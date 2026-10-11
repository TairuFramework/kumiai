import { commitKeyRotation, decodeClientState, encodeClientState, restoreGroup } from '@kumiai/mls'
import { type AdoptionWrite, asLogPosition, type ControlSlot, type Operation } from '@kumiai/rpc'
import { expect, test } from 'vitest'

import { simpleHandleAccess } from '../src/access.js'
import { createControlAdoptionPort } from '../src/control-adoption.js'
import { createControlBuildPort, createPersistenceBuildSaver } from '../src/control-build.js'
import { encodeControlJournal } from '../src/control-journal.js'
import { createMemoryGroupPersistence } from '../src/memory-group-persistence.js'
import { createMemoryTransaction } from '../src/memory-transaction.js'
import { createGroupMLS } from '../src/mls.js'
import { createOwnerQueues } from '../src/owner-queue.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
import { controlAdoptionFixture } from './fixtures/control-adoption.js'
import { createRealGroup } from './fixtures/real-group.js'
import { installSeed, makeStorageSeed, nextChange } from './fixtures/storage-seed.js'
import {
  createTransactionalAccess,
  createTransactionalStore,
} from './fixtures/transactional-access.js'

test('stale adoption version leaves state and control unchanged', async () => {
  const f = await controlAdoptionFixture()
  const expected = await f.expected()
  f.store.bump()
  const before = structuredClone(f.store.snapshot())
  expect(await f.port.adopt(f.slot.journal, expected, f.write)).toBe('moved')
  expect(f.store.snapshot()).toEqual(before)
  expect(await f.port.adopt(f.slot.journal, await f.expected(), f.write)).toBe('installed')
  expect(f.host.live().state.keySchedule.epochAuthenticator).toEqual(
    f.rotation.newGroup.state.keySchedule.epochAuthenticator,
  )
})

test('adoption rollback leaves state control and anchor unchanged', async () => {
  const f = await controlAdoptionFixture()
  const before = structuredClone(f.store.snapshot())
  const live = f.host.live()
  f.store.beforeWrite = () => {
    throw new Error('rollback')
  }
  await expect(f.port.adopt(f.slot.journal, await f.expected(), f.write)).rejects.toThrow(
    'rollback',
  )
  expect(f.store.snapshot()).toEqual(before)
  expect(f.host.live()).toBe(live)
  f.store.beforeWrite = undefined
  expect(await f.port.adopt(f.slot.journal, await f.expected(), f.write)).toBe('installed')
  expect(f.store.snapshot().control.applied).toHaveLength(1)
  expect(f.store.snapshot().control.outcomes).toHaveLength(1)
  expect(f.store.snapshot().anchorSlot?.pending?.landed).toBe(true)
})

test('no-op requires committed payload evidence', async () => {
  const f = await controlAdoptionFixture()
  await f.host.access.replace(f.rotation.newGroup)
  const before = structuredClone(f.store.snapshot())
  expect(await f.port.adopt(f.slot.journal, await f.expected(), f.write)).toBe('moved')
  expect(f.store.snapshot()).toEqual(before)
})

test('committed adoption replay does not recreate acknowledged landed facts', async () => {
  const f = await controlAdoptionFixture()
  expect(await f.port.adopt(f.slot.journal, await f.expected(), f.write)).toBe('installed')
  await f.store.control.apply({ deleteOutcomes: ['landed-fact'] }, 'ack')
  const before = structuredClone(f.store.snapshot())
  expect(await f.port.adopt(f.slot.journal, await f.expected(), f.write)).toBe('noop')
  expect(f.store.snapshot()).toEqual(before)
})

test('own authorship requires the content signature rather than sender data alone', async () => {
  const group = await createRealGroup(1, 'own-authorship')
  const member = group.members[0]
  if (member === undefined) throw new Error('missing member')
  const store = createTransactionalStore(member.handle)
  const host = await createTransactionalAccess(member, store)
  const mls = createGroupMLS({
    access: host.access,
    identity: member.identity,
    entrySlot: member.slot,
  })
  const rotation = await commitKeyRotation(member.handle)
  const tampered = rotation.commitMessage.slice()
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1
  expect(await member.handle.verifyCommitSignature(tampered)).toBe(false)
  expect(await mls.readCommitHeader(tampered)).not.toHaveProperty('committerDID')
})

test('a durable control hold refuses installation with an otherwise current proof', async () => {
  const f = await controlAdoptionFixture()
  await f.store.control.apply(
    { controlHold: { reason: 'unsupported-version', position: f.proof.position } },
    'hold',
  )
  const before = structuredClone(f.store.snapshot())
  expect(await f.port.adopt(f.slot.journal, await f.expected(), f.write)).toBe('moved')
  expect(f.store.snapshot()).toEqual(before)
})

test('transport clearing preserves a durable control hold and its cursor evidence', async () => {
  const db = createMemoryTransaction({ rows: {} })
  const groups = createMemoryGroupPersistence({
    db,
    owners: createOwnerQueues(),
    atRest: createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(17) }),
    providerID: 'memory',
  })
  const seed = await makeStorageSeed({ id: 'held-group', incarnation: 1, epoch: 2, mode: 'double' })
  await installSeed(groups, seed, 'seed')
  const controlHold = { reason: 'unsupported-version' as const, position: asLogPosition('002') }
  const cursor = { position: asLogPosition('001'), epoch: 2, stranded: true as const }
  await groups.transition(await nextChange(groups, seed.key.groupID, 'hold'), async (stores) => {
    await stores
      .incarnation(1)
      .control.apply({ controlHold, cursor, strand: { reason: 'unsupported-version' } }, 'hold')
  })
  await groups.transition(await nextChange(groups, seed.key.groupID, 'clear'), async (stores) => {
    await stores.incarnation(1).clearTransport()
  })
  expect(await groups.ports(seed.key).control.load()).toMatchObject({
    controlHold,
    cursor,
    strand: { reason: 'unsupported-version' },
  })
})

test('2.1 adoption rolls back and co-commits trust spent anchor and opaque side writes', async () => {
  const db = createMemoryTransaction({ rows: { side: new Map() } })
  const groups = createMemoryGroupPersistence({
    db,
    owners: createOwnerQueues(),
    atRest: createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(18) }),
    providerID: 'memory',
  })
  const seed = await makeStorageSeed({
    id: 'coupled-adoption',
    incarnation: 1,
    epoch: 0,
    mode: 'real-mls',
  })
  await installSeed(groups, seed, 'seed')
  const restoreCandidate = async (bytes: Uint8Array) => {
    const state = decodeClientState(bytes)
    if (state === undefined) throw new Error('Invalid candidate')
    return restoreGroup({
      state,
      credential: seed.trust.credential,
      ledgerEntries: seed.trust.ledger,
    })
  }
  if (seed.state.state === null) throw new Error('Missing seed state')
  let current = await restoreCandidate(seed.state.state)
  let rollback = true
  let holdDuringPersist = false
  let holdInsideTransaction = false
  const access = simpleHandleAccess({
    handle: () => current,
    adopt: (next) => {
      current = next
    },
    key: seed.key,
    stateVersion: async () => (await groups.loadState(seed.key))?.version ?? 0,
    persist: async (next, write) => {
      if (write === undefined) throw new Error('Missing adoption write')
      if (holdDuringPersist)
        await groups
          .ports(seed.key)
          .control.apply(
            { controlHold: { reason: 'unsupported-version', position: asLogPosition('held') } },
            'hold-in-persist',
          )
      await groups.transition(
        await nextChange(groups, seed.key.groupID, write.mutationID),
        async (stores) => {
          const rows = stores.incarnation(1)
          const state = await rows.state.load()
          if (state === null || state.deleted || state.version !== write.expected?.stateVersion)
            throw Object.assign(new Error('Stale state'), { name: 'ControlAdoptionMovedError' })
          const trust = await stores.trust.load()
          if (trust === null) throw new Error('Missing trust')
          await stores.trust.save({
            ...trust,
            installed: {
              ...seed.key,
              epoch: Number(next.epoch),
              authenticator: next.state.keySchedule.epochAuthenticator,
            },
            signerTree: next.state.ratchetTree,
            registry: next.registry,
            credential: next.credential,
            ledger: next.ledgerTokens,
          })
          if (holdInsideTransaction)
            await rows.control.apply(
              {
                controlHold: {
                  reason: 'unsupported-version',
                  position: asLogPosition('held-in-tx'),
                },
              },
              write.mutationID,
            )
          await rows.state.save(
            {
              ...state,
              version: state.version + 1,
              epoch: Number(next.epoch),
              epochAuthenticator: next.state.keySchedule.epochAuthenticator,
              state: encodeClientState(next.state),
              ledger: next.ledgerTokens,
            },
            write.expected,
          )
          await rows.control.apply(write.changes, write.mutationID)
          const anchor = await rows.anchor.load()
          if (anchor?.pending !== undefined && anchor.pending.advance === write.anchorLanded)
            await rows.anchor.save({ ...anchor, pending: { ...anchor.pending, landed: true } })
          stores.tx.rows.side?.set('handler', new Uint8Array([7]))
          if (rollback) throw new Error('coupled rollback')
        },
      )
    },
  })
  const control = groups.ports(seed.key).control
  const rotation = await commitKeyRotation(current)
  const intent: Operation & { stage: 'intent' } = {
    id: 'coupled',
    kind: 'rotation',
    revokes: false,
    body: new Uint8Array(),
    seq: 1,
    enqueuedAt: 0,
    deadline: 30_000,
    stage: 'intent',
  }
  await control.apply({ putOperations: [intent] }, 'intent')
  const build = createControlBuildPort({
    access,
    control,
    now: () => 0,
    newID: () => 'build',
    saveBuilt: createPersistenceBuildSaver({ persistence: groups, key: seed.key }),
    build: async () => ({
      commit: rotation.commitMessage,
      bodies: [],
      welcome: null,
      journal: encodeClientState(rotation.newGroup.state),
      epoch: 0,
      incarnation: 1,
      authenticatorBefore: current.state.keySchedule.epochAuthenticator,
      digest: 'rotation',
    }),
  })
  expect(
    (
      await build.prepareBuild(intent, async () => ({
        payload: new Uint8Array([1]),
        publishID: 'publish',
        expectedHead: null,
      }))
    ).kind,
  ).toBe('saved')
  const slot = (await control.load()).commitOnce
  if (slot === null) throw new Error('Missing slot')
  const position = asLogPosition('001')
  const proof = {
    source: (await groups.readEvidence(seed.key)).source,
    from: null,
    position,
    payloadDigest: slot.payloadDigest,
  }
  await control.apply({ commitOnceAcceptance: proof }, 'accept')
  await groups.ports(seed.key).anchor.save({
    anchor: { epoch: 0, secret: new Uint8Array(32).fill(1) },
    pending: {
      epochBefore: 0,
      epochAfter: 1,
      rosterBefore: [current.credential.id],
      forced: false,
      advance: 'rotation',
    },
  })
  const port = createControlAdoptionPort({ access, control, restoreCandidate })
  const write: AdoptionWrite = {
    mutationID: 'landed-coupled',
    anchorLanded: 'rotation',
    changes: {
      commitOnce: null,
      deleteOperations: [intent.id],
      cursor: { position, epoch: 1 },
      putApplied: [
        {
          epoch: 0,
          digest: slot.digest,
          payloadDigest: slot.payloadDigest,
          sequenceID: position,
          opID: intent.id,
          removed: false,
        },
      ],
      putOutcomes: [{ id: 'landed-coupled', opID: intent.id, kind: 'landed', at: 1, position }],
    },
  }
  const expected = { ...(await groups.readEvidence(seed.key)).source, acceptance: proof }
  holdDuringPersist = true
  rollback = false
  expect(await port.adopt(slot.journal, expected, write)).toBe('moved')
  expect(current.epoch).toBe(0n)
  expect(await groups.loadState(seed.key)).toMatchObject({ deleted: false, epoch: 0 })
  expect((await groups.loadState(seed.key))?.version).toBeGreaterThan(expected.stateVersion)
  await control.apply({ controlHold: null }, 'clear-probe-hold')
  holdDuringPersist = false
  Object.assign(expected, (await groups.readEvidence(seed.key)).source)
  holdInsideTransaction = true
  expect(await port.adopt(slot.journal, expected, write)).toBe('moved')
  expect(current.epoch).toBe(0n)
  expect((await control.load()).controlHold).toBeNull()
  holdInsideTransaction = false
  rollback = true
  const before = db.snapshot()
  await expect(port.adopt(slot.journal, expected, write)).rejects.toThrow('coupled rollback')
  expect(db.snapshot()).toEqual(before)
  expect(current.epoch).toBe(0n)
  rollback = false
  expect(await port.adopt(slot.journal, expected, write)).toBe('installed')
  const trust = await groups.loadTrust(seed.key.groupID)
  expect(trust?.installed.authenticator).toEqual(
    rotation.newGroup.state.keySchedule.epochAuthenticator,
  )
  expect(trust?.spentEpochAuthenticators).toEqual(
    expect.arrayContaining([
      seed.state.epochAuthenticator,
      rotation.newGroup.state.keySchedule.epochAuthenticator,
    ]),
  )
  expect((await groups.ports(seed.key).anchor.load())?.pending?.landed).toBe(true)
  expect(db.snapshot().side?.get('handler')).toEqual(new Uint8Array([7]))
  expect((await control.load()).applied).toHaveLength(1)
  expect((await control.load()).outcomes).toHaveLength(1)
})

test('a hold committed after preparation prevents the 2.1 build save', async () => {
  const db = createMemoryTransaction({ rows: {} })
  const groups = createMemoryGroupPersistence({
    db,
    owners: createOwnerQueues(),
    atRest: createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(19) }),
    providerID: 'memory',
  })
  const seed = await makeStorageSeed({ id: 'held-save', incarnation: 1, epoch: 2, mode: 'double' })
  await installSeed(groups, seed, 'seed')
  const control = groups.ports(seed.key).control
  const intent: Operation & { stage: 'intent' } = {
    id: 'held',
    kind: 'rotation',
    revokes: false,
    body: new Uint8Array(),
    seq: 1,
    enqueuedAt: 0,
    deadline: 30_000,
    stage: 'intent',
  }
  await control.apply({ putOperations: [intent] }, 'intent')
  const source = (await groups.readEvidence(seed.key)).source
  if (seed.state.state === null) throw new Error('Missing state')
  const slot: ControlSlot = {
    opID: intent.id,
    incarnation: 1,
    epoch: 2,
    authenticatorBefore: seed.state.epochAuthenticator,
    searchFrom: null,
    expectedHead: null,
    publishID: 'held-publish',
    payload: new Uint8Array([1]),
    payloadDigest: 'held-payload',
    digest: 'held-commit',
    bodies: [],
    welcome: null,
    journal: encodeControlJournal({
      version: 1,
      source,
      checkpoint: null,
      sourceState: seed.state.state,
      sourceCredential: seed.trust.credential,
      sourceLedger: seed.trust.ledger,
      candidate: seed.state.state,
    }),
  }
  await control.apply(
    { controlHold: { reason: 'unsupported-version', position: asLogPosition('001') } },
    'hold',
  )
  const save = createPersistenceBuildSaver({ persistence: groups, key: seed.key })
  expect(await save(intent, slot, source, 'stale-preparation')).toBe('moved')
  expect((await control.load()).commitOnce).toBeNull()
})

test('transactional save rechecks the hold after its write gate before publishing state', async () => {
  const f = await controlAdoptionFixture()
  const before = f.host.live().epoch
  f.store.beforeWrite = () => {
    f.store.snapshot().control.controlHold = {
      reason: 'unsupported-version',
      position: f.proof.position,
    }
  }
  expect(await f.port.adopt(f.slot.journal, await f.expected(), f.write)).toBe('moved')
  expect(f.host.live().epoch).toBe(before)
  expect(f.store.snapshot().control.applied).toEqual([])
  expect(f.store.snapshot().control.controlHold?.reason).toBe('unsupported-version')
})
