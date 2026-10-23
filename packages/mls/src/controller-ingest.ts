import {
  authoritativeLog,
  type ControllerLog,
  digestOf,
  type FoldResult,
  isControllerLog,
  isEpochEventShape,
  type KeyState,
  LOG_FORKED,
  LOG_NOT_AUTHORITATIVE,
  mergeLogs,
} from '@kokuin/controller'
import { normalizeDID } from '@kokuin/token'

import { foldControllerLog, isDetachedFoldReason } from './controller-log.js'
import { RevokeProofError } from './errors.js'

export type FoldOk = Extract<FoldResult, { ok: true }>

export function ingestControllerLog(
  controller: string,
  recorded: ControllerLog | undefined,
  proof: ControllerLog,
): { log: ControllerLog; before?: FoldOk; after: FoldOk; introduced: Array<string> } {
  const did = normalizeDID(controller)
  let before: FoldOk | undefined
  if (recorded != null) {
    const folded = foldControllerLog(did, recorded)
    if (!folded.ok) throw new RevokeProofError('not-authority-signed')
    before = folded
  }
  if (!isControllerLog(proof)) throw new RevokeProofError('not-authority-signed')
  const first = proof.chain[0]?.event
  let chain = proof.chain
  if (first == null) {
    if (recorded == null) throw new RevokeProofError('detached')
    chain = recorded.chain
  } else if (first.t !== 'icp') {
    if (recorded == null || first.p !== before?.states.at(-1)?.digest)
      throw new RevokeProofError('detached')
    if (proof.chain.some(({ event }) => event.g > (before?.head.gen ?? 0)))
      throw new RevokeProofError('needs-reset')
    chain = [...recorded.chain, ...proof.chain]
  }
  for (const { event } of chain) {
    if ((event.t !== 'icp' && event.t !== 'rot') || ('cap' in event && event.cap != null))
      throw new RevokeProofError('not-authority-signed')
  }
  const joined = { chain, events: proof.events }
  const folded = foldControllerLog(did, { chain, events: [] })
  if (!folded.ok) {
    throw new RevokeProofError(
      isDetachedFoldReason(folded.reason) ? 'detached' : 'not-authority-signed',
    )
  }
  for (let index = 1; index < folded.states.length; index++) {
    if (folded.states[index]?.digest === folded.states[index - 1]?.digest)
      throw new RevokeProofError('not-authority-signed')
  }
  if (first?.t === 'icp' && before != null && folded.head.gen <= before.head.gen)
    throw new RevokeProofError('detached')

  let authoritative: ReturnType<typeof authoritativeLog>
  try {
    const loaded = recorded == null ? joined : mergeLogs(did, recorded, joined)
    authoritative = authoritativeLog({ did, loaded, seen: recorded, context: 'device registry' })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    const detached =
      message.includes(LOG_FORKED) ||
      message.includes(LOG_NOT_AUTHORITATIVE) ||
      isDetachedFoldReason(message)
    const error = new RevokeProofError(detached ? 'detached' : 'not-authority-signed')
    error.cause = cause
    throw error
  }
  const { log, result: after } = authoritative
  const applied = new Set(before?.applied)
  const introduced = after.applied.filter((digest) => !applied.has(digest))
  const newlyApplied = new Set(introduced)
  // Saturation bounds stored copies, but every newly applied author still needs endorsement.
  for (const signed of proof.events) {
    if (!isEpochEventShape(signed)) continue
    const { event } = signed
    if (!newlyApplied.has(digestOf(event)) || event.by == null) continue
    const author = before?.head.members.get(event.by)
    if (author != null && (author.removed || !author.effective))
      throw new RevokeProofError('not-endorsed')
  }
  return { log, ...(before == null ? {} : { before }), after, introduced }
}

export function effectDelta(
  before: KeyState | undefined,
  after: KeyState,
): { denied: Array<string>; removed: Array<{ did: string; add: string }>; generation: boolean } {
  const denials = (state: KeyState | undefined) => {
    return new Set(
      [...(state?.deny ?? [])].filter((target) => target.startsWith('did:')).map(normalizeDID),
    )
  }
  const prior = denials(before)
  const denied = [...denials(after)].filter((did) => !prior.has(did)).sort()
  const removed: Array<{ did: string; add: string }> = []
  for (const [add, member] of before?.members ?? []) {
    if (!member.effective) continue
    const held = after.members.get(add)
    if (held?.effective && normalizeDID(held.did) === normalizeDID(member.did)) continue
    removed.push({ did: normalizeDID(member.did), add })
  }
  removed.sort((a, b) => a.did.localeCompare(b.did) || a.add.localeCompare(b.add))
  return { denied, removed, generation: after.gen !== (before?.gen ?? 0) }
}
