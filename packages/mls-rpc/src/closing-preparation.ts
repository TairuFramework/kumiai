import { type CheckpointFactRecord, PeerRemovedError } from '@kumiai/rpc'
import { sha256 } from '@noble/hashes/sha2.js'

import { checkpointPreparation } from './checkpoint-capture.js'
import type {
  ClosingDomain,
  ClosingMutation,
  ClosingPreparation,
  ClosingReason,
  EntryReads,
  Prepared,
  StateMetadata,
} from './entry-capability.js'
import { copyStoredValue, sameStoredValue } from './memory-incarnation-stores.js'
import type { OwnerAttempt, OwnerEntry } from './owner-queue.js'
import { encodeStoredValue, physicalRecordKey } from './persistence-codec.js'
import {
  DisplacedGroupHandleError,
  GroupStateConflictError,
  PersistencePhaseError,
  RegistrySourceMovedError,
} from './persistence-errors.js'
import type {
  EpochIdentity,
  GroupKey,
  GroupLifetime,
  GroupStateRecord,
  MemoryTransaction,
} from './persistence-types.js'

type Frozen = {
  entry: OwnerEntry
  attempt: OwnerAttempt
  prepared: Prepared<unknown>
  expected: Prepared<unknown>['expected']
  guards: unknown
  value: unknown
  domain: ClosingDomain
  source: GroupKey
  metadata: StateMetadata
  identity: EpochIdentity | null
  lifetime: GroupLifetime
  reason: ClosingReason
  mutationID: string
  consumed: boolean
  captures: Map<string, Uint8Array>
  written: Set<number>
  lifetimeWritten: boolean
  sealed: Map<string, Uint8Array>
}
const tokens = new WeakMap<ClosingMutation, Frozen>()
const active = new WeakMap<OwnerAttempt, Frozen>()
type ClosingExpectation = Pick<
  Frozen,
  'source' | 'metadata' | 'identity' | 'lifetime' | 'expected' | 'guards' | 'reason'
> & {
  domainDigest: Uint8Array
  valueDigest: Uint8Array
}
// Retain only guards and a digest across attempts, never the retired private state bytes.
const originalExpectations = new WeakMap<object, Map<string, ClosingExpectation>>()
function persistenceDigest(value: unknown): Uint8Array {
  function sorted(value: unknown): unknown {
    if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return value
    if (Array.isArray(value)) return value.map(sorted)
    if (value instanceof Map)
      return new Map([...value].map(([key, item]) => [sorted(key), sorted(item)]))
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sorted(record[key])]),
    )
  }
  return sha256(encodeStoredValue(sorted(value)))
}
const listeners = new WeakMap<object, Set<(key: GroupKey, reason: Error) => void>>()

export function observeSourceClosure(
  coordinator: object,
  listener: (key: GroupKey, reason: Error) => void,
): () => void {
  let set = listeners.get(coordinator)
  if (set === undefined) {
    set = new Set()
    listeners.set(coordinator, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
  }
}
function conflict(message: string): never {
  throw new GroupStateConflictError(message)
}

// This object is issued only inside the registered entry's prepare callback.
export function createClosingPreparation(params: {
  entry: OwnerEntry
  reads: EntryReads
  request: { groupID: string; mutationID: string | null }
  coordinator: object
}): { closing: ClosingPreparation; consume<P>(prepared: Prepared<P>): P } {
  const { entry, reads, request, coordinator } = params
  const attempt = entry.attempt()
  let issued: Frozen | undefined
  const assertPrepare = () => {
    attempt.assertLive()
    if (entry.attempt() !== attempt || entry.phase !== 'prepare')
      throw new PersistencePhaseError('Closing preparation expired')
  }
  function mutationID(prepared: Prepared<unknown>): string {
    const id = request.mutationID ?? prepared.mutationID
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      (prepared.mutationID !== undefined && prepared.mutationID !== id)
    )
      return conflict('Closing mutation ID missing or conflicting')
    return id
  }
  return {
    closing: {
      async freeze(input) {
        assertPrepare()
        if (issued !== undefined || input.prepared.closing !== undefined)
          return conflict('Closing preparation already declared')
        const id = mutationID(input.prepared)
        const source = copyStoredValue(input.source)
        const expected = copyStoredValue(input.prepared.expected)
        const guards = copyStoredValue({ ...input.prepared, value: undefined, closing: undefined })
        const captures = new Map<string, Uint8Array>()
        function collect(value: unknown): void {
          if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return
          const fact = value as CheckpointFactRecord
          if (fact.kind === 'fact') {
            const canonical = checkpointPreparation(fact)
            if (canonical !== undefined && sameStoredValue(canonical, fact.canonical))
              captures.set(fact.id, canonical)
          }
          for (const item of value instanceof Map ? value.values() : Object.values(value))
            collect(item)
        }
        const value = copyStoredValue(input.prepared.value)
        collect(input.prepared.value)
        const domain = copyStoredValue(input.domain)
        const reason = input.reason
        const lifetime = await reads.lifetime()
        const metadata = await reads.metadata(source.incarnation)
        assertPrepare()
        if (
          source.groupID !== request.groupID ||
          lifetime === null ||
          metadata === null ||
          (lifetime.activeIncarnation ?? lifetime.latestIncarnation) !== source.incarnation ||
          expected === null ||
          expected.revision !== lifetime.revision ||
          expected.activeIncarnation !== lifetime.activeIncarnation
        )
          return conflict('Closing source lifetime moved')
        if (!['terminal', 'switch', 'readmission', 'delete', 'successor'].includes(reason))
          return conflict('Unknown closing reason')
        const incarnations = new Set<number>()
        for (const state of domain.states) {
          const previous = await reads.metadata(state.incarnation)
          if (
            state.groupID !== source.groupID ||
            incarnations.has(state.incarnation) ||
            state.version !== (previous?.version ?? 0) + 1
          )
            return conflict('Closing state identity or version moved')
          incarnations.add(state.incarnation)
        }
        const next = domain.lifetime
        if (
          next !== null &&
          (next.groupID !== source.groupID ||
            next.revision !== lifetime.revision + 1 ||
            next.mutationID !== id)
        )
          return conflict('Closing lifetime guard mismatch')
        if (reason === 'terminal') {
          if (
            !domain.states.some(
              (state) =>
                state.incarnation === source.incarnation &&
                !state.deleted &&
                state.terminal &&
                !metadata.terminal,
            )
          )
            return conflict('Closing terminal declaration has no removal')
        } else if (next === null || next.activeIncarnation === lifetime.activeIncarnation) {
          return conflict('Closing declaration has no displacement')
        }
        if (
          lifetime.activeIncarnation !== null &&
          next !== null &&
          next.activeIncarnation !== lifetime.activeIncarnation &&
          !metadata.deleted &&
          !domain.states.some((state) => state.incarnation === source.incarnation && state.deleted)
        )
          return conflict('Closing displacement requires its frozen tombstone')
        // Administrative retirement must also work without readable private recovery material.
        const identity =
          reason === 'delete' || reason === 'successor'
            ? null
            : ((await reads.trust())?.installed ?? null)
        if (
          reason !== 'delete' &&
          reason !== 'successor' &&
          (identity === null ||
            identity.groupID !== source.groupID ||
            identity.incarnation !== source.incarnation)
        )
          return conflict('Closing source trust identity unavailable')
        const expectation: ClosingExpectation = copyStoredValue({
          source,
          metadata,
          identity,
          lifetime,
          expected,
          guards,
          reason,
          domainDigest: persistenceDigest(domain),
          valueDigest: persistenceDigest(value),
        })
        let originals = originalExpectations.get(coordinator)
        if (originals === undefined) {
          originals = new Map()
          originalExpectations.set(coordinator, originals)
        }
        const originalKey = JSON.stringify([request.groupID, id])
        const original = originals.get(originalKey)
        if (original !== undefined && !sameStoredValue(original, expectation))
          return conflict('Closing rollback retry source or domain moved')
        assertPrepare()
        originals.set(originalKey, expectation)
        const token: ClosingMutation = Object.freeze({ mutationID: id })
        const prepared = { ...input.prepared, value, closing: token }
        issued = {
          entry,
          attempt,
          prepared,
          expected,
          guards,
          value: copyStoredValue(value),
          domain,
          source,
          metadata: copyStoredValue(metadata),
          identity: copyStoredValue(identity),
          lifetime: copyStoredValue(lifetime),
          reason,
          mutationID: id,
          captures,
          written: new Set(),
          lifetimeWritten: false,
          sealed: new Map(),
          consumed: false,
        }
        tokens.set(token, issued)
        return prepared
      },
    },
    consume(prepared) {
      assertPrepare()
      const token = prepared.closing
      if (token === undefined) {
        if (issued !== undefined) return conflict('Closing declaration omitted')
        return prepared.value
      }
      const frozen = tokens.get(token)
      if (
        frozen === undefined ||
        frozen !== issued ||
        frozen.entry !== entry ||
        frozen.attempt !== attempt ||
        frozen.consumed ||
        frozen.prepared !== prepared ||
        mutationID(prepared) !== frozen.mutationID ||
        !sameStoredValue(prepared.expected, frozen.expected) ||
        !sameStoredValue({ ...prepared, value: undefined, closing: undefined }, frozen.guards) ||
        !sameStoredValue(prepared.value, frozen.value)
      )
        return conflict('Closing token is not bound to this preparation')
      frozen.consumed = true
      active.set(attempt, frozen)
      const reason =
        frozen.reason === 'terminal'
          ? new PeerRemovedError()
          : new DisplacedGroupHandleError('Source closing mutation submitted')
      for (const listener of listeners.get(coordinator) ?? []) listener(frozen.source, reason)
      return copyStoredValue(frozen.value) as typeof prepared.value
    },
  }
}

export function assertClosingState(
  entry: OwnerEntry | undefined,
  previous: StateMetadata | null,
  state: GroupStateRecord,
): void {
  const frozen = entry === undefined ? undefined : active.get(entry.attempt())
  if (frozen !== undefined) {
    if (!frozen.domain.states.some((allowed) => sameStoredValue(allowed, state)))
      conflict('State write differs from frozen closing domain')
    frozen.written.add(state.incarnation)
  } else if (state.deleted || (state.terminal && previous?.terminal !== true)) {
    conflict('Closing state write requires private preparation')
  }
}
export function assertClosingLifetime(
  entry: OwnerEntry | undefined,
  previous: GroupLifetime | null,
  lifetime: GroupLifetime,
): void {
  const frozen = entry === undefined ? undefined : active.get(entry.attempt())
  if (frozen !== undefined) {
    if (frozen.domain.lifetime === null) {
      if (
        !['finalise', 'account'].includes(entry?.phase ?? '') ||
        !sameStoredValue(lifetime, {
          ...frozen.lifetime,
          revision: frozen.lifetime.revision + 1,
          mutationID: frozen.mutationID,
        })
      )
        conflict('Undeclared closing lifetime write')
    } else {
      if (!sameStoredValue(frozen.domain.lifetime, lifetime))
        conflict('Lifetime write differs from frozen closing domain')
      frozen.lifetimeWritten = true
    }
  } else if (previous !== null && previous.activeIncarnation !== lifetime.activeIncarnation) {
    conflict('Closing lifetime write requires private preparation')
  }
}

export async function retirementDomain(
  reads: EntryReads,
  lifetime: GroupLifetime,
  states: Array<GroupStateRecord> = [],
): Promise<ClosingDomain> {
  const previous = await reads.lifetime()
  const domain = { states: [...states], lifetime }
  if (
    previous?.activeIncarnation != null &&
    previous.activeIncarnation !== lifetime.activeIncarnation
  ) {
    const metadata = await reads.metadata(previous.activeIncarnation)
    if (metadata === null) return conflict('Missing retirement metadata')
    if (!metadata.deleted && !states.some((state) => state.incarnation === metadata.incarnation))
      domain.states.push({
        groupID: lifetime.groupID,
        incarnation: metadata.incarnation,
        version: metadata.version + 1,
        deleted: true,
      })
  }
  return domain
}

export function closingCheckpointPreparation(
  entry: OwnerEntry | undefined,
  record: CheckpointFactRecord,
): Uint8Array | undefined {
  const captured =
    entry === undefined ? undefined : active.get(entry.attempt())?.captures.get(record.id)
  return captured !== undefined && sameStoredValue(captured, record.canonical)
    ? captured.slice()
    : undefined
}

export async function revalidateClosingSource(
  entry: OwnerEntry,
  reads: Pick<EntryReads, 'lifetime' | 'metadata' | 'trust'>,
): Promise<void> {
  const frozen = active.get(entry.attempt())
  if (frozen === undefined) return
  if (
    !sameStoredValue(await reads.lifetime(), frozen.lifetime) ||
    !sameStoredValue(await reads.metadata(frozen.source.incarnation), frozen.metadata) ||
    (frozen.identity !== null &&
      !sameStoredValue((await reads.trust())?.installed, frozen.identity))
  )
    throw new RegistrySourceMovedError('Frozen closing source moved before submission')
}
export function captureClosingWrite(
  entry: OwnerEntry | undefined,
  namespace: 'state' | 'meta' | 'lifetime',
  incarnation: number | null,
  bytes: Uint8Array,
): void {
  const frozen = entry === undefined ? undefined : active.get(entry.attempt())
  frozen?.sealed.set(JSON.stringify([namespace, incarnation]), bytes.slice())
}

export function assertClosingWrites(entry: OwnerEntry, tx: MemoryTransaction): void {
  const frozen = active.get(entry.attempt())
  if (frozen === undefined) return
  if (
    frozen.domain.states.some((state) => !frozen.written.has(state.incarnation)) ||
    (frozen.domain.lifetime !== null && !frozen.lifetimeWritten)
  )
    conflict('Frozen closing domain write omitted')
  const { source, sealed } = frozen
  function matches(namespace: string, incarnation: number | null): boolean {
    const expected = sealed.get(JSON.stringify([namespace, incarnation]))
    const address = {
      groupID: source.groupID,
      incarnation,
      namespace,
      recordID: namespace === 'meta' ? JSON.stringify(['state-version']) : 'current',
    }
    return (
      expected !== undefined &&
      sameStoredValue(tx.rows[namespace]?.get(physicalRecordKey(address)), expected)
    )
  }
  // Compare the exact writes that passed frozen-value checks without reopening retired state.
  for (const state of frozen.domain.states) {
    if (!matches('state', state.incarnation) || !matches('meta', state.incarnation))
      conflict('Persisted state differs from frozen closing domain')
  }
  if (frozen.domain.lifetime !== null && !matches('lifetime', null))
    conflict('Persisted lifetime differs from frozen closing domain')
}

export function assertClosingMetadata(
  entry: OwnerEntry | undefined,
  previous: StateMetadata | null,
  value: StateMetadata,
): void {
  if (previous?.terminal === value.terminal && previous?.deleted === value.deleted) return
  if (!value.terminal && !value.deleted) return
  const frozen = entry === undefined ? undefined : active.get(entry.attempt())
  const state = frozen?.domain.states.find((state) => state.incarnation === value.incarnation)
  if (
    state === undefined ||
    state.version !== value.version ||
    state.deleted !== value.deleted ||
    value.terminal !== (state.deleted ? previous?.terminal : state.terminal) ||
    (previous !== null && !sameStoredValue(previous.initialIdentity, value.initialIdentity))
  )
    conflict('Closing admission metadata requires frozen state')
}
