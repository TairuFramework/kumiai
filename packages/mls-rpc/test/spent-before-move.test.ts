import type { LogHub } from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import { createLedgerEntrySlot } from '../src/mls.js'
import { createRecoveryContinuationPort } from '../src/registry/continuation.js'
import { registrySafety } from '../src/registry/safety.js'
import { createRegistryGroupMLS } from '../src/registry-group-mls.js'
import { createRegistryPeer, type RegistryPeer } from '../src/registry-peer.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createRegistryFixture } from './fixtures/registry.js'

for (const context of ['supplied', 'absent'] as const) {
  test(`latched spent corruption rejects manual recovery after a transient trust read / ownership context ${context}`, async () => {
    const key = { groupID: `spent-manual-read-failure-${context}`, incarnation: 1 }
    const f = await createRegistryFixture({
      mode: 'real-mls',
      setup: 'seeded',
      groupID: key.groupID,
      ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
    })
    let owner: RegistryPeer | undefined
    try {
      const saved = await f.manualRecovery().authoriseManualRecovery(key, {
        mode: 'resync',
        targetID: 'new-hub',
        commitTopicID: 'new-commits',
        allowOpenFork: false,
      })
      await f.registry.access(key.groupID)
      await f.corruptTrust(key.groupID, 'empty-spent')
      const unexpected = () => {
        throw new Error('Corrupt source must not start a peer or use the hub')
      }
      const hub: LogHub = {
        subscribe: unexpected,
        receive: unexpected,
        publish: unexpected,
        fetchTopic: unexpected,
      }
      owner = await createRegistryPeer({
        registry: f.registry,
        key,
        recovery: f.environment,
        target: { targetID: 'old-hub', topicID: 'old-commits' },
        resolveTarget: async (id) => ({ id, hub, commitTopicID: 'new-commits' }),
        continuation: createRecoveryContinuationPort({
          registry: f.registry,
          persistence: f.device.groups,
        }),
        createMLS: unexpected,
        createPeer: unexpected,
      })
      await owner.ready
      const capability = registrySafety(f.registry)
      if (capability === null) throw new Error('Missing safety capability')
      expect(capability.held(key)).toBe('spent-set-corrupt')
      expect(owner.status().kind).toBe('spent-set-corrupt')
      const control = await f.device.groups.ports(key).control.load()
      const read = capability.entry.read.bind(capability.entry)
      let failNextTrustRead = true
      vi.spyOn(capability.entry, 'read').mockImplementation((groupID, fn) => {
        return read(groupID, (reads) => {
          return fn({
            ...reads,
            trust: async () => {
              if (failNextTrustRead) {
                failNextTrustRead = false
                throw new Error('Transient diagnostic trust read failure')
              }
              return reads.trust()
            },
          })
        })
      })
      let outcome: unknown
      void owner.runManualRecovery(saved).then(
        (destination) => {
          outcome = { destination }
        },
        (error: unknown) => {
          outcome = error
        },
      )
      await vi.waitFor(() => {
        expect(outcome).toMatchObject({ name: 'SpentSetCorruptError', key })
      })
      expect(failNextTrustRead).toBe(false)
      expect(await f.manualRecovery().readManualRecovery(saved.id)).toEqual(saved)
      expect(await f.device.groups.ports(key).control.load()).toEqual(control)
      expect((await f.device.groups.load(key.groupID))?.activeIncarnation).toBe(1)
      expect(owner.installedKey()).toEqual(key)
      expect(owner.peer()).toBeNull()
      expect(owner.status().kind).toBe('spent-set-corrupt')
    } finally {
      owner?.dispose()
      await owner?.drained().catch(() => {})
      vi.restoreAllMocks()
      await f.close()
    }
  })

  test(`spent diagnosis runs before a current move / ownership context ${context}`, async () => {
    const key = { groupID: `spent-before-move-${context}`, incarnation: 1 }
    const f = await createRegistryFixture({
      mode: 'real-mls',
      setup: 'seeded',
      groupID: key.groupID,
      ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
    })
    let owner: RegistryPeer | undefined
    try {
      const saved = await f.manualRecovery().authoriseManualRecovery(key, {
        mode: 'resync',
        targetID: 'new-hub',
        commitTopicID: 'new-commits',
        allowOpenFork: false,
      })
      // Keep the runtime warm: a current move must diagnose the surviving trust envelope itself.
      await f.registry.access(key.groupID)
      await f.corruptTrust(key.groupID, 'empty-spent')
      const access = vi.spyOn(f.registry, 'access')
      const unexpected = () => {
        throw new Error('Corrupt source must not start a peer or use the hub')
      }
      const hub: LogHub = {
        subscribe: unexpected,
        receive: unexpected,
        publish: unexpected,
        fetchTopic: unexpected,
      }
      owner = await createRegistryPeer({
        registry: f.registry,
        key,
        recovery: f.environment,
        target: { targetID: 'old-hub', topicID: 'old-commits' },
        resolveTarget: async (id) => ({ id, hub, commitTopicID: 'new-commits' }),
        continuation: createRecoveryContinuationPort({
          registry: f.registry,
          persistence: f.device.groups,
        }),
        createMLS: (key, _handoff, options) =>
          createRegistryGroupMLS({
            registry: f.registry,
            key,
            recovery: f.environment,
            target: options.target,
            identity: f.identity,
            entrySlot: createLedgerEntrySlot(),
            manualRecovery: options.manualRecovery,
          }),
        createPeer: unexpected,
      })
      await owner.ready.catch(() => {})
      expect(owner.status().kind).toBe('spent-set-corrupt')
      expect(access).not.toHaveBeenCalled()
      expect(await f.manualRecovery().readManualRecovery(saved.id)).toEqual(saved)
      expect(owner.peer()).toBeNull()
      expect(owner.installedKey()).toEqual(key)
    } finally {
      owner?.dispose()
      await owner?.drained().catch(() => {})
      vi.restoreAllMocks()
      await f.close()
    }
  })
}
