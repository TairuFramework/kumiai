import { describe, expect, test } from 'vitest'

import type {
  ConformanceGroupPersistence,
  ConformanceGroupStores,
  ConformanceGroupTransaction,
  ConformanceGroupTransition,
  ConformancePersistenceFixture,
  StorageConformanceParams,
  StorageTestPorts,
} from './persistence-fixture.js'

const groupID = 'group-A'
const key = { groupID, incarnation: 1 }
const topicID = 'topic-secret'
const utf8 = (value: string) => new TextEncoder().encode(value)

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    if (needle.every((byte, index) => haystack[start + index] === byte)) return true
  }
  return false
}

export async function scanSealed<TTx extends ConformanceGroupTransaction>(
  fixture: ConformancePersistenceFixture<StorageTestPorts<TTx>>,
): Promise<void> {
  const physical = await fixture.inspectRows()
  const raw = await fixture.inspectRawBytes()
  let count = 0
  for (const [namespace, rows] of Object.entries(physical)) {
    if (namespace === 'host-side' || namespace.endsWith('-owner')) continue
    for (const [address, bytes] of rows) {
      count++
      expect(bytes).toBeInstanceOf(Uint8Array)
      expect(raw.filter((row) => row.namespace === namespace && row.key === address)).toHaveLength(
        1,
      )
    }
  }
  expect(raw).toHaveLength(count)
  for (const row of raw) {
    expect(row.bytes).toBeInstanceOf(Uint8Array)
    expect(row.bytes.length).toBeGreaterThan(0)
    expect(JSON.parse(row.key)).toEqual([row.groupID, row.incarnation, row.recordID])
    for (const secret of [utf8('plaintext-sentinel'), new Uint8Array(32).fill(97), utf8(topicID)]) {
      expect(containsBytes(row.bytes, secret)).toBe(false)
      expect(row.key).not.toContain(topicID)
    }
  }
}

export async function storageChange<TTx extends ConformanceGroupTransaction>(
  groups: ConformanceGroupPersistence<TTx>,
  id: string,
  mutationID: string,
): Promise<ConformanceGroupTransition> {
  const life = await groups.load(id)
  return {
    groupID: id,
    mutationID,
    expected:
      life === null ? null : { revision: life.revision, activeIncarnation: life.activeIncarnation },
  }
}

export async function storageSeed<TTx extends ConformanceGroupTransaction>(
  groups: ConformanceGroupPersistence<TTx>,
  id = groupID,
) {
  const lifetime = await groups.load(id)
  const state = await groups.loadState({ groupID: id, incarnation: 1 })
  const trust = await groups.loadTrust(id)
  if (lifetime === null || state === null || state.deleted || trust === null)
    throw new Error('Missing storage seed')
  return { lifetime, state, trust }
}

export async function writeStorageInstall<TTx extends ConformanceGroupTransaction>(
  stores: ConformanceGroupStores<TTx>,
  seed: Awaited<ReturnType<typeof storageSeed>>,
  mutationID: string,
  incarnation = 1,
): Promise<void> {
  const previous = await stores.lifetime.load()
  const retained = await stores.trust.load()
  await stores.lifetime.save({
    ...seed.lifetime,
    latestIncarnation: incarnation,
    activeIncarnation: incarnation,
    revision: (previous?.revision ?? 0) + 1,
    mutationID,
  })
  await stores.incarnation(incarnation).state.save({ ...seed.state, incarnation, version: 1 })
  await stores.trust.save({
    ...seed.trust,
    genesisAnchor: retained?.genesisAnchor ?? seed.trust.genesisAnchor,
    installed: { ...seed.trust.installed, incarnation },
    spentEpochAuthenticators: [
      ...(retained?.spentEpochAuthenticators ?? []),
      ...seed.trust.spentEpochAuthenticators,
    ],
  })
}

export function testGroupStorageConformance<TTx extends ConformanceGroupTransaction>(
  params: StorageConformanceParams<TTx>,
): void {
  describe(`Group storage conformance -- ${params.label}`, () => {
    test('authenticates every physical byte copy and atomically commits side rows', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        const namespaces = new Set((await fixture.inspectRawBytes()).map((row) => row.namespace))
        expect([...namespaces].sort()).toEqual(
          [
            'anchor',
            'control',
            'cursor',
            'device',
            'device-cleanup',
            'device-last-resort',
            'device-package',
            'device-receipt',
            'device-restore',
            'lifetime',
            'meta',
            'outbox',
            'pending',
            'poison',
            'state',
            'trust',
          ].sort(),
        )
        await scanSealed(fixture)
        expect(await fixture.inspectSideRow('effect-1')).toBeNull()
        const effect = utf8('plaintext-sentinel')
        const groups = fixture.ports.device.groups
        await groups.transition(
          await storageChange(groups, groupID, 'complete'),
          async (stores) => {
            await params.writeSideRow(stores.tx, 'effect-1', effect)
            await stores.incarnation(1).pending.complete(['frame-1'])
            await stores.incarnation(1).cursor.save(topicID, '10')
          },
        )
        const reopened = await fixture.reopen()
        expect(await fixture.inspectSideRow('effect-1')).toEqual(effect)
        await reopened.device.groups.transition(
          await storageChange(reopened.device.groups, groupID, 'verify-complete'),
          async (stores) => {
            expect((await stores.incarnation(1).pending.list()).map((row) => row.frame.id)).toEqual(
              ['frame-2'],
            )
            expect(await stores.incarnation(1).cursor.load(topicID)).toBe('10')
            await stores.incarnation(1).pending.complete(['frame-1', 'missing'])
          },
        )
        await scanSealed(fixture)
      } finally {
        await fixture.close()
      }
    })

    test.each(['callback', 'after-first-write', 'before-commit', 'status-read'] as const)(
      'rolls back all namespaces, side rows and hooks on %s failure',
      async (point) => {
        const fixture = await params.createFixture(groupID)
        try {
          const groups = fixture.ports.device.groups
          const change = await storageChange(groups, groupID, 'rollback')
          const before = await fixture.inspectRows()
          const hooks: Array<string> = []
          if (point !== 'callback') fixture.failNext(point)
          await expect(
            groups.transition(change, async (stores) => {
              stores.tx.onCommit(() => {
                hooks.push('commit')
              })
              stores.tx.onRollback(() => {
                hooks.push('rollback')
              })
              const rows = stores.incarnation(1)
              const state = await rows.state.load()
              const trust = await stores.trust.load()
              if (state === null || state.deleted || trust === null) throw new Error('Missing seed')
              await rows.state.save({ ...state, version: state.version + 1, senderHWM: 32 })
              await stores.trust.save({ ...trust, ledger: [...trust.ledger, ...trust.ledger] })
              await rows.control.apply(
                { putOutcomes: [{ id: 'outcome-2', opID: null, at: 1001, kind: 'unknown' }] },
                'rollback',
              )
              await rows.anchor.save(null)
              await rows.pending.complete(['frame-1', 'poison-1'])
              await rows.pending.put([
                {
                  frame: {
                    ...key,
                    id: 'frame-3',
                    protocol: 'chat',
                    procedure: 'posted',
                    topicID,
                    segment: 3,
                    position: '11',
                  },
                  payload: utf8('plaintext-sentinel'),
                  senderDID: state.credential.id,
                  epoch: 3,
                  idempotencyKey: JSON.stringify([
                    'kumiai/frame/v1',
                    groupID,
                    1,
                    topicID,
                    '11',
                    'chat',
                    'posted',
                  ]),
                },
              ])
              await rows.cursor.save(topicID, '10')
              await rows.outbox.put([
                {
                  seq: 8,
                  protocol: 'chat',
                  prc: 'posted',
                  data: utf8('plaintext-sentinel'),
                  status: 'accepted',
                  lastAttempt: null,
                },
              ])
              await rows.meta.putSettlement(7, null)
              await rows.meta.ackEvent('event-1')
              await params.writeSideRow(stores.tx, 'effect-1', utf8('effect'))
              if (point === 'callback') throw new Error('callback failure')
            }),
          ).rejects.toThrow()
          expect(await fixture.inspectRows()).toEqual(before)
          expect(hooks).toEqual(
            point === 'callback' || point === 'before-commit' ? ['rollback'] : [],
          )
          await fixture.reopen()
          await scanSealed(fixture)
        } finally {
          await fixture.close()
        }
      },
    )

    test('co-commits transactional event effects and contains effect failures', async () => {
      let shouldFail = false
      const fixture = await params.createFixture(groupID, {
        async outbox(tx, event) {
          await params.writeSideRow(tx, 'event-effect', utf8(event.id))
          if (shouldFail) throw new Error('effect failure')
        },
      })
      try {
        const groups = fixture.ports.device.groups
        const event = {
          ...key,
          id: 'effect-event',
          kind: 'accepted' as const,
          entry: {
            seq: 8,
            protocol: 'chat',
            prc: 'posted',
            data: utf8('plaintext-sentinel'),
            status: 'accepted' as const,
            lastAttempt: null,
          },
        }
        const before = await fixture.inspectRows()
        shouldFail = true
        await expect(
          groups.transition(await storageChange(groups, groupID, 'effect-failed'), async (stores) =>
            stores.incarnation(1).meta.putEvents([event]),
          ),
        ).rejects.toThrow('effect failure')
        expect(await fixture.inspectRows()).toEqual(before)
        expect(await fixture.inspectSideRow('event-effect')).toBeNull()
        shouldFail = false
        await groups.transition(
          await storageChange(groups, groupID, 'effect-commit'),
          async (stores) => stores.incarnation(1).meta.putEvents([event]),
        )
        expect(await fixture.inspectSideRow('event-effect')).toEqual(utf8('effect-event'))
        await fixture.reopen()
        await scanSealed(fixture)
      } finally {
        await fixture.close()
      }
    })

    test('enforces lifetime CAS, state versions and spent authenticator refusal', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        const groups = fixture.ports.device.groups
        const seed = await storageSeed(groups)
        const change = await storageChange(groups, groupID, 'advance')
        await groups.transition(change, async (stores) => {
          await stores
            .incarnation(1)
            .state.save({ ...seed.state, version: seed.state.version + 1, senderHWM: 32 })
          await stores.incarnation(1).cursor.save(topicID, '10')
        })
        expect(await groups.loadState(key)).toEqual({
          ...seed.state,
          version: seed.state.version + 1,
          senderHWM: 32,
        })
        const before = await fixture.inspectRows()
        await expect(
          groups.transition({ ...change, mutationID: 'stale' }, async () => {
            throw new Error('CAS callback must not run')
          }),
        ).rejects.toThrow()
        for (const candidate of [
          { ...seed.state, version: seed.state.version + 1 },
          { ...seed.state, version: seed.state.version + 3 },
          { ...seed.state, version: seed.state.version + 2, senderHWM: 15 },
          { ...seed.state, version: seed.state.version + 2, epoch: 2 },
        ]) {
          await expect(
            groups.transition(await storageChange(groups, groupID, 'bad-state'), async (stores) =>
              stores.incarnation(1).state.save(candidate),
            ),
          ).rejects.toThrow()
        }
        await expect(
          groups.transition(await storageChange(groups, groupID, 'spent'), async (stores) =>
            writeStorageInstall(stores, seed, 'spent', 2),
          ),
        ).rejects.toThrow()
        expect(await fixture.inspectRows()).toEqual(before)
        expect(await groups.loadTrust(groupID)).toEqual(seed.trust)
      } finally {
        await fixture.close()
      }
    })

    test('corrupt state retains trust but corrupt trust refuses installation', async () => {
      for (const namespace of ['state', 'trust'] as const) {
        const fixture = await params.createFixture(groupID)
        const donor = await params.createFixture(groupID)
        try {
          const groups = fixture.ports.device.groups
          const seed = await storageSeed(groups)
          const fresh = await storageSeed(donor.ports.device.groups)
          const lifetimeBefore = await groups.load(groupID)
          const row = (await fixture.inspectRawBytes()).find((row) => row.namespace === namespace)
          if (row === undefined) throw new Error('Missing ciphertext')
          await fixture.mutateStoredRecord(
            namespace,
            row.key,
            (bytes) => new Uint8Array(bytes.length),
          )
          const reopened = await fixture.reopen()
          const restored = reopened.device.groups
          if (namespace === 'state') {
            await expect(restored.loadState(key)).rejects.toThrow()
            expect(await restored.loadTrust(groupID)).toEqual(seed.trust)
          } else {
            await expect(restored.loadTrust(groupID)).rejects.toThrow()
            expect(await restored.loadState(key)).toEqual(seed.state)
          }
          expect(await restored.load(groupID)).toEqual(lifetimeBefore)
          const before = await fixture.inspectRows()
          await expect(
            restored.transition(
              await storageChange(restored, groupID, 'install-corrupt'),
              async (stores) => writeStorageInstall(stores, fresh, 'install-corrupt', 2),
            ),
          ).rejects.toThrow()
          expect(await fixture.inspectRows()).toEqual(before)
          await restored.transition(
            await storageChange(restored, groupID, 'safety'),
            async (stores) =>
              stores.incarnation(1).meta.putEvents([
                {
                  ...key,
                  id: 'safety-1',
                  kind: 'group:recovery-unavailable',
                  reason: 'trust-unreadable',
                },
              ]),
          )
          expect((await restored.load(groupID))?.mutationID).toBe('safety')
        } finally {
          await fixture.close()
          await donor.close()
        }
      }
    })

    test('null state retains recovery metadata and installation requires co-written trust', async () => {
      const fixture = await params.createFixture(groupID)
      const donor = await params.createFixture(groupID)
      try {
        const groups = fixture.ports.device.groups
        const seed = await storageSeed(groups)
        await groups.transition(await storageChange(groups, groupID, 'lost'), async (stores) =>
          stores
            .incarnation(1)
            .state.save({ ...seed.state, version: seed.state.version + 1, state: null }),
        )
        expect(await groups.loadTrust(groupID)).toEqual(seed.trust)
        await expect(
          groups.transition(await storageChange(groups, groupID, 'restore-old'), async (stores) =>
            stores.incarnation(1).state.save({ ...seed.state, version: seed.state.version + 2 }),
          ),
        ).rejects.toThrow()
        const fresh = await storageSeed(donor.ports.device.groups)
        const before = await fixture.inspectRows()
        await expect(
          groups.transition(
            await storageChange(groups, groupID, 'missing-trust-install'),
            async (stores) => {
              const life = await stores.lifetime.load()
              if (life === null) throw new Error('Missing lifetime')
              await stores.lifetime.save({
                ...life,
                latestIncarnation: 2,
                activeIncarnation: 2,
                revision: life.revision + 1,
                mutationID: 'missing-trust-install',
              })
              await stores.incarnation(2).state.save({ ...fresh.state, incarnation: 2, version: 1 })
            },
          ),
        ).rejects.toThrow()
        expect(await fixture.inspectRows()).toEqual(before)
      } finally {
        await fixture.close()
        await donor.close()
      }
    })

    test('isolates incarnations, numeric lane ordering and delimiter-bearing topic addresses', async () => {
      const fixture = await params.createFixture(groupID)
      const donor = await params.createFixture(groupID)
      try {
        const groups = fixture.ports.device.groups
        const fresh = await storageSeed(donor.ports.device.groups)
        await groups.transition(await storageChange(groups, groupID, 'switch'), async (stores) =>
          writeStorageInstall(stores, fresh, 'switch', 2),
        )
        expect((await groups.loadState(key))?.deleted).toBe(true)
        expect(groups.ports(key).key).toEqual(key)
        await expect(groups.ports(key).cursor.save(topicID, '11')).rejects.toThrow()
        let escaped: ConformanceGroupStores<TTx> | undefined
        await groups.transition(
          await storageChange(groups, groupID, 'isolated'),
          async (stores) => {
            escaped = stores
            expect(
              (await stores.incarnation(1).pending.list()).map((row) => row.frame.position),
            ).toEqual(['2', '10'])
            expect(await stores.incarnation(2).pending.list()).toEqual([])
            expect(await stores.incarnation(2).cursor.load(topicID)).toBeNull()
            await stores.incarnation(2).cursor.save('topic:secret', '2')
            await stores.incarnation(2).cursor.save('topic\u0000secret', '10')
            expect(await stores.incarnation(2).cursor.load('topic:secret')).toBe('2')
            expect(await stores.incarnation(2).cursor.load('topic\u0000secret')).toBe('10')
          },
        )
        if (escaped === undefined) throw new Error('Missing stores')
        await expect(escaped.trust.load()).rejects.toThrow()
        await expect(escaped.incarnation(1).pending.list()).rejects.toThrow()
        await fixture.reopen()
        await scanSealed(fixture)
      } finally {
        await fixture.close()
        await donor.close()
      }
    })

    for (const stage of ['absent', 'progress', 'tombstone'] as const) {
      test.each(['commit', 'rollback'] as const)(
        `raw-negative reads await backend completion for ${stage} late %s`,
        async (finish) => {
          const fixture = await params.createFixture(stage === 'absent' ? 'group-B' : groupID)
          const donor = await params.createFixture(groupID)
          try {
            const groups = fixture.ports.device.groups
            const seed = await storageSeed(donor.ports.device.groups)
            const change = await storageChange(groups, groupID, 'late')
            const before = await fixture.inspectRows()
            const hooks: Array<string> = []
            const fault = fixture.rejectCommitPending()
            let settled = false
            const operation = groups
              .transition(change, async (stores) => {
                stores.tx.onCommit(() => {
                  hooks.push('commit')
                  throw new Error('contained hook')
                })
                stores.tx.onCommit(() => {
                  hooks.push('commit-after')
                })
                stores.tx.onRollback(() => {
                  hooks.push('rollback')
                  throw new Error('contained hook')
                })
                stores.tx.onRollback(() => {
                  hooks.push('rollback-after')
                })
                if (stage === 'absent') await writeStorageInstall(stores, seed, 'late')
                else if (stage === 'tombstone') {
                  const life = await stores.lifetime.load()
                  if (life === null) throw new Error('Missing lifetime')
                  await stores.lifetime.save({
                    ...life,
                    activeIncarnation: null,
                    revision: life.revision + 1,
                    mutationID: 'late',
                  })
                } else {
                  await stores.incarnation(1).pending.complete(['frame-1'])
                  await stores.incarnation(1).cursor.save(topicID, '10')
                }
                await params.writeSideRow(stores.tx, 'effect-1', utf8('effect'))
                return 'private-result'
              })
              .then(
                (value) => {
                  settled = true
                  return value
                },
                (error: unknown) => {
                  settled = true
                  return error
                },
              )
            await fault.rejected
            await fault.barrierWaiting
            expect(settled).toBe(false)
            expect(hooks).toEqual([])
            expect(await fixture.inspectRows()).toEqual(before)
            expect(await fixture.inspectSideRow('effect-1')).toBeNull()
            let readDone = false
            const read = groups.load(groupID).then((value) => {
              readDone = true
              return value
            })
            // An unrelated group progresses while the completion owner remains held.
            await groups.transition(
              await storageChange(groups, 'group-B', 'independent'),
              async (stores) => params.writeSideRow(stores.tx, 'effect-B', utf8('independent')),
            )
            expect(readDone).toBe(false)
            fixture.failNext('status-read')
            await fault.finish(finish)
            const result = await operation
            expect(result).toEqual(
              finish === 'commit'
                ? 'private-result'
                : expect.objectContaining({ name: 'StorageOutcomeUnknownError' }),
            )
            expect(hooks).toEqual(
              finish === 'commit' ? ['commit', 'commit-after'] : ['rollback', 'rollback-after'],
            )
            expect(await groups.resolve(groupID, 'late')).toBe(
              finish === 'commit' ? 'committed' : 'rolled-back',
            )
            expect(hooks).toHaveLength(2)
            expect((await read)?.mutationID ?? null).toBe(
              finish === 'commit' ? 'late' : stage === 'absent' ? null : 'seed-records',
            )
            expect(await fixture.inspectSideRow('effect-1')).toEqual(
              finish === 'commit' ? utf8('effect') : null,
            )
            if (stage === 'tombstone' && finish === 'commit') {
              expect((await groups.loadState(key))?.deleted).toBe(true)
              expect(await groups.loadTrust(groupID)).not.toBeNull()
              await expect(
                groups.transition(
                  { groupID, mutationID: 'resurrect', expected: null },
                  async (stores) => writeStorageInstall(stores, seed, 'resurrect'),
                ),
              ).rejects.toThrow()
            }
            await fixture.reopen()
            await scanSealed(fixture)
          } finally {
            await fixture.close()
            await donor.close()
          }
        },
      )

      test.each(['before-commit', 'status-read'] as const)(
        `refuses ${stage} transitions on %s failure`,
        async (point) => {
          const fixture = await params.createFixture(stage === 'absent' ? 'group-B' : groupID)
          const donor = await params.createFixture(groupID)
          try {
            const groups = fixture.ports.device.groups
            const seed = await storageSeed(donor.ports.device.groups)
            const change = await storageChange(groups, groupID, 'failed-stage')
            const before = await fixture.inspectRows()
            fixture.failNext(point)
            await expect(
              groups.transition(change, async (stores) => {
                if (stage === 'absent') await writeStorageInstall(stores, seed, 'failed-stage')
                else if (stage === 'tombstone') {
                  const life = await stores.lifetime.load()
                  if (life === null) throw new Error('Missing lifetime')
                  await stores.lifetime.save({
                    ...life,
                    revision: life.revision + 1,
                    mutationID: 'failed-stage',
                    activeIncarnation: null,
                  })
                } else await stores.incarnation(1).cursor.save(topicID, '10')
                await params.writeSideRow(stores.tx, 'effect-1', utf8('effect'))
              }),
            ).rejects.toThrow()
            expect(await fixture.inspectRows()).toEqual(before)
            await fixture.reopen()
            await scanSealed(fixture)
          } finally {
            await fixture.close()
            await donor.close()
          }
        },
      )

      test(`resolves commit-then-reject for ${stage} exactly once`, async () => {
        const fixture = await params.createFixture(stage === 'absent' ? 'group-B' : groupID)
        const donor = await params.createFixture(groupID)
        try {
          const groups = fixture.ports.device.groups
          const seed = await storageSeed(donor.ports.device.groups)
          const change = await storageChange(groups, groupID, 'committed-rejection')
          const hooks: Array<string> = []
          fixture.commitThenReject()
          await groups.transition(change, async (stores) => {
            stores.tx.onCommit(() => {
              hooks.push('commit')
            })
            stores.tx.onRollback(() => {
              hooks.push('rollback')
            })
            if (stage === 'absent') await writeStorageInstall(stores, seed, 'committed-rejection')
            else if (stage === 'tombstone') {
              const life = await stores.lifetime.load()
              if (life === null) throw new Error('Missing lifetime')
              await stores.lifetime.save({
                ...life,
                revision: life.revision + 1,
                mutationID: 'committed-rejection',
                activeIncarnation: null,
              })
            } else await stores.incarnation(1).cursor.save(topicID, '10')
          })
          expect(await groups.resolve(groupID, 'committed-rejection')).toBe('committed')
          expect(hooks).toEqual(['commit'])
          const reopened = await fixture.reopen()
          expect((await reopened.device.groups.load(groupID))?.mutationID).toBe(
            'committed-rejection',
          )
          await scanSealed(fixture)
        } finally {
          await fixture.close()
          await donor.close()
        }
      })
    }
  })
}
