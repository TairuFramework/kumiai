import { decodeSignedToken, type OwnIdentity } from '@kokuin/token'
import {
  type ControllerBinding,
  createGroup,
  encodeClientState,
  publicMembershipFacts,
  signLedgerEntry,
} from '@kumiai/mls'
import { forkEventID, recoveryUnavailableEventID } from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import {
  bindEntryCapability,
  coordinatorBinding,
  entryCapability,
} from '../src/entry-capability.js'
import { createGroupHandleRegistry } from '../src/index.js'
import type { GroupKey, GroupStores, MemoryTransaction } from '../src/persistence-types.js'
import * as registryRuntime from '../src/registry/runtime.js'
import { createRegistryRuntime } from '../src/registry/runtime.js'
import { publicRuntimeFacts } from '../src/registry/runtime-facts.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { deferred } from '../src/runtime.js'
import {
  createRegistryFixture,
  type RegistryFixtureBase,
  registryFixtureObserve,
  registryFixtureRestore,
} from './fixtures/registry.js'
import { registryHandle } from './fixtures/registry-welcome.js'
import { nextChange } from './fixtures/storage-seed.js'

function registry(fixture: RegistryFixtureBase) {
  return createGroupHandleRegistry({
    persistence: fixture.device,
    providerID: fixture.device.providerID,
    recovery: fixture.environment,
    restore: registryFixtureRestore(fixture),
    restoreCandidate: async () => {
      throw new Error('Unexpected candidate restoration')
    },
  })
}
async function installNext(fixture: RegistryFixtureBase, key: GroupKey) {
  const record = await fixture.device.groups.loadState(key)
  if (record === null || record.deleted || record.state === null) throw new Error('Missing state')
  const handle = await fixture.advance(
    await registryFixtureRestore(fixture)({ ...record, state: record.state }),
  )
  const count = fixture.restoreCount(key.groupID)
  await fixture.installRows({
    key,
    state: {
      ...record,
      version: record.version + 1,
      epoch: Number(handle.epoch),
      epochAuthenticator: handle.state.keySchedule.epochAuthenticator,
      state: encodeClientState(handle.state),
    },
    trust: recoveryTrustFor(handle, key, await fixture.device.groups.loadTrust(key.groupID)),
  })
  expect(fixture.restoreCount(key.groupID)).toBe(count)
  return handle
}
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

for (const mode of ['real-mls', 'double'] as const) {
  describe(`registry runtime (${mode})`, () => {
    const groupID = `runtime-${mode}`
    const key = { groupID, incarnation: 1 }
    const create = () => createRegistryFixture({ mode, groupID, setup: 'seeded' })

    test('public facts match real and model handles without restoration', async () => {
      const fixture = await create()
      try {
        const handle = await fixture.makeHandle(1)
        const params = {
          tree: handle.state.ratchetTree,
          anchor: handle.anchor,
          registry: handle.registry,
          ownerDID: fixture.identity.id,
        }
        expect(publicRuntimeFacts(params)).toEqual({
          members: [fixture.identity.id],
          ownPresent: true,
          lapsed: false,
        })
        expect(publicRuntimeFacts(params)).toEqual(publicMembershipFacts(params))
        expect(handle.listMembers().map((member) => member.id)).toEqual([fixture.identity.id])
        params.tree[handle.state.privatePath.leafIndex * 2] = undefined
        expect(publicRuntimeFacts(params)).toEqual({
          members: [],
          ownPresent: false,
          lapsed: false,
        })
      } finally {
        await fixture.close()
      }
    })

    test('public lapse agrees with real and model handles and admission precedence', async () => {
      const fixture = await createRegistryFixture({ mode, groupID, setup: 'empty' })
      try {
        const { bindingFor } = (await import(
          new URL('../../mls/test/fixtures/lifecycle-ledger.ts', import.meta.url).href
        )) as {
          bindingFor(identity: OwnIdentity): Promise<ControllerBinding>
        }
        const binding = await bindingFor(fixture.identity)
        fixture.environment.options.controller = binding
        const options = fixture.environment.options
        const original = (await createGroup(fixture.identity, groupID, options)).group
        const clock = await signLedgerEntry(fixture.identity, {
          type: 'kumiai.device',
          groupID,
          subject: binding.id,
          value: {
            op: 'clock',
            time: Number(decodeSignedToken(binding.capability).payload.exp) + 1,
          },
        })
        await original.applyLedgerEntries([clock])
        const handle = await registryHandle({ mode, handle: original, options })
        const facts = publicRuntimeFacts({
          tree: handle.state.ratchetTree,
          anchor: handle.anchor,
          registry: handle.registry,
          ownerDID: fixture.identity.id,
        })
        expect(facts).toEqual({ members: [fixture.identity.id], ownPresent: true, lapsed: true })
        expect(handle.sendAdmission()).toMatchObject({ admissible: false, reason: 'lapsed' })
        await fixture.installRows({
          key,
          state: {
            ...key,
            version: 1,
            deleted: false,
            terminal: false,
            epoch: Number(handle.epoch),
            epochAuthenticator: handle.state.keySchedule.epochAuthenticator,
            state: encodeClientState(handle.state),
            credential: handle.credential,
            ledger: handle.ledgerTokens,
            senderHWM: 0,
          },
          trust: recoveryTrustFor(handle, key, null),
        })
        const access = await registry(fixture).access(groupID)
        await fixture.device.groups.ports(key).cursor.save('lapsed', '1')
        expect(access.admission()).toEqual({ epoch: 0, admissible: false, reason: 'lapsed' })
        expect(access.runtime.snapshot()?.available).toBe(true)
        await fixture.installRows({ key, control: { strand: { reason: 'lost-state' } } })
        expect(access.admission()).toEqual({ epoch: 0, admissible: false, reason: 'stranded' })
        const record = await fixture.device.groups.loadState(key)
        if (record === null || record.deleted) throw new Error('Missing state')
        await fixture.installRows({
          key,
          state: { ...record, version: record.version + 1, terminal: true },
        })
        expect(access.admission()).toEqual({ epoch: 0, admissible: false, reason: 'terminal' })
        expect(access.runtime.snapshot()?.available).toBe(false)
        await fixture.installRows({
          key,
          control: {
            recoveryUnavailable: {
              ...key,
              id: recoveryUnavailableEventID(key),
              kind: 'group:recovery-unavailable',
              reason: 'trust-unreadable',
            },
          },
        })
        expect(access.admission()).toEqual({
          epoch: 0,
          admissible: false,
          reason: 'recovery-unavailable',
        })
        await fixture.installRows({
          key,
          control: {
            forkHalt: {
              eventID: forkEventID(key),
              detectedAt: 42,
              evidence: {
                kind: 'digest-divergence',
                epoch: 0,
                position: '1',
                localDigest: 'local',
                remoteDigest: 'remote',
              },
            },
          },
        })
        expect(access.admission()).toEqual({ epoch: 0, admissible: false, reason: 'fork-halted' })
      } finally {
        await fixture.close()
      }
    })

    test('control-only commit updates runtime and admission from final rows', async () => {
      const fixture = await create()
      try {
        const access = await registry(fixture).access(groupID)
        const count = fixture.restoreCount(groupID)
        const notifications: Array<number | undefined> = []
        access.runtime.onEpochChanged((value) => {
          notifications.push(value?.stateVersion)
        })
        await fixture.installRows({ key, control: { strand: { reason: 'lost-state' } } })
        expect(access.stateVersion()).toBe(2)
        expect(access.runtime.snapshot()).toMatchObject({ stateVersion: 2, available: true })
        expect(access.admission()).toEqual({ epoch: 0, admissible: false, reason: 'stranded' })
        expect(fixture.restoreCount(groupID)).toBe(count)
        expect(notifications).toEqual([2])
      } finally {
        await fixture.close()
      }
    })

    test('access follows a replaced runtime through later publications', async () => {
      const fixture = await create()
      const runtimeFactory = createRegistryRuntime
      const controllers: Array<ReturnType<typeof createRegistryRuntime>> = []
      const spy = vi.spyOn(registryRuntime, 'createRegistryRuntime').mockImplementation(() => {
        const controller = runtimeFactory()
        controllers.push(controller)
        return controller
      })
      try {
        const access = await registry(fixture).access(groupID)
        const controller = controllers[0]
        const snapshot = access.runtime.snapshot()
        if (controller === undefined || snapshot === null) throw new Error('Missing runtime')
        const replacement = runtimeFactory()
        replacement.publish({ ...snapshot, epoch: 1, stateVersion: 2 })
        controller.runtime = replacement.runtime
        expect(access.runtime.snapshot()).toMatchObject({ ...key, epoch: 1, stateVersion: 2 })
        const epochs: Array<number | undefined> = []
        access.runtime.onEpochChanged((value) => {
          epochs.push(value?.epoch)
        })
        replacement.publish({ ...snapshot, epoch: 2, stateVersion: 3 })
        expect(access.runtime.snapshot()).toMatchObject({ ...key, epoch: 2, stateVersion: 3 })
        expect(epochs).toEqual([2])
      } finally {
        spy.mockRestore()
        await fixture.close()
      }
    })

    test('snapshot is installed synchronously at proof before external notification', async () => {
      const fixture = await create()
      try {
        const access = await registry(fixture).access(groupID)
        let calls = 0
        access.runtime.onEpochChanged(() => {
          calls++
        })
        const atProof: Array<{ stateVersion: number | undefined; calls: number }> = []
        registryFixtureObserve(fixture, groupID, () => {
          atProof.push({ stateVersion: access.runtime.snapshot()?.stateVersion, calls })
        })
        await fixture.device.groups.ports(key).cursor.save('proof', '1')
        expect(atProof).toEqual([{ stateVersion: 2, calls: 0 }])
        expect(calls).toBe(1)
      } finally {
        await fixture.close()
      }
    })

    test('anchor outbox and cursor facades invalidate immutable cache bytes', async () => {
      const fixture = await create()
      try {
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        const ports = fixture.device.groups.ports(key)
        const writes = [
          () => ports.anchor.save({ anchor: { epoch: 0, secret: new Uint8Array(32).fill(8) } }),
          () =>
            ports.outbox.put({
              seq: 1,
              protocol: 'app',
              prc: 'message',
              data: new Uint8Array([9]),
              lastAttempt: null,
              status: 'accepted',
            }),
          () => ports.cursor.save('topic', '1'),
        ]
        for (const [index, write] of writes.entries()) {
          const count = fixture.restoreCount(groupID)
          await write()
          expect(access.stateVersion()).toBe(index + 2)
          expect(await owner.access(groupID)).toBe(access)
          expect(fixture.restoreCount(groupID)).toBe(count + 1)
        }
      } finally {
        await fixture.close()
      }
    })

    test.each(['commit', 'rollback'] as const)(
      'pending proof retains old snapshot until %s',
      async (outcome) => {
        const fixture = await create()
        try {
          const access = await registry(fixture).access(groupID)
          const before = access.runtime.snapshot()
          const values: Array<number | undefined> = []
          access.runtime.onEpochChanged((value) => {
            values.push(value?.stateVersion)
          })
          const fault = fixture.armWorkFault('pending-runtime', 'pending')
          const saving = fixture.device.groups.transition(
            await nextChange(fixture.device.groups, groupID, 'pending-runtime'),
            async (stores) => {
              await stores.incarnation(1).cursor.save('pending', '2')
            },
          )
          const settled = saving.then(
            () => 'committed',
            () => 'rolled-back',
          )
          await fault.rejected
          expect(access.runtime.snapshot()).toEqual(before)
          expect(values).toEqual([])
          await fault.finish(outcome)
          expect(await settled).toBe(outcome === 'commit' ? 'committed' : 'rolled-back')
          await turn()
          expect(access.runtime.snapshot()?.stateVersion).toBe(outcome === 'commit' ? 2 : 1)
          expect(values).toEqual(outcome === 'commit' ? [2] : [])
        } finally {
          await fixture.close()
        }
      },
    )

    test('snapshots and listener values are independently defensive', async () => {
      const fixture = await create()
      try {
        const access = await registry(fixture).access(groupID)
        access.runtime.onEpochChanged((value) => {
          if (value === null) throw new Error('Missing listener snapshot')
          value.authenticator.fill(0)
          ;(value.members as Set<string>).clear()
          value.stateVersion = 999
        })
        const received: Array<number | undefined> = []
        access.runtime.onEpochChanged((value) => {
          expect(value?.members).toEqual(new Set([fixture.identity.id]))
          expect(value?.authenticator.some((byte) => byte !== 0)).toBe(true)
          received.push(value?.stateVersion)
        })
        await installNext(fixture, key)
        expect(received).toEqual([2])
        const snapshot = access.runtime.snapshot()
        if (snapshot === null) throw new Error('Missing runtime snapshot')
        snapshot.authenticator.fill(0)
        ;(snapshot.members as Set<string>).clear()
        expect(access.runtime.snapshot()?.members).toEqual(new Set([fixture.identity.id]))
        expect(access.epoch()).toBe(1)
      } finally {
        await fixture.close()
      }
    })

    test('successive commits retain the last accepted spent trust baseline', async () => {
      const fixture = await create()
      try {
        const capability = entryCapability(fixture.device.groups)
        const binding = coordinatorBinding(fixture.device.groups)
        if (capability === null || binding === null) throw new Error('Missing capability')
        let proofs = 0
        let firstAuthenticator: Uint8Array | undefined
        let removed = false
        bindEntryCapability({
          persistence: fixture.device.groups,
          coordinatorBinding: binding,
          capability: {
            ...capability,
            observe(groupID, onProof, afterRelease) {
              return capability.observe(
                groupID,
                (value) => {
                  proofs++
                  if (proofs === 1)
                    firstAuthenticator = value.trust?.installed.authenticator.slice()
                  if (proofs === 2 && value.trust !== null && firstAuthenticator !== undefined) {
                    const spent = value.trust.spentEpochAuthenticators
                    value.trust.spentEpochAuthenticators = spent.filter(
                      (bytes) =>
                        bytes.length !== firstAuthenticator?.length ||
                        bytes.some((byte, index) => byte !== firstAuthenticator?.[index]),
                    )
                    removed = value.trust.spentEpochAuthenticators.length === spent.length - 1
                  }
                  onProof(value)
                },
                afterRelease,
              )
            },
          },
        })
        const access = await registry(fixture).access(groupID)
        const values: Array<number | null> = []
        access.runtime.onEpochChanged((value) => {
          values.push(value?.stateVersion ?? null)
        })
        await installNext(fixture, key)
        expect(access.runtime.snapshot()).toMatchObject({ stateVersion: 2, epoch: 1 })
        const restored = fixture.restoreCount(groupID)
        await installNext(fixture, key)
        expect(proofs).toBe(2)
        expect(removed).toBe(true)
        expect(fixture.restoreCount(groupID)).toBe(restored + 1)
        expect(access.runtime.snapshot()).toBeNull()
        expect(values).toEqual([2, null])
        expect((await fixture.device.groups.loadTrust(groupID))?.installed.epoch).toBe(2)
      } finally {
        await fixture.close()
      }
    })

    test('listeners can call same-group roots after release', async () => {
      const fixture = await create()
      try {
        const access = await registry(fixture).access(groupID)
        const read = deferred<void>()
        access.runtime.onEpochChanged(() => {
          void fixture.device.groups.load(groupID).then(() => read.resolve(), read.reject)
        })
        await fixture.device.groups.ports(key).cursor.save('root', '1')
        await expect(read.promise).resolves.toBeUndefined()
      } finally {
        await fixture.close()
      }
    })

    test('slow rejecting and throwing listeners do not delay commits or FIFO notifications', async () => {
      const fixture = await create()
      const pending = deferred<void>()
      try {
        const access = await registry(fixture).access(groupID)
        const order: Array<string> = []
        access.runtime.onEpochChanged((value) => {
          order.push(`first:${value?.stateVersion}`)
          return pending.promise
        })
        access.runtime.onEpochChanged(() => {
          throw new Error('Listener failed synchronously')
        })
        access.runtime.onEpochChanged((value) => {
          order.push(`last:${value?.stateVersion}`)
        })
        await fixture.device.groups.ports(key).cursor.save('fifo', '1')
        await fixture.device.groups.ports(key).cursor.save('fifo', '2')
        expect(order).toEqual(['first:2', 'last:2', 'first:3', 'last:3'])
        expect(access.stateVersion()).toBe(3)
        pending.reject(new Error('Listener failed asynchronously'))
        await turn()
      } finally {
        pending.resolve()
        await fixture.close()
      }
    })

    test.each(['trust', 'state'] as const)('unreadable %s publishes null once', async (corrupt) => {
      const fixture = await create()
      try {
        const access = await registry(fixture).access(groupID)
        const values: Array<unknown> = []
        access.runtime.onEpochChanged((value) => {
          values.push(value)
        })
        if (corrupt === 'trust') await fixture.corruptTrust(groupID)
        else await fixture.corruptState(key)
        await fixture.device.groups
          .ports(key)
          .control.apply({ cursor: { position: null, epoch: 0 } }, 'diagnostic-1')
        expect(access.runtime.snapshot()).toBeNull()
        await fixture.device.groups
          .ports(key)
          .control.apply({ cursor: { position: null, epoch: 0 } }, 'diagnostic-2')
        expect(values).toEqual([null])
      } finally {
        await fixture.close()
      }
    })

    test.each([
      'lifetimeStatus',
      'metadataStatus',
      'controlStatus',
      'trustStatus',
      'stateStatus',
    ] as const)('unreadable observation %s refuses public snapshot', async (status) => {
      const fixture = await create()
      try {
        const capability = entryCapability(fixture.device.groups)
        const binding = coordinatorBinding(fixture.device.groups)
        if (capability === null || binding === null) throw new Error('Missing capability')
        bindEntryCapability({
          persistence: fixture.device.groups,
          coordinatorBinding: binding,
          capability: {
            ...capability,
            observe(groupID, onProof, afterRelease) {
              return capability.observe(
                groupID,
                (value) => {
                  value[status] = 'unreadable'
                  onProof(value)
                },
                afterRelease,
              )
            },
          },
        })
        const access = await registry(fixture).access(groupID)
        await fixture.device.groups.ports(key).cursor.save('status', '1')
        expect(access.runtime.snapshot()).toBeNull()
      } finally {
        await fixture.close()
      }
    })

    test.each(['empty', 'seeded'] as const)(
      'first recovery source call subscribes before entry for %s groups',
      async (setup) => {
        const fixture = await createRegistryFixture({ mode, groupID, setup })
        try {
          const capability = entryCapability(fixture.device.groups)
          const binding = coordinatorBinding(fixture.device.groups)
          if (capability === null || binding === null) throw new Error('Missing capability')
          const order: Array<string> = []
          bindEntryCapability({
            persistence: fixture.device.groups,
            coordinatorBinding: binding,
            capability: {
              ...capability,
              observe(...args) {
                order.push('subscribe')
                return capability.observe(...args)
              },
              read(groupID, fn) {
                order.push('entry')
                return capability.read(groupID, fn)
              },
            },
          })
          const owner = registry(fixture)
          async function readSource() {
            if (setup === 'empty') {
              await expect(owner.recoverySource(groupID)).rejects.toMatchObject({
                reason: 'absent',
              })
            } else {
              expect((await owner.recoverySource(groupID)).key).toEqual(key)
            }
          }
          await readSource()
          expect(order).toEqual(['subscribe', 'entry'])
          await readSource()
          expect(order).toEqual(['subscribe', 'entry', 'entry'])
          expect(fixture.restoreCount(groupID)).toBe(0)
        } finally {
          await fixture.close()
        }
      },
    )

    test('initially absent groups subscribe before the first cold call', async () => {
      const fixture = await createRegistryFixture({ mode, groupID, setup: 'empty' })
      try {
        const capability = entryCapability(fixture.device.groups)
        const binding = coordinatorBinding(fixture.device.groups)
        if (capability === null || binding === null) throw new Error('Missing capability')
        let subscribed = false
        bindEntryCapability({
          persistence: fixture.device.groups,
          coordinatorBinding: binding,
          capability: {
            ...capability,
            observe(...args) {
              subscribed = true
              return capability.observe(...args)
            },
            read(groupID, fn) {
              expect(subscribed).toBe(true)
              return capability.read(groupID, fn)
            },
          },
        })
        await expect(registry(fixture).access(groupID)).rejects.toMatchObject({ reason: 'absent' })
      } finally {
        await fixture.close()
      }
    })

    test('displacement emits null once and replacement starts with its own runtime', async () => {
      const fixture = await create()
      try {
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        const values: Array<unknown> = []
        access.runtime.onEpochChanged((value) => {
          values.push(value)
        })
        const handle = await fixture.makeHandle(0)
        const nextKey = { groupID, incarnation: 2 }
        const record = await fixture.device.groups.loadState(key)
        if (record === null || record.deleted) throw new Error('Missing state')
        await fixture.device.groups.transition(
          await nextChange(fixture.device.groups, groupID, 'displace'),
          async (stores) => {
            const lifetime = await stores.lifetime.load()
            if (lifetime === null) throw new Error('Missing lifetime')
            await stores.lifetime.save({
              ...lifetime,
              latestIncarnation: 2,
              activeIncarnation: 2,
              revision: lifetime.revision + 1,
              mutationID: 'displace',
            })
            await stores.incarnation(2).state.save({
              ...record,
              ...nextKey,
              version: 1,
              state: encodeClientState(handle.state),
              epochAuthenticator: handle.state.keySchedule.epochAuthenticator,
            })
            await stores.trust.save(recoveryTrustFor(handle, nextKey, await stores.trust.load()))
          },
        )
        expect(access.runtime.snapshot()).toBeNull()
        await expect(access.read(() => {})).rejects.toMatchObject({
          name: 'DisplacedGroupHandleError',
        })
        expect(values).toEqual([null])
        expect((await owner.access(groupID)).runtime.snapshot()).toMatchObject({
          ...nextKey,
          stateVersion: 1,
        })
      } finally {
        await fixture.close()
      }
    })

    test('effect-only commit projects the final accounted active version', async () => {
      let supplied: GroupStores<MemoryTransaction> | undefined
      const fixture = await createRegistryFixture({
        mode,
        groupID,
        setup: 'seeded',
        effects: {
          async outbox() {
            await supplied?.incarnation(1).cursor.save('effect', '1')
          },
        },
      })
      try {
        const access = await registry(fixture).access(groupID)
        await fixture.device.groups.transition(
          await nextChange(fixture.device.groups, groupID, 'effect-only'),
          async (stores) => {
            supplied = stores
            await stores.incarnation(2).meta.putEvents([
              {
                ...key,
                incarnation: 2,
                kind: 'accepted',
                id: 'effect',
                entry: {
                  seq: 1,
                  protocol: 'app',
                  prc: 'message',
                  data: new Uint8Array([9]),
                  lastAttempt: null,
                  status: 'accepted',
                },
              },
            ])
          },
        )
        expect(access.runtime.snapshot()?.stateVersion).toBe(2)
        expect(await fixture.device.groups.ports(key).cursor.load('effect')).toBe('1')
      } finally {
        await fixture.close()
      }
    })
  })
}

test('listener failures retain bounded internal diagnostics without affecting later listeners', async () => {
  const runtime = createRegistryRuntime()
  const synchronous = new Error('Synchronous listener')
  const asynchronous = new Error('Asynchronous listener')
  let calls = 0
  runtime.runtime.onEpochChanged(() => {
    throw synchronous
  })
  runtime.runtime.onEpochChanged(() => Promise.reject(asynchronous))
  runtime.runtime.onEpochChanged(() => {
    calls++
  })
  runtime.publish({
    groupID: 'diagnostics',
    incarnation: 1,
    epoch: 0,
    stateVersion: 1,
    authenticator: new Uint8Array([9]),
    members: new Set(),
    available: false,
  })
  expect(calls).toBe(1)
  expect(runtime.listenerFailures()).toEqual({ count: 1, lastError: synchronous })
  await turn()
  expect(runtime.listenerFailures()).toEqual({ count: 2, lastError: asynchronous })
})
