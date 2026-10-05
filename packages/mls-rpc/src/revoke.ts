import { type GroupHandle, type RevokeBuildResult, revokeWithProof } from '@kumiai/mls'
import type { GroupMLS, GroupPeer, GroupProtocolDefinition } from '@kumiai/rpc'

import { groupHandleAccess } from './mls.js'

export type RevokeJournalOptions = {
  /** Must restore the derived handle INCLUDING its ledger through the host's adoptJournalled. */
  serializeJournal: (derived: GroupHandle) => Promise<Uint8Array> | Uint8Array
}

export type PublishRevokeResult =
  | { status: 'committed'; epoch: number }
  | Exclude<RevokeBuildResult, { status: 'built' }>

export type PublishRevokeProofParams<Protocols extends Record<string, GroupProtocolDefinition>> = {
  peer: GroupPeer<Protocols>
  mls: GroupMLS
  input: Parameters<typeof revokeWithProof>[1]
  options: RevokeJournalOptions
}

export async function publishRevokeProof<Protocols extends Record<string, GroupProtocolDefinition>>(
  params: PublishRevokeProofParams<Protocols>,
): Promise<PublishRevokeResult> {
  const { peer, mls, input, options } = params
  const access = groupHandleAccess.get(mls)
  if (access == null) throw new Error('publishRevokeProof requires an adapter-created GroupMLS')
  const finished = Symbol('proof needs no commit')
  let outcome: PublishRevokeResult | undefined
  try {
    await peer.commit(
      async () => {
        const built = await access.read(async (group) => {
          const result = await revokeWithProof(group, input)
          return { result, priorTokens: new Set(group.ledgerTokens) }
        })
        if (built.result.status !== 'built') {
          outcome = built.result
          throw finished
        }
        const { newGroup, commitMessage, epoch } = built.result.result
        const journal = await options.serializeJournal(newGroup)
        return {
          commit: commitMessage,
          bodies: newGroup.ledgerTokens.filter((token) => !built.priorTokens.has(token)),
          kind: 'ledger',
          journal,
          onAccepted: async () => {
            await access.replace(newGroup)
            outcome = { status: 'committed', epoch: Number(epoch) }
          },
        }
      },
      { holdLogSends: true },
    )
  } catch (error) {
    if (error !== finished) throw error
  }
  if (outcome == null) throw new Error('Proof commit completed without an outcome')
  return outcome
}
