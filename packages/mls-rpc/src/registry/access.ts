import {
  assertRetainsKnownEffects,
  decodeClientState,
  denyApplicationSend,
  encodeClientState,
  type GroupHandle,
  type Relinquished,
  relinquishSend,
  restrictCommitAuthoring,
} from '@kumiai/mls'
import {
  type AdoptionExpected,
  type AdoptionWrite,
  type AnchorSlot,
  applyChanges,
  type CheckpointFactRecord,
  type CommitOnceWriteContext,
  type ControlSnapshot,
  type ControlStore,
  controlOccurrenceCoverage,
  controlOwnConsumptionAllowed,
  controlSafetyHeld,
  GroupSafetyHeldError,
  type SafetyHold,
  SavedControlCompatibilityError,
  type SendAdmission,
} from '@kumiai/rpc'

import {
  type ControlHandleAccess,
  type ControlRead,
  type ControlReadScope,
  type HandleAccess,
  type PersistContext,
  retainsKnownEffects,
} from '../access.js'
import { currentCheckpointFact, prepareCheckpointInstallation } from '../checkpoint-capture.js'
import { controlCompatible } from '../control-compat.js'
import { type ControlJournal, decodeControlJournal } from '../control-journal.js'
import { controlBuildContexts } from '../control-write-context.js'
import type { EntryCapability, EntryReads } from '../entry-capability.js'
import { groupBatchFor } from '../group-batch-binding.js'
import { consumesInboundCommit } from '../inbound-commit.js'
import { copyStoredValue, sameStoredValue } from '../memory-incarnation-stores.js'
import { decodeStoredValue, encodeStoredValue } from '../persistence-codec.js'
import {
  DisplacedGroupHandleError,
  GroupStateUncertainError,
  GroupUnavailableError,
  RegistryRecoveryReplacementError,
} from '../persistence-errors.js'
import type {
  GroupKey,
  GroupRecoveryTrust,
  GroupStores,
  GroupTransaction,
} from '../persistence-types.js'
import { clearGroupCondition } from '../safety-conditions.js'
import { createRegistryAppOpen } from './app-open.js'
import { bindRegistryStreamingOpen } from './app-open-binding.js'
import { createPublicationPreparation } from './app-publication.js'
import { type ColdEnvironment, restoreValidated, type ValidatedGroupState } from './cold.js'
import {
  bindControlCandidateRestore,
  bindControlSourceRestore,
  bindRegistryControlBatch,
  ControlDrainRequiredError,
  type RegistryControlBatchEntry,
} from './control-batch.js'
import { createLiveReceive, registryReceiveSlots } from './live-receive.js'
import { createLiveSend, type LiveSlot, leaseReaders, registryLiveSend } from './live-send.js'
import {
  capturedRecord,
  eligibilityOf,
  reservationEnvelope,
  reserveFromBytes,
  restoreCaptured,
} from './reserve.js'
import type { createRegistryRuntime } from './runtime.js'
import { RetainedTrustUnavailableError, readRetainedTrust } from './safety.js'
import { readRecoverySource } from './source.js'
import { recoveryTrustFor } from './trust.js'
import type { GroupRuntimeSnapshot, ReadableGroupState, RegistryHandleAccess } from './types.js'
import { ordinaryCandidateMatches, validateRegistryHandle } from './validation.js'

export type RegistryOwner = {
  key: GroupKey
  value: ValidatedGroupState
  acceptedTrust: GroupRecoveryTrust
  cacheValid: boolean
  snapshot: GroupRuntimeSnapshot
  admission: SendAdmission
  runtime: ReturnType<typeof createRegistryRuntime>
  hooks: Set<() => Promise<void>>
  access: RegistryHandleAccess | null
  expected: Map<number, ReadableGroupState>
  maintenance: ReturnType<typeof createLiveSend> | null
}

export const registryCapturedReplacements = new WeakMap<
  RegistryHandleAccess,
  (
    captured: Relinquished,
    adoption: Parameters<HandleAccess['replace']>[1],
    prepare: Parameters<HandleAccess['replace']>[2],
  ) => Promise<boolean>
>()

export function createRegistryAccess<TTx extends GroupTransaction>(params: {
  owner: RegistryOwner
  initialControl: ControlSnapshot
  initialEligibility: Uint8Array
  live: LiveSlot
  dropOwner(): void
  waitForMaintenanceGate(signal: AbortSignal): Promise<void> | undefined
  binding: object
  capability: EntryCapability<TTx>
  environment: ColdEnvironment
  restoreCandidate(candidate: Uint8Array): Promise<GroupHandle>
  resolve(mutationID: string): Promise<'committed' | 'rolled-back'>
  load(reads: EntryReads, assertMutationSafety?: () => void): Promise<ValidatedGroupState>
  publish(): void
  admissionChanged(): void
  invalidate(displaced: boolean): void
  assertCurrent(): void
  assertAvailable(): void
  safetyHeld(): SafetyHold
  diagnoseFailure(error: unknown): Promise<void>
}): RegistryHandleAccess {
  const { owner, capability, environment } = params
  function assertSafety(): void {
    const reason = params.safetyHeld()
    if (reason !== null) throw new GroupSafetyHeldError(reason)
  }
  async function assertWorkSafety(stores: GroupStores<TTx>): Promise<void> {
    const reason = controlSafetyHeld(await stores.incarnation(owner.key.incarnation).control.load())
    if (reason !== null) throw new GroupSafetyHeldError(reason)
    assertSafety()
  }
  const live = createLiveSend({ ...params, slot: params.live, assertWorkSafety })
  owner.maintenance = live
  async function isolated(
    reads: EntryReads,
    assertMutationSafety?: () => void,
  ): Promise<ControlRead> {
    try {
      const value = await params.load(reads, assertMutationSafety)
      if (value.key.incarnation !== owner.key.incarnation)
        throw new DisplacedGroupHandleError('Registry access belongs to a retired incarnation')
      assertMutationSafety?.()
      const handle = await restoreValidated(value, environment)
      params.assertCurrent()
      return {
        handle,
        source: {
          key: { ...value.key },
          stateVersion: value.record.version,
          identity: {
            ...value.trust.installed,
            authenticator: value.trust.installed.authenticator.slice(),
          },
        },
      }
    } catch (error) {
      if (error instanceof GroupUnavailableError || error instanceof DisplacedGroupHandleError)
        params.invalidate(
          error instanceof DisplacedGroupHandleError ||
            (error instanceof GroupUnavailableError && error.reason === 'deleted'),
        )
      throw error
    }
  }
  async function read<T>(fn: (handle: GroupHandle) => T | Promise<T>): Promise<T> {
    params.assertAvailable()
    try {
      return await capability.read(owner.key.groupID, async (reads) => {
        const { handle } = await isolated(reads)
        return await fn(handle)
      })
    } catch (error) {
      await params.diagnoseFailure(error)
      throw error
    } finally {
      params.publish()
    }
  }
  async function readControl<T>(fn: (scope: ControlReadScope) => Promise<T>): Promise<T> {
    params.assertAvailable()
    try {
      return await capability.read(owner.key.groupID, async (reads) => {
        let active = true
        const refresh = async (): Promise<ControlRead> => {
          if (!active) throw new Error('Control read scope has ended')
          const value = await isolated(reads)
          if (!active) throw new Error('Control read scope has ended')
          return value
        }
        const loadControl = async (control?: ControlStore): Promise<ControlSnapshot> => {
          if (!active) throw new Error('Control read scope has ended')
          if (control !== undefined && !sameStoredValue(control.key, owner.key))
            throw new DisplacedGroupHandleError('Control store belongs to another incarnation')
          const value = await reads.control(owner.key.incarnation)
          if (!active) throw new Error('Control read scope has ended')
          return value
        }
        try {
          return await fn({
            ...(await refresh()),
            refresh,
            loadControl,
            loadCheckpoints: () => {
              if (!active) throw new Error('Control read scope has ended')
              return reads.checkpoints()
            },
          })
        } finally {
          active = false
        }
      })
    } catch (error) {
      await params.diagnoseFailure(error)
      throw error
    } finally {
      params.publish()
    }
  }
  function moved(cause?: unknown): Error {
    const error = new Error('Ordinary adoption source or candidate moved', { cause })
    error.name = 'ControlAdoptionMovedError'
    return error
  }
  class Noop extends Error {}
  function journalFor(write: AdoptionWrite | undefined): ControlJournal {
    if (write?.expected?.journal === undefined || write.expected.occurrence === undefined)
      throw new RegistryRecoveryReplacementError(
        'Ordinary replacement requires an accepted control journal',
      )
    try {
      return decodeControlJournal(write.expected.journal)
    } catch (cause) {
      throw new RegistryRecoveryReplacementError(
        'Recovery or malformed journal cannot replace ordinary state',
        { cause },
      )
    }
  }
  function staged(handle: GroupHandle) {
    return {
      incarnation: owner.key.incarnation,
      epochAfter: Number(handle.epoch),
      removed:
        handle.state.groupActiveState.kind === 'removedFromGroup' ||
        !handle
          .listMembers()
          .some((member) => member.leafIndex === handle.state.privatePath.leafIndex),
      epochAuthenticator: handle.state.keySchedule.epochAuthenticator.slice(),
    }
  }
  async function recordFor(
    captured: Relinquished,
    value: ValidatedGroupState,
    privateHandle?: GroupHandle,
  ) {
    const base = capturedRecord(captured, value.key, value.record.version + 1)
    const sameIdentity =
      base.epoch === value.record.epoch &&
      sameStoredValue(base.epochAuthenticator, value.record.epochAuthenticator)
    const restoreEnvironment =
      privateHandle === undefined
        ? environment
        : { ...environment, restore: async () => privateHandle }
    const reserved = sameIdentity
      ? null
      : await reserveFromBytes(restoreEnvironment, { ...base, senderHWM: 0 }, 0)
    const handle = reserved?.handle ?? privateHandle ?? (await restoreCaptured(environment, base))
    validateRegistryHandle({
      handle,
      key: value.key,
      trust: value.trust,
      environment: environment.recovery,
      ownerDID: environment.ownerDID,
    })
    const record: ReadableGroupState = {
      ...base,
      epoch: Number(handle.epoch),
      epochAuthenticator: handle.state.keySchedule.epochAuthenticator.slice(),
      state: reserved?.state ?? captured.state,
      terminal: value.record.terminal || staged(handle).removed,
      senderHWM:
        reserved === null ? Math.max(value.record.senderHWM, base.senderHWM) : reserved.senderHWM,
    }
    const reservation =
      reserved?.reservation == null
        ? null
        : {
            ...reserved.reservation,
            envelope: reservationEnvelope(record),
          }
    return {
      record,
      handle,
      reservation,
      eligibility: eligibilityOf(handle.state, handle.ownLeafLapsed()),
    }
  }
  async function writeState(
    stores: GroupStores<TTx>,
    record: ReadableGroupState,
    trust: ValidatedGroupState['trust'],
    write?: AdoptionWrite,
    checkpoint?: CheckpointFactRecord,
    deferControl = false,
  ) {
    params.assertCurrent()
    await assertWorkSafety(stores)
    const target = stores.incarnation(owner.key.incarnation)
    await target.state.save(record, write?.expected)
    await stores.trust.save(trust)
    if (checkpoint !== undefined) {
      await clearGroupCondition(stores.checkpoints, owner.key)
      await stores.checkpoints.put(checkpoint)
      if (!record.terminal)
        await stores.checkpoints.put({
          kind: 'publication',
          id: `publication:${checkpoint.id}`,
          key: { groupID: record.groupID, incarnation: record.incarnation },
          factID: checkpoint.id,
          frame: null,
          publishID: null,
          accepted: false,
          nextHeartbeatAt: null,
        })
    }
    if (write !== undefined && !deferControl) {
      await target.control.apply(write.changes, write.mutationID)
      if (write.anchorLanded !== undefined) {
        const anchor = await target.anchor.load()
        if (anchor?.pending?.advance === write.anchorLanded)
          await target.anchor.save({ ...anchor, pending: { ...anchor.pending, landed: true } })
      }
    }
  }
  function assertMutationID(write: AdoptionWrite | undefined): void {
    if (
      write !== undefined &&
      (typeof write.mutationID !== 'string' || write.mutationID.length === 0)
    )
      throw new TypeError('Adoption requires a mutation ID')
  }
  // Resolution precedes replay and spent checks. Uncertainty supplies no success/rollback inference.
  async function proved(mutationID: string): Promise<boolean> {
    try {
      return (await params.resolve(mutationID)) === 'committed'
    } catch (error) {
      if (!(error instanceof GroupStateUncertainError)) throw error
      return false
    }
  }
  async function destinationFor(next: GroupHandle, write: AdoptionWrite): Promise<GroupHandle> {
    const journal = journalFor(write)
    let destination: GroupHandle
    try {
      destination = denyApplicationSend(
        restrictCommitAuthoring(await params.restoreCandidate(journal.candidate)),
      )
    } catch (cause) {
      throw moved(cause)
    }
    if (
      !ordinaryCandidateMatches(next, destination, owner.key) ||
      (journal.candidateAuthenticator !== undefined &&
        !sameStoredValue(
          destination.state.keySchedule.epochAuthenticator,
          journal.candidateAuthenticator,
        ))
    )
      throw moved()
    try {
      for (const handle of [next, destination]) {
        validateRegistryHandle({
          handle,
          key: owner.key,
          trust: owner.value.trust,
          environment: environment.recovery,
          ownerDID: environment.ownerDID,
        })
      }
    } catch (cause) {
      throw moved(cause)
    }
    return destination
  }
  function ordinaryProof(write: AdoptionWrite, journal: ControlJournal): boolean {
    const expected = write.expected
    const proof = expected?.occurrence
    return (
      expected !== undefined &&
      proof !== undefined &&
      sameStoredValue(expected.key, owner.key) &&
      sameStoredValue(journal.source.key, owner.key) &&
      sameStoredValue(proof.source.key, owner.key) &&
      sameStoredValue(journal.source.identity, proof.source.identity) &&
      (proof.coverage === 'complete' || proof.coverage === 'incomplete')
    )
  }
  async function ordinaryDestination(
    reads: EntryReads,
    source: AdoptionExpected,
    next: GroupHandle,
    expected: AdoptionExpected,
    write: AdoptionWrite,
    committed: boolean,
    prepare?: () => Promise<boolean>,
    preparedControl?: ControlSnapshot,
  ): Promise<GroupHandle | null> {
    const journal = journalFor(write)
    if (!ordinaryProof(write, journal)) throw moved()
    if (!committed) assertSafety()
    const destination = await destinationFor(next, write)
    if (committed) return null
    assertSafety()
    const control = preparedControl ?? (await reads.control(owner.key.incarnation))
    const proof = write.expected?.occurrence
    if (proof === undefined) throw moved()
    if (
      sameStoredValue(source.identity, {
        ...owner.key,
        epoch: Number(destination.epoch),
        authenticator: destination.state.keySchedule.epochAuthenticator,
      })
    ) {
      const row = control.applied.find((row) => row.epoch === journal.source.identity?.epoch)
      if (
        (row?.payloadDigest === proof.payloadDigest && row?.sequenceID === proof.position) ||
        (await reads.controlMutation(owner.key.incarnation)) === write.mutationID
      )
        return null
      throw moved()
    }
    const stored = await reads.state(owner.key.incarnation)
    const sourceState = decodeClientState(journal.sourceState)
    const currentState =
      stored === null || stored.deleted || stored.state === null
        ? undefined
        : decodeClientState(stored.state)
    if (
      !sameStoredValue(source.key, expected.key) ||
      !sameStoredValue(source.identity, expected.identity) ||
      !sameStoredValue(source.key, write.expected?.key) ||
      !sameStoredValue(source.identity, write.expected?.identity) ||
      !sameStoredValue(source.identity, journal.source.identity) ||
      sourceState === undefined ||
      currentState === undefined
    )
      throw moved()
    assertSafety()
    if (prepare !== undefined && !(await prepare())) throw moved()
    assertSafety()
    if (
      controlSafetyHeld(control) !== null ||
      control.strand !== null ||
      control.cursor?.stranded === true ||
      control.controlHold !== null ||
      control.commitOnce === null ||
      control.commitOnce.payloadDigest !== proof.payloadDigest ||
      control.commitOnce.head !== journal.checkpoint ||
      !sameStoredValue(control.commitOnce.journal, write.expected?.journal) ||
      proof.coverage !== controlOccurrenceCoverage(control, control.commitOnce, proof.position) ||
      !controlOwnConsumptionAllowed(control, proof, write.changes)
    )
      throw moved()
    if (!controlCompatible(sourceState, currentState, journal.referencedProposals))
      throw new SavedControlCompatibilityError(
        'Recognised own occurrence has an incompatible saved candidate',
      )
    return destination
  }
  async function ordinary(
    captured: Relinquished,
    supplied: { expected: AdoptionExpected; write: AdoptionWrite } | undefined,
    prepare?: Parameters<HandleAccess['replace']>[2],
    adoption?: Parameters<HandleAccess['replace']>[1],
    restored?: GroupHandle,
  ): Promise<'installed' | 'noop'> {
    const next =
      restored ??
      (await restoreCaptured(
        environment,
        capturedRecord(captured, owner.key, owner.value.record.version + 1),
      ))
    params.assertAvailable()
    assertMutationID(supplied?.write)
    const committed = supplied === undefined ? false : await proved(supplied.write.mutationID)
    try {
      return await live.run(
        { groupID: owner.key.groupID, mutationID: supplied?.write.mutationID ?? null },
        async (reads) => {
          if (supplied !== undefined && (committed || params.safetyHeld() !== null)) {
            const { write } = supplied
            const journal = journalFor(write)
            if (!ordinaryProof(write, journal)) throw moved()
            let replay = committed
            if (!replay) {
              const current = await readRecoverySource(reads, owner.key.groupID)
              const proof = write.expected?.occurrence
              const control = await reads.control(owner.key.incarnation)
              const row = control.applied.find(
                (row) => row.epoch === journal.source.identity?.epoch,
              )
              replay =
                proof !== undefined &&
                sameStoredValue(current.identity, {
                  ...owner.key,
                  epoch: Number(next.epoch),
                  authenticator: next.state.keySchedule.epochAuthenticator,
                }) &&
                ((row?.payloadDigest === proof.payloadDigest &&
                  row?.sequenceID === proof.position) ||
                  (await reads.controlMutation(owner.key.incarnation)) === write.mutationID)
            }
            if (replay) {
              await destinationFor(next, write)
              throw new Noop()
            }
          }
          assertSafety()
          const { handle: current, source } = await isolated(reads, assertSafety)
          assertSafety()
          const value = owner.value
          const lifetime = await reads.lifetime()
          assertSafety()
          const write = supplied?.write ?? adoption?.(staged(next))
          assertMutationID(write)
          journalFor(write)
          if (write === undefined || write.expected === undefined)
            throw new RegistryRecoveryReplacementError('Ordinary replacement requires provenance')
          const expected = supplied?.expected ?? {
            key: write.expected.key,
            stateVersion: write.expected.stateVersion,
            identity: write.expected.identity,
          }
          const destination = await ordinaryDestination(
            reads,
            source,
            next,
            expected,
            write,
            committed || lifetime?.mutationID === write.mutationID,
            prepare === undefined ? undefined : () => prepare(current, source),
          )
          if (destination === null) throw new Noop()
          if (current.anchor.controller != null)
            assertRetainsKnownEffects(
              current.anchor.controller,
              current.registry,
              destination.registry,
            )
          assertSafety()
          // The decoded handle is isolated from the caller and only now may carry source progress.
          await current.carryReceiveProgress(destination)
          const {
            record,
            handle: installed,
            reservation,
            eligibility,
          } = await recordFor(await relinquishSend(destination), value, destination)
          const trust = recoveryTrustFor(installed, value.key, value.trust)
          return {
            expected: lifetime,
            mutationID: write.mutationID,
            value: {
              source,
              record,
              trust,
              write,
              reservation,
              eligibility,
              checkpoint: await prepareCheckpointInstallation({
                key: owner.key,
                handle: installed,
                mutationID: write.mutationID,
                stateVersion: record.version,
                previousFact: currentCheckpointFact(await reads.checkpoints())?.canonical ?? null,
              }),
            },
          }
        },
        async (stores, prepared) => {
          await assertWorkSafety(stores)
          const target = stores.incarnation(owner.key.incarnation)
          const record = await target.state.load()
          const trust = await readRetainedTrust({ trust: stores.trust.load }, owner.key)
          if (
            record === null ||
            record.version !== prepared.source.stateVersion ||
            !sameStoredValue(trust?.installed, prepared.source.identity)
          )
            throw moved()
          if (prepared.source.identity === null) throw moved()
          controlBuildContexts.set(stores.tx, {
            kind: 'adoption',
            before: prepared.source.identity,
            after: prepared.trust.installed,
            ...(!prepared.record.deleted && prepared.record.terminal
              ? { removed: true as const }
              : {}),
          })
          try {
            await writeState(
              stores,
              prepared.record,
              prepared.trust,
              prepared.write,
              prepared.checkpoint,
            )
          } finally {
            controlBuildContexts.delete(stores.tx)
          }
          return 'installed' as const
        },
      )
    } catch (error) {
      if (error instanceof Noop) return 'noop'
      await params.diagnoseFailure(error)
      if (error instanceof RetainedTrustUnavailableError)
        // biome-ignore lint/style/useErrorCause: Mutation boundaries expose the diagnosed safety reason.
        throw new GroupSafetyHeldError('recovery-unavailable')
      throw error
    } finally {
      params.publish()
    }
  }
  const mutate: HandleAccess['mutate'] = async (fn, adoption) => {
    params.assertAvailable()
    assertSafety()
    const fallbackMutationID = crypto.randomUUID()
    let noopResult: { value: Awaited<ReturnType<typeof fn>> } | undefined
    try {
      return await live.run(
        {
          groupID: owner.key.groupID,
          mutationID: adoption === undefined ? fallbackMutationID : null,
        },
        async (reads) => {
          assertSafety()
          const { handle, source } = await isolated(reads, assertSafety)
          assertSafety()
          const value = owner.value
          const lifetime = await reads.lifetime()
          let record: ReadableGroupState | undefined
          let trust: ValidatedGroupState['trust'] | undefined
          let eligibility: Uint8Array | undefined
          let reservation: Awaited<ReturnType<typeof recordFor>>['reservation'] = null
          let write: AdoptionWrite | undefined
          let checkpoint: CheckpointFactRecord | undefined
          let mutationID: string = fallbackMutationID
          let nooped = false
          let active = true
          const persist = async (input: GroupHandle, ctx?: PersistContext): Promise<void> => {
            const captured = await relinquishSend(input, ctx)
            const candidate = await restoreCaptured(
              environment,
              capturedRecord(captured, value.key, value.record.version + 1),
            )
            if (!active) throw new Error('Mutation prepare scope has ended')
            assertSafety()
            const proposed = adoption?.(staged(candidate))
            const stagedWrite =
              proposed === undefined
                ? undefined
                : (decodeStoredValue(encodeStoredValue(proposed)) as AdoptionWrite)
            assertMutationID(stagedWrite)
            let final = candidate
            if (stagedWrite?.expected?.journal !== undefined) {
              const destination = await ordinaryDestination(
                reads,
                source,
                candidate,
                {
                  key: stagedWrite.expected.key,
                  stateVersion: stagedWrite.expected.stateVersion,
                  identity: stagedWrite.expected.identity,
                },
                stagedWrite,
                // Attempt-bound lifetime reads prove the provider-accounted mutation without a root call.
                lifetime?.mutationID === stagedWrite.mutationID,
              )
              if (destination === null) {
                nooped = true
                return
              }
              final = destination
              const committedSource = await restoreValidated(value, environment)
              await committedSource.carryReceiveProgress(final)
            } else if (
              candidate.state.groupActiveState.kind === 'removedFromGroup' ||
              Number(candidate.epoch) !== value.record.epoch ||
              !sameStoredValue(
                candidate.state.keySchedule.epochAuthenticator,
                value.record.epochAuthenticator,
              )
            ) {
              const control = await reads.control(owner.key.incarnation)
              if (
                (control.commitOnce !== null ||
                  candidate.state.groupActiveState.kind === 'removedFromGroup') &&
                !consumesInboundCommit({
                  context: ctx,
                  source: handle,
                  result: input,
                  capturedState: captured.state,
                  cursorBefore: control.cursor,
                  record: value.record,
                  write: stagedWrite,
                })
              )
                throw moved()
            }
            const saved =
              final === candidate
                ? await recordFor(captured, value, candidate)
                : await recordFor(await relinquishSend(final), value, final)
            const stagedRecord = saved.record
            const stagedTrust = recoveryTrustFor(saved.handle, value.key, value.trust)
            if (!active) throw new Error('Mutation prepare scope has ended')
            const stagedMutationID = stagedWrite?.mutationID ?? fallbackMutationID
            const stagedCheckpoint =
              stagedRecord.epoch === value.record.epoch &&
              sameStoredValue(stagedRecord.epochAuthenticator, value.record.epochAuthenticator)
                ? undefined
                : await prepareCheckpointInstallation({
                    key: owner.key,
                    handle: saved.handle,
                    mutationID: stagedMutationID,
                    stateVersion: stagedRecord.version,
                    previousFact:
                      currentCheckpointFact(await reads.checkpoints())?.canonical ?? null,
                  })
            if (!active) throw new Error('Mutation prepare scope has ended')
            record = stagedRecord
            eligibility = saved.eligibility
            reservation = saved.reservation
            trust = stagedTrust
            write = stagedWrite
            mutationID = stagedMutationID
            checkpoint = stagedCheckpoint
          }
          let result: Awaited<ReturnType<typeof fn>>
          try {
            assertSafety()
            result = await fn(handle, persist)
            assertSafety()
            if (record === undefined && !nooped) await persist(handle)
          } finally {
            active = false
          }
          if (record === undefined && nooped) {
            noopResult = { value: result }
            throw new Noop()
          }
          if (record === undefined || trust === undefined || eligibility === undefined)
            throw new Error('Mutation state was not staged')
          return {
            expected: lifetime,
            mutationID,
            value: { result, record, trust, write, source, checkpoint, reservation, eligibility },
          }
        },
        async (stores, prepared) => {
          await assertWorkSafety(stores)
          if (prepared.write !== undefined && prepared.source.identity !== null)
            controlBuildContexts.set(stores.tx, {
              kind: 'adoption',
              before: prepared.source.identity,
              after: prepared.trust.installed,
              ...(!prepared.record.deleted && prepared.record.terminal
                ? { removed: true as const }
                : {}),
            })
          try {
            await writeState(
              stores,
              prepared.record,
              prepared.trust,
              prepared.write,
              prepared.checkpoint,
            )
          } finally {
            controlBuildContexts.delete(stores.tx)
          }
          return prepared.result
        },
      )
    } catch (error) {
      if (error instanceof Noop && noopResult !== undefined) return noopResult.value
      await params.diagnoseFailure(error)
      if (error instanceof RetainedTrustUnavailableError)
        // biome-ignore lint/style/useErrorCause: Mutation boundaries expose the diagnosed safety reason.
        throw new GroupSafetyHeldError('recovery-unavailable')
      throw error
    } finally {
      params.publish()
    }
  }
  const replace: HandleAccess['replace'] = async (next, adoption, prepare) => {
    const captured = await relinquishSend(next)
    params.assertAvailable()
    assertSafety()
    await ordinary(captured, undefined, prepare, adoption)
    next.confirmAdopted()
  }
  async function adopt(
    next: GroupHandle,
    expected: AdoptionExpected,
    write: AdoptionWrite,
  ): Promise<'installed' | 'noop' | 'moved'> {
    try {
      return await ordinary(await relinquishSend(next), { expected, write })
    } catch (error) {
      if (error instanceof Error && error.name === 'ControlAdoptionMovedError') return 'moved'
      throw error
    }
  }
  function assertReceiveAvailable(): void {
    params.assertAvailable()
    assertSafety()
    if (live.committedRecord.terminal || !owner.snapshot.available)
      throw new GroupUnavailableError({ reason: 'invalid' })
  }
  const appOpen = createRegistryAppOpen({
    ...params,
    run: live.run,
    isolated,
    recordFor,
    assertSafety,
    assertWorkSafety,
  })
  const access: RegistryHandleAccess = {
    ...createPublicationPreparation({ ...params, live, assertWorkSafety }),
    receive: createLiveReceive({
      ...params,
      slot: params.live,
      accounting: live.accounting,
      assertAvailable: assertReceiveAvailable,
      refresh: async () => {
        await capability.read(owner.key.groupID, async (reads) => {
          assertReceiveAvailable()
          await params.load(reads, assertSafety)
          assertReceiveAvailable()
        })
      },
    }),
    openBatch: appOpen.openBatch,
    pending: appOpen.pending,
    get key() {
      return { ...owner.key }
    },
    get runtime() {
      return owner.runtime.runtime
    },
    epoch() {
      params.assertAvailable()
      return owner.snapshot.epoch
    },
    stateVersion() {
      params.assertAvailable()
      return owner.snapshot.stateVersion
    },
    admission() {
      params.assertAvailable()
      return live.admission()
    },
    seal: live.seal,
    onRotationRequired: live.onRotationRequired,
    onAdmissionChanged: live.onAdmissionChanged,
    read,
    readControl,
    mutate,
    replace,
    adopt,
    onRetire(hook) {
      params.assertAvailable()
      const registered = () => hook()
      owner.hooks.add(registered)
      return () => {
        owner.hooks.delete(registered)
      }
    },
  }
  bindRegistryStreamingOpen(access, {
    key: owner.key,
    scheduler: groupBatchFor(params.binding, owner.key.groupID),
    openReady: appOpen.openReady,
  })
  const controlBatch: RegistryControlBatchEntry = {
    key: { ...owner.key },
    run(input) {
      capability.assertRoot()
      params.assertAvailable()
      assertSafety()
      return groupBatchFor(params.binding, owner.key.groupID).schedule({
        source: input.source,
        kind: 'control',
        signal: input.signal,
        run: async (budget) => {
          try {
            return await live.run(
              { groupID: owner.key.groupID, mutationID: null },
              async (reads) => {
                params.assertAvailable()
                assertSafety()
                if (input.signal?.aborted) throw input.signal.reason
                const initial = await isolated(reads, assertSafety)
                const source = copyStoredValue(initial.source)
                const value = owner.value
                const lifetime = await reads.lifetime()
                const originalControl = await reads.control(owner.key.incarnation)
                const originalAnchor = await reads.anchor(owner.key.incarnation)
                let snapshot = copyStoredValue(originalControl)
                let anchor = copyStoredValue(originalAnchor)
                let lastMutation = await reads.controlMutation(owner.key.incarnation)
                let handle = initial.handle
                let active = true
                let saved: Awaited<ReturnType<typeof recordFor>> | undefined
                let trust = value.trust
                let checkpoint: CheckpointFactRecord | undefined
                let write: AdoptionWrite | undefined
                let context: CommitOnceWriteContext | null =
                  source.identity === null ? null : { kind: 'cursor', source: source.identity }
                let mutationID: string = crypto.randomUUID()
                const changes: Array<{
                  changes: Parameters<ControlStore['apply']>[0]
                  mutationID: string
                  context: CommitOnceWriteContext | null
                }> = []
                let anchorChanged = false
                const assertActive = () => {
                  if (!active) throw new Error('Control prepare scope has ended')
                  params.assertCurrent()
                  assertSafety()
                  if (input.signal?.aborted) throw input.signal.reason
                }
                const stageControl: ControlStore['apply'] = async (next, id) => {
                  assertActive()
                  snapshot = applyChanges(snapshot, copyStoredValue(next), context, owner.key)
                  changes.push({
                    changes: copyStoredValue(next),
                    mutationID: id,
                    context: copyStoredValue(context),
                  })
                  lastMutation = id
                  mutationID = id
                }
                const stage = async (
                  next: GroupHandle,
                  proposed?: AdoptionWrite,
                  ctx?: PersistContext,
                ) => {
                  assertActive()
                  assertMutationID(proposed)
                  const captured = await relinquishSend(next, ctx)
                  const candidate = await restoreCaptured(
                    environment,
                    capturedRecord(captured, value.key, value.record.version + 1),
                  )
                  assertActive()
                  let destination = candidate
                  if (
                    staged(candidate).removed &&
                    (await reads.pendingFrames(owner.key.incarnation)).length !== 0
                  )
                    throw new ControlDrainRequiredError()
                  if (proposed?.expected?.journal !== undefined) {
                    const result = await ordinaryDestination(
                      reads,
                      source,
                      candidate,
                      proposed.expected,
                      proposed,
                      lifetime?.mutationID === proposed.mutationID,
                      undefined,
                      snapshot,
                    )
                    if (result === null) return
                    destination = result
                    retainsKnownEffects(destination)(handle)
                    await handle.carryReceiveProgress(destination)
                  }
                  assertActive()
                  if (
                    proposed?.expected?.journal === undefined &&
                    (snapshot.commitOnce !== null || staged(destination).removed) &&
                    (Number(destination.epoch) !== value.record.epoch ||
                      staged(destination).removed) &&
                    !consumesInboundCommit({
                      context: ctx,
                      source: initial.handle,
                      result: next,
                      capturedState: captured.state,
                      cursorBefore: originalControl.cursor,
                      record: value.record,
                      write: proposed,
                    })
                  )
                    throw moved()
                  saved = await recordFor(await relinquishSend(destination), value, destination)
                  assertActive()
                  handle = saved.handle
                  trust = recoveryTrustFor(handle, value.key, value.trust)
                  mutationID = proposed?.mutationID ?? mutationID
                  write = proposed
                  if (source.identity !== null)
                    context = {
                      kind: 'adoption',
                      before: source.identity,
                      after: trust.installed,
                      ...(staged(handle).removed ? { removed: true as const } : {}),
                    }
                  if (proposed !== undefined) {
                    await stageControl(proposed.changes, proposed.mutationID)
                    if (
                      proposed.anchorLanded !== undefined &&
                      anchor?.pending?.advance === proposed.anchorLanded
                    ) {
                      anchor = { ...anchor, pending: { ...anchor.pending, landed: true } }
                      anchorChanged = true
                    }
                  }
                  if (
                    saved.record.epoch !== value.record.epoch ||
                    !sameStoredValue(
                      saved.record.epochAuthenticator,
                      value.record.epochAuthenticator,
                    )
                  )
                    checkpoint = await prepareCheckpointInstallation({
                      key: owner.key,
                      handle,
                      mutationID,
                      stateVersion: saved.record.version,
                      previousFact:
                        currentCheckpointFact(await reads.checkpoints())?.canonical ?? null,
                    })
                  assertActive()
                }
                const local: ControlHandleAccess = {
                  epoch: () => {
                    assertActive()
                    return Number(handle.epoch)
                  },
                  admission: () => {
                    assertActive()
                    return handle.sendAdmission()
                  },
                  read: async (fn) => {
                    assertActive()
                    const result = await fn(handle)
                    assertActive()
                    return result
                  },
                  readControl: async (fn) => {
                    assertActive()
                    const refresh = async () => {
                      assertActive()
                      return { handle, source: copyStoredValue(source) }
                    }
                    const result = await fn({
                      handle,
                      source: copyStoredValue(source),
                      refresh,
                      loadControl: async (store) => {
                        assertActive()
                        if (store !== undefined && !sameStoredValue(store.key, owner.key))
                          throw moved()
                        return copyStoredValue(snapshot)
                      },
                      loadCheckpoints: async () => {
                        assertActive()
                        return reads.checkpoints()
                      },
                    })
                    assertActive()
                    return result
                  },
                  mutate: async (fn, adoption) => {
                    assertActive()
                    let persisted = false
                    const persist = async (next: GroupHandle, ctx?: PersistContext) => {
                      await stage(next, adoption?.(staged(next)), ctx)
                      persisted = true
                    }
                    const result = await fn(handle, persist)
                    assertActive()
                    if (!persisted) await persist(handle)
                    return result
                  },
                  replace: async (next, adoption, prepare) => {
                    assertActive()
                    if (prepare !== undefined && !(await prepare(handle, copyStoredValue(source))))
                      return
                    const proposed = adoption?.(staged(next))
                    if (proposed?.expected?.journal === undefined) throw moved()
                    await stage(next, proposed)
                  },
                }
                bindControlCandidateRestore(local, async (bytes) => {
                  assertActive()
                  const candidate = restrictCommitAuthoring(await params.restoreCandidate(bytes))
                  assertActive()
                  return candidate
                })
                bindControlSourceRestore(local, async (input) => {
                  assertActive()
                  const restored = restrictCommitAuthoring(
                    await environment.restore({
                      ...value.record,
                      state: encodeClientState(input.state),
                      credential: input.credential,
                      ledger: input.ledgerEntries ?? [],
                      epoch: Number(input.state.groupContext.epoch),
                      epochAuthenticator: input.state.keySchedule.epochAuthenticator.slice(),
                    }),
                  )
                  assertActive()
                  return restored
                })
                const control: ControlStore = {
                  key: { ...owner.key },
                  load: async () => {
                    assertActive()
                    return copyStoredValue(snapshot)
                  },
                  lastMutation: async () => {
                    assertActive()
                    return lastMutation
                  },
                  apply: stageControl,
                }
                let result: Awaited<ReturnType<typeof input.prepare>>
                try {
                  budget.begin()
                  if (!budget.take()) throw new RangeError('Control budget exhausted')
                  result = await input.prepare({
                    access: local,
                    control,
                    anchor: {
                      load: async () => {
                        assertActive()
                        return copyStoredValue(anchor)
                      },
                      save: async (slot) => {
                        assertActive()
                        anchor = copyStoredValue(slot)
                        anchorChanged = true
                      },
                    },
                  })
                  assertActive()
                } finally {
                  active = false
                }
                return {
                  expected: lifetime,
                  mutationID,
                  value: {
                    result,
                    source,
                    originalControl,
                    originalAnchor,
                    snapshot,
                    anchor,
                    anchorChanged,
                    stateChanged: saved !== undefined,
                    record: saved?.record ?? value.record,
                    eligibility:
                      saved?.eligibility ?? eligibilityOf(handle.state, handle.ownLeafLapsed()),
                    reservation: saved?.reservation ?? null,
                    trust,
                    checkpoint,
                    write,
                    context,
                    changes,
                  },
                }
              },
              async (stores, prepared) => {
                params.assertCurrent()
                if (input.signal?.aborted) throw input.signal.reason
                await assertWorkSafety(stores)
                const target = stores.incarnation(owner.key.incarnation)
                const record = await target.state.load()
                const trust = await readRetainedTrust({ trust: stores.trust.load }, owner.key)
                if (
                  record?.version !== prepared.source.stateVersion ||
                  !sameStoredValue(trust.installed, prepared.source.identity) ||
                  !sameStoredValue(await target.control.load(), prepared.originalControl) ||
                  !sameStoredValue(await target.anchor.load(), prepared.originalAnchor)
                )
                  throw moved()
                const applyControl = async (change: (typeof prepared.changes)[number]) => {
                  if (change.context !== null) controlBuildContexts.set(stores.tx, change.context)
                  else controlBuildContexts.delete(stores.tx)
                  await target.control.apply(
                    change.changes,
                    prepared.changes.at(-1)?.mutationID ?? change.mutationID,
                  )
                }
                try {
                  let prefix = 0
                  // Own-consumption proof reads the coverage cursor in this same transaction.
                  if (prepared.stateChanged) {
                    for (const change of prepared.changes) {
                      if (change.context?.kind !== 'cursor') break
                      await applyControl(change)
                      prefix++
                    }
                  }
                  if (prepared.context !== null)
                    controlBuildContexts.set(stores.tx, prepared.context)
                  if (prepared.stateChanged)
                    await writeState(
                      stores,
                      prepared.record,
                      prepared.trust,
                      prepared.write,
                      prepared.checkpoint,
                      true,
                    )
                  for (const change of prepared.changes.slice(prefix)) await applyControl(change)
                  if (prepared.anchorChanged && prepared.anchor !== null)
                    await target.anchor.save(prepared.anchor)
                } finally {
                  controlBuildContexts.delete(stores.tx)
                }
                return {
                  value: prepared.result,
                  epoch: prepared.record.epoch,
                  control: copyStoredValue(prepared.snapshot),
                  anchor: copyStoredValue(prepared.anchor),
                }
              },
            )
          } catch (error) {
            await params.diagnoseFailure(error)
            throw error
          } finally {
            params.publish()
          }
        },
      })
    },
  }
  bindRegistryControlBatch(access, controlBatch)
  registryLiveSend.set(access, live)
  registryReceiveSlots.set(access, params.live)
  leaseReaders.set(access, live.snapshot)
  registryCapturedReplacements.set(access, async (captured, adoption, prepare) => {
    const next = await restoreCaptured(
      environment,
      capturedRecord(captured, owner.key, owner.value.record.version + 1),
    )
    if (prepare !== undefined) {
      const current = await readControl(async ({ handle, source }) => ({ handle, source }))
      if (!(await prepare(current.handle, current.source))) return false
    }
    const write = adoption?.(staged(next))
    if (write?.expected === undefined)
      throw new RegistryRecoveryReplacementError('Ordinary replacement requires provenance')
    await ordinary(captured, { expected: write.expected, write }, undefined, undefined, next)
    return true
  })
  return access
}
