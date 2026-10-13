import type { ControlStore } from '@kumiai/rpc'
import { testControlSafetyInputConformance } from '@kumiai/rpc-conformance'
import { afterEach, describe } from 'vitest'

import { createStorageFixture } from './fixtures/storage-persistence.js'
import { nextChange } from './fixtures/storage-seed.js'

for (const mode of ['real-mls', 'double'] as const) {
  for (const boundary of ['ports', 'incarnation'] as const) {
    describe(`${boundary} control safety inputs -- ${mode}`, () => {
      let fixture: Awaited<ReturnType<typeof createStorageFixture>> | undefined
      const key = { groupID: 'group-A', incarnation: 1 }
      const control = (ports: NonNullable<typeof fixture>['ports']): ControlStore => {
        const groups = ports.device.groups
        const store = groups.ports(key).control
        if (boundary === 'ports') return store
        return {
          key,
          load: store.load,
          lastMutation: store.lastMutation,
          async apply(changes, mutationID) {
            await groups.transition(
              await nextChange(groups, key.groupID, mutationID),
              async (stores) => {
                await stores.incarnation(key.incarnation).control.apply(changes, mutationID)
              },
            )
          },
        }
      }
      afterEach(async () => {
        await fixture?.close()
        fixture = undefined
      })
      testControlSafetyInputConformance({
        open: async () => {
          fixture = await createStorageFixture({ id: key.groupID, mode })
          return control(fixture.ports)
        },
        reopen: async () => {
          if (fixture === undefined) throw new Error('Missing fixture')
          return control(await fixture.reopen())
        },
      })
    })
  }
}
