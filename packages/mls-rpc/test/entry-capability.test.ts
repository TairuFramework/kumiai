import { expect, test } from 'vitest'

import { coordinatorBinding, type EntryReads, entryCapability } from '../src/entry-capability.js'
import { createMemoryDevicePersistence } from '../src/memory-device-persistence.js'
import { createMemoryGroupPersistence } from '../src/memory-group-persistence.js'
import { createMemoryPrepareTransaction } from '../src/memory-group-state.js'
import { createOwnerQueues } from '../src/owner-queue.js'
import { GroupStateConflictError } from '../src/persistence-errors.js'
import type { MemoryStoreRows } from '../src/persistence-types.js'
import { createMemoryTransaction } from '../src/testing.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
import { installSeed, makeStorageSeed } from './fixtures/storage-seed.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function setup(rows: MemoryStoreRows = {}) {
  const owners = createOwnerQueues()
  const db = createMemoryTransaction({ rows })
  const codec = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(98) })
  let open: typeof codec.open = (...args) => codec.open(...args)
  const atRest = {
    seal: codec.seal,
    open: (...args: Parameters<typeof codec.open>) => open(...args),
  }
  const params = { db, owners, atRest, providerID: 'entry-provider' }
  const groups = createMemoryGroupPersistence(params)
  await installSeed(
    groups,
    await makeStorageSeed({ id: 'entry-group', incarnation: 1, epoch: 3, mode: 'double' }),
    'seed',
  )
  const capability = entryCapability(groups)
  if (capability === null) throw new Error('Missing entry capability')
  return {
    ...params,
    groups,
    capability,
    codec,
    setOpen(fn: typeof open) {
      open = fn
    },
  }
}

test('unrelated host rows cannot block prepare reads or runs', async () => {
  const fixture = await setup({ host: new Map([['unrelated', new Date(0)]]) })
  expect(await fixture.groups.load('review-group')).toBeNull()
  await fixture.capability.read('review-group', async (reads) => {
    const entry = fixture.owners.current()
    if (entry === undefined) throw new Error('Missing prepare entry')
    const tx = createMemoryPrepareTransaction({
      ...fixture,
      entry,
      groupID: 'review-group',
      rows: fixture.db.snapshot(),
    })
    expect(tx.rows.host).toBeUndefined()
    expect(tx.rows.state?.size).toBe(0)
    expect(await reads.lifetime()).toBeNull()
  })
  expect(
    await fixture.capability.run(
      { groupID: 'entry-group', mutationID: 'host-row' },
      async (reads) => {
        const life = await reads.lifetime()
        expect(life).toMatchObject({ revision: 1, activeIncarnation: 1 })
        return { expected: { revision: 1, activeIncarnation: 1 }, value: 'prepared' }
      },
      async (_stores, value) => value,
    ),
  ).toBe('prepared')
  expect(fixture.db.snapshot().host?.get('unrelated')).toEqual(new Date(0))
})

test.each([
  'orphan-invalid-key',
  'null',
  '["entry-group"]',
  '["entry-group",0,"current"]',
  '["entry-group",1,2]',
])('malformed orphan address %s cannot block prepare reads or diagnostics', async (key) => {
  const fixture = await setup({ state: new Map([[key, new Uint8Array([1])]]) })
  expect(await fixture.groups.load('review-group')).toBeNull()
  await fixture.capability.read('entry-group', async (reads) => {
    const entry = fixture.owners.current()
    if (entry === undefined) throw new Error('Missing prepare entry')
    const tx = createMemoryPrepareTransaction({
      ...fixture,
      entry,
      groupID: 'entry-group',
      rows: fixture.db.snapshot(),
    })
    expect(tx.rows.state?.has(key)).toBe(false)
    expect(await reads.lifetime()).toMatchObject({ revision: 1, activeIncarnation: 1 })
    expect(await reads.metadata(1)).toMatchObject({ version: 1, deleted: false })
    expect(await reads.state(1)).toMatchObject({ groupID: 'entry-group', incarnation: 1 })
    expect(await reads.diagnoseState(1)).toBe('readable')
  })
  await fixture.capability.read('review-group', async (reads) => {
    expect(await reads.lifetime()).toBeNull()
    expect(await reads.diagnoseState(1)).toBe('missing')
  })
})

test('prepare has real committed reads', async () => {
  const fixture = await setup()
  const opened = deferred()
  const release = deferred()
  let transactions = 0
  let working = false
  const transact = fixture.db.transact
  fixture.db.transact = (...args) => {
    transactions++
    return transact(...args)
  }
  fixture.setOpen(async (...args) => {
    expect(fixture.owners.current()?.phase).toBe('prepare')
    opened.resolve()
    await release.promise
    return fixture.codec.open(...args)
  })
  const result = fixture.capability.run(
    { groupID: 'entry-group', mutationID: 'prepared' },
    async (reads) => {
      const life = await reads.lifetime()
      expect(life?.revision).toBe(1)
      return { expected: { revision: 1, activeIncarnation: 1 }, value: 'prepared-value' }
    },
    async (_stores, value) => {
      working = true
      return value
    },
  )
  try {
    await opened.promise
    expect(transactions).toBe(0)
    expect(working).toBe(false)
    fixture.setOpen((...args) => fixture.codec.open(...args))
    release.resolve()
    expect(await result).toBe('prepared-value')
    expect(transactions).toBe(1)
    expect(working).toBe(true)
  } finally {
    release.resolve()
  }
})

test('closing prepare drains admitted reads before work', async () => {
  const fixture = await setup()
  const opened = deferred()
  const release = deferred()
  let pending!: Promise<unknown>
  let late!: EntryReads
  let working = false
  fixture.setOpen(async (...args) => {
    opened.resolve()
    await release.promise
    return fixture.codec.open(...args)
  })
  const result = fixture.capability.run(
    { groupID: 'entry-group', mutationID: 'drain' },
    async (reads) => {
      late = reads
      pending = reads.trust()
      void pending.catch(() => undefined)
      return { expected: { revision: 1, activeIncarnation: 1 }, value: null }
    },
    async () => {
      working = true
    },
  )
  try {
    await opened.promise
    await expect(late.lifetime()).rejects.toMatchObject({ name: 'PersistencePhaseError' })
    expect(working).toBe(false)
    fixture.setOpen((...args) => fixture.codec.open(...args))
    release.resolve()
    await result
    expect(await pending).toMatchObject({ groupID: 'entry-group' })
    expect(working).toBe(true)
  } finally {
    release.resolve()
  }
})

test('revoked delayed opens publish nothing after rejected prepare', async () => {
  const fixture = await setup()
  const opened = deferred()
  const release = deferred()
  let published = false
  let pending!: Promise<unknown>
  fixture.setOpen(async (...args) => {
    opened.resolve()
    await release.promise
    return fixture.codec.open(...args)
  })
  await expect(
    fixture.capability.read('entry-group', async (reads) => {
      pending = reads.state(1).then(() => {
        published = true
      })
      void pending.catch(() => undefined)
      await opened.promise
      throw new Error('cancel prepare')
    }),
  ).rejects.toThrow('cancel prepare')
  await expect(pending).rejects.toMatchObject({ name: 'PersistencePhaseError' })
  fixture.setOpen((...args) => fixture.codec.open(...args))
  expect(await fixture.capability.read('entry-group', (reads) => reads.lifetime())).toMatchObject({
    revision: 1,
  })
  release.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  expect(published).toBe(false)
})

test('fail-stop revokes suspended prepare reads', async () => {
  const fixture = await setup()
  const opened = deferred()
  const release = deferred()
  let published = false
  fixture.setOpen(async (...args) => {
    opened.resolve()
    await release.promise
    return fixture.codec.open(...args)
  })
  const result = fixture.capability.read('entry-group', async (reads) => {
    await reads.state(1)
    published = true
  })
  const refusal = expect(result).rejects.toBeInstanceOf(GroupStateConflictError)
  await opened.promise
  fixture.owners.failStop(new GroupStateConflictError('conflicting marker'))
  await refusal
  release.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  expect(published).toBe(false)
})

test('capability missing on copied persistence; separate wrappers share coordinator binding', async () => {
  const fixture = await setup()
  const separate = createMemoryGroupPersistence(fixture)
  const device = createMemoryDevicePersistence({ ...fixture, ownerDID: 'entry-owner' })
  expect(coordinatorBinding(fixture.groups)).not.toBeNull()
  expect(coordinatorBinding(separate)).toBe(coordinatorBinding(fixture.groups))
  expect(coordinatorBinding(device.groups)).toBe(coordinatorBinding(fixture.groups))
  expect(entryCapability(separate)).not.toBeNull()
  expect(entryCapability({ ...fixture.groups })).toBeNull()
  expect(coordinatorBinding({ ...fixture.groups })).toBeNull()
})
