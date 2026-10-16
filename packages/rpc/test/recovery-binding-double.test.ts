import { randomIdentity } from '@kokuin/token'
import {
  malformedCheckpointBodies,
  testCheckpointCacheConformance,
  testCheckpointComparisonConformance,
  testCheckpointCoverageConformance,
  testCheckpointPortConformance,
} from '@kumiai/rpc-conformance'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { fromUTF, toB64U, toUTF } from '@sozai/codec'
import { expect, test } from 'vitest'

import {
  createMemoryCheckpointPort,
  createMemoryGroupMLS,
  type MemoryCheckpointDatabase,
  type MemoryCheckpointFact,
  memoryCheckpointFrame,
} from './fixtures/memory-group-mls.js'

test('a refused bound candidate is not reused by the memory port', async () => {
  const binding = { id: 'controller', prefix: [], capability: 'initial-capability' }
  const options = { members: ['alice', 'bob'], binding, recoveryBinding: async () => binding }
  const alice = createMemoryGroupMLS({ ...options, localDID: 'alice' })
  const bob = createMemoryGroupMLS({ ...options, localDID: 'bob' })
  const { request, requestKey } = await bob.createRecoveryRequest('refused-binding')
  const pending = await bob.applyRecovery(
    await alice.sealGroupInfo(request),
    'refused-binding',
    requestKey,
  )
  if (pending == null || 'renewalRequired' in pending) throw new Error('No candidate')
  pending.markBindingUnusable()
  expect(await bob.prepareRecovery()).toBe('renewal-required')
})

test('fresh recovery requests build distinct external commits while candidate restore preserves bytes', async () => {
  const options = { members: ['alice', 'bob'] }
  const alice = createMemoryGroupMLS({ ...options, localDID: 'alice' })
  const bob = createMemoryGroupMLS({ ...options, localDID: 'bob' })
  const first = await bob.createRecoveryRequest('first-attempt')
  const pending = await bob.applyRecovery(
    await alice.sealGroupInfo(first.request),
    'first-attempt',
    first.requestKey,
  )
  if (pending == null || 'renewalRequired' in pending) throw new Error('No first candidate')
  const second = await bob.createRecoveryRequest('fresh-attempt')
  const fresh = await bob.applyRecovery(
    await alice.sealGroupInfo(second.request),
    'fresh-attempt',
    second.requestKey,
  )
  if (fresh == null || 'renewalRequired' in fresh) throw new Error('No fresh candidate')
  expect(fresh.commit).not.toEqual(pending.commit)
  const restored = await bob.restoreRecovery(await pending.serialize(), first.requestKey)
  expect(restored.commit).toEqual(pending.commit)
})

test('ineligible retained recovery signer is refused', async () => {
  const alice = createMemoryGroupMLS({ members: ['alice'], localDID: 'alice' })
  const removed = createMemoryGroupMLS({ members: ['alice'], localDID: 'bob' })
  const { request, requestKey } = await alice.createRecoveryRequest('removed-signer')
  const sealed = await removed.sealGroupInfo(request)
  expect(await alice.applyRecovery(sealed, 'removed-signer', requestKey)).toBeNull()
})

test('recovery signer from another controller is refused', async () => {
  const binding = { id: 'controller', prefix: [], capability: 'initial-capability' }
  const alice = createMemoryGroupMLS({ members: ['alice', 'bob'], localDID: 'alice', binding })
  const bob = createMemoryGroupMLS({
    members: ['alice', 'bob'],
    localDID: 'bob',
    binding: { ...binding, id: 'other-controller' },
  })
  const { request, requestKey } = await alice.createRecoveryRequest('foreign-controller')
  expect(
    await alice.applyRecovery(await bob.sealGroupInfo(request), 'foreign-controller', requestKey),
  ).toBeNull()
})

function checkpointKeyHash(bytes: Uint8Array): string {
  const size = new Uint8Array(4)
  new DataView(size.buffer).setUint32(0, bytes.length)
  return toB64U(
    sha256(concatBytes(fromUTF('kumiai/checkpoint-key/v1'), new Uint8Array([0]), size, bytes)),
  )
}
function checkpointFixture(groupID = `independent-checkpoints-${crypto.randomUUID()}`) {
  const identity = randomIdentity()
  const key = { groupID, incarnation: 1 }
  const db: MemoryCheckpointDatabase = {
    activeIncarnation: 1,
    facts: [],
    frames: new Map(),
    gaps: [],
  }
  let port = createMemoryCheckpointPort({ key, identity, database: db })
  const member = (who = identity) => ({
    signerDID: who.id,
    keyHash: checkpointKeyHash(who.publicKey),
    signaturePublicKey: toB64U(who.publicKey),
    leafIndex: 0,
  })
  function install(incarnation: number, epoch: number, members = [member()]) {
    const previous = db.facts.at(-1)
    const currentKey = { groupID, incarnation }
    if (previous !== undefined) previous.supersededAt ??= Date.now()
    const from = previous?.key.incarnation === incarnation ? previous.epoch + 1 : 0
    if (from < epoch)
      db.gaps.push({
        key: currentKey,
        from,
        through: epoch - 1,
        reason: from === 0 ? 'pre-join' : 'skipped',
      })
    const fact: MemoryCheckpointFact = {
      id: crypto.randomUUID(),
      key: currentKey,
      epoch,
      authHash: toB64U(crypto.getRandomValues(new Uint8Array(32))),
      genesisHash: toB64U(new Uint8Array(32).fill(1)),
      ciphersuite: 1,
      parentAuthHash: previous?.epoch === epoch - 1 ? previous.authHash : null,
      members,
      supersededAt: null,
    }
    db.activeIncarnation = incarnation
    db.facts.push(fact)
    while (db.facts.length > 256) {
      const expired = db.facts.shift()
      if (expired === undefined) throw new Error('Missing expired fact')
      db.gaps.push({
        key: expired.key,
        from: expired.epoch,
        through: expired.epoch,
        reason: 'expired',
      })
      db.frames.delete(expired.id)
    }
    return fact
  }
  return {
    identity,
    groupID,
    key,
    db,
    member,
    install,
    port: () => port,
    restart() {
      port = createMemoryCheckpointPort({ key, identity, database: db })
    },
  }
}

testCheckpointPortConformance({
  label: 'independent rpc model',
  createFixture: async () => {
    const fixture = checkpointFixture()
    let current = fixture.install(1, 0)
    return {
      port: fixture.port(),
      key: fixture.key,
      installed: async () => current,
      advance: async () => {
        current = fixture.install(1, current.epoch + 1)
      },
      generations: async () => fixture.db.facts.map((fact) => [fact.key, fact.epoch]),
      unproven: async () => crypto.randomUUID(),
      retire: async () => {
        fixture.db.activeIncarnation = 2
      },
      decodeEpoch: (frame) => (JSON.parse(toUTF(frame.slice(10, -64))) as { epoch: number }).epoch,
      close: async () => {},
    }
  },
})

testCheckpointCacheConformance({
  label: 'independent rpc model',
  createFixture: async () => {
    const fixture = checkpointFixture()
    const other = randomIdentity()
    const members = [fixture.member(), { ...fixture.member(other), leafIndex: 1 }]
    let current = fixture.install(1, 0, members)
    return {
      port: fixture.port(),
      key: fixture.key,
      installed: async () => current,
      advance: async () => {
        current = fixture.install(1, current.epoch + 1, members)
      },
      saveFrame: async (factID, frame) => {
        fixture.db.frames.set(factID, frame.slice())
      },
      signBody: (body, otherSigner) =>
        memoryCheckpointFrame(
          body as Parameters<typeof memoryCheckpointFrame>[0],
          (otherSigner ? other : fixture.identity).privateKey,
        ),
      otherKeyHash: fixture.member(other).keyHash,
      close: async () => {},
    }
  },
})

testCheckpointComparisonConformance({
  label: 'independent rpc model',
  createFixture: async () => {
    const fixture = checkpointFixture()
    const remote = randomIdentity()
    fixture.install(1, 0, [fixture.member(), fixture.member(remote)])
    const current = fixture.install(1, 1)
    const body = {
      v: 1,
      type: 'kumiai/checkpoint/v1',
      groupID: fixture.groupID,
      epoch: 1,
      ciphersuite: current.ciphersuite,
      genesisHash: current.genesisHash,
      parentAuthHash: current.parentAuthHash,
      authHash: toB64U(new Uint8Array(32).fill(8)),
      keyHash: fixture.member(remote).keyHash,
      leafIndex: 123,
    }
    const other = randomIdentity()
    return {
      port: fixture.port(),
      key: fixture.key,
      malformedFrames: malformedCheckpointBodies(body).map((value) =>
        memoryCheckpointFrame(value as typeof body, remote.privateKey),
      ),
      sharedRosterDID: remote.id,
      frame: memoryCheckpointFrame(body, remote.privateKey),
      wrongKeyFrame: memoryCheckpointFrame(
        { ...body, keyHash: fixture.member(other).keyHash },
        other.privateKey,
      ),
      wrongBindingFrame: memoryCheckpointFrame(
        { ...body, genesisHash: toB64U(new Uint8Array(32).fill(9)) },
        remote.privateKey,
      ),
      close: async () => {},
    }
  },
})

testCheckpointCoverageConformance({
  label: 'independent rpc model',
  createFixture: async () => {
    const fixture = checkpointFixture()
    return {
      groupID: fixture.groupID,
      port: fixture.port,
      install: async (incarnation, epoch) => {
        fixture.install(incarnation, epoch)
      },
      restart: async () => fixture.restart(),
      prune: async () => {
        const expired = fixture.db.facts.filter(
          (fact) => fact.supersededAt !== null && Date.now() - fact.supersededAt >= 604800000,
        )
        for (const fact of expired) {
          fixture.db.gaps.push({
            key: fact.key,
            from: fact.epoch,
            through: fact.epoch,
            reason: 'expired',
          })
          fixture.db.frames.delete(fact.id)
        }
        fixture.db.facts = fixture.db.facts.filter((fact) => !expired.includes(fact))
      },
      close: async () => {},
    }
  },
})

test('independent checkpoints reject ZIP215-only signatures', async () => {
  const fixture = checkpointFixture()
  const point = new Uint8Array(32)
  point[0] = 1
  const member = {
    ...fixture.member(),
    keyHash: checkpointKeyHash(point),
    signaturePublicKey: toB64U(point),
  }
  const fact = fixture.install(1, 0, [member])
  const body = {
    v: 1,
    type: 'kumiai/checkpoint/v1',
    groupID: fixture.groupID,
    genesisHash: fact.genesisHash,
    ciphersuite: fact.ciphersuite,
    epoch: 0,
    authHash: fact.authHash,
    parentAuthHash: null,
    keyHash: member.keyHash,
    leafIndex: member.leafIndex,
  }
  const frame = memoryCheckpointFrame(body, fixture.identity.privateKey)
  const signature = new Uint8Array(64)
  signature[0] = 1
  frame.set(signature, frame.length - 64)
  const bodyBytes = frame.slice(10, -64)
  const size = new Uint8Array(4)
  new DataView(size.buffer).setUint32(0, bodyBytes.length)
  expect(
    ed25519.verify(
      signature,
      concatBytes(fromUTF('kumiai/checkpoint-signature/v1'), new Uint8Array([0]), size, bodyBytes),
      point,
      { zip215: true },
    ),
  ).toBe(true)
  expect(await fixture.port().compare(fixture.key, frame)).toEqual({ kind: 'invalid' })
})

test('independent checkpoints reject malformed UTF-8 before signature verification', async () => {
  const fixture = checkpointFixture('checkpoint-\ufffd')
  const fact = fixture.install(1, 0)
  const member = fixture.member()
  const body = {
    v: 1,
    type: 'kumiai/checkpoint/v1',
    groupID: fixture.groupID,
    genesisHash: fact.genesisHash,
    ciphersuite: fact.ciphersuite,
    epoch: 0,
    authHash: fact.authHash,
    parentAuthHash: null,
    keyHash: member.keyHash,
    leafIndex: member.leafIndex,
  }
  const valid = memoryCheckpointFrame(body, fixture.identity.privateKey)
  const index = valid.findIndex(
    (byte, index) => byte === 0xef && valid[index + 1] === 0xbf && valid[index + 2] === 0xbd,
  )
  expect(index).toBeGreaterThan(10)
  const malformed = concatBytes(
    valid.slice(0, index),
    new Uint8Array([0xff]),
    valid.slice(index + 3),
  )
  const view = new DataView(malformed.buffer)
  view.setUint32(2, malformed.length - 6)
  view.setUint32(6, malformed.length - 74)
  expect(await fixture.port().compare(fixture.key, valid)).toMatchObject({ kind: 'agreement' })
  expect(await fixture.port().compare(fixture.key, malformed)).toEqual({ kind: 'invalid' })
})

test('independent checkpoints refuse ambiguous key attribution', async () => {
  const fixture = checkpointFixture()
  const member = fixture.member()
  const fact = fixture.install(1, 0, [
    member,
    { ...member, signerDID: randomIdentity().id, leafIndex: 1 },
  ])
  const frame = await fixture.port().signInstalled(fact.id)
  if (frame === null) throw new Error('Missing own statement')
  expect(await fixture.port().compare(fixture.key, frame)).toEqual({ kind: 'invalid' })
})
