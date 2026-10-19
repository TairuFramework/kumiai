import type { ControllerBinding, GroupHandle } from '@kumiai/mls'
import type { GroupPeer, LogHub } from '@kumiai/rpc'
import { createMemoryAppOutbox } from '@kumiai/rpc-conformance'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { AppOutboxAcceptance, AppOutboxAcceptanceParams } from '../../rpc/lib/app-outbox.js'
import type { LogDeliveryParams } from '../../rpc/lib/log-delivery.js'
import { createLedgerEntrySlot } from '../src/index.js'
import { registryReceiveSlots } from '../src/registry/live-receive.js'
import { registryLiveSend } from '../src/registry/live-send.js'
import { createRegistryGroupMLS } from '../src/registry-group-mls.js'
import { gateRegistryMaintenance } from '../src/testing.js'
import { createRegistryLeaseFixture } from './fixtures/registry-lease.js'

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
      fixture.failNextEncrypt('throw-after')
      await expect(fixture.sealEphemeral()).rejects.toThrow()
      expect(mls.sendAdmission()).toMatchObject({ admissible: false, reason: 'rotation-required' })
    })
    test('cold final range reopens GroupMLS after accept without another storage operation', async () => {
      const fixture = await setup(mode)
      const gate = gateRegistryMaintenance(fixture.fixture().registry)
      await fixture.forceStoredGeneration(496)
      await registryLiveSend.get(fixture.access())?.accounting()
      await fixture.reopen()
      const mls = await groupMLS(fixture)
      const observed: Array<string> = []
      const unsubscribe = fixture.access().onAdmissionChanged(() => {
        const admission = mls.sendAdmission()
        observed.push(admission.admissible ? 'admissible' : admission.reason)
      })
      await fixture.drainMaintenance()
      unsubscribe()
      gate.release()
      expect(observed).toContain('rotation-required')
      const transactions = fixture.transactions()
      expect(fixture.lease()).toMatchObject({ own: 496, limit: 500 })
      expect(mls.sendAdmission()).toMatchObject({ admissible: true })
      expect(fixture.transactions()).toBe(transactions)
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

test.each([false, true])('registry peer handles final-lease admission (cold=%s)', async (cold) => {
  const { createGroupPeer } = await import('@kumiai/rpc')
  const api = await import('../src/index.js')
  const { FakeHub } = (await import(
    new URL('../../rpc/test/fixtures/fake-hub.ts', import.meta.url).href
  )) as {
    FakeHub: new () => LogHub & { published: Array<{ logPosition?: string }> }
  }
  const fixture = await setup('real-mls')
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
    expect(recoveryModes).toEqual([false])
    if (!cold) await finalRange(fixture)
    const peer = typedPeer
    if (peer === undefined) throw new Error('Missing peer')
    if (!cold) {
      await peer.protocol('chat').dispatch('posted', { data: { text: 'generation 499' } })
      await vi.waitFor(() =>
        expect(hub.published.some((frame) => frame.logPosition != null)).toBe(true),
      )
    }
    expect(fixture.admission()).toMatchObject({ admissible: false, reason: 'rotation-required' })
    await expect(
      peer.protocol('chat').dispatch('posted', { data: { text: 'next' } }),
    ).rejects.toMatchObject({ reason: 'rotation-required' })
  } finally {
    owner.dispose()
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
