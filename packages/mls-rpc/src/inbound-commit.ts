import { encodeClientState, type GroupHandle } from '@kumiai/mls'
import { type AdoptionWrite, digestAppliedCommit } from '@kumiai/rpc'

import type { PersistContext } from './access.js'
import { sameStoredValue } from './memory-incarnation-stores.js'
import type { ReadableGroupState } from './registry/types.js'

type InboundCommit = {
  source: GroupHandle
  epoch: number
  authenticator: Uint8Array
  result: GroupHandle
  state?: Uint8Array
  digest: string
}

const inboundCommits = new WeakMap<PersistContext, InboundCommit>()

// Only the authenticated processMessage persist callback mints this one-use proof.
export function inboundCommitContext(
  source: GroupHandle,
  before: { epoch: number; authenticator: Uint8Array },
  result: GroupHandle,
  commit: Uint8Array,
  context?: PersistContext,
  bindResult = false,
): PersistContext {
  const proof = { ...context }
  inboundCommits.set(proof, {
    source,
    ...before,
    result,
    ...(bindResult ? { state: encodeClientState(result.state) } : {}),
    digest: digestAppliedCommit(commit),
  })
  return proof
}

export function consumesInboundCommit(params: {
  context: PersistContext | undefined
  source: GroupHandle
  result: GroupHandle
  capturedState: Uint8Array
  cursorBefore: AdoptionWrite['changes']['cursor']
  record: ReadableGroupState
  write: AdoptionWrite | undefined
}): boolean {
  const { context, source, result, capturedState, record, write, cursorBefore } = params
  const proof = context === undefined ? undefined : inboundCommits.get(context)
  if (context !== undefined) inboundCommits.delete(context)
  const row = write?.changes.putApplied?.find((row) => row.epoch === record.epoch)
  return (
    proof !== undefined &&
    proof.source === source &&
    proof.result === result &&
    proof.epoch === record.epoch &&
    sameStoredValue(proof.authenticator, record.epochAuthenticator) &&
    proof.state !== undefined &&
    sameStoredValue(proof.state, capturedState) &&
    Number(result.epoch) === record.epoch + 1 &&
    write?.changes.commitOnce === null &&
    row?.digest === proof.digest &&
    row.removed === false &&
    write.changes.cursor?.epoch === Number(result.epoch) &&
    (write.changes.cursor.position === row.sequenceID ||
      (write.changes.cursor.stranded === true &&
        write.changes.cursor.position === (cursorBefore?.position ?? null) &&
        (write.changes.cursor.position === null ||
          write.changes.cursor.position <= row.sequenceID)))
  )
}
