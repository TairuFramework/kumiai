import {
  ApplicationSendRefusedError,
  bindSendCeiling,
  decodeClientState,
  type GroupHandle,
  isApplicationSendDenied,
  ownApplicationGeneration,
  restrictCommitAuthoring,
} from '@kumiai/mls'
import {
  type ControlSnapshot,
  decodeAppAAD,
  GroupSafetyHeldError,
  type SafetyHold,
  type SendAdmission,
  SendNotAdmissibleError,
} from '@kumiai/rpc'

import type {
  ClosingPreparation,
  EntryCapability,
  EntryReads,
  Prepared,
} from '../entry-capability.js'
import { entryReadsAttempt } from '../entry-capability.js'
import { copyStoredValue, sameStoredValue } from '../memory-incarnation-stores.js'
import {
  GroupStateConflictError,
  GroupStateUncertainError,
  RegistryRetiringError,
  StorageOutcomeUnknownError,
} from '../persistence-errors.js'
import type { EpochIdentity, GroupStores, GroupTransaction } from '../persistence-types.js'
import { untilAbort } from '../runtime.js'
import type { RegistryOwner } from './access.js'
import { scheduleRegistryAccounting } from './accounting.js'
import { type ColdEnvironment, copyRecord } from './cold.js'
import { setReceiveBase } from './live-receive.js'
import {
  eligibilityOf,
  LEASE_AWAIT_MS,
  LEASE_MAX_GENERATION,
  LEASE_RENEW_BELOW,
  type Reservation,
  reservationEnvelope,
  reserveFromBytes,
} from './reserve.js'
import { readSourceAdmission } from './source-command-runtime.js'
import type { CryptoCommands, SourceCryptoScope } from './source-crypto-commands.js'
import { sourceCryptoScope } from './source-crypto-commands.js'
import type { GroupHandleRegistry, ReadableGroupState, RegistryHandleAccess } from './types.js'

export class ApplicationLeaseUnavailableError extends Error {
  #reason: 'cold' | 'exhausted' | 'deferred'
  constructor(reason: 'cold' | 'exhausted' | 'deferred') {
    super(`Application lease unavailable: ${reason}`)
    this.name = 'ApplicationLeaseUnavailableError'
    this.#reason = reason
  }
  get reason() {
    return this.#reason
  }
}

export type SendCopy = {
  copy: GroupHandle
  identity: EpochIdentity
  limit: number
  eligibility: Uint8Array
}
export type LiveSlot = {
  inflight: Set<Promise<unknown>>
  base: ReadableGroupState | null
  receive: GroupHandle | null
  receiveDigest: Uint8Array | null
  consumed: { incarnation: number | null; epochs: Map<number, Set<string>>; closed: Set<number> }
  cancellation: AbortController
  refresh: (() => Promise<void> | null) | null
}
type Saved = {
  record: ReadableGroupState
  reservation?: Reservation | null
  publicationCopy?: SendCopy
  eligibility: Uint8Array
}
type OwnProof = Saved & { generation: number; registered: boolean; proven: boolean }

export const registryMaintenanceGates = new WeakMap<
  GroupHandleRegistry,
  (signal: AbortSignal) => Promise<void>
>()

export const leaseReaders = new WeakMap<
  RegistryHandleAccess,
  () => {
    copy: GroupHandle
    identity: EpochIdentity
    limit: number
    own: number
    storedGeneration: number
    knownVersion: number
    expectedVersions: Array<number>
  } | null
>()
export const liveHandles = new WeakSet<GroupHandle>()
export const registryLiveSend = new WeakMap<
  RegistryHandleAccess,
  ReturnType<typeof createLiveSend>
>()

export function committedNext(record: ReadableGroupState): number {
  const state = decodeClientState(record.state)
  return Math.max(state === undefined ? 0 : ownApplicationGeneration(state), record.senderHWM)
}

export function sendCompatible(
  previous: ReadableGroupState,
  candidate: ReadableGroupState,
  previousEligibility: Uint8Array,
  eligibility: Uint8Array,
): boolean {
  return (
    sameStoredValue(identityOf(previous), identityOf(candidate)) &&
    sameStoredValue(previous.state, candidate.state) &&
    sameStoredValue(previousEligibility, eligibility)
  )
}

function identityOf(record: ReadableGroupState): EpochIdentity {
  return {
    groupID: record.groupID,
    incarnation: record.incarnation,
    epoch: record.epoch,
    authenticator: record.epochAuthenticator,
  }
}

type Headroom =
  | { kind: 'cold' }
  | { kind: 'pending'; proof: OwnProof; fence: number }
  | { kind: 'live'; copy: SendCopy; fence: number }
type CommittedSend = {
  classifiedVersion: number
  record: ReadableGroupState
  control: ControlSnapshot
  eligibility: Uint8Array
  headroom: Headroom
}
type CommittedEvidence = {
  kind: 'initial' | 'own' | 'observed' | 'refresh' | 'foreign'
  control?: ControlSnapshot
  eligibility?: Uint8Array
  proof?: OwnProof
  current?: () => boolean
}

export function createLiveSlot(): LiveSlot {
  return {
    inflight: new Set(),
    base: null,
    receive: null,
    receiveDigest: null,
    consumed: { incarnation: null, epochs: new Map(), closed: new Set() },
    cancellation: new AbortController(),
    refresh: null,
  }
}

export function createLiveSend<TTx extends GroupTransaction>(params: {
  owner: RegistryOwner
  executeMaintain(): Promise<void>
  executeHandoff(): Promise<void>
  executeSeal(
    input: CryptoCommands['app.seal']['input'],
    signal: AbortSignal,
  ): Promise<CryptoCommands['app.seal']['output']>
  initialControl: ControlSnapshot
  initialEligibility: Uint8Array
  slot: LiveSlot
  capability: EntryCapability<TTx>
  binding: object
  environment: ColdEnvironment
  resolve(mutationID: string): Promise<'committed' | 'rolled-back'>
  assertAvailable(): void
  assertCurrent(): void
  assertWorkSafety(stores: GroupStores<TTx>): Promise<void>
  safetyHeld(): SafetyHold
  diagnoseFailure(error: unknown): Promise<void>
  publish(): void
  admissionChanged(): void
  dropOwner(): void
  waitForMaintenanceGate(signal: AbortSignal): Promise<void> | undefined
}) {
  const { owner, slot, capability, environment } = params
  const proofs = new WeakMap<ReadableGroupState, OwnProof>()
  let generation = 0
  let sealVersion = 0
  let encryptFault: {
    when: 'throw-before' | 'throw-after' | 'block'
    entered(): void
    release: Promise<void>
  } | null = null
  let publicationConsumed: { identity: EpochIdentity; next: number } | null = null
  let foreignGeneration = 0
  let closed = false
  let paused = false
  let committed!: CommittedSend
  let deferred = false
  let cancellation = new AbortController()
  const closing = new AbortController()
  let maintenance: Promise<void> | null = null
  const pendingAccept = new Set<OwnProof>()
  let maintenanceAbort: AbortController | null = null
  let block: { started(): void; release: Promise<void> } | null = null
  const admissionListeners = new Set<() => void>()
  void advanceCommitted(owner.value.record.version, owner.value.record, {
    kind: 'initial',
    control: params.initialControl,
    eligibility: params.initialEligibility,
  })
  let lastAdmission = admission()
  let rotationIdentity: EpochIdentity | null = null
  const rotationListeners = new Set<(identity: EpochIdentity) => void>()
  const resolutions = new Set<Promise<void>>()
  const checks = new Set<Promise<void>>()
  const accountingStarts = new Set<() => void>()
  const unresolved = new Set<OwnProof>()
  let observedVersion = committed.classifiedVersion

  function available(): boolean {
    if (closed || paused) return false
    try {
      params.assertAvailable()
      return true
    } catch {
      return false
    }
  }
  function assertSeal(): void {
    params.assertAvailable()
    const safety = params.safetyHeld()
    if (safety !== null) throw new GroupSafetyHeldError(safety)
    const current = admission()
    if (!current.admissible) throw new SendNotAdmissibleError(current.reason)
  }
  function invalidate(): void {
    sealVersion++
    generation++
    foreignGeneration++
    committed.headroom = { kind: 'cold' }
    changed()
  }
  function committedGeneration(): number {
    return committedNext(committed.record)
  }
  function needsMaintenance(): boolean {
    const copy = sendCopy()
    return (
      available() &&
      unresolved.size === 0 &&
      pendingAccept.size === 0 &&
      !deferred &&
      owner.admission.admissible &&
      params.safetyHeld() === null &&
      committedGeneration() < LEASE_MAX_GENERATION &&
      currentNext() < LEASE_MAX_GENERATION &&
      (copy === null || copy.limit - currentNext() < LEASE_RENEW_BELOW)
    )
  }
  function sendCopy(): SendCopy | null {
    return committed.headroom.kind === 'live' ? committed.headroom.copy : null
  }
  function currentNext(): number {
    const headroom = committed.headroom
    const next =
      headroom.kind === 'pending' && headroom.proof.reservation != null
        ? headroom.proof.reservation.start
        : headroom.kind === 'live'
          ? ownApplicationGeneration(headroom.copy.copy.state)
          : committedGeneration()
    return publicationConsumed !== null &&
      sameStoredValue(publicationConsumed.identity, identityOf(committed.record))
      ? Math.max(next, publicationConsumed.next)
      : next
  }
  function admission(): SendAdmission {
    const base = owner.admission
    const reason = params.safetyHeld()
    if (reason !== null) return { epoch: base.epoch, admissible: false, reason }
    return base.admissible && currentNext() >= LEASE_MAX_GENERATION
      ? { epoch: base.epoch, admissible: false, reason: 'rotation-required' }
      : { ...base }
  }
  function supplyRotation(listener: (identity: EpochIdentity) => void, identity: EpochIdentity) {
    try {
      listener({ ...identity, authenticator: identity.authenticator.slice() })
    } catch {
      /* Advisory listener. */
    }
  }
  function changed(): void {
    const next = admission()
    params.admissionChanged()
    if (!sameStoredValue(lastAdmission, next)) {
      lastAdmission = next
      for (const listener of [...admissionListeners]) {
        try {
          listener()
        } catch {
          /* Advisory listener. */
        }
      }
    }
    notifyRotation()
  }
  function notifyRotation(): void {
    const identity = identityOf(committed.record)
    if (
      currentNext() < LEASE_MAX_GENERATION ||
      (rotationIdentity !== null && !sameStoredValue(rotationIdentity, identity))
    )
      rotationIdentity = null
    if (currentNext() < LEASE_MAX_GENERATION || rotationIdentity !== null) return
    rotationIdentity = { ...identity, authenticator: identity.authenticator.slice() }
    for (const listener of [...rotationListeners]) supplyRotation(listener, identity)
  }
  async function account(proof: OwnProof): Promise<void> {
    if (!available() || !proof.registered || proof.generation !== foreignGeneration) return
    proof.proven = true
    await advanceCommitted(proof.record.version, proof.record, { kind: 'own', proof })
  }

  // Publish the frontier, its snapshot and all headroom decisions together.
  async function advanceCommitted(
    version: number,
    candidate: ReadableGroupState | undefined,
    evidence: CommittedEvidence,
    attempt = 0,
  ): Promise<void> {
    const previous = committed
    const fence = generation
    const foreignFence = foreignGeneration
    const current = () =>
      (evidence.kind === 'initial' || available()) &&
      (evidence.current?.() ?? true) &&
      (previous === undefined || version >= committed.classifiedVersion)
    if (!current()) return
    const retry = () => {
      // A same-version successor owns its newer control snapshot.
      const nextEvidence =
        committed !== previous && version === committed.classifiedVersion
          ? { ...evidence, control: undefined }
          : evidence
      // Four restores at most. Unstable compatibility is foreign, never reusable headroom.
      return advanceCommitted(
        version,
        candidate,
        attempt < 3 ? nextEvidence : { ...nextEvidence, kind: 'foreign' },
        attempt + 1,
      )
    }
    const expected = owner.expected.get(version)
    const proof = evidence.proof ?? (expected === undefined ? undefined : proofs.get(expected))
    const own =
      candidate !== undefined &&
      proof?.registered &&
      proof.generation === foreignGeneration &&
      sameStoredValue(candidate.state, proof.record.state) &&
      sameStoredValue(identityOf(candidate), identityOf(proof.record))
    if (own) proof.proven = true
    if (
      previous !== undefined &&
      version === previous.classifiedVersion &&
      previous.record.version === version &&
      sameStoredValue(candidate, previous.record) &&
      evidence.kind !== 'foreign' &&
      (evidence.control === undefined || sameStoredValue(evidence.control, previous.control)) &&
      (evidence.eligibility === undefined ||
        sameStoredValue(evidence.eligibility, previous.eligibility))
    )
      return
    let eligibility = evidence.eligibility ?? (own ? proof.eligibility : previous.eligibility)
    const control = evidence.control ?? previous.control
    let compatible = false
    if (previous !== undefined && candidate !== undefined && !own && evidence.kind !== 'foreign') {
      try {
        if (sameStoredValue(previous.record.state, candidate.state)) {
          if (
            evidence.eligibility === undefined &&
            (!sameStoredValue(control, previous.control) ||
              !sameStoredValue(candidate.ledger, previous.record.ledger) ||
              !sameStoredValue(candidate.credential, previous.record.credential) ||
              candidate.terminal !== previous.record.terminal)
          ) {
            const handle = restrictCommitAuthoring(await environment.restore(copyRecord(candidate)))
            eligibility = eligibilityOf(handle.state, handle.ownLeafLapsed())
          }
          if (!current()) return
          if (generation !== fence || foreignGeneration !== foreignFence) {
            schedule()
            return retry()
          }
          if (committed !== previous) return retry()
          compatible = sendCompatible(previous.record, candidate, previous.eligibility, eligibility)
        }
      } catch {
        if (!current()) return
        if (generation !== fence || foreignGeneration !== foreignFence) return retry()
      }
    }
    if (!current()) return
    if (generation !== fence || foreignGeneration !== foreignFence) return retry()
    if (committed !== previous) return retry()
    let headroom: Headroom = previous?.headroom ?? { kind: 'cold' }
    const foreign = previous !== undefined && !own && !compatible
    if (foreign) {
      foreignGeneration++
      sealVersion++
      generation++
      headroom = { kind: 'cold' }
    } else if (own) {
      if (
        previous !== undefined &&
        (!sameStoredValue(identityOf(previous.record), identityOf(proof.record)) ||
          !sameStoredValue(previous.eligibility, eligibility))
      ) {
        sealVersion++
        generation++
        headroom = { kind: 'cold' }
      }
      if (headroom.kind !== 'live' && proof.reservation != null)
        headroom = { kind: 'pending', proof, fence: generation }
    }
    if (candidate === undefined) {
      committed = { ...previous, classifiedVersion: version, headroom }
    } else {
      committed = {
        classifiedVersion: version,
        record: copyRecord(candidate),
        control: copyStoredValue(control),
        eligibility: eligibility.slice(),
        headroom,
      }
      const state = decodeClientState(candidate.state)
      deferred =
        state !== undefined &&
        (state.groupActiveState.kind !== 'active' ||
          Object.keys(state.unappliedProposals).length !== 0)
      if (evidence.kind !== 'observed' && evidence.kind !== 'foreign')
        setReceiveBase(slot, candidate)
    }
    if (evidence.kind === 'initial') return
    if (foreign && evidence.kind !== 'refresh') {
      slot.base = null
      slot.refresh?.()
    }
    changed()
    if (foreign) schedule()
  }
  async function accept(proof: OwnProof, scope: SourceCryptoScope): Promise<void> {
    const headroom = committed.headroom
    const fence = headroom.kind === 'cold' ? generation : headroom.fence
    try {
      await acceptReservation(proof, scope)
    } catch {
      if (generation === fence && committed.headroom === headroom) {
        invalidate()
        schedule()
      }
    } finally {
      if (committed.headroom.kind === 'pending' && committed.headroom.proof === proof)
        committed.headroom = { kind: 'cold' }
      changed()
    }
  }
  async function acceptReservation(proof: OwnProof, scope: SourceCryptoScope): Promise<void> {
    const reservation = proof.reservation
    if (reservation == null || !proof.registered || !proof.proven) return
    const saved = reservation.envelope?.saved
    const proven = saved === undefined ? undefined : decodeClientState(saved.state)
    const valid = () =>
      available() &&
      proof.generation === foreignGeneration &&
      sameStoredValue(owner.key, {
        groupID: reservation.identity.groupID,
        incarnation: reservation.identity.incarnation,
      }) &&
      sameStoredValue(identityOf(committed.record), reservation.identity) &&
      sameStoredValue(committed.eligibility, reservation.eligibility)
    if (
      saved === undefined ||
      proven === undefined ||
      reservation.envelope.version !== saved.version ||
      saved.version !== proof.record.version ||
      !sameStoredValue(saved.state, proof.record.state) ||
      !sameStoredValue(identityOf(saved), reservation.identity) ||
      reservation.limit > ownApplicationGeneration(proven) ||
      !valid()
    ) {
      if (available() && proof.generation === foreignGeneration) invalidate()
      return
    }
    if (proof.publicationCopy !== undefined) {
      const copy = proof.publicationCopy
      if (ownApplicationGeneration(copy.copy.state) > reservation.limit) return
      copy.limit = reservation.limit
      committed.headroom = { kind: 'live', copy, fence: generation }
      deferred = false
      return
    }
    params.assertCurrent()
    const current = sendCopy()
    if (current !== null && sameStoredValue(current.identity, reservation.identity)) {
      if (
        !sameStoredValue(current.eligibility, reservation.eligibility) ||
        reservation.start < current.limit
      ) {
        invalidate()
        return
      }
      if (reservation.start === current.limit) {
        current.limit = reservation.limit
        deferred = false
        return
      }
    }
    const headroom = committed.headroom
    const capturedGeneration = headroom.kind === 'cold' ? generation : headroom.fence
    const restore = async () =>
      restrictCommitAuthoring(await environment.restore(copyRecord(reservation.pre)))
    const copy = restrictCommitAuthoring(await scope.call(restore))
    scope.assertLive()
    if (
      !valid() ||
      generation !== capturedGeneration ||
      committed.headroom !== headroom ||
      !sameStoredValue(eligibilityOf(copy.state, copy.ownLeafLapsed()), reservation.eligibility) ||
      ownApplicationGeneration(copy.state) !== reservation.start
    )
      return
    const record: SendCopy = {
      copy,
      identity: reservation.identity,
      limit: reservation.limit,
      eligibility: reservation.eligibility.slice(),
    }
    bindSendCeiling(copy, () => record.limit)
    liveHandles.add(copy)
    committed.headroom = { kind: 'live', copy: record, fence: generation }
    deferred = false
  }
  function register(saved: Saved): OwnProof {
    const record = copyRecord(saved.record)
    const proof = {
      ...saved,
      record,
      eligibility: saved.eligibility.slice(),
      generation: foreignGeneration,
      registered: true,
      proven: false,
    }
    unresolved.add(proof)
    owner.expected.set(record.version, record)
    proofs.set(record, proof)
    return proof
  }
  function foreign(
    version: number,
    record?: ReadableGroupState,
    control?: ControlSnapshot,
    eligibility?: Uint8Array,
  ): Promise<void> {
    return advanceCommitted(version, record, { kind: 'foreign', control, eligibility })
  }
  function observed(version: number, stillCurrent: () => boolean): () => void {
    observedVersion = Math.max(observedVersion, version)
    const signal = cancellation.signal
    if (signal.aborted) return () => {}
    const current = () =>
      !signal.aborted &&
      available() &&
      stillCurrent() &&
      version >= observedVersion &&
      version >= committed.classifiedVersion
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    let started = false
    const check = () => {
      if (started || signal.aborted) return
      started = true
      void scheduleRegistryAccounting({
        capability,
        binding: params.binding,
        key: owner.key,
        source: 'live',
        signal,
        current,
        read: async (reads) => {
          if (!current()) return
          const record = await reads.state(owner.key.incarnation)
          const nextControl = await reads.control(owner.key.incarnation)
          // A newer observation owns classification, including after an async restore.
          if (!current() || (record !== null && record.version > version)) return
          if (
            record === null ||
            record.deleted ||
            record.state === null ||
            record.version !== version ||
            decodeClientState(record.state) === undefined
          ) {
            await foreign(version)
            return
          }
          await advanceCommitted(
            version,
            { ...record, state: record.state },
            {
              kind: 'observed',
              control: nextControl,
              current,
            },
          )
        },
      }).then(finish, () => {
        if (current()) foreign(version)
        finish()
      })
    }
    checks.add(pending)
    accountingStarts.add(check)
    slot.inflight.add(pending)
    signal.addEventListener('abort', finish, { once: true })
    // A microtask can still inherit the provider's active ownership context.
    const fallback = setTimeout(check, 0)
    void pending.then(() => {
      clearTimeout(fallback)
      signal.removeEventListener('abort', finish)
      accountingStarts.delete(check)
      checks.delete(pending)
      slot.inflight.delete(pending)
    })
    return check
  }
  async function accounting(): Promise<void> {
    while (checks.size !== 0) await Promise.allSettled([...checks])
  }
  async function settle(proof: OwnProof, outcome: 'committed' | 'rolled-back'): Promise<void> {
    unresolved.delete(proof)
    if (outcome === 'committed') await account(proof)
    if (owner.expected.get(proof.record.version) === proof.record)
      owner.expected.delete(proof.record.version)
    if (outcome === 'committed' && proof.reservation != null && available()) {
      pendingAccept.add(proof)
      await params.executeHandoff()
    }
    schedule()
  }
  async function delay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      signal.addEventListener('abort', done, { once: true })
    })
  }
  function resolveLater(proof: OwnProof, mutationID: string): void {
    const pending = (async () => {
      let backoff = 100
      while (!closed) {
        await delay(backoff, closing.signal)
        if (closed) return
        try {
          await settle(proof, await params.resolve(mutationID))
          return
        } catch (error) {
          if (error instanceof GroupStateUncertainError) {
            unresolved.delete(proof)
            schedule()
            return
          }
          backoff = Math.min(backoff * 2, 15_000)
        }
      }
    })()
    resolutions.add(pending)
    void pending.finally(() => {
      resolutions.delete(pending)
    })
  }
  async function run<P extends Saved, T>(
    request: { groupID: string; mutationID: string | null },
    prepare: (reads: EntryReads, closing: ClosingPreparation) => Promise<Prepared<P>>,
    work: (stores: GroupStores<TTx>, prepared: P) => Promise<T>,
    effects?: (stores: GroupStores<TTx>, prepared: P, result: T) => Promise<void>,
  ): Promise<T> {
    let proof: OwnProof | undefined
    let mutationID = request.mutationID
    try {
      const result = await capability.run(
        request,
        async (reads, closing) => {
          let prepared = await prepare(reads, closing)
          mutationID = prepared.mutationID ?? mutationID
          proof = register(prepared.value)
          const value = prepared.value as { record?: ReadableGroupState }
          if (value.record?.terminal && !owner.value.record.terminal) {
            prepared = await closing.freeze({
              source: owner.key,
              reason: 'terminal',
              prepared,
              domain: { states: [value.record], lifetime: null },
            })
          }
          return prepared
        },
        work,
        effects,
      )
      if (proof !== undefined) await settle(proof, 'committed')
      return result
    } catch (error) {
      if (proof !== undefined) {
        if (!(error instanceof StorageOutcomeUnknownError)) await settle(proof, 'rolled-back')
        else if (mutationID !== null) {
          let outcome: 'committed' | 'rolled-back' | undefined
          try {
            outcome = await params.resolve(mutationID)
          } catch (failure) {
            if (failure instanceof GroupStateUncertainError) {
              unresolved.delete(proof)
              schedule()
            } else resolveLater(proof, mutationID)
          }
          if (outcome !== undefined) await settle(proof, outcome)
        }
      }
      throw error
    } finally {
      for (const start of accountingStarts) start()
    }
  }
  class NoReservation extends Error {}
  async function maintain(signal: AbortSignal): Promise<void> {
    await run(
      { groupID: owner.key.groupID, mutationID: crypto.randomUUID() },
      async (reads) => {
        params.assertAvailable()
        await readSourceAdmission(reads, owner.key)
        const scope = sourceCryptoScope(entryReadsAttempt(reads), params.assertAvailable)
        const ownedEnvironment: ColdEnvironment = {
          ...environment,
          restore: async (record) =>
            scope.protect(
              restrictCommitAuthoring(await scope.call(() => environment.restore(record))),
            ),
        }
        if (!needsMaintenance() || signal.aborted) throw new NoReservation()
        const lifetime = await reads.lifetime()
        const record = await reads.state(owner.key.incarnation)
        if (
          lifetime?.activeIncarnation !== owner.key.incarnation ||
          record === null ||
          record.deleted ||
          record.state === null
        )
          throw new NoReservation()
        const reserved = await reserveFromBytes(
          ownedEnvironment,
          { ...record, state: record.state },
          Math.max(record.senderHWM, currentNext()),
        )
        if (reserved.reservation === null) {
          deferred = true
          throw new NoReservation()
        }
        const saved: ReadableGroupState = {
          ...record,
          state: reserved.state,
          version: record.version + 1,
          senderHWM: reserved.senderHWM,
        }
        return {
          expected: lifetime,
          value: {
            record: saved,
            eligibility: reserved.reservation.eligibility,
            reservation: { ...reserved.reservation, envelope: reservationEnvelope(saved) },
          },
        }
      },
      async (stores, prepared) => {
        params.assertAvailable()
        if (signal.aborted) throw new NoReservation()
        await params.assertWorkSafety(stores)
        const target = stores.incarnation(owner.key.incarnation)
        const current = await target.state.load()
        if (current?.version !== prepared.record.version - 1)
          throw new GroupStateConflictError('Lease source moved')
        await target.state.save(prepared.record)
      },
    )
  }
  async function acceptPending(scope: SourceCryptoScope): Promise<void> {
    for (const proof of [...pendingAccept]) {
      scope.assertLive()
      await accept(proof, scope)
      scope.assertLive()
      pendingAccept.delete(proof)
    }
  }
  function schedule(): Promise<void> | null {
    if (maintenance !== null) return maintenance
    if (!needsMaintenance()) return null
    const abort = new AbortController()
    maintenanceAbort = abort
    const pending = (async () => {
      await delay(0, abort.signal)
      let backoff = 100
      while (!abort.signal.aborted && needsMaintenance()) {
        await params.waitForMaintenanceGate(abort.signal)
        const blocked = block
        if (blocked !== null) {
          block = null
          blocked.started()
          await Promise.race([
            blocked.release,
            new Promise<void>((resolve) =>
              abort.signal.addEventListener('abort', () => resolve(), { once: true }),
            ),
          ])
        }
        if (abort.signal.aborted || !needsMaintenance()) return
        try {
          await params.executeMaintain()
          if (sendCopy() === null && needsMaintenance()) {
            await delay(backoff, abort.signal)
            backoff = Math.min(backoff * 2, 15_000)
            continue
          }
          return
        } catch (error) {
          if (error instanceof NoReservation || abort.signal.aborted || !available()) return
          await params.diagnoseFailure(error)
          await delay(backoff, abort.signal)
          backoff = Math.min(backoff * 2, 15_000)
        } finally {
          params.publish()
        }
      }
    })()
    maintenance = pending
    const finished = () => {
      if (maintenance !== pending) return
      maintenance = null
      if (abort.signal.aborted) schedule()
    }
    void pending.then(finished, finished)
    return pending
  }
  async function waitForMaintenance(job: Promise<void> | null): Promise<void> {
    if (job === null) return
    const signal = cancellation.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort!: () => void
    try {
      await Promise.race([
        (async () => {
          let pending: Promise<void> | null = job
          while (pending !== null) {
            await pending
            if (maintenance === pending) return
            pending = maintenance
          }
        })(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, LEASE_AWAIT_MS)
        }),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(signal.reason)
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        }),
      ])
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }
  function seal(plaintext: Uint8Array, opts: { aad: Uint8Array; intent: 'log' | 'ephemeral' }) {
    const bytes = new Uint8Array(plaintext)
    const aad = new Uint8Array(opts.aad)
    const intent = opts.intent
    const signal = cancellation.signal
    const pending = (async () => {
      params.assertAvailable()
      if ((decodeAppAAD(aad)?.intent ?? 'ephemeral') !== intent)
        throw new TypeError('App AAD intent mismatch')
      assertSeal()
      await untilAbort(accounting(), signal)
      for (let attempt = 0; ; attempt++) {
        if (signal.aborted) throw signal.reason
        assertSeal()
        const record = sendCopy()
        let exhausted =
          record !== null && ownApplicationGeneration(record.copy.state) >= record.limit
        if (record !== null && !exhausted) {
          try {
            return await params.executeSeal({ plaintext: bytes, aad, intent }, signal)
          } catch (error) {
            if (
              !(error instanceof ApplicationSendRefusedError) ||
              isApplicationSendDenied(record.copy) ||
              ownApplicationGeneration(record.copy.state) < record.limit
            )
              throw error
            exhausted = true
          } finally {
            changed()
            schedule()
          }
        }
        const reason = deferred ? 'deferred' : exhausted ? 'exhausted' : 'cold'
        const job = schedule()
        if (intent !== 'log' || attempt !== 0) throw new ApplicationLeaseUnavailableError(reason)
        await waitForMaintenance(job)
      }
    })()
    slot.inflight.add(pending)
    void pending.then(
      () => slot.inflight.delete(pending),
      () => slot.inflight.delete(pending),
    )
    return pending
  }
  function cancel(reason: unknown, permanent = false): void {
    paused = true
    foreignGeneration++
    closed ||= permanent
    pendingAccept.clear()
    if (permanent) closing.abort(reason)
    maintenanceAbort?.abort(reason)
    cancellation.abort(reason)
    invalidate()
  }
  async function sealOwned(input: CryptoCommands['app.seal']['input'], scope: SourceCryptoScope) {
    scope.assertLive()
    params.assertAvailable()
    const held = params.safetyHeld()
    if (held !== null) throw new GroupSafetyHeldError(held)
    const record = sendCopy()
    if (record === null) throw new ApplicationLeaseUnavailableError('cold')
    if (ownApplicationGeneration(record.copy.state) >= record.limit)
      throw new ApplicationLeaseUnavailableError('exhausted')
    assertSeal()
    const allocated = ownApplicationGeneration(record.copy.state)
    if ((decodeAppAAD(input.aad)?.intent ?? 'ephemeral') !== input.intent)
      throw new TypeError('App AAD intent mismatch')
    const unsubscribe = scope.onRevoke(() => {
      if (record === sendCopy()) invalidate()
      schedule()
    })
    try {
      const scratch = scope.protect(record.copy)
      scope.assertLive()
      sealVersion++
      const fault = encryptFault
      encryptFault = null
      if (fault !== null) {
        fault.entered()
        if (fault.when === 'throw-before')
          throw new Error('Injected encryption failure before consumption')
        if (fault.when === 'block') await fault.release
      }
      scope.assertLive()
      if (ownApplicationGeneration(record.copy.state) !== allocated)
        throw new ApplicationLeaseUnavailableError('exhausted')
      const sealed = await scope.call(() =>
        scratch.encryptApplication(input.plaintext, { aad: input.aad }),
      )
      if (fault?.when === 'throw-after')
        throw new Error('Injected encryption failure after consumption')
      scope.assertLive()
      if (record !== sendCopy()) throw new ApplicationLeaseUnavailableError('cold')
      return { ...sealed, epoch: record.identity.epoch }
    } catch (error) {
      try {
        scope.assertLive()
      } catch {
        // A revoked scratch copy burns the remainder of its reserved range.
        if (record === sendCopy()) invalidate()
      }
      throw error
    } finally {
      unsubscribe()
    }
  }
  async function prepareSeal(
    record: ReadableGroupState,
    bytes: Uint8Array,
    aad: Uint8Array,
    scope: SourceCryptoScope,
  ) {
    scope.assertLive()
    const ownedEnvironment: ColdEnvironment = {
      ...environment,
      restore: async (record) =>
        scope.protect(restrictCommitAuthoring(await scope.call(() => environment.restore(record)))),
    }
    assertSeal()
    let copy = sendCopy()
    if (!sameStoredValue(identityOf(record), identityOf(committed.record)))
      throw new GroupStateConflictError('Publication identity moved')
    const renew =
      copy === null || copy.limit - ownApplicationGeneration(copy.copy.state) < LEASE_RENEW_BELOW
    let reserved =
      renew && committedNext(record) < LEASE_MAX_GENERATION
        ? await reserveFromBytes(
            ownedEnvironment,
            record,
            Math.max(record.senderHWM, currentNext()),
          )
        : null
    if (reserved !== null && reserved.reservation === null) {
      if (copy === null || ownApplicationGeneration(copy.copy.state) >= copy.limit)
        throw new ApplicationLeaseUnavailableError('deferred')
      reserved = null
    }
    const saved =
      reserved === null
        ? { ...copyRecord(record), version: record.version + 1 }
        : {
            ...copyRecord(record),
            state: reserved.state,
            senderHWM: reserved.senderHWM,
            version: record.version + 1,
          }
    const reservation =
      reserved?.reservation == null
        ? null
        : {
            ...reserved.reservation,
            envelope: reservationEnvelope(saved),
          }
    if (copy === null || ownApplicationGeneration(copy.copy.state) >= copy.limit) {
      if (reservation === null) throw new ApplicationLeaseUnavailableError('exhausted')
      const handle = restrictCommitAuthoring(
        await ownedEnvironment.restore(copyRecord(reservation.pre)),
      )
      copy = {
        copy: handle,
        identity: reservation.identity,
        limit: reservation.limit,
        eligibility: Uint8Array.from(reservation.eligibility),
      }
      const staged = copy
      bindSendCeiling(handle, () => staged.limit)
      liveHandles.add(handle)
    }
    scope.assertLive()
    scope.protect(copy.copy)
    assertSeal()
    sealVersion++
    try {
      const sealed = await scope.call(() => copy.copy.encryptApplication(bytes, { aad }))
      scope.assertLive()
      return {
        record: saved,
        reservation,
        eligibility: Uint8Array.from(copy.eligibility),
        publicationCopy: copy,
        sealed,
      }
    } finally {
      const next = ownApplicationGeneration(copy.copy.state)
      const previous =
        publicationConsumed !== null && sameStoredValue(publicationConsumed.identity, copy.identity)
          ? publicationConsumed.next
          : 0
      publicationConsumed = { identity: copy.identity, next: Math.max(previous, next) }
      changed()
    }
  }
  return {
    prepareSeal,
    maintain: () => maintain(cancellation.signal),
    acceptPending,
    sealOwned,
    armEncryptFault(when: 'throw-before' | 'throw-after' | 'block') {
      let entered!: () => void
      let release!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      encryptFault = { when, entered, release: pending }
      return { started, release }
    },
    async publication<T>(fn: () => Promise<T>): Promise<T> {
      await accounting()
      return await fn()
    },
    frontier: () => sealVersion,
    unresolved: () => unresolved.size !== 0 || checks.size !== 0,
    pendingProof: () => unresolved.size !== 0,
    seal,
    run,
    observed,
    accounting,
    invalidate,
    schedule,
    effectiveNext: () => currentNext(),
    admission,
    changed,
    onAdmissionChanged(listener: () => void) {
      admissionListeners.add(listener)
      return () => {
        admissionListeners.delete(listener)
      }
    },
    snapshot() {
      const send = sendCopy()
      return send === null
        ? null
        : {
            copy: send.copy,
            identity: { ...send.identity, authenticator: send.identity.authenticator.slice() },
            limit: send.limit,
            own: ownApplicationGeneration(send.copy.state),
            storedGeneration: committedGeneration(),
            knownVersion: committed.classifiedVersion,
            expectedVersions: [...owner.expected.keys()],
          }
    },
    foreign,
    get classifiedVersion() {
      return committed.classifiedVersion
    },
    get committedRecord() {
      return committed.record
    },
    refreshed(
      record: ReadableGroupState,
      eligibility: Uint8Array | undefined,
      control?: ControlSnapshot,
    ) {
      return advanceCommitted(record.version, record, { kind: 'refresh', eligibility, control })
    },
    async handoff(reservation: Reservation, scope: SourceCryptoScope) {
      if (!available()) return
      const record = reservation.envelope?.saved
      if (record === undefined) return
      const loaded = committed.record
      if (
        loaded.version !== committed.classifiedVersion ||
        loaded.version < reservation.envelope.version ||
        !sendCompatible(record, loaded, reservation.eligibility, committed.eligibility)
      )
        return
      const state = decodeClientState(loaded.state)
      if (state === undefined || reservation.limit > ownApplicationGeneration(state)) return
      const proof: OwnProof = {
        record,
        reservation,
        eligibility: reservation.eligibility,
        generation: foreignGeneration,
        registered: true,
        proven: true,
      }
      // Announced exhaustion reopens only after the copy has actually restored.
      if (committed.headroom.kind === 'cold' && rotationIdentity === null) {
        committed.headroom = { kind: 'pending', proof, fence: generation }
        changed()
      }
      await accept(proof, scope)
      schedule()
    },
    cancel,
    retire() {
      cancel(new RegistryRetiringError({ key: owner.key }))
    },
    resume() {
      if (!closed) {
        paused = false
        cancellation = new AbortController()
        schedule()
      }
    },
    onRotationRequired(listener: (identity: EpochIdentity) => void) {
      notifyRotation()
      rotationListeners.add(listener)
      if (rotationIdentity !== null) supplyRotation(listener, rotationIdentity)
      return () => {
        rotationListeners.delete(listener)
      }
    },
    async drain() {
      while (maintenance !== null || resolutions.size !== 0) {
        await maintenance
        await Promise.allSettled(resolutions)
      }
    },
    blockMaintenance() {
      let started!: () => void
      let release!: () => void
      const entered = new Promise<void>((resolve) => {
        started = resolve
      })
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      block = { started, release: released }
      return { started: entered, release }
    },
    dropOwner: params.dropOwner,
  }
}
