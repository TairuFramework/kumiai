import type { KeyState } from '@kokuin/controller'
import { type ControllerLog, type FoldResult, foldLog, type SignedEvent } from '@kokuin/controller'
import { normalizeDID } from '@kokuin/token'

export const LEGACY_CHAIN_REVOKE = 'legacy chain revoke'

export function asControllerLog(chain: ReadonlyArray<SignedEvent>): ControllerLog {
  return { chain: [...chain], events: [] }
}

export function hasLegacyRevoke(chain: ReadonlyArray<unknown>): boolean {
  return chain.some((signed) => {
    if (signed == null || typeof signed !== 'object' || !('event' in signed)) return false
    const event = signed.event
    return event != null && typeof event === 'object' && 't' in event && event.t === 'rev'
  })
}

export function foldChain(did: string, chain: ReadonlyArray<SignedEvent>): FoldResult {
  // Upstream skips unsigned non-critical events, including legacy revocations.
  if (hasLegacyRevoke(chain)) {
    const index = chain.findIndex((signed) => hasLegacyRevoke([signed]))
    return { ok: false, reason: LEGACY_CHAIN_REVOKE, index }
  }
  return foldLog(did, asControllerLog(chain))
}

export function isDetachedFoldReason(reason: string): boolean {
  return /sequence|digest/.test(reason)
}

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
