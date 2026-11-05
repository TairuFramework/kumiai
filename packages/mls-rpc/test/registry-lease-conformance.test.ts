import { testRegistryLeaseConformance } from '@kumiai/rpc-conformance'
import { expect, test, vi } from 'vitest'

import { entryCapability } from '../src/entry-capability.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createRegistryLeaseFixture } from './fixtures/registry-lease.js'

for (const mode of ['real-mls', 'double'] as const) {
  for (const ownership of ['supplied', 'absent'] as const) {
    test(`transaction probe includes read ownership entries (${mode}, ${ownership})`, async () => {
      const fixture = await createRegistryLeaseFixture(
        mode,
        'seed',
        0,
        ownership === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
      )
      try {
        const capability = entryCapability(fixture.fixture().device.groups)
        if (capability === null) throw new Error('Missing entry capability')
        const before = fixture.providerTransactions()
        expect(
          await capability.read(fixture.key.groupID, (reads) => reads.lifetime()),
        ).toMatchObject({ activeIncarnation: 1 })
        expect(fixture.providerTransactions() - before).toBe(1)
        const commands = vi.spyOn(capability, 'command')
        const warm = fixture.providerTransactions()
        await fixture.sealEphemeral()
        expect(commands).toHaveBeenCalledOnce()
        expect(fixture.providerTransactions()).toBe(warm)
      } finally {
        await fixture.close()
      }
    })
    testRegistryLeaseConformance({
      label: `${mode}, ${ownership} ownership context`,
      createFixture: (source, generation) =>
        createRegistryLeaseFixture(
          mode,
          source,
          generation,
          ownership === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        ),
    })
  }
}
