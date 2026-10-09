import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { randomIdentity } from '@kokuin/token'
import { commitLedgerEntries, createGroup, decodeClientState, signLedgerEntry } from '@kumiai/mls'
import {
  createGroupCrypto,
  createGroupMLS,
  createLedgerEntrySlot,
  type HandleAccess,
  simpleHandleAccess,
} from '@kumiai/mls-rpc'
import type { AdoptionWrite } from '@kumiai/rpc'
import { expect, test } from 'vitest'

import { createMemoryStateStore } from './app-lane-e2e.js'

test('the migration example co-commits adoption bookkeeping and rolls back with MLS state', async () => {
  const identity = randomIdentity()
  const handle = (await createGroup(identity, 'migration-persistence')).group
  const store = createMemoryStateStore()
  await store.save(handle)
  const token = await signLedgerEntry(identity, {
    groupID: handle.groupID,
    type: 'note',
    subject: identity.id,
    value: 'atomic migration',
  })
  const next = (await commitLedgerEntries(handle, [token])).newGroup
  const doc = await readFile(
    new URL('../../../packages/mls-rpc/README.md', import.meta.url),
    'utf8',
  )
  const example = doc.split('Migrating from 0.9:')[1]?.match(/```ts\n([\s\S]*?)```/)?.[1]
  if (example == null) throw new Error('Missing migration example')
  const access = runInNewContext(`${example}\naccess`, {
    handle,
    adopt: () => {},
    // The old callback is assignable but drops the adoption write.
    persist: (current: typeof handle) => store.save(current),
    store,
    identity,
    entrySlot: createLedgerEntrySlot(),
    pending: undefined,
    simpleHandleAccess,
    createGroupCrypto,
    createGroupMLS,
  }) as HandleAccess
  const anchor = {
    anchor: { epoch: 0, secret: new Uint8Array(32).fill(1) },
    pending: {
      epochBefore: 0,
      epochAfter: 1,
      rosterBefore: [identity.id],
      forced: false,
      advance: 'migration-adoption',
    },
  }
  const anchorStore = store.database.anchorStore('state')
  await anchorStore.save(anchor)
  const write: AdoptionWrite = {
    mutationID: 'migration-save',
    anchorLanded: anchor.pending.advance,
    changes: { putOutcomes: [{ id: 'operation', opID: 'operation', at: 1, kind: 'unknown' }] },
  }
  store.database.failNext('mid-save')
  await expect(access.replace(next, () => write)).rejects.toThrow('Injected transaction failure')
  expect(
    decodeClientState((await store.saved())?.state ?? new Uint8Array())?.groupContext.epoch,
  ).toBe(0n)
  expect((await store.control.load()).outcomes).toEqual([])
  expect(await store.control.lastMutation()).toBeNull()
  expect(await anchorStore.load()).toEqual(anchor)
  await access.replace(next, () => write)
  expect(
    decodeClientState((await store.saved())?.state ?? new Uint8Array())?.groupContext.epoch,
  ).toBe(1n)
  expect((await store.control.load()).outcomes).toEqual(write.changes.putOutcomes)
  expect(await store.control.lastMutation()).toBe(write.mutationID)
  expect((await anchorStore.load())?.pending?.landed).toBe(true)
  expect(doc.replace(/\s+/g, ' ')).toMatch(
    /store.save.*root transaction.*MLS state.*ledger.*changes.*mutationID.*anchorLanded/,
  )
})
