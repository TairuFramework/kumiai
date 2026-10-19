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
  SendNotAdmissibleError,
} from '@kumiai/rpc'

import type { EntryCapability, EntryReads, Prepared } from '../entry-capability.js'
import { copyStoredValue, sameStoredValue } from '../memory-incarnation-stores.js'
import {
  GroupStateConflictError,
  GroupStateUncertainError,
  RegistryRetiringError,
  StorageOutcomeUnknownError,
} from '../persistence-errors.js'
import type { EpochIdentity, GroupStores, GroupTransaction } from '../persistence-types.js'
import type { RegistryOwner } from './access.js'
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
  lock: { run<T>(fn: () => Promise<T>): Promise<T> }
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

export function effectiveNext(owner: RegistryOwner): number {
  if (owner.send !== null) return ownApplicationGeneration(owner.send.copy.state)
  const state = decodeClientState(owner.latestCommitted.state)
  return Math.max(
    state === undefined ? 0 : ownApplicationGeneration(state),
    owner.latestCommitted.senderHWM,
  )
}

export function createLiveSlot(): LiveSlot {
  let tail = Promise.resolve()
  return {
    inflight: new Set(),
    base: null,
    receive: null,
    receiveDigest: null,
    consumed: { incarnation: null, epochs: new Map(), closed: new Set() },
    cancellation: new AbortController(),
    refresh: null,
    lock: {
      async run<T>(fn: () => Promise<T>): Promise<T> {
        const previous = tail
        let release!: () => void
        tail = new Promise<void>((resolve) => {
          release = resolve
        })
        await previous
        try {
          return await fn()
        } finally {
          release()
        }
      },
    },
  }
}

export function createLiveSend<TTx extends GroupTransaction>(params: {
  owner: RegistryOwner
  slot: LiveSlot
  capability: EntryCapability<TTx>
  environment: ColdEnvironment
  resolve(mutationID: string): Promise<'committed' | 'rolled-back'>
  assertAvailable(): void
  assertCurrent(): void
  assertWorkSafety(stores: GroupStores<TTx>): Promise<void>
  safetyHeld(): SafetyHold
  diagnoseFailure(error: unknown): Promise<void>
  publish(): void
  dropOwner(): void
  waitForMaintenanceGate(signal: AbortSignal): Promise<void> | undefined
}) {
  const { owner, slot, capability, environment } = params
  const proofs = new WeakMap<ReadableGroupState, OwnProof>()
  let generation = 0
  let foreignGeneration = 0
  let closed = false
  let paused = false
  const initial = decodeClientState(owner.latestCommitted.state)
  let deferred =
    initial !== undefined &&
    (initial.groupActiveState.kind !== 'active' ||
      Object.keys(initial.unappliedProposals).length !== 0)
  let cancellation = new AbortController()
  const closing = new AbortController()
  let maintenance: Promise<void> | null = null
  let maintenanceAbort: AbortController | null = null
  let block: { started(): void; release: Promise<void> } | null = null
  const rotationListeners = new Set<(identity: EpochIdentity) => void>()
  const resolutions = new Set<Promise<void>>()
  const checks = new Set<Promise<void>>()
  const accountingStarts = new Set<() => void>()
  const unresolved = new Set<OwnProof>()
  let observedVersion = owner.knownVersion

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
    if (!owner.admission.admissible) throw new SendNotAdmissibleError(owner.admission.reason)
  }
  function invalidate(): void {
    generation++
    owner.send = null
  }
  function committedGeneration(): number {
    const state = decodeClientState(owner.latestCommitted.state)
    return Math.max(
      owner.latestCommitted.senderHWM,
      state === undefined ? 0 : ownApplicationGeneration(state),
    )
  }
  function needsMaintenance(): boolean {
    return (
      available() &&
      unresolved.size === 0 &&
      !deferred &&
      owner.admission.admissible &&
      params.safetyHeld() === null &&
      committedGeneration() < LEASE_MAX_GENERATION &&
      effectiveNext(owner) < LEASE_MAX_GENERATION &&
      (owner.send === null || owner.send.limit - effectiveNext(owner) < LEASE_RENEW_BELOW)
    )
  }
  function notifyRotation(): void {
    if (effectiveNext(owner) < LEASE_MAX_GENERATION) return
    for (const listener of rotationListeners) {
      try {
        listener({ ...owner.snapshot, authenticator: owner.snapshot.authenticator.slice() })
      } catch {
        /* Advisory listener. */
      }
    }
  }
  function account(proof: OwnProof): void {
    proof.proven = proof.registered
    if (!available() || !proof.proven || proof.record.version < owner.knownVersion) return
    owner.knownVersion = proof.record.version
    owner.latestCommitted = copyRecord(proof.record)
    owner.latestEligibility = proof.eligibility.slice()
    setReceiveBase(slot, proof.record)
    if (
      owner.send !== null &&
      (!sameStoredValue(owner.send.identity, identityOf(proof.record)) ||
        !sameStoredValue(owner.send.eligibility, proof.eligibility))
    )
      invalidate()
    const state = decodeClientState(proof.record.state)
    deferred =
      state !== undefined &&
      (state.groupActiveState.kind !== 'active' ||
        Object.keys(state.unappliedProposals).length !== 0)
  }
  function identityOf(record: ReadableGroupState): EpochIdentity {
    return {
      groupID: record.groupID,
      incarnation: record.incarnation,
      epoch: record.epoch,
      authenticator: record.epochAuthenticator,
    }
  }
  async function accept(proof: OwnProof): Promise<void> {
    try {
      await acceptReservation(proof)
    } catch {
      invalidate()
      schedule()
    }
  }
  async function acceptReservation(proof: OwnProof): Promise<void> {
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
      sameStoredValue(identityOf(owner.latestCommitted), reservation.identity) &&
      sameStoredValue(owner.latestEligibility, reservation.eligibility)
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
    params.assertCurrent()
    const current = owner.send
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
    const capturedGeneration = generation
    const copy = restrictCommitAuthoring(await environment.restore(copyRecord(reservation.pre)))
    if (
      !valid() ||
      generation !== capturedGeneration ||
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
    owner.send = record
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
  ): void {
    if (record !== undefined && record.version >= owner.knownVersion) {
      owner.latestCommitted = copyRecord(record)
      if (control !== undefined) owner.latestControl = copyStoredValue(control)
      if (eligibility !== undefined) owner.latestEligibility = eligibility.slice()
      const state = decodeClientState(record.state)
      deferred =
        state !== undefined &&
        (state.groupActiveState.kind !== 'active' ||
          Object.keys(state.unappliedProposals).length !== 0)
    }
    foreignGeneration++
    invalidate()
    slot.base = null
    slot.refresh?.()
    owner.knownVersion = Math.max(owner.knownVersion, version)
    notifyRotation()
    schedule()
  }
  function observed(version: number, stillCurrent: () => boolean): () => void {
    observedVersion = Math.max(observedVersion, version)
    const capturedGeneration = generation
    const signal = cancellation.signal
    if (signal.aborted) return () => {}
    const current = () =>
      !signal.aborted &&
      available() &&
      stillCurrent() &&
      version >= observedVersion &&
      version >= owner.knownVersion
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    let started = false
    const check = () => {
      if (started || signal.aborted) return
      started = true
      void capability
        .read(owner.key.groupID, async (reads) => {
          if (!current()) return
          const known = copyRecord(owner.latestCommitted)
          const control = copyStoredValue(owner.latestControl)
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
            foreign(version)
            return
          }
          const readable = { ...record, state: record.state }
          const expected = owner.expected.get(version)
          if (expected === undefined && version <= owner.knownVersion) return
          const proof = expected === undefined ? undefined : proofs.get(expected)
          if (proof !== undefined && sameStoredValue(record.state, proof.record.state)) {
            owner.latestControl = copyStoredValue(nextControl)
            account(proof)
            return
          }
          if (!sameStoredValue(record.state, known.state)) {
            foreign(version, readable, nextControl)
            return
          }
          let eligibility = owner.latestEligibility
          try {
            if (
              !sameStoredValue(nextControl, control) ||
              !sameStoredValue(record.ledger, known.ledger) ||
              !sameStoredValue(record.credential, known.credential) ||
              record.terminal !== known.terminal
            ) {
              const handle = restrictCommitAuthoring(
                await environment.restore(copyRecord(readable)),
              )
              eligibility = eligibilityOf(handle.state, handle.ownLeafLapsed())
            }
            if (!current()) return
            if (
              generation !== capturedGeneration ||
              !sameStoredValue(eligibility, owner.send?.eligibility ?? owner.latestEligibility)
            ) {
              foreign(version, readable, nextControl, eligibility)
              return
            }
            owner.knownVersion = Math.max(owner.knownVersion, version)
            owner.latestCommitted = copyRecord(readable)
            owner.latestControl = copyStoredValue(nextControl)
            owner.latestEligibility = eligibility.slice()
          } catch {
            if (current()) foreign(version, readable, nextControl)
          }
        })
        .then(finish, () => {
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
    if (outcome === 'committed') account(proof)
    if (owner.expected.get(proof.record.version) === proof.record)
      owner.expected.delete(proof.record.version)
    if (outcome === 'committed') await accept(proof)
    notifyRotation()
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
    prepare: (reads: EntryReads) => Promise<Prepared<P>>,
    work: (stores: GroupStores<TTx>, prepared: P) => Promise<T>,
  ): Promise<T> {
    let proof: OwnProof | undefined
    let mutationID = request.mutationID
    try {
      const result = await capability.run(
        request,
        async (reads) => {
          const prepared = await prepare(reads)
          mutationID = prepared.mutationID ?? mutationID
          proof = register(prepared.value)
          return prepared
        },
        work,
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
          await run(
            { groupID: owner.key.groupID, mutationID: crypto.randomUUID() },
            async (reads) => {
              params.assertAvailable()
              if (!needsMaintenance() || abort.signal.aborted) throw new NoReservation()
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
                environment,
                { ...record, state: record.state },
                record.senderHWM,
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
              if (abort.signal.aborted) throw new NoReservation()
              await params.assertWorkSafety(stores)
              const target = stores.incarnation(owner.key.incarnation)
              const current = await target.state.load()
              if (current?.version !== prepared.record.version - 1)
                throw new GroupStateConflictError('Lease source moved')
              await target.state.save(prepared.record)
            },
          )
          if (owner.send === null && needsMaintenance()) {
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
        job,
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
      await accounting()
      for (let attempt = 0; ; attempt++) {
        if (signal.aborted) throw signal.reason
        assertSeal()
        const record = owner.send
        let exhausted =
          record !== null && ownApplicationGeneration(record.copy.state) >= record.limit
        if (record !== null && !exhausted) {
          try {
            const sealed = await record.copy.encryptApplication(bytes, { aad })
            return { ...sealed, epoch: record.identity.epoch }
          } catch (error) {
            if (
              !(error instanceof ApplicationSendRefusedError) ||
              isApplicationSendDenied(record.copy) ||
              ownApplicationGeneration(record.copy.state) < record.limit
            )
              throw error
            exhausted = true
          } finally {
            schedule()
            notifyRotation()
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
    if (permanent) closing.abort(reason)
    maintenanceAbort?.abort(reason)
    cancellation.abort(reason)
    invalidate()
  }
  return {
    seal,
    run,
    observed,
    accounting,
    invalidate,
    schedule,
    effectiveNext: () => effectiveNext(owner),
    snapshot() {
      const send = owner.send
      return send === null
        ? null
        : {
            copy: send.copy,
            identity: { ...send.identity, authenticator: send.identity.authenticator.slice() },
            limit: send.limit,
            own: ownApplicationGeneration(send.copy.state),
            storedGeneration: committedGeneration(),
            knownVersion: owner.knownVersion,
            expectedVersions: [...owner.expected.keys()],
          }
    },
    foreign,
    refreshed(record: ReadableGroupState, eligibility: Uint8Array) {
      setReceiveBase(slot, record)
      owner.knownVersion = Math.max(owner.knownVersion, record.version)
      owner.latestCommitted = copyRecord(record)
      owner.latestEligibility = eligibility.slice()
      const state = decodeClientState(record.state)
      deferred =
        state !== undefined &&
        (state.groupActiveState.kind !== 'active' ||
          Object.keys(state.unappliedProposals).length !== 0)
      if (
        owner.send !== null &&
        (!sameStoredValue(owner.send.identity, identityOf(record)) ||
          !sameStoredValue(owner.send.eligibility, eligibility))
      )
        invalidate()
    },
    async handoff(reservation: Reservation) {
      const record = reservation.envelope?.saved
      if (record === undefined) return
      const loaded = owner.latestCommitted
      if (
        !sameStoredValue(identityOf(loaded), reservation.identity) ||
        loaded.version < reservation.envelope.version ||
        !sameStoredValue(loaded.state, record.state)
      )
        return
      const state = decodeClientState(loaded.state)
      if (state === undefined || reservation.limit > ownApplicationGeneration(state)) return
      await accept({
        record,
        reservation,
        eligibility: reservation.eligibility,
        generation: foreignGeneration,
        registered: true,
        proven: true,
      })
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
      rotationListeners.add(listener)
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
