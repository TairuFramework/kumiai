import { randomIdentity } from '@kokuin/token'
import { encodeEventFrame } from '@kumiai/broadcast'
import {
  asLogPosition,
  type ControlChanges,
  encodeAppAAD,
  forkEventID,
  type ProtocolSurface,
  recoveryUnavailableEventID,
} from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import { finaliseAppSettlements } from '../src/app-settlement.js'
import type { AccountedGroupObservation } from '../src/entry-capability.js'
import { entryCapability } from '../src/entry-capability.js'
import { createLedgerEntrySlot } from '../src/mls.js'
import {
  decodeStoredValue,
  encodeStoredValue,
  physicalRecordKey,
  recordAAD,
} from '../src/persistence-codec.js'
import type {
  AppOutboxEntry,
  AppStatusEvent,
  GroupKey,
  MemoryTransaction,
} from '../src/persistence-types.js'
import { createRegistryGroupMLS } from '../src/registry-group-mls.js'
import { gateRegistryMaintenance } from '../src/testing.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
import {
  createRegistryFixture,
  type PendingFault,
  type RegistryFixture,
} from './fixtures/registry.js'
import { startLeaseRotationPeer } from './fixtures/registry-lease-rotation.js'
import {
  createStorageFixture as createStorage,
  type RegistryStorageFixture,
  writeSideRow,
} from './fixtures/storage-persistence.js'
import { installSeed, makeStorageSeed, nextChange } from './fixtures/storage-seed.js'

async function createStorageFixture(params: Parameters<typeof createStorage>[0]) {
  const identity = params.identity ?? randomIdentity()
  const fixture = await createStorage({ ...params, identity, setup: 'empty' })
  await installSeed(
    fixture.ports.device.groups,
    await makeStorageSeed({ id: params.id, incarnation: 1, epoch: 3, mode: params.mode }),
    'seed',
  )
  return fixture
}

const holds = [
  'fork-halted',
  'recovery-unavailable',
  'spent-set-corrupt',
  'legacy-control',
  'revoke',
  'rotation-required',
] as const
const codec = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(98) })
const entry: AppOutboxEntry = {
  seq: 70,
  protocol: 'chat',
  prc: 'posted',
  data: encodeEventFrame('posted', { text: 'original' }),
  status: 'accepted',
  lastAttempt: {
    incarnation: 1,
    epoch: 3,
    segment: 0,
    floor: null,
    attempts: 1,
    publishID: 'original-attempt',
    topicID: 'original-topic',
  },
}
const obligation = {
  sequenceID: '00000000000000000042',
  attemptID: 'original-attempt',
  topicID: 'original-topic',
  outcome: 'published' as const,
}

async function certify(fixture: RegistryStorageFixture, key: GroupKey) {
  const groups = fixture.ports.device.groups
  const outbox = groups.ports(key).outbox
  await outbox.put(entry)
  await outbox.put({ ...entry, seq: 71, lastAttempt: null })
  const state = await groups.loadState(key)
  if (state === null || state.deleted) throw new Error('Missing source')
  expect(
    await outbox.recordSettlement(entry.seq, obligation, {
      identity: { ...key, epoch: state.epoch, authenticator: state.epochAuthenticator },
      stateVersion: state.version,
      attemptID: obligation.attemptID,
    }),
  ).toEqual({ recorded: true })
}

async function hold(fixture: RegistryStorageFixture, key: GroupKey, kind: (typeof holds)[number]) {
  const groups = fixture.ports.device.groups
  if (kind === 'spent-set-corrupt') {
    const address = {
      groupID: key.groupID,
      incarnation: null,
      namespace: 'trust',
      recordID: 'current',
    }
    const bytes = (await fixture.inspectRows()).trust?.get(physicalRecordKey(address))
    if (!(bytes instanceof Uint8Array)) throw new Error('Missing trust')
    const trust = decodeStoredValue(await codec.open(bytes, recordAAD(address))) as Record<
      string,
      unknown
    >
    trust.spentEpochAuthenticators = []
    const changed = await codec.seal(encodeStoredValue(trust), recordAAD(address))
    await fixture.mutateStoredRecord('trust', physicalRecordKey(address), () => changed)
    return
  }
  if (kind === 'rotation-required') {
    const state = await groups.loadState(key)
    if (state === null || state.deleted) throw new Error('Missing source')
    await groups.transition(
      await nextChange(groups, key.groupID, crypto.randomUUID()),
      async (stores) => {
        await stores
          .incarnation(key.incarnation)
          .state.save({ ...state, version: state.version + 1, senderHWM: 500 })
      },
    )
    return
  }
  const changes: ControlChanges =
    kind === 'fork-halted'
      ? {
          forkHalt: {
            eventID: forkEventID(key),
            detectedAt: 1,
            evidence: {
              kind: 'epoch-authenticator',
              epoch: 0,
              local: new Uint8Array([1]),
              remote: new Uint8Array([2]),
            },
          },
        }
      : kind === 'recovery-unavailable'
        ? {
            recoveryUnavailable: {
              ...key,
              id: recoveryUnavailableEventID(key),
              kind: 'group:recovery-unavailable',
              reason: 'trust-unreadable',
            },
          }
        : kind === 'legacy-control'
          ? { controlHold: { reason: 'unsupported-version', position: asLogPosition('42') } }
          : {
              putOperations: [
                {
                  id: 'revoke',
                  seq: 1,
                  kind: 'remove',
                  revokes: true,
                  body: new Uint8Array(),
                  enqueuedAt: 1,
                  deadline: 30_001,
                  stage: 'intent',
                },
              ],
            }
  await groups.ports(key).control.apply(changes, crypto.randomUUID())
}

async function retire(fixture: RegistryStorageFixture, key: GroupKey) {
  const groups = fixture.ports.device.groups
  const change = await nextChange(groups, key.groupID, crypto.randomUUID())
  await groups.transition(change, async (stores) => {
    const lifetime = await stores.lifetime.load()
    if (lifetime === null) throw new Error('Missing lifetime')
    await stores.lifetime.save({
      ...lifetime,
      activeIncarnation: null,
      revision: lifetime.revision + 1,
      mutationID: change.mutationID,
    })
  })
}

for (const mode of ['real-mls', 'double'] as const) {
  describe(`certified app finalisation / ${mode}`, () => {
    for (const stateKind of ['active', 'terminal', 'retired'] as const) {
      test.each(holds)(
        `corrupt source state cannot block certified finalisation / ${stateKind} / %s`,
        async (held) => {
          const effects: Array<AppStatusEvent> = []
          const fixture = await createStorageFixture({
            id: 'frozen',
            mode,
            effects: {
              outbox: async (tx, event) => {
                if (event.kind !== 'published') return
                await writeSideRow(tx, event.id, new Uint8Array([42]))
                tx.onCommit(() => effects.push(event))
              },
            },
          })
          const key = { groupID: 'frozen', incarnation: 1 }
          try {
            await certify(fixture, key)
            if (stateKind === 'terminal') {
              const groups = fixture.ports.device.groups
              const source = await groups.loadState(key)
              if (source === null || source.deleted) throw new Error('Missing source')
              await groups.transition(
                await nextChange(groups, key.groupID, crypto.randomUUID()),
                async (stores) => {
                  await stores
                    .incarnation(1)
                    .state.save({ ...source, version: source.version + 1, terminal: true })
                },
              )
            }
            await hold(fixture, key, held)
            if (stateKind === 'retired') await retire(fixture, key)
            const stateKey = physicalRecordKey({ ...key, namespace: 'state', recordID: 'current' })
            await fixture.mutateStoredRecord('state', stateKey, (bytes) => {
              bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 1
              return bytes
            })
            await fixture.reopen()
            const before = await fixture.inspectRows()
            const opens: Array<string> = []
            fixture.observeCodec((kind, namespace) => {
              if (kind === 'open') opens.push(namespace)
            })
            const observations: Array<AccountedGroupObservation> = []
            fixture.entry().observe(key.groupID, (value) => observations.push(value))
            let failure: unknown
            try {
              await finaliseAppSettlements({ persistence: fixture.ports.device.groups, key })
              await finaliseAppSettlements({ persistence: fixture.ports.device.groups, key })
            } catch (error) {
              failure = error
            }
            expect.soft(opens).not.toContain('state')
            expect(failure).toBeUndefined()
            expect(observations).toHaveLength(1)
            expect(observations[0]?.stateStatus).toBe('unobserved')
            const after = await fixture.inspectRows()
            expect(after.state).toEqual(before.state)
            const outbox = fixture.ports.device.groups.ports(key).outbox
            const published = (await outbox.events()).filter((event) => event.kind === 'published')
            expect(published).toHaveLength(1)
            expect(published[0]).toMatchObject({
              ...key,
              entry,
              occurrence: {
                incarnation: 1,
                segment: 0,
                topicID: obligation.topicID,
                position: obligation.sequenceID,
              },
            })
            expect(effects).toEqual(published)
            expect(after['host-side']?.size).toBe(1)
            expect(await outbox.loadSettlement(70)).toBeNull()
            expect((await outbox.list()).map((value) => value.seq)).toEqual([71])
          } finally {
            await fixture.close()
          }
        },
      )
    }

    test('held reconstruction finalises only persisted publication obligations', async () => {
      const fixture = await createStorageFixture({ id: 'held', mode })
      const key = { groupID: 'held', incarnation: 1 }
      try {
        await certify(fixture, key)
        fixture.failNext('before-commit')
        await expect(
          fixture.ports.device.groups.ports(key).outbox.remove(70, {
            incarnation: 1,
            segment: 0,
            topicID: obligation.topicID,
            position: obligation.sequenceID,
          }),
        ).rejects.toThrow()
        await hold(fixture, key, 'fork-halted')
        await fixture.reopen()
        await finaliseAppSettlements({ persistence: fixture.ports.device.groups, key })
        expect(
          (await fixture.ports.device.groups.ports(key).outbox.list()).map((row) => row.seq),
        ).toEqual([71])
        expect(
          (await fixture.ports.device.groups.ports(key).outbox.events()).filter(
            (row) => row.kind === 'published',
          ),
        ).toHaveLength(1)
      } finally {
        await fixture.close()
      }
    })

    test('certified finalisation advances metadata CAS without rewriting state', async () => {
      const fixture = await createStorageFixture({ id: 'version', mode })
      const key = { groupID: 'version', incarnation: 1 }
      try {
        await certify(fixture, key)
        const groups = fixture.ports.device.groups
        const state = await groups.loadState(key)
        if (state === null) throw new Error('Missing source')
        const before = await fixture.inspectRows()
        await finaliseAppSettlements({ persistence: groups, key })
        expect((await fixture.inspectRows()).state).toEqual(before.state)
        await fixture.reopen()
        const reopened = fixture.ports.device.groups
        const projected = await reopened.loadState(key)
        expect(projected?.version).toBe(state.version + 1)
        await expect(
          reopened.transition(await nextChange(reopened, key.groupID, 'stale'), async (stores) => {
            await stores.incarnation(1).state.save({ ...state, version: state.version + 1 })
          }),
        ).rejects.toThrow('version')
        if (projected === null) throw new Error('Missing source')
        await reopened.transition(
          await nextChange(reopened, key.groupID, 'fresh'),
          async (stores) => {
            await stores.incarnation(1).state.save({ ...projected, version: projected.version + 1 })
          },
        )
        expect((await reopened.loadState(key))?.version).toBe(state.version + 2)
      } finally {
        await fixture.close()
      }
    })

    test.each(['uncertified', 'attempt', 'topic', 'restore', 'namespace'] as const)(
      'certified finalisation cannot widen into another transition / %s',
      async (damage) => {
        let effectMutation: ((tx: MemoryTransaction) => void) | undefined
        const fixture = await createStorageFixture({
          id: 'restricted',
          mode,
          effects: {
            outbox: async (tx, event) => {
              if (event.kind === 'published') effectMutation?.(tx)
            },
          },
        })
        const key = { groupID: 'restricted', incarnation: 1 }
        try {
          await certify(fixture, key)
          if (damage === 'attempt' || damage === 'topic') {
            const location = { ...key, namespace: 'outbox', recordID: '70' }
            const rows = await fixture.inspectRows()
            const bytes = rows.outbox?.get(physicalRecordKey(location))
            if (!(bytes instanceof Uint8Array)) throw new Error('Missing outbox')
            const decoded = decodeStoredValue(
              await codec.open(bytes, recordAAD(location)),
            ) as AppOutboxEntry
            if (decoded.lastAttempt === null) throw new Error('Missing attempt')
            decoded.lastAttempt[damage === 'attempt' ? 'publishID' : 'topicID'] = 'conflict'
            const changed = await codec.seal(encodeStoredValue(decoded), recordAAD(location))
            await fixture.mutateStoredRecord('outbox', physicalRecordKey(location), () => changed)
          } else if (damage === 'restore') {
            const groups = fixture.ports.device.groups
            const change = await nextChange(groups, key.groupID, 'restore')
            await groups.transition(change, async (stores) => {
              const life = await stores.lifetime.load()
              if (life === null) throw new Error('Missing lifetime')
              await stores.lifetime.save({
                ...life,
                restorePending: true,
                revision: life.revision + 1,
                mutationID: change.mutationID,
              })
            })
          } else if (damage === 'namespace')
            effectMutation = (tx) => {
              tx.rows.cursor?.set(
                JSON.stringify([key.groupID, key.incarnation, 'forbidden']),
                new Uint8Array([1]),
              )
            }
          const before = await fixture.inspectRows()
          await expect(
            fixture.entry().finaliseCertifiedApp(key, damage === 'uncertified' ? 71 : 70),
          ).rejects.toThrow()
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )

    test('removal effect and obligation deletion commit together', async () => {
      let fail = true
      const fixture = await createStorageFixture({
        id: 'atomic',
        mode,
        effects: {
          outbox: async (tx, event) => {
            if (event.kind !== 'published') return
            await writeSideRow(tx, event.id, new Uint8Array([1]))
            if (fail) throw new Error('effect failed')
          },
        },
      })
      const key = { groupID: 'atomic', incarnation: 1 }
      try {
        await certify(fixture, key)
        const before = await fixture.inspectRows()
        await expect(
          finaliseAppSettlements({ persistence: fixture.ports.device.groups, key }),
        ).rejects.toThrow('effect failed')
        expect(await fixture.inspectRows()).toEqual(before)
        fail = false
        await finaliseAppSettlements({ persistence: fixture.ports.device.groups, key })
        const outbox = fixture.ports.device.groups.ports(key).outbox
        expect(await outbox.loadSettlement(70)).toBeNull()
        expect((await outbox.events()).filter((row) => row.kind === 'published')).toHaveLength(1)
        expect((await fixture.inspectRows())['host-side']?.size).toBe(1)
      } finally {
        await fixture.close()
      }
    })
  })
}

async function certifyRegistry(fixture: RegistryFixture, key: GroupKey) {
  const outbox = fixture.device.groups.ports(key).outbox
  if (entry.lastAttempt === null) throw new Error('Missing fixture attempt')
  await outbox.put({ ...entry, lastAttempt: { ...entry.lastAttempt, epoch: 0 } })
  const state = await fixture.device.groups.loadState(key)
  if (state === null || state.deleted) throw new Error('Missing source')
  expect(
    await outbox.recordSettlement(70, obligation, {
      identity: { ...key, epoch: state.epoch, authenticator: state.epochAuthenticator },
      stateVersion: state.version,
      attemptID: obligation.attemptID,
    }),
  ).toEqual({ recorded: true })
}

for (const mode of ['real-mls', 'double'] as const) {
  test(`blocked startup finalisation in group A does not block group B admission / ${mode}`, async () => {
    let fixture = await createRegistryFixture({
      mode,
      setup: 'empty',
      groupID: 'A',
      backgroundMaintenance: 'gated',
    })
    const release = Promise.withResolvers<void>()
    let entered = false
    try {
      for (const groupID of ['A', 'B']) {
        const key = await fixture.registry.seed(await fixture.makeHandle(0, groupID), {
          packageUse: null,
        })
        await certifyRegistry(fixture, key)
      }
      fixture = await fixture.reopen()
      fixture.onPhase('account', async () => {
        if (entered) return
        entered = true
        await release.promise
      })
      const registry = fixture.registry
      const a = registry.access('A')
      void a.catch(() => {})
      await vi.waitFor(() => expect(entered).toBe(true))
      let admittedA = false
      void a.then(
        () => {
          admittedA = true
        },
        () => {},
      )
      const bPromise = registry.access('B')
      let admittedB = false
      void bPromise.then(
        () => {
          admittedB = true
        },
        () => {},
      )
      await vi.waitFor(() => expect(admittedB).toBe(true))
      const b = await bPromise
      expect(b.admission()).toMatchObject({ admissible: true })
      gateRegistryMaintenance(registry).release()
      await b.seal(new Uint8Array([1]), {
        aad: encodeAppAAD({ topicID: 'B-topic', intent: 'log' }),
        intent: 'log',
      })
      expect(
        await fixture.device.groups
          .ports({ groupID: 'B', incarnation: 1 })
          .outbox.loadSettlement(70),
      ).toBeNull()
      expect(admittedA).toBe(false)
      release.resolve()
      expect((await a).admission()).toMatchObject({ admissible: true })
      expect(
        await fixture.device.groups
          .ports({ groupID: 'A', incarnation: 1 })
          .outbox.loadSettlement(70),
      ).toBeNull()
    } finally {
      release.resolve()
      await fixture.close()
    }
  })

  test(`retired finalisation needs no registry access or old peer / ${mode}`, async () => {
    let fixture = await createRegistryFixture({
      mode,
      setup: 'empty',
      groupID: 'retired',
      backgroundMaintenance: 'gated',
    })
    try {
      const key = await fixture.registry.seed(await fixture.makeHandle(0), { packageUse: null })
      await certifyRegistry(fixture, key)
      const recovery = await fixture.confirmedRecovery(key, { confirm: true })
      const mutationID =
        'format' in recovery.record ? recovery.record.switchMutationID : crypto.randomUUID()
      if (mutationID === null) throw new Error('Missing switch mutation')
      const next = await fixture.registry.switchIncarnation(recovery.candidate, {
        source: recovery.source,
        rejoinID: recovery.record.id,
        proof: recovery.proof,
        write: {
          mutationID,
          source: { rejoinID: recovery.record.id },
          destination: {
            control: {
              cursor: {
                position: recovery.proof.position,
                epoch: Number(recovery.candidate.epoch),
              },
            },
          },
        },
      })
      expect(next.incarnation).toBe(2)
      fixture = await fixture.reopen()
      const registry = fixture.registry
      const access = vi.spyOn(registry, 'access')
      const before = await fixture.inspectRows()
      await finaliseAppSettlements({ persistence: fixture.device.groups, key })
      const after = await fixture.inspectRows()
      expect(access).not.toHaveBeenCalled()
      expect(fixture.restores()).toBe(0)
      expect(after.state).toEqual(before.state)
      expect(after.trust).toEqual(before.trust)
      expect(after.anchor).toEqual(before.anchor)
      expect(
        (await fixture.device.groups.ports(key).outbox.events()).filter(
          (event) => event.kind === 'published',
        ),
      ).toHaveLength(1)
      access.mockRestore()
    } finally {
      await fixture.close()
    }
  })

  test(`administrative observation invalidates versions without stranding sends / ${mode}`, async () => {
    const fixture = await createRegistryFixture({
      mode,
      setup: 'empty',
      groupID: 'observed',
      backgroundMaintenance: 'gated',
    })
    try {
      const key = await fixture.registry.seed(await fixture.makeHandle(0), { packageUse: null })
      const access = await fixture.registry.access(key.groupID)
      const mls = await createRegistryGroupMLS({
        registry: fixture.registry,
        key,
        identity: fixture.identity,
        entrySlot: createLedgerEntrySlot(),
        recovery: fixture.environment,
        target: { targetID: 'hub', topicID: 'commits' },
      })
      await certifyRegistry(fixture, key)
      const before = access.stateVersion()
      const snapshots: Array<unknown> = []
      access.runtime.onEpochChanged((value) => snapshots.push(value))
      await finaliseAppSettlements({ persistence: fixture.device.groups, key })
      expect(mls.sendAdmission()).toMatchObject({ admissible: true })
      expect(access.runtime.snapshot()?.stateVersion).toBe(before + 1)
      expect(snapshots).not.toContain(null)
      expect(access.admission()).toMatchObject({ admissible: true })
      await access.seal(new Uint8Array([2]), {
        aad: encodeAppAAD({ topicID: 'observed-app', intent: 'ephemeral' }),
        intent: 'ephemeral',
      })
      await access.read(() => undefined)
      expect(access.stateVersion()).toBe(before + 1)
      const cap = entryCapability(fixture.device.groups)
      expect(cap).not.toBeNull()
    } finally {
      await fixture.close()
    }
  })
}

for (const mode of ['real-mls', 'double'] as const) {
  for (const phase of ['certification', 'finalisation'] as const) {
    test(`disposal retains submitted settlement completion / ambiguous ${phase} / ${mode}`, async () => {
      const fixture = await createRegistryFixture({
        mode,
        setup: 'empty',
        groupID: 'ambiguous',
        backgroundMaintenance: 'gated',
      })
      let running: Awaited<ReturnType<typeof startLeaseRotationPeer>> | undefined
      const hookEntered = Promise.withResolvers<void>()
      const hookRelease = Promise.withResolvers<void>()
      const rejected = Promise.withResolvers<PendingFault>()
      let armed = false
      try {
        const key = await fixture.registry.seed(await fixture.makeHandle(0), { packageUse: null })
        const outbox = fixture.device.groups.ports(key).outbox
        function arm() {
          if (armed) return
          armed = true
          fixture.onPhase('hook', async () => {
            hookEntered.resolve()
            await hookRelease.promise
          })
          const fault = fixture.armNextWorkFault('pending')
          void fault.rejected.then(() => rejected.resolve(fault))
        }
        running = await startLeaseRotationPeer({
          mode,
          fixture,
          key,
          outbox: {
            ...outbox,
            recordSettlement: (...args) => {
              if (phase === 'certification') arm()
              return outbox.recordSettlement(...args)
            },
            remove: (...args) => {
              if (phase === 'finalisation') arm()
              return outbox.remove(...args)
            },
          },
        })
        await running.owner.ready
        const peer = running.owner.peer()
        if (peer === null) throw new Error('Missing live peer')
        const protocol = peer.protocol('chat') as ProtocolSurface<{
          posted: { type: 'event'; retain: 'log'; data: { type: 'object' } }
        }>
        await protocol.dispatch('posted', { data: { text: 'ambiguous' } })
        const fault = await rejected.promise
        await peer.dispose()
        let drained = false
        const drain = peer.drained().then(() => {
          drained = true
        })
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(drained).toBe(false)
        const submitted = running.frames().length
        await fault.finish('commit')
        await hookEntered.promise
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(drained).toBe(false)
        hookRelease.resolve()
        await drain
        expect(await outbox.list()).toEqual([])
        expect(await outbox.loadSettlement(0)).toBeNull()
        expect((await outbox.events()).filter((event) => event.kind === 'published')).toHaveLength(
          1,
        )
        expect(running.frames()).toHaveLength(submitted)
      } finally {
        hookRelease.resolve()
        running?.owner.dispose()
        await running?.owner.drained()
        await fixture.close()
      }
    })
  }
}

test('backup-restored entries do not use the ordinary finalisation exemption', async () => {
  const fixture = await createStorageFixture({ id: 'restored', mode: 'double' })
  const key = { groupID: 'restored', incarnation: 1 }
  try {
    await certify(fixture, key)
    const groups = fixture.ports.device.groups
    const change = await nextChange(groups, key.groupID, 'restore-pending')
    await groups.transition(change, async (stores) => {
      const lifetime = await stores.lifetime.load()
      if (lifetime === null) throw new Error('Missing lifetime')
      await stores.lifetime.save({
        ...lifetime,
        restorePending: true,
        revision: lifetime.revision + 1,
        mutationID: change.mutationID,
      })
    })
    await fixture.reopen()
    const before = await fixture.inspectRows()
    await expect(
      finaliseAppSettlements({ persistence: fixture.ports.device.groups, key }),
    ).rejects.toThrow()
    expect(await fixture.inspectRows()).toEqual(before)
  } finally {
    await fixture.close()
  }
})

test('a concurrent certified removal remains idempotent after another finaliser wins', async () => {
  const fixture = await createStorageFixture({ id: 'concurrent', mode: 'double' })
  const key = { groupID: 'concurrent', incarnation: 1 }
  try {
    await certify(fixture, key)
    const outbox = fixture.ports.device.groups.ports(key).outbox
    const removing = outbox.remove(70, {
      incarnation: 1,
      segment: 0,
      topicID: obligation.topicID,
      position: obligation.sequenceID,
    })
    const finalising = fixture.entry().finaliseCertifiedApp(key, 70)
    await Promise.all([removing, finalising])
    expect((await outbox.events()).filter((event) => event.kind === 'published')).toHaveLength(1)
  } finally {
    await fixture.close()
  }
})

test('certified finalisation cannot widen into another transition / generic callback', async () => {
  const fixture = await createStorageFixture({ id: 'callback', mode: 'double' })
  const key = { groupID: 'callback', incarnation: 1 }
  try {
    await certify(fixture, key)
    const stateKey = physicalRecordKey({ ...key, namespace: 'state', recordID: 'current' })
    await fixture.mutateStoredRecord('state', stateKey, (bytes) => {
      bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 1
      return bytes
    })
    const groups = fixture.ports.device.groups
    const request = {
      ...(await nextChange(groups, key.groupID, 'forged-administrative-mode')),
      key,
      active: false,
      certifiedApp: 71,
    }
    const before = await fixture.inspectRows()
    await expect(
      groups.transition(request, async (stores) => {
        await stores.incarnation(key.incarnation).outbox.remove([71])
      }),
    ).rejects.toThrow()
    expect(await fixture.inspectRows()).toEqual(before)
  } finally {
    await fixture.close()
  }
})

for (const mode of ['real-mls', 'double'] as const) {
  test(`certified finalisation retries proven rollback before queued source work / ${mode}`, async () => {
    const fixture = await createStorageFixture({ id: 'retry-finalisation', mode })
    const key = { groupID: 'retry-finalisation', incarnation: 1 }
    let retried = false
    const retryEntered = Promise.withResolvers<void>()
    const retryRelease = Promise.withResolvers<void>()
    try {
      await certify(fixture, key)
      fixture.onPhase('retry', async () => {
        retried = true
        retryEntered.resolve()
        await retryRelease.promise
      })
      const fault = fixture.armNextWorkFault('pending')
      const finalising = finaliseAppSettlements({ persistence: fixture.ports.device.groups, key })
      void finalising.catch(() => {})
      await fault.rejected
      let queuedFinished = false
      const queued = fixture.ports.device.groups
        .ports(key)
        .control.apply(
          { cursor: { epoch: 3, position: asLogPosition('later') } },
          'queued-after-finalisation',
        )
        .then(() => {
          queuedFinished = true
        })
      await fault.finish('rollback')
      await vi.waitFor(() => expect(retried).toBe(true))
      await retryEntered.promise
      expect(queuedFinished).toBe(false)
      retryRelease.resolve()
      await Promise.all([finalising, queued])
      const outbox = fixture.ports.device.groups.ports(key).outbox
      expect(await outbox.loadSettlement(70)).toBeNull()
      expect((await outbox.events()).filter((event) => event.kind === 'published')).toHaveLength(1)
    } finally {
      retryRelease.resolve()
      await fixture.close()
    }
  })
}

for (const namespace of ['lifetime', 'outbox', 'meta'] as const) {
  test(`certified finalisation refuses corrupt administrative envelopes / ${namespace}`, async () => {
    const fixture = await createStorageFixture({ id: 'bad-envelope', mode: 'double' })
    const key = { groupID: 'bad-envelope', incarnation: 1 }
    try {
      await certify(fixture, key)
      const address = {
        groupID: key.groupID,
        incarnation: namespace === 'lifetime' ? null : 1,
        namespace,
        recordID:
          namespace === 'lifetime'
            ? 'current'
            : namespace === 'outbox'
              ? '70'
              : JSON.stringify(['settlement', 70]),
      }
      await fixture.mutateStoredRecord(namespace, physicalRecordKey(address), (bytes) => {
        bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 1
        return bytes
      })
      await fixture.reopen()
      const before = await fixture.inspectRows()
      await expect(
        finaliseAppSettlements({ persistence: fixture.ports.device.groups, key }),
      ).rejects.toThrow()
      expect(await fixture.inspectRows()).toEqual(before)
    } finally {
      await fixture.close()
    }
  })
}

test('certified finalisation refuses factory fail-stop after conflicting proof', async () => {
  const fixture = await createStorageFixture({ id: 'fail-stop', mode: 'double' })
  const key = { groupID: 'fail-stop', incarnation: 1 }
  const proofEntered = Promise.withResolvers<void>()
  const proofRelease = Promise.withResolvers<void>()
  try {
    await certify(fixture, key)
    fixture.onPhase('proof', async () => {
      proofEntered.resolve()
      await proofRelease.promise
    })
    const fault = fixture.armNextWorkFault('pending')
    const finalising = finaliseAppSettlements({ persistence: fixture.ports.device.groups, key })
    void finalising.catch(() => {})
    await fault.rejected
    await proofEntered.promise
    await fault.finish('commit')
    await fixture.forceOwnerMarker(
      { groupID: key.groupID },
      { mutationID: 'conflict', revision: 999 },
    )
    proofRelease.resolve()
    await expect(finalising).rejects.toThrow('ownership conflict')
    const before = await fixture.inspectRows()
    await expect(
      finaliseAppSettlements({ persistence: fixture.ports.device.groups, key }),
    ).rejects.toThrow('ownership conflict')
    expect(await fixture.inspectRows()).toEqual(before)
  } finally {
    proofRelease.resolve()
    await fixture.close()
  }
})

test('certified finalisation refuses another record AAD', async () => {
  const fixture = await createStorageFixture({ id: 'wrong-aad', mode: 'double' })
  const key = { groupID: 'wrong-aad', incarnation: 1 }
  try {
    await certify(fixture, key)
    const settlement = physicalRecordKey({
      ...key,
      namespace: 'meta',
      recordID: JSON.stringify(['settlement', 70]),
    })
    const version = physicalRecordKey({
      ...key,
      namespace: 'meta',
      recordID: JSON.stringify(['state-version']),
    })
    await fixture.swapStoredRecords('meta', settlement, version)
    await fixture.reopen()
    const before = await fixture.inspectRows()
    await expect(
      finaliseAppSettlements({ persistence: fixture.ports.device.groups, key }),
    ).rejects.toThrow()
    expect(await fixture.inspectRows()).toEqual(before)
  } finally {
    await fixture.close()
  }
})

test('certified removal captures its occurrence before queuing', async () => {
  const fixture = await createStorageFixture({ id: 'captured-occurrence', mode: 'double' })
  const key = { groupID: 'captured-occurrence', incarnation: 1 }
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  try {
    await certify(fixture, key)
    const occurrence = {
      incarnation: 1,
      segment: 0,
      topicID: obligation.topicID,
      position: obligation.sequenceID,
    }
    const blocker = fixture.entry().read(key.groupID, async () => {
      entered.resolve()
      await released.promise
    })
    await entered.promise
    const outbox = fixture.ports.device.groups.ports(key).outbox
    const removing = outbox.remove(70, occurrence)
    void removing.catch(() => {})
    occurrence.topicID = 'changed-after-submit'
    occurrence.position = 'changed-after-submit'
    released.resolve()
    await Promise.all([blocker, removing])
    expect((await outbox.events()).filter((event) => event.kind === 'published')).toMatchObject([
      { occurrence: { topicID: 'original-topic', position: '00000000000000000042' } },
    ])
  } finally {
    released.resolve()
    await fixture.close()
  }
})
