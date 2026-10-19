import {
  type ControllerBinding,
  decodeClientState,
  encodeClientState,
  type GroupHandle,
  ownApplicationGeneration,
  restoreGroup,
} from '@kumiai/mls'
import { forkEventID, type GroupPeer, type LogHub } from '@kumiai/rpc'
import { createMemoryAppOutbox } from '@kumiai/rpc-conformance'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { AppOutboxAcceptance, AppOutboxAcceptanceParams } from '../../rpc/lib/app-outbox.js'
import type { LogDeliveryParams } from '../../rpc/lib/log-delivery.js'
import { createLedgerEntrySlot } from '../src/index.js'
import { registryReceiveSlots } from '../src/registry/live-receive.js'
import { registryLiveSend } from '../src/registry/live-send.js'
import type { Reservation } from '../src/registry/reserve.js'
import { registrySafety } from '../src/registry/safety.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { createRegistryGroupMLS } from '../src/registry-group-mls.js'
import { deferred } from '../src/runtime.js'
import { dropRegistryOwner, gateRegistryMaintenance } from '../src/testing.js'
import { createRegistryLeaseFixture } from './fixtures/registry-lease.js'
import { restoreMemoryControlHandle } from './fixtures/sealed-memory-mls.js'

const fixtures: Array<Awaited<ReturnType<typeof createRegistryLeaseFixture>>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()))
})
async function setup(mode: 'real-mls' | 'double', source: 'seed' | 'welcome' = 'seed') {
  const fixture = await createRegistryLeaseFixture(mode, source)
  fixtures.push(fixture)
  return fixture
}
async function groupMLS(fixture: Awaited<ReturnType<typeof setup>>, open = true) {
  const base = fixture.fixture()
  const mls = await createRegistryGroupMLS({
    registry: base.registry,
    key: fixture.key,
    recovery: base.environment,
    target: { targetID: 'lease-hub', topicID: 'lease-commits' },
    identity: base.identity,
    entrySlot: createLedgerEntrySlot(),
  })
  if (open) await mls.readEpoch()
  return mls
}
function reportedHold(fixture: Awaited<ReturnType<typeof setup>>) {
  const safety = registrySafety(fixture.fixture().registry)
  if (safety === null) throw new Error('Missing safety capability')
  const halt = {
    eventID: `hold-${crypto.randomUUID()}`,
    producer: 'app-report' as const,
    detectedAt: 1,
    evidence: {
      kind: 'digest-divergence' as const,
      epoch: fixture.access().epoch(),
      position: '1',
      localDigest: 'local',
      remoteDigest: 'remote',
    },
  }
  return {
    raise: () => safety.reportHold(fixture.key, halt),
    release: () => safety.prepareReportedHoldRelease(fixture.key, halt)(),
  }
}
async function coldFinalRange(fixture: Awaited<ReturnType<typeof setup>>, generation = 496) {
  const gate = gateRegistryMaintenance(fixture.fixture().registry)
  await fixture.forceStoredGeneration(generation)
  await registryLiveSend.get(fixture.access())?.accounting()
  await fixture.reopen()
  gate.release()
  return gateRegistryMaintenance(fixture.fixture().registry)
}
async function finalRange(fixture: Awaited<ReturnType<typeof setup>>) {
  await fixture.forceStoredGeneration(480)
  await registryLiveSend.get(fixture.access())?.accounting()
  await fixture.drainMaintenance()
  for (let generation = 480; generation < 499; generation++)
    expect((await fixture.sealDurable()).generation).toBe(generation)
}
for (const mode of ['real-mls', 'double'] as const) {
  describe(`rotation admission (${mode})`, () => {
    test('final lease is usable and seal 499 closes GroupMLS acceptance', async () => {
      const fixture = await setup(mode)
      const mls = await groupMLS(fixture)
      await finalRange(fixture)
      expect(mls.sendAdmission()).toMatchObject({ admissible: true })
      expect(fixture.fixture().registry.effectiveNext(fixture.key)).toBe(499)
      expect(
        fixture
          .fixture()
          .registry.effectiveNext({ ...fixture.key, incarnation: fixture.key.incarnation + 1 }),
      ).toBeNull()
      expect((await fixture.sealDurable()).generation).toBe(499)
      expect(mls.sendAdmission()).toMatchObject({ admissible: false, reason: 'rotation-required' })
      await expect(fixture.sealDurable()).rejects.toMatchObject({ reason: 'rotation-required' })
    })
    test('failed encrypt at 499 also closes GroupMLS admission', async () => {
      const fixture = await setup(mode)
      const mls = await groupMLS(fixture)
      await finalRange(fixture)
      const rotations = vi.fn()
      fixture.access().onRotationRequired(rotations)
      fixture.failNextEncrypt('throw-after')
      await expect(fixture.sealEphemeral()).rejects.toThrow()
      expect(rotations).toHaveBeenCalledTimes(1)
      expect(mls.sendAdmission()).toMatchObject({ admissible: false, reason: 'rotation-required' })
    })
    test.each([484, 490, 499])(
      'cold final range at %s notifies only at real exhaustion',
      async (start) => {
        const fixture = await setup(mode)
        const maintenance = await coldFinalRange(fixture, start)
        const mls = await groupMLS(fixture, false)
        const rotations = vi.fn()
        fixture.access().onRotationRequired(rotations)
        maintenance.release()
        await fixture.drainMaintenance()
        expect(rotations).not.toHaveBeenCalled()
        expect(mls.sendAdmission()).toMatchObject({ admissible: true })
        for (let generation = start; generation < 500; generation++) {
          expect(rotations).not.toHaveBeenCalled()
          expect((await fixture.sealEphemeral()).generation).toBe(generation)
        }
        expect(rotations).toHaveBeenCalledTimes(1)
        expect(mls.sendAdmission()).toMatchObject({ reason: 'rotation-required' })
      },
    )
    test.each([false, true])(
      'cold copy restore preserves headroom across a compatible version advance (%s)',
      async (advanceVersion) => {
        const fixture = await setup(mode)
        const maintenance = await coldFinalRange(fixture)
        const mls = await groupMLS(fixture)
        const base = fixture.fixture()
        const rotations = vi.fn()
        fixture.access().onRotationRequired(rotations)
        const entered = deferred<void>()
        const released = deferred<void>()
        let committed = false
        base.onPhase('account', () => {
          committed = true
        })
        base.overrideRestore(async (record) => {
          const state = decodeClientState(record.state)
          if (state === undefined) throw new Error('Invalid restore state')
          if (committed && ownApplicationGeneration(state) === 496) {
            entered.resolve()
            await released.promise
          }
          return (mode === 'real-mls' ? restoreGroup : restoreMemoryControlHandle)({
            state,
            credential: record.credential,
            ledgerEntries: record.ledger,
            options: base.environment.options,
          })
        })
        maintenance.release()
        const draining = fixture.drainMaintenance()
        const { createAppOutboxAcceptance } = (await import(
          new URL('../../rpc/src/app-outbox.ts', import.meta.url).href
        )) as {
          createAppOutboxAcceptance: (params: AppOutboxAcceptanceParams) => AppOutboxAcceptance
        }
        const queue = createAppOutboxAcceptance({
          outbox: createMemoryAppOutbox(),
          limit: 4,
          admission: () => mls.sendAdmission(),
        })
        try {
          await entered.promise
          if (advanceVersion) {
            const record = await fixture.record()
            await base.installRows({
              key: fixture.key,
              state: { ...record, version: record.version + 1 },
            })
            await registryLiveSend.get(fixture.access())?.accounting()
          }
          expect.soft(rotations).not.toHaveBeenCalled()
          expect.soft(mls.sendAdmission()).toMatchObject({ admissible: true })
          await expect.soft(fixture.sealEphemeral()).rejects.toMatchObject({ reason: 'cold' })
          await expect
            .soft(queue.accept({ protocol: 'chat', prc: 'posted', data: new Uint8Array([1]) }))
            .resolves.toBeUndefined()
        } finally {
          released.resolve()
          await draining
          queue.close()
        }
        expect(fixture.lease()).toMatchObject({ own: 496, limit: 500 })
        expect(rotations).not.toHaveBeenCalled()
        for (let generation = 496; generation < 500; generation++)
          expect((await fixture.sealEphemeral()).generation).toBe(generation)
        expect(rotations).toHaveBeenCalledTimes(1)
        expect(mls.sendAdmission()).toMatchObject({ reason: 'rotation-required' })
      },
    )
    test('a rejected cold copy clears pending headroom and notifies exhaustion', async () => {
      const fixture = await setup(mode)
      const maintenance = await coldFinalRange(fixture)
      const mls = await groupMLS(fixture)
      const base = fixture.fixture()
      const rotations = vi.fn()
      fixture.access().onRotationRequired(rotations)
      let committed = false
      base.onPhase('account', () => {
        committed = true
      })
      base.overrideRestore(async (record) => {
        const state = decodeClientState(record.state)
        if (state === undefined) throw new Error('Invalid restore state')
        if (committed && ownApplicationGeneration(state) === 496) {
          const node = state.secretTree.leafNodes[state.privatePath.leafIndex * 2]
          if (node === undefined) throw new Error('Missing own ratchet')
          node.application.generation = 497
        }
        return (mode === 'real-mls' ? restoreGroup : restoreMemoryControlHandle)({
          state,
          credential: record.credential,
          ledgerEntries: record.ledger,
          options: base.environment.options,
        })
      })
      maintenance.release()
      await fixture.drainMaintenance()
      expect(fixture.lease()).toBeNull()
      expect(mls.sendAdmission()).toMatchObject({ reason: 'rotation-required' })
      expect(rotations).toHaveBeenCalledTimes(1)
    })
    test('hold arriving during cold copy restore clears without another storage operation', async () => {
      const fixture = await setup(mode)
      const maintenance = await coldFinalRange(fixture)
      const mls = await groupMLS(fixture)
      const base = fixture.fixture()
      const hold = reportedHold(fixture)
      let committed = false
      base.onPhase('account', () => {
        committed = true
      })
      base.overrideRestore(async (record) => {
        const state = decodeClientState(record.state)
        if (state === undefined) throw new Error('Invalid restore state')
        if (committed && ownApplicationGeneration(state) === 496) hold.raise()
        return (mode === 'real-mls' ? restoreGroup : restoreMemoryControlHandle)({
          state,
          credential: record.credential,
          ledgerEntries: record.ledger,
          options: base.environment.options,
        })
      })
      maintenance.release()
      await fixture.drainMaintenance()
      expect(fixture.lease()).toMatchObject({ own: 496, limit: 500 })
      expect(mls.sendAdmission()).toMatchObject({ reason: 'fork-halted' })
      const transactions = fixture.transactions()
      hold.release()
      expect(mls.sendAdmission()).toMatchObject({ admissible: true })
      expect(fixture.transactions()).toBe(transactions)
    })
    test('hold released after epoch advance recomputes headroom', async () => {
      const fixture = await setup(mode)
      const mls = await groupMLS(fixture)
      await finalRange(fixture)
      await fixture.sealDurable()
      const base = fixture.fixture()
      const record = await fixture.record()
      const next = await base.advance(await base.restoreCommittedSender())
      const trust = recoveryTrustFor(
        next,
        fixture.key,
        await base.device.groups.loadTrust(fixture.key.groupID),
      )
      const halt = {
        eventID: forkEventID(fixture.key),
        producer: 'app-report' as const,
        detectedAt: 1,
        evidence: {
          kind: 'digest-divergence' as const,
          epoch: fixture.access().epoch(),
          position: '1',
          localDigest: 'local',
          remoteDigest: 'remote',
        },
      }
      await base.installRows({
        key: fixture.key,
        trust,
        control: { forkHalt: halt },
        state: {
          ...record,
          version: record.version + 1,
          epoch: Number(next.epoch),
          state: encodeClientState(next.state),
          epochAuthenticator: next.state.keySchedule.epochAuthenticator,
          senderHWM: 0,
        },
      })
      await registryLiveSend.get(fixture.access())?.accounting()
      expect(mls.sendAdmission()).toMatchObject({ reason: 'fork-halted' })
      const safety = registrySafety(base.registry)
      if (safety === null) throw new Error('Missing safety capability')
      safety.prepareReportedHoldRelease(fixture.key, halt)()
      expect(mls.sendAdmission()).toMatchObject({ admissible: true, epoch: Number(next.epoch) })
    })
    test.each(['seal', 'failed-encrypt', 'copy-loss'] as const)(
      'unopened GroupMLS follows memory-only %s',
      async (operation) => {
        const fixture = await setup(mode)
        await finalRange(fixture)
        const mls = await groupMLS(fixture, false)
        expect(mls.sendAdmission()).toMatchObject({ admissible: true })
        if (operation === 'seal') await fixture.sealEphemeral()
        else if (operation === 'failed-encrypt') {
          fixture.failNextEncrypt('throw-after')
          await expect(fixture.sealEphemeral()).rejects.toThrow()
        } else registryLiveSend.get(fixture.access())?.invalidate()
        expect(mls.sendAdmission()).toMatchObject({ reason: 'rotation-required' })
      },
    )
    test.each(['own', 'senderHWM'] as const)(
      'ownerless construction uses committed %s',
      async (field) => {
        const fixture = await setup(mode)
        if (field === 'own') await fixture.forceStoredGeneration(500)
        else {
          const record = await fixture.record()
          await fixture.fixture().installRows({
            key: fixture.key,
            state: { ...record, senderHWM: 500, version: record.version + 1 },
          })
        }
        await fixture.reopen(false)
        expect(fixture.fixture().registry.effectiveNext(fixture.key)).toBeNull()
        const mls = await groupMLS(fixture, false)
        expect(mls.sendAdmission()).toMatchObject({ reason: 'rotation-required' })
      },
    )
    test('unopened GroupMLS retains committed progress after owner loss', async () => {
      const fixture = await setup(mode)
      const mls = await groupMLS(fixture, false)
      await finalRange(fixture)
      dropRegistryOwner(fixture.access())
      expect(fixture.fixture().registry.effectiveNext(fixture.key)).toBeNull()
      expect(mls.sendAdmission()).toMatchObject({ reason: 'rotation-required' })
    })
    test.each([499, 500])('ownerless commit refreshes senderHWM %s', async (senderHWM) => {
      const fixture = await setup(mode)
      await fixture.reopen(false)
      const base = fixture.fixture()
      const mls = await groupMLS(fixture, false)
      const safety = registrySafety(base.registry)
      if (safety === null) throw new Error('Missing safety capability')
      const updates = vi.fn()
      const unsubscribe = safety.onAdmissionChanged(fixture.key, updates)
      try {
        expect(base.registry.effectiveNext(fixture.key)).toBeNull()
        expect(mls.sendAdmission()).toMatchObject({ admissible: true })
        const record = await fixture.record()
        await base.installRows({
          key: fixture.key,
          state: { ...record, senderHWM, version: record.version + 1 },
        })
        await safety.entry.read(fixture.key.groupID, async () => {})
        expect(base.registry.effectiveNext(fixture.key)).toBeNull()
        expect(mls.sendAdmission()).toMatchObject(
          senderHWM === 500
            ? { admissible: false, reason: 'rotation-required' }
            : { admissible: true },
        )
        expect(updates).toHaveBeenCalledExactlyOnceWith(senderHWM)
      } finally {
        unsubscribe()
      }
    })
    test('committed progress refreshes without an effective admission change', async () => {
      const fixture = await setup(mode)
      const gate = gateRegistryMaintenance(fixture.fixture().registry)
      const mls = await groupMLS(fixture, false)
      const safety = registrySafety(fixture.fixture().registry)
      if (safety === null) throw new Error('Missing safety capability')
      const updates = vi.fn()
      const changes = vi.fn()
      const unsubscribe = safety.onAdmissionChanged(fixture.key, updates)
      const unsubscribeAccess = fixture.access().onAdmissionChanged(changes)
      try {
        const record = await fixture.record()
        await fixture.fixture().installRows({
          key: fixture.key,
          state: { ...record, senderHWM: 499, version: record.version + 1 },
        })
        await registryLiveSend.get(fixture.access())?.accounting()
        expect(mls.sendAdmission()).toMatchObject({ admissible: true })
        expect(changes).not.toHaveBeenCalled()
        expect(updates).toHaveBeenCalledWith(499)
      } finally {
        unsubscribe()
        unsubscribeAccess()
        gate.release()
      }
    })
    test('restored headroom clears the same-identity rotation latch', async () => {
      const fixture = await setup(mode)
      const gate = gateRegistryMaintenance(fixture.fixture().registry)
      try {
        await fixture.forceStoredGeneration(496)
        const live = registryLiveSend.get(fixture.access())
        if (live === undefined) throw new Error('Missing live sender')
        await live.accounting()
        let reservation: Reservation | undefined
        await fixture.reserveNow(undefined, (value) => {
          reservation = value
        })
        if (reservation === undefined) throw new Error('Missing final reservation')
        const rotations = vi.fn()
        fixture.access().onRotationRequired(rotations)
        expect(rotations).not.toHaveBeenCalled()
        live.invalidate()
        expect(rotations).toHaveBeenCalledTimes(1)
        // No generation was sealed before losing this copy.
        await live.handoff(reservation)
        expect(fixture.admission()).toMatchObject({ admissible: true })
        for (let generation = 496; generation < 500; generation++)
          expect((await fixture.sealEphemeral()).generation).toBe(generation)
        expect(rotations).toHaveBeenCalledTimes(2)
      } finally {
        gate.release()
      }
    })
    test('exhausted identity replays to first and late subscribers after reopen', async () => {
      const fixture = await setup(mode)
      await finalRange(fixture)
      await fixture.sealDurable()
      await fixture.reopen()
      const first = vi.fn()
      const late = vi.fn()
      fixture.access().onRotationRequired(first)
      expect(first).toHaveBeenCalledTimes(1)
      await fixture.writeElsewhere('control')
      fixture.access().onRotationRequired(late)
      expect(first).toHaveBeenCalledTimes(1)
      expect(late).toHaveBeenCalledTimes(1)
    })
    test.each(['fork-halted', 'terminal'] as const)(
      '%s takes precedence at 500',
      async (reason) => {
        const fixture = await setup(mode)
        const mls = await groupMLS(fixture, false)
        await fixture.forceStoredGeneration(500)
        await registryLiveSend.get(fixture.access())?.accounting()
        if (reason === 'fork-halted') await fixture.holdSafety()
        else await fixture.setUnavailable()
        expect(fixture.admission()).toMatchObject({ reason })
        expect(mls.sendAdmission()).toMatchObject({ reason })
      },
    )
    test('spent-set corruption emits an admission change', async () => {
      const fixture = await setup(mode)
      const changes: Array<string> = []
      fixture.access().onAdmissionChanged(() => {
        const next = fixture.admission()
        changes.push(next.admissible ? 'admissible' : next.reason)
      })
      const atProof: Array<Array<string>> = []
      const safety = registrySafety(fixture.fixture().registry)
      if (safety === null) throw new Error('Missing safety capability')
      const unsubscribe = safety.entry.observe(fixture.key.groupID, (observation) => {
        if (observation.trustStatus === 'spent-set-corrupt') atProof.push([...changes])
      })
      try {
        await fixture.fixture().corruptTrust(fixture.key.groupID, 'empty-spent')
        await fixture.writeElsewhere('control')
        expect(atProof).toContainEqual(['spent-set-corrupt'])
      } finally {
        unsubscribe()
      }
    })
    test('cached load notifies when admission changes without another restore', async () => {
      const fixture = await setup(mode)
      await fixture.drainMaintenance()
      const changes: Array<string> = []
      fixture.access().onAdmissionChanged(() => {
        const next = fixture.admission()
        changes.push(next.admissible ? 'admissible' : next.reason)
      })
      reportedHold(fixture).raise()
      await fixture.access().readControl(async () => {})
      expect(changes).toEqual(['fork-halted'])
    })
    test('GroupMLS subscribes at construction and unsubscribes on registry disposal', async () => {
      const fixture = await setup(mode)
      const safety = registrySafety(fixture.fixture().registry)
      if (safety === null) throw new Error('Missing safety capability')
      const register = safety.onAdmissionChanged.bind(safety)
      const removals: Array<() => void> = []
      vi.spyOn(safety, 'onAdmissionChanged').mockImplementation((key, listener) => {
        const unsubscribe = vi.fn(register(key, listener))
        removals.push(unsubscribe)
        return unsubscribe
      })
      await groupMLS(fixture, false)
      expect(removals).toHaveLength(1)
      await fixture.fixture().registry.dispose()
      expect(removals[0]).toHaveBeenCalledTimes(1)
    })
    test('restart at stored 500 without a copy remains rotation-required', async () => {
      const fixture = await setup(mode)
      await fixture.forceStoredGeneration(500)
      await fixture.reopen()
      const mls = await groupMLS(fixture, false)
      expect(fixture.lease()).toBeNull()
      expect(mls.sendAdmission()).toMatchObject({ admissible: false, reason: 'rotation-required' })
    })
    test('copy loss at stored 500 flips admission and control-only writes cannot reopen it', async () => {
      const fixture = await setup(mode)
      const mls = await groupMLS(fixture)
      await finalRange(fixture)
      await fixture.drainMaintenance()
      expect(await fixture.storedGeneration()).toBe(500)
      expect(mls.sendAdmission()).toMatchObject({ admissible: true })
      registryLiveSend.get(fixture.access())?.invalidate()
      expect(mls.sendAdmission()).toMatchObject({ admissible: false, reason: 'rotation-required' })
      await fixture.writeElsewhere('control')
      expect(mls.sendAdmission()).toMatchObject({ admissible: false, reason: 'rotation-required' })
    })
    test('rotation listener fires once per identity, replays late and resets for a new epoch', async () => {
      const fixture = await setup(mode, 'welcome')
      const mls = await groupMLS(fixture)
      const rotations = vi.fn()
      fixture.access().onRotationRequired(rotations)
      await finalRange(fixture)
      await fixture.sealDurable()
      await fixture.writeElsewhere('control')
      await expect(fixture.sealDurable()).rejects.toThrow()
      expect(rotations).toHaveBeenCalledTimes(1)
      const late = vi.fn()
      fixture.access().onRotationRequired(late)
      expect(late).toHaveBeenCalledTimes(1)
      await fixture.advanceEpoch()
      expect(mls.sendAdmission()).toMatchObject({ admissible: true })
      await finalRange(fixture)
      await fixture.sealDurable()
      expect(rotations).toHaveBeenCalledTimes(2)
      expect(late).toHaveBeenCalledTimes(2)
    })
    test('rotation-required still refreshes the cold receive base', async () => {
      const fixture = await setup(mode, 'welcome')
      const mls = await groupMLS(fixture)
      await fixture.forceStoredGeneration(500)
      await registryLiveSend.get(fixture.access())?.accounting()
      const group = fixture.group
      if (group === null) throw new Error('Missing peer')
      const aad = fixture.aad('ephemeral')
      const ciphertext = await group.sender.handle.encrypt(new Uint8Array([7]), { aad })
      expect(await fixture.openEphemeral([{ ciphertext, expectedAAD: aad }])).toMatchObject([
        { kind: 'opened', payload: new Uint8Array([7]) },
      ])
      expect(mls.sendAdmission()).toMatchObject({ admissible: false, reason: 'rotation-required' })
    })
  })
}

test.each(['real-mls', 'double'] as const)(
  'lapse takes precedence over rotation-required (%s)',
  async (mode) => {
    const { createGroup, restoreGroup, signLedgerEntry, DEVICE_ENTRY_TYPE } = await import(
      '@kumiai/mls'
    )
    const { createRegistryFixture } = await import('./fixtures/registry.js')
    const { registryHandle } = await import('./fixtures/registry-welcome.js')
    const base = await createRegistryFixture({
      mode,
      setup: 'empty',
      groupID: `lapse-${crypto.randomUUID()}`,
    })
    const { timedBinding, rawCommit } = (await import(
      new URL('../../mls/test/fixtures/lifecycle-pipeline.ts', import.meta.url).href
    )) as {
      timedBinding(params: {
        identity: typeof base.identity
        iat: number
        exp: number
      }): Promise<ControllerBinding>
      rawCommit(params: {
        group: GroupHandle
        tokens: Array<string>
      }): Promise<{ newState: GroupHandle['state'] }>
    }
    try {
      vi.spyOn(Date, 'now').mockReturnValue(150_000)
      const controller = await timedBinding({ identity: base.identity, iat: 100, exp: 200 })
      const { group } = await createGroup(base.identity, 'lapsed-rotation', { controller })
      const token = await signLedgerEntry(base.identity, {
        type: DEVICE_ENTRY_TYPE,
        groupID: group.groupID,
        subject: controller.id,
        value: { op: 'clock', time: 201 },
      })
      const committed = await rawCommit({ group, tokens: [token] })
      const handle = await restoreGroup({
        state: committed.newState,
        credential: group.credential,
        ledgerEntries: [token],
      })
      const key = await base.registry.seed(
        await registryHandle({ mode, handle, options: base.environment.options }),
        {
          packageUse: { sourceID: 'lease-lapse', ref: 'joined', kind: 'ordinary' },
        },
      )
      const saved = await base.device.groups.loadState(key)
      if (saved === null || saved.deleted) throw new Error('Missing state')
      await base.installRows({
        key,
        state: { ...saved, senderHWM: 500, version: saved.version + 1 },
      })
      const access = await base.registry.access(key.groupID)
      const mls = await createRegistryGroupMLS({
        registry: base.registry,
        key,
        recovery: base.environment,
        target: { targetID: 'lease-hub', topicID: 'lease-commits' },
        identity: base.identity,
        entrySlot: createLedgerEntrySlot(),
      })
      expect(access.admission()).toMatchObject({ admissible: false, reason: 'lapsed' })
      expect(mls.sendAdmission()).toMatchObject({ admissible: false, reason: 'lapsed' })
    } finally {
      await base.close()
    }
  },
)

test.each([
  ['real-mls', false],
  ['real-mls', true],
  ['double', false],
  ['double', true],
] as const)('registry peer handles final-lease admission (%s, cold=%s)', async (mode, cold) => {
  const { createGroupPeer } = await import('@kumiai/rpc')
  const api = await import('../src/index.js')
  const { FakeHub } = (await import(
    new URL('../../rpc/test/fixtures/fake-hub.ts', import.meta.url).href
  )) as {
    FakeHub: new () => LogHub & { published: Array<{ logPosition?: string }> }
  }
  const fixture = await setup(mode)
  if (cold) {
    await fixture.forceStoredGeneration(500)
    await fixture.reopen()
  }
  const base = fixture.fixture()
  const hub = new FakeHub()
  const target = { targetID: 'lease-hub', topicID: 'lease-commits' }
  const protocols = {
    chat: { posted: { type: 'event', retain: 'log', data: { type: 'object' } } },
  } as const
  let typedPeer: GroupPeer<typeof protocols> | undefined
  const recoveryModes: Array<boolean> = []
  const owner = await api.createRegistryPeer({
    registry: base.registry,
    key: fixture.key,
    recovery: base.environment,
    target,
    continuation: api.createRecoveryContinuationPort({
      registry: base.registry,
      persistence: base.device.groups,
    }),
    createMLS: () => groupMLS(fixture),
    createPeer: async (key, options) => {
      recoveryModes.push(options.recoveryOnly)
      const ports = base.device.groups.ports(key)
      typedPeer = createGroupPeer({
        ...options,
        onConfirmedRecovery: undefined,
        hub,
        crypto: api.createGroupCrypto({ access: fixture.access() }),
        control: ports.control,
        anchorStore: ports.anchor,
        appCursorStore: ports.cursor,
        appOutbox: ports.outbox,
        appOutboxLimit: 16,
        localDID: base.identity.id,
        protocols,
        handlers: { chat: { posted: () => {} } },
        validation: api.createControlValidationPort({
          identity: base.identity,
          options: base.environment.options,
          restoreCandidate: async () => {
            throw new Error('No build expected')
          },
        }),
        readEvidence: () => base.device.groups.readEvidence(key),
        prepareBuild: async () => {
          throw new Error('No build expected')
        },
        adopt: async () => {
          throw new Error('No adoption expected')
        },
        deliverWelcome: async () => {},
      })
      return typedPeer
    },
  })
  try {
    await owner.ready
    const peer = typedPeer
    if (peer === undefined) throw new Error('Missing peer')
    expect(recoveryModes).toEqual([false])
    if (!cold) await finalRange(fixture)
    if (!cold) {
      const publishedBefore = hub.published.length
      await peer.protocol('chat').dispatch('posted', { data: { text: 'generation 499' } })
      await vi.waitFor(() => {
        expect(
          hub.published.slice(publishedBefore).some((frame) => frame.logPosition != null),
        ).toBe(true)
        expect(fixture.admission()).toMatchObject({ reason: 'rotation-required' })
      })
    }
    expect(fixture.admission()).toMatchObject({ admissible: false, reason: 'rotation-required' })
    await expect(
      peer.protocol('chat').dispatch('posted', { data: { text: 'next' } }),
    ).rejects.toMatchObject({ reason: 'rotation-required' })
  } finally {
    const disposal = typedPeer?.dispose()
    owner.dispose()
    await disposal
    await typedPeer?.drained()
    await owner.drained()
  }
})

test.each(['real-mls', 'double'] as const)(
  'a resend sealed at 499 still publishes (%s)',
  async (mode) => {
    const fixture = await setup(mode, 'welcome')
    const mls = await groupMLS(fixture)
    const { createAppOutboxAcceptance } = (await import(
      new URL('../../rpc/src/app-outbox.ts', import.meta.url).href
    )) as {
      createAppOutboxAcceptance: (params: AppOutboxAcceptanceParams) => AppOutboxAcceptance
    }
    const { createLogDelivery } = (await import(
      new URL('../../rpc/src/log-delivery.ts', import.meta.url).href
    )) as {
      createLogDelivery: (params: LogDeliveryParams) => {
        trigger(): void
        rejoined(epoch: number): void
        close(): void
      }
    }
    const store = createMemoryAppOutbox()
    const queue = createAppOutboxAcceptance({
      outbox: store,
      limit: 4,
      admission: () => mls.sendAdmission(),
    })
    const published: Array<number> = []
    const delivery = createLogDelivery({
      queue,
      ready: async () => {},
      floor: () => ({ epoch: fixture.access().epoch(), position: null, covered: true }),
      held: () => !mls.sendAdmission().admissible,
      handoffHeld: () => false,
      probe: async () => ({ head: null, oldest: null, gap: false, messages: [] }),
      pull: async () => {},
      heal: async () => {},
      seal: async (entry) => {
        const sealed = await fixture.sealDurable(entry.data)
        return {
          topicID: 'lease-app',
          payload: sealed.ciphertext,
          floor: { epoch: sealed.epoch, position: null, covered: true },
        }
      },
      put: store.put,
      publish: async () => {
        published.push(fixture.lease()?.own ?? -1)
      },
      remove: store.remove,
      clear: store.clear,
      cleared: () => {},
      deliveredWindowMs: 60_000,
      deliveredLimit: 4,
    })
    try {
      await queue.accept({ protocol: 'chat', prc: 'posted', data: new Uint8Array([8]) })
      delivery.trigger()
      await vi.waitFor(() => expect(published).toHaveLength(1))
      await vi.waitFor(() => expect(queue.entries()).toEqual([]))
      await fixture.advanceEpoch()
      await finalRange(fixture)
      delivery.rejoined(2)
      await vi.waitFor(() => expect(published).toEqual([1, 500]))
      expect(mls.sendAdmission()).toMatchObject({ admissible: false, reason: 'rotation-required' })
    } finally {
      delivery.close()
      queue.close()
    }
  },
)

test.each(['real-mls', 'double'] as const)(
  'a foreign high-water mark closes copyless GroupMLS admission (%s)',
  async (mode) => {
    const fixture = await setup(mode)
    const gate = gateRegistryMaintenance(fixture.fixture().registry)
    try {
      await fixture.forceStoredGeneration(496)
      const live = registryLiveSend.get(fixture.access())
      if (live === undefined) throw new Error('Missing live sender')
      await live.accounting()
      const mls = await groupMLS(fixture)
      const slot = registryReceiveSlots.get(fixture.access())
      if (slot === undefined) throw new Error('Missing live slot')
      // The earlier receive refresh must not repair this admission update.
      await Promise.allSettled([...slot.inflight])
      expect(fixture.lease()).toBeNull()
      expect(mls.sendAdmission()).toMatchObject({ admissible: true })
      const record = await fixture.record()
      await fixture.fixture().installRows({
        key: fixture.key,
        state: { ...record, version: record.version + 1, senderHWM: 500 },
      })
      await live.accounting()
      expect(fixture.admission()).toMatchObject({ admissible: false, reason: 'rotation-required' })
      expect(mls.sendAdmission()).toMatchObject({ admissible: false, reason: 'rotation-required' })
    } finally {
      gate.release()
    }
  },
)
