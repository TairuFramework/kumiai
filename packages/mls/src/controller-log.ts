import {
  type ControllerLog,
  deviceRevokeIndices,
  digestOf,
  type FoldResult,
  foldLog,
  pruneLog,
  type SignedEvent,
} from '@kokuin/controller'
import { type CryptoOptions, normalizeDID } from '@kokuin/token'

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

export async function foldChain(
  did: string,
  chain: ReadonlyArray<SignedEvent>,
  options?: CryptoOptions,
): Promise<FoldResult> {
  return foldControllerLog(did, asControllerLog(chain), options)
}

export async function foldControllerLog(
  did: string,
  log: ControllerLog,
  options?: CryptoOptions,
): Promise<FoldResult> {
  // Kokuin 0.2 skips unsigned crit:false events, but a chain rev must never fold.
  if (hasChainRevoke(log.chain)) {
    const index = log.chain.findIndex((signed) => hasChainRevoke([signed]))
    return { ok: false, reason: CHAIN_REVOKE_REFUSED, index }
  }
  return foldLog({ ...options, did: did, input: log })
}

export async function revokeIndices(
  did: string,
  chain: ReadonlyArray<SignedEvent>,
  subject: string,
  options?: CryptoOptions,
): Promise<Array<number>> {
  return deviceRevokeIndices({ ...options, did: did, chain: [...chain], subject: subject })
}

export type MemberDropIndicesParams = {
  did: string
  chain: ReadonlyArray<SignedEvent>
  add: string
} & CryptoOptions

export async function memberDropIndices({
  did,
  chain,
  add,
  ...options
}: MemberDropIndicesParams): Promise<Array<number>> {
  const folded = await foldChain(did, chain, options)
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

/** Same-generation `rot` indices whose snapshot newly carries `add` as `member`'s removed incarnation. */
export async function memberTombstoneIndices(
  did: string,
  chain: ReadonlyArray<SignedEvent>,
  add: string,
  member: string,
  options?: CryptoOptions,
): Promise<Array<number>> {
  const folded = await foldChain(did, chain, options)
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
      prior.tombstones?.has(add) !== true &&
      normalizeDID(state.tombstones?.get(add)?.did ?? '') === normalizeDID(member)
    )
      indices.push(index)
  }
  return indices
}

export async function closureOf(
  did: string,
  log: ControllerLog,
  targets: ReadonlyArray<string>,
  options?: CryptoOptions,
): Promise<ControllerLog | undefined> {
  const folded = await foldControllerLog(did, log, options)
  if (!folded.ok || folded.head.saturated) return undefined
  const applied = new Set(folded.applied)
  if (targets.some((digest) => !applied.has(digest))) return undefined

  const needed = new Set(targets)
  const events: ControllerLog['events'] = []
  // Applied copies are topologically ordered and closed under ancestry in an unsaturated epoch.
  const pruned = await pruneLog({ ...options, did: did, input: log })
  for (const signed of pruned.events.toReversed()) {
    if (!needed.has(digestOf(signed.event))) continue
    events.push(signed)
    for (const parent of signed.event.p) needed.add(parent)
  }
  return structuredClone({ chain: log.chain, events: events.reverse() })
}

export function isDetachedFoldReason(reason: string): boolean {
  return /sequence|digest/.test(reason)
}
