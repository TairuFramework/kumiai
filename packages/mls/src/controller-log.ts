import type { KeyState } from '@kokuin/controller'
import { type ControllerLog, type FoldResult, foldLog, type SignedEvent } from '@kokuin/controller'
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
  // Kokuin 0.2 skips unsigned crit:false events, but a chain rev must never fold.
  if (hasChainRevoke(chain)) {
    const index = chain.findIndex((signed) => hasChainRevoke([signed]))
    return { ok: false, reason: CHAIN_REVOKE_REFUSED, index }
  }
  return foldLog(did, asControllerLog(chain))
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
