import { describe, expect, test } from 'vitest'

import type { ConformanceAdoptionWrite, ConformanceControlChanges } from './control-store.js'
import type {
  ConformanceGroupPersistence,
  ConformanceGroupStores,
  ConformanceGroupTransaction,
  ConformanceGroupTransition,
  ConformancePersistenceEvent,
  ConformancePersistenceFixture,
  GroupStorageConformanceParams,
  StorageConformanceParams,
  StorageTestPorts,
} from './persistence-fixture.js'

const groupID = 'group-A'
const key = { groupID, incarnation: 1 }
const topicID = 'topic-secret'
const utf8 = (value: string) => new TextEncoder().encode(value)

const forkHalt = {
  eventID: JSON.stringify(['group:fork', groupID, 1]),
  detectedAt: 1234,
  evidence: {
    kind: 'digest-divergence' as const,
    epoch: 3,
    position: '10',
    localDigest: 'local-commit',
    remoteDigest: 'remote-commit',
  },
}
const recoveryUnavailable = {
  ...key,
  id: JSON.stringify(['group:recovery-unavailable', groupID, 1]),
  kind: 'group:recovery-unavailable' as const,
  reason: 'trust-unreadable' as const,
}
const safetyRows: Array<{
  field: 'forkHalt' | 'recoveryUnavailable'
  changes: ConformanceControlChanges
  event: ConformancePersistenceEvent
}> = [
  {
    field: 'forkHalt',
    changes: { forkHalt },
    event: { ...key, id: forkHalt.eventID, kind: 'group:fork', halt: forkHalt },
  },
  { field: 'recoveryUnavailable', changes: { recoveryUnavailable }, event: recoveryUnavailable },
]

async function storageEvents<TTx extends ConformanceGroupTransaction>(
  fixture: ConformancePersistenceFixture<StorageTestPorts<TTx>>,
): Promise<Array<ConformancePersistenceEvent>> {
  return fixture
    .entry()
    .read(groupID, async () => fixture.constructPrepareStores(key).incarnation(1).meta.events())
}

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
  ports: StorageTestPorts<TTx>,
  id = groupID,
) {
  const groups = ports.device.groups
  const lifetime = await groups.load(id)
  const state = await groups.loadState({ groupID: id, incarnation: 1 })
  const trust = await groups.loadTrust(id)
  if (lifetime === null || state === null || state.deleted || trust === null)
    throw new Error('Missing storage seed')
  return {
    lifetime,
    state,
    trust,
    confirmedTranscriptHash: await ports.readConfirmedTranscriptHash(state.state),
    prepareInstallationCheckpoint: ports.prepareInstallationCheckpoint,
  }
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
  const trust = {
    ...seed.trust,
    genesisAnchor: retained?.genesisAnchor ?? seed.trust.genesisAnchor,
    installed: { ...seed.trust.installed, incarnation },
    spentEpochAuthenticators: [
      ...(retained?.spentEpochAuthenticators ?? []),
      ...seed.trust.spentEpochAuthenticators,
    ],
  }
  await stores.trust.save(trust)
  const records = await stores.checkpoints.list()
  const coverage = records.find((record) => record.kind === 'coverage' && record.id === 'coverage')
  const previousID = coverage?.kind === 'coverage' ? coverage.installations.at(-1)?.id : undefined
  const previousFact = records.find((record) => record.kind === 'fact' && record.id === previousID)
  const fact = await seed.prepareInstallationCheckpoint({
    key: { groupID: seed.state.groupID, incarnation },
    trust,
    confirmedTranscriptHash: seed.confirmedTranscriptHash,
    mutationID,
    stateVersion: 1,
    previousFact: previousFact?.kind === 'fact' ? previousFact.canonical : null,
  })
  await stores.checkpoints.put(fact)
  await stores.checkpoints.put({
    kind: 'publication',
    id: `publication:${fact.id}`,
    key: fact.key,
    factID: fact.id,
    frame: null,
    publishID: null,
    accepted: false,
    nextHeartbeatAt: null,
  })
}

export async function assertLowerEpochRefused<TTx extends ConformanceGroupTransaction>(
  params: StorageConformanceParams<TTx>,
): Promise<void> {
  const fixture = await params.createFixture(groupID)
  try {
    const groups = fixture.ports.device.groups
    const seed = await storageSeed(fixture.ports)
    const lower = await params.lowerEpochCandidate(groupID)
    expect(lower.state.epoch).toBeLessThan(seed.state.epoch)
    expect(seed.trust.spentEpochAuthenticators).not.toContainEqual(lower.state.epochAuthenticator)
    const before = await fixture.inspectRows()
    await expect(
      groups.transition(
        await storageChange(groups, groupID, 'epoch-regression'),
        async (stores) => {
          await stores
            .incarnation(1)
            .state.save({ ...lower.state, version: seed.state.version + 1 })
          await stores.trust.save({
            ...lower.trust,
            genesisAnchor: seed.trust.genesisAnchor,
            spentEpochAuthenticators: [
              ...seed.trust.spentEpochAuthenticators,
              ...lower.trust.spentEpochAuthenticators,
            ],
          })
        },
      ),
    ).rejects.toMatchObject({ name: 'GroupStateConflictError', message: 'Epoch regressed' })
    expect(await fixture.inspectRows()).toEqual(before)
  } finally {
    await fixture.close()
  }
}

export async function assertCorruptStorageRecovery<TTx extends ConformanceGroupTransaction>(
  params: Pick<StorageConformanceParams<TTx>, 'createFixture'>,
  namespace: 'state' | 'trust',
): Promise<void> {
  const fixture = await params.createFixture(groupID)
  const donor = await params.createFixture(groupID)
  try {
    const groups = fixture.ports.device.groups
    const seed = await storageSeed(fixture.ports)
    const fresh = await storageSeed(donor.ports)
    const lifetimeBefore = await groups.load(groupID)
    const row = (await fixture.inspectRawBytes()).find((row) => row.namespace === namespace)
    if (row === undefined) throw new Error('Missing ciphertext')
    await fixture.mutateStoredRecord(namespace, row.key, (bytes) => new Uint8Array(bytes.length))
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
    const installation = restored.transition(
      await storageChange(restored, groupID, 'install-corrupt'),
      async (stores) => writeStorageInstall(stores, fresh, 'install-corrupt', 2),
    )
    if (namespace === 'state') {
      await installation
      expect(await restored.loadState(key)).toEqual({
        ...key,
        deleted: true,
        version: seed.state.version + 1,
      })
      expect(await restored.loadState({ ...key, incarnation: 2 })).toEqual({
        ...fresh.state,
        incarnation: 2,
        version: 1,
      })
      expect((await restored.loadTrust(groupID))?.genesisAnchor).toEqual(seed.trust.genesisAnchor)
    } else {
      await expect(installation).rejects.toThrow()
      expect(await fixture.inspectRows()).toEqual(before)
    }
    await restored.transition(await storageChange(restored, groupID, 'safety'), async (stores) =>
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
    const safetyPorts = await fixture.reopen()
    await safetyPorts.device.groups.transition(
      await storageChange(safetyPorts.device.groups, groupID, 'read-safety'),
      async (stores) => {
        expect(
          (await stores.incarnation(1).meta.events()).find((event) => event.id === 'safety-1'),
        ).toEqual({
          ...key,
          id: 'safety-1',
          kind: 'group:recovery-unavailable',
          reason: 'trust-unreadable',
        })
      },
    )
  } finally {
    await fixture.close()
    await donor.close()
  }
}

export async function assertPartialLossSpentRefused<TTx extends ConformanceGroupTransaction>(
  params: Pick<StorageConformanceParams<TTx>, 'createFixture'>,
): Promise<void> {
  const fixture = await params.createFixture(groupID)
  try {
    const seed = await storageSeed(fixture.ports)
    for (const [namespace, values] of Object.entries(await fixture.inspectRows())) {
      if (namespace === 'trust') continue
      for (const address of values.keys()) {
        const [storedID, incarnation] = JSON.parse(address) as [string, number | null]
        if (
          storedID === groupID &&
          (incarnation !== null || namespace === 'lifetime' || namespace === 'group-owner')
        )
          await fixture.deleteCommittedRow(namespace, address)
      }
    }
    const { device } = await fixture.reopen()
    const change = await storageChange(device.groups, groupID, 'reinstall')
    const before = await fixture.inspectRows()
    await expect(
      device.groups.transition(change, async (stores) =>
        writeStorageInstall(stores, seed, 'reinstall'),
      ),
    ).rejects.toMatchObject({
      name: 'GroupStateConflictError',
      message: 'Epoch authenticator already spent',
    })
    expect(await fixture.inspectRows()).toEqual(before)
    expect(await device.groups.loadTrust(groupID)).toEqual(seed.trust)
    expect(await device.groups.loadState(key)).toBeNull()
  } finally {
    await fixture.close()
  }
}

export function testGroupStorageConformance<TTx extends ConformanceGroupTransaction>(
  params: GroupStorageConformanceParams<TTx>,
): void {
  describe(`Group storage conformance -- ${params.label}`, () => {
    for (const ownership of ['supplied', 'absent'] as const) {
      test(`ordinary stores cannot fabricate spent corruption (${ownership} ownership context)`, async () => {
        const fixture = await params.createFixture(groupID, {
          ownershipContext: ownership === 'supplied' ? params.ownershipContext?.() : undefined,
        })
        try {
          const groups = fixture.ports.device.groups
          await storageSeed(fixture.ports)
          const before = await fixture.inspectRows()
          const id = JSON.stringify(['spent-set-corrupt', groupID, 1])
          await expect(
            groups.transition(
              await storageChange(groups, groupID, 'fabricated-corruption'),
              async (stores) => {
                await stores.checkpoints.put({
                  kind: 'condition',
                  id,
                  key,
                  active: true,
                  sealedProof: null,
                  event: { ...key, id, kind: 'spent-set-corrupt', detectedAt: 1, evidence: null },
                })
              },
            ),
          ).rejects.toMatchObject({ name: 'GroupStateConflictError' })
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      })
      test(`branch journal survives acknowledgement and counts only accepted occurrences (${ownership} ownership context)`, async () => {
        const fixture = await params.createFixture(groupID, {
          ownershipContext: ownership === 'supplied' ? params.ownershipContext?.() : undefined,
        })
        try {
          const groups = fixture.ports.device.groups
          const seed = await storageSeed(fixture.ports)
          const outbox = groups.ports(key).outbox
          await outbox.put({
            seq: 8,
            protocol: 'chat',
            prc: 'posted',
            data: utf8('plaintext-sentinel'),
            status: 'accepted',
            lastAttempt: {
              incarnation: 1,
              epoch: seed.state.epoch,
              publishID: 'prospective-shared',
              attempts: 1,
              floor: null,
              segment: seed.state.epoch,
              topicID,
            },
          })
          await outbox.remove(8)
          for (const event of await outbox.events()) await outbox.ackEvent(event.id)
          const received = {
            frame: {
              ...key,
              id: 'shared-received',
              protocol: 'chat',
              procedure: 'posted',
              topicID,
              segment: seed.state.epoch,
              position: '11',
            },
            payload: utf8('plaintext-sentinel'),
            senderDID: 'did:key:other',
            epoch: seed.state.epoch,
            idempotencyKey: 'shared-received',
          }
          await groups.transition(
            await storageChange(groups, groupID, 'shared-receive'),
            async (stores) => {
              await stores.incarnation(1).pending.put([received, received])
              await stores.incarnation(1).pending.complete([received.frame.id])
              await stores.incarnation(1).cursor.save(topicID, '11')
            },
          )
          const reopened = await fixture.reopen()
          await reopened.device.groups.transition(
            await storageChange(reopened.device.groups, groupID, 'shared-replay'),
            async (stores) => {
              await stores.incarnation(1).pending.put([received])
            },
          )
          const records = await fixture.entry().read(groupID, (reads) => reads.checkpoints())
          expect(records.filter((row) => row.kind === 'others-seen')).toEqual([
            expect.objectContaining({ count: 1 }),
          ])
          expect(records.find((row) => row.kind === 'own-branch-messages')).toMatchObject({
            messages: [
              { id: 'prospective-shared', epoch: seed.state.epoch, authHash: expect.any(String) },
            ],
          })
          await scanSealed(fixture)
        } finally {
          await fixture.close()
        }
      })

      test(`direct successful installations prepare matching fact and debt (${ownership} ownership context)`, async () => {
        const fixture = await params.createFixture(groupID, {
          ownershipContext: ownership === 'supplied' ? params.ownershipContext?.() : undefined,
        })
        const donor = await params.createFixture(groupID)
        try {
          const fresh = await storageSeed(donor.ports)
          const groups = fixture.ports.device.groups
          const before = await fixture.entry().read(groupID, (reads) => reads.checkpoints())
          await groups.transition(
            await storageChange(groups, groupID, 'shared-install'),
            (stores) => writeStorageInstall(stores, fresh, 'shared-install', 2),
          )
          const records = await fixture.entry().read(groupID, (reads) => reads.checkpoints())
          const facts = records.filter(
            (record) => record.kind === 'fact' && record.key.incarnation === 2,
          )
          expect(facts).toHaveLength(1)
          const fact = facts[0]
          if (fact?.kind !== 'fact') throw new Error('Missing shared installation fact')
          expect(fact.key).toEqual({ groupID, incarnation: 2 })
          expect(JSON.parse(new TextDecoder().decode(fact.canonical))).toMatchObject({
            key: fact.key,
            epoch: fresh.state.epoch,
            installation: { mutationID: 'shared-install', stateVersion: 1 },
          })
          expect(
            records.filter((record) => record.kind === 'publication' && record.factID === fact.id),
          ).toEqual([
            expect.objectContaining({
              key: fact.key,
              factID: fact.id,
              accepted: false,
              frame: null,
            }),
          ])
          for (const row of before) {
            if (row.kind === 'coverage') continue
            const after = records.find((record) => record.id === row.id)
            expect(after).toMatchObject(
              row.kind === 'fact' ? { ...row, supersededAt: expect.any(Number) } : row,
            )
          }
          await fixture.reopen()
          expect(await fixture.entry().read(groupID, (reads) => reads.checkpoints())).toEqual(
            records,
          )
        } finally {
          await donor.close()
          await fixture.close()
        }
      })
    }
    for (const { field, changes, event } of safetyRows) {
      test(`${field}: halt and event co-commit`, async () => {
        const fixture = await params.createFixture(groupID)
        try {
          const groups = fixture.ports.device.groups
          await groups.ports(key).control.apply(changes, 'hold-safety')
          expect((await groups.ports(key).control.load())[field]).toEqual(changes[field])
          expect((await storageEvents(fixture)).filter((row) => row.id === event.id)).toEqual([
            event,
          ])
          await groups.ports(key).control.apply(changes, 'repeat-safety')
          await fixture.reopen()
          expect((await storageEvents(fixture)).filter((row) => row.id === event.id)).toEqual([
            event,
          ])
          await scanSealed(fixture)
        } finally {
          await fixture.close()
        }
      })

      test.each(['after-first-write', 'before-commit', 'commit-then-reject'] as const)(
        `${field}: fault/ambiguous COMMIT preserves both-or-neither on %s`,
        async (point) => {
          const fixture = await params.createFixture(groupID)
          try {
            const groups = fixture.ports.device.groups
            const before = await fixture.inspectRows()
            fixture.armWorkFault('hold-safety', point)
            const writing = groups.ports(key).control.apply(changes, 'hold-safety')
            if (point === 'commit-then-reject') await writing
            else {
              await expect(writing).rejects.toThrow()
              expect(await fixture.inspectRows()).toEqual(before)
            }
            const committed = point === 'commit-then-reject'
            const reopened = (await fixture.reopen()).device.groups
            expect((await reopened.ports(key).control.load())[field]).toEqual(
              committed ? changes[field] : null,
            )
            expect((await storageEvents(fixture)).filter((row) => row.id === event.id)).toEqual(
              committed ? [event] : [],
            )
          } finally {
            await fixture.close()
          }
        },
      )

      test.each(['commit', 'rollback'] as const)(
        `${field}: pending proof preserves both-or-neither after %s`,
        async (finish) => {
          const fixture = await params.createFixture(groupID)
          const proof = fixture.holdProof('hold-safety')
          try {
            const groups = fixture.ports.device.groups
            const before = await fixture.inspectRows()
            const fault = fixture.armWorkFault('hold-safety', 'pending')
            let writeDone = false
            const writing = groups
              .ports(key)
              .control.apply(changes, 'hold-safety')
              .then(
                () => {
                  writeDone = true
                },
                (error: unknown) => {
                  writeDone = true
                  return error
                },
              )
            await fault.rejected
            await proof.started
            expect(await fixture.inspectRows()).toEqual(before)
            expect(writeDone).toBe(false)
            let readDone = false
            const reading = groups
              .ports(key)
              .control.load()
              .then((snapshot) => {
                readDone = true
                return snapshot
              })
            await groups.ports({ groupID: 'group-B', incarnation: 1 }).control.load()
            expect(readDone).toBe(false)
            const resolution = groups.resolve(groupID, 'hold-safety')
            await fault.finish(finish)
            expect(readDone).toBe(false)
            expect(writeDone).toBe(false)
            proof.release()
            expect(await writing).toEqual(
              finish === 'commit'
                ? undefined
                : expect.objectContaining({ name: 'StorageOutcomeUnknownError' }),
            )
            expect((await reading)[field]).toEqual(finish === 'commit' ? changes[field] : null)
            expect(await resolution).toBe(finish === 'commit' ? 'committed' : 'rolled-back')
            await fixture.reopen()
            expect((await storageEvents(fixture)).filter((row) => row.id === event.id)).toEqual(
              finish === 'commit' ? [event] : [],
            )
            if (finish === 'rollback') expect(await fixture.inspectRows()).toEqual(before)
          } finally {
            proof.release()
            await fixture.close()
          }
        },
      )

      test(`${field}: conflicting same-ID event rolls back control`, async () => {
        const fixture = await params.createFixture(groupID)
        try {
          const groups = fixture.ports.device.groups
          const conflict =
            event.kind === 'group:fork'
              ? { ...event, halt: { ...event.halt, detectedAt: 99 } }
              : { ...key, id: event.id, kind: 'group:fork' as const, halt: forkHalt }
          await groups.transition(
            await storageChange(groups, groupID, 'preinstall-conflict'),
            async (stores) => stores.incarnation(1).meta.putEvents([conflict]),
          )
          const before = await fixture.inspectRows()
          const snapshot = await groups.ports(key).control.load()
          await expect(
            groups
              .ports(key)
              .control.apply(
                { ...changes, putOutcomes: [{ id: 'mixed', opID: null, at: 9, kind: 'unknown' }] },
                'conflict-safety',
              ),
          ).rejects.toMatchObject({ name: 'GroupStateConflictError' })
          expect(await fixture.inspectRows()).toEqual(before)
          expect(await groups.ports(key).control.load()).toEqual(snapshot)
          expect((await storageEvents(fixture)).filter((row) => row.id === event.id)).toEqual([
            conflict,
          ])
        } finally {
          await fixture.close()
        }
      })

      test(`${field}: ack keeps halt and identical reapply does not resurrect event`, async () => {
        const fixture = await params.createFixture(groupID)
        try {
          const groups = fixture.ports.device.groups
          await groups.ports(key).control.apply(changes, 'hold-safety')
          expect((await storageEvents(fixture)).filter((row) => row.id === event.id)).toEqual([
            event,
          ])
          await groups.transition(
            await storageChange(groups, groupID, 'ack-safety'),
            async (stores) => stores.incarnation(1).meta.ackEvent(event.id),
          )
          expect((await groups.ports(key).control.load())[field]).toEqual(changes[field])
          await groups.ports(key).control.apply(changes, 'repeat-safety')
          await fixture.reopen()
          expect((await fixture.ports.device.groups.ports(key).control.load())[field]).toEqual(
            changes[field],
          )
          expect((await storageEvents(fixture)).filter((row) => row.id === event.id)).toEqual([])
        } finally {
          await fixture.close()
        }
      })

      test(`${field}: outbox cannot ack safety event`, async () => {
        const fixture = await params.createFixture(groupID)
        try {
          const groups = fixture.ports.device.groups
          await groups.transition(
            await storageChange(groups, groupID, 'preinstall-safety'),
            async (stores) => stores.incarnation(1).meta.putEvents([event]),
          )
          const before = await fixture.inspectRows()
          await expect(groups.ports(key).outbox.ackEvent(event.id)).rejects.toBeInstanceOf(
            TypeError,
          )
          expect(await fixture.inspectRows()).toEqual(before)
          expect((await storageEvents(fixture)).filter((row) => row.id === event.id)).toEqual([
            event,
          ])
          await groups.transition(
            await storageChange(groups, groupID, 'ack-safety'),
            async (stores) => stores.incarnation(1).meta.ackEvent(event.id),
          )
          const acknowledged = await fixture.inspectRows()
          await groups.ports(key).outbox.ackEvent(event.id)
          expect(await fixture.inspectRows()).toEqual(acknowledged)
        } finally {
          await fixture.close()
        }
      })

      test(`${field}: absent stable safety ID is an idempotent outbox ack`, async () => {
        const fixture = await params.createFixture(groupID)
        try {
          const groups = fixture.ports.device.groups
          const before = await fixture.inspectRows()
          await groups.ports(key).outbox.ackEvent(event.id)
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      })

      test.each(['facade', 'transaction'] as const)(
        `${field}: safety fields permit certified storage finalisation through %s`,
        async (route) => {
          const fixture = await params.createFixture(groupID)
          try {
            const groups = fixture.ports.device.groups
            const outbox = groups.ports(key).outbox
            const initialEntries = await outbox.list()
            const attempted = {
              seq: 31,
              protocol: 'chat',
              prc: 'posted',
              data: utf8('certified-data'),
              status: 'accepted' as const,
              lastAttempt: {
                incarnation: 1,
                epoch: 3,
                floor: null,
                attempts: 1,
                publishID: 'publish-1',
                segment: 3,
                topicID,
              },
            }
            const occurrence = { incarnation: 1, segment: 3, topicID, position: '10' }
            await groups.transition(
              await storageChange(groups, groupID, 'bind-attempt'),
              async (stores) => {
                const rows = stores.incarnation(1)
                await rows.outbox.put([attempted])
                await rows.meta.putSettlement(31, {
                  sequenceID: '10',
                  attemptID: 'publish-1',
                  topicID,
                  outcome: 'published',
                })
              },
            )
            await groups.ports(key).control.apply(changes, 'hold-safety')
            const before = await fixture.inspectRows()
            await expect(outbox.remove(31, { ...occurrence, position: '11' })).rejects.toThrow(
              'original occurrence',
            )
            expect(await fixture.inspectRows()).toEqual(before)
            if (route === 'facade') await outbox.remove(31, occurrence)
            else
              await groups.transition(
                await storageChange(groups, groupID, 'finalise-certified'),
                async (stores) => {
                  const rows = stores.incarnation(1)
                  await rows.meta.putEvents([
                    {
                      ...key,
                      id: 'original-publication',
                      kind: 'published',
                      entry: attempted,
                      occurrence,
                    },
                  ])
                  await rows.outbox.remove([31])
                },
              )
            expect(await outbox.list()).toEqual(initialEntries)
            expect(await outbox.loadSettlement(31)).toBeNull()
            await fixture.reopen()
            expect((await fixture.ports.device.groups.ports(key).control.load())[field]).toEqual(
              changes[field],
            )
            expect(await fixture.ports.device.groups.ports(key).outbox.list()).toEqual(
              initialEntries,
            )
            expect(
              await fixture.ports.device.groups.ports(key).outbox.loadSettlement(31),
            ).toBeNull()
            expect(
              (await fixture.ports.device.groups.ports(key).outbox.events()).filter(
                (row) => row.kind === 'published',
              ),
            ).toEqual([
              { ...key, id: expect.any(String), kind: 'published', entry: attempted, occurrence },
            ])
            expect((await storageEvents(fixture)).filter((row) => row.id === event.id)).toEqual([
              event,
            ])
          } finally {
            await fixture.close()
          }
        },
      )
    }

    test.each(['clear', 'terminal', 'retire', 'delete'] as const)(
      '%s preserves both safety fields and unacked events',
      async (action) => {
        const fixture = await params.createFixture(groupID)
        const donor = action === 'retire' ? await params.createFixture(groupID) : null
        try {
          const groups = fixture.ports.device.groups
          const seed = await storageSeed(donor?.ports ?? fixture.ports)
          await groups.ports(key).control.apply({ forkHalt, recoveryUnavailable }, 'hold-safety')
          if (action === 'clear' || action === 'delete')
            await fixture.deleteCommittedRow(
              'meta',
              JSON.stringify([groupID, 1, JSON.stringify(['settlement', 7])]),
            )
          await groups.transition(
            await storageChange(groups, groupID, 'preserve-safety'),
            async (stores) => {
              const rows = stores.incarnation(1)
              if (action === 'terminal') {
                const state = await rows.state.load()
                if (state === null || state.deleted) throw new Error('Missing active state')
                await rows.state.save({ ...state, version: state.version + 1, terminal: true })
              } else if (action === 'retire') {
                await writeStorageInstall(stores, seed, 'preserve-safety', 2)
              } else {
                await rows.clearTransport()
                if (action === 'delete') {
                  const life = await stores.lifetime.load()
                  if (life === null) throw new Error('Missing lifetime')
                  await stores.lifetime.save({
                    ...life,
                    activeIncarnation: null,
                    revision: life.revision + 1,
                    mutationID: 'preserve-safety',
                  })
                }
              }
            },
          )
          await fixture.reopen()
          expect(await fixture.ports.device.groups.ports(key).control.load()).toMatchObject({
            forkHalt,
            recoveryUnavailable,
          })
          expect(
            (await storageEvents(fixture)).filter((row) => row.kind.startsWith('group:')),
          ).toEqual(safetyRows.map((row) => row.event))
        } finally {
          await fixture.close()
          await donor?.close()
        }
      },
    )

    test.each([
      { label: 'ordinary failure', reason: 'removed' as const, stableID: true },
      {
        label: 'abandonment with a nonstable ID',
        reason: 'incarnation-abandoned' as const,
        stableID: false,
      },
      { label: 'deletion with a nonstable ID', reason: 'deleted' as const, stableID: false },
    ])('removing an entry after $label still emits removed', async ({ reason, stableID }) => {
      const fixture = await params.createFixture(groupID)
      try {
        const groups = fixture.ports.device.groups
        const initialEntries = await groups.ports(key).outbox.list()
        const initialEvents = await groups.ports(key).outbox.events()
        const entry = {
          seq: 31,
          protocol: 'chat',
          prc: 'posted',
          data: utf8('ordinary-failed-data'),
          lastAttempt: null,
          status: 'failed' as const,
        }
        const event = {
          ...key,
          id: stableID
            ? JSON.stringify(['incarnation-abandoned', groupID, 1, entry.seq])
            : JSON.stringify(['prior-failure', entry.seq, 'failed']),
          kind: 'failed' as const,
          reason,
          nextIncarnation: reason === 'incarnation-abandoned' ? 2 : undefined,
          entry,
        }
        await groups.transition(
          await storageChange(groups, groupID, 'prior-failure'),
          async (stores) => {
            const source = stores.incarnation(1)
            await source.outbox.put([entry])
            await source.meta.putEvents([event])
          },
        )
        await groups.transition(
          await storageChange(groups, groupID, 'ordinary-removal'),
          async (stores) => stores.incarnation(1).outbox.remove([entry.seq]),
        )
        const expectedEvents = [
          ...initialEvents,
          event,
          {
            ...key,
            id: JSON.stringify(['ordinary-removal', entry.seq, 'failed']),
            kind: 'failed',
            reason: 'removed',
            entry,
          },
        ]
        expect(await groups.ports(key).outbox.list()).toEqual(initialEntries)
        expect(await groups.ports(key).outbox.events()).toEqual(expectedEvents)
        const reopened = await fixture.reopen()
        expect(await reopened.device.groups.ports(key).outbox.events()).toEqual(expectedEvents)
      } finally {
        await fixture.close()
      }
    })

    test.each(['incarnation-abandoned', 'deleted'] as const)(
      'removing a %s entry retains its matching stable failure event',
      async (reason) => {
        const fixture = await params.createFixture(groupID)
        try {
          const groups = fixture.ports.device.groups
          const initialEntries = await groups.ports(key).outbox.list()
          const initialEvents = await groups.ports(key).outbox.events()
          const entry = {
            seq: 31,
            protocol: 'chat',
            prc: 'posted',
            data: utf8('retained-abandoned-data'),
            lastAttempt: {
              incarnation: 1,
              epoch: 3,
              floor: null,
              attempts: 1,
              publishID: 'abandoned-publish',
              segment: 3,
              topicID,
            },
            status: 'failed' as const,
          }
          const event = {
            ...key,
            id: JSON.stringify([reason, groupID, 1, 31]),
            kind: 'failed' as const,
            reason,
            nextIncarnation: reason === 'incarnation-abandoned' ? 2 : undefined,
            entry,
          }
          await groups.transition(
            await storageChange(groups, groupID, 'fail-abandoned'),
            async (stores) => {
              const source = stores.incarnation(1)
              await source.outbox.put([entry])
              await source.meta.putEvents([event])
            },
          )
          await groups.transition(
            await storageChange(groups, groupID, 'remove-abandoned'),
            async (stores) => stores.incarnation(1).outbox.remove([31]),
          )
          expect(await groups.ports(key).outbox.list()).toEqual(initialEntries)
          expect(await groups.ports(key).outbox.events()).toEqual([...initialEvents, event])
          const reopened = await fixture.reopen()
          expect(await reopened.device.groups.ports(key).outbox.events()).toEqual([
            ...initialEvents,
            event,
          ])
        } finally {
          await fixture.close()
        }
      },
    )

    test('evidence reads bind committed state version, cursor and applied rows to one fixed key', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        const groups = fixture.ports.device.groups
        const seed = await storageSeed(fixture.ports)
        const before = await groups.readEvidence(key)
        expect(before.source).toEqual({
          key,
          stateVersion: seed.state.version,
          identity: {
            ...key,
            epoch: seed.state.epoch,
            authenticator: seed.state.epochAuthenticator,
          },
        })
        expect(before.terminal).toBe(false)
        const row = {
          epoch: seed.state.epoch - 1,
          digest: 'evidence-commit',
          payloadDigest: 'evidence-payload',
          sequenceID: '000101',
          opID: null,
          removed: false,
        }
        const cursor = { position: '000101', epoch: seed.state.epoch }
        await groups.transition(
          await storageChange(groups, groupID, 'evidence-write'),
          async (stores) => {
            await stores
              .incarnation(1)
              .control.apply({ putApplied: [row], cursor }, 'evidence-write')
          },
        )
        const reopened = (await fixture.reopen()).device.groups
        const evidence = await reopened.readEvidence(key)
        const state = await reopened.loadState(key)
        const control = await reopened.ports(key).control.load()
        expect(evidence.source).toEqual({ ...before.source, stateVersion: seed.state.version + 1 })
        expect(evidence.source.stateVersion).toBe(state?.version)
        expect(evidence.applied).toEqual(control.applied)
        expect(evidence.applied).toContainEqual(row)
        expect(evidence.cursor).toEqual(cursor)
        await expect(
          groups.transition(
            await storageChange(groups, groupID, 'evidence-rollback'),
            async (stores) => {
              await stores
                .incarnation(1)
                .control.apply(
                  { cursor: { position: '000102', epoch: seed.state.epoch } },
                  'evidence-rollback',
                )
              throw new Error('rollback evidence')
            },
          ),
        ).rejects.toThrow('rollback evidence')
        expect(await groups.readEvidence(key)).toEqual(evidence)
        await groups.transition(
          await storageChange(groups, groupID, 'evidence-retire'),
          async (stores) => {
            const life = await stores.lifetime.load()
            if (life === null) throw new Error('missing lifetime')
            await stores.lifetime.save({
              ...life,
              activeIncarnation: null,
              revision: life.revision + 1,
              mutationID: 'evidence-retire',
            })
          },
        )
        expect(await groups.readEvidence(key)).toMatchObject({
          source: { key, identity: null },
          terminal: false,
          applied: control.applied,
          cursor,
        })
      } finally {
        await fixture.close()
      }
    })
    test('authenticates every physical byte copy and atomically commits side rows', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        const namespaces = new Set((await fixture.inspectRawBytes()).map((row) => row.namespace))
        expect([...namespaces].sort()).toEqual(
          [
            'anchor',
            'checkpoints',
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
          let reachedWrites = false
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
              await rows.meta.putSettlement(8, {
                sequenceID: '11',
                attemptID: 'publish-2',
                topicID,
                outcome: 'published',
              })
              await rows.meta.ackEvent('event-1')
              await params.writeSideRow(stores.tx, 'effect-1', utf8('effect'))
              reachedWrites = true
              if (point === 'callback') throw new Error('callback failure')
            }),
          ).rejects.toThrow(point === 'callback' ? 'callback failure' : `Injected ${point} failure`)
          expect(reachedWrites).toBe(point === 'callback' || point === 'before-commit')
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
      5000,
    )

    test('serialises overlapping methods across group store instances without lost writes', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        const groups = fixture.ports.device.groups
        const seed = await storageSeed(fixture.ports)
        const before = await groups.ports(key).control.load()
        const outcomes = [
          { id: 'overlap-1', opID: null, at: 1001, kind: 'unknown' as const },
          { id: 'overlap-2', opID: null, at: 1002, kind: 'unknown' as const },
        ] as const
        const hooks: Array<string> = []
        let calls = 0
        await groups.transition(await storageChange(groups, groupID, 'overlap'), async (stores) => {
          calls++
          stores.tx.onCommit(() => {
            hooks.push('commit')
          })
          stores.tx.onRollback(() => {
            hooks.push('rollback')
          })
          const [, , snapshot] = await Promise.all([
            stores.incarnation(1).control.apply({ putOutcomes: [outcomes[0]] }, 'overlap'),
            stores.incarnation(1).control.apply({ putOutcomes: [outcomes[1]] }, 'overlap'),
            stores.incarnation(1).control.load(),
          ])
          expect(snapshot.outcomes).toEqual([...before.outcomes, ...outcomes])
        })
        expect(await groups.resolve(groupID, 'overlap')).toBe('committed')
        expect(await groups.resolve(groupID, 'overlap')).toBe('committed')
        expect(calls).toBe(1)
        expect(hooks).toEqual(['commit'])
        const reopened = await fixture.reopen()
        expect(await reopened.device.groups.load(groupID)).toEqual({
          ...seed.lifetime,
          revision: seed.lifetime.revision + 1,
          mutationID: 'overlap',
        })
        expect(await reopened.device.groups.loadState(key)).toEqual({
          ...seed.state,
          version: seed.state.version + 1,
        })
        expect((await reopened.device.groups.ports(key).control.load()).outcomes).toEqual([
          ...before.outcomes,
          ...outcomes,
        ])
      } finally {
        await fixture.close()
      }
    }, 5000)

    test('co-commits transactional event effects and contains effect failures', async () => {
      let shouldFail = false
      const fixture = await params.createFixture(groupID, {
        effects: {
          async outbox(tx, event) {
            await params.writeSideRow(tx, 'event-effect', utf8(event.id))
            if (shouldFail) throw new Error('effect failure')
          },
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

    test('refuses a proof-bearing state save without retained acceptance', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        const groups = fixture.ports.device.groups
        const seed = await storageSeed(fixture.ports)
        const source = {
          key,
          identity: {
            ...key,
            epoch: seed.state.epoch,
            authenticator: seed.state.epochAuthenticator,
          },
          stateVersion: seed.state.version,
        }
        const expected: ConformanceAdoptionWrite<string>['expected'] = {
          ...source,
          acceptance: {
            source,
            from: null,
            position: 'unretained-occurrence',
            payloadDigest: 'unretained-payload',
          },
          journal: utf8('unretained-candidate'),
        }
        const before = await fixture.inspectRows()
        await expect(
          groups.transition(
            await storageChange(groups, groupID, 'unretained-adoption'),
            async (stores) =>
              stores
                .incarnation(1)
                .state.save(
                  { ...seed.state, version: seed.state.version + 1, senderHWM: 32 },
                  expected,
                ),
          ),
        ).rejects.toMatchObject({ name: 'ControlAdoptionMovedError' })
        expect(await fixture.inspectRows()).toEqual(before)
        expect(await groups.loadState(key)).toEqual(seed.state)
      } finally {
        await fixture.close()
      }
    })

    test('enforces lifetime CAS, state versions and spent authenticator refusal', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        const groups = fixture.ports.device.groups
        const seed = await storageSeed(fixture.ports)
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
        let staleCalls = 0
        await expect(
          groups.transition({ ...change, mutationID: 'stale' }, async () => {
            staleCalls++
          }),
        ).rejects.toMatchObject({
          name: 'GroupStateConflictError',
          message: 'Group lifetime conflict',
        })
        expect(staleCalls).toBe(0)
        for (const candidate of [
          { ...seed.state, version: seed.state.version + 1 },
          { ...seed.state, version: seed.state.version + 3 },
          { ...seed.state, version: seed.state.version + 2, senderHWM: 15 },
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

    test('refuses an internally consistent unspent lower epoch with matching trust', async () => {
      await assertLowerEpochRefused(params)
    }, 5000)

    test.each(['state', 'trust'] as const)(
      'corrupt %s retains the other records and persists a safety event',
      async (namespace) => {
        await assertCorruptStorageRecovery(params, namespace)
      },
      5000,
    )

    test('null state retains recovery metadata and installation requires co-written trust', async () => {
      const fixture = await params.createFixture(groupID)
      const donor = await params.createFixture(groupID)
      try {
        const groups = fixture.ports.device.groups
        const seed = await storageSeed(fixture.ports)
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
        const fresh = await storageSeed(donor.ports)
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
        const { device } = await fixture.reopen()
        const groups = device.groups
        const fresh = await storageSeed(donor.ports)
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
    }, 5000)

    for (const stage of ['absent', 'progress', 'tombstone'] as const) {
      test.each(['commit', 'rollback'] as const)(
        `raw-negative reads await backend completion for ${stage} late %s`,
        async (finish) => {
          const fixture = await params.createFixture(stage === 'absent' ? 'group-B' : groupID)
          const donor = await params.createFixture(groupID)
          try {
            const groups = fixture.ports.device.groups
            const seed = await storageSeed(donor.ports)
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
            const independentSeed = await storageSeed(fixture.ports, 'group-B')
            await groups.transition(
              await storageChange(groups, 'group-B', 'independent'),
              async (stores) => {
                await stores.incarnation(1).cursor.save(topicID, '20')
                await params.writeSideRow(stores.tx, 'effect-B', utf8('independent'))
              },
            )
            expect(readDone).toBe(false)
            const resolution = groups.resolve(groupID, 'late')
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
            expect(await resolution).toBe(finish === 'commit' ? 'committed' : 'rolled-back')
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
            const reopened = await fixture.reopen()
            expect(await reopened.device.groups.load('group-B')).toEqual({
              ...independentSeed.lifetime,
              revision: independentSeed.lifetime.revision + 1,
              mutationID: 'independent',
            })
            expect(
              await reopened.device.groups.loadState({ groupID: 'group-B', incarnation: 1 }),
            ).toEqual({
              ...independentSeed.state,
              version: independentSeed.state.version + 1,
            })
            expect(
              await reopened.device.groups
                .ports({ groupID: 'group-B', incarnation: 1 })
                .cursor.load(topicID),
            ).toBe('20')
            expect(await fixture.inspectSideRow('effect-B')).toEqual(utf8('independent'))
            await scanSealed(fixture)
          } finally {
            await fixture.close()
            await donor.close()
          }
        },
        5000,
      )

      test.each(['before-commit', 'status-read'] as const)(
        `refuses ${stage} transitions on %s failure`,
        async (point) => {
          const fixture = await params.createFixture(stage === 'absent' ? 'group-B' : groupID)
          const donor = await params.createFixture(groupID)
          try {
            const groups = fixture.ports.device.groups
            const seed = await storageSeed(donor.ports)
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
          const seed = await storageSeed(donor.ports)
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
