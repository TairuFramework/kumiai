import { normalizeDID } from '@kokuin/token'
import type { GroupContextExtension, Proposal, ProposalWithSender } from 'ts-mls'
import { defaultProposalTypes, makeCustomExtension } from 'ts-mls'
import { describe, expect, test } from 'vitest'

import { GROUP_ANCHOR_EXTENSION_TYPE, LEDGER_HEAD_EXTENSION_TYPE } from '../src/anchor.js'
import {
  type CommitPolicyContext,
  defaultCommitPolicy,
  MissingLedgerEntriesError,
} from '../src/policy.js'
import type { GroupPermission, RosterState } from '../src/roster.js'

const ADMIN_DID = 'did:key:zAdmin'
const MEMBER_DID = 'did:key:zMember'
const THIRD_DID = 'did:key:zThird'
const OUTSIDER_DID = 'did:key:zOutsider'

const ADMIN_LEAF = 0
const MEMBER_LEAF = 1
const THIRD_LEAF = 2

const ANCHOR_BYTES = new Uint8Array([0xf1, 0x00, 0x01, 0x02, 0x03])
/** The head bytes a commit enacting nothing must re-install unchanged. */
const HEAD_BYTES = new Uint8Array([0x01, 0xaa, 0xbb, 0xcc])
/** Any other head: what a commit moving the head to a value the envelope does not
 *  account for would install. */
const OTHER_HEAD_BYTES = new Uint8Array([0x01, 0xde, 0xad, 0xbe])

function roster(entries: Array<[string, GroupPermission]>): RosterState {
  return { roles: new Map(entries.map(([did, permission]) => [normalizeDID(did), permission])) }
}

function context(overrides: Partial<CommitPolicyContext> = {}): CommitPolicyContext {
  const baseRoster = roster([
    [ADMIN_DID, 'admin'],
    [MEMBER_DID, 'member'],
  ])
  const leaves = new Map<number, string>([
    [ADMIN_LEAF, ADMIN_DID],
    [MEMBER_LEAF, MEMBER_DID],
    [THIRD_LEAF, THIRD_DID],
  ])
  return {
    baseRoster,
    candidateRoster: baseRoster,
    didOfLeaf: (leafIndex) => leaves.get(leafIndex),
    currentExtensions: controlExtensions(HEAD_BYTES.slice()),
    expectedHeadExtensionData: HEAD_BYTES,
    commitEnactsEntries: false,
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

function headExtension(bytes: Uint8Array): GroupContextExtension {
  return makeCustomExtension({ extensionType: LEDGER_HEAD_EXTENSION_TYPE, extensionData: bytes })
}

/** A non-head, non-anchor GroupContext extension type — stands in for something like
 *  external_senders that an admin must not be able to inject or strip on a head move. */
const EXTRA_EXTENSION_TYPE = 0xf200
const EXTRA_BYTES = new Uint8Array([0x09, 0x08, 0x07])

function extraExtension(bytes: Uint8Array): GroupContextExtension {
  return makeCustomExtension({ extensionType: EXTRA_EXTENSION_TYPE, extensionData: bytes })
}

/** The list a legitimate head update installs: the unchanged anchor and the head. */
function controlExtensions(head: Uint8Array): Array<GroupContextExtension> {
  return [anchorExtension(ANCHOR_BYTES.slice()), headExtension(head)]
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

  test('group_context_extensions accepts an admin re-including the anchor and the expected head', () => {
    const gce = gceProposal(controlExtensions(HEAD_BYTES.slice()))
    expect(defaultCommitPolicy(commit(ADMIN_LEAF, [withSender(gce, undefined)]), context())).toBe(
      'accept',
    )
  })

  test('group_context_extensions rejects a mutated anchor', () => {
    const gce = gceProposal([
      anchorExtension(new Uint8Array([0xff, 0xff])),
      headExtension(HEAD_BYTES.slice()),
    ])
    expect(defaultCommitPolicy(commit(ADMIN_LEAF, [withSender(gce, undefined)]), context())).toBe(
      'reject',
    )
  })

  test('group_context_extensions rejects a list with no anchor extension', () => {
    const gce = gceProposal([headExtension(HEAD_BYTES.slice())])
    expect(defaultCommitPolicy(commit(ADMIN_LEAF, [withSender(gce, undefined)]), context())).toBe(
      'reject',
    )
  })

  test('group_context_extensions rejects a list with no head extension', () => {
    const gce = gceProposal([anchorExtension(ANCHOR_BYTES.slice())])
    expect(defaultCommitPolicy(commit(ADMIN_LEAF, [withSender(gce, undefined)]), context())).toBe(
      'reject',
    )
  })

  test('group_context_extensions rejects a head the envelope does not account for', () => {
    const gce = gceProposal(controlExtensions(OTHER_HEAD_BYTES))
    expect(defaultCommitPolicy(commit(ADMIN_LEAF, [withSender(gce, undefined)]), context())).toBe(
      'reject',
    )
  })

  test('group_context_extensions by a member is rejected even when the anchor is intact', () => {
    const gce = gceProposal(controlExtensions(HEAD_BYTES.slice()))
    expect(defaultCommitPolicy(commit(MEMBER_LEAF, [withSender(gce, undefined)]), context())).toBe(
      'reject',
    )
  })

  test('group_context_extensions accepts moving only the head while every other extension is unchanged', () => {
    // A group carrying an extra extension: moving the head to its expected value while
    // leaving the anchor and the extra extension byte-identical and in place is accepted.
    const current = [
      anchorExtension(ANCHOR_BYTES.slice()),
      extraExtension(EXTRA_BYTES.slice()),
      headExtension(HEAD_BYTES.slice()),
    ]
    const gce = gceProposal([
      anchorExtension(ANCHOR_BYTES.slice()),
      extraExtension(EXTRA_BYTES.slice()),
      headExtension(OTHER_HEAD_BYTES.slice()),
    ])
    expect(
      defaultCommitPolicy(
        commit(ADMIN_LEAF, [withSender(gce, undefined)]),
        context({ currentExtensions: current, expectedHeadExtensionData: OTHER_HEAD_BYTES }),
      ),
    ).toBe('accept')
  })

  test('group_context_extensions rejects a correct head move that injects a new extension', () => {
    const current = [anchorExtension(ANCHOR_BYTES.slice()), headExtension(HEAD_BYTES.slice())]
    const gce = gceProposal([
      anchorExtension(ANCHOR_BYTES.slice()),
      headExtension(HEAD_BYTES.slice()),
      extraExtension(EXTRA_BYTES.slice()),
    ])
    expect(
      defaultCommitPolicy(
        commit(ADMIN_LEAF, [withSender(gce, undefined)]),
        context({ currentExtensions: current, expectedHeadExtensionData: HEAD_BYTES }),
      ),
    ).toBe('reject')
  })

  test('group_context_extensions rejects a correct head move that strips an existing extension', () => {
    const current = [
      anchorExtension(ANCHOR_BYTES.slice()),
      extraExtension(EXTRA_BYTES.slice()),
      headExtension(HEAD_BYTES.slice()),
    ]
    const gce = gceProposal([
      anchorExtension(ANCHOR_BYTES.slice()),
      headExtension(HEAD_BYTES.slice()),
    ])
    expect(
      defaultCommitPolicy(
        commit(ADMIN_LEAF, [withSender(gce, undefined)]),
        context({ currentExtensions: current, expectedHeadExtensionData: HEAD_BYTES }),
      ),
    ).toBe('reject')
  })

  test('group_context_extensions rejects a correct head move that alters another extension', () => {
    const current = [
      anchorExtension(ANCHOR_BYTES.slice()),
      extraExtension(EXTRA_BYTES.slice()),
      headExtension(HEAD_BYTES.slice()),
    ]
    const gce = gceProposal([
      anchorExtension(ANCHOR_BYTES.slice()),
      extraExtension(new Uint8Array([0xbe, 0xef])),
      headExtension(HEAD_BYTES.slice()),
    ])
    expect(
      defaultCommitPolicy(
        commit(ADMIN_LEAF, [withSender(gce, undefined)]),
        context({ currentExtensions: current, expectedHeadExtensionData: HEAD_BYTES }),
      ),
    ).toBe('reject')
  })

  test('a commit that enacts entries without a group_context_extensions proposal is rejected', () => {
    // Entries would be enacted while the head stood still, so the head would stop
    // covering the ledger and an omission would become undetectable.
    const add = taggedProposal(defaultProposalTypes.add)
    expect(
      defaultCommitPolicy(
        commit(ADMIN_LEAF, [withSender(add, undefined)]),
        context({ commitEnactsEntries: true }),
      ),
    ).toBe('reject')
  })

  test('an empty commit that enacts entries is rejected', () => {
    expect(
      defaultCommitPolicy(commit(ADMIN_LEAF, []), context({ commitEnactsEntries: true })),
    ).toBe('reject')
  })

  test('a commit enacting entries and moving the head to the expected value is accepted', () => {
    const add = taggedProposal(defaultProposalTypes.add)
    const gce = gceProposal(controlExtensions(OTHER_HEAD_BYTES.slice()))
    expect(
      defaultCommitPolicy(
        commit(ADMIN_LEAF, [withSender(add, undefined), withSender(gce, undefined)]),
        context({
          commitEnactsEntries: true,
          expectedHeadExtensionData: OTHER_HEAD_BYTES,
        }),
      ),
    ).toBe('accept')
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

  test('an admin may remove a plain member', () => {
    const remove = removeProposal(MEMBER_LEAF)
    expect(
      defaultCommitPolicy(commit(ADMIN_LEAF, [withSender(remove, undefined)]), context()),
    ).toBe('accept')
  })

  test('removing a target still admin in the candidate roster is rejected', () => {
    // No demotion rode this commit, so the target is still admin after the fold.
    const roles = roster([
      [ADMIN_DID, 'admin'],
      [THIRD_DID, 'admin'],
    ])
    const remove = removeProposal(THIRD_LEAF)
    expect(
      defaultCommitPolicy(
        commit(ADMIN_LEAF, [withSender(remove, undefined)]),
        context({ baseRoster: roles, candidateRoster: roles }),
      ),
    ).toBe('reject')
  })

  test('removing an admin the same envelope demoted to member is accepted', () => {
    const remove = removeProposal(THIRD_LEAF)
    expect(
      defaultCommitPolicy(
        commit(ADMIN_LEAF, [withSender(remove, undefined)]),
        context({
          baseRoster: roster([
            [ADMIN_DID, 'admin'],
            [THIRD_DID, 'admin'],
          ]),
          candidateRoster: roster([
            [ADMIN_DID, 'admin'],
            [THIRD_DID, 'member'],
          ]),
        }),
      ),
    ).toBe('accept')
  })

  test('an admin cannot self-remove while still admin in the candidate roster', () => {
    // The candidate-admin check precedes the self-removal shortcut, so an admin
    // must demote itself in the same envelope before it may remove its own leaf.
    const remove = removeProposal(ADMIN_LEAF)
    expect(
      defaultCommitPolicy(commit(ADMIN_LEAF, [withSender(remove, undefined)]), context()),
    ).toBe('reject')
  })

  test('an admin may self-remove when the same envelope demotes it to member', () => {
    const remove = removeProposal(ADMIN_LEAF)
    expect(
      defaultCommitPolicy(
        commit(ADMIN_LEAF, [withSender(remove, undefined)]),
        context({ candidateRoster: roster([[ADMIN_DID, 'member']]) }),
      ),
    ).toBe('accept')
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
