import { encode, mlsMessageEncoder } from 'ts-mls'

import { commitWithEntries } from './group-commit.js'
import { deriveGroup, type GroupHandle, mutexFor } from './group-handle.js'

export type CommitKeyRotationResult = {
  commitMessage: Uint8Array
  newGroup: GroupHandle
  epoch: bigint
}

export async function commitKeyRotation(group: GroupHandle): Promise<CommitKeyRotationResult> {
  return mutexFor(group).run(async () => {
    if (Object.keys(group.state.unappliedProposals).length !== 0)
      throw new Error('Key rotation refuses pending proposals')
    const result = await commitWithEntries({
      group,
      pendingProposals: {},
      extraProposals: [],
      enacted: [],
      requireAdmin: false,
    })
    const newGroup = deriveGroup(group, result.newState)
    return {
      commitMessage: encode(mlsMessageEncoder, result.commit),
      newGroup,
      epoch: newGroup.epoch,
    }
  })
}
