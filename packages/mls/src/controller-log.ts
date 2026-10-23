import type { KeyState } from '@kokuin/controller'
import {
  type ControllerLog,
  deviceRevokeIndices,
  digestOf,
  type FoldResult,
  foldLog,
  pruneLog,
  type SignedEvent,
} from '@kokuin/controller'
import { normalizeDID } from '@kokuin/token'

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

/** Requires a normalised subject DID. */
export function revokesSubject(
  chain: ReadonlyArray<SignedEvent>,
  states: ReadonlyArray<KeyState>,
  index: number,
  subject: string,
): boolean {
  const state = states[index]
  const prior = states[index - 1]
  if (index <= 0 || chain[index]?.event.t !== 'rot' || state == null || prior == null) return false
  const denies = (state: KeyState) => [...state.deny].some((did) => normalizeDID(did) === subject)
  return state.gen === prior.gen && denies(state) && !denies(prior)
}
