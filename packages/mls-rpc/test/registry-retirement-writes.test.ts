import { signLedgerEntry } from '@kumiai/mls'
import { asLogPosition, type ControlChanges, controlSettled } from '@kumiai/rpc'
import { describe, expect, test } from 'vitest'

import { physicalRecordKey } from '../src/persistence-codec.js'
import type {
  AppOutboxEntry,
  GroupStores,
  MemoryTransaction,
  PersistenceEvent,
} from '../src/persistence-types.js'
import { createGroupHandleRegistry } from '../src/registry/registry.js'
import { retireIncarnation } from '../src/registry/retired.js'
import {
  createRegistryFixture,
  type RegistryFixtureBase,
  registryFixtureRestore,
  registryFixtureRetirement,
} from './fixtures/registry.js'
import { makeStorageSeed, nextChange } from './fixtures/storage-seed.js'

const groupID = 'retirement-writes'
const source = { groupID, incarnation: 1 }
const mutationID = 'retire-source'
const utf8 = (value: string) => new TextEncoder().encode(value)
function entry(seq: number, attempted = false): AppOutboxEntry {
  return {
    seq,
    protocol: 'chat',
    prc: 'posted',
    data: utf8(`immutable-message-${seq}`),
    status: 'accepted',
    lastAttempt: attempted
      ? {
          incarnation: 1,
          epoch: 0,
          floor: null,
          attempts: 2,
          publishID: `publish-${seq}`,
          segment: 0,
          topicID: 'old-topic',
        }
      : null,
  }
}
function failed(value: AppOutboxEntry): PersistenceEvent {
  return {
    ...source,
    id: JSON.stringify(['incarnation-abandoned', groupID, 1, value.seq]),
    kind: 'failed',
    reason: 'incarnation-abandoned',
    nextIncarnation: 2,
    entry: { ...value, status: 'failed' },
  }
}

for (const mode of ['real-mls', 'double'] as const) {
  describe(`drained retirement writes -- ${mode}`, () => {
    const create = () => createRegistryFixture({ mode, setup: 'seeded', groupID })
    async function destination(fixture: RegistryFixtureBase) {
      return makeStorageSeed({
        id: groupID,
        incarnation: 2,
        epoch: 1,
        mode,
        identity: fixture.identity,
        options: fixture.environment.options,
      })
    }
    async function install(
      stores: GroupStores<MemoryTransaction>,
      candidate: Awaited<ReturnType<typeof destination>>,
    ) {
      const lifetime = await stores.lifetime.load()
      const trust = await stores.trust.load()
      if (lifetime === null || trust === null) throw new Error('Missing source')
      await stores.lifetime.save({
        ...lifetime,
        latestIncarnation: 2,
        activeIncarnation: 2,
        revision: lifetime.revision + 1,
        mutationID,
      })
      await stores.incarnation(2).state.save(candidate.state)
      await stores.trust.save({
        ...candidate.trust,
        genesisAnchor: trust.genesisAnchor,
        spentEpochAuthenticators: trust.spentEpochAuthenticators,
      })
      await stores.incarnation(2).control.apply({ cursor: null }, mutationID)
      await stores.incarnation(2).anchor.save(null)
      await stores.incarnation(2).cursor.save('new-topic', '0')
    }
    async function switchSource(fixture: RegistryFixtureBase, switchedRejoinID?: string) {
      const groups = fixture.device.groups
      const candidate = await destination(fixture)
      await groups.transition(await nextChange(groups, groupID, mutationID), async (stores) => {
        await retireIncarnation(stores, {
          source,
          nextIncarnation: 2,
          switchedRejoinID,
          mutationID,
          at: 1234,
        })
        await install(stores, candidate)
      })
    }

    test('retirement writes before pointer change', async () => {
      const fixture = await create()
      try {
        await fixture.installRows({ key: source, outbox: [entry(1)] })
        const groups = fixture.device.groups
        const candidate = await destination(fixture)
        const before = await fixture.inspectRows()
        await expect(
          groups.transition(await nextChange(groups, groupID, mutationID), async (stores) => {
            await install(stores, candidate)
            await retireIncarnation(stores, { source, nextIncarnation: 2, mutationID, at: 1234 })
          }),
        ).rejects.toMatchObject({ name: 'DisplacedGroupHandleError' })
        expect(await fixture.inspectRows()).toEqual(before)
        await switchSource(fixture)
        expect(await groups.loadState(source)).toMatchObject({ deleted: true })
        expect(await groups.ports(source).outbox.list()).toEqual([])
        expect(await groups.ports(source).outbox.events()).toEqual([failed(entry(1))])
        expect(await groups.load(groupID)).toMatchObject({ activeIncarnation: 2 })
        expect(await groups.ports({ groupID, incarnation: 2 }).outbox.list()).toEqual([])
      } finally {
        await fixture.close()
      }
    })

    test('every uncertified entry fails once', async () => {
      let fixture = await create()
      try {
        const previouslyFailed = { ...entry(3, true), status: 'failed' as const }
        const entries = [entry(1), entry(2, true), previouslyFailed]
        await fixture.installRows({
          key: source,
          outbox: entries,
          events: [failed(previouslyFailed)],
        })
        await switchSource(fixture)
        const expected = entries.map(failed)
        const ports = fixture.device.groups.ports(source)
        expect(await ports.outbox.list()).toEqual([])
        expect((await ports.outbox.events()).sort((a, b) => a.entry.seq - b.entry.seq)).toEqual(
          expected,
        )
        fixture = await fixture.reopen()
        const reopened = fixture.device.groups.ports(source)
        expect((await reopened.outbox.events()).sort((a, b) => a.entry.seq - b.entry.seq)).toEqual(
          expected,
        )
        await reopened.outbox.remove(2)
        expect((await reopened.outbox.events()).sort((a, b) => a.entry.seq - b.entry.seq)).toEqual(
          expected,
        )
        expect(
          await fixture.device.groups.ports({ groupID, incarnation: 2 }).outbox.list(),
        ).toEqual([])
      } finally {
        await fixture.close()
      }
    })

    test('conflicting stable failure events refuse retirement', async () => {
      const fixture = await create()
      try {
        const event = failed(entry(1))
        if (event.kind !== 'failed') throw new Error('Missing failure event')
        await fixture.installRows({
          key: source,
          outbox: [entry(1)],
          events: [{ ...event, nextIncarnation: 3 }],
        })
        const before = await fixture.inspectRows()
        await expect(switchSource(fixture)).rejects.toMatchObject({
          name: 'GroupStateConflictError',
        })
        expect(await fixture.inspectRows()).toEqual(before)
      } finally {
        await fixture.close()
      }
    })

    test('certified entries and settlements remain unchanged', async () => {
      const fixture = await create()
      try {
        const certified = entry(2, true)
        const obligation = {
          sequenceID: '19',
          attemptID: 'publish-2',
          topicID: 'old-topic',
          outcome: 'published' as const,
        }
        await fixture.installRows({
          key: source,
          outbox: [entry(1), certified],
          settlements: [{ seq: 2, value: obligation }],
        })
        const before = await fixture.inspectRows()
        await switchSource(fixture)
        const after = await fixture.inspectRows()
        for (const [namespace, recordID] of [
          ['outbox', '2'],
          ['meta', JSON.stringify(['settlement', 2])],
        ] as const) {
          const key = physicalRecordKey({ ...source, namespace, recordID })
          expect(after[namespace]?.get(key)).toEqual(before[namespace]?.get(key))
        }
        const outbox = fixture.device.groups.ports(source).outbox
        expect(await outbox.list()).toEqual([certified])
        expect(await outbox.loadSettlement(2)).toEqual(obligation)
        expect(await outbox.events()).toEqual([failed(entry(1))])
        await expect(outbox.remove(2)).rejects.toThrow()
        expect(await outbox.list()).toEqual([certified])
        await outbox.remove(2, { incarnation: 1, segment: 0, topicID: 'old-topic', position: '19' })
        expect(await outbox.list()).toEqual([])
        expect(await outbox.loadSettlement(2)).toBeNull()
      } finally {
        await fixture.close()
      }
    })

    test('fully settled retirement drain leaves no published entries after switch', async () => {
      const fixture = await create()
      try {
        const certified = entry(2, true)
        const obligation = {
          sequenceID: '19',
          attemptID: 'publish-2',
          topicID: 'old-topic',
          outcome: 'published' as const,
        }
        await fixture.installRows({
          key: source,
          outbox: [certified],
          settlements: [{ seq: 2, value: obligation }],
        })
        const registry = createGroupHandleRegistry({
          persistence: fixture.device,
          providerID: fixture.device.providerID,
          recovery: fixture.environment,
          restore: registryFixtureRestore(fixture),
          restoreCandidate: async () => {
            throw new Error('Drain must not restore a candidate')
          },
        })
        const access = await registry.access(groupID)
        const outbox = fixture.device.groups.ports(source).outbox
        access.onRetire(async () => {
          await outbox.remove(2, {
            incarnation: 1,
            segment: 0,
            topicID: 'old-topic',
            position: '19',
          })
        })
        const attempt = registryFixtureRetirement(registry).beginRetirement(source)
        await attempt.drain()
        expect(await outbox.list()).toEqual([])
        const events = await outbox.events()
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
          kind: 'published',
          entry: certified,
          occurrence: { incarnation: 1, segment: 0, topicID: 'old-topic', position: '19' },
        })
        await switchSource(fixture)
        attempt.settle('committed')
        expect(await outbox.list()).toEqual([])
        expect(await outbox.events()).toEqual(events)
        await expect(access.read(() => {})).rejects.toMatchObject({
          name: 'DisplacedGroupHandleError',
        })
      } finally {
        await fixture.close()
      }
    })

    test('unknown operations keep owed artifacts and slot', async () => {
      const fixture = await create()
      try {
        const state = await fixture.device.groups.loadState(source)
        if (state === null || state.deleted) throw new Error('Missing source')
        const { record } = await fixture.confirmedRecovery(source)
        const identity = { ...source, epoch: state.epoch, authenticator: state.epochAuthenticator }
        const proof = {
          source: { key: source, stateVersion: state.version, identity },
          from: null,
          position: asLogPosition('slot-position'),
          payloadDigest: 'slot-payload-digest',
        }
        const changes: ControlChanges = {
          commitOnce: {
            incarnation: 1,
            epoch: state.epoch,
            authenticatorBefore: state.epochAuthenticator,
            opID: 'old-operation',
            publishID: 'slot-publish',
            payload: utf8('slot-payload'),
            payloadDigest: proof.payloadDigest,
            digest: 'slot-commit-digest',
            journal: utf8('retained-journal'),
            bodies: [],
            welcome: { bytes: utf8('invitation'), recipients: ['recipient'] },
            searchFrom: null,
            expectedHead: null,
          },
          commitOnceAcceptance: proof,
          controlHold: { reason: 'acceptance-unknown', position: proof.position },
          strand: { reason: 'retention-gap' },
          putOperations: [
            {
              id: 'old-operation',
              kind: 'rotation',
              revokes: true,
              body: utf8('rotate'),
              seq: 1,
              enqueuedAt: 1,
              deadline: 1000,
              stage: 'intent',
            },
          ],
          putRejoin: { ...record, stage: 'published' },
          putOutcomes: [
            {
              id: 'owed',
              opID: 'owed',
              at: 12,
              kind: 'landed',
              position: asLogPosition('owed-position'),
            },
          ],
          putWelcomes: [
            {
              opID: 'owed',
              welcome: utf8('owed-welcome'),
              recipients: ['recipient'],
              committed: true,
            },
          ],
          putResponses: [
            {
              position: asLogPosition('response-position'),
              digest: 'response-digest',
              kind: 'applied',
              epoch: 0,
              epochAfter: 1,
            },
          ],
          putApplied: [
            {
              epoch: 0,
              digest: 'applied-digest',
              payloadDigest: 'applied-payload',
              sequenceID: 'applied-position',
              opID: null,
              removed: false,
            },
          ],
          cursor: {
            epoch: 0,
            position: asLogPosition('source-position'),
            stranded: true,
            fork: { conflictEpoch: 1, sharedPosition: null, frameDigest: 'fork-frame' },
          },
        }
        await fixture.installRows({ key: source, control: changes })
        const control = fixture.device.groups.ports(source).control
        const before = await control.load()
        await switchSource(fixture)
        expect(await control.load()).toEqual({
          ...before,
          operations: [],
          rejoin: null,
          outcomes: [
            ...before.outcomes,
            { id: 'old-operation', opID: 'old-operation', at: 1234, kind: 'unknown' },
            { id: record.id, opID: null, at: 1234, kind: 'unknown' },
          ],
        })
        await expect(control.apply({ putRejoin: record }, 'retired-put')).rejects.toMatchObject({
          name: 'DisplacedGroupHandleError',
        })
        await expect(control.apply({ deleteRejoin: true }, 'retired-delete')).rejects.toMatchObject(
          { name: 'DisplacedGroupHandleError' },
        )
      } finally {
        await fixture.close()
      }
    })

    test('switched rejoin remains adopted with ledgerBefore', async () => {
      let fixture = await create()
      try {
        const { candidate, record } = await fixture.confirmedRecovery(source)
        const missing = await signLedgerEntry(fixture.identity, {
          type: 'kumiai.role',
          groupID,
          subject: fixture.identity.id,
          value: 'member',
        })
        expect(candidate.ledgerTokens).not.toContain(missing)
        const continuation = { ...record, ledgerBefore: [missing, ...record.ledgerBefore, missing] }
        await fixture.installRows({ key: source, control: { putRejoin: continuation } })
        await switchSource(fixture, record.id)
        fixture = await fixture.reopen()
        const control = await fixture.device.groups.ports(source).control.load()
        expect(control.rejoin).toEqual({ ...continuation, stage: 'adopted' })
        expect(control.rejoin?.ledgerBefore).toEqual([missing, ...record.ledgerBefore, missing])
        expect(control.outcomes).toEqual([])
        expect(control.operations).toEqual([])
        const fresh = fixture.device.groups.ports({ groupID, incarnation: 2 })
        expect((await fresh.control.load()).operations).toEqual([])
        expect(await fresh.outbox.list()).toEqual([])
      } finally {
        await fixture.close()
      }
    })

    test('adopted rejoin blocks deletion after transport cleanup', async () => {
      let fixture = await create()
      try {
        const { record } = await fixture.confirmedRecovery(source)
        await fixture.installRows({ key: source, control: { putRejoin: record } })
        await switchSource(fixture, record.id)
        const groups = fixture.device.groups
        expect(controlSettled(await groups.ports(source).control.load())).toBe(false)
        await groups.transition(
          await nextChange(groups, groupID, 'cleanup-retired-transport'),
          async (stores) => {
            await stores.incarnation(1).clearTransport()
          },
        )
        fixture = await fixture.reopen()
        const control = fixture.device.groups.ports(source).control
        const snapshot = await control.load()
        expect(snapshot.rejoin).toEqual({ ...record, stage: 'adopted' })
        expect(controlSettled(snapshot)).toBe(false)
        await expect(control.apply({ deleteRejoin: true }, 'delete-adopted')).rejects.toMatchObject(
          { name: 'DisplacedGroupHandleError' },
        )
      } finally {
        await fixture.close()
      }
    })

    test.each(['wrong-id', 'unconfirmed'] as const)(
      'refuses switched rejoin with %s',
      async (invalid) => {
        const fixture = await create()
        try {
          const { record } = await fixture.confirmedRecovery(source)
          await fixture.installRows({
            key: source,
            control: {
              putRejoin: invalid === 'unconfirmed' ? { ...record, stage: 'published' } : record,
            },
          })
          const before = await fixture.inspectRows()
          await expect(
            switchSource(fixture, invalid === 'wrong-id' ? 'other-rejoin' : record.id),
          ).rejects.toMatchObject({ name: 'GroupStateConflictError' })
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )

    test('mid-write rollback preserves both sides', async () => {
      const fixture = await create()
      try {
        const { record } = await fixture.confirmedRecovery(source)
        await fixture.installRows({
          key: source,
          outbox: [entry(1), entry(2, true)],
          control: { putRejoin: record },
        })
        const before = await fixture.inspectRows()
        const candidate = await destination(fixture)
        const groups = fixture.device.groups
        await expect(
          groups.transition(await nextChange(groups, groupID, mutationID), async (stores) => {
            await retireIncarnation(stores, {
              source,
              nextIncarnation: 2,
              switchedRejoinID: record.id,
              mutationID,
              at: 1234,
            })
            expect(await stores.incarnation(1).outbox.list()).toEqual([])
            expect((await stores.incarnation(1).control.load()).rejoin?.stage).toBe('adopted')
            await install(stores, candidate)
            throw new Error('Installation interrupted')
          }),
        ).rejects.toThrow('Installation interrupted')
        expect(await fixture.inspectRows()).toEqual(before)
        expect(await groups.loadState({ groupID, incarnation: 2 })).toBeNull()
        expect(await groups.ports(source).outbox.events()).toEqual([])
        fixture.armWorkFault(mutationID, 'before-commit')
        await expect(switchSource(fixture, record.id)).rejects.toThrow(
          'Injected before-commit failure',
        )
        expect(await fixture.inspectRows()).toEqual(before)
      } finally {
        await fixture.close()
      }
    })
  })
}
