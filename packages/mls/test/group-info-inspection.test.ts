import { randomIdentity } from '@kokuin/token'
import {
  createGroupInfoWithExternalPubAndRatchetTree,
  decode,
  encode,
  type MlsGroupInfo,
  mlsMessageDecoder,
  mlsMessageEncoder,
  protocolVersions,
  wireformats,
} from 'ts-mls'
import { expect, test, vi } from 'vitest'

import * as mls from '../src/index.js'
import { readRecoveryPublicTree, recoveryTreeHash } from '../src/recovery-absence.js'
import { timedBinding } from './fixtures/lifecycle-pipeline.js'
import { captureFixture } from './fixtures/recovery-capture.js'

test.each([true, false])(
  'public GroupInfo inspection never constructs a candidate (standard=%s)',
  async (standard) => {
    const fixture = await captureFixture({ standard })
    const { groupInfo } = await mls.exportGroupInfo({ group: fixture.group })
    const state = structuredClone(fixture.group.state)
    const sign = vi
      .spyOn(fixture.group.context.cipherSuite.signature, 'sign')
      .mockRejectedValue(new Error('inspection must not sign'))
    const kem = vi
      .spyOn(fixture.group.context.cipherSuite.hpke, 'generateKeyPair')
      .mockRejectedValue(new Error('inspection must not generate keys'))
    try {
      expect(
        await mls.inspectRecoveryGroupInfo({
          groupInfo,
          identity: fixture.identity,
          credential: fixture.group.credential,
          controller: fixture.trust.binding ?? undefined,
          ledgerEntries: fixture.group.ledgerTokens,
          options: {
            cryptoProvider: { getCiphersuiteImpl: async () => fixture.group.context.cipherSuite },
          },
        }),
      ).toEqual({ groupID: fixture.group.groupID, epoch: Number(fixture.group.epoch) })
      expect(sign).not.toHaveBeenCalled()
      expect(kem).not.toHaveBeenCalled()
      expect(fixture.group.state).toEqual(state)
    } finally {
      sign.mockRestore()
      kem.mockRestore()
    }
  },
)

function concat(parts: Array<Uint8Array>): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => [...part]))
}
function vector(bytes: Uint8Array): Uint8Array {
  const length = bytes.length
  if (length < 64) return concat([new Uint8Array([length]), bytes])
  if (length < 16384) return concat([new Uint8Array([0x40 | (length >>> 8), length & 255]), bytes])
  const prefix = new Uint8Array(4)
  new DataView(prefix.buffer).setUint32(0, length | 0x80000000)
  return concat([prefix, bytes])
}
async function resign(fixture: Awaited<ReturnType<typeof captureFixture>>, info: MlsGroupInfo) {
  const unsigned = encode(mlsMessageEncoder, {
    ...info,
    groupInfo: { ...info.groupInfo, signature: new Uint8Array() },
  }).subarray(4, -1)
  info.groupInfo.signature = await fixture.group.context.cipherSuite.signature.sign(
    fixture.identity.privateKey,
    concat([vector(new TextEncoder().encode('MLS 1.0 GroupInfoTBS')), vector(unsigned)]),
  )
  return encode(mlsMessageEncoder, info)
}

test.each([
  'tree-hash',
  'leaf-signature',
  'credential',
  'parent-hash',
  'duplicate-key',
  'capabilities',
] as const)('public GroupInfo inspection rejects a member-signed invalid %s', async (fault) => {
  const fixture = await captureFixture({ standard: true })
  // A second member creates parent hashes and a key-package leaf.
  const bob = randomIdentity()
  const invite = await mls.createInvite({
    group: fixture.group,
    identity: fixture.identity,
    recipientDID: bob.id,
    permission: 'member',
  })
  const bundle = await mls.createKeyPackageBundle(bob)
  const added = await mls.commitInvite(fixture.group, bundle.publicPackage, invite.invite)
  fixture.group = added.newGroup
  const state = structuredClone(fixture.group.state)
  const own = state.ratchetTree[0]
  const other = state.ratchetTree[2]
  const parent = state.ratchetTree[1]
  if (own?.nodeType !== 1 || other?.nodeType !== 1 || parent?.nodeType !== 2)
    throw new Error('Missing tree')
  if (fault === 'leaf-signature') own.leaf.signature = new Uint8Array(64)
  if (fault === 'credential')
    own.leaf.credential = {
      credentialType: 1,
      identity: new TextEncoder().encode(JSON.stringify({ v: 1, id: bob.id })),
    }
  if (fault === 'parent-hash') parent.parent.parentHash = new Uint8Array(32)
  if (fault === 'duplicate-key') other.leaf.hpkePublicKey = own.leaf.hpkePublicKey.slice()
  if (fault === 'capabilities') own.leaf.capabilities.credentials = []
  const message: MlsGroupInfo = {
    version: protocolVersions.mls10,
    wireformat: wireformats.mls_group_info,
    groupInfo: await createGroupInfoWithExternalPubAndRatchetTree(
      state,
      [],
      fixture.group.context.cipherSuite,
    ),
  }
  // Re-sign the changed leaf so its credential and capabilities are independent guards.
  if (fault === 'credential' || fault === 'capabilities') {
    const body = readRecoveryPublicTree(message).bodies[0]
    if (body === undefined) throw new Error('Missing leaf body')
    const groupID = message.groupInfo.groupContext.groupId
    const tbs = concat([
      body.subarray(1, -vector(own.leaf.signature).length),
      vector(groupID),
      new Uint8Array(4),
    ])
    own.leaf.signature = await fixture.group.context.cipherSuite.signature.sign(
      fixture.identity.privateKey,
      concat([vector(new TextEncoder().encode('MLS 1.0 LeafNodeTBS')), vector(tbs)]),
    )
    message.groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(
      state,
      [],
      fixture.group.context.cipherSuite,
    )
  }
  if (fault !== 'tree-hash')
    message.groupInfo.groupContext.treeHash = await recoveryTreeHash(
      readRecoveryPublicTree(message).bodies,
      fixture.group.context.cipherSuite,
    )
  else message.groupInfo.groupContext.treeHash = new Uint8Array(32)
  await expect(
    mls.inspectRecoveryGroupInfo({
      groupInfo: await resign(fixture, message),
      identity: fixture.identity,
      credential: fixture.group.credential,
    }),
  ).rejects.toThrow()
})

test('public GroupInfo inspection checks replacement binding and authenticated ledger', async () => {
  const fixture = await captureFixture()
  const { groupInfo } = await mls.exportGroupInfo({ group: fixture.group })
  const params = {
    groupInfo,
    identity: fixture.identity,
    credential: fixture.group.credential,
    ledgerEntries: [],
  }
  await expect(mls.inspectRecoveryGroupInfo(params)).rejects.toMatchObject({
    reason: 'floating-refused',
  })
  const timestamp = Math.floor(Date.now() / 1000)
  const older = await timedBinding({
    identity: fixture.identity,
    iat: timestamp - 100,
    exp: timestamp + 1000,
  })
  await expect(
    mls.inspectRecoveryGroupInfo({ ...params, controller: older }),
  ).rejects.toMatchObject({ reason: 'renewal-order' })
  await expect(
    mls.inspectRecoveryGroupInfo({
      ...params,
      controller: fixture.trust.binding ?? undefined,
      ledgerEntries: ['unbound-ledger'],
    }),
  ).rejects.toThrow()
})

test('public GroupInfo inspection preserves signature and hash provider failures', async () => {
  const fixture = await captureFixture({ standard: true })
  const { groupInfo } = await mls.exportGroupInfo({ group: fixture.group })
  const message = decode(mlsMessageDecoder, groupInfo)
  expect(message?.wireformat).toBe(wireformats.mls_group_info)
  const params = {
    groupInfo,
    identity: fixture.identity,
    credential: fixture.group.credential,
    options: {
      cryptoProvider: { getCiphersuiteImpl: async () => fixture.group.context.cipherSuite },
    },
  }
  for (const method of ['verify', 'digest'] as const) {
    const error = new Error(`local ${method} failure`)
    const failing =
      method === 'verify'
        ? vi.spyOn(fixture.group.context.cipherSuite.signature, 'verify').mockRejectedValue(error)
        : vi.spyOn(fixture.group.context.cipherSuite.hash, 'digest').mockRejectedValue(error)
    try {
      await expect(mls.inspectRecoveryGroupInfo(params)).rejects.toBe(error)
    } finally {
      failing.mockRestore()
    }
  }
})

test('public GroupInfo inspection refuses a different group, signature, or replacement identity', async () => {
  const fixture = await captureFixture({ standard: true })
  const { groupInfo } = await mls.exportGroupInfo({ group: fixture.group })
  const params = { groupInfo, identity: fixture.identity, credential: fixture.group.credential }
  await expect(
    mls.inspectRecoveryGroupInfo({
      ...params,
      credential: { ...params.credential, groupID: 'another-group' },
    }),
  ).rejects.toThrow()
  const altered = groupInfo.slice()
  altered[altered.length - 1] = (altered.at(-1) ?? 0) ^ 1
  await expect(mls.inspectRecoveryGroupInfo({ ...params, groupInfo: altered })).rejects.toThrow()
  const stranger = randomIdentity()
  await expect(
    mls.inspectRecoveryGroupInfo({
      ...params,
      identity: stranger,
      credential: { ...params.credential, id: stranger.id },
    }),
  ).rejects.toThrow()
})
