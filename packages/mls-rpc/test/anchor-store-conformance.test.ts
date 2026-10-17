import type { AnchorStore } from '@kumiai/rpc'
import { testAnchorStoreConformance } from '@kumiai/rpc-conformance'

import {
  createIncarnationStores,
  createMemoryGroupPersistence,
  createMemoryTransaction,
  createOwnerQueues,
} from '../src/testing.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
import { installSeed, makeStorageSeed, nextChange } from './fixtures/storage-seed.js'

function createAnchorStore(registry: boolean): AnchorStore {
  const key = { groupID: 'anchor-conformance', incarnation: 1 }
  const db = createMemoryTransaction({ rows: {} })
  const atRest = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(97) })
  const groups = createMemoryGroupPersistence({
    db,
    owners: createOwnerQueues(),
    atRest,
    providerID: 'anchor-conformance',
  })
  const ready = makeStorageSeed({ id: key.groupID, incarnation: 1, epoch: 9, mode: 'double' }).then(
    (seed) => installSeed(groups, seed, 'seed'),
  )
  async function withAnchor<TValue>(
    work: (anchor: AnchorStore) => Promise<TValue>,
  ): Promise<TValue> {
    await ready
    if (registry) {
      return groups.transition(
        await nextChange(groups, key.groupID, crypto.randomUUID()),
        (stores) => {
          const target = stores.incarnation(1)
          return work(target.anchor)
        },
      )
    }
    return db.transact({ groupID: key.groupID, devicePackages: false }, (tx) => {
      return work(createIncarnationStores({ tx, key, atRest }).anchor)
    })
  }
  return {
    load: () => withAnchor((anchor) => anchor.load()),
    save: (slot) => withAnchor((anchor) => anchor.save(slot)),
  }
}

testAnchorStoreConformance({
  label: 'mls-rpc memory incarnation anchor namespace',
  createStore: () => createAnchorStore(false),
})

testAnchorStoreConformance({
  label: 'mls-rpc registry anchor rows',
  createStore: () => createAnchorStore(true),
})
