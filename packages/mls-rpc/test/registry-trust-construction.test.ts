import { controlBatch } from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import { createLedgerEntrySlot } from '../src/mls.js'
import { createRegistryGroupMLS } from '../src/registry-group-mls.js'
import { createRegistryFixture } from './fixtures/registry.js'

test.each(['real-mls', 'double'] as const)(
  'registry MLS construction and recovery secret need only retained trust (%s)',
  async (mode) => {
    const groupID = crypto.randomUUID()
    let fixture = await createRegistryFixture({
      mode,
      setup: 'seeded',
      groupID,
      backgroundMaintenance: 'gated',
    })
    fixture = await fixture.reopen()
    const restore = vi.fn(async () => {
      throw new Error('Private state cannot restore')
    })
    fixture.overrideRestore(restore)
    try {
      const result = await createRegistryGroupMLS({
        registry: fixture.registry,
        key: { groupID, incarnation: 1 },
        recovery: fixture.environment,
        identity: fixture.identity,
        entrySlot: createLedgerEntrySlot(),
        target: { targetID: 'hub', topicID: 'commits' },
      }).then(
        (mls) => ({ mls }),
        (error: unknown) => ({ error }),
      )
      expect(result).not.toHaveProperty('error')
      if (!('mls' in result)) throw new Error('Missing trust-only MLS')
      expect(await result.mls.exportRecoverySecret()).toHaveLength(32)
      expect(restore).not.toHaveBeenCalled()
      const binding = controlBatch(result.mls)
      expect(binding).toBeDefined()
      await expect(
        binding?.run({ source: 'needs-private-state', prepare: async () => {} }),
      ).rejects.toThrow()
      expect(restore).toHaveBeenCalledOnce()
    } finally {
      await fixture.close()
    }
  },
)
