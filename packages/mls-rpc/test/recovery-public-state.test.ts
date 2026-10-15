import { randomIdentity } from '@kokuin/token'
import {
  type ClientState,
  createGroup,
  createKeyPackageBundle,
  decodeClientState,
  encodeClientState,
  removeMember,
} from '@kumiai/mls'
import {
  type CiphersuiteImpl,
  CodecError,
  createCommit,
  createGroupInfoWithExternalPubAndRatchetTree,
  decode,
  defaultExtensionTypes,
  defaultProposalTypes,
  encode,
  generateKeyPackage,
  joinGroup,
  keyPackageEncoder,
  mlsMessageDecoder,
  mlsMessageEncoder,
  wireformats,
} from 'ts-mls'
import { expect, test } from 'vitest'

import {
  leafBytes,
  offeredTree,
  publicTreeBytes,
  verifyOfferedGroupInfo,
} from '../src/recovery-public-state.js'
import { createRealGroup } from './fixtures/real-group.js'

async function genuineInfo(state: ClientState, suite: CiphersuiteImpl) {
  return {
    version: 1 as const,
    wireformat: wireformats.mls_group_info,
    groupInfo: await createGroupInfoWithExternalPubAndRatchetTree(state, [], suite),
  }
}

test.each([9, 17])(
  'public GroupInfo verification accepts genuine large trees: %s leaves',
  async (leaves) => {
    const s = await createRealGroup(leaves, `large-public-tree-${leaves}`)
    let group = (await removeMember(s.committer.handle, leaves)).newGroup
    const suite = group.context.cipherSuite
    const verify = async (state: ClientState) => {
      const info = await genuineInfo(state, suite)
      expect(info.groupInfo.groupContext.treeHash).toEqual(state.groupContext.treeHash)
      expect(await verifyOfferedGroupInfo(state, info, suite)).toBe(true)
    }
    expect(group.state.ratchetTree.filter((node) => node?.nodeType === 1)).toHaveLength(leaves)
    expect(group.state.ratchetTree.length).toBeGreaterThan(leaves * 2)
    expect(group.state.ratchetTree[leaves * 2]).toBeUndefined()
    await verify(group.state)

    const middle = Math.floor(leaves / 2)
    group = (await removeMember(group, middle)).newGroup
    expect(group.state.ratchetTree[middle * 2]).toBeUndefined()
    expect(
      group.state.ratchetTree.some((node, index) => index % 2 === 1 && node === undefined),
    ).toBe(true)
    await verify(group.state)

    // An add-only ts-mls commit preserves existing parents and creates unmerged leaves.
    const bundle = await createKeyPackageBundle(randomIdentity())
    const branch = decodeClientState(encodeClientState(group.state))
    if (branch === undefined) throw new Error('Missing branch state')
    const added = await createCommit({
      context: group.context,
      state: branch,
      extraProposals: [
        { proposalType: defaultProposalTypes.add, add: { keyPackage: bundle.publicPackage } },
      ],
      ratchetTreeExtension: true,
    })
    if (added.welcome === undefined) throw new Error('Missing genuine Welcome')
    const joined = await joinGroup({
      context: group.context,
      welcome: added.welcome.welcome,
      keyPackage: bundle.publicPackage,
      privateKeys: bundle.privatePackage,
    })
    expect(joined.groupContext.treeHash).toEqual(added.newState.groupContext.treeHash)
    expect(
      added.newState.ratchetTree.some(
        (node) => node?.nodeType === 2 && node.parent.unmergedLeaves.includes(middle),
      ),
    ).toBe(true)
    await verify(added.newState)
    await verify(joined)
  },
)

test.each(['suite', 'parent at leaf', 'leaf at parent'] as const)(
  'public GroupInfo verification refuses invalid suite or node parity: %s',
  async (fault) => {
    const s = await createRealGroup(2, `invalid-public-tree-${fault}`)
    const group = s.committer.handle
    const state = decodeClientState(encodeClientState(group.state))
    if (state === undefined) throw new Error('Missing state')
    if (fault === 'parent at leaf') state.ratchetTree[2] = state.ratchetTree[1]
    if (fault === 'leaf at parent') state.ratchetTree[1] = state.ratchetTree[2]
    if (fault === 'suite') state.groupContext.cipherSuite++
    const info = await genuineInfo(state, group.context.cipherSuite)
    expect(await verifyOfferedGroupInfo(group.state, info, group.context.cipherSuite)).toBe(false)
  },
)

test.each([
  ['empty', new Uint8Array([0])],
  ['trailing blank', new Uint8Array([1, 0])],
  ['unknown node type', new Uint8Array([2, 1, 3])],
] as const)(
  'public GroupInfo verification refuses malformed tree parsing: %s',
  async (_name, bytes) => {
    const { group } = await createGroup(randomIdentity(), 'malformed-public-tree')
    const info = await genuineInfo(group.state, group.context.cipherSuite)
    const extension = info.groupInfo.extensions.find(
      (entry) => entry.extensionType === defaultExtensionTypes.ratchet_tree,
    )
    if (extension === undefined) throw new Error('Missing tree extension')
    extension.extensionData = bytes
    await expect(
      verifyOfferedGroupInfo(group.state, info, group.context.cipherSuite),
    ).resolves.toBe(false)
  },
)

test.each(['signature', 'hash'] as const)(
  'public GroupInfo verification preserves %s implementation errors',
  async (operation) => {
    const { group } = await createGroup(randomIdentity(), 'public-tree-provider-errors')
    const suite = group.context.cipherSuite
    const info = await genuineInfo(group.state, suite)
    for (const failure of [
      new Error('Provider failure'),
      new TypeError('Provider shape'),
      new CodecError('Provider codec'),
      new RangeError('Provider range'),
    ]) {
      const failingSuite = {
        ...suite,
        ...(operation === 'signature'
          ? {
              signature: {
                ...suite.signature,
                verify: async () => {
                  throw failure
                },
              },
            }
          : {
              hash: {
                ...suite.hash,
                digest: async () => {
                  throw failure
                },
              },
            }),
      }
      await expect(verifyOfferedGroupInfo(group.state, info, failingSuite)).rejects.toBe(failure)
    }
  },
)

test.each([0, 1, 4])(
  'public GroupInfo verification accepts genuine trees with %s invited members',
  async (size) => {
    const { createRealGroup } = await import('./fixtures/real-group.js')
    const { exportGroupInfo, removeMember } = await import('@kumiai/mls')
    const s = await createRealGroup(size, `verified-public-tree-${size}`)
    let group = s.committer.handle
    if (size > 1) {
      const member = s.members[0]
      if (member === undefined) throw new Error('Missing member')
      const index = group.findMemberLeafIndex(member.identity.id)
      if (index === undefined) throw new Error('Missing member leaf')
      group = (await removeMember(group, index)).newGroup
    }
    const info = decode(mlsMessageDecoder, (await exportGroupInfo({ group })).groupInfo)
    if (info?.wireformat !== wireformats.mls_group_info) throw new Error('Missing GroupInfo')
    expect(await verifyOfferedGroupInfo(group.state, info, group.context.cipherSuite)).toBe(true)
    info.groupInfo.signature[0] = (info.groupInfo.signature[0] ?? 0) ^ 1
    expect(await verifyOfferedGroupInfo(group.state, info, group.context.cipherSuite)).toBe(false)
  },
)

test.each(['empty', 'zero-one-absent'] as const)(
  'public-state adapter isolates the exact tree across variable private suffixes: %s',
  async (proposals) => {
    const { group } = await createGroup(randomIdentity(), 'public-tree-adapter')
    const proposal = { proposalType: defaultProposalTypes.remove, remove: { removed: 0 } }
    const base: ClientState = {
      ...group.state,
      unappliedProposals:
        proposals === 'empty'
          ? {}
          : {
              'AA==': { proposal, senderLeafIndex: 0 },
              'AQ==': { proposal, senderLeafIndex: 1 },
              'Ag==': { proposal, senderLeafIndex: undefined },
            },
    }
    for (const size of [0, 1, 255, 32767]) {
      const tree = Array.from({ length: size }, (_, index) =>
        index === 0 || index === size - 1 ? group.state.ratchetTree[0] : undefined,
      )
      const state = { ...base, ratchetTree: tree }
      const info = await createGroupInfoWithExternalPubAndRatchetTree(
        state,
        [],
        group.context.cipherSuite,
      )
      const expected = info.extensions.find(
        (extension) => extension.extensionType === defaultExtensionTypes.ratchet_tree,
      )?.extensionData
      expect(publicTreeBytes(state).tree).toEqual(expected)
      const wire = encode(mlsMessageEncoder, {
        version: 1,
        wireformat: wireformats.mls_group_info,
        groupInfo: info,
      })
      if (size === 0) {
        expect(() => offeredTree(base, wire)).toThrow()
        continue
      }
      const restored = offeredTree(base, wire)
      expect(publicTreeBytes({ ...base, ratchetTree: restored }).tree).toEqual(expected)
      expect(restored).toHaveLength(size)
      if (size > 0) {
        const leaf = restored[0]
        expect(leafBytes(base, leaf)).toEqual(leafBytes(group.state, group.state.ratchetTree[0]))
        if (leaf?.nodeType !== 1) throw new Error('Missing test leaf')
        leaf.leaf.signature[0] = (leaf.leaf.signature[0] ?? 0) ^ 1
        expect(leafBytes(base, leaf)).not.toEqual(
          leafBytes(group.state, group.state.ratchetTree[0]),
        )
      }
    }
    const restored = decodeClientState(encodeClientState(base))
    if (restored === undefined) throw new Error('Missing round trip')
    expect(publicTreeBytes(restored).tree).toEqual(publicTreeBytes(base).tree)
    expect(() => offeredTree(base, new Uint8Array([0]))).toThrow()
    expect(() => leafBytes(base, undefined)).toThrow('fresh recovery leaf')
  },
)

test('leaf adapter returns exactly the LeafNode embedded by the public KeyPackage encoder', async () => {
  const { group } = await createGroup(randomIdentity(), 'leaf-wire-vector')
  const leaf = group.state.ratchetTree[0]
  if (leaf?.nodeType !== 1) throw new Error('Missing own leaf')
  const { publicPackage } = await generateKeyPackage({
    credential: leaf.leaf.credential,
    cipherSuite: group.context.cipherSuite,
  })
  expect(publicPackage.extensions).toEqual([])
  const vectorPrefix = (length: number) => (length < 64 ? 1 : length < 16384 ? 2 : 4)
  const encoded = encode(keyPackageEncoder, publicPackage)
  // KeyPackage: two u16 fields, init_key<V>, LeafNode, extensions<V>, signature<V>.
  const start = 4 + vectorPrefix(publicPackage.initKey.length) + publicPackage.initKey.length
  const end =
    encoded.length -
    1 -
    vectorPrefix(publicPackage.signature.length) -
    publicPackage.signature.length
  expect(leafBytes(group.state, { nodeType: 1, leaf: publicPackage.leafNode })).toEqual(
    encoded.subarray(start, end),
  )
})
