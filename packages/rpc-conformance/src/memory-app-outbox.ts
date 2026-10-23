import type { ConformanceAppOutbox, ConformanceAppOutboxEntry } from './app-outbox.js'
import type {
  ConformanceAppSettlementObligation,
  ConformanceAppStatusEvent,
  ConformanceEpochIdentity,
  ConformanceGroupKey,
} from './persistence-fixture.js'

export type MemoryAppOutbox = ConformanceAppOutbox & { failNextPut(): void }

export function createMemoryAppOutbox(params: {
  key: ConformanceGroupKey
  snapshot(): { identity: ConformanceEpochIdentity; stateVersion: number } | null
}): MemoryAppOutbox {
  let refusePut = false
  let tail = Promise.resolve()
  const rows = new Map<number, ConformanceAppOutboxEntry>()
  const obligations = new Map<number, ConformanceAppSettlementObligation>()
  const events = new Map<string, ConformanceAppStatusEvent>()
  const copy = <T>(value: T): T => structuredClone(value)
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
  const serial = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const result = tail.then(fn)
    tail = result.then(
      () => {},
      () => {},
    )
    return result
  }
  const event = (value: ConformanceAppStatusEvent) => events.set(value.id, copy(value))
  const remove = (seq: number, occurrence?: Parameters<ConformanceAppOutbox['remove']>[1]) => {
    const entry = rows.get(seq)
    if (entry === undefined) return
    const obligation = obligations.get(seq)
    const attempt = entry.lastAttempt
    if (occurrence !== undefined) {
      if (
        attempt === null ||
        occurrence.incarnation !== attempt.incarnation ||
        occurrence.topicID !== attempt.topicID ||
        occurrence.segment !== attempt.segment ||
        (obligation !== undefined &&
          (occurrence.position !== obligation.sequenceID ||
            attempt.publishID !== obligation.attemptID))
      )
        throw new Error('Publication occurrence mismatch')
      event({ ...params.key, id: crypto.randomUUID(), entry, kind: 'published', occurrence })
    } else {
      if (obligation !== undefined)
        throw new Error('Certified entry requires its original occurrence')
      event({ ...params.key, id: crypto.randomUUID(), entry, kind: 'failed', reason: 'removed' })
    }
    rows.delete(seq)
    obligations.delete(seq)
  }
  return {
    put(entry) {
      const owned = copy(entry)
      return serial(() => {
        if (refusePut) {
          refusePut = false
          throw new Error('Outbox write refused')
        }
        if (
          !Number.isSafeInteger(owned.seq) ||
          owned.seq < 0 ||
          (owned.lastAttempt !== null && owned.lastAttempt.incarnation !== params.key.incarnation)
        )
          throw new Error('Invalid outbox sequence or incarnation')
        const previous = rows.get(owned.seq)
        if (previous !== undefined) {
          if (
            !same(
              [previous.protocol, previous.prc, previous.data],
              [owned.protocol, owned.prc, owned.data],
            )
          )
            throw new Error('App plaintext is immutable')
          if (obligations.has(owned.seq) && !same(previous, owned))
            throw new Error('Obligated app entry is immutable')
        } else {
          if (owned.status !== 'accepted') throw new Error('New app entry must be accepted')
          event({ ...params.key, id: crypto.randomUUID(), kind: 'accepted', entry: owned })
        }
        rows.set(owned.seq, owned)
      })
    },
    list: () => serial(() => [...rows.values()].sort((a, b) => a.seq - b.seq).map(copy)),
    recordSettlement(seq, obligation, expected) {
      const owned = copy({ obligation, expected })
      return serial(() => {
        const snapshot = params.snapshot()
        if (
          snapshot === null ||
          !same(snapshot.identity, owned.expected.identity) ||
          !same(params.key, {
            groupID: snapshot.identity.groupID,
            incarnation: snapshot.identity.incarnation,
          })
        )
          return { recorded: false as const, reason: 'identity-changed' as const }
        if (snapshot.stateVersion !== owned.expected.stateVersion)
          return { recorded: false as const, reason: 'state-version-changed' as const }
        const entry = rows.get(seq)
        if (entry === undefined)
          return { recorded: false as const, reason: 'entry-missing' as const }
        const attempt = entry.lastAttempt
        if (
          attempt === null ||
          attempt.publishID !== owned.expected.attemptID ||
          owned.obligation.attemptID !== attempt.publishID ||
          owned.obligation.topicID !== attempt.topicID ||
          attempt.incarnation !== snapshot.identity.incarnation ||
          attempt.epoch !== snapshot.identity.epoch
        )
          return { recorded: false as const, reason: 'attempt-changed' as const }
        const previous = obligations.get(seq)
        if (previous !== undefined && !same(previous, owned.obligation))
          throw new Error('Settlement is immutable')
        obligations.set(seq, owned.obligation)
        return { recorded: true as const }
      })
    },
    loadSettlement: (seq) => serial(() => copy(obligations.get(seq) ?? null)),
    remove: (seq, outcome) => {
      const owned = copy(outcome)
      return serial(() => remove(seq, owned))
    },
    clear: () =>
      serial(() => {
        if (obligations.size !== 0)
          throw new Error('Certified entry requires its original occurrence')
        for (const seq of rows.keys()) remove(seq)
      }),
    events: () => serial(() => [...events.values()].map(copy)),
    ackEvent: (id) =>
      serial(() => {
        events.delete(id)
      }),
    failNextPut: () => {
      refusePut = true
    },
  }
}
