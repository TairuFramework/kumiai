import { decodeClientState, decodeEpochRosterFact, restoreGroup } from '@kumiai/mls'
import { type CheckpointRecord, foldForkNotices } from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import {
  incrementOthersSeen,
  incrementOthersSeenBy,
  projectBranchHistory,
  recordOwnBranchMessage,
} from '../src/branch-history.js'
import { createCheckpointService } from '../src/checkpoint.js'
import { assertCheckpointUpdates } from '../src/checkpoint-store.js'
import { createGroupCrypto } from '../src/crypto.js'
import { entryCapability } from '../src/entry-capability.js'
import type { AppOutboxEntry, PendingAppFrame } from '../src/persistence-types.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createRealGroup, testHandleAccess } from './fixtures/real-group.js'
import { createForkNoticeFixture, createRegistryFixture } from './fixtures/registry.js'
import { createStorageFixture } from './fixtures/storage-persistence.js'
import { nextChange } from './fixtures/storage-seed.js'

for (const mode of ['real-mls', 'double'] as const) {
  for (const ownership of ['supplied', 'absent'] as const) {
    describe(`branch history (${mode}, ${ownership} ownership context)`, () => {
      async function setup() {
        const groupID = `branch-history-${crypto.randomUUID()}`
        let fixture = await createRegistryFixture({
          groupID,
          mode,
          setup: 'empty',
          ownershipContext:
            ownership === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        })
        const key = await fixture.registry.seed(await fixture.makeHandle(0), { packageUse: null })
        const groups = fixture.device.groups
        const records = () => {
          const entry = entryCapability(fixture.device.groups)
          if (entry === null) throw new Error('Missing entry')
          return entry.read(groupID, (reads) => reads.checkpoints())
        }
        const row = (await records()).find((row) => row.kind === 'fact')
        if (row?.kind !== 'fact') throw new Error('Missing installed fact')
        const fact = decodeEpochRosterFact(row.canonical)
        const own = { id: 'prospective-publish', epoch: fact.epoch, authHash: fact.authHash }
        const outbox: AppOutboxEntry = {
          seq: 1,
          protocol: 'chat',
          prc: 'posted',
          data: new TextEncoder().encode('plaintext-sentinel'),
          status: 'accepted',
          lastAttempt: {
            incarnation: key.incarnation,
            epoch: fact.epoch,
            floor: null,
            attempts: 1,
            publishID: own.id,
            segment: fact.epoch,
            topicID: 'chat-topic',
          },
        }
        const received = (id: number): PendingAppFrame => ({
          frame: {
            ...key,
            id: `received-${id}`,
            protocol: 'chat',
            procedure: 'posted',
            topicID: 'received-topic',
            segment: fact.epoch,
            position: String(id),
          },
          payload: new Uint8Array([1]),
          senderDID: 'did:key:other-member',
          epoch: fact.epoch,
          idempotencyKey: `received-${id}`,
        })
        const write = async (work: Parameters<typeof groups.transition>[1]) => {
          const current = fixture.device.groups
          return current.transition(await nextChange(current, groupID, crypto.randomUUID()), work)
        }
        const createService = () =>
          createCheckpointService({
            registry: fixture.registry,
            key,
            identity: fixture.identity,
          })
        let service = createService()
        return {
          get fixture() {
            return fixture
          },
          get groups() {
            return fixture.device.groups
          },
          get service() {
            return service
          },
          async reopen() {
            fixture = await fixture.reopen()
            service = createService()
          },
          key,
          records,
          fact,
          own,
          outbox,
          received,
          write,
        }
      }

      test('acked app events do not erase prospective message IDs', async () => {
        const h = await setup()
        try {
          const outbox = h.groups.ports(h.key).outbox
          await outbox.put(h.outbox)
          await outbox.remove(1)
          for (const event of await outbox.events()) await outbox.ackEvent(event.id)
          expect(await outbox.list()).toEqual([])
          expect(await outbox.events()).toEqual([])
          await h.reopen()
          expect((await h.records()).filter((row) => row.kind === 'own-branch-messages')).toEqual([
            expect.objectContaining({
              key: h.key,
              epoch: h.fact.epoch,
              authHash: h.fact.authHash,
              messages: [h.own],
            }),
          ])
        } finally {
          await h.fixture.close()
        }
      })

      test('ten thousand received messages keep one epoch counter', async () => {
        const h = await setup()
        try {
          const before = (await h.records()).length
          await h.write(async (stores) => {
            const pending = stores.incarnation(h.key.incarnation).pending
            await pending.put(Array.from({ length: 10000 }, (_, index) => h.received(index + 1)))
            await pending.complete(
              Array.from({ length: 10000 }, (_, index) => h.received(index + 1).frame.id),
            )
            await stores.incarnation(h.key.incarnation).cursor.save('received-topic', '10000')
          })
          const records = await h.records()
          expect(records.filter((row) => row.kind === 'others-seen')).toEqual([
            expect.objectContaining({
              epoch: h.fact.epoch,
              authHash: h.fact.authHash,
              count: 10000,
            }),
          ])
          expect(records.length - before).toBeLessThanOrEqual(2)
          expect(JSON.stringify(records.filter((row) => row.kind === 'others-seen'))).not.toContain(
            'received-',
          )
        } finally {
          await h.fixture.close()
        }
      })

      test('received replay never increments twice', async () => {
        const h = await setup()
        try {
          await expect(
            h.write(async (stores) => {
              await stores.incarnation(1).pending.put([h.received(1)])
              throw new Error('rollback received')
            }),
          ).rejects.toThrow('rollback received')
          expect((await h.records()).filter((row) => row.kind === 'others-seen')).toEqual([])
          await h.write((stores) =>
            stores.incarnation(1).pending.put([h.received(1), h.received(1)]),
          )
          await h.reopen()
          await h.write((stores) => stores.incarnation(1).pending.put([h.received(1)]))
          await h.write(async (stores) => {
            await stores.incarnation(1).pending.complete(['received-1'])
            await stores.incarnation(1).cursor.save('received-topic', '1')
          })
          await h.write((stores) => stores.incarnation(1).pending.put([h.received(1)]))
          expect((await h.records()).filter((row) => row.kind === 'others-seen')).toEqual([
            expect.objectContaining({ count: 1 }),
          ])
        } finally {
          await h.fixture.close()
        }
      })

      test('ephemeral sends leave no journal rows', async () => {
        const h = await setup()
        try {
          const before = await h.fixture.inspectRows()
          const access = await h.fixture.registry.access(h.key.groupID)
          let handle = await access.read((handle) => handle)
          const ephemeral = createGroupCrypto({
            access: testHandleAccess({
              handle: () => handle,
              adopt: (next) => {
                handle = next
              },
            }),
          })
          await ephemeral.wrap(new Uint8Array([1]), { aad: new Uint8Array() })
          expect(await h.fixture.inspectRows()).toEqual(before)
        } finally {
          await h.fixture.close()
        }
      })

      test('own message journal contains no plaintext', async () => {
        const h = await setup()
        try {
          await h.groups.ports(h.key).outbox.put(h.outbox)
          const rows = (await h.records()).filter((row) => row.kind === 'own-branch-messages')
          expect(rows).toHaveLength(1)
          expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
            'authHash',
            'epoch',
            'id',
            'key',
            'kind',
            'messages',
          ])
          expect(rows[0]?.messages).toEqual([h.own])
          const extra = { ...h.own, id: 'extra-publish', plaintext: 'plaintext-sentinel' }
          await h.write((stores) => recordOwnBranchMessage(stores, { key: h.key, message: extra }))
          const journal = (await h.records()).find((row) => row.kind === 'own-branch-messages')
          expect(journal?.messages).toEqual([h.own, { ...h.own, id: 'extra-publish' }])
          expect(JSON.stringify(rows)).not.toContain('plaintext-sentinel')
          for (const bytes of (await h.fixture.inspectRows()).checkpoints?.values() ?? [])
            expect(bytes).toBeInstanceOf(Uint8Array)
        } finally {
          await h.fixture.close()
        }
      })

      test('own messages update at risk without notification', async () => {
        const h = await createForkNoticeFixture({
          mode,
          ownershipContext:
            ownership === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        })
        try {
          const earlier = await h.journalOwnMessage('before-detection')
          await h.service().importCheckpoint(h.key, h.frame)
          const before = (await h.service().forkNotices(h.key.groupID))[0]
          expect(before?.atRisk).toEqual([earlier])
          const events = await h.service().events(h.key.groupID)
          expect(events[0]?.notice.atRisk).toEqual([earlier])
          const emitted = h.emitted.length
          await h.advance(1)
          const later = await h.journalOwnMessage('after-detection')
          const after = (await h.service().forkNotices(h.key.groupID))[0]
          expect(after?.atRisk).toEqual([earlier, later])
          expect(after?.revision).toBe(before?.revision)
          expect(after?.coverage.ownMessages).toEqual({ kind: 'complete' })
          expect(await h.service().events(h.key.groupID)).toEqual(events)
          expect(h.emitted).toHaveLength(emitted)
        } finally {
          await h.close()
        }
      })

      test('own echoes do not count as others and unattempted sends have no own IDs', async () => {
        const h = await setup()
        try {
          await h.groups.ports(h.key).outbox.put({ ...h.outbox, lastAttempt: null })
          await h.write((stores) =>
            stores
              .incarnation(1)
              .pending.put([{ ...h.received(1), senderDID: h.fixture.identity.id }]),
          )
          expect(
            (await h.records()).filter(
              (row) => row.kind === 'own-branch-messages' || row.kind === 'others-seen',
            ),
          ).toEqual([])
        } finally {
          await h.fixture.close()
        }
      })

      test('journal rows expire with their supporting installation after supersession', async () => {
        const startedAt = Date.now()
        const now = vi.spyOn(Date, 'now').mockReturnValue(startedAt)
        const h = await setup()
        try {
          await h.groups.ports(h.key).outbox.put(h.outbox)
          await h.write((stores) => stores.incarnation(1).pending.put([h.received(1)]))
          const access = await h.fixture.registry.access(h.key.groupID)
          const built = await h.fixture.acceptedOrdinary(access)
          await access.adopt(built.candidate, built.expected, built.write)
          now.mockReturnValue(startedAt + 604800000 - 1)
          await h.write(async () => {})
          expect(
            (await h.records()).filter(
              (row) => row.kind === 'own-branch-messages' || row.kind === 'others-seen',
            ),
          ).toHaveLength(2)
          now.mockReturnValue(startedAt + 604800000)
          await h.write(async () => {})
          expect(
            (await h.records()).filter(
              (row) => row.kind === 'own-branch-messages' || row.kind === 'others-seen',
            ),
          ).toEqual([])
        } finally {
          now.mockRestore()
          await h.fixture.close()
        }
      })

      test('journal write authority cannot be reused after finalisation validation', async () => {
        const h = await setup()
        try {
          const before = await h.fixture.inspectRows()
          await expect(
            h.write(async (stores) => {
              await recordOwnBranchMessage(stores, { key: h.key, message: h.own })
              const rows = (await stores.checkpoints.list()).filter(
                (row) => row.kind === 'own-branch-messages',
              )
              assertCheckpointUpdates([], rows, stores.tx)
              // A later phase must not resurrect a row pruned by the coordinator.
              assertCheckpointUpdates([], rows, stores.tx)
            }),
          ).rejects.toThrow('authority')
          expect(await h.fixture.inspectRows()).toEqual(before)
        } finally {
          await h.fixture.close()
        }
      })

      test('dedicated journal refuses retired incarnations even while facts remain retained', async () => {
        const h = await setup()
        try {
          await h.groups.transition(
            await nextChange(h.groups, h.key.groupID, 'retire-journal'),
            async (stores) => {
              const life = await stores.lifetime.load()
              if (life === null) throw new Error('Missing lifetime')
              await stores.lifetime.save({
                ...life,
                revision: life.revision + 1,
                mutationID: 'retire-journal',
                activeIncarnation: null,
              })
            },
          )
          expect((await h.records()).some((row) => row.kind === 'fact')).toBe(true)
          await expect(
            h.write((stores) => recordOwnBranchMessage(stores, { key: h.key, message: h.own })),
          ).rejects.toThrow('installed metadata')
        } finally {
          await h.fixture.close()
        }
      })

      test('journal guards reject empty IDs foreign bindings and counter overflow atomically', async () => {
        const h = await setup()
        try {
          const before = await h.fixture.inspectRows()
          await expect(
            h.write((stores) =>
              recordOwnBranchMessage(stores, { key: h.key, message: { ...h.own, id: '' } }),
            ),
          ).rejects.toThrow('publish ID')
          await expect(
            h.write((stores) =>
              recordOwnBranchMessage(stores, { key: { ...h.key, incarnation: 2 }, message: h.own }),
            ),
          ).rejects.toThrow('installed metadata')
          await expect(
            h.write((stores) =>
              incrementOthersSeen(stores, {
                key: { ...h.key, groupID: 'foreign' },
                epoch: h.fact.epoch,
                authHash: h.fact.authHash,
              }),
            ),
          ).rejects.toThrow('installed metadata')
          expect(await h.fixture.inspectRows()).toEqual(before)
          await h.write((stores) =>
            incrementOthersSeenBy(
              stores,
              { key: h.key, epoch: h.fact.epoch, authHash: h.fact.authHash },
              Number.MAX_SAFE_INTEGER,
            ),
          )
          await expect(
            h.write((stores) =>
              incrementOthersSeen(stores, {
                key: h.key,
                epoch: h.fact.epoch,
                authHash: h.fact.authHash,
              }),
            ),
          ).rejects.toThrow('overflow')
          expect((await h.records()).find((row) => row.kind === 'others-seen')).toMatchObject({
            count: Number.MAX_SAFE_INTEGER,
          })
        } finally {
          await h.fixture.close()
        }
      })

      test('dedicated journal functions require installed branch metadata and are idempotent for own IDs', async () => {
        const h = await setup()
        try {
          await h.write(async (stores) => {
            await recordOwnBranchMessage(stores, { key: h.key, message: h.own })
            await recordOwnBranchMessage(stores, { key: h.key, message: h.own })
            await incrementOthersSeen(stores, {
              key: h.key,
              epoch: h.fact.epoch,
              authHash: h.fact.authHash,
            })
          })
          expect(
            (await h.records()).find((row) => row.kind === 'own-branch-messages'),
          ).toMatchObject({ messages: [h.own] })
          const before = await h.fixture.inspectRows()
          await expect(
            h.write((stores) =>
              recordOwnBranchMessage(stores, {
                key: h.key,
                message: { ...h.own, authHash: 'wrong-branch' },
              }),
            ),
          ).rejects.toThrow()
          expect(await h.fixture.inspectRows()).toEqual(before)
          const journals = (await h.records()).filter((row) =>
            ['own-branch-messages', 'others-seen', 'branch-coverage'].includes(row.kind),
          )
          expect(journals).toHaveLength(3)
          for (const row of journals) {
            await expect(h.service.updateRecords({ put: [row] })).rejects.toThrow('authority')
            await expect(h.service.updateRecords({ remove: [row.id] })).rejects.toThrow('authority')
            await expect(h.write((stores) => stores.checkpoints.remove([row.id]))).rejects.toThrow(
              'authority',
            )
          }
          const forged: CheckpointRecord = {
            kind: 'others-seen',
            id: 'forged',
            key: h.key,
            epoch: 0,
            authHash: h.fact.authHash,
            count: 12,
          }
          await expect(h.write((stores) => stores.checkpoints.put(forged))).rejects.toThrow(
            'authority',
          )
        } finally {
          await h.fixture.close()
        }
      })
    })
  }
}

test('missing older metadata keeps same-epoch coverage partial after the first journal write', async () => {
  const fixture = await createStorageFixture({ id: 'legacy-journal', mode: 'double' })
  try {
    const records = () => fixture.entry().read('legacy-journal', (reads) => reads.checkpoints())
    const marker = (await records()).find((row) => row.kind === 'branch-coverage')
    if (marker === undefined) throw new Error('Missing journal coverage marker')
    await fixture.deleteCommittedRow(
      'checkpoints',
      JSON.stringify(['legacy-journal', null, marker.id]),
    )
    const ports = await fixture.reopen()
    const groups = ports.device.groups
    const key = { groupID: 'legacy-journal', incarnation: 1 }
    await groups.ports(key).outbox.put({
      seq: 2,
      protocol: 'chat',
      prc: 'posted',
      data: new Uint8Array([1]),
      status: 'accepted',
      lastAttempt: {
        incarnation: 1,
        epoch: 3,
        publishID: 'first-after-upgrade',
        attempts: 1,
        floor: null,
        segment: 3,
        topicID: 'chat',
      },
    })
    const row = (await records()).find((row) => row.kind === 'fact')
    if (row?.kind !== 'fact') throw new Error('Missing installed fact')
    const fact = decodeEpochRosterFact(row.canonical)
    const folded = foldForkNotices({
      key,
      records: await records(),
      now: Date.now(),
      statements: [
        {
          epoch: 3,
          authHash: 'another-branch',
          localAuthHash: fact.authHash,
          parentAuthHash: null,
          signerDID: 'other',
          keyHash: 'other-key',
          frameID: 'other-frame',
        },
      ],
    })
    const notice = projectBranchHistory(folded.records).find((row) => row.kind === 'notice')
    expect(notice?.notice.atRisk).toEqual([
      { id: 'first-after-upgrade', epoch: 3, authHash: fact.authHash },
    ])
    expect(notice?.notice.coverage.ownMessages).toEqual({
      kind: 'partial',
      reasons: ['pre-journal-history'],
    })
  } finally {
    await fixture.close()
  }
})

test('authenticated MLS replay after rollback completion and restart never recounts', async () => {
  const real = await createRealGroup(1, 'branch-authenticated-replay')
  const receiver = real.members[0]
  if (receiver === undefined) throw new Error('Missing receiver')
  let fixture = await createRegistryFixture({
    groupID: real.committer.handle.groupID,
    mode: 'real-mls',
    setup: 'empty',
    identity: receiver.identity,
    options: { resolveLedgerEntries: real.resolveLedgerEntries },
  })
  try {
    const key = await fixture.registry.seed(
      await restoreGroup({
        state: receiver.handle.state,
        credential: receiver.handle.credential,
        ledgerEntries: receiver.handle.ledgerTokens,
        options: fixture.environment.options,
      }),
      { packageUse: { sourceID: 'branch-replay', ref: 'joined-member', kind: 'ordinary' } },
    )
    const payload = await real.committer.handle.encrypt(new Uint8Array([42]))
    const receive = async (frameID: string, rollback = false) => {
      const groups = fixture.device.groups
      const record = await groups.loadState(key)
      if (record === null || record.deleted || record.state === null)
        throw new Error('Missing receiver state')
      const state = decodeClientState(record.state)
      if (state === undefined) throw new Error('Invalid receiver state')
      const handle = await restoreGroup({
        state,
        credential: record.credential,
        ledgerEntries: record.ledger,
        options: fixture.environment.options,
      })
      await groups.transition(
        await nextChange(groups, key.groupID, crypto.randomUUID()),
        async (stores) => {
          await handle.decryptStaged(payload, {}, async (staged, opened) => {
            await stores
              .incarnation(1)
              .state.save({ ...record, version: record.version + 1, state: staged })
            await stores.incarnation(1).pending.put([
              {
                frame: {
                  ...key,
                  id: frameID,
                  protocol: 'chat',
                  procedure: 'posted',
                  topicID: 'chat',
                  segment: record.epoch,
                  position: '1',
                },
                payload: opened.payload,
                senderDID: opened.senderDID,
                epoch: record.epoch,
                idempotencyKey: frameID,
              },
            ])
          })
          if (rollback) throw new Error('rollback authenticated receive')
        },
      )
    }
    await expect(receive('first', true)).rejects.toThrow('rollback authenticated receive')
    await receive('first')
    const groups = fixture.device.groups
    await groups.transition(
      await nextChange(groups, key.groupID, 'complete-authenticated'),
      async (stores) => {
        await stores.incarnation(1).pending.complete(['first'])
        await stores.incarnation(1).cursor.save('chat', '1')
      },
    )
    fixture = await fixture.reopen()
    await expect(receive('different-hub-occurrence')).rejects.toThrow()
    const entry = entryCapability(fixture.device.groups)
    if (entry === null) throw new Error('Missing entry')
    const records = await entry.read(key.groupID, (reads) => reads.checkpoints())
    expect(records.filter((row) => row.kind === 'others-seen')).toEqual([
      expect.objectContaining({ count: 1 }),
    ])
  } finally {
    await fixture.close()
  }
})

test('expiry removes copied own IDs from open and closed notices and event snapshots', async () => {
  const h = await createForkNoticeFixture({ mode: 'real-mls' })
  try {
    const message = await h.journalOwnMessage('expired-risk')
    await h.service().importCheckpoint(h.key, h.frame)
    const records = await h.service().readRecords()
    for (const row of records) {
      if (row.kind === 'fact') row.supersededAt = Date.now() - 604800000
      if (row.kind === 'notice' || row.kind === 'notice-event') {
        const notice = row.kind === 'notice' ? row.notice : row.event.notice
        notice.atRisk = [message]
      }
    }
    for (const closed of [false, true]) {
      for (const row of records)
        if (row.kind === 'notice') row.notice.closedAt = closed ? Date.now() : null
      const projected = projectBranchHistory(records)
      for (const row of projected) {
        if (row.kind !== 'notice' && row.kind !== 'notice-event') continue
        const notice = row.kind === 'notice' ? row.notice : row.event.notice
        expect(notice.atRisk).toEqual([])
        expect(notice.coverage.ownMessages).toMatchObject({
          kind: 'partial',
          reasons: expect.arrayContaining(['retention-gap']),
        })
      }
    }
  } finally {
    await h.close()
  }
})

test('at-risk projection requires matching retained ancestry and reports missing links', async () => {
  const h = await createForkNoticeFixture({ mode: 'real-mls' })
  try {
    const earlier = await h.journalOwnMessage('earlier-risk')
    await h.service().importCheckpoint(h.key, h.frame)
    await h.advance(2)
    const later = await h.journalOwnMessage('later-risk')
    const records = await h.service().readRecords()
    const complete = projectBranchHistory(records).find((row) => row.kind === 'notice')
    expect(complete?.notice.atRisk).toEqual([earlier, later])
    const missing = projectBranchHistory(
      records.filter((row) => row.kind !== 'fact' || row.epoch !== later.epoch - 1),
    )
    const partial = missing.find((row) => row.kind === 'notice')
    expect(partial?.notice.atRisk).toEqual([earlier])
    expect(partial?.notice.coverage.ownMessages).toMatchObject({
      kind: 'partial',
      reasons: expect.arrayContaining(['unknown-ancestry']),
    })
    const notice = records.find((row) => row.kind === 'notice')
    if (notice?.kind !== 'notice') throw new Error('Missing fork notice')
    notice.notice.deviceAuthHash = 'different-device-branch'
    expect(
      projectBranchHistory(records).find((row) => row.kind === 'notice')?.notice.atRisk,
    ).toEqual([])
  } finally {
    await h.close()
  }
})
