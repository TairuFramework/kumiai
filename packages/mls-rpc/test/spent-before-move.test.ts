import type { LogHub } from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import { createLedgerEntrySlot } from '../src/mls.js'
import { createRecoveryContinuationPort } from '../src/registry/continuation.js'
import { createRegistryGroupMLS } from '../src/registry-group-mls.js'
import { createRegistryPeer, type RegistryPeer } from '../src/registry-peer.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createRegistryFixture } from './fixtures/registry.js'

for (const context of ['supplied', 'absent'] as const) {
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
