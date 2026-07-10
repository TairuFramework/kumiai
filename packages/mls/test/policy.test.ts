import { normalizeDID } from '@kokuin/token'
import type { GroupContextExtension, Proposal, ProposalWithSender } from 'ts-mls'
import { defaultProposalTypes, makeCustomExtension } from 'ts-mls'
import { describe, expect, test } from 'vitest'

import { GROUP_ANCHOR_EXTENSION_TYPE } from '../src/anchor.js'
import type { GroupPermission } from '../src/capability.js'
import {
  type CommitPolicyContext,
  defaultCommitPolicy,
  MissingLedgerEntriesError,
} from '../src/policy.js'
import type { RosterState } from '../src/roster.js'

const ADMIN_DID = 'did:key:zAdmin'
const MEMBER_DID = 'did:key:zMember'
const THIRD_DID = 'did:key:zThird'
const OUTSIDER_DID = 'did:key:zOutsider'

const ADMIN_LEAF = 0
const MEMBER_LEAF = 1
const THIRD_LEAF = 2

const ANCHOR_BYTES = new Uint8Array([0xf1, 0x00, 0x01, 0x02, 0x03])

function context(overrides: Partial<CommitPolicyContext> = {}): CommitPolicyContext {
  const roles = new Map<string, GroupPermission>([
    [normalizeDID(ADMIN_DID), 'admin'],
    [normalizeDID(MEMBER_DID), 'member'],
  ])
  const roster: RosterState = { roles }
  const leaves = new Map<number, string>([
    [ADMIN_LEAF, ADMIN_DID],
    [MEMBER_LEAF, MEMBER_DID],
    [THIRD_LEAF, THIRD_DID],
  ])
  return {
    roster,
    didOfLeaf: (leafIndex) => leaves.get(leafIndex),
    anchorExtensionData: ANCHOR_BYTES,
    ...overrides,
  }
}

/**
 * A proposal whose crypto-bearing payload the policy never inspects (add,
 * update, psk, reinit, external_init). The type tag is real; the payload is not
 * fabricated because no case depends on it.
 */
function taggedProposal(proposalType: number): Proposal {
  return { proposalType, payload: undefined } as unknown as Proposal
}

function removeProposal(removed: number): Proposal {
  return { proposalType: defaultProposalTypes.remove, remove: { removed } }
}

function gceProposal(extensions: Array<GroupContextExtension>): Proposal {
  return {
    proposalType: defaultProposalTypes.group_context_extensions,
    groupContextExtensions: { extensions },
  }
}

function customProposal(proposalType: number): Proposal {
  return { proposalType, proposalData: new Uint8Array([0]) }
}

function anchorExtension(bytes: Uint8Array): GroupContextExtension {
  return makeCustomExtension({ extensionType: GROUP_ANCHOR_EXTENSION_TYPE, extensionData: bytes })
}

function withSender(proposal: Proposal, senderLeafIndex: number | undefined): ProposalWithSender {
  return { proposal, senderLeafIndex }
}

function commit(
  senderLeafIndex: number | undefined,
  proposals: Array<ProposalWithSender>,
): { kind: 'commit'; senderLeafIndex: number | undefined; proposals: Array<ProposalWithSender> } {
  return { kind: 'commit', senderLeafIndex, proposals }
}

describe('defaultCommitPolicy', () => {
  test('add is admin-gated', () => {
    const add = taggedProposal(defaultProposalTypes.add)
    expect(defaultCommitPolicy(commit(MEMBER_LEAF, [withSender(add, undefined)]), context())).toBe(
      'reject',
    )
    expect(defaultCommitPolicy(commit(ADMIN_LEAF, [withSender(add, undefined)]), context())).toBe(
      'accept',
    )
  })

  test('remove of a third party is admin-gated', () => {
    const remove = removeProposal(THIRD_LEAF)
    expect(
      defaultCommitPolicy(commit(MEMBER_LEAF, [withSender(remove, undefined)]), context()),
    ).toBe('reject')
    expect(
      defaultCommitPolicy(commit(ADMIN_LEAF, [withSender(remove, undefined)]), context()),
    ).toBe('accept')
  })

  test('self-removal is allowed for a member', () => {
    const remove = removeProposal(MEMBER_LEAF)
    expect(
      defaultCommitPolicy(commit(MEMBER_LEAF, [withSender(remove, undefined)]), context()),
    ).toBe('accept')
  })

  test('update is always allowed', () => {
    const update = taggedProposal(defaultProposalTypes.update)
    expect(
      defaultCommitPolicy(commit(MEMBER_LEAF, [withSender(update, undefined)]), context()),
    ).toBe('accept')
  })

  test('psk and reinit are admin-gated', () => {
    const psk = taggedProposal(defaultProposalTypes.psk)
    const reinit = taggedProposal(defaultProposalTypes.reinit)
    expect(defaultCommitPolicy(commit(MEMBER_LEAF, [withSender(psk, undefined)]), context())).toBe(
      'reject',
    )
    expect(defaultCommitPolicy(commit(ADMIN_LEAF, [withSender(psk, undefined)]), context())).toBe(
      'accept',
    )
    expect(
      defaultCommitPolicy(commit(MEMBER_LEAF, [withSender(reinit, undefined)]), context()),
    ).toBe('reject')
  })

  test('group_context_extensions accepts an admin re-including the byte-identical anchor', () => {
    const gce = gceProposal([anchorExtension(ANCHOR_BYTES.slice())])
    expect(defaultCommitPolicy(commit(ADMIN_LEAF, [withSender(gce, undefined)]), context())).toBe(
      'accept',
    )
  })

  test('group_context_extensions rejects a mutated anchor', () => {
    const gce = gceProposal([anchorExtension(new Uint8Array([0xff, 0xff]))])
    expect(defaultCommitPolicy(commit(ADMIN_LEAF, [withSender(gce, undefined)]), context())).toBe(
      'reject',
    )
  })

  test('group_context_extensions rejects a list with no anchor extension', () => {
    const gce = gceProposal([
      makeCustomExtension({ extensionType: 0xf101, extensionData: new Uint8Array([1]) }),
    ])
    expect(defaultCommitPolicy(commit(ADMIN_LEAF, [withSender(gce, undefined)]), context())).toBe(
      'reject',
    )
  })

  test('group_context_extensions by a member is rejected even when the anchor is intact', () => {
    const gce = gceProposal([anchorExtension(ANCHOR_BYTES.slice())])
    expect(defaultCommitPolicy(commit(MEMBER_LEAF, [withSender(gce, undefined)]), context())).toBe(
      'reject',
    )
  })

  test('external_init commit accepts a roster member rejoining by removing its own leaf', () => {
    const externalCommit = commit(undefined, [
      withSender(taggedProposal(defaultProposalTypes.external_init), undefined),
      withSender(removeProposal(MEMBER_LEAF), undefined),
    ])
    expect(defaultCommitPolicy(externalCommit, context({ externalCommitDID: MEMBER_DID }))).toBe(
      'accept',
    )
  })

  test('external_init commit rejects a DID absent from the roster', () => {
    const externalCommit = commit(undefined, [
      withSender(taggedProposal(defaultProposalTypes.external_init), undefined),
      withSender(removeProposal(MEMBER_LEAF), undefined),
    ])
    expect(defaultCommitPolicy(externalCommit, context({ externalCommitDID: OUTSIDER_DID }))).toBe(
      'reject',
    )
  })

  test('external_init commit rejects any proposal beyond external_init and the self-remove', () => {
    const externalCommit = commit(undefined, [
      withSender(taggedProposal(defaultProposalTypes.external_init), undefined),
      withSender(removeProposal(MEMBER_LEAF), undefined),
      withSender(taggedProposal(defaultProposalTypes.add), undefined),
    ])
    expect(defaultCommitPolicy(externalCommit, context({ externalCommitDID: MEMBER_DID }))).toBe(
      'reject',
    )
  })

  test('external_init commit rejects a remove that targets a different leaf', () => {
    const externalCommit = commit(undefined, [
      withSender(taggedProposal(defaultProposalTypes.external_init), undefined),
      withSender(removeProposal(THIRD_LEAF), undefined),
    ])
    expect(defaultCommitPolicy(externalCommit, context({ externalCommitDID: MEMBER_DID }))).toBe(
      'reject',
    )
  })

  test('an empty commit is a key rotation any member may make', () => {
    expect(defaultCommitPolicy(commit(MEMBER_LEAF, []), context())).toBe('accept')
  })

  test('an admin cannot launder a member by-reference remove of a third party', () => {
    // The committer is an admin, but the Remove was authored by a member; the
    // effective sender is the member, so the third-party remove is rejected.
    const laundered = commit(ADMIN_LEAF, [withSender(removeProposal(THIRD_LEAF), MEMBER_LEAF)])
    expect(defaultCommitPolicy(laundered, context())).toBe('reject')
  })

  test('a commit mixing a passing and a failing proposal is rejected', () => {
    const mixed = commit(MEMBER_LEAF, [
      withSender(taggedProposal(defaultProposalTypes.update), undefined),
      withSender(taggedProposal(defaultProposalTypes.add), undefined),
    ])
    expect(defaultCommitPolicy(mixed, context())).toBe('reject')
  })

  test('an unknown proposal type is rejected even for an admin', () => {
    const unknown = commit(ADMIN_LEAF, [withSender(customProposal(0xa0a0), undefined)])
    expect(defaultCommitPolicy(unknown, context())).toBe('reject')
  })

  test('a standalone by-reference proposal is gated by its own sender', () => {
    const thirdPartyRemove = {
      kind: 'proposal' as const,
      proposal: withSender(removeProposal(THIRD_LEAF), MEMBER_LEAF),
    }
    expect(defaultCommitPolicy(thirdPartyRemove, context())).toBe('reject')

    const selfRemove = {
      kind: 'proposal' as const,
      proposal: withSender(removeProposal(MEMBER_LEAF), MEMBER_LEAF),
    }
    expect(defaultCommitPolicy(selfRemove, context())).toBe('accept')

    const update = {
      kind: 'proposal' as const,
      proposal: withSender(taggedProposal(defaultProposalTypes.update), MEMBER_LEAF),
    }
    expect(defaultCommitPolicy(update, context())).toBe('accept')
  })

  test('a standalone external_init is rejected', () => {
    const standalone = {
      kind: 'proposal' as const,
      proposal: withSender(taggedProposal(defaultProposalTypes.external_init), MEMBER_LEAF),
    }
    expect(defaultCommitPolicy(standalone, context())).toBe('reject')
  })

  test('the policy never throws, even on an unresolvable sender', () => {
    expect(() =>
      defaultCommitPolicy(
        commit(undefined, [withSender(taggedProposal(defaultProposalTypes.add), undefined)]),
        context(),
      ),
    ).not.toThrow()
  })
})

describe('MissingLedgerEntriesError', () => {
  test('carries its ids and is an Error', () => {
    const error = new MissingLedgerEntriesError(['entry-a', 'entry-b'])
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('MissingLedgerEntriesError')
    expect(error.ids).toEqual(['entry-a', 'entry-b'])
  })
})
