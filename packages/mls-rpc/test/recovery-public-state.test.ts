import { randomIdentity } from '@kokuin/token'
import { type ClientState, createGroup, decodeClientState, encodeClientState } from '@kumiai/mls'
import {
  createGroupInfoWithExternalPubAndRatchetTree,
  defaultExtensionTypes,
  defaultProposalTypes,
  encode,
  generateKeyPackage,
  keyPackageEncoder,
  mlsMessageEncoder,
  wireformats,
} from 'ts-mls'
import { expect, test } from 'vitest'

import { leafBytes, offeredTree, publicTreeBytes } from '../src/recovery-public-state.js'

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
