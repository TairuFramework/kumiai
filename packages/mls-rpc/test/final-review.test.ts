import type { Outcome } from '@kumiai/rpc'
import { assertPartialLossSpentRefused } from '@kumiai/rpc-conformance'
import { describe, expect, test } from 'vitest'

import { createMemoryDevicePersistence } from '../src/memory-device-persistence.js'
import { memoryFaults } from '../src/memory-faults.js'
import { createMemoryGroupPersistence } from '../src/memory-group-persistence.js'
import { createGroupStateStores } from '../src/memory-group-state.js'
import { createMemoryTransaction } from '../src/memory-transaction.js'
import { createOwnerQueues, type OwnerQueues } from '../src/owner-queue.js'
import { physicalRecordKey } from '../src/persistence-codec.js'
import type {
  DeviceStores,
  GroupLifetime,
  GroupStores,
  MemoryDatabase,
  MemoryTransaction,
} from '../src/persistence-types.js'
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

    test('nested sibling control writes both persist', async () => {
      const { db, groups } = await setup()
      const mutationID = 'nested-control'
      const outcomes: Array<Outcome> = [
        { id: 'operation-1', opID: 'operation-1', at: 1000, kind: 'unknown' },
        { id: 'operation-2', opID: 'operation-2', at: 1001, kind: 'unknown' },
      ]
      await groups.transition(await nextChange(groups, groupID, mutationID), async (stores) => {
        const entry = ownerQueues(db).current()
        if (entry === undefined) throw new Error('Missing owner entry')
        await entry.sequence(async () => {
          const control = stores.incarnation(1).control
          await Promise.all(
            outcomes.map((outcome) => control.apply({ putOutcomes: [outcome] }, mutationID)),
          )
        })
      })
      expect((await groups.ports(key).control.load()).outcomes).toEqual(outcomes)
    })

    test('a suspended nested child holds outcome, hooks, caller and queued reads', async () => {
      const { db, groups } = await setup()
      const owners = ownerQueues(db)
      const reached = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      let sealingHeld = false
      const outcome: Outcome = { id: 'operation-1', opID: 'operation-1', at: 1000, kind: 'unknown' }
      const guarded = createMemoryGroupPersistence({
        owners,
        db,
        providerID: 'memory',
        atRest: {
          ...atRest,
          async seal(bytes, aad) {
            if (!sealingHeld && JSON.parse(new TextDecoder().decode(aad))[3] === 'control') {
              sealingHeld = true
              reached.resolve()
              await resume.promise
            }
            return atRest.seal(bytes, aad)
          },
        },
      })
      const order: Array<string> = []
      let child!: Promise<unknown>
      let entry!: NonNullable<ReturnType<OwnerQueues['current']>>
      const mutationID = 'nested-suspended'
      const change = await nextChange(groups, groupID, mutationID)
      const transition = guarded
        .transition(change, async (stores) => {
          const current = owners.current()
          if (current === undefined) throw new Error('Missing owner entry')
          entry = current
          stores.tx.onCommit(() => {
            order.push('hook')
          })
          await entry.sequence(async () => {
            child = stores
              .incarnation(1)
              .control.apply({ putOutcomes: [outcome] }, mutationID)
              .then(
                () => {
                  order.push('child')
                },
                (error: unknown) => error,
              )
            await reached.promise
          })
        })
        .then(() => {
          order.push('caller')
        })
      await reached.promise
      const reading = groups
        .ports(key)
        .control.load()
        .then((value) => {
          order.push('read')
          return value
        })
      let heldPhase: string
      let heldOrder: Array<string>
      try {
        await new Promise<void>((resolve) => setImmediate(resolve))
        heldPhase = entry.phase
        heldOrder = [...order]
      } finally {
        resume.resolve()
        await Promise.all([transition, reading, child])
      }
      expect(heldPhase).toBe('work')
      expect(heldOrder).toEqual([])
      expect(await child).toBeUndefined()
      expect((await reading).outcomes).toEqual([outcome])
      expect(order).toEqual(['child', 'hook', 'caller', 'read'])
    })

    test.each(
      (['seal', 'open'] as const).flatMap((callback) =>
        (['constructed lifetime', 'supplied cleanup'] as const).map((access) => ({
          callback,
          access,
        })),
      ),
    )(
      'account codec $callback refuses host writes through $access',
      async ({ callback, access }) => {
        const { db, groups } = await setup()
        const owners = ownerQueues(db)
        const ownerDID = 'did:example:owner'
        let supplied!: DeviceStores<MemoryTransaction>
        let attempted = false
        const results: Array<unknown> = []
        async function hostWrite(aad: Uint8Array) {
          const namespace = JSON.parse(new TextDecoder().decode(aad))[3]
          if (
            attempted ||
            owners.current()?.phase !== 'account' ||
            namespace !== (callback === 'seal' ? 'device' : 'lifetime')
          )
            return
          attempted = true
          await Promise.resolve()
          const attempt = async () => {
            if (access === 'constructed lifetime') {
              const rows = createGroupStateStores({ tx: { ...supplied.tx }, groupID, atRest })
              const life = await rows.lifetime.load()
              if (life === null) throw new Error('Missing lifetime')
              await rows.lifetime.save({ ...life, restorePending: true })
            } else {
              await supplied.cleanup.put({
                id: 'cleanup-1',
                ownerDID,
                sourceID: 'source-1',
                ref: 'package-ref-1',
                kind: 'ordinary',
                groupID,
                notAfter: 10000,
              })
            }
          }
          results.push(await attempt().catch((error: unknown) => error))
        }
        const device = createMemoryDevicePersistence({
          db,
          providerID: 'memory',
          ownerDID,
          atRest: {
            async seal(bytes, aad) {
              if (callback === 'seal') await hostWrite(aad)
              return atRest.seal(bytes, aad)
            },
            async open(bytes, aad) {
              if (callback === 'open') await hostWrite(aad)
              return atRest.open(bytes, aad)
            },
          },
        })
        const mutationID = `codec-${callback}-${access}`
        await device.transition(
          {
            mutationID,
            expectedRevision: 0,
            group: await nextChange(groups, groupID, mutationID),
          },
          async (stores) => {
            supplied = stores
          },
        )
        expect(attempted).toBe(true)
        expect(results).toEqual([expect.objectContaining({ name: 'PersistencePhaseError' })])
        expect((await groups.load(groupID))?.restorePending).toBe(false)
        expect(
          await device.transition(
            {
              mutationID: 'inspect-cleanup',
              expectedRevision: 1,
              group: null,
            },
            async (stores) => stores.cleanup.list(),
          ),
        ).toEqual([])
      },
    )

    test('a hook scheduled root read succeeds after release while transaction capabilities stay expired', async () => {
      const { db, groups } = await setup()
      const owners = ownerQueues(db)
      const background = Promise.withResolvers<GroupLifetime | null>()
      let supplied!: GroupStores<MemoryTransaction>
      let context: ReturnType<OwnerQueues['current']>
      let captured!: NonNullable<ReturnType<OwnerQueues['current']>>
      const read = background.promise.catch((error: unknown) => error)
      const change = await nextChange(groups, groupID, 'hook-background-read')
      await groups.transition(change, async (stores) => {
        supplied = stores
        const current = owners.current()
        if (current === undefined) throw new Error('Missing owner entry')
        captured = current
        stores.tx.onCommit(() => {
          setImmediate(() => {
            context = owners.current()
            void groups.load(groupID).then(background.resolve, background.reject)
          })
        })
      })
      expect(captured.phase).toBe('released')
      expect(await read).toMatchObject({ groupID, mutationID: 'hook-background-read', revision: 2 })
      expect(context).toBeUndefined()
      await expect(supplied.lifetime.load()).rejects.toMatchObject({
        name: 'PersistencePhaseError',
      })
      await expect(captured.sequence(async () => undefined)).rejects.toMatchObject({
        name: 'PersistencePhaseError',
      })
      expect(() => supplied.tx.rows.lifetime).toThrow('expired')
    })

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
        createFixture: (id, options) => createStorageFixture({ id, mode, ...options }),
      })
    }, 5000)
  })
}
