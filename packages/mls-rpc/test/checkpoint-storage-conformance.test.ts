import { testCheckpointStorageConformance } from '@kumiai/rpc-conformance'
import { expect, test } from 'vitest'

import type { MemoryTransaction } from '../src/persistence-types.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createRealGroup } from './fixtures/real-group.js'
import { createStorageFixture, writeSideRow } from './fixtures/storage-persistence.js'
import { makeStorageSeed } from './fixtures/storage-seed.js'
import { createTransactionalStore } from './fixtures/transactional-access.js'

for (const mode of ['real-mls', 'double'] as const) {
  for (const context of ['supplied', 'absent'] as const) {
    testCheckpointStorageConformance<MemoryTransaction>({
      label: `${mode} / ownership context ${context}`,
      createFixture: (id, options) =>
        createStorageFixture({
          id,
          mode,
          ...options,
          ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        }),
      writeSideRow,
      async retire(fixture) {
        const groups = fixture.ports.device.groups
        const trust = await groups.loadTrust('group-A')
        if (trust === null) throw new Error('Missing trust')
        const next = await makeStorageSeed({ id: 'group-A', incarnation: 2, epoch: 1, mode })
        next.trust.genesisAnchor = trust.genesisAnchor
        next.trust.spentEpochAuthenticators.push(...trust.spentEpochAuthenticators)
        const life = await groups.load('group-A')
        if (life === null) throw new Error('Missing lifetime')
        await groups.transition(
          {
            groupID: 'group-A',
            mutationID: 'checkpoint-retirement',
            expected: { revision: life.revision, activeIncarnation: life.activeIncarnation },
          },
          async (stores) => {
            await stores.lifetime.save({
              ...next.lifetime,
              revision: life.revision + 1,
              mutationID: 'checkpoint-retirement',
            })
            await stores.incarnation(2).state.save(next.state)
            await stores.trust.save(next.trust)
          },
        )
      },
    })
  }
}

test('transactional access fixture preserves independent checkpoint copies across state saves and reopen', async () => {
  const real = await createRealGroup(0, 'transactional-checkpoints')
  const store = createTransactionalStore(real.committer.handle)
  const record = {
    kind: 'fact' as const,
    id: 'transactional-fact',
    key: { groupID: 'transactional-checkpoints', incarnation: 1 },
    epoch: 0,
    canonical: new Uint8Array([0, 128, 255]),
    supersededAt: null,
  }
  await store.checkpoints.put(record)
  record.canonical.fill(0)
  expect(await store.checkpoints.list()).toEqual([
    { ...record, canonical: new Uint8Array([0, 128, 255]) },
  ])
  const row = store.snapshot()
  await store.save(row.revision, row.state, row.ledger)
  const reopened = await store.fork()
  expect(await reopened.checkpoints.list()).toEqual(await store.checkpoints.list())
  const loaded = await reopened.checkpoints.load(record.id)
  if (loaded?.kind !== 'fact') throw new Error('Missing checkpoint fact')
  loaded.canonical.fill(9)
  expect(await reopened.checkpoints.list()).toEqual(await store.checkpoints.list())
  await expect(
    reopened.checkpoints.put({ ...record, key: { groupID: 'foreign', incarnation: 1 } }),
  ).rejects.toThrow('group')
  for (const incarnation of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(
      reopened.checkpoints.put({ ...record, key: { ...record.key, incarnation } }),
    ).rejects.toThrow('binding')
  }
  await reopened.checkpoints.remove([record.id])
  expect(await reopened.checkpoints.load(record.id)).toBeNull()
  expect(await store.checkpoints.load(record.id)).not.toBeNull()
})
