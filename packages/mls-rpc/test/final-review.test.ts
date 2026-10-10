import { assertPartialLossSpentRefused } from '@kumiai/rpc-conformance'
import { describe, expect, test } from 'vitest'

import { memoryFaults } from '../src/memory-faults.js'
import { createMemoryGroupPersistence } from '../src/memory-group-persistence.js'
import { createGroupStateStores } from '../src/memory-group-state.js'
import { createMemoryTransaction } from '../src/memory-transaction.js'
import { createOwnerQueues, type OwnerQueues } from '../src/owner-queue.js'
import { physicalRecordKey } from '../src/persistence-codec.js'
import type { GroupStores, MemoryDatabase, MemoryTransaction } from '../src/persistence-types.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
import { createStorageFixture } from './fixtures/storage-persistence.js'
import { installSeed, makeStorageSeed, nextChange } from './fixtures/storage-seed.js'

const queues = new WeakMap<object, OwnerQueues>()
function ownerQueues(db: object): OwnerQueues {
  let owners = queues.get(db)
  if (owners === undefined) {
    owners = createOwnerQueues()
    queues.set(db, owners)
  }
  return owners
}

const groupID = 'group-A'
const key = { groupID, incarnation: 1 }
const atRest = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(97) })

for (const mode of ['real-mls', 'double'] as const) {
  describe(`final review -- ${mode}`, () => {
    async function setup() {
      const db = createMemoryTransaction({ rows: {} })
      const groups = createMemoryGroupPersistence({
        owners: ownerQueues(db),
        db,
        atRest,
        providerID: 'memory',
      })
      const seed = await makeStorageSeed({ id: groupID, incarnation: 1, epoch: 3, mode })
      await installSeed(groups, seed, 'seed')
      return { db, groups, seed }
    }

    test.each(['state', 'trust', 'lifetime'] as const)(
      'F2 refuses hook %s writes through supplied and independently constructed stores',
      async (domain) => {
        const { db, groups, seed } = await setup()
        const fresh = await makeStorageSeed({ id: groupID, incarnation: 1, epoch: 4, mode })
        let supplied!: GroupStores<MemoryTransaction>
        for (const access of ['supplied', 'constructed'] as const) {
          const before = db.snapshot()
          const mutationID = `hook-${domain}-${access}`
          const guarded = createMemoryGroupPersistence({
            owners: ownerQueues(db),
            db,
            atRest,
            providerID: 'memory',
            effects: {
              async outbox(tx) {
                const rows = createGroupStateStores({ tx, groupID, atRest })
                expect(await supplied.lifetime.load()).not.toBeNull()
                expect(await rows.trust.load()).toEqual(seed.trust)
                if (domain === 'state') {
                  const state =
                    access === 'supplied' ? supplied.incarnation(1).state : rows.state(1)
                  const current = await state.load()
                  if (current === null) throw new Error('Missing state')
                  await state.save({ ...current, version: current.version + 1 })
                } else if (domain === 'trust') {
                  const trust = access === 'supplied' ? supplied.trust : rows.trust
                  await trust.save({
                    ...fresh.trust,
                    genesisAnchor: seed.trust.genesisAnchor,
                    spentEpochAuthenticators: [
                      ...seed.trust.spentEpochAuthenticators,
                      ...fresh.trust.spentEpochAuthenticators,
                    ],
                  })
                } else {
                  const lifetime = access === 'supplied' ? supplied.lifetime : rows.lifetime
                  await lifetime.save({
                    ...seed.lifetime,
                    revision: 2,
                    mutationID,
                    activeIncarnation: null,
                  })
                }
              },
            },
          })
          await expect(
            guarded.transition(await nextChange(groups, groupID, mutationID), async (stores) => {
              supplied = stores
              await stores.incarnation(1).meta.putEvents([
                {
                  ...key,
                  id: mutationID,
                  kind: 'accepted',
                  entry: {
                    seq: 7,
                    protocol: 'chat',
                    prc: 'posted',
                    data: new TextEncoder().encode('plaintext-sentinel'),
                    status: 'accepted',
                    lastAttempt: null,
                  },
                },
              ])
            }),
          ).rejects.toMatchObject({
            name: 'PersistencePhaseError',
            message: 'Cannot write domain in effects',
          })
          expect(db.snapshot()).toEqual(before)
        }
      },
      5000,
    )

    test('F2 refuses hook lifetime retirement after source tombstoning', async () => {
      const { db, groups, seed } = await setup()
      let supplied!: GroupStores<MemoryTransaction>
      const fresh = await makeStorageSeed({ id: groupID, incarnation: 2, epoch: 4, mode })
      fresh.trust.genesisAnchor = seed.trust.genesisAnchor
      fresh.trust.spentEpochAuthenticators.push(...seed.trust.spentEpochAuthenticators)
      const guarded = createMemoryGroupPersistence({
        owners: ownerQueues(db),
        db,
        atRest,
        providerID: 'memory',
        effects: {
          async delete(tx) {
            const life = await supplied.lifetime.load()
            if (life === null) throw new Error('Missing lifetime')
            await createGroupStateStores({ tx, groupID, atRest }).lifetime.save({
              ...life,
              activeIncarnation: null,
            })
          },
        },
      })
      const before = db.snapshot()
      await expect(
        guarded.transition(await nextChange(groups, groupID, 'hook-retire'), async (stores) => {
          supplied = stores
          await stores.lifetime.save({ ...fresh.lifetime, revision: 2, mutationID: 'hook-retire' })
          await stores.incarnation(2).state.save(fresh.state)
          await stores.trust.save(fresh.trust)
        }),
      ).rejects.toMatchObject({
        name: 'PersistencePhaseError',
        message: 'Cannot write domain in effects',
      })
      expect(db.snapshot()).toEqual(before)
    }, 5000)

    test.each(['switch', 'retire', 'explicit-retire'] as const)(
      'F3 %s retires unreadable private state using independently persisted source version',
      async (action) => {
        const { db, groups, seed } = await setup()
        await groups.ports(key).cursor.save('topic-secret', '2')
        const source = await groups.loadState(key)
        if (source === null) throw new Error('Missing state')
        const rows = db.snapshot()
        const address = physicalRecordKey({ ...key, namespace: 'state', recordID: 'current' })
        const ciphertext = rows.state?.get(address)
        if (!(ciphertext instanceof Uint8Array)) throw new Error('Missing ciphertext')
        rows.state?.set(address, new Uint8Array(ciphertext.length))
        const restored = createMemoryTransaction({ rows })
        const recovered = createMemoryGroupPersistence({
          owners: createOwnerQueues(),
          db: restored,
          atRest,
          providerID: 'memory',
        })
        await expect(recovered.loadState(key)).rejects.toThrow()
        expect(await recovered.loadTrust(groupID)).toEqual(seed.trust)
        if (action === 'switch') {
          const fresh = await makeStorageSeed({ id: groupID, incarnation: 2, epoch: 4, mode })
          fresh.trust.genesisAnchor = seed.trust.genesisAnchor
          fresh.trust.spentEpochAuthenticators.push(...seed.trust.spentEpochAuthenticators)
          await installSeed(recovered, fresh, 'recover')
          expect(await recovered.loadState(fresh.key)).toEqual(fresh.state)
          expect((await recovered.loadTrust(groupID))?.spentEpochAuthenticators).toEqual(
            expect.arrayContaining([seed.state.epochAuthenticator, fresh.state.epochAuthenticator]),
          )
        } else {
          const change = await nextChange(recovered, groupID, 'retire-corrupt')
          await recovered.transition(change, async (stores) => {
            const life = await stores.lifetime.load()
            if (life === null) throw new Error('Missing lifetime')
            await stores.lifetime.save({
              ...life,
              revision: life.revision + 1,
              mutationID: 'retire-corrupt',
              activeIncarnation: null,
            })
            if (action === 'explicit-retire')
              await stores
                .incarnation(1)
                .state.save({ ...key, version: source.version + 1, deleted: true })
          })
          expect((await recovered.load(groupID))?.activeIncarnation).toBeNull()
        }
        expect(await recovered.loadState(key)).toEqual({
          ...key,
          version: source.version + 1,
          deleted: true,
        })
      },
      5000,
    )

    test('F3 stages state and source metadata before either write when sealing fails', async () => {
      const { db, groups, seed } = await setup()
      let refuseMetadata = true
      const codec = {
        ...atRest,
        async seal(bytes: Uint8Array, aad: Uint8Array) {
          if (refuseMetadata && new TextDecoder().decode(aad).includes('state-version')) {
            refuseMetadata = false
            throw new Error('metadata seal failed')
          }
          return await atRest.seal(bytes, aad)
        },
      }
      const guarded = createMemoryGroupPersistence({
        owners: ownerQueues(db),
        db,
        atRest: codec,
        providerID: 'memory',
      })
      await guarded.transition(
        await nextChange(groups, groupID, 'caught-metadata-failure'),
        async (stores) => {
          await expect(
            stores.incarnation(1).state.save({ ...seed.state, version: 2, senderHWM: 32 }),
          ).rejects.toThrow('metadata seal failed')
          expect(await stores.incarnation(1).state.load()).toEqual(seed.state)
        },
      )
      expect(await groups.loadState(key)).toEqual(seed.state)
    }, 5000)

    test('F4 root and facade reads wait for delayed completion proof and commit hooks', async () => {
      const { db: backend, seed } = await setup()
      const waiting = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let resolving = false
      let claimedProof = false
      const db: MemoryDatabase = {
        ...backend,
        async transact(scope, work, options) {
          if (resolving && !claimedProof) {
            claimedProof = true
            waiting.resolve()
            await release.promise
          }
          return await backend.transact(scope, work, {
            onUnknown(settlement) {
              resolving = true
              options?.onUnknown(settlement)
            },
          })
        },
      }
      const groups = createMemoryGroupPersistence({
        owners: ownerQueues(db),
        db,
        atRest,
        providerID: 'memory',
      })
      const change = await nextChange(groups, groupID, 'proof-fence')
      memoryFaults(backend).commitThenReject()
      const order: Array<string> = []
      const write = groups
        .transition(change, async (stores) => {
          stores.tx.onCommit(() => {
            order.push('hook')
          })
          await stores.incarnation(1).state.save({ ...seed.state, version: 2 })
        })
        .then(() => {
          order.push('writer')
        })
      await waiting.promise
      const other = createMemoryGroupPersistence({
        owners: ownerQueues(db),
        db,
        atRest,
        providerID: 'memory',
      })
      const reads = [
        groups.loadState(key),
        groups.load(groupID),
        other.loadTrust(groupID),
        other.ports(key).anchor.load(),
        other.ports(key).cursor.load('topic-secret'),
      ].map((read, index) =>
        read.then((value) => {
          order.push(`read-${index}`)
          expect(order).toContain('hook')
          return value
        }),
      )
      const observed = Promise.all(reads)
      // Attach immediately: a broken fence must fail without an unhandled rejection.
      const result = observed.catch((error: unknown) => error)
      try {
        expect(await other.load('group-B')).toBeNull()
        await new Promise<void>((done) => {
          setTimeout(done, 0)
        })
        expect(order).toEqual([])
      } finally {
        release.resolve()
        await write
      }
      const values = await result
      expect(values).toBeInstanceOf(Array)
      expect((values as Array<unknown>)[0]).toMatchObject({ version: 2 })
      expect(order.slice(0, 2)).toEqual(['hook', 'writer'])
      expect(order.slice(2)).toEqual(['read-0', 'read-1', 'read-2', 'read-3', 'read-4'])
    }, 5000)

    test('refuses spent incarnation-one reinstall after partial loss retaining trust', async () => {
      await assertPartialLossSpentRefused({
        createFixture: (id) => createStorageFixture({ id, mode }),
      })
    }, 5000)
  })
}
