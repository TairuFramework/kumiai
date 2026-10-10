import { type ClientState, decodeClientState, encodeClientState } from '@kumiai/mls'
import { describe, expect, test } from 'vitest'

import { createMemoryGroupPersistence } from '../src/memory-group-persistence.js'
import { createGroupStateStores, type GroupStateStores } from '../src/memory-group-state.js'
import { createMemoryTransaction } from '../src/memory-transaction.js'
import { createOwnerQueues } from '../src/owner-queue.js'
import { GroupStateConflictError } from '../src/persistence-errors.js'
import { assertStateTransition, assertTrustTransition } from '../src/persistence-guards.js'
import type { AtRestCodec, GroupStateRecord } from '../src/persistence-types.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
import { createRealGroup } from './fixtures/real-group.js'
import { installSeed, makeStorageSeed, nextChange } from './fixtures/storage-seed.js'

const groupID = 'group-A'
const scope = { groupID, devicePackages: false }
const codec = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(97) })

function decoded(record: GroupStateRecord & { deleted: false }): ClientState {
  if (record.state === null) throw new Error('Expected seed bytes')
  const state = decodeClientState(record.state)
  if (state === undefined) throw new Error('Expected valid seed')
  return state
}

function pausedSeal(): { atRest: AtRestCodec; entered: Promise<void>; release(): void } {
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  let paused = false
  return {
    entered: entered.promise,
    release: () => resume.resolve(),
    atRest: {
      ...codec,
      async seal(bytes, aad) {
        if (!paused) {
          paused = true
          entered.resolve()
          await resume.promise
        }
        return codec.seal(bytes, aad)
      },
    },
  }
}

test.each([1, 3])('allows genuine secret-tree expansion with %i other members', async (size) => {
  const real = await createRealGroup(size, groupID)
  const handle = real.committer.handle
  const previous: GroupStateRecord & { deleted: false } = {
    groupID,
    incarnation: 1,
    version: 1,
    deleted: false,
    terminal: false,
    epoch: Number(handle.epoch),
    epochAuthenticator: handle.state.keySchedule.epochAuthenticator.slice(),
    state: encodeClientState(handle.state),
    credential: handle.credential,
    ledger: handle.ledgerTokens,
    senderHWM: 16,
  }
  const before = decoded(previous)
  expect(Object.keys(before.secretTree.intermediateNodes)).toEqual([size === 1 ? '1' : '3'])
  await handle.encrypt(new TextEncoder().encode('advance the application ratchet'))
  const next = { ...previous, version: 2, state: encodeClientState(handle.state) }
  const after = decoded(next)
  expect(Object.keys(after.secretTree.intermediateNodes)).toEqual(size === 1 ? ['2'] : ['2', '5'])
  expect(after.secretTree.leafNodes[0]?.application.generation).toBe(1)
  expect(() => assertStateTransition(previous, next, null)).not.toThrow()
  const db = createMemoryTransaction({ rows: {} })
  await db.transact(scope, async (tx) => {
    const stores = createGroupStateStores({ tx, groupID, atRest: codec })
    await stores.state(1).save(previous)
    await stores.state(1).save(next)
    expect(await stores.state(1).load()).toEqual(next)
    const restored = decoded(next)
    Object.assign(restored.secretTree.intermediateNodes, before.secretTree.intermediateNodes)
    await expect(
      stores.state(1).save({ ...next, version: 3, state: encodeClientState(restored) }),
    ).rejects.toThrow(GroupStateConflictError)
  })
  const retainedAncestor = decoded(next)
  Object.assign(retainedAncestor.secretTree.intermediateNodes, before.secretTree.intermediateNodes)
  expect(() =>
    assertStateTransition(previous, { ...next, state: encodeClientState(retainedAncestor) }, null),
  ).toThrow(GroupStateConflictError)
  const historical = (client: ClientState) => {
    const current = decoded(next)
    current.groupContext.epoch = BigInt(previous.epoch + 1)
    current.historicalReceiverData.set(BigInt(previous.epoch), {
      groupContext: client.groupContext,
      resumptionPsk: client.keySchedule.resumptionPsk,
      ratchetTree: client.ratchetTree,
      senderDataSecret: client.keySchedule.senderDataSecret,
      secretTree: client.secretTree,
    })
    return { ...next, epoch: previous.epoch + 1, state: encodeClientState(current) }
  }
  expect(() =>
    assertStateTransition(historical(before), { ...historical(after), version: 3 }, null),
  ).not.toThrow()
})

for (const mode of ['real-mls', 'double'] as const) {
  describe(mode, () => {
    const seed = () => makeStorageSeed({ id: groupID, incarnation: 1, epoch: 3, mode })

    test('rejects version and identity regression without spending an authenticator', async () => {
      const value = await seed()
      const otherAuthenticator = value.state.epochAuthenticator.slice()
      otherAuthenticator[0] = (otherAuthenticator[0] ?? 0) ^ 1
      for (const candidate of [
        { ...value.state, version: 1 },
        { ...value.state, version: 3 },
        { ...value.state, version: 2, epoch: 2 },
        { ...value.state, version: 2, epochAuthenticator: otherAuthenticator },
        { ...value.state, version: 2, senderHWM: 15 },
      ]) {
        expect(() => assertStateTransition(value.state, candidate, value.trust)).toThrow(
          GroupStateConflictError,
        )
      }
      expect(() =>
        assertStateTransition(null, { ...value.state, version: 2 }, value.trust),
      ).toThrow(GroupStateConflictError)
      expect(value.trust.spentEpochAuthenticators).toEqual([value.state.epochAuthenticator])
      const db = createMemoryTransaction({ rows: {} })
      await db.transact(scope, async (tx) => {
        const stores = createGroupStateStores({ tx, groupID, atRest: codec })
        await stores.state(1).save(value.state)
        await stores.trust.save(value.trust)
        await stores.lifetime.save(value.lifetime)
        expect(await stores.state(1).load()).toEqual(value.state)
        expect(await stores.lifetime.load()).toEqual(value.lifetime)
        for (const candidate of [
          { ...value.state, version: 1 },
          { ...value.state, version: 2, senderHWM: 15 },
        ]) {
          await expect(stores.state(1).save(candidate)).rejects.toThrow(GroupStateConflictError)
        }
        await stores.state(1).save({ ...value.state, version: 2, senderHWM: 32 })
        expect(await stores.trust.load()).toEqual(value.trust)
      })
      for (const rows of Object.values(db.snapshot())) {
        for (const bytes of rows.values()) expect(bytes).toBeInstanceOf(Uint8Array)
      }
    })

    test('resets the sender ceiling on a new epoch while refusing same-identity regression', async () => {
      const value = await seed()
      const previous = { ...value.state, senderHWM: 32 }
      const client = decoded(previous)
      client.groupContext.epoch = 4n
      client.keySchedule.epochAuthenticator = crypto.getRandomValues(new Uint8Array(32))
      const next = {
        ...previous,
        version: 2,
        epoch: 4,
        epochAuthenticator: client.keySchedule.epochAuthenticator,
        state: encodeClientState(client),
        senderHWM: 16,
      }
      expect(() => assertStateTransition(previous, next, value.trust)).not.toThrow()
      const db = createMemoryTransaction({ rows: {} })
      await db.transact(scope, async (tx) => {
        const stores = createGroupStateStores({ tx, groupID, atRest: codec })
        await stores.state(1).save(previous)
        await stores.trust.save(value.trust)
        await expect(
          stores.state(1).save({ ...previous, version: 2, senderHWM: 16 }),
        ).rejects.toThrow(GroupStateConflictError)
        await stores.state(1).save(next)
        expect(await stores.state(1).load()).toEqual(next)
        expect(await stores.trust.load()).toEqual(value.trust)
      })
    })

    test('retains trust above tombstones and refuses absent or unreadable trust', async () => {
      const value = await seed()
      const db = createMemoryTransaction({ rows: {} })
      await db.transact(scope, async (tx) => {
        const stores = createGroupStateStores({ tx, groupID, atRest: codec })
        expect(await stores.trust.load()).toBeNull()
        expect(await stores.state(1).load()).toBeNull()
        await stores.state(1).save(value.state)
        await stores.trust.save(value.trust)
      })
      await db.transact(scope, async (tx) => {
        const stores = createGroupStateStores({ tx, groupID, atRest: codec })
        await stores.state(1).save({ ...value.key, version: 2, deleted: true })
        expect((await stores.trust.load())?.genesisAnchor).toEqual(value.trust.genesisAnchor)
        await expect(stores.state(1).save({ ...value.state, version: 3 })).rejects.toThrow(
          GroupStateConflictError,
        )
      })
      const nullDB = createMemoryTransaction({ rows: {} })
      await nullDB.transact(scope, async (tx) => {
        const stores = createGroupStateStores({ tx, groupID, atRest: codec })
        await stores.state(1).save(value.state)
        await stores.trust.save(value.trust)
        await stores.state(1).save({ ...value.state, version: 2, state: null })
        expect(await stores.trust.load()).toEqual(value.trust)
        const copy = await stores.trust.load()
        copy?.spentEpochAuthenticators[0]?.fill(0)
        expect((await stores.trust.load())?.spentEpochAuthenticators).toEqual(
          value.trust.spentEpochAuthenticators,
        )
      })
      expect(() =>
        assertStateTransition(
          value.state,
          { ...value.state, version: 2, epoch: 4, state: null },
          null,
        ),
      ).toThrow(GroupStateConflictError)
      expect(() =>
        assertTrustTransition(value.trust, { ...value.trust, spentEpochAuthenticators: [] }),
      ).toThrow(GroupStateConflictError)
      const unreadable = {
        ...codec,
        open: async () => {
          throw new Error('trust unreadable')
        },
      }
      await db.transact(scope, async (tx) => {
        const stores = createGroupStateStores({ tx, groupID, atRest: unreadable })
        await expect(stores.trust.load()).rejects.toThrow('trust unreadable')
        await expect(stores.trust.save(value.trust)).rejects.toThrow('trust unreadable')
      })
    })

    test('refuses private-state restoration after null state in the same incarnation', async () => {
      const value = await seed()
      const client = decoded(value.state)
      const chain = () => ({
        secret: new Uint8Array(32).fill(97),
        generation: 5,
        unusedGenerations: {},
      })
      client.secretTree.leafNodes[0] = { handshake: chain(), application: chain() }
      delete client.secretTree.intermediateNodes[0]
      const progressed = { ...value.state, state: encodeClientState(client) }
      const lost = { ...progressed, version: 2, state: null }
      const db = createMemoryTransaction({ rows: {} })
      await db.transact(scope, async (tx) => {
        const stores = createGroupStateStores({ tx, groupID, atRest: codec })
        await stores.state(1).save(progressed)
        await stores.trust.save(value.trust)
        await stores.state(1).save(lost)
        await expect(stores.state(1).save({ ...value.state, version: 3 })).rejects.toThrow(
          GroupStateConflictError,
        )
        expect(await stores.state(1).load()).toEqual(lost)
        expect(await stores.trust.load()).toEqual(value.trust)
        await stores.state(1).save({ ...lost, version: 3 })
      })
      const fresh = decoded(value.state)
      fresh.groupContext.epoch = 4n
      fresh.keySchedule.epochAuthenticator = crypto.getRandomValues(new Uint8Array(32))
      const recovered = {
        ...value.state,
        version: 3,
        epoch: 4,
        epochAuthenticator: fresh.keySchedule.epochAuthenticator,
        state: encodeClientState(fresh),
      }
      expect(() => assertStateTransition(lost, recovered, value.trust)).toThrow(
        GroupStateConflictError,
      )
      expect(() =>
        assertStateTransition(lost, { ...recovered, incarnation: 2, version: 1 }, value.trust),
      ).not.toThrow()
    })

    test('refuses spent A3 in a different incarnation by byte value', async () => {
      const value = await seed()
      const candidate = { ...value.state, incarnation: 2, version: 1 }
      expect(() => assertStateTransition(null, candidate, value.trust)).toThrow(
        GroupStateConflictError,
      )
      expect(() => assertStateTransition(value.state, candidate, value.trust)).toThrow(
        GroupStateConflictError,
      )
      const fresh = {
        ...candidate,
        epoch: 1,
        state: null,
        epochAuthenticator: crypto.getRandomValues(new Uint8Array(32)),
      }
      expect(() => assertStateTransition(null, fresh, value.trust)).not.toThrow()
      expect(() => assertStateTransition(null, fresh, null)).toThrow(GroupStateConflictError)
      const db = createMemoryTransaction({ rows: {} })
      await db.transact(scope, async (tx) => {
        const stores = createGroupStateStores({ tx, groupID, atRest: codec })
        await stores.trust.save(value.trust)
        await expect(stores.state(2).save(candidate)).rejects.toThrow(GroupStateConflictError)
      })
    })

    test('binds non-null v2 bytes to group, epoch and authenticator metadata', async () => {
      const value = await seed()
      for (const mutate of [
        (client: ClientState) => {
          client.groupContext.groupId = new TextEncoder().encode('group-B')
        },
        (client: ClientState) => {
          client.groupContext.groupId = new Uint8Array([0xc3, 0x28])
        },
        (client: ClientState) => {
          client.groupContext.epoch = 2n
        },
        (client: ClientState) => {
          client.keySchedule.epochAuthenticator.fill(0)
        },
      ]) {
        const client = decoded(value.state)
        mutate(client)
        expect(() =>
          assertStateTransition(
            value.state,
            { ...value.state, version: 2, state: encodeClientState(client) },
            value.trust,
          ),
        ).toThrow(GroupStateConflictError)
      }
      for (const bytes of [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array()]) {
        expect(() =>
          assertStateTransition(
            value.state,
            { ...value.state, version: 2, state: bytes },
            value.trust,
          ),
        ).toThrow(GroupStateConflictError)
      }
      expect(() =>
        assertStateTransition(
          value.state,
          {
            ...value.state,
            version: 2,
            credential: { ...value.state.credential, groupID: 'group-B' },
          },
          value.trust,
        ),
      ).toThrow(GroupStateConflictError)
    })

    test('preserves consumed generations in current and matching historical trees', async () => {
      const value = await seed()
      const client = decoded(value.state)
      const chain = () => ({
        secret: new Uint8Array(32).fill(97),
        generation: 5,
        unusedGenerations: { 2: new Uint8Array(32).fill(98) },
      })
      client.secretTree.leafNodes[0] = { handshake: chain(), application: chain() }
      client.historicalReceiverData.clear()
      client.historicalReceiverData.set(2n, {
        resumptionPsk: new Uint8Array(32).fill(99),
        secretTree: structuredClone(client.secretTree),
        ratchetTree: client.ratchetTree,
        senderDataSecret: client.keySchedule.senderDataSecret,
        groupContext: { ...client.groupContext, epoch: 2n },
      })
      const previous = { ...value.state, state: encodeClientState(client) }
      for (const historical of [false, true]) {
        for (const kind of ['handshake', 'application'] as const) {
          for (const mutation of [
            'backward',
            'consumed',
            'missing-leaf',
            'intermediate',
          ] as const) {
            const next = decoded(previous)
            const tree = historical
              ? next.historicalReceiverData.get(2n)?.secretTree
              : next.secretTree
            if (tree === undefined || tree.leafNodes[0] === undefined)
              throw new Error('Expected ratchet')
            if (mutation === 'backward') tree.leafNodes[0][kind].generation = 4
            if (mutation === 'consumed')
              tree.leafNodes[0][kind].unusedGenerations[1] = new Uint8Array(32)
            if (mutation === 'missing-leaf') delete tree.leafNodes[0]
            if (mutation === 'intermediate') tree.intermediateNodes[100] = new Uint8Array(32)
            expect(() =>
              assertStateTransition(
                previous,
                { ...previous, version: 2, state: encodeClientState(next) },
                value.trust,
              ),
            ).toThrow(GroupStateConflictError)
          }
          const next = decoded(previous)
          const tree = historical
            ? next.historicalReceiverData.get(2n)?.secretTree
            : next.secretTree
          const node = tree?.leafNodes[0]
          if (node === undefined) throw new Error('Expected ratchet')
          node[kind].generation = 8
          node[kind].unusedGenerations[6] = new Uint8Array(32).fill(99)
          delete node[kind].unusedGenerations[2]
          expect(() =>
            assertStateTransition(
              previous,
              { ...previous, version: 2, state: encodeClientState(next) },
              value.trust,
            ),
          ).not.toThrow()
        }
      }
      const evicted = decoded(previous)
      const history = evicted.historicalReceiverData.get(2n)
      if (history === undefined) throw new Error('Expected history')
      evicted.historicalReceiverData.set(1n, {
        ...history,
        groupContext: { ...history.groupContext, epoch: 1n },
      })
      expect(() =>
        assertStateTransition(
          previous,
          { ...previous, version: 2, state: encodeClientState(evicted) },
          value.trust,
        ),
      ).toThrow(GroupStateConflictError)
      const advanced = decoded(previous)
      advanced.historicalReceiverData.set(3n, {
        ...history,
        resumptionPsk: client.keySchedule.resumptionPsk,
        secretTree: structuredClone(client.secretTree),
        groupContext: client.groupContext,
      })
      advanced.groupContext.epoch = 4n
      advanced.keySchedule.epochAuthenticator = crypto.getRandomValues(new Uint8Array(32))
      advanced.secretTree = {
        leafWidth: 1,
        intermediateNodes: { 0: new Uint8Array(32) },
        leafNodes: {},
      }
      const record = {
        ...previous,
        version: 2,
        epoch: 4,
        epochAuthenticator: advanced.keySchedule.epochAuthenticator,
        state: encodeClientState(advanced),
      }
      expect(() => assertStateTransition(previous, record, value.trust)).not.toThrow()
      const retained = advanced.historicalReceiverData.get(3n)?.secretTree.leafNodes[0]
      if (retained === undefined) throw new Error('Expected retained current tree')
      retained.application.generation = 4
      expect(() =>
        assertStateTransition(
          previous,
          { ...record, state: encodeClientState(advanced) },
          value.trust,
        ),
      ).toThrow(GroupStateConflictError)
    })

    test('keeps anchor, sorted unique spent copies, ledger repeats and registry Maps across reopen', async () => {
      const value = await seed()
      const trust = { ...value.trust, ledger: [...value.trust.ledger, ...value.trust.ledger] }
      trust.registry = {
        devices: new Map([
          [
            trust.credential.id,
            { controller: trust.credential.id, status: 'revoked', logPosition: 2 },
          ],
        ]),
        controllers: new Map([
          [trust.credential.id, { recordedLog: [], genFloor: 2, timeFloor: 1000 }],
        ]),
      }
      const low = new Uint8Array([0])
      const high = new Uint8Array(33).fill(255)
      const spent = [low.slice(), value.state.epochAuthenticator.slice(), high.slice()]
      const db = createMemoryTransaction({ rows: {} })
      await db.transact(scope, async (tx) => {
        const stores = createGroupStateStores({ tx, groupID, atRest: codec })
        await stores.trust.save({
          ...trust,
          spentEpochAuthenticators: [high, low, high.slice(), value.state.epochAuthenticator],
        })
        await expect(
          stores.trust.save({ ...trust, genesisAnchor: new Uint8Array([0]) }),
        ).rejects.toThrow(GroupStateConflictError)
      })
      high.fill(0)
      const reopened = createMemoryTransaction({ rows: db.snapshot() })
      await reopened.transact(scope, async (tx) => {
        const stores = createGroupStateStores({ tx, groupID, atRest: codec })
        const loaded = await stores.trust.load()
        expect(loaded).toEqual({
          ...trust,
          spentEpochAuthenticators: spent,
        })
        loaded?.genesisAnchor.fill(0)
        expect((await stores.trust.load())?.genesisAnchor).toEqual(trust.genesisAnchor)
      })
      const node = trust.signerTree.find((entry) => entry !== undefined)
      if (node === undefined) throw new Error('Expected public node')
      const privateTree = [{ ...node, privateKey: new Uint8Array(32) }]
      expect(() => assertTrustTransition(null, { ...trust, signerTree: privateTree })).toThrow(
        GroupStateConflictError,
      )
    })

    test('serialises overlapping state saves across store instances without losing the ceiling', async () => {
      const value = await seed()
      const db = createMemoryTransaction({ rows: {} })
      await db.transact(scope, async (tx) => {
        const initial = createGroupStateStores({ tx, groupID, atRest: codec })
        await initial.state(1).save(value.state)
        await initial.trust.save(value.trust)
        const pause = pausedSeal()
        const firstStores = createGroupStateStores({ tx, groupID, atRest: pause.atRest })
        const secondStores = createGroupStateStores({ tx, groupID, atRest: pause.atRest })
        const accepted = { ...value.state, version: 2, senderHWM: 64 }
        const first = firstStores.state(1).save(accepted)
        await pause.entered
        const second = secondStores
          .state(1)
          .save({ ...value.state, version: 2, senderHWM: 32 })
          .catch((error: unknown) => error)
        pause.release()
        await first
        expect(await second).toBeInstanceOf(GroupStateConflictError)
        expect(await secondStores.state(1).load()).toEqual(accepted)
        await secondStores.state(1).save({ ...accepted, version: 3 })
      })
      await db.transact(scope, async (tx) => {
        const stores = createGroupStateStores({ tx, groupID, atRest: codec })
        expect(await stores.state(1).load()).toEqual({ ...value.state, version: 3, senderHWM: 64 })
      })
    })

    test('serialises overlapping trust saves across store instances without losing spent identities', async () => {
      const value = await seed()
      const firstAuthenticator = new Uint8Array([1])
      const secondAuthenticator = new Uint8Array([2])
      const both = {
        ...value.trust,
        spentEpochAuthenticators: [
          ...value.trust.spentEpochAuthenticators,
          firstAuthenticator,
          secondAuthenticator,
        ],
      }
      const db = createMemoryTransaction({ rows: {} })
      await db.transact(scope, async (tx) => {
        const initial = createGroupStateStores({ tx, groupID, atRest: codec })
        await initial.trust.save(value.trust)
        const pause = pausedSeal()
        const firstStores = createGroupStateStores({ tx, groupID, atRest: pause.atRest })
        const secondStores = createGroupStateStores({ tx, groupID, atRest: pause.atRest })
        const first = firstStores.trust.save({
          ...value.trust,
          spentEpochAuthenticators: [...value.trust.spentEpochAuthenticators, firstAuthenticator],
        })
        await pause.entered
        const second = secondStores.trust
          .save({
            ...value.trust,
            spentEpochAuthenticators: [
              ...value.trust.spentEpochAuthenticators,
              secondAuthenticator,
            ],
          })
          .catch((error: unknown) => error)
        pause.release()
        await first
        expect(await second).toBeInstanceOf(GroupStateConflictError)
        expect((await secondStores.trust.load())?.spentEpochAuthenticators).toEqual(
          expect.arrayContaining([...value.trust.spentEpochAuthenticators, firstAuthenticator]),
        )
        await secondStores.trust.save(both)
      })
      await db.transact(scope, async (tx) => {
        const stores = createGroupStateStores({ tx, groupID, atRest: codec })
        expect((await stores.trust.load())?.spentEpochAuthenticators).toHaveLength(3)
        expect((await stores.trust.load())?.spentEpochAuthenticators).toEqual(
          expect.arrayContaining(both.spentEpochAuthenticators),
        )
      })
    })

    test.each(['state', 'trust'] as const)(
      'drains unfinished %s work and refuses access while the entry changes phase',
      async (namespace) => {
        const value = await seed()
        const db = createMemoryTransaction({ rows: {} })
        const owners = createOwnerQueues()
        const groups = createMemoryGroupPersistence({
          db,
          owners,
          atRest: codec,
          providerID: 'memory',
        })
        await installSeed(groups, value, 'seed')
        const pause = pausedSeal()
        const paused = createMemoryGroupPersistence({
          db,
          owners,
          atRest: pause.atRest,
          providerID: 'memory',
        })
        const change = await nextChange(groups, groupID, 'suspended')
        let escaped: GroupStateStores | undefined
        let pending: Promise<unknown> | undefined
        let returned = false
        const transition = paused
          .transition(change, async (stores) => {
            escaped = createGroupStateStores({
              tx: { ...stores.tx },
              groupID,
              atRest: pause.atRest,
            })
            pending = (
              namespace === 'state'
                ? stores.incarnation(1).state.save({ ...value.state, version: 2 })
                : escaped.trust.save(value.trust)
            ).catch((error: unknown) => error)
            await pause.entered
          })
          .then(() => {
            returned = true
          })
        await pause.entered
        await new Promise<void>((resolve) => setImmediate(resolve))
        if (escaped === undefined || pending === undefined) throw new Error('Expected stores')
        try {
          expect(returned).toBe(false)
          const row = namespace === 'state' ? escaped.state(1) : escaped.trust
          const result = await Promise.race([
            row.load().catch((error: unknown) => error),
            new Promise<null>((resolve) => setImmediate(() => resolve(null))),
          ])
          expect(result).toMatchObject({ name: 'PersistencePhaseError' })
        } finally {
          pause.release()
          expect(await pending).toBeUndefined()
          await transition
        }
        await expect(escaped.lifetime.load()).rejects.toMatchObject({
          name: 'PersistencePhaseError',
        })
        expect((await groups.loadState(value.key))?.version).toBe(namespace === 'state' ? 2 : 1)
        expect(await groups.loadTrust(groupID)).toEqual(value.trust)
      },
    )

    test('rolls back state and trust when sealing a later row fails', async () => {
      const value = await seed()
      const db = createMemoryTransaction({ rows: {} })
      await db.transact(scope, async (tx) => {
        const stores = createGroupStateStores({ tx, groupID, atRest: codec })
        await stores.state(1).save(value.state)
        await stores.trust.save(value.trust)
      })
      const before = db.snapshot()
      const failing = {
        ...codec,
        seal: async (bytes: Uint8Array, aad: Uint8Array) => {
          if (new TextDecoder().decode(aad).includes('"trust"')) throw new Error('seal failed')
          return codec.seal(bytes, aad)
        },
      }
      await expect(
        db.transact(scope, async (tx) => {
          const stores = createGroupStateStores({ tx, groupID, atRest: failing })
          await stores.state(1).save({ ...value.state, version: 2, state: null })
          await stores.trust.save(value.trust)
        }),
      ).rejects.toThrow('seal failed')
      expect(db.snapshot()).toEqual(before)
      await db.transact(scope, async (tx) => {
        const stores = createGroupStateStores({ tx, groupID, atRest: codec })
        expect(await stores.state(1).load()).toEqual(value.state)
        expect(await stores.trust.load()).toEqual(value.trust)
      })
    })

    test('binds rows to group and incarnation and expires them with the callback', async () => {
      const value = await seed()
      const db = createMemoryTransaction({ rows: {} })
      let escaped: GroupStateStores | undefined
      await db.transact(scope, async (tx) => {
        const stores = createGroupStateStores({ tx, groupID, atRest: codec })
        escaped = stores
        expect(() => createGroupStateStores({ tx, groupID: 'group-B', atRest: codec })).toThrow()
        await expect(stores.state(1).save({ ...value.state, groupID: 'group-B' })).rejects.toThrow(
          GroupStateConflictError,
        )
        await expect(stores.state(2).save(value.state)).rejects.toThrow(GroupStateConflictError)
        await expect(
          stores.lifetime.save({ ...value.lifetime, groupID: 'group-B' }),
        ).rejects.toThrow(GroupStateConflictError)
        await expect(stores.trust.save({ ...value.trust, groupID: 'group-B' })).rejects.toThrow(
          GroupStateConflictError,
        )
      })
      if (escaped === undefined) throw new Error('Expected stores')
      await expect(escaped.trust.load()).rejects.toThrow('expired')
      await expect(escaped.state(1).load()).rejects.toThrow('expired')
      await expect(escaped.lifetime.save(value.lifetime)).rejects.toThrow('expired')
    })
  })
}
