import type { KeyState } from '@kokuin/controller'
import {
  type ControllerLog,
  deviceRevokeIndices,
  digestOf,
  type FoldResult,
  foldLog,
  isEpochEventShape,
  type SignedEvent,
  verifyEpochSignature,
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
  if (!folded.ok) return undefined
  const applied = new Set(folded.applied)
  if (targets.some((digest) => !applied.has(digest))) return undefined

  const authentic = new Map<string, ControllerLog['events'][number]>()
  for (const signed of log.events) {
    if (!isEpochEventShape(signed)) continue
    const digest = digestOf(signed.event)
    if (!applied.has(digest) || authentic.has(digest)) continue
    const by = signed.event.by
    const member = by == null ? undefined : folded.head.members.get(by)
    if (by != null && member == null) continue
    // Applied authorisation fixes the signer; removal never changes its pin.
    const signer = member == null ? { rootKeys: folded.head.keys } : { memberKey: member.key }
    if (verifyEpochSignature(signed, signer)) authentic.set(digest, signed)
  }

  const needed = new Set<string>()
  const pending = [...targets]
  while (pending.length > 0) {
    const digest = pending.pop()
    if (digest == null || digest === folded.head.epoch || needed.has(digest)) continue
    const signed = authentic.get(digest)
    if (signed == null) return undefined
    needed.add(digest)
    pending.push(...signed.event.p)
  }

  const events: ControllerLog['events'] = []
  for (const digest of folded.applied) {
    const signed = authentic.get(digest)
    if (needed.has(digest) && signed != null) events.push(signed)
  }
  return { chain: [...log.chain], events }
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
