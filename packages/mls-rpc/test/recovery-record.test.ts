import { createRotate } from '@kokuin/controller'
import { type OwnIdentity, randomIdentity } from '@kokuin/token'
import {
  type ControllerBinding,
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  encodeClientState,
  processWelcome,
  sealCapturedGroupInfo,
} from '@kumiai/mls'
import {
  asLogPosition,
  assignRecoverySwitchMutationID,
  type CapturedRejoinRecord,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
  type LegacyRejoinRecord,
} from '@kumiai/rpc'
import { fromB64U, toB64U } from '@sozai/codec'
import { beforeAll, describe, expect, test } from 'vitest'

import { createGroupMLS, createLedgerEntrySlot } from '../src/mls.js'
import {
  decodeStoredValue,
  encodeStoredValue,
  encodeTrust,
  openRecord,
  sealRecord,
} from '../src/persistence-codec.js'
import { GroupStateConflictError } from '../src/persistence-errors.js'
import type { GroupRecoveryTrust } from '../src/persistence-types.js'
import {
  type CapturedRecoverySnapshot,
  decodeCapturedRecoveryCandidate,
  decodeRecoveryCandidate,
  encodeCapturedRecoveryCandidate,
} from '../src/recovery-codec.js'
import { decodeRecoveryRecord, validateCapturedRecoveryRecord } from '../src/recovery-record.js'
import { recoveryTrustDigest } from '../src/recovery-trust-digest.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
import { createRealGroup, type RealMember, testHandleAccess } from './fixtures/real-group.js'
import { legacyRecoveryTrustDigest } from './fixtures/recovery-trust-digest-v1.js'

let trust: GroupRecoveryTrust
beforeAll(async () => {
  const real = await createRealGroup(2, 'trust-digest')
  trust = recoveryTrustFor(real.committer.handle, { groupID: 'trust-digest', incarnation: 1 }, null)
  trust.spentEpochAuthenticators.push(trust.installed.authenticator.slice())
})

test('reordered equivalent public trust hashes equally with bigint lifetimes and sparse slots', () => {
  const first = structuredClone(trust)
  first.registry.devices = new Map([
    ['device-b', { controller: 'controller-b', status: 'active' }],
    ['device-a', { controller: 'controller-a', status: 'revoked' }],
  ])
  first.registry.controllers = new Map([
    ['controller-b', { recordedLog: [], genFloor: 2, timeFloor: 3 }],
    ['controller-a', { recordedLog: [], genFloor: 4, timeFloor: 5 }],
  ])
  first.signerTree.push(undefined)
  const second = structuredClone(first)
  second.registry.devices = new Map([...second.registry.devices].reverse())
  second.registry.controllers = new Map([...second.registry.controllers].reverse())
  second.credential = { groupID: first.credential.groupID, id: first.credential.id }
  expect(first.signerTree.some((node) => node?.nodeType === 1 && 'lifetime' in node.leaf)).toBe(
    true,
  )
  expect(recoveryTrustDigest(second)).toBe(recoveryTrustDigest(first))
  expect(recoveryTrustDigest(first)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  const absent = structuredClone(first)
  absent.signerTree.length -= 1
  expect(recoveryTrustDigest(absent)).not.toBe(recoveryTrustDigest(first))
})

test.each([
  [
    'authority',
    (value: GroupRecoveryTrust) => {
      value.binding = { id: 'controller', prefix: [], capability: 'grant' }
    },
  ],
  [
    'key',
    (value: GroupRecoveryTrust) => {
      value.genesisAnchor[0] = (value.genesisAnchor[0] ?? 0) ^ 1
    },
  ],
  [
    'signer key',
    (value: GroupRecoveryTrust) => {
      const node = value.signerTree.find((entry) => entry?.nodeType === 1)
      if (node?.nodeType !== 1) throw new Error('Missing signer')
      node.leaf.signaturePublicKey[0] = (node.leaf.signaturePublicKey[0] ?? 0) ^ 1
    },
  ],
  [
    'ledger',
    (value: GroupRecoveryTrust) => {
      value.ledger.push('another-token')
    },
  ],
  [
    'spent',
    (value: GroupRecoveryTrust) => {
      value.spentEpochAuthenticators.push(new Uint8Array(32).fill(7))
    },
  ],
  [
    'installed',
    (value: GroupRecoveryTrust) => {
      value.installed.epoch += 1
    },
  ],
  [
    'registry',
    (value: GroupRecoveryTrust) => {
      value.registry.controllers = new Map([
        ['authority', { recordedLog: [], genFloor: 1, timeFloor: 2 }],
      ])
    },
  ],
  [
    'lifetime',
    (value: GroupRecoveryTrust) => {
      const node = value.signerTree.find(
        (entry) => entry?.nodeType === 1 && 'lifetime' in entry.leaf,
      )
      if (node?.nodeType !== 1 || !('lifetime' in node.leaf)) throw new Error('Missing lifetime')
      node.leaf.lifetime.notAfter += 1n
    },
  ],
] as const)('changed public %s facts differ', (_name, mutate) => {
  const changed = structuredClone(trust)
  mutate(changed)
  expect(recoveryTrustDigest(changed)).not.toBe(recoveryTrustDigest(trust))
})

test('distinct ledger fields that collide under naive NUL concatenation hash differently', () => {
  const first = { ...trust, ledger: ['a\u0000b', 'c'] }
  const second = { ...trust, ledger: ['a', 'b\u0000c'] }
  expect(first.ledger.join('\u0000')).toBe(second.ledger.join('\u0000'))
  expect(recoveryTrustDigest(first)).not.toBe(recoveryTrustDigest(second))
})

test('invalid public trust is refused instead of hashing lossy JSON values', () => {
  const invalid = structuredClone(trust)
  invalid.ledger = [Number.NaN] as unknown as Array<string>
  expect(() => recoveryTrustDigest(invalid)).toThrow()
  const privateTree = structuredClone(trust)
  Object.assign(privateTree.signerTree[0] ?? {}, { privateKey: new Uint8Array(32) })
  expect(() => recoveryTrustDigest(privateTree)).toThrow()
})

async function recordFixture(members?: Array<RealMember>) {
  const group = members == null ? await createRealGroup(2, 'captured-record') : { members }
  const member = group.members[0]
  const responder = group.members[1]
  if (member == null || responder == null) throw new Error('Missing recovery members')
  const key = { groupID: member.handle.groupID, incarnation: 1 }
  const requester = createGroupMLS({
    identity: member.identity,
    entrySlot: member.slot,
    access: testHandleAccess({ handle: () => member.handle, adopt: () => {} }),
  })
  const remote = createGroupMLS({
    identity: responder.identity,
    entrySlot: responder.slot,
    access: testHandleAccess({ handle: () => responder.handle, adopt: () => {} }),
  })
  const requestID = 'captured-request'
  const { request, requestKey } = await requester.createRecoveryRequest(requestID)
  const pending = await requester.applyRecovery(
    await remote.sealGroupInfo(request),
    requestID,
    requestKey,
  )
  if (pending == null || 'renewalRequired' in pending) throw new Error('Missing candidate')
  const heldTrust = recoveryTrustFor(member.handle, key, null)
  const payload = encodeHandshakeFrame(
    HANDSHAKE_KIND.commit,
    encodeCommitFrame(pending.commit, new Uint8Array()),
  )
  const legacy: LegacyRejoinRecord = {
    id: 'rejoin-id',
    publishID: 'publish-id',
    stage: 'built',
    expectedHead: null,
    request,
    requestID,
    requestKey,
    candidate: pending.serialize(),
    payload,
    digest: digestAppliedCommit(pending.commit),
    payloadDigest: digestAppliedCommit(payload),
    source: {
      key,
      epoch: Number(member.handle.epoch),
      authenticator: heldTrust.installed.authenticator.slice(),
      head: null,
    },
    epochAfter: pending.epoch,
    ledgerBefore: heldTrust.ledger,
    conflictEpoch: null,
  }
  const snapshot = decodeRecoveryCandidate(legacy.candidate, legacy.requestKey)
  const head = asLogPosition('capture-head')
  const source = {
    key,
    identity: heldTrust.installed,
    stateVersion: 1,
    lifetimeRevision: 1,
    trust: heldTrust,
    trustDigest: recoveryTrustDigest(heldTrust),
  }
  const target = {
    targetID: 'recovery-hub',
    topicID: 'commit-topic',
    groupInfoEpoch: snapshot.epoch - 1,
    groupInfoAuthenticator: heldTrust.installed.authenticator.slice(),
    captureHead: head,
  }
  const captured: CapturedRecoverySnapshot = {
    ...snapshot,
    source,
    target,
    captureHead: head,
    searchFrom: head,
    attestedReply: await sealCapturedGroupInfo({
      group: responder.handle,
      identity: responder.identity,
      request: new TextDecoder().decode(request),
      captureHead: head,
    }),
  }
  const { source: _source, conflictEpoch: _conflict, ...common } = legacy
  const record: CapturedRejoinRecord = {
    ...common,
    format: 2,
    source,
    target,
    captureHead: head,
    searchFrom: head,
    expectedHead: head,
    trigger: 'automatic',
    authorisationID: null,
    switchMutationID: null,
    destinationKey: null,
    candidate: encodeCapturedRecoveryCandidate(captured, legacy.requestKey),
  }
  return { record, legacy, snapshot: captured }
}

describe('public trust JSON positions', () => {
  let record: CapturedRejoinRecord

  beforeAll(async () => {
    const lifecycle = (await import(
      new URL('../../mls/test/fixtures/lifecycle-ledger.ts', import.meta.url).href
    )) as {
      controllerSeed: Uint8Array
      controllerID: string
      inception: ControllerBinding['prefix'][number]
      bindingFor(
        identity: OwnIdentity,
        prefix: ControllerBinding['prefix'],
      ): Promise<ControllerBinding>
    }
    const prefix = [
      lifecycle.inception,
      createRotate({
        seed: lifecycle.controllerSeed,
        profile: 0,
        did: lifecycle.controllerID,
        prior: lifecycle.inception.event,
        options: { keyPosition: { gen: 0, seq: 0 }, seal: '100' },
      }),
    ]
    const identity = randomIdentity()
    const responder = randomIdentity()
    const controller = await lifecycle.bindingFor(identity, prefix)
    const { group } = await createGroup(identity, 'captured-bound-record', { controller })
    const { invite } = await createInvite({ group, identity, recipientDID: responder.id })
    const bundle = await createKeyPackageBundle(responder, {
      controller: await lifecycle.bindingFor(responder, prefix),
    })
    const added = await commitInvite(group, bundle.publicPackage, invite)
    const joined = await processWelcome({
      identity: responder,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
    })
    const fixture = await recordFixture([
      { identity, handle: added.newGroup, slot: createLedgerEntrySlot() },
      { identity: responder, handle: joined.group, slot: createLedgerEntrySlot() },
    ])
    const held = fixture.snapshot.source.trust
    Object.assign(held, { extra: { bytes: 'AQID', bigint: '100' } })
    const leaf = held.signerTree.find((node) => node?.nodeType === 1)
    if (leaf?.nodeType !== 1) throw new Error('Missing signer leaf')
    Object.assign(leaf.leaf, { extra: { bytes: 'AQID', bigint: '100' } })
    const source = { ...fixture.snapshot.source, trustDigest: recoveryTrustDigest(held) }
    record = {
      ...fixture.record,
      source,
      candidate: encodeCapturedRecoveryCandidate(
        { ...fixture.snapshot, source },
        fixture.record.requestKey,
      ),
    }
    expect(decodeRecoveryRecord(record).kind).toBe('captured')
  })

  test('genuine bound captures retain the original digest format', () => {
    const held = record.source.trust as GroupRecoveryTrust
    expect(held.binding?.prefix).toHaveLength(2)
    expect(held.binding?.prefix[1]?.event).toMatchObject({ a: '100' })
    expect(recoveryTrustDigest(held)).toBe(legacyRecoveryTrustDigest(held))
    expect(recoveryTrustDigest(trust)).toBe(legacyRecoveryTrustDigest(trust))
    const sparse = structuredClone(held)
    sparse.signerTree.length += 2
    sparse.signerTree[sparse.signerTree.length - 1] = undefined
    if (sparse.binding === null) throw new Error('Missing binding')
    sparse.binding.holderGrant = undefined
    const event = sparse.binding.prefix[0]
    if (event === undefined) throw new Error('Missing inception')
    event.recoveryKey = undefined
    event.event.i = undefined
    event.event.p = undefined
    expect(recoveryTrustDigest(sparse)).toBe(legacyRecoveryTrustDigest(sparse))
  })

  test.each(['k', 'ka', 'a'] as const)(
    'binding event %s refuses erased-type replacements with the saved digest',
    (field) => {
      const invalid = structuredClone(record)
      const held = invalid.source.trust as GroupRecoveryTrust
      const event = held.binding?.prefix[field === 'a' ? 1 : 0]?.event as unknown as Record<
        string,
        unknown
      >
      if (field === 'a') {
        expect(event.a).toBe('100')
        event.a = 100n
      } else {
        const keys = event[field] as Array<unknown>
        expect(typeof keys[0]).toBe('string')
        const key = keys[0] as string
        keys[0] = fromB64U(key)
        expect(toB64U(keys[0] as Uint8Array)).toBe(key)
      }
      expect(invalid.source.trustDigest).toBe(record.source.trustDigest)
      expect(invalid.candidate).toEqual(record.candidate)
      expect.soft(() => recoveryTrustDigest(held)).toThrow(GroupStateConflictError)
      expect.soft(() => validateCapturedRecoveryRecord(invalid)).toThrow(GroupStateConflictError)
      expect.soft(() => decodeRecoveryRecord(invalid)).toThrow(GroupStateConflictError)
    },
  )

  const invalidJSON = [
    ['bytes', () => new Uint8Array([1, 2, 3])],
    ['bigint', () => 100n],
    ['undefined', () => undefined],
    ['non-plain object', () => new Date(0)],
    ['non-finite number', () => Number.NaN],
  ] as const
  test.each(
    ['root', 'leaf'].flatMap((position) =>
      invalidJSON.map(([kind, value]) => ({ position, kind, value })),
    ),
  )('unknown $position property refuses $kind', ({ position, kind, value }) => {
    const invalid = structuredClone(record)
    const held = invalid.source.trust as GroupRecoveryTrust
    const leaf = held.signerTree.find((node) => node?.nodeType === 1)
    if (leaf?.nodeType !== 1) throw new Error('Missing signer leaf')
    const owner = (position === 'root' ? held : leaf.leaf) as unknown as {
      extra: Record<string, unknown>
    }
    owner.extra[kind] = value()
    expect(invalid.source.trustDigest).toBe(record.source.trustDigest)
    expect(invalid.candidate).toEqual(record.candidate)
    expect.soft(() => recoveryTrustDigest(held)).toThrow(GroupStateConflictError)
    expect.soft(() => validateCapturedRecoveryRecord(invalid)).toThrow(GroupStateConflictError)
    expect.soft(() => decodeRecoveryRecord(invalid)).toThrow(GroupStateConflictError)
  })
})

describe('public trust field types', () => {
  let record: CapturedRejoinRecord

  beforeAll(async () => {
    const fixture = await recordFixture()
    const held = structuredClone(fixture.snapshot.source.trust)
    held.spentEpochAuthenticators.push(held.installed.authenticator.slice())
    const signer = held.signerTree.find(
      (node) => node?.nodeType === 1 && node.leaf.leafNodeSource === 1,
    )
    const parent = held.signerTree.find((node) => node?.nodeType === 2)
    if (signer?.nodeType !== 1 || signer.leaf.leafNodeSource !== 1 || parent?.nodeType !== 2)
      throw new Error('Missing public signer fields')
    const { lifetime: _lifetime, ...leaf } = signer.leaf
    held.signerTree = [
      {
        ...signer,
        leaf: {
          ...signer.leaf,
          extensions: [{ extensionType: 1, extensionData: new Uint8Array([1, 2, 3]) }],
        },
      },
      parent,
      { nodeType: 1, leaf: { ...leaf, leafNodeSource: 2 } },
      { nodeType: 1, leaf: { ...leaf, leafNodeSource: 3, parentHash: parent.parent.parentHash } },
      {
        nodeType: 1,
        leaf: {
          ...signer.leaf,
          credential: { credentialType: 2, certificates: [new Uint8Array([4])] },
        },
      },
      {
        nodeType: 1,
        leaf: {
          ...signer.leaf,
          credential: { credentialType: 0xff00, data: new Uint8Array([5]) },
        },
      },
    ]
    const source = {
      ...fixture.snapshot.source,
      trust: held,
      trustDigest: recoveryTrustDigest(held),
    }
    record = {
      ...fixture.record,
      source,
      candidate: encodeCapturedRecoveryCandidate(
        { ...fixture.snapshot, source },
        fixture.record.requestKey,
      ),
    }
    expect(() => validateCapturedRecoveryRecord(record)).not.toThrow()
  })

  const byteFields: Array<[string, Array<string | number>]> = [
    ['genesis anchor', ['genesisAnchor']],
    ['installed authenticator', ['installed', 'authenticator']],
    ['spent authenticator', ['spentEpochAuthenticators', 0]],
    ['leaf HPKE key', ['signerTree', 0, 'leaf', 'hpkePublicKey']],
    ['leaf signature key', ['signerTree', 0, 'leaf', 'signaturePublicKey']],
    ['leaf signature', ['signerTree', 0, 'leaf', 'signature']],
    ['basic credential identity', ['signerTree', 0, 'leaf', 'credential', 'identity']],
    ['leaf extension data', ['signerTree', 0, 'leaf', 'extensions', 0, 'extensionData']],
    ['parent HPKE key', ['signerTree', 1, 'parent', 'hpkePublicKey']],
    ['parent hash', ['signerTree', 1, 'parent', 'parentHash']],
    ['update leaf HPKE key', ['signerTree', 2, 'leaf', 'hpkePublicKey']],
    ['commit leaf parent hash', ['signerTree', 3, 'leaf', 'parentHash']],
    ['X509 certificate', ['signerTree', 4, 'leaf', 'credential', 'certificates', 0]],
    ['custom credential data', ['signerTree', 5, 'leaf', 'credential', 'data']],
  ]
  const bigintFields: Array<[string, Array<string | number>]> = [
    ['lifetime start', ['signerTree', 0, 'leaf', 'lifetime', 'notBefore']],
    ['lifetime end', ['signerTree', 0, 'leaf', 'lifetime', 'notAfter']],
  ]
  const cases = [
    ...byteFields.map(([name, path]) => ({ name, path, representation: 'base64url' as const })),
    ...bigintFields.flatMap(([name, path]) => [
      { name: `${name} string`, path, representation: 'decimal' as const },
      { name: `${name} number`, path, representation: 'number' as const },
    ]),
  ]

  test.each(cases)(
    '$name refuses an erased-type replacement before returning a record',
    (entry) => {
      const invalid = structuredClone(record)
      let owner = invalid.source.trust as Record<string | number, unknown>
      for (const key of entry.path.slice(0, -1)) owner = owner[key] as typeof owner
      const key = entry.path.at(-1)
      if (key === undefined) throw new Error('Missing field path')
      const original = owner[key]
      if (entry.representation === 'base64url') {
        expect(original).toBeInstanceOf(Uint8Array)
        owner[key] = toB64U(original as Uint8Array)
      } else {
        expect(typeof original).toBe('bigint')
        owner[key] = entry.representation === 'decimal' ? String(original) : Number(original)
      }
      expect(invalid.source.trustDigest).toBe(record.source.trustDigest)
      expect
        .soft(() => recoveryTrustDigest(invalid.source.trust as GroupRecoveryTrust))
        .toThrow(GroupStateConflictError)
      expect.soft(() => validateCapturedRecoveryRecord(invalid)).toThrow(GroupStateConflictError)
      expect.soft(() => decodeRecoveryRecord(invalid)).toThrow(GroupStateConflictError)
    },
  )
})

test('full sealed record reopens origin and accounts for duplicated trust and sourceState', async () => {
  const { record, snapshot } = await recordFixture()
  const address = {
    groupID: record.source.key.groupID,
    incarnation: 1,
    namespace: 'control',
    recordID: 'rejoin',
  }
  const storageKey = new Uint8Array(32).fill(86)
  const sealed = await sealRecord(
    createDeterministicAtRestCodec({ key: storageKey }),
    address,
    record,
  )
  const reopened = decodeRecoveryRecord(
    await openRecord(createDeterministicAtRestCodec({ key: storageKey }), address, sealed),
  )
  expect(reopened).toMatchObject({ kind: 'captured', record })
  if (reopened.kind !== 'captured') throw new Error('Wrong record format')
  const candidate = decodeCapturedRecoveryCandidate(
    reopened.record.candidate,
    reopened.record.requestKey,
  )
  expect(candidate.target).toEqual(snapshot.target)
  expect(candidate.source).toEqual(snapshot.source)
  expect(candidate.searchFrom).toBe('capture-head')
  expect(candidate.attestedReply).toEqual(snapshot.attestedReply)
  const size = {
    candidate: record.candidate.length,
    fullSealedRecord: sealed.length,
    duplicatedTrust:
      encodeStoredValue(snapshot.source.trust).length +
      encodeStoredValue(encodeTrust(snapshot.source.trust)).length,
    sourceState: encodeClientState({ ...snapshot.state, ratchetTree: snapshot.sourceTree }).length,
    trustDigestCharacters: snapshot.source.trustDigest.length,
  }
  console.info('Recovery persistence sizes (bytes)', JSON.stringify(size))
  expect(size.trustDigestCharacters).toBe(43)
  expect(size.candidate).toBeGreaterThan(size.sourceState)
  expect(size.fullSealedRecord).toBeGreaterThan(size.candidate + size.duplicatedTrust)
  const corrupted = structuredClone(reopened.record)
  corrupted.source.trustDigest = 'A'.repeat(43)
  expect(() => decodeRecoveryRecord(corrupted)).toThrow('trust digest')
})

test('captured records validate their immutable origin and digest before use', async () => {
  const { record } = await recordFixture()
  expect(decodeRecoveryRecord(record)).toMatchObject({ kind: 'captured', record })
  const changed = structuredClone(record)
  changed.source.trust = { ...(record.source.trust as GroupRecoveryTrust), ledger: ['changed'] }
  expect(() => validateCapturedRecoveryRecord(changed)).toThrow('trust digest')
  for (const mutate of [
    (value: CapturedRejoinRecord) => {
      value.source.key.incarnation += 1
    },
    (value: CapturedRejoinRecord) => {
      value.target.targetID = 'other-target'
    },
    (value: CapturedRejoinRecord) => {
      value.target.groupInfoAuthenticator[0] = (value.target.groupInfoAuthenticator[0] ?? 0) ^ 1
    },
    (value: CapturedRejoinRecord) => {
      value.captureHead = asLogPosition('other-head')
    },
    (value: CapturedRejoinRecord) => {
      value.searchFrom = null
    },
    (value: CapturedRejoinRecord) => {
      value.requestID = 'other-request'
    },
    (value: CapturedRejoinRecord) => {
      value.epochAfter += 1
    },
    (value: CapturedRejoinRecord) => {
      value.digest = 'other-commit'
    },
    (value: CapturedRejoinRecord) => {
      value.payloadDigest = 'other-payload'
    },
  ]) {
    const invalid = structuredClone(record)
    mutate(invalid)
    expect(() => validateCapturedRecoveryRecord(invalid)).toThrow()
  }
  const decoded = decodeRecoveryRecord(record)
  if (decoded.kind !== 'captured') throw new Error('Wrong record format')
  decoded.record.target.groupInfoAuthenticator.fill(0)
  expect(record.target.groupInfoAuthenticator.some((byte) => byte !== 0)).toBe(true)
})

test('confirmed records carry the assigned switch ID and tolerate historical confirmed null', async () => {
  const { record, snapshot } = await recordFixture()
  const position = asLogPosition('confirmed-position')
  const confirmed = {
    ...record,
    stage: 'confirmed' as const,
    position,
    verdict: new Uint8Array([1, 2]),
    switchMutationID: assignRecoverySwitchMutationID(record.switchMutationID, 'switch-1'),
    candidate: encodeCapturedRecoveryCandidate(
      {
        ...snapshot,
        boundCommit: { position, commitDigest: record.digest, tag: 'confirmation-tag' },
      },
      record.requestKey,
    ),
  }
  expect(decodeRecoveryRecord(confirmed)).toMatchObject({
    kind: 'captured',
    record: { switchMutationID: 'switch-1' },
  })
  const address = {
    groupID: record.source.key.groupID,
    incarnation: 1,
    namespace: 'control',
    recordID: 'rejoin',
  }
  const codec = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(87) })
  const saved = await sealRecord(codec, address, confirmed)
  expect(decodeRecoveryRecord(await openRecord(codec, address, saved))).toMatchObject({
    kind: 'captured',
    record: { stage: 'confirmed', switchMutationID: 'switch-1' },
  })
  expect(decodeRecoveryRecord({ ...confirmed, switchMutationID: null })).toMatchObject({
    kind: 'captured',
    record: { switchMutationID: null },
  })
  const manual = { ...record, trigger: 'manual', authorisationID: 'manual-authorisation' }
  expect(decodeRecoveryRecord(manual)).toMatchObject({
    kind: 'captured',
    executable: false,
    record: manual,
  })
  expect(() => decodeRecoveryRecord({ ...manual, authorisationID: null })).toThrow()
})

test('every legacy stage and conflict epoch preserves all stored bytes without execution', async () => {
  const { legacy } = await recordFixture()
  for (const stage of ['built', 'published', 'confirmed', 'adopted', 'refused'] as const) {
    for (const conflictEpoch of [null, 17]) {
      const record: LegacyRejoinRecord = {
        ...legacy,
        stage,
        conflictEpoch,
        expectedHead: asLogPosition('legacy-head'.repeat(10)),
        source: { ...legacy.source, head: asLogPosition('legacy-source-head'.repeat(10)) },
      }
      const encoded = encodeStoredValue(record)
      const after = decodeRecoveryRecord(decodeStoredValue(encoded))
      expect(after).toMatchObject({ kind: 'legacy', executable: false })
      expect(encodeStoredValue(after.record)).toEqual(encoded)
    }
  }
  expect(() => decodeRecoveryRecord({ ...legacy, format: 3 })).toThrow()
})

test('candidate identity cannot be replaced by another source owner', async () => {
  const { record, snapshot } = await recordFixture()
  const state = structuredClone(snapshot.state)
  const next = state.ratchetTree.findIndex(
    (node, index) => node?.nodeType === 1 && index !== state.privatePath.leafIndex * 2,
  )
  state.privatePath.leafIndex = next / 2
  expect(() => encodeCapturedRecoveryCandidate({ ...snapshot, state }, record.requestKey)).toThrow()
  expect(encodeClientState(snapshot.state)[0]).toBe(2)
  const wrongPayload = encodeHandshakeFrame(
    HANDSHAKE_KIND.commit,
    encodeCommitFrame(new Uint8Array([9]), new Uint8Array()),
  )
  expect(() =>
    validateCapturedRecoveryRecord({
      ...record,
      payload: wrongPayload,
      payloadDigest: digestAppliedCommit(wrongPayload),
    }),
  ).toThrow()
})
