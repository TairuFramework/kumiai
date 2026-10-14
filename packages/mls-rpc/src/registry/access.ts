import { encodeClientState, type GroupHandle } from '@kumiai/mls'
import {
  type AdoptionExpected,
  type AdoptionWrite,
  type ControlSnapshot,
  type ControlStore,
  controlSafetyHeld,
  GroupSafetyHeldError,
  type SafetyHold,
  type SendAdmission,
} from '@kumiai/rpc'

import type { ControlRead, ControlReadScope, HandleAccess } from '../access.js'
import { type ControlJournal, decodeControlJournal } from '../control-journal.js'
import { controlBuildContexts } from '../control-write-context.js'
import type { EntryCapability, EntryReads } from '../entry-capability.js'
import { sameStoredValue } from '../memory-incarnation-stores.js'
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
import { type ColdEnvironment, restoreValidated, type ValidatedGroupState } from './cold.js'
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
}

export function createRegistryAccess<TTx extends GroupTransaction>(params: {
  owner: RegistryOwner
  capability: EntryCapability<TTx>
  environment: ColdEnvironment
  restoreCandidate(candidate: Uint8Array): Promise<GroupHandle>
  resolve(mutationID: string): Promise<'committed' | 'rolled-back'>
  load(reads: EntryReads, assertMutationSafety?: () => void): Promise<ValidatedGroupState>
  publish(): void
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
          return await fn({ ...(await refresh()), refresh, loadControl })
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
    if (write?.expected?.journal === undefined || write.expected.acceptance === undefined)
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
  function recordFor(handle: GroupHandle, value: ValidatedGroupState): ReadableGroupState {
    validateRegistryHandle({
      handle,
      key: value.key,
      trust: value.trust,
      environment: environment.recovery,
      ownerDID: environment.ownerDID,
    })
    const generation =
      handle.state.secretTree.leafNodes[handle.state.privatePath.leafIndex]?.application
        .generation ?? 0
    return {
      ...value.record,
      version: value.record.version + 1,
      epoch: Number(handle.epoch),
      epochAuthenticator: handle.state.keySchedule.epochAuthenticator.slice(),
      state: encodeClientState(handle.state),
      credential: { ...handle.credential },
      ledger: [...handle.ledgerTokens],
      terminal: value.record.terminal || staged(handle).removed,
      senderHWM:
        Number(handle.epoch) === value.record.epoch
          ? Math.max(value.record.senderHWM, generation)
          : generation,
    }
  }
  async function writeState(
    stores: GroupStores<TTx>,
    record: ReadableGroupState,
    trust: ValidatedGroupState['trust'],
    write?: AdoptionWrite,
  ) {
    params.assertCurrent()
    await assertWorkSafety(stores)
    const target = stores.incarnation(owner.key.incarnation)
    await target.state.save(record, write?.expected)
    await stores.trust.save(trust)
    if (write !== undefined) {
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
      destination = await params.restoreCandidate(journal.candidate)
    } catch (cause) {
      throw moved(cause)
    }
    if (!ordinaryCandidateMatches(next, destination, owner.key)) throw moved()
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
    const proof = expected?.acceptance
    return (
      expected !== undefined &&
      proof !== undefined &&
      sameStoredValue(expected.key, owner.key) &&
      sameStoredValue(journal.source.key, owner.key) &&
      sameStoredValue(proof.source.key, owner.key) &&
      sameStoredValue(journal.source.identity, proof.source.identity) &&
      proof.from === journal.checkpoint
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
  ): Promise<GroupHandle | null> {
    const journal = journalFor(write)
    if (!ordinaryProof(write, journal)) throw moved()
    if (!committed) assertSafety()
    const destination = await destinationFor(next, write)
    if (committed) return null
    assertSafety()
    const control = await reads.control(owner.key.incarnation)
    const proof = write.expected?.acceptance
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
        (row?.payloadDigest === proof.payloadDigest && row.sequenceID === proof.position) ||
        (await reads.controlMutation(owner.key.incarnation)) === write.mutationID
      )
        return null
      throw moved()
    }
    if (
      !sameStoredValue(source, expected) ||
      !sameStoredValue(source, {
        key: write.expected?.key,
        stateVersion: write.expected?.stateVersion,
        identity: write.expected?.identity,
      }) ||
      !sameStoredValue(source.identity, journal.source.identity)
    )
      throw moved()
    assertSafety()
    if (prepare !== undefined && !(await prepare())) throw moved()
    assertSafety()
    if (
      controlSafetyHeld(control) !== null ||
      control.strand !== null ||
      control.cursor?.stranded === true ||
      (control.controlHold !== null && control.controlHold.reason !== 'acceptance-unknown') ||
      control.commitOnce === null ||
      control.commitOnce.payloadDigest !== proof.payloadDigest ||
      control.commitOnce.searchFrom !== proof.from ||
      !sameStoredValue(control.commitOnce.journal, write.expected?.journal) ||
      !sameStoredValue(control.commitOnceAcceptance, proof)
    )
      throw moved()
    return destination
  }
  async function ordinary(
    next: GroupHandle,
    supplied: { expected: AdoptionExpected; write: AdoptionWrite } | undefined,
    prepare?: Parameters<HandleAccess['replace']>[2],
    adoption?: Parameters<HandleAccess['replace']>[1],
  ): Promise<'installed' | 'noop'> {
    params.assertAvailable()
    assertMutationID(supplied?.write)
    const committed = supplied === undefined ? false : await proved(supplied.write.mutationID)
    try {
      return await capability.run(
        { groupID: owner.key.groupID, mutationID: supplied?.write.mutationID ?? null },
        async (reads) => {
          if (supplied !== undefined && (committed || params.safetyHeld() !== null)) {
            const { write } = supplied
            const journal = journalFor(write)
            if (!ordinaryProof(write, journal)) throw moved()
            let replay = committed
            if (!replay) {
              const current = await readRecoverySource(reads, owner.key.groupID)
              const proof = write.expected?.acceptance
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
                  row.sequenceID === proof.position) ||
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
          assertSafety()
          // The decoded handle is isolated from the caller and only now may carry source progress.
          await current.carryReceiveProgress(destination)
          const record = recordFor(destination, value)
          const trust = recoveryTrustFor(destination, value.key, value.trust)
          return {
            expected: lifetime,
            mutationID: write.mutationID,
            value: { source, record, trust, write },
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
          })
          try {
            await writeState(stores, prepared.record, prepared.trust, prepared.write)
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
    let noopResult: { value: Awaited<ReturnType<typeof fn>> } | undefined
    try {
      return await capability.run(
        {
          groupID: owner.key.groupID,
          mutationID: adoption === undefined ? crypto.randomUUID() : null,
        },
        async (reads) => {
          assertSafety()
          const { handle, source } = await isolated(reads, assertSafety)
          assertSafety()
          const value = owner.value
          const lifetime = await reads.lifetime()
          let record: ReadableGroupState | undefined
          let trust: ValidatedGroupState['trust'] | undefined
          let write: AdoptionWrite | undefined
          let nooped = false
          let active = true
          const persist = async (candidate: GroupHandle): Promise<void> => {
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
              Number(candidate.epoch) !== value.record.epoch ||
              !sameStoredValue(
                candidate.state.keySchedule.epochAuthenticator,
                value.record.epochAuthenticator,
              )
            ) {
              const control = await reads.control(owner.key.incarnation)
              if (control.commitOnce !== null) throw moved()
            }
            const stagedRecord = recordFor(final, value)
            const stagedTrust = recoveryTrustFor(final, value.key, value.trust)
            if (!active) throw new Error('Mutation prepare scope has ended')
            record = stagedRecord
            trust = stagedTrust
            write = stagedWrite
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
          if (record === undefined || trust === undefined)
            throw new Error('Mutation state was not staged')
          return {
            expected: lifetime,
            mutationID: write?.mutationID ?? crypto.randomUUID(),
            value: { result, record, trust, write, source },
          }
        },
        async (stores, prepared) => {
          await assertWorkSafety(stores)
          if (prepared.write !== undefined && prepared.source.identity !== null)
            controlBuildContexts.set(stores.tx, {
              kind: 'adoption',
              before: prepared.source.identity,
              after: prepared.trust.installed,
            })
          try {
            await writeState(stores, prepared.record, prepared.trust, prepared.write)
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
    params.assertAvailable()
    assertSafety()
    await ordinary(next, undefined, prepare, adoption)
    next.confirmAdopted()
  }
  async function adopt(
    next: GroupHandle,
    expected: AdoptionExpected,
    write: AdoptionWrite,
  ): Promise<'installed' | 'noop' | 'moved'> {
    try {
      return await ordinary(next, { expected, write })
    } catch (error) {
      if (error instanceof Error && error.name === 'ControlAdoptionMovedError') return 'moved'
      throw error
    }
  }
  return {
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
      return { ...owner.admission }
    },
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
}
