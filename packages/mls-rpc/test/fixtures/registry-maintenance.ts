import { decodeClientState, ownApplicationGeneration } from '@kumiai/mls'
import { encodeAppAAD } from '@kumiai/rpc'
import { expect, test } from 'vitest'

import { drainRegistryMaintenance, registryLeaseSnapshot } from '../../src/testing.js'
import { createRegistryFixture } from './registry.js'

// Each legacy fixture family also exercises the production warm-up schedule.
export function testRegistryBackgroundWarmup(family: string) {
  for (const mode of ['real-mls', 'double'] as const) {
    test(`${family} fixture with background reservations enabled (${mode})`, async () => {
      let fixture = await createRegistryFixture({
        mode,
        setup: 'seeded',
        groupID: `warmup-${family}-${mode}`,
      })
      try {
        let access = await fixture.registry.access(`warmup-${family}-${mode}`)
        const assertReserved = async (limit: number) => {
          const saved = await fixture.device.groups.loadState(access.key)
          if (saved === null || saved.deleted || saved.state === null)
            throw new Error('Missing reserved state')
          const state = decodeClientState(saved.state)
          if (state === undefined) throw new Error('Invalid reserved state')
          expect(saved.senderHWM).toBe(limit)
          expect(ownApplicationGeneration(state)).toBe(limit)
          expect(registryLeaseSnapshot(access)?.limit).toBe(limit)
        }
        await drainRegistryMaintenance(access)
        await assertReserved(16)
        fixture = await fixture.reopen()
        access = await fixture.registry.access(access.key.groupID)
        const sealed = await access.seal(new Uint8Array([1]), {
          aad: encodeAppAAD({ topicID: 'warmup', intent: 'log' }),
          intent: 'log',
        })
        expect(sealed.generation).toBe(16)
        await assertReserved(32)
      } finally {
        await fixture.close()
      }
    })
  }
}
