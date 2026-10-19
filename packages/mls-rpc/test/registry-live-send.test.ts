import {
  ApplicationSendRefusedError,
  type ControllerBinding,
  createGroup,
  decodeClientState,
  encodeClientState,
  type GroupHandle,
  ownApplicationGeneration,
} from '@kumiai/mls'
import { encodeAppAAD, GroupSafetyHeldError } from '@kumiai/rpc'
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest'

import { entryCapability } from '../src/entry-capability.js'
import { ApplicationLeaseUnavailableError } from '../src/index.js'
import { StorageOutcomeUnknownError } from '../src/persistence-errors.js'
import { registryLiveSend } from '../src/registry/live-send.js'
import * as reservations from '../src/registry/reserve.js'
import { registryRetirement } from '../src/registry/retirement.js'
import { deferred } from '../src/runtime.js'
import {
  gateRegistryMaintenance,
  hasRegistryPendingHandoff,
  isLiveHandle,
  registryLeaseSnapshot,
} from '../src/testing.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createRegistryFixture } from './fixtures/registry.js'
import { createRegistryLeaseFixture } from './fixtures/registry-lease.js'

type Fixture = Awaited<ReturnType<typeof createRegistryLeaseFixture>>
const fixtures: Array<Fixture> = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()))
})
async function setup(
  mode: 'real-mls' | 'double',
  source: 'seed' | 'welcome' = 'seed',
  initialGeneration = 0,
) {
  const fixture = await createRegistryLeaseFixture(mode, source, initialGeneration)
  fixtures.push(fixture)
  return fixture
}
async function invariant(fixture: Fixture) {
  const lease = fixture.lease()
  expect(lease).not.toBeNull()
  expect(lease?.limit).toBeLessThanOrEqual(await fixture.storedGeneration())
  expect(await fixture.rawRestoreEncrypt()).toBeGreaterThanOrEqual(lease?.limit ?? 0)
}
async function promptly<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Accounting did not settle')), 500)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
for (const mode of ['real-mls', 'double'] as const) {
  describe(`live send (${mode})`, () => {
    test('foreign save at an unknown own version is classified by content', async () => {
      const fixture = await setup(mode)
      const gate = gateRegistryMaintenance(fixture.fixture().registry)
      const capability = entryCapability(fixture.fixture().device.groups)
      if (capability === null) throw new Error('Missing capability')
      vi.spyOn(capability, 'run').mockImplementationOnce(async (request, prepare) => {
        await capability.read(request.groupID, prepare)
        throw new StorageOutcomeUnknownError('Unknown write outcome')
      })
      vi.spyOn(fixture.fixture().device.groups, 'resolve').mockRejectedValue(
        new Error('Proof temporarily unavailable'),
      )
      await expect(fixture.reserveNow()).rejects.toThrow('Unknown write outcome')
      expect(fixture.lease()?.expectedVersions).toEqual([2])
      await fixture.writeElsewhere('proposal')
      expect((await fixture.record()).version).toBe(2)
      expect(fixture.lease()).toBeNull()
      await expect(fixture.sealEphemeral()).rejects.toMatchObject({ reason: 'deferred' })
      gate.release()
    })
    test('known rollback releases maintenance without resolving a superseded marker', async () => {
      const fixture = await setup(mode)
      const resolve = vi.spyOn(fixture.fixture().device.groups, 'resolve')
      fixture.fixture().armNextWorkFault('after-first-write')
      await expect(fixture.reserveNow()).rejects.toThrow()
      expect(fixture.lease()?.expectedVersions).toEqual([])
      expect(resolve).not.toHaveBeenCalled()
      for (let generation = 0; generation < 20; generation++)
        expect((await fixture.sealDurable()).generation).toBe(generation)
      expect(fixture.lease()?.limit).toBe(32)
      await invariant(fixture)
    })
    test.each(['immediate', 'delayed'] as const)(
      'superseded unknown proof stops %s resolution and releases maintenance',
      async (timing) => {
        const fixture = await setup(mode)
        const capability = entryCapability(fixture.fixture().device.groups)
        if (capability === null) throw new Error('Missing capability')
        const original = capability.run.bind(capability)
        vi.spyOn(capability, 'run').mockImplementationOnce(async (...args) => {
          await original(...args)
          await fixture
            .fixture()
            .device.groups.ports(fixture.key)
            .control.apply({}, crypto.randomUUID())
          throw new StorageOutcomeUnknownError('Lost result after marker supersession')
        })
        const resolve = vi.spyOn(fixture.fixture().device.groups, 'resolve')
        if (timing === 'delayed') resolve.mockRejectedValueOnce(new Error('Proof read failed'))
        await expect(fixture.reserveNow()).rejects.toThrow('Lost result')
        for (let index = 0; index < 13; index++) await fixture.sealEphemeral()
        await promptly(fixture.drainMaintenance())
        expect(resolve).toHaveBeenCalledTimes(timing === 'delayed' ? 2 : 1)
        expect(fixture.lease()?.limit).toBe(48)
        expect(fixture.lease()?.expectedVersions).toEqual([2])
        await invariant(fixture)
      },
    )
    test('accept restore rejection preserves a committed mutation result and schedules warm-up', async () => {
      const fixture = await setup(mode, 'welcome')
      const live = registryLiveSend.get(fixture.access())
      const capability = entryCapability(fixture.fixture().device.groups)
      if (live === undefined || capability === null) throw new Error('Missing capability')
      const gate = gateRegistryMaintenance(fixture.fixture().registry)
      live.invalidate()
      const original = capability.run.bind(capability)
      vi.spyOn(capability, 'run').mockImplementationOnce(async (...args) => {
        const result = await original(...args)
        fixture.fixture().overrideRestore(async () => {
          throw new Error('Accept restore rejected')
        })
        return result
      })
      await expect(fixture.group?.advance()).resolves.toBeUndefined()
      const state = decodeClientState((await fixture.record()).state)
      if (state === undefined) throw new Error('Missing committed state')
      expect(ownApplicationGeneration(state)).toBe(16)
      expect(fixture.lease()).toBeNull()
      await promptly(gate.started)
    })
    test.each(['supplied', 'absent'] as const)(
      'accounting progresses when a committed provider skips afterRelease (%s ownership)',
      async (ownership) => {
        const id = `missing-release-${mode}-${crypto.randomUUID()}`
        const base = await createRegistryFixture({
          mode,
          setup: 'empty',
          groupID: id,
          ownershipContext:
            ownership === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        })
        const capability = entryCapability(base.device.groups)
        if (capability === null) throw new Error('Missing capability')
        const releases: Array<() => void> = []
        const observe = capability.observe.bind(capability)
        vi.spyOn(capability, 'observe').mockImplementation((groupID, onProof, afterRelease) =>
          observe(groupID, (observation) => {
            onProof(observation)
            releases.push(() => afterRelease?.(observation))
          }),
        )
        onTestFinished(async () => {
          for (const release of releases) release()
          await base.close()
        })
        const key = await base.registry.seed(await base.makeHandle(0), { packageUse: null })
        const access = await base.registry.access(id)
        const copy = registryLeaseSnapshot(access)?.copy
        await base.device.groups.ports(key).control.apply({}, crypto.randomUUID())
        await expect(
          promptly(
            access.seal(new Uint8Array([1]), {
              aad: encodeAppAAD({ topicID: 'lease-app', intent: 'ephemeral' }),
              intent: 'ephemeral',
            }),
          ),
        ).resolves.toMatchObject({ generation: 0 })
        expect(registryLeaseSnapshot(access)?.copy).toBe(copy)
        await access.mutate(async () => 'committed')
        await expect(
          promptly(registryLiveSend.get(access)?.accounting() ?? Promise.resolve()),
        ).resolves.toBeUndefined()
      },
    )
    test('dispose aborts a seal waiting for accounting and drains the pending check', async () => {
      const fixture = await setup(mode)
      const live = registryLiveSend.get(fixture.access())
      const capability = entryCapability(fixture.fixture().device.groups)
      if (live === undefined || capability === null) throw new Error('Missing capability')
      const version = (await fixture.record()).version + 1
      const blocked = deferred<void>()
      const read = capability.read.bind(capability)
      vi.spyOn(capability, 'read').mockImplementationOnce(async (...args) => {
        await blocked.promise
        return read(...args)
      })
      const release = live.observed(version, () => true)
      release()
      const sealing = fixture.sealEphemeral().catch((error: unknown) => error)
      try {
        await promptly(fixture.fixture().registry.dispose())
        expect(await sealing).toMatchObject({ name: 'DisplacedGroupHandleError' })
      } finally {
        blocked.resolve()
        await sealing
      }
    })
    test.each(['reservation', 'mutation'] as const)(
      'a later own %s observation supersedes a metadata check without wasting generations',
      async (kind) => {
        const fixture = await setup(mode)
        const capability = entryCapability(fixture.fixture().device.groups)
        if (capability === null) throw new Error('Missing capability')
        const started = deferred<void>()
        const blocked = deferred<void>()
        const read = capability.read.bind(capability)
        vi.spyOn(capability, 'read').mockImplementationOnce(async (...args) => {
          started.resolve()
          await blocked.promise
          return read(...args)
        })
        const copy = fixture.lease()?.copy
        const before = fixture.transactions()
        await fixture
          .fixture()
          .device.groups.ports(fixture.key)
          .control.apply({}, crypto.randomUUID())
        await started.promise
        try {
          if (kind === 'reservation') await fixture.reserveNow()
          else await fixture.access().mutate(async () => 'host-result')
        } finally {
          blocked.resolve()
        }
        await registryLiveSend.get(fixture.access())?.accounting()
        await fixture.drainMaintenance()
        expect(fixture.lease()?.copy).toBe(copy)
        expect(fixture.lease()?.limit).toBe(kind === 'reservation' ? 32 : 16)
        expect(await fixture.storedGeneration()).toBe(kind === 'reservation' ? 32 : 16)
        expect(fixture.transactions() - before).toBe(1)
        expect((await fixture.sealEphemeral()).generation).toBe(0)
      },
    )
    test('foreign generation 500 never schedules another maintenance transaction', async () => {
      const fixture = await setup(mode)
      const live = registryLiveSend.get(fixture.access())
      if (live === undefined) throw new Error('Missing sender')
      const rotated: Array<number> = []
      live.onRotationRequired((identity) => rotated.push(identity.epoch))
      const before = fixture.transactions()
      await fixture.forceStoredGeneration(500)
      await live.accounting()
      expect(live.effectiveNext()).toBe(500)
      expect(fixture.lease()).toBeNull()
      for (let index = 0; index < 3; index++) {
        await live.schedule()
        await fixture.drainMaintenance()
        await expect(fixture.sealEphemeral()).rejects.toBeInstanceOf(
          ApplicationLeaseUnavailableError,
        )
      }
      expect(fixture.transactions()).toBe(before)
      expect(rotated.length).toBeGreaterThan(0)
    })
    test('deferred seals do not run a transaction on each attempt', async () => {
      const fixture = await setup(mode)
      const proposal = await fixture.proposal()
      await fixture.access().mutate(async (handle) => {
        handle.state.unappliedProposals = proposal
      })
      await fixture.drainMaintenance()
      const before = fixture.transactions()
      for (let index = 0; index < 3; index++) {
        await expect(fixture.sealDurable()).rejects.toMatchObject({ reason: 'deferred' })
        await fixture.drainMaintenance()
      }
      expect(fixture.transactions()).toBe(before)
    })
    test('non-bound send policy refusals propagate unchanged', async () => {
      const fixture = await setup(mode)
      const copy = fixture.lease()?.copy
      if (copy === undefined) throw new Error('Missing copy')
      const error = new ApplicationSendRefusedError()
      vi.spyOn(copy, 'encryptApplication').mockRejectedValueOnce(error)
      await expect(fixture.sealEphemeral()).rejects.toBe(error)
    })
    test('safety holds refuse before waiting for pending accounting', async () => {
      const fixture = await setup(mode)
      const capability = entryCapability(fixture.fixture().device.groups)
      const live = registryLiveSend.get(fixture.access())
      if (capability === null || live === undefined) throw new Error('Missing capability')
      const version = (await fixture.record()).version + 1
      const read = capability.read.bind(capability)
      const blocked = deferred<void>()
      vi.spyOn(capability, 'read').mockImplementationOnce(async (...args) => {
        await blocked.promise
        return read(...args)
      })
      const release = live.observed(version, () => true)
      release()
      await fixture.holdSafety()
      try {
        await expect(promptly(fixture.sealEphemeral())).rejects.toBeInstanceOf(GroupSafetyHeldError)
      } finally {
        blocked.resolve()
        await live.accounting()
      }
    })
    test('rollback of retirement restarts an interrupted warm-up', async () => {
      const fixture = await setup(mode)
      await fixture.dropOwner()
      const block = fixture.blockMaintenance()
      await block.started
      const live = registryLiveSend.get(fixture.access())
      const retiring = registryRetirement(fixture.fixture().registry).beginRetirement(fixture.key)
      retiring.settle('rolled-back')
      block.release()
      await live?.drain()
      await live?.drain()
      expect(fixture.lease()?.limit).toBe(32)
    })
    test.each(['seed', 'welcome'] as const)(
      'install hand-off from %s seals without transactions',
      async (source) => {
        const fixture = await setup(mode, source)
        const before = fixture.transactions()
        const generations = []
        for (let index = 0; index < 12; index++)
          generations.push((await fixture.sealEphemeral()).generation)
        expect(generations).toEqual(Array.from({ length: 12 }, (_, index) => index))
        expect(fixture.transactions()).toBe(before)
        await invariant(fixture)
      },
    )
    test('restart wastes, never reuses, and durable sealing waits for warm-up', async () => {
      const fixture = await setup(mode)
      for (let index = 0; index < 5; index++)
        expect((await fixture.sealEphemeral()).generation).toBe(index)
      await fixture.reopen()
      expect((await fixture.sealDurable()).generation).toBe(16)
      await invariant(fixture)
    })
    test('owner drop is cold and schedules warm-up on reload', async () => {
      const fixture = await setup(mode)
      await fixture.dropOwner()
      await expect(fixture.sealEphemeral()).rejects.toMatchObject({ reason: 'cold' })
      await fixture.drainMaintenance()
      expect((await fixture.sealEphemeral()).generation).toBe(16)
      await invariant(fixture)
    })
    test.each(['throw-before', 'throw-after'] as const)(
      'failed encrypt %s never reuses a consumed generation',
      async (when) => {
        const fixture = await setup(mode)
        fixture.failNextEncrypt(when)
        await expect(fixture.sealEphemeral()).rejects.toThrow('Injected')
        expect((await fixture.sealEphemeral()).generation).toBe(when === 'throw-before' ? 0 : 1)
      },
    )
    test('renewal extends the same copy and uses only the transaction private restore', async () => {
      const fixture = await setup(mode)
      const lease = fixture.lease()
      for (let index = 0; index < 13; index++) await fixture.sealEphemeral()
      const before = fixture.restores()
      await fixture.drainMaintenance()
      expect(fixture.lease()?.copy).toBe(lease?.copy)
      expect(fixture.lease()?.limit).toBe(32)
      expect(fixture.restores() - before).toBe(1)
      await invariant(fixture)
    })
    test.each(['control', 'cursor'] as const)(
      'accounted %s version keeps the copy',
      async (kind) => {
        const fixture = await setup(mode)
        const copy = fixture.lease()?.copy
        await fixture.writeElsewhere(kind)
        await registryLiveSend.get(fixture.access())?.accounting()
        expect(fixture.lease()?.copy).toBe(copy)
        expect(fixture.lease()?.knownVersion).toBe((await fixture.record()).version)
        expect((await fixture.sealEphemeral()).generation).toBe(0)
      },
    )
    test.each(['receive', 'proposal'] as const)(
      'foreign %s version drops the copy',
      async (kind) => {
        const fixture = await setup(mode, 'welcome')
        await fixture.writeElsewhere(kind)
        await registryLiveSend.get(fixture.access())?.accounting()
        expect(fixture.lease()).toBeNull()
      },
    )
    test('changed control rechecks eligibility and drops a newly lapsed copy', async () => {
      const id = `control-floor-${mode}-${crypto.randomUUID()}`
      const base = await createRegistryFixture({ mode, setup: 'empty', groupID: id })
      onTestFinished(() => base.close())
      const { timedBinding } = (await import(
        new URL('../../mls/test/fixtures/lifecycle-pipeline.ts', import.meta.url).href
      )) as {
        timedBinding(params: {
          identity: typeof base.identity
          iat: number
          exp: number
        }): Promise<ControllerBinding>
      }
      vi.spyOn(Date, 'now').mockReturnValue(150_000)
      const binding = await timedBinding({ identity: base.identity, iat: 100, exp: 200 })
      const { createGroup } = await import('@kumiai/mls')
      const { registryHandle } = await import('./fixtures/registry-welcome.js')
      const source = (
        await createGroup(base.identity, id, { ...base.environment.options, controller: binding })
      ).group
      const input = await registryHandle({
        mode,
        handle: source,
        options: base.environment.options,
      })
      const key = await base.registry.seed(input, { packageUse: null })
      const access = await base.registry.access(id)
      expect(registryLeaseSnapshot(access)).not.toBeNull()
      const restored = await base.restoreCommittedSender()
      expect(restored.ownLeafLapsed()).toBe(false)
      const registry = restored.registry
      registry.controllers = new Map(registry.controllers).set(binding.id, {
        recordedLog: binding.prefix,
        genFloor: 0,
        timeFloor: 201,
      })
      Object.defineProperty(restored, 'registry', { value: registry })
      expect(restored.ownLeafLapsed()).toBe(true)
      base.overrideRestore(async () => restored)
      const before = base.restores()
      await base.device.groups
        .ports(key)
        .control.apply({ cursor: { position: null, epoch: 0 } }, crypto.randomUUID())
      await registryLiveSend.get(access)?.accounting()
      expect(registryLeaseSnapshot(access)).toBeNull()
      expect(base.restores() - before).toBe(1)
    })
    test('owner change during eligibility restore discards its result', async () => {
      const fixture = await setup(mode)
      const oldAccess = fixture.access()
      const oldLive = registryLiveSend.get(oldAccess)
      const hold = fixture.fixture().holdRestore(fixture.key.groupID)
      await fixture
        .fixture()
        .device.groups.ports(fixture.key)
        .control.apply({ cursor: { position: null, epoch: 0 } }, crypto.randomUUID())
      await hold.started
      oldLive?.dropOwner()
      hold.release()
      await oldLive?.accounting()
      expect(fixture.lease()).toBeNull()
      await expect(fixture.sealEphemeral()).rejects.toThrow('no longer current')
    })
    test('own proposal changes eligibility and defers new seals', async () => {
      const fixture = await setup(mode)
      const proposal = await fixture.proposal()
      await fixture.access().mutate(async (handle) => {
        handle.state.unappliedProposals = proposal
      })
      expect(fixture.lease()).toBeNull()
      await expect(fixture.sealEphemeral()).rejects.toMatchObject({ reason: 'deferred' })
    })
    test('parallel seals report distinct contiguous generations', async () => {
      const fixture = await setup(mode)
      const frames = await Promise.all(Array.from({ length: 12 }, () => fixture.sealEphemeral()))
      expect(frames.map((frame) => frame.generation).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 12 }, (_, index) => index),
      )
    })
    test('cold ephemeral rejects at once, durable waits without holding the provider lane', async () => {
      const fixture = await setup(mode)
      await fixture.dropOwner()
      const block = fixture.blockMaintenance()
      await expect(fixture.sealEphemeral()).rejects.toMatchObject({ reason: 'cold' })
      const waiting = fixture.sealDurable()
      await block.started
      const capability = entryCapability(fixture.fixture().device.groups)
      if (capability === null) throw new Error('Missing capability')
      let resolved = false
      void waiting.then(() => {
        resolved = true
      })
      await capability.run(
        { groupID: fixture.key.groupID, mutationID: crypto.randomUUID() },
        async (reads) => ({ expected: await reads.lifetime(), value: null }),
        async () => {},
      )
      expect(resolved).toBe(false)
      block.release()
      expect((await waiting).generation).toBe(16)
    })
    test('lease wait aborts at retirement start and rollback permits another seal', async () => {
      const fixture = await setup(mode)
      await fixture.dropOwner()
      const block = fixture.blockMaintenance()
      const waiting = fixture.sealDurable()
      const rejected = expect(waiting).rejects.toMatchObject({ name: 'RegistryRetiringError' })
      await block.started
      const attempt = registryRetirement(fixture.fixture().registry).beginRetirement(fixture.key)
      await rejected
      block.release()
      await attempt.drain()
      attempt.settle('rolled-back')
      expect((await fixture.sealDurable()).generation).toBeGreaterThanOrEqual(16)
    })
    test('retirement and dispose drain live encryption', async () => {
      const fixture = await setup(mode)
      const block = fixture.blockNextEncrypt()
      const sealing = fixture.sealEphemeral()
      await block.started
      let drained = false
      const closing = fixture
        .fixture()
        .registry.dispose()
        .then(() => {
          drained = true
        })
      await Promise.resolve()
      expect(drained).toBe(false)
      block.release()
      await sealing
      await closing
    })
    test('host callbacks never receive the live copy', async () => {
      const fixture = await setup(mode)
      expect(isLiveHandle(fixture.lease()?.copy)).toBe(true)
      await fixture.access().read((handle) => {
        expect(isLiveHandle(handle)).toBe(false)
      })
      await fixture.access().mutate(async (handle) => {
        expect(isLiveHandle(handle)).toBe(false)
      })
    })
    test('own durable receive and pending completion retain the sender', async () => {
      const fixture = await setup(mode, 'welcome')
      const copy = fixture.lease()?.copy
      expect((await fixture.openDurable())[0]?.kind).toBe('opened')
      expect(fixture.lease()?.copy).toBe(copy)
      const [pending] = await fixture.access().pending.list()
      if (pending === undefined) throw new Error('Missing pending frame')
      await fixture.access().pending.complete(pending.frame.id)
      expect(fixture.lease()?.copy).toBe(copy)
      expect((await fixture.sealEphemeral()).generation).toBe(0)
    })
    test('renewal accepts its retained envelope after settlement cleanup', async () => {
      const fixture = await setup(mode)
      const copy = fixture.lease()?.copy
      await fixture.reserveNow()
      expect(fixture.lease()?.copy).toBe(copy)
      expect(fixture.lease()?.limit).toBe(32)
      await invariant(fixture)
    })
    test.each(['persist-pre', 'envelope-pre', 'no-envelope', 'overlap', 'pre-start'] as const)(
      'refuses a defective reservation: %s',
      async (fault) => {
        const fixture = await setup(mode)
        await fixture.sealEphemeral()
        const before = fixture.lease()
        await fixture.reserveNow(fault)
        if (fault === 'pre-start') {
          expect(fixture.lease()?.copy).toBe(before?.copy)
          expect(fixture.lease()?.limit).toBe(before?.limit)
        } else expect(fixture.lease()).toBeNull()
      },
    )
    test.each(['after-first-write', 'commit-then-reject'] as const)(
      'reservation acceptance follows commit proof: %s',
      async (fault) => {
        const fixture = await setup(mode)
        const before = fixture.lease()?.limit
        fixture.fixture().armNextWorkFault(fault)
        const reservation = fixture.reserveNow()
        if (fault === 'after-first-write') {
          await expect(reservation).rejects.toThrow()
          expect(fixture.lease()?.limit).toBe(before)
        } else {
          await reservation
          expect(fixture.lease()?.limit).toBe(32)
          await invariant(fixture)
        }
      },
    )
    test.each(['commit', 'rollback'] as const)(
      'unknown reservation waits for delayed %s proof',
      async (outcome) => {
        const fixture = await setup(mode)
        const fault = fixture.fixture().armNextWorkFault('pending')
        const reserved = fixture.reserveNow()
        const settled = reserved.then(
          () => 'committed',
          () => 'rolled-back',
        )
        await fault.rejected
        expect(fixture.lease()?.limit).toBe(16)
        await fault.finish(outcome)
        expect(await settled).toBe(outcome === 'commit' ? 'committed' : 'rolled-back')
        expect(fixture.lease()?.limit).toBe(outcome === 'commit' ? 32 : 16)
        await invariant(fixture)
      },
    )
    test.each(['receive', 'proposal', 'foreign'] as const)(
      'a %s write between proof and acceptance is classified by eligibility',
      async (kind) => {
        const fixture = await setup(mode, 'welcome')
        const capability = entryCapability(fixture.fixture().device.groups)
        if (capability === null) throw new Error('Missing capability')
        const original = capability.run.bind(capability)
        vi.spyOn(capability, 'run').mockImplementationOnce(async (...args) => {
          const value = await original(...args)
          if (kind === 'receive') await fixture.openDurable()
          else if (kind === 'foreign') {
            await fixture.writeElsewhere('receive')
            await registryLiveSend.get(fixture.access())?.accounting()
          } else {
            const proposal = await fixture.proposal()
            await fixture.access().mutate(async (handle) => {
              handle.state.unappliedProposals = proposal
            })
          }
          return value
        })
        const copy = fixture.lease()?.copy
        await fixture.reserveNow()
        if (kind === 'receive') {
          expect(fixture.lease()?.copy).toBe(copy)
          expect(fixture.lease()?.limit).toBe(32)
        } else {
          expect(fixture.lease()).toBeNull()
          if (kind === 'proposal')
            await expect(fixture.sealEphemeral()).rejects.toMatchObject({ reason: 'deferred' })
        }
      },
    )
    test('maintenance rechecks need and skips a healthy copy', async () => {
      const fixture = await setup(mode)
      const before = fixture.transactions()
      registryLiveSend.get(fixture.access())?.schedule()
      await fixture.drainMaintenance()
      expect(fixture.transactions()).toBe(before)
    })
    test('concurrent cold calls schedule a single reservation', async () => {
      const fixture = await setup(mode)
      await fixture.dropOwner()
      const block = fixture.blockMaintenance()
      const calls = await Promise.allSettled(
        Array.from({ length: 8 }, () => fixture.sealEphemeral()),
      )
      expect(calls.every((call) => call.status === 'rejected')).toBe(true)
      await block.started
      const before = fixture.transactions()
      block.release()
      await fixture.drainMaintenance()
      expect(fixture.transactions() - before).toBe(1)
    })
    test('the final lease schedules no maintenance', async () => {
      const fixture = await setup(mode, 'seed', 484)
      expect(fixture.lease()?.limit).toBe(500)
      for (let generation = 484; generation < 497; generation++)
        expect((await fixture.sealEphemeral()).generation).toBe(generation)
      const before = fixture.transactions()
      for (let generation = 497; generation < 500; generation++) {
        expect((await fixture.sealEphemeral()).generation).toBe(generation)
        await fixture.drainMaintenance()
      }
      await expect(fixture.sealEphemeral()).rejects.toMatchObject({ reason: 'exhausted' })
      await fixture.drainMaintenance()
      expect(fixture.transactions()).toBe(before)
      await invariant(fixture)
    })
    test('a parallel loser at the ceiling reports exhausted', async () => {
      const fixture = await setup(mode, 'seed', 499)
      const calls = await Promise.allSettled([fixture.sealEphemeral(), fixture.sealEphemeral()])
      expect(calls.filter((call) => call.status === 'fulfilled')).toHaveLength(1)
      expect(calls.find((call) => call.status === 'rejected')).toMatchObject({
        reason: { reason: 'exhausted' },
      })
    })
    test.each(['fork-halted', 'recovery-unavailable', 'spent-set-corrupt'] as const)(
      'safety holds refuse seals live and after restart: %s',
      async (reason) => {
        const fixture = await setup(mode)
        await fixture.holdSafety(reason)
        await expect(fixture.sealEphemeral()).rejects.toBeInstanceOf(GroupSafetyHeldError)
        await fixture.reopen()
        await expect(fixture.sealEphemeral()).rejects.toBeInstanceOf(GroupSafetyHeldError)
      },
    )
    test('a blocked old copy retains its own ceiling after replacement', async () => {
      const fixture = await setup(mode)
      for (let index = 0; index < 15; index++) await fixture.sealEphemeral()
      // Prevent the scheduled renewal from extending the old copy.
      const blockMaintenance = fixture.blockMaintenance()
      await blockMaintenance.started
      const old = fixture.lease()?.copy
      const blocked = fixture.blockNextEncrypt()
      const waiting = fixture.sealEphemeral()
      await blocked.started
      if (old === undefined) throw new Error('Missing old copy')
      // Consume its last generation while the wrapper holds the earlier call.
      expect((await old.encryptApplication(new Uint8Array([3]))).generation).toBe(15)
      await fixture.forceStoredGeneration(48)
      await registryLiveSend.get(fixture.access())?.accounting()
      await fixture.reserveNow()
      expect(fixture.lease()?.copy).not.toBe(old)
      blocked.release()
      await expect(waiting).rejects.toMatchObject({ reason: 'exhausted' })
      blockMaintenance.release()
    })
    test('seals before and after restart open exactly once at the peer', async () => {
      const fixture = await setup(mode, 'welcome')
      const frames = []
      for (let index = 0; index < 5; index++) frames.push(await fixture.sealEphemeral())
      await fixture.reopen()
      frames.push(await fixture.sealDurable())
      expect(frames.map((frame) => frame.generation)).toEqual([0, 1, 2, 3, 4, 16])
      const peer = fixture.group?.sender.handle
      if (peer === undefined) throw new Error('Missing peer')
      for (const frame of frames) {
        expect((await peer.decrypt(frame.ciphertext)).payload).toEqual(new Uint8Array([1]))
        await expect(peer.decrypt(frame.ciphertext)).rejects.toThrow()
      }
    })
    test('an incoming commit installs a fresh hand-off with no seal transactions', async () => {
      const fixture = await setup(mode, 'welcome')
      await fixture.group?.advance()
      const before = fixture.transactions()
      expect(fixture.lease()?.limit).toBe(16)
      const generations = []
      for (let index = 0; index < 12; index++)
        generations.push((await fixture.sealEphemeral()).generation)
      expect(generations).toEqual(Array.from({ length: 12 }, (_, index) => index))
      expect(fixture.transactions()).toBe(before)
      await invariant(fixture)
    })
    test('ordinary adoption installs a fresh hand-off', async () => {
      const fixture = await setup(mode)
      const accepted = await fixture.fixture().acceptedOrdinary(fixture.access())
      expect(
        await fixture.access().adopt(accepted.candidate, accepted.expected, accepted.write),
      ).toBe('installed')
      const before = fixture.transactions()
      for (let index = 0; index < 12; index++)
        expect((await fixture.sealEphemeral()).generation).toBe(index)
      expect(fixture.transactions()).toBe(before)
      await invariant(fixture)
    })
    test('invalidation while building a replacement copy discards it', async () => {
      const fixture = await setup(mode)
      await fixture.forceStoredGeneration(48)
      await registryLiveSend.get(fixture.access())?.accounting()
      const live = registryLiveSend.get(fixture.access())
      const source = await fixture.fixture().restoreCommittedSender()
      let count = 0
      const reached = deferred<void>()
      const released = deferred<void>()
      fixture.fixture().overrideRestore(async () => {
        count++
        if (count === 2) {
          reached.resolve()
          await released.promise
        }
        // Each restore needs a fresh handle and policy.
        const { restoreGroup } = await import('@kumiai/mls')
        return restoreGroup({
          state: structuredClone(source.state),
          credential: source.credential,
          ledgerEntries: source.ledgerTokens,
          options: fixture.fixture().environment.options,
        })
      })
      const reserving = fixture.reserveNow()
      await reached.promise
      live?.invalidate()
      released.resolve()
      await reserving
      expect(fixture.lease()).toBeNull()
    })
    test.each(['control', 'different-bytes', 'identity', 'delete'] as const)(
      'pending seed hand-off handles %s before access',
      async (change) => {
        const id = `pending-lease-${mode}-${crypto.randomUUID()}`
        const fixture = await createRegistryFixture({ mode, setup: 'empty', groupID: id })
        onTestFinished(() => fixture.close())
        const reserve = vi.spyOn(reservations, 'reserveFromBytes')
        if (change === 'different-bytes') {
          const envelope = reservations.reservationEnvelope
          vi.spyOn(reservations, 'reservationEnvelope').mockImplementationOnce((record) => {
            const state = decodeClientState(record.state)
            if (state === undefined) throw new Error('Missing state')
            const ratchet = state.secretTree.leafNodes[state.privatePath.leafIndex * 2]
            if (ratchet === undefined) throw new Error('Missing ratchet')
            ratchet.application.generation++
            return envelope({ ...record, state: encodeClientState(state) })
          })
        }
        const key = await fixture.registry.seed(await fixture.makeHandle(0), { packageUse: null })
        const reserved = await reserve.mock.results[0]?.value
        if (change === 'control')
          await fixture.device.groups
            .ports(key)
            .control.apply({ cursor: null }, crypto.randomUUID())
        if (change === 'identity') {
          const result = reserved.reservation
          result.identity.incarnation++
        }
        if (change === 'delete') {
          await fixture.registry.delete(key)
          await expect(fixture.registry.access(id)).rejects.toThrow()
          return
        }
        const access = await fixture.registry.access(id)
        if (change !== 'control') expect(registryLeaseSnapshot(access)).toBeNull()
        else {
          const before = fixture.restores()
          for (let generation = 0; generation < 12; generation++)
            expect(
              (
                await access.seal(new Uint8Array([1]), {
                  aad: encodeAppAAD({ topicID: 'lease-app', intent: 'ephemeral' }),
                  intent: 'ephemeral',
                })
              ).generation,
            ).toBe(generation)
          expect(fixture.restores()).toBe(before)
        }
      },
    )
    test('dispose clears a seed hand-off whose proof arrives after disposal starts', async () => {
      const id = `dispose-pending-${mode}-${crypto.randomUUID()}`
      const fixture = await createRegistryFixture({ mode, setup: 'empty', groupID: id })
      onTestFinished(() => fixture.close())
      const registry = fixture.registry
      const fault = fixture.armNextWorkFault('pending')
      const seeding = registry.seed(await fixture.makeHandle(0), { packageUse: null })
      await fault.rejected
      const disposing = registry.dispose()
      await fault.finish('commit')
      await seeding
      await disposing
      expect(hasRegistryPendingHandoff(registry, id)).toBe(false)
    })
    test('foreign state clears a pending hand-off before access, even if the bytes later return', async () => {
      const id = `foreign-pending-${mode}-${crypto.randomUUID()}`
      const fixture = await createRegistryFixture({ mode, setup: 'empty', groupID: id })
      onTestFinished(() => fixture.close())
      const gate = gateRegistryMaintenance(fixture.registry)
      const key = await fixture.registry.seed(await fixture.makeHandle(0), { packageUse: null })
      expect(hasRegistryPendingHandoff(fixture.registry, id)).toBe(true)
      const saved = await fixture.device.groups.loadState(key)
      if (saved === null || saved.deleted || saved.state === null) throw new Error('Missing state')
      const state = decodeClientState(saved.state)
      if (state === undefined) throw new Error('Invalid state')
      const { group: proposer } = await createGroup(
        fixture.identity,
        id,
        fixture.environment.options,
      )
      await proposer.proposeSelfRemoval()
      state.unappliedProposals = proposer.state.unappliedProposals
      await fixture.installRows({
        key,
        state: { ...saved, version: saved.version + 1, state: encodeClientState(state) },
      })
      // Join the post-observation read before checking the hand-off.
      await fixture.device.groups.loadState(key)
      expect(hasRegistryPendingHandoff(fixture.registry, id)).toBe(false)
      await fixture.installRows({ key, state: { ...saved, version: saved.version + 2 } })
      const access = await fixture.registry.access(id)
      expect(registryLeaseSnapshot(access)).toBeNull()
      gate.release()
      await registryLiveSend.get(access)?.drain()
      expect(registryLeaseSnapshot(access)?.limit).toBe(32)
    })
    test.each(['commit', 'rollback'] as const)(
      'seed hand-off waits for delayed %s proof without an owner',
      async (outcome) => {
        const id = `pending-seed-${mode}-${crypto.randomUUID()}`
        const fixture = await createRegistryFixture({ mode, setup: 'empty', groupID: id })
        onTestFinished(() => fixture.close())
        const fault = fixture.armNextWorkFault('pending')
        const seeding = fixture.registry.seed(await fixture.makeHandle(0), { packageUse: null })
        const settled = seeding.then(
          () => 'committed',
          () => 'rolled-back',
        )
        await fault.rejected
        await fault.finish(outcome)
        expect(await settled).toBe(outcome === 'commit' ? 'committed' : 'rolled-back')
        if (outcome === 'commit') {
          const access = await fixture.registry.access(id)
          expect(registryLeaseSnapshot(access)?.limit).toBe(16)
        } else await expect(fixture.registry.access(id)).rejects.toThrow()
      },
    )
    test.each(['commit', 'rollback'] as const)(
      'switch hand-off follows delayed %s proof',
      async (outcome) => {
        const fixture = await setup(mode)
        const base = fixture.fixture()
        const recovery = await base.confirmedRecovery(fixture.key, { confirm: true })
        const fault = base.armNextWorkFault('pending')
        const switching = base.registry.switchIncarnation(recovery.candidate, {
          source: recovery.source,
          rejoinID: recovery.record.id,
          proof: recovery.proof,
          write: {
            mutationID:
              'format' in recovery.record
                ? (recovery.record.switchMutationID ?? crypto.randomUUID())
                : crypto.randomUUID(),
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
        const settled = switching.then(
          () => 'committed',
          () => 'rolled-back',
        )
        await fault.rejected
        await fault.finish(outcome)
        expect(await settled).toBe(outcome === 'commit' ? 'committed' : 'rolled-back')
        const access = await base.registry.access(fixture.key.groupID)
        if (outcome === 'commit') {
          expect(access.key.incarnation).toBe(fixture.key.incarnation + 1)
          expect(registryLeaseSnapshot(access)?.limit).toBe(16)
          for (let generation = 0; generation < 12; generation++)
            expect(
              (
                await access.seal(new Uint8Array([1]), {
                  aad: fixture.aad('ephemeral'),
                  intent: 'ephemeral',
                })
              ).generation,
            ).toBe(generation)
        } else expect(access.key.incarnation).toBe(fixture.key.incarnation)
      },
    )
    test.each(['proposal', 'suspended', 'removed'] as const)(
      'ineligible %s install never advances stored generation',
      async (kind) => {
        const id = `deferred-lease-${mode}-${crypto.randomUUID()}`
        const fixture = await createRegistryFixture({ mode, setup: 'empty', groupID: id })
        onTestFinished(() => fixture.close())
        const input = await fixture.makeHandle(0)
        if (kind === 'removed') input.state.groupActiveState = { kind: 'removedFromGroup' }
        else if (kind === 'suspended')
          input.state.groupActiveState = {
            kind: 'suspendedPendingReinit',
            reinit: {
              groupId: input.state.groupContext.groupId,
              version: input.state.groupContext.version,
              cipherSuite: input.state.groupContext.cipherSuite,
              extensions: [],
            },
          }
        else {
          const { createGroup } = await import('@kumiai/mls')
          const source = (await createGroup(fixture.identity, id, fixture.environment.options))
            .group
          await source.proposeSelfRemoval()
          input.state.unappliedProposals = source.state.unappliedProposals
        }
        const key = await fixture.registry.seed(input, { packageUse: null })
        const access = await fixture.registry.access(id)
        await expect(
          access.seal(new Uint8Array([1]), {
            aad: encodeAppAAD({ topicID: 'lease-app', intent: 'ephemeral' }),
            intent: 'ephemeral',
          }),
        ).rejects.toMatchObject({ reason: kind === 'removed' ? 'terminal' : 'deferred' })
        await registryLiveSend.get(access)?.drain()
        const saved = await fixture.device.groups.loadState(key)
        if (saved === null || saved.deleted) throw new Error('Missing state')
        expect(saved.senderHWM).toBe(0)
      },
    )
    test('retirement drains an admitted seal and refuses new ones from drain start', async () => {
      const fixture = await setup(mode)
      const block = fixture.blockNextEncrypt()
      const sealing = fixture.sealEphemeral()
      await block.started
      const retirement = registryRetirement(fixture.fixture().registry).beginRetirement(fixture.key)
      let drained = false
      const draining = retirement.drain().then(() => {
        drained = true
      })
      await expect(fixture.sealEphemeral()).rejects.toMatchObject({ name: 'RegistryRetiringError' })
      expect(drained).toBe(false)
      block.release()
      await sealing
      await draining
      retirement.settle('rolled-back')
    })
    test('a failed eligibility restore is foreign', async () => {
      const fixture = await setup(mode)
      fixture.fixture().overrideRestore(async () => {
        throw new Error('Cannot restore observed control')
      })
      await fixture
        .fixture()
        .device.groups.ports(fixture.key)
        .control.apply({ cursor: { position: null, epoch: 0 } }, crypto.randomUUID())
      await registryLiveSend.get(fixture.access())?.accounting()
      expect(fixture.lease()).toBeNull()
    })
    test('background maintenance gate is persistent, per registry, and leaves installs running', async () => {
      const id = `maintenance-gate-${mode}`
      const base = await createRegistryFixture({ mode, setup: 'seeded', groupID: id })
      onTestFinished(() => base.close())
      const storedHWM = async () => {
        const saved = await base.device.groups.loadState({ groupID: id, incarnation: 1 })
        if (saved === null || saved.deleted) throw new Error('Missing state')
        return saved.senderHWM
      }
      const gate = gateRegistryMaintenance(base.registry)
      const access = await base.registry.access(id)
      await gate.started
      expect(registryLeaseSnapshot(access)).toBeNull()
      expect(await storedHWM()).toBe(0)
      const independent = await setup(mode)
      await independent.dropOwner()
      await independent.drainMaintenance()
      expect(independent.lease()?.limit).toBe(32)
      const accepted = await base.acceptedOrdinary(access)
      expect(await access.adopt(accepted.candidate, accepted.expected, accepted.write)).toBe(
        'installed',
      )
      expect(registryLeaseSnapshot(access)?.limit).toBe(16)
      for (let index = 0; index < 13; index++)
        await access.seal(new Uint8Array([1]), {
          aad: encodeAppAAD({ topicID: 'gate-app', intent: 'ephemeral' }),
          intent: 'ephemeral',
        })
      expect(await storedHWM()).toBe(16)
      gate.release()
      await registryLiveSend.get(access)?.drain()
      expect(registryLeaseSnapshot(access)?.limit).toBe(32)
      expect(await storedHWM()).toBe(32)
    })
    test('maintenance preserves an unresolved own mutation marker until resolution', async () => {
      const fixture = await setup(mode)
      const capability = entryCapability(fixture.fixture().device.groups)
      if (capability === null) throw new Error('Missing capability')
      const original = capability.run.bind(capability)
      vi.spyOn(capability, 'run').mockImplementationOnce(async (...args) => {
        await original(...args)
        throw new StorageOutcomeUnknownError('Lost run result')
      })
      vi.spyOn(fixture.fixture().device.groups, 'resolve').mockRejectedValueOnce(
        new Error('Outcome unresolved'),
      )
      await expect(fixture.reserveNow()).rejects.toThrow('Lost run result')
      const before = fixture.transactions()
      for (let index = 0; index < 13; index++) await fixture.sealEphemeral()
      await registryLiveSend.get(fixture.access())?.schedule()
      expect(fixture.transactions()).toBe(before)
      expect(fixture.lease()?.expectedVersions).toEqual([2])
      await fixture.drainMaintenance()
      expect(fixture.lease()?.expectedVersions).toEqual([])
      expect(fixture.lease()?.limit).toBe(32)
      await invariant(fixture)
    })
    test('unknown run rejection retains its version until delayed resolution', async () => {
      const fixture = await setup(mode)
      const capability = entryCapability(fixture.fixture().device.groups)
      if (capability === null) throw new Error('Missing capability')
      const original = capability.run.bind(capability)
      vi.spyOn(capability, 'run').mockImplementationOnce(async (...args) => {
        await original(...args)
        throw new StorageOutcomeUnknownError('Lost run result')
      })
      vi.spyOn(fixture.fixture().device.groups, 'resolve').mockRejectedValueOnce(
        new Error('Outcome unresolved'),
      )
      await expect(fixture.reserveNow()).rejects.toThrow('Lost run result')
      expect(fixture.lease()?.limit).toBe(16)
      expect(fixture.lease()?.expectedVersions).toEqual([2])
      await fixture.drainMaintenance()
      expect(fixture.lease()?.expectedVersions).toEqual([])
      expect(fixture.lease()?.limit).toBe(32)
      await invariant(fixture)
    })
    test('a generation change during eligibility restore discards the result and warms up', async () => {
      const fixture = await setup(mode)
      const live = registryLiveSend.get(fixture.access())
      if (live === undefined) throw new Error('Missing sender')
      const hold = fixture.fixture().holdRestore(fixture.key.groupID)
      await fixture
        .fixture()
        .device.groups.ports(fixture.key)
        .control.apply({ cursor: { position: null, epoch: 0 } }, crypto.randomUUID())
      await hold.started
      live.invalidate()
      hold.release()
      await live.accounting()
      await live.drain()
      expect(fixture.lease()?.limit).toBe(32)
      expect((await fixture.sealEphemeral()).generation).toBe(16)
    })
    test('a lapsed install refuses sealing without advancing stored generations', async () => {
      const id = `lapsed-${mode}-${crypto.randomUUID()}`
      const base = await createRegistryFixture({ mode, setup: 'empty', groupID: id })
      onTestFinished(() => base.close())
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
      vi.spyOn(Date, 'now').mockReturnValue(150_000)
      const binding = await timedBinding({ identity: base.identity, iat: 100, exp: 200 })
      const { createGroup, restoreGroup, signLedgerEntry, DEVICE_ENTRY_TYPE } = await import(
        '@kumiai/mls'
      )
      const { registryHandle } = await import('./fixtures/registry-welcome.js')
      const { group } = await createGroup(base.identity, id, { controller: binding })
      const token = await signLedgerEntry(base.identity, {
        type: DEVICE_ENTRY_TYPE,
        groupID: id,
        subject: binding.id,
        value: { op: 'clock', time: 201 },
      })
      const committed = await rawCommit({ group, tokens: [token] })
      const canonical = await restoreGroup({
        state: committed.newState,
        credential: group.credential,
        ledgerEntries: [token],
      })
      const input = await registryHandle({
        mode,
        handle: canonical,
        options: base.environment.options,
      })
      const key = await base.registry.seed(input, {
        packageUse: { sourceID: 'floor', ref: 'lapsed', kind: 'ordinary' },
      })
      const access = await base.registry.access(id)
      await expect(
        access.seal(new Uint8Array([1]), {
          aad: encodeAppAAD({ topicID: 'lease-app', intent: 'ephemeral' }),
          intent: 'ephemeral',
        }),
      ).rejects.toMatchObject({ reason: 'lapsed' })
      expect(registryLeaseSnapshot(access)).toBeNull()
      const record = await base.device.groups.loadState(key)
      if (record === null || record.deleted) throw new Error('Missing state')
      expect(record.senderHWM).toBe(0)
    })
    test('rolled-back resolution never accepts the retained reservation', async () => {
      const fixture = await setup(mode)
      const capability = entryCapability(fixture.fixture().device.groups)
      if (capability === null) throw new Error('Missing capability')
      vi.spyOn(capability, 'run').mockImplementationOnce(async (request, prepare) => {
        await capability.read(request.groupID, prepare)
        throw new StorageOutcomeUnknownError('Unknown rollback')
      })
      const resolve = vi
        .spyOn(fixture.fixture().device.groups, 'resolve')
        .mockResolvedValue('rolled-back')
      await expect(fixture.reserveNow()).rejects.toThrow()
      expect(resolve).toHaveBeenCalled()
      expect(fixture.lease()?.limit).toBe(16)
      await invariant(fixture)
    })
    test('outbox bookkeeping keeps the live copy without an eligibility restore', async () => {
      const fixture = await setup(mode)
      const copy = fixture.lease()?.copy
      const before = fixture.restores()
      await fixture
        .fixture()
        .device.groups.ports(fixture.key)
        .outbox.put({
          seq: 1,
          protocol: 'chat',
          prc: 'posted',
          data: new Uint8Array([1]),
          lastAttempt: null,
          status: 'accepted',
        })
      await registryLiveSend.get(fixture.access())?.accounting()
      expect(fixture.lease()?.copy).toBe(copy)
      expect(fixture.restores()).toBe(before)
      expect(fixture.lease()?.knownVersion).toBe((await fixture.record()).version)
    })
    test('changed control metadata retains the copy after one eligibility restore', async () => {
      const fixture = await setup(mode)
      const before = fixture.restores()
      const copy = fixture.lease()?.copy
      await fixture
        .fixture()
        .device.groups.ports(fixture.key)
        .control.apply({ cursor: { position: null, epoch: 0 } }, crypto.randomUUID())
      await registryLiveSend.get(fixture.access())?.accounting()
      expect(fixture.lease()?.copy).toBe(copy)
      expect(fixture.lease()?.knownVersion).toBe((await fixture.record()).version)
      expect(fixture.restores() - before).toBe(1)
      expect((await fixture.sealEphemeral()).generation).toBe(0)
    })
    test('AAD intent is validated before encryption', async () => {
      const fixture = await setup(mode)
      await expect(
        fixture
          .access()
          .seal(new Uint8Array([1]), { aad: fixture.aad('log'), intent: 'ephemeral' }),
      ).rejects.toBeInstanceOf(TypeError)
      expect(fixture.lease()?.own).toBe(0)
    })
  })
}
