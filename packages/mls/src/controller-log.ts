import {
  type ControllerLog,
  deviceRevokeIndices,
  digestOf,
  type FoldResult,
  foldLog,
  pruneLog,
  type SignedEvent,
} from '@kokuin/controller'

export const CHAIN_REVOKE_REFUSED = 'chain revoke refused'

export function asControllerLog(chain: ReadonlyArray<SignedEvent>): ControllerLog {
  return { chain: [...chain], events: [] }
}

export function hasChainRevoke(chain: ReadonlyArray<unknown>): boolean {
  return chain.some((signed) => {
    if (signed == null || typeof signed !== 'object' || !('event' in signed)) return false
    const event = signed.event
    return event != null && typeof event === 'object' && 't' in event && event.t === 'rev'
  })
}

export function foldChain(did: string, chain: ReadonlyArray<SignedEvent>): FoldResult {
  return foldControllerLog(did, asControllerLog(chain))
}

export function foldControllerLog(did: string, log: ControllerLog): FoldResult {
  // Kokuin 0.2 skips unsigned crit:false events, but a chain rev must never fold.
  if (hasChainRevoke(log.chain)) {
    const index = log.chain.findIndex((signed) => hasChainRevoke([signed]))
    return { ok: false, reason: CHAIN_REVOKE_REFUSED, index }
  }
  return foldLog(did, log)
}

export function revokeIndices(
  did: string,
  chain: ReadonlyArray<SignedEvent>,
  subject: string,
): Array<number> {
  return deviceRevokeIndices(did, [...chain], subject)
}

export function memberDropIndices(
  did: string,
  chain: ReadonlyArray<SignedEvent>,
  add: string,
): Array<number> {
  const folded = foldChain(did, chain)
  if (!folded.ok) return []
  const indices: Array<number> = []
  for (let index = 1; index < chain.length; index++) {
    const state = folded.states[index]
    const prior = folded.states[index - 1]
    if (
      chain[index]?.event.t === 'rot' &&
      state != null &&
      prior != null &&
      state.gen === prior.gen &&
      prior.members.has(add) &&
      !prior.members.get(add)?.removed &&
      !state.members.has(add)
    )
      indices.push(index)
  }
  return indices
}

/** Same-generation `rot` indices whose snapshot newly carries `add` as a removed incarnation. */
export function memberTombstoneIndices(
  did: string,
  chain: ReadonlyArray<SignedEvent>,
  add: string,
): Array<number> {
  const folded = foldChain(did, chain)
  if (!folded.ok) return []
  const indices: Array<number> = []
  for (let index = 1; index < chain.length; index++) {
    const state = folded.states[index]
    const prior = folded.states[index - 1]
    if (
      chain[index]?.event.t === 'rot' &&
      state != null &&
      prior != null &&
      state.gen === prior.gen &&
      state.tombstones?.has(add) === true &&
      prior.tombstones?.has(add) !== true
    )
      indices.push(index)
  }
  return indices
}

export function closureOf(
  did: string,
  log: ControllerLog,
  targets: ReadonlyArray<string>,
): ControllerLog | undefined {
  const folded = foldControllerLog(did, log)
  if (!folded.ok || folded.head.saturated) return undefined
  const applied = new Set(folded.applied)
  if (targets.some((digest) => !applied.has(digest))) return undefined

  const needed = new Set(targets)
  const events: ControllerLog['events'] = []
  // Applied copies are topologically ordered and closed under ancestry in an unsaturated epoch.
  for (const signed of pruneLog(did, log).events.toReversed()) {
    if (!needed.has(digestOf(signed.event))) continue
    events.push(signed)
    for (const parent of signed.event.p) needed.add(parent)
  }
  return structuredClone({ chain: log.chain, events: events.reverse() })
}

export function isDetachedFoldReason(reason: string): boolean {
  return /sequence|digest/.test(reason)
}
