import { type OwnIdentity, randomIdentity } from '@kokuin/token'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  exportGroupInfo,
  type GroupHandle,
  joinGroupExternal,
  ledgerEntryDigest,
  processWelcome,
  removeMember,
} from '@kumiai/mls'
import { decode, encode, mlsMessageDecoder, mlsMessageEncoder, wireformats } from 'ts-mls'

import { createLedgerEntrySlot, type LedgerEntrySlot } from '../../src/mls.js'

export type RealMember = {
  identity: OwnIdentity
  handle: GroupHandle
  slot: LedgerEntrySlot
}

/**
 * A real MLS group with a COMMITTER outside the member list.
 *
 * Every commit the conformance suites hand a port is authored here rather than by one of the
 * ports under test, which is what makes them all RECEIVED commits — the case `processCommit`'s
 * contract is about, and the case a double that models a commit as a value to adopt gets wrong.
 */
export type RealGroup = {
  committer: RealMember
  members: Array<RealMember>
  /** Every ledger-entry body any commit in this group names, by digest. */
  bodies: Map<string, string>
  /** What a `CommitContext` carries: the bodies riding a commit's own frame. */
  resolveLedgerEntries: (ids: Array<string>) => Promise<Array<string>>
}

export async function createRealGroup(size: number, groupID: string): Promise<RealGroup> {
  const bodies = new Map<string, string>()
  const resolveLedgerEntries = async (ids: Array<string>) =>
    ids.map((id) => {
      const token = bodies.get(id)
      if (token == null) throw new Error(`unknown ledger entry ${id}`)
      return token
    })

  const makeSlot = (): LedgerEntrySlot => {
    const slot = createLedgerEntrySlot()
    // Installed so joining and restoring resolve; `processCommit` swaps in the commit's own
    // resolver for its duration and clears it again, which is the contract this slot exists for.
    slot.install(resolveLedgerEntries)
    return slot
  }

  const committerIdentity = randomIdentity()
  const committerSlot = makeSlot()
  const { group } = await createGroup(committerIdentity, groupID, {
    resolveLedgerEntries: committerSlot.resolve,
  })
  const committer: RealMember = {
    identity: committerIdentity,
    handle: group,
    slot: committerSlot,
  }

  const members: Array<RealMember> = []
  for (let index = 0; index < size; index++) {
    const identity = randomIdentity()
    const slot = makeSlot()
    const { invite } = await createInvite({
      group: committer.handle,
      identity: committerIdentity,
      recipientDID: identity.id,
      permission: 'member',
    })
    for (const token of invite.ledgerEntries) bodies.set(ledgerEntryDigest(token), token)
    const bundle = await createKeyPackageBundle(identity)
    const added = await commitInvite(committer.handle, bundle.publicPackage, invite)
    committer.handle = added.newGroup
    // The members already in the group walk forward over the same commit the newcomer's
    // Welcome describes, so the whole group ends at one epoch.
    for (const member of members) await member.handle.processMessage(added.commitMessage)
    const { group: joined } = await processWelcome({
      identity,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      ratchetTree: committer.handle.state.ratchetTree,
      options: { resolveLedgerEntries: slot.resolve },
    })
    members.push({ identity, handle: joined, slot })
  }

  return { committer, members, bodies, resolveLedgerEntries }
}

/** A Commit the committer authors and adopts, framed at the epoch every member is still at. */
export async function buildRealCommit(
  group: RealGroup,
  options: { removes?: number } = {},
): Promise<Uint8Array> {
  if (options.removes != null) {
    const member = group.members[options.removes]
    if (member == null) throw new Error(`no member at index ${options.removes}`)
    const leafIndex = group.committer.handle.findMemberLeafIndex(member.identity.id)
    if (leafIndex == null) throw new Error(`no leaf for ${member.identity.id}`)
    const removed = await removeMember(group.committer.handle, leafIndex)
    group.committer.handle = removed.newGroup
    return removed.commitMessage
  }
  // A plain advance. MLS has no bare "move on" commit reachable from this surface, so the
  // committer adds a throwaway member — a commit that changes the epoch and carries entries,
  // which is also the shape a receiving port has to resolve bodies for.
  const newcomer = randomIdentity()
  const { invite } = await createInvite({
    group: group.committer.handle,
    identity: group.committer.identity,
    recipientDID: newcomer.id,
    permission: 'member',
  })
  for (const token of invite.ledgerEntries) group.bodies.set(ledgerEntryDigest(token), token)
  const bundle = await createKeyPackageBundle(newcomer)
  const added = await commitInvite(group.committer.handle, bundle.publicPackage, invite)
  group.committer.handle = added.newGroup
  return added.commitMessage
}

/**
 * A genuine external commit — `members[rejoining]` rejoining the group it is already in — and the
 * forgery of it a publisher holding no key can produce: the same frame with ONLY the UpdatePath
 * leaf's credential identity rewritten. The leaf's signature key is untouched, so the frame is
 * still a well-formed external commit at the same epoch whose signature no longer matches its
 * content.
 */
export async function buildRealExternalCommit(
  group: RealGroup,
  params: { rejoining: number; forgeAs: string },
): Promise<{ genuine: Uint8Array; forged: Uint8Array }> {
  const member = group.members[params.rejoining]
  if (member == null) throw new Error(`no member at index ${params.rejoining}`)
  const { groupInfo } = await exportGroupInfo({ group: group.committer.handle })
  const { commitMessage } = await joinGroupExternal({
    identity: member.identity,
    groupInfo,
    credential: member.handle.credential,
    resync: true,
  })
  return {
    genuine: commitMessage,
    forged: rewriteExternalCommitIdentity(commitMessage, params.forgeAs),
  }
}

function rewriteExternalCommitIdentity(commit: Uint8Array, did: string): Uint8Array {
  const decoded = decode(mlsMessageDecoder, commit)
  if (decoded == null || decoded.wireformat !== wireformats.mls_public_message) {
    throw new Error('not a public message')
  }
  const content = decoded.publicMessage.content as unknown as {
    commit: { path: { leafNode: { credential: { identity: Uint8Array } } } }
  }
  const path = content.commit.path
  return encode(mlsMessageEncoder, {
    ...decoded,
    publicMessage: {
      ...decoded.publicMessage,
      content: {
        ...content,
        commit: {
          ...content.commit,
          path: {
            ...path,
            leafNode: {
              ...path.leafNode,
              credential: {
                ...path.leafNode.credential,
                identity: new TextEncoder().encode(JSON.stringify({ id: did })),
              },
            },
          },
        },
      },
    },
  } as never)
}
