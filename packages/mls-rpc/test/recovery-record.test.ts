import { encodeClientState, sealCapturedGroupInfo } from '@kumiai/mls'
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
import { beforeAll, expect, test } from 'vitest'

import { createGroupMLS } from '../src/mls.js'
import {
  decodeStoredValue,
  encodeStoredValue,
  encodeTrust,
  openRecord,
  sealRecord,
} from '../src/persistence-codec.js'
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
import { createRealGroup, testHandleAccess } from './fixtures/real-group.js'

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

async function recordFixture() {
  const group = await createRealGroup(2, 'captured-record')
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
