import { AsyncLocalStorage } from 'node:async_hooks'
import { expect, test, vi } from 'vitest'

import type { OwnershipContextPort } from '../src/persistence-types.js'
import type { createRegistryLeaseFixture } from './fixtures/registry-lease.js'

for (const mode of ['real-mls', 'double'] as const) {
  for (const context of [false, true]) {
    test.each(['ambient', 'owner'] as const)(
      `contextual import leaves independent registry refreshes detached (${mode}, context=${context}, importer=%s)`,
      async (importer) => {
        vi.resetModules()
        const storage = new AsyncLocalStorage<object>()
        const port: OwnershipContextPort = {
          run: (token, fn) => storage.run(token, fn),
          get: () => storage.getStore(),
        }
        const { createOwnerQueues } = await import('../src/owner-queue.js')
        const queues = createOwnerQueues({ ownershipContext: port })
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        let importingToken: object | undefined
        const load = async () => {
          importingToken = port.get()
          await import('../src/registry/live-receive.js')
          entered.resolve()
          await release.promise
        }
        const importing =
          importer === 'owner'
            ? queues.run('read', { ownerDID: null, groupID: 'importer' }, load)
            : storage.run({}, load)
        const fixtures: Array<Awaited<ReturnType<typeof createRegistryLeaseFixture>>> = []
        try {
          await entered.promise
          expect(importingToken).toBeDefined()
          const { createRegistryLeaseFixture } = await import('./fixtures/registry-lease.js')
          const { registryReceiveSlots } = await import('../src/registry/live-receive.js')
          const { registryMaintenanceGates } = await import('../src/registry/live-send.js')
          const observed: Array<object | undefined> = []
          for (let index = 0; index < 2; index++) {
            const fixture = await createRegistryLeaseFixture(
              mode,
              'welcome',
              0,
              context ? port : undefined,
            )
            fixtures.push(fixture)
            await fixture.drainMaintenance()
            const live = registryReceiveSlots.get(fixture.access())
            if (live === undefined) throw new Error('Missing receive slot')
            await fixture.access().receive([])
            registryMaintenanceGates.set(fixture.fixture().registry, async () => {
              observed.push(port.get())
            })
            await fixture.writeElsewhere('proposal')
            expect(live.base).toBeNull()
            await fixture.waitForReceiveRefresh()
            expect(await fixture.openEphemeral([])).toEqual([])
          }
          expect(observed).toHaveLength(2)
          expect(observed, 'refreshes must never inherit the first importer store').not.toContain(
            importingToken,
          )
        } finally {
          release.resolve()
          await importing
          await Promise.all(fixtures.map((fixture) => fixture.close()))
        }
      },
    )
  }
}
