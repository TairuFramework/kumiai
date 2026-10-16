import {
  createIdentity,
  encodeMultibase,
  type OwnIdentity,
  randomIdentity,
  stringifyToken,
} from '@kokuin/token'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromB64U, toB64U } from '@sozai/codec'
import {
  createGroupInfoWithExternalPubAndRatchetTree,
  decode,
  defaultExtensionTypes,
  encode,
  mlsMessageDecoder,
  mlsMessageEncoder,
  wireformats,
} from 'ts-mls'
import { expect, test, vi } from 'vitest'

import * as mls from '../src/index.js'
import { openSealedReply, type SealedReplyKind, sealToRequest } from '../src/recovery.js'
import { timedBinding } from './fixtures/lifecycle-pipeline.js'

const utf8 = new TextEncoder()
const kind: SealedReplyKind = {
  hpkeInfo: utf8.encode('kumiai/mls/recovery-roster/v1'),
  aadDomain: utf8.encode('kumiai/mls/recovery-roster-aad/v1'),
  version: 1,
  fail: (_reason, message) => new Error(message),
}

function join(parts: Array<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, bytes) => size + bytes.length, 0))
  let offset = 0
  for (const bytes of parts) {
    out.set(bytes, offset)
    offset += bytes.length
  }
  return out
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value)
  return out
}

function lp(bytes: Uint8Array): Uint8Array {
  return join([u32(bytes.length), bytes])
}

function checkpoints(frames: Array<Uint8Array>): Uint8Array {
  return join([u32(frames.length), ...frames.map(lp)])
}

function split(bytes: Uint8Array): {
  token: string
  groupInfo: Uint8Array
  ledger: Uint8Array
  lineage: Uint8Array
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  const field = () => {
    const size = view.getUint32(offset)
    offset += 4
    const out = bytes.slice(offset, offset + size)
    offset += size
    return out
  }
  const token = new TextDecoder().decode(field())
  const groupInfo = field()
  const ledger = field()
  return { token, groupInfo, ledger, lineage: bytes.slice(offset) }
}

function trustFor(group: mls.GroupHandle): mls.RecoveryTrustInputs {
  const anchor = mls.readGroupAnchorExtension(group)?.extensionData
  if (!(anchor instanceof Uint8Array)) throw new Error('Missing anchor')
  return {
    groupID: group.groupID,
    genesisAnchor: anchor.slice(),
    signerTree: structuredClone(group.state.ratchetTree),
    registry: structuredClone(group.registry),
    credential: { ...group.credential },
    binding: null,
    ledger: group.ledgerTokens,
    ciphersuiteName: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
  }
}

function installed(group: mls.GroupHandle, identity: OwnIdentity, parentAuthHash: string | null) {
  const anchor = mls.readGroupAnchorExtension(group)?.extensionData
  if (!(anchor instanceof Uint8Array)) throw new Error('Missing anchor')
  const epoch = Number(group.epoch)
  const genesisHash = mls.checkpointGenesisHash(anchor)
  const authHash = mls.checkpointAuthHash({
    groupID: group.groupID,
    genesisHash,
    epoch,
    epochAuthenticator: group.state.keySchedule.epochAuthenticator,
  })
  const body: mls.EpochCheckpointBodyV1 = {
    v: 1,
    type: 'kumiai/checkpoint/v1',
    groupID: group.groupID,
    genesisHash,
    ciphersuite: group.context.cipherSuite.id,
    epoch,
    authHash,
    parentAuthHash,
    keyHash: mls.checkpointKeyHash(identity.publicKey),
    leafIndex: group.state.privatePath.leafIndex,
  }
  const fact: mls.EpochRosterFactV1 = {
    v: 1,
    key: { groupID: group.groupID, incarnation: 1 },
    genesisHash,
    ciphersuite: body.ciphersuite,
    epoch,
    authHash,
    parentAuthHash,
    confirmedTranscriptHash: toB64U(group.state.groupContext.confirmedTranscriptHash),
    members: group.state.ratchetTree.flatMap((node, index) => {
      if (node?.nodeType !== 1) return []
      const signerDID = mls.didFromCredential(node.leaf.credential)
      if (signerDID === null) throw new Error('Missing member DID')
      return [
        {
          signerDID,
          keyHash: mls.checkpointKeyHash(node.leaf.signaturePublicKey),
          signaturePublicKey: toB64U(node.leaf.signaturePublicKey),
          leafIndex: index / 2,
        },
      ]
    }),
    installation: { mutationID: `installed-${epoch}`, stateVersion: epoch + 1 },
  }
  return {
    body,
    fact: mls.encodeEpochRosterFact(fact),
    frame: mls.encodeEpochCheckpoint(
      body,
      ed25519.sign(mls.checkpointSignatureInput(body), identity.privateKey),
    ),
  }
}

async function fixture(requester = randomIdentity(), identity = randomIdentity()) {
  let group = (await mls.createGroup(identity, `absence-${crypto.randomUUID()}`)).group
  const history = [installed(group, identity, null)]
  const bundle = await mls.createKeyPackageBundle(requester)
  const { invite } = await mls.createInvite({
    group,
    identity,
    recipientDID: requester.id,
    permission: 'member',
  })
  const added = await mls.commitInvite(group, bundle.publicPackage, invite)
  group = added.newGroup
  const joined = await mls.processWelcome({
    identity: requester,
    invite,
    welcome: added.welcomeMessage,
    keyPackageBundle: bundle,
  })
  const trust = trustFor(joined.group)
  history.push(installed(group, identity, history.at(-1)?.body.authHash ?? null))
  const index = group.findMemberLeafIndex(requester.id)
  if (index === undefined) throw new Error('Missing requester')
  const beforeRemoval = group
  group = (await mls.removeMember(group, index)).newGroup
  history.push(installed(group, identity, history.at(-1)?.body.authHash ?? null))
  const held = await mls.createRecoveryRequestFromTrust({
    trust,
    identity: requester,
    requestID: 'absent',
    comparisonEpoch: 1,
  })
  const seal = (changes: Partial<Parameters<typeof mls.sealRosterAbsenceReply>[0]> = {}) =>
    mls.sealRosterAbsenceReply({
      group,
      identity,
      request: held.request,
      captureHead: 'captured-head',
      retainedRosterFacts: history.map((entry) => entry.fact),
      lineage: history.map((entry) => entry.frame),
      ...changes,
    })
  const verify = (
    evidence: Uint8Array,
    changes: Partial<Parameters<typeof mls.verifyRosterAbsence>[0]> = {},
  ) =>
    mls.verifyRosterAbsence({
      trust,
      requestID: 'absent',
      requestKey: held.requestKey,
      evidence,
      options: {},
      ...changes,
    })
  return {
    identity,
    requester,
    group,
    beforeRemoval,
    joined: joined.group,
    trust,
    held,
    history,
    seal,
    verify,
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

async function plaintext(s: Fixture, evidence: Uint8Array) {
  return await openSealedReply({
    kind,
    group: { groupID: s.group.groupID, context: s.group.context, credential: s.trust.credential },
    sealed: evidence,
    requestID: 'absent',
    ephemeralPrivateKey: s.held.requestKey,
  })
}

async function rewrite(
  s: Fixture,
  evidence: Uint8Array,
  edit: (parts: ReturnType<typeof split>, payload: Record<string, unknown>) => void,
) {
  const parts = split(await plaintext(s, evidence))
  const payload = JSON.parse(
    Buffer.from(parts.token.split('.')[1] as string, 'base64url').toString(),
  ) as Record<string, unknown>
  edit(parts, payload)
  parts.token = stringifyToken(await s.identity.signToken(payload, { embedLongForm: true }))
  return await sealToRequest({
    kind,
    group: s.group,
    request: s.held.request,
    requireMember: false,
    plaintext: join([
      lp(utf8.encode(parts.token)),
      lp(parts.groupInfo),
      lp(parts.ledger),
      parts.lineage,
    ]),
  })
}

async function attestGroup(s: Fixture, group: mls.GroupHandle, lineage: Array<Uint8Array>) {
  const evidence = await s.seal()
  if (evidence === null) throw new Error('Missing original proof')
  const { groupInfo } = await mls.exportGroupInfo({ group })
  const info = decode(mlsMessageDecoder, groupInfo)
  if (info?.wireformat !== wireformats.mls_group_info) throw new Error('Missing GroupInfo')
  const tree = info.groupInfo.extensions.find(
    (entry) => entry.extensionType === defaultExtensionTypes.ratchet_tree,
  )?.extensionData
  if (!(tree instanceof Uint8Array)) throw new Error('Missing tree')
  return await rewrite(s, evidence, (parts, payload) => {
    parts.groupInfo = groupInfo
    parts.ledger = join([
      u32(group.ledgerTokens.length),
      ...group.ledgerTokens.map((token) => lp(utf8.encode(token))),
    ])
    parts.lineage = checkpoints(lineage)
    payload.groupInfoDigest = encodeMultibase(sha256(groupInfo))
    payload.treeDigest = encodeMultibase(sha256(tree))
    payload.ledgerDigest = encodeMultibase(sha256(parts.ledger))
    payload.lineageDigest = encodeMultibase(sha256(parts.lineage))
    payload.groupInfoAuthenticator = toB64U(group.state.keySchedule.epochAuthenticator)
  })
}

test('retained former member receives request bound public roster', async () => {
  const s = await fixture()
  const evidence = await s.seal()
  expect(evidence).not.toBeNull()
  if (evidence === null) throw new Error('Missing roster')
  expect(await s.verify(evidence)).toMatchObject({
    groupID: s.group.groupID,
    requesterDID: s.requester.id,
    requestID: 'absent',
    epoch: 2,
    captureHead: 'captured-head',
    responderDID: s.identity.id,
    responderKeyHash: mls.checkpointKeyHash(s.identity.publicKey),
    confirmedTranscriptHash: toB64U(s.group.state.groupContext.confirmedTranscriptHash),
    groupInfoAuthenticator: s.group.state.keySchedule.epochAuthenticator,
    lineage: s.history.slice(1).map(({ body }) => ({ epoch: body.epoch, authHash: body.authHash })),
    evidence,
  })
  await expect(
    mls.sealCapturedGroupInfo({
      group: s.group,
      identity: s.identity,
      request: s.held.request,
      captureHead: null,
    }),
  ).rejects.toMatchObject({ reason: 'not-a-member' })
})

test('never seen requester receives no roster reply', async () => {
  const requester = await createIdentity({
    keys: [
      { purpose: 'sig', alg: 'EdDSA' },
      { purpose: 'sig', alg: 'EdDSA' },
    ],
  })
  const s = await fixture(requester)
  const other = randomIdentity()
  const held = await mls.createRecoveryRequest({
    group: {
      groupID: s.group.groupID,
      context: s.group.context,
      credential: { ...s.trust.credential, id: other.id },
    },
    identity: other,
    requestID: 'stranger',
    comparisonEpoch: 1,
  })
  expect(await s.seal({ request: held.request })).toBeNull()
  const second = requester.keys[1]
  if (second === undefined) throw new Error('Missing second signing key')
  const unseenKey = {
    ...requester,
    publicKey: second.publicKey,
    signToken: <Payload extends Record<string, unknown>>(payload: Payload) =>
      requester.signToken(payload, { kid: second.fragment, embedLongForm: true }),
  }
  const changed = await mls.createRecoveryRequest({
    group: s.joined,
    identity: unseenKey,
    requestID: 'same-DID',
    comparisonEpoch: 1,
  })
  expect(await s.seal({ request: changed.request })).toBeNull()
})

test('retained signer eligibility resolves the verified key among a DID multiple leaves', async () => {
  const identity = await createIdentity({
    keys: [
      { purpose: 'sig', alg: 'EdDSA' },
      { purpose: 'sig', alg: 'EdDSA' },
    ],
  })
  const s = await fixture(randomIdentity(), identity)
  const second = identity.keys[1]
  if (second === undefined) throw new Error('Missing secondary key')
  const alternate = {
    ...identity,
    publicKey: second.publicKey,
    privateKey: second.privateKey,
    signToken: <Payload extends Record<string, unknown>>(payload: Payload) =>
      identity.signToken(payload, { kid: second.fragment, embedLongForm: true }),
  }
  const now = Math.floor(Date.now() / 1000)
  const bundle = await mls.createKeyPackageBundle(alternate, {
    controller: await timedBinding({ identity: alternate, iat: now, exp: now + 3600 }),
  })
  const { invite } = await mls.createInvite({
    group: s.beforeRemoval,
    identity,
    recipientDID: identity.id,
    permission: 'admin',
  })
  const added = await mls.commitInvite(s.beforeRemoval, bundle.publicPackage, invite)
  const joined = await mls.processWelcome({
    identity: alternate,
    invite,
    welcome: added.welcomeMessage,
    keyPackageBundle: bundle,
  })
  const state = mls.decodeClientState(mls.encodeClientState(s.joined.state))
  if (state === undefined) throw new Error('Missing requester state')
  const bodies = new Map(
    added.newGroup.ledgerTokens.map((token) => [mls.ledgerEntryDigest(token), token]),
  )
  const requester = await mls.restoreGroup({
    state,
    credential: s.joined.credential,
    ledgerEntries: s.joined.ledgerTokens,
    options: {
      resolveLedgerEntries: async (ids) =>
        ids.map((id) => {
          const token = bodies.get(id)
          if (token === undefined) throw new Error('Missing ledger body')
          return token
        }),
    },
  })
  await requester.processMessage(added.commitMessage)
  const trust = trustFor(requester)
  const index = added.newGroup.findMemberLeafIndex(s.requester.id)
  if (index === undefined) throw new Error('Missing requester')
  const before = installed(joined.group, alternate, null)
  const removed = await mls.removeMember(added.newGroup, index)
  await joined.group.processMessage(removed.commitMessage)
  const current = installed(joined.group, alternate, before.body.authHash)
  const request = await mls.createRecoveryRequestFromTrust({
    trust,
    identity: s.requester,
    requestID: 'absent',
    comparisonEpoch: 2,
  })
  const evidence = await s.seal({
    group: joined.group,
    identity: alternate,
    request: request.request,
    retainedRosterFacts: [before.fact, current.fact],
    lineage: [before.frame, current.frame],
  })
  if (evidence === null) throw new Error('Missing secondary-key reply')
  const original = structuredClone(trust.signerTree)
  const proof = await s.verify(evidence, { trust, requestKey: request.requestKey })
  expect(proof).not.toBeNull()
  expect(proof?.responderDID).toBe(identity.id)
  expect(proof?.responderKeyHash).toBe(mls.checkpointKeyHash(second.publicKey))
  expect(trust.signerTree).toEqual(original)
  const invalid = structuredClone(trust.signerTree)
  const secondary = invalid.find(
    (node) =>
      node?.nodeType === 1 &&
      node.leaf.signaturePublicKey.every((byte, index) => byte === second.publicKey[index]),
  )
  if (secondary?.nodeType !== 1 || !('identity' in secondary.leaf.credential))
    throw new Error('Missing secondary leaf')
  const credential = mls.parseMLSCredentialIdentity(secondary.leaf.credential.identity)
  if (credential.controller === undefined) throw new Error('Missing secondary binding')
  credential.controller.capability = 'invalid'
  secondary.leaf.credential = {
    ...secondary.leaf.credential,
    identity: utf8.encode(JSON.stringify(credential)),
  }
  expect(
    await s.verify(evidence, {
      trust: { ...trust, signerTree: invalid },
      requestKey: request.requestKey,
    }),
  ).toBeNull()
})

test('expired requester history cannot authorise disclosure', async () => {
  const s = await fixture()
  // Notice summaries are deliberately absent from the authority inputs after fact pruning.
  expect(await s.seal({ retainedRosterFacts: [s.history[2]?.fact ?? new Uint8Array()] })).toBeNull()
  expect(await s.seal({ retainedRosterFacts: [] })).toBeNull()
})

test.each(['DID', 'key', 'group', 'genesis', 'suite', 'current', 'future'] as const)(
  'retained fact binding scopes disclosure: %s',
  async (field) => {
    const s = await fixture()
    const fact = mls.decodeEpochRosterFact(s.history[1]?.fact ?? new Uint8Array())
    const member = fact.members.find((member) => member.signerDID === s.requester.id)
    if (member === undefined) throw new Error('Missing former member')
    if (field === 'DID') member.signerDID = randomIdentity().id
    if (field === 'key') {
      const other = randomIdentity()
      member.signaturePublicKey = toB64U(other.publicKey)
      member.keyHash = mls.checkpointKeyHash(other.publicKey)
    }
    if (field === 'group') fact.key.groupID = 'other'
    if (field === 'genesis') fact.genesisHash = toB64U(new Uint8Array(32))
    if (field === 'suite') fact.ciphersuite = 3
    if (field === 'current') fact.epoch = 2
    if (field === 'future') fact.epoch = 3
    expect(await s.seal({ retainedRosterFacts: [mls.encodeEpochRosterFact(fact)] })).toBeNull()
  },
)

test.each([
  'type',
  'groupID',
  'requestID',
  'request',
  'captureHead',
  'groupInfoAuthenticator',
  'groupInfoDigest',
  'treeDigest',
  'ledgerDigest',
  'lineageDigest',
])('absence proof binds exact request head ledger and lineage: %s', async (field) => {
  const s = await fixture()
  const evidence = await s.seal()
  if (evidence === null) throw new Error('Missing roster')
  expect(
    await s.verify(
      await rewrite(s, evidence, (_parts, payload) => {
        payload[field] = field === 'captureHead' ? '' : 'substituted'
      }),
    ),
  ).toBeNull()
})

test.each(['groupInfo', 'ledger', 'lineage'] as const)(
  'absence proof binds delivered %s bytes',
  async (field) => {
    const s = await fixture()
    const evidence = await s.seal()
    if (evidence === null) throw new Error('Missing roster')
    expect(
      await s.verify(
        await rewrite(s, evidence, (parts) => {
          parts[field][parts[field].length - 1] = (parts[field][parts[field].length - 1] ?? 0) ^ 1
        }),
      ),
    ).toBeNull()
  },
)

test('roster reply discloses only current public state', async () => {
  const s = await fixture()
  const evidence = await s.seal()
  if (evidence === null) throw new Error('Missing roster')
  const bytes = await plaintext(s, evidence)
  const parts = split(bytes)
  const info = decode(mlsMessageDecoder, parts.groupInfo)
  expect(info?.wireformat).toBe(wireformats.mls_group_info)
  for (const secret of [
    s.group.state.signaturePrivateKey,
    s.group.state.keySchedule.exporterSecret,
    s.group.state.keySchedule.initSecret,
    ...s.history.map(({ fact }) => fact),
  ]) {
    expect(Buffer.from(bytes).includes(Buffer.from(secret))).toBe(false)
  }
  expect(new TextDecoder().decode(bytes)).not.toContain('privatePath')
  expect(new TextDecoder().decode(bytes)).not.toContain('message plaintext')
  expect(await s.verify(join([evidence, new Uint8Array([0])]))).toBeNull()
  expect(
    await s.verify(
      await sealToRequest({
        kind,
        group: s.group,
        request: s.held.request,
        requireMember: false,
        plaintext: join([bytes, new Uint8Array([0])]),
      }),
    ),
  ).toBeNull()
})

test('roster reply cannot cross recovery domains', async () => {
  const s = await fixture()
  const evidence = await s.seal()
  if (evidence === null) throw new Error('Missing roster')
  expect(
    await mls.authenticateRecoveryReply({
      trust: s.trust,
      sealed: evidence,
      requestID: 'absent',
      requestKey: s.held.requestKey,
      options: {},
    }),
  ).toBeNull()
  await expect(
    mls.openRecoveryVerdictFromTrust({
      trust: s.trust,
      sealed: evidence,
      requestID: 'absent',
      requestKey: s.held.requestKey,
      options: {},
    }),
  ).rejects.toThrow()
  await expect(
    mls.openSealedLedger({
      group: s.joined,
      sealed: evidence,
      requestID: 'absent',
      ephemeralPrivateKey: s.held.requestKey,
    }),
  ).rejects.toThrow()
  const ordinary = await mls.sealCapturedGroupInfo({
    group: s.joined,
    identity: s.requester,
    request: s.held.request,
    captureHead: null,
  })
  expect(await s.verify(ordinary)).toBeNull()
  const ledger = await mls.sealLedger({ group: s.joined, request: s.held.request })
  expect(await s.verify(ledger)).toBeNull()
})

test('present DID with a changed leaf is not absent', async () => {
  const s = await fixture()
  expect(await s.seal({ group: s.beforeRemoval })).toBeNull()
  const rotation = await mls.commitKeyRotation(s.joined)
  await s.beforeRemoval.processMessage(rotation.commitMessage)
  const present = s.beforeRemoval
  const fact = s.history[1]
  if (fact === undefined) throw new Error('Missing retained roster')
  const current = installed(present, s.identity, fact.body.authHash)
  expect(await s.seal({ group: present, lineage: [fact.frame, current.frame] })).toBeNull()
})

test('a signed incorrect public tree hash cannot be replaced by an attestation', async () => {
  const s = await fixture()
  const evidence = await s.seal()
  if (evidence === null) throw new Error('Missing roster')
  const state = {
    ...s.group.state,
    groupContext: { ...s.group.state.groupContext, treeHash: new Uint8Array(32) },
  }
  const groupInfo = encode(mlsMessageEncoder, {
    version: 1,
    wireformat: wireformats.mls_group_info,
    groupInfo: await createGroupInfoWithExternalPubAndRatchetTree(
      state,
      [],
      s.group.context.cipherSuite,
    ),
  })
  expect(
    await s.verify(
      await rewrite(s, evidence, (parts, payload) => {
        parts.groupInfo = groupInfo
        payload.groupInfoDigest = encodeMultibase(sha256(groupInfo))
      }),
    ),
  ).toBeNull()
})

test('verified public tree with our DID present cannot establish absence', async () => {
  const s = await fixture()
  const evidence = await s.seal()
  if (evidence === null) throw new Error('Missing roster')
  const { groupInfo } = await mls.exportGroupInfo({ group: s.beforeRemoval })
  const info = decode(mlsMessageDecoder, groupInfo)
  if (info?.wireformat !== wireformats.mls_group_info) throw new Error('Missing public tree')
  const tree = info.groupInfo.extensions.find(
    (entry) => entry.extensionType === defaultExtensionTypes.ratchet_tree,
  )?.extensionData
  if (!(tree instanceof Uint8Array)) throw new Error('Missing tree')
  const changed = await rewrite(s, evidence, (parts, payload) => {
    parts.groupInfo = groupInfo
    parts.lineage = checkpoints([s.history[1]?.frame ?? new Uint8Array()])
    payload.groupInfoDigest = encodeMultibase(sha256(groupInfo))
    payload.treeDigest = encodeMultibase(sha256(tree))
    payload.lineageDigest = encodeMultibase(sha256(parts.lineage))
    payload.groupInfoAuthenticator = toB64U(s.beforeRemoval.state.keySchedule.epochAuthenticator)
  })
  expect(await s.verify(changed)).toBeNull()
})

test.each(['signature', 'group', 'missing head', 'duplicate head'] as const)(
  'complete ledger verification refuses coherent %s substitution',
  async (fault) => {
    const s = await fixture()
    const evidence = await s.seal()
    if (evidence === null) throw new Error('Missing roster')
    let token = await mls.signLedgerEntry(s.identity, {
      type: 'kumiai.role',
      groupID: fault === 'group' ? 'other' : s.group.groupID,
      subject: s.requester.id,
      value: 'member',
    })
    if (fault === 'signature') {
      const pieces = token.split('.')
      const signature = fromB64U(pieces[2] as string)
      signature[0] = (signature[0] ?? 0) ^ 1
      pieces[2] = toB64U(signature)
      token = pieces.join('.')
    }
    const ledger = join([u32(1), lp(utf8.encode(token))])
    const extension = mls.buildLedgerHeadExtension(
      mls.computeHead(s.group.groupID, [mls.ledgerEntryDigest(token)]),
    )
    const state = {
      ...s.group.state,
      groupContext: {
        ...s.group.state.groupContext,
        extensions: [
          ...s.group.state.groupContext.extensions.filter(
            (entry) => entry.extensionType !== mls.LEDGER_HEAD_EXTENSION_TYPE,
          ),
          ...(fault === 'missing head'
            ? []
            : fault === 'duplicate head'
              ? [extension, extension]
              : [extension]),
        ],
      },
    }
    const groupInfo = encode(mlsMessageEncoder, {
      version: 1,
      wireformat: wireformats.mls_group_info,
      groupInfo: await createGroupInfoWithExternalPubAndRatchetTree(
        state,
        [],
        s.group.context.cipherSuite,
      ),
    })
    expect(
      await s.verify(
        await rewrite(s, evidence, (parts, payload) => {
          parts.groupInfo = groupInfo
          parts.ledger = ledger
          payload.groupInfoDigest = encodeMultibase(sha256(groupInfo))
          payload.ledgerDigest = encodeMultibase(sha256(ledger))
        }),
      ),
    ).toBeNull()
  },
)

test('strict lineage signatures reject ZIP215 identity points', async () => {
  const s = await fixture()
  const point = new Uint8Array(32)
  point[0] = 1
  const signature = new Uint8Array(64)
  signature[0] = 1
  const body = {
    ...s.history[2]?.body,
    keyHash: mls.checkpointKeyHash(point),
  } as mls.EpochCheckpointBodyV1
  expect(
    ed25519.verify(signature, mls.checkpointSignatureInput(body), point, { zip215: true }),
  ).toBe(true)
  expect(
    await s.seal({
      identity: { ...s.identity, publicKey: point },
      lineage: [mls.encodeEpochCheckpoint(body, signature)],
    }),
  ).toBeNull()
})

test.each([
  'empty',
  'count',
  'oversized frame',
  'trailing',
  'truncated',
  'older than comparison',
] as const)('roster checkpoint framing rejects %s', async (fault) => {
  const s = await fixture()
  const evidence = await s.seal()
  if (evidence === null) throw new Error('Missing roster')
  expect(
    await s.verify(
      await rewrite(s, evidence, (parts, payload) => {
        if (fault === 'empty') parts.lineage = u32(0)
        if (fault === 'count')
          parts.lineage = checkpoints(
            Array.from({ length: 257 }, () => s.history[2]?.frame ?? new Uint8Array()),
          )
        if (fault === 'oversized frame') parts.lineage = checkpoints([new Uint8Array(4097)])
        if (fault === 'trailing') parts.lineage = join([parts.lineage, new Uint8Array([0])])
        if (fault === 'truncated') parts.lineage = parts.lineage.subarray(0, -1)
        if (fault === 'older than comparison')
          parts.lineage = checkpoints(s.history.map(({ frame }) => frame))
        payload.lineageDigest = encodeMultibase(sha256(parts.lineage))
      }),
    ),
  ).toBeNull()
})

test('reply never signs a new checkpoint when the offered frame is unavailable', async () => {
  const s = await fixture()
  const sign = vi.spyOn(s.identity, 'signToken')
  expect(await s.seal({ lineage: s.history.slice(0, 2).map(({ frame }) => frame) })).toBeNull()
  expect(sign).not.toHaveBeenCalled()
})

test('incomplete local public ledger never discloses truncated history', async () => {
  const s = await fixture()
  const state = mls.decodeClientState(mls.encodeClientState(s.group.state))
  if (state === undefined) throw new Error('Missing current state')
  const incomplete = await mls.restoreGroup({
    state,
    credential: s.group.credential,
    ledgerEntries: [],
  })
  expect(await incomplete.isLedgerComplete()).toBe(false)
  expect(await s.seal({ group: incomplete })).toBeNull()
})

test('roster lineage contains at most 256 signed checkpoints', async () => {
  const s = await fixture()
  const evidence = await s.seal()
  if (evidence === null) throw new Error('Missing roster')
  const finalAuth = mls.checkpointAuthHash({
    groupID: s.group.groupID,
    genesisHash: mls.checkpointGenesisHash(s.trust.genesisAnchor),
    epoch: 257,
    epochAuthenticator: s.group.state.keySchedule.epochAuthenticator,
  })
  let parentAuthHash: string | null = null
  const frames: Array<Uint8Array> = []
  const source = s.history[2]?.body
  if (source === undefined) throw new Error('Missing current checkpoint')
  for (let epoch = 1; epoch <= 257; epoch++) {
    const authHash = epoch === 257 ? finalAuth : toB64U(sha256(utf8.encode(`epoch-${epoch}`)))
    const body = { ...source, epoch, authHash, parentAuthHash }
    frames.push(
      mls.encodeEpochCheckpoint(
        body,
        ed25519.sign(mls.checkpointSignatureInput(body), s.identity.privateKey),
      ),
    )
    parentAuthHash = authHash
  }
  expect(
    await mls.verifyRecoveryLineage({
      trust: s.trust,
      frames,
      signerKeyHash: source.keyHash,
      epoch: 257,
      authHash: finalAuth,
    }),
  ).toBeNull()
  const state = { ...s.group.state, groupContext: { ...s.group.state.groupContext, epoch: 257n } }
  const groupInfo = encode(mlsMessageEncoder, {
    version: 1,
    wireformat: wireformats.mls_group_info,
    groupInfo: await createGroupInfoWithExternalPubAndRatchetTree(
      state,
      [],
      s.group.context.cipherSuite,
    ),
  })
  const reply = await rewrite(s, evidence, (parts, payload) => {
    parts.groupInfo = groupInfo
    parts.lineage = checkpoints(frames)
    payload.groupInfoDigest = encodeMultibase(sha256(groupInfo))
    payload.lineageDigest = encodeMultibase(sha256(parts.lineage))
  })
  expect(reply.byteLength).toBeLessThan(786432)
  expect(await s.verify(reply)).toBeNull()
})

test('roster sealing validates its local identity and preserves signing failures', async () => {
  const s = await fixture()
  await expect(s.seal({ identity: s.requester })).rejects.toThrow('identity mismatch')
  await expect(s.seal({ captureHead: '' })).rejects.toThrow('Invalid capture head')
  const failure = new TypeError('Local signer offline')
  vi.spyOn(s.identity, 'signToken').mockRejectedValue(failure)
  await expect(s.seal()).rejects.toBe(failure)
})

test('refolding the complete public ledger refuses a revoked responder', async () => {
  const s = await fixture()
  const evidence = await s.seal()
  if (evidence === null) throw new Error('Missing roster')
  const tokens = await Promise.all([
    mls.signLedgerEntry(s.identity, {
      type: 'kumiai.device',
      groupID: s.group.groupID,
      subject: s.identity.id,
      value: { op: 'register', controller: s.identity.id },
    }),
    mls.signLedgerEntry(s.identity, {
      type: 'kumiai.device',
      groupID: s.group.groupID,
      subject: s.identity.id,
      value: { op: 'revoke' },
    }),
  ])
  const ledger = join([u32(tokens.length), ...tokens.map((token) => lp(utf8.encode(token)))])
  const state = {
    ...s.group.state,
    groupContext: {
      ...s.group.state.groupContext,
      extensions: [
        ...s.group.state.groupContext.extensions.filter(
          (entry) => entry.extensionType !== mls.LEDGER_HEAD_EXTENSION_TYPE,
        ),
        mls.buildLedgerHeadExtension(
          mls.computeHead(s.group.groupID, tokens.map(mls.ledgerEntryDigest)),
        ),
      ],
    },
  }
  const groupInfo = encode(mlsMessageEncoder, {
    version: 1,
    wireformat: wireformats.mls_group_info,
    groupInfo: await createGroupInfoWithExternalPubAndRatchetTree(
      state,
      [],
      s.group.context.cipherSuite,
    ),
  })
  expect(
    await s.verify(
      await rewrite(s, evidence, (parts, payload) => {
        parts.groupInfo = groupInfo
        parts.ledger = ledger
        payload.groupInfoDigest = encodeMultibase(sha256(groupInfo))
        payload.ledgerDigest = encodeMultibase(sha256(ledger))
      }),
    ),
  ).toBeNull()
})

test.each(['group', 'anchor'] as const)(
  'invalid retained %s binding grants no roster or lineage proof',
  async (field) => {
    const s = await fixture()
    const evidence = await s.seal()
    if (evidence === null) throw new Error('Missing roster')
    const trust =
      field === 'group'
        ? { ...s.trust, groupID: 'other' }
        : { ...s.trust, genesisAnchor: new Uint8Array() }
    await expect(s.verify(evidence, { trust })).resolves.toBeNull()
    await expect(
      mls.verifyRecoveryLineage({
        trust,
        frames: s.history.slice(1).map(({ frame }) => frame),
        signerKeyHash: mls.checkpointKeyHash(s.identity.publicKey),
        epoch: 2,
        authHash: s.history[2]?.body.authHash ?? '',
      }),
    ).resolves.toBeNull()
  },
)

test('provider faults retain error identity', async () => {
  const s = await fixture()
  const evidence = await s.seal()
  if (evidence === null) throw new Error('Missing roster')
  const failure = new Error('Provider offline')
  await expect(
    s.verify(evidence, {
      options: {
        cryptoProvider: {
          async getCiphersuiteImpl() {
            throw failure
          },
        },
      },
    }),
  ).rejects.toBe(failure)
  const provider = {
    async getCiphersuiteImpl(
      name: Parameters<typeof mls.nobleCryptoProvider.getCiphersuiteImpl>[0],
    ) {
      const suite = await mls.nobleCryptoProvider.getCiphersuiteImpl(name)
      return {
        ...suite,
        signature: {
          ...suite.signature,
          async verify() {
            throw failure
          },
        },
      }
    },
  }
  await expect(s.verify(evidence, { options: { cryptoProvider: provider } })).rejects.toBe(failure)
  await expect(s.verify(evidence, { requestKey: new Uint8Array(31) })).rejects.toThrow()
  await expect(
    s.verify(evidence, {
      trust: {
        ...s.trust,
        get registry(): mls.DeviceRegistry {
          throw failure
        },
      },
    }),
  ).rejects.toBe(failure)
})

test.each([
  'parent',
  'signer',
  'group',
  'suite',
  'anchor',
  'authenticator',
  'missing',
  'order',
  'duplicate',
  'signature',
  'epoch gap',
  'key hash',
  'wrong F epoch',
] as const)('lineage cannot be spliced across signers or parents: %s', async (change) => {
  const s = await fixture()
  const frames = s.history.slice(1).map(({ frame }) => frame)
  const last = mls.decodeEpochCheckpoint(frames[1] as Uint8Array)
  const body = { ...last.body }
  let key = s.identity.privateKey
  if (change === 'parent') body.parentAuthHash = toB64U(new Uint8Array(32))
  if (change === 'signer') {
    key = s.requester.privateKey
    body.keyHash = mls.checkpointKeyHash(s.requester.publicKey)
  }
  if (change === 'group') body.groupID = 'other-group'
  if (change === 'suite') body.ciphersuite = 3
  if (change === 'anchor') body.genesisHash = toB64U(new Uint8Array(32))
  if (change === 'authenticator') body.authHash = toB64U(new Uint8Array(32))
  if (change === 'key hash') body.keyHash = mls.checkpointKeyHash(s.requester.publicKey)
  if (change === 'wrong F epoch') body.epoch = 1
  frames[1] = mls.encodeEpochCheckpoint(body, ed25519.sign(mls.checkpointSignatureInput(body), key))
  if (change === 'missing') frames.pop()
  if (change === 'order') frames.reverse()
  if (change === 'duplicate') frames.push(frames[1] as Uint8Array)
  if (change === 'wrong F epoch') frames.splice(0, 1)
  if (change === 'signature')
    (frames[1] as Uint8Array)[(frames[1]?.length ?? 0) - 1] =
      ((frames[1] as Uint8Array)[(frames[1]?.length ?? 0) - 1] ?? 0) ^ 1
  if (change === 'epoch gap') {
    const first = mls.decodeEpochCheckpoint(frames[0] as Uint8Array)
    const body = { ...first.body, epoch: 0 }
    frames[0] = mls.encodeEpochCheckpoint(
      body,
      ed25519.sign(mls.checkpointSignatureInput(body), s.identity.privateKey),
    )
  }
  expect(
    await mls.verifyRecoveryLineage({
      trust: s.trust,
      frames,
      signerKeyHash: mls.checkpointKeyHash(s.identity.publicKey),
      epoch: 2,
      authHash: s.history[2]?.body.authHash ?? '',
    }),
  ).toBeNull()
  const request = await mls.createRecoveryRequest({
    group: s.joined,
    identity: s.requester,
    requestID: 'absent',
    comparisonEpoch: 0,
  })
  expect(await s.seal({ request: request.request, lineage: frames })).toBeNull()
})

test('comparison span is signed and validated', async () => {
  const s = await fixture()
  expect((await mls.verifyRecoveryRequest(s.held.request)).comparisonEpoch).toBe(1)
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    const fields = JSON.parse(
      Buffer.from(s.held.request.split('.')[1] as string, 'base64url').toString(),
    ) as Record<string, unknown>
    fields.comparisonEpoch = value
    const request = stringifyToken(await s.requester.signToken(fields, { embedLongForm: true }))
    await expect(mls.verifyRecoveryRequest(request)).rejects.toMatchObject({ reason: 'malformed' })
  }
  for (const comparisonEpoch of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(
      mls.createRecoveryRequest({
        group: s.joined,
        identity: s.requester,
        requestID: 'invalid',
        comparisonEpoch,
      }),
    ).rejects.toThrow()
  }
  const parts = s.held.request.split('.')
  const fields = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString())
  fields.comparisonEpoch = 0
  parts[1] = Buffer.from(JSON.stringify(fields)).toString('base64url')
  await expect(mls.verifyRecoveryRequest(parts.join('.'))).rejects.toMatchObject({
    reason: 'unverified',
  })
  const legacy = await mls.createRecoveryRequest({
    group: s.joined,
    identity: s.requester,
    requestID: 'legacy',
  })
  expect((await mls.verifyRecoveryRequest(legacy.request)).comparisonEpoch).toBeUndefined()
  expect(await s.seal({ request: legacy.request })).toBeNull()
  const legacyFields = JSON.parse(
    Buffer.from(s.held.request.split('.')[1] as string, 'base64url').toString(),
  ) as Record<string, unknown>
  delete legacyFields.comparisonEpoch
  const legacyRequest = stringifyToken(
    await s.requester.signToken(legacyFields, { embedLongForm: true }),
  )
  const evidence = await s.seal()
  if (evidence === null) throw new Error('Missing roster')
  expect(
    await s.verify(
      await rewrite(s, evidence, (_parts, payload) => {
        payload.request = legacyRequest
      }),
    ),
  ).toBeNull()
  const ahead = await mls.createRecoveryRequest({
    group: s.joined,
    identity: s.requester,
    requestID: 'ahead',
    comparisonEpoch: 3,
  })
  expect(await s.seal({ request: ahead.request })).toBeNull()
})

test('roster authenticators require canonical encoding', async () => {
  const s = await fixture()
  const evidence = await s.seal()
  if (evidence === null) throw new Error('Missing roster')
  expect(
    await s.verify(
      await rewrite(s, evidence, (_parts, payload) => {
        payload.groupInfoAuthenticator = `${payload.groupInfoAuthenticator}=`
      }),
    ),
  ).toBeNull()
})

test.each(['GroupInfo', 'ledger'] as const)(
  'roster %s decoder consumes every delivered byte',
  async (field) => {
    const s = await fixture()
    const evidence = await s.seal()
    if (evidence === null) throw new Error('Missing roster')
    expect(
      await s.verify(
        await rewrite(s, evidence, (parts, payload) => {
          if (field === 'GroupInfo') {
            parts.groupInfo = join([parts.groupInfo, new Uint8Array([0])])
            payload.groupInfoDigest = encodeMultibase(sha256(parts.groupInfo))
          } else {
            parts.ledger = join([parts.ledger, new Uint8Array([0])])
            payload.ledgerDigest = encodeMultibase(sha256(parts.ledger))
          }
        }),
      ),
    ).toBeNull()
  },
)

test.each([
  'tree hash',
  'GroupInfo signature',
  'transcript signature',
  'ledger head',
  'ledger signature',
  'request key',
  'own DID present',
] as const)(
  'public roster authentication rejects a coherently attested %s fault',
  async (fault) => {
    const s = await fixture()
    const evidence = await s.seal()
    if (evidence === null) throw new Error('Missing roster')
    if (fault === 'request key') {
      expect(await s.verify(evidence, { requestKey: new Uint8Array(32).fill(17) })).toBeNull()
      return
    }
    const changed = await rewrite(s, evidence, (parts, payload) => {
      const info = decode(mlsMessageDecoder, parts.groupInfo)
      if (info?.wireformat !== wireformats.mls_group_info) throw new Error('Missing GroupInfo')
      if (fault === 'tree hash')
        info.groupInfo.groupContext.treeHash[0] = (info.groupInfo.groupContext.treeHash[0] ?? 0) ^ 1
      if (fault === 'GroupInfo signature')
        info.groupInfo.signature[0] = (info.groupInfo.signature[0] ?? 0) ^ 1
      if (fault === 'transcript signature')
        info.groupInfo.groupContext.confirmedTranscriptHash[0] =
          (info.groupInfo.groupContext.confirmedTranscriptHash[0] ?? 0) ^ 1
      if (fault === 'ledger head' || fault === 'ledger signature') {
        parts.ledger = new Uint8Array(4)
        payload.ledgerDigest = encodeMultibase(sha256(parts.ledger))
      }
      if (fault === 'own DID present') {
        payload.requesterDID = s.identity.id
      }
      parts.groupInfo = encode(mlsMessageEncoder, info)
      payload.groupInfoDigest = encodeMultibase(sha256(parts.groupInfo))
    })
    expect(await s.verify(changed)).toBeNull()
  },
)

test('large group roster reply fits requested lineage span', async () => {
  const s = await fixture()
  let group = s.group
  for (let index = 0; index < 16; index++) {
    const member = randomIdentity()
    const bundle = await mls.createKeyPackageBundle(member)
    const { invite } = await mls.createInvite({
      group,
      identity: s.identity,
      recipientDID: member.id,
      permission: 'member',
    })
    group = (await mls.commitInvite(group, bundle.publicPackage, invite)).newGroup
    s.history.push(installed(group, s.identity, s.history.at(-1)?.body.authHash ?? null))
  }
  expect(group.state.ratchetTree.filter((node) => node?.nodeType === 1)).toHaveLength(17)
  const token = await mls.signLedgerEntry(s.identity, {
    type: 'public.metadata',
    groupID: s.group.groupID,
    subject: s.identity.id,
    value: 'x'.repeat(510_000),
  })
  group = (await mls.commitLedgerEntries(group, [token])).newGroup
  s.history.push(installed(group, s.identity, s.history.at(-1)?.body.authHash ?? null))
  while (group.epoch < 255n) {
    group = (await mls.commitKeyRotation(group)).newGroup
    s.history.push(installed(group, s.identity, s.history.at(-1)?.body.authHash ?? null))
  }
  const request = await mls.createRecoveryRequest({
    group: s.joined,
    identity: s.requester,
    requestID: 'absent',
    comparisonEpoch: 250,
  })
  const sealedRosterReply = await s.seal({
    group,
    request: request.request,
    lineage: s.history.map(({ frame }) => frame),
  })
  if (sealedRosterReply === null) throw new Error('Missing bounded roster')
  const verifiedRosterAbsence = await s.verify(sealedRosterReply, {
    requestKey: request.ephemeralPrivateKey,
  })
  const returnedLineageEpochs = verifiedRosterAbsence?.lineage.map(({ epoch }) => epoch)
  expect(returnedLineageEpochs).toEqual([250, 251, 252, 253, 254, 255])
  expect(sealedRosterReply.byteLength).toBeLessThanOrEqual(786432)
  expect(verifiedRosterAbsence).not.toBeNull()
  const publicBytes = await openSealedReply({
    kind,
    group: { groupID: group.groupID, context: group.context, credential: s.trust.credential },
    sealed: sealedRosterReply,
    requestID: 'absent',
    ephemeralPrivateKey: request.ephemeralPrivateKey,
  })
  const parts = split(publicBytes)
  const fullHistoryReplyBytes =
    49 +
    12 +
    utf8.encode(parts.token).length +
    parts.groupInfo.length +
    parts.ledger.length +
    checkpoints(s.history.map(({ frame }) => frame)).length
  expect(fullHistoryReplyBytes).toBeGreaterThan(786432)
  const old = await mls.createRecoveryRequest({
    group: s.joined,
    identity: s.requester,
    requestID: 'absent',
    comparisonEpoch: 0,
  })
  const truncated = await s.seal({
    group,
    request: old.request,
    lineage: s.history.map(({ frame }) => frame),
  })
  if (truncated === null) throw new Error('Missing suffix roster')
  const proof = await s.verify(truncated, { requestKey: old.ephemeralPrivateKey })
  expect(proof).not.toBeNull()
  expect(proof?.lineage.at(-1)?.epoch).toBe(255)
  expect(proof?.lineage[0]?.epoch).toBeGreaterThan(0)
  expect(truncated.byteLength).toBeLessThanOrEqual(786432)
})

test.each([
  { name: 'oversized public state yields no truncated roster', comparisonEpoch: 1 },
  { name: 'old comparison requests never truncate oversized state', comparisonEpoch: 0 },
])('$name', async ({ comparisonEpoch }) => {
  const s = await fixture()
  const token = await mls.signLedgerEntry(s.identity, {
    type: 'public.metadata',
    groupID: s.group.groupID,
    subject: s.identity.id,
    value: 'x'.repeat(590_000),
  })
  const group = (await mls.commitLedgerEntries(s.group, [token])).newGroup
  s.history.push(installed(group, s.identity, s.history.at(-1)?.body.authHash ?? null))
  const old = await mls.createRecoveryRequest({
    group: s.joined,
    identity: s.requester,
    requestID: 'absent',
    comparisonEpoch,
  })
  expect(
    await s.seal({ group, request: old.request, lineage: s.history.map(({ frame }) => frame) }),
  ).toBeNull()
  expect(await s.verify(new Uint8Array(786433))).toBeNull()
  const oversized = await attestGroup(
    s,
    group,
    s.history.slice(1).map(({ frame }) => frame),
  )
  expect(oversized.byteLength).toBeGreaterThan(786432)
  expect(await s.verify(oversized)).toBeNull()
  // Existing current-member captured recovery keeps its availability even above this bound.
  const request = await mls.createRecoveryRequest({
    group,
    identity: s.identity,
    requestID: 'ordinary',
  })
  const ordinary = await mls.sealCapturedGroupInfo({
    group,
    identity: s.identity,
    request: request.request,
    captureHead: null,
  })
  expect(
    await mls.authenticateRecoveryReply({
      trust: trustFor(group),
      sealed: ordinary,
      requestID: 'ordinary',
      requestKey: request.ephemeralPrivateKey,
      options: {},
    }),
  ).not.toBeNull()
})
