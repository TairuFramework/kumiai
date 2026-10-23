import type { KeyState } from '@kokuin/controller'
import {
  type ControllerLog,
  type FoldResult,
  foldLog,
  type SignedEvent,
  verifySignatures,
} from '@kokuin/controller'
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

export function isAuthenticLegacyRevoke(
  controller: string,
  chain: ReadonlyArray<unknown>,
): boolean {
  const index = chain.findIndex((signed) => hasLegacyRevoke([signed]))
  if (index < 1) return false
  const folded = foldChain(controller, chain.slice(0, index) as Array<SignedEvent>)
  if (!folded.ok) return false
  const prior = folded.states.at(-1)
  const rev = chain[index] as SignedEvent & { event: { x?: unknown; cap?: unknown } }
  return (
    prior != null &&
    rev.event.i === controller &&
    rev.event.p === prior.digest &&
    rev.event.g === prior.gen &&
    rev.event.s === prior.seq + 1 &&
    typeof rev.event.x === 'string' &&
    rev.event.cap === undefined &&
    verifySignatures(rev.event, rev.sigs, prior.keys)
  )
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
