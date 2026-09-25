import { encodeClientState } from '@kumiai/mls'
import { type AppFrameRef, AppFrameStorageError } from '@kumiai/rpc'
import { describe, expect, test } from 'vitest'

import { simpleHandleAccess } from '../src/access.js'
import { createGroupCrypto } from '../src/crypto.js'
import { createRealGroup, type RealGroup } from './fixtures/real-group.js'
import {
  createTransactionalAccess,
  createTransactionalStore,
  RevisionConflictError,
} from './fixtures/transactional-access.js'

const utf8 = new TextEncoder()
const aad = utf8.encode('topic')

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function failureOf(work: () => unknown): Promise<unknown> {
  try {
    await work()
  } catch (error) {
    return error
  }
  throw new Error('expected a failure')
}

function frameRef(id: string): AppFrameRef {
  return { id, topicID: 'topic', protocol: 'chat', segment: 1, position: '000000000001' }
}

async function setup(name: string) {
  const group: RealGroup = await createRealGroup(1, name)
  const receiver = group.members[0]
  if (receiver == null) throw new Error('missing receiver')
  const store = createTransactionalStore(receiver.handle)
  const host = await createTransactionalAccess(receiver, store)
  const crypto = createGroupCrypto({ access: host.access, pending: host.pending })
  const sender = createGroupCrypto({
    access: simpleHandleAccess({ handle: () => group.committer.handle, adopt: () => {} }),
  })
  const seal = async (text: string) => await sender.wrap(utf8.encode(text), { aad })
  return { group, store, host, crypto, seal }
}

describe('transactional access: atomic durable open', () => {
  test('the working handle is published only after the write commits, and the lock is free meanwhile', async () => {
    const { store, host, crypto, seal } = await setup('tx-publish-on-commit')
    const sealed = await seal('hello')
    const before = host.live()
    const entered = deferred()
    const release = deferred()
    store.beforeWrite = async () => {
      entered.resolve()
      await release.promise
    }

    const opening = crypto.unwrap(sealed, { expectedAAD: aad, frame: frameRef('f1') })
    await entered.promise
    // The write is pending: a read takes the lock and sees the handle from before the open.
    expect(await host.access.read((handle) => handle)).toBe(before)
    expect(store.records.size).toBe(0)
    release.resolve()

    const opened = await opening
    expect(new TextDecoder().decode(opened.payload)).toBe('hello')
    expect(store.records.has('f1')).toBe(true)
    expect(store.snapshot().revision).toBe(1)
    expect(host.live()).not.toBe(before)
  })

  test('a revision conflict retries from a fresh handle and consumes the key once', async () => {
    const { store, crypto, seal } = await setup('tx-conflict')
    const sealed = await seal('hello')
    let writes = 0
    store.beforeWrite = () => {
      writes += 1
      if (writes === 1) store.bump()
    }

    await expect(
      crypto.unwrap(sealed, { expectedAAD: aad, frame: frameRef('f1') }),
    ).resolves.toMatchObject({ senderDID: expect.any(String) })
    expect(writes).toBe(2)
    expect([...store.records.keys()]).toEqual(['f1'])
    expect(store.snapshot().revision).toBe(2)
    await expect(
      crypto.unwrap(sealed, { expectedAAD: aad, frame: frameRef('f1') }),
    ).rejects.not.toBeInstanceOf(AppFrameStorageError)
    expect(store.records.size).toBe(1)
  })

  test('a failed write keeps the key, the row and the live handle', async () => {
    const { store, host, crypto, seal } = await setup('tx-storage-failure')
    const sealed = await seal('hello')
    const before = { live: host.live(), row: store.snapshot() }
    store.beforeWrite = () => {
      throw new Error('disk failed')
    }

    const failure = await failureOf(() =>
      crypto.unwrap(sealed, { expectedAAD: aad, frame: frameRef('f1') }),
    )
    expect(failure).toBeInstanceOf(AppFrameStorageError)
    expect((failure as Error).cause).toMatchObject({ message: 'disk failed' })
    expect(host.live()).toBe(before.live)
    expect(store.snapshot()).toBe(before.row)
    expect(store.records.size).toBe(0)

    store.beforeWrite = undefined
    await expect(
      crypto.unwrap(sealed, { expectedAAD: aad, frame: frameRef('f1') }),
    ).resolves.toMatchObject({ payload: utf8.encode('hello') })
    expect(store.records.size).toBe(1)
  })

  test('a stale same-epoch save after an open is rejected', async () => {
    const { store, host, crypto, seal } = await setup('tx-stale-save')
    const stale = store.snapshot()
    await crypto.unwrap(await seal('hello'), { expectedAAD: aad, frame: frameRef('f1') })
    const opened = store.snapshot()
    expect(Number(host.live().epoch)).toBe(host.access.epoch())

    await expect(store.save(stale.revision, stale.state, stale.ledger)).rejects.toBeInstanceOf(
      RevisionConflictError,
    )
    expect(store.snapshot()).toBe(opened)
  })

  test('an earlier save is ordered ahead of the open', async () => {
    const { store, crypto, seal } = await setup('tx-save-order')
    const sealed = await seal('hello')
    const row = store.snapshot()
    const hold = deferred()
    let holding = true
    store.beforeWrite = async () => {
      if (!holding) return
      holding = false
      await hold.promise
    }
    // Issued first and delayed: the open's write queues behind it and must retry past it.
    const earlier = store.save(row.revision, row.state, row.ledger)
    const opening = crypto.unwrap(sealed, { expectedAAD: aad, frame: frameRef('f1') })
    hold.resolve()
    await earlier
    await opening
    expect(store.snapshot().revision).toBe(2)
    expect(store.records.size).toBe(1)
  })

  test('a rolled-back mutation publishes nothing', async () => {
    const { store, host } = await setup('tx-rollback')
    const before = { live: host.live(), row: store.snapshot() }
    await expect(
      host.access.mutate(async (handle) => {
        await handle.encrypt(utf8.encode('spent'))
        throw new Error('transaction rolled back')
      }),
    ).rejects.toThrow('transaction rolled back')
    expect(host.live()).toBe(before.live)
    expect(store.snapshot()).toBe(before.row)
  })

  test('a duplicate frame ID keeps its first record and consumes the key once', async () => {
    const { store, crypto, seal } = await setup('tx-duplicate')
    const earlier = {
      frame: frameRef('f1'),
      payload: utf8.encode('first'),
      senderDID: 'did:example:first',
    }
    store.records.set('f1', earlier)
    const sealed = await seal('hello')

    await crypto.unwrap(sealed, { expectedAAD: aad, frame: frameRef('f1') })
    expect(store.records.get('f1')).toBe(earlier)
    const revision = store.snapshot().revision
    await expect(
      crypto.unwrap(sealed, { expectedAAD: aad, frame: frameRef('f1') }),
    ).rejects.not.toBeInstanceOf(AppFrameStorageError)
    expect(store.snapshot().revision).toBe(revision)
  })

  test('wrong AAD and unopenable bytes keep their own errors and write nothing', async () => {
    const { store, crypto, seal } = await setup('tx-open-errors')
    const sealed = await seal('hello')
    for (const [bytes, expectedAAD] of [
      [sealed, utf8.encode('other topic')],
      [new Uint8Array([0, 1, 2]), aad],
    ] as const) {
      const failure = await failureOf(() =>
        crypto.unwrap(bytes, { expectedAAD, frame: frameRef('f1') }),
      )
      expect(failure).toBeInstanceOf(Error)
      expect(failure).not.toBeInstanceOf(AppFrameStorageError)
    }
    expect(store.snapshot().revision).toBe(0)
    expect(store.records.size).toBe(0)
  })

  test('pending list and complete do not wait on the handle lock', async () => {
    const { host, crypto } = await setup('tx-pending-outside')
    const hold = deferred()
    const entered = deferred()
    const holding = host.access.read(async () => {
      entered.resolve()
      await hold.promise
    })
    await entered.promise
    await expect(crypto.pending?.list()).resolves.toEqual([])
    await expect(crypto.pending?.complete('none')).resolves.toBeUndefined()
    hold.resolve()
    await holding
  })

  test('the stored state is the state the live handle publishes', async () => {
    const { store, host, crypto, seal } = await setup('tx-stored-state')
    await crypto.unwrap(await seal('hello'), { expectedAAD: aad, frame: frameRef('f1') })
    expect(store.snapshot().state).toEqual(encodeClientState(host.live().state))
  })
})
