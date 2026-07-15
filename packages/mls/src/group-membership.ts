import { type DefaultProposal, defaultProposalTypes, encode, mlsMessageEncoder } from 'ts-mls'

import { commitWithEntries } from './group-commit.js'
import { deriveGroup, type GroupHandle, mutexFor } from './group-handle.js'

export type RemoveMemberResult = {
  /** Framed MLSMessage bytes. Broadcast to existing members via the DS. */
  commitMessage: Uint8Array
  newGroup: GroupHandle
  /** Post-commit epoch (== newGroup.epoch). NOT the commit's wire-header epoch: a
   *  commit is framed at the sender's pre-commit epoch (== epoch - 1n), which is what
   *  receivers compare against their own handle.epoch for ordering (see
   *  readMessageEpoch). */
  epoch: bigint
}

/**
 * Remove a member. Advances the epoch and rotates keys.
 *
 * Removal must demote: a receiver rejects a Remove whose target is still `admin` in
 * the folded roster. So removing an admin means riding the demotion entry on the same
 * commit — pass it as `ledgerEntries`. The caller signs the entry; this only carries it.
 *
 * Reads `group` and returns a NEW derived handle (`newGroup`); it never advances
 * `group`. The caller MUST adopt `newGroup` — never reuse `group` — before the next
 * commit: two commits from the same source handle both frame at its epoch and diverge.
 * The mutex only serializes concurrent calls against one handle; it does not make a
 * second commit from a superseded handle safe.
 */
export async function removeMember(
  group: GroupHandle,
  leafIndex: number,
  ledgerEntries?: Array<string>,
): Promise<RemoveMemberResult> {
  return mutexFor(group).run(async () => {
    const removeProposal: DefaultProposal = {
      proposalType: defaultProposalTypes.remove,
      remove: { removed: leafIndex },
    }

    const enacted = ledgerEntries ?? []
    const result = await commitWithEntries(group, [removeProposal], enacted)

    const newGroup = deriveGroup(group, result.newState)
    await newGroup.applyLedgerEntries(enacted)

    return {
      commitMessage: encode(mlsMessageEncoder, result.commit),
      newGroup,
      epoch: newGroup.epoch,
    }
  })
}
