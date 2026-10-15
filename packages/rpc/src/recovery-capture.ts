import type { EpochIdentity, GroupKey } from './control/types.js'
import type { LogPosition } from './cursor.js'

export type CommitPrefix =
  | {
      kind: 'complete'
      key: GroupKey
      identity: EpochIdentity
      stateVersion: number
      head: LogPosition | null
    }
  | { kind: 'incomplete' | 'held' }

export async function replyWithReconciledGroupInfo(params: {
  reconcileCommitPrefix(): Promise<CommitPrefix>
  sealGroupInfo(head: LogPosition | null): Promise<Uint8Array>
  publish(sealed: Uint8Array): Promise<unknown>
  blocked(): boolean
}): Promise<boolean> {
  if (params.blocked()) return false
  const prefix = await params.reconcileCommitPrefix()
  if (prefix.kind !== 'complete' || params.blocked()) return false
  const sealed = await params.sealGroupInfo(prefix.head)
  if (params.blocked()) return false
  await params.publish(sealed)
  return true
}
