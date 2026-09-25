import { decodeClientState, encodeClientState, restoreGroup } from '@kumiai/mls'
import type { PendingAppFrame } from '@kumiai/rpc'
import { describe, expect, test } from 'vitest'

import { simpleHandleAccess } from '../src/access.js'
import { createGroupCrypto } from '../src/crypto.js'
import { createRealGroup } from './fixtures/real-group.js'

const utf8 = new TextEncoder()

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('real MLS durable host save ordering', () => {
  test('a delayed pre-open save finishes before the atomic open, and a stale same-epoch save cannot replace it', async () => {
    const group = await createRealGroup(1, 'real-port-save-order')
    const receiver = group.members[0]
    if (receiver == null) throw new Error('missing receiver')
    const before = encodeClientState(receiver.handle.state)
    const records = new Map<string, PendingAppFrame>()
    let savedState = before
    let savedVersion = 0
    const order: Array<string> = []
    const gate = deferred()
    const entered = deferred()
    const persistEntered = deferred()
    let tail = Promise.resolve()
    const serialized = async <T>(work: () => Promise<T>): Promise<T> => {
      const previous = tail
      const next = deferred()
      tail = next.promise
      await previous
      try {
        return await work()
      } finally {
        next.resolve()
      }
    }
    const saveHandle = async (state: Uint8Array, version: number, wait?: Promise<void>) => {
      return serialized(async () => {
        entered.resolve()
        await wait
        if (version <= savedVersion) return false
        savedState = state.slice()
        savedVersion = version
        order.push('earlier')
        return true
      })
    }
    const pending = {
      persistOpened: async (state: Uint8Array, record: PendingAppFrame) => {
        persistEntered.resolve()
        await serialized(async () => {
          savedState = state.slice()
          savedVersion = 2
          records.set(record.frame.id, record)
          order.push('opened')
        })
      },
      list: async () => [...records.values()],
      complete: async (id: string) => {
        records.delete(id)
      },
    }
    const sender = createGroupCrypto({
      access: simpleHandleAccess({ handle: () => group.committer.handle, adopt: () => {} }),
    })
    const receiverPort = createGroupCrypto({
      access: simpleHandleAccess({ handle: () => receiver.handle, adopt: () => {} }),
      pending,
    })
    const aad = utf8.encode('topic')
    const sealed = await sender.wrap(utf8.encode('hello'), { aad })
    const frame = {
      id: 'real-port-frame',
      topicID: 'topic',
      protocol: 'chat',
      segment: Number(receiver.handle.epoch),
      position: '1',
    }

    const earlierSave = saveHandle(before, 1, gate.promise)
    await entered.promise
    const opening = receiverPort.unwrap(sealed, { expectedAAD: aad, frame })
    await persistEntered.promise
    expect(records.size).toBe(0)
    gate.resolve()
    await earlierSave
    await expect(opening).resolves.toMatchObject({
      payload: utf8.encode('hello'),
      senderDID: group.committer.identity.id,
    })
    expect(order).toEqual(['earlier', 'opened'])
    expect(savedVersion).toBe(2)
    expect(savedState).toEqual(encodeClientState(receiver.handle.state))
    expect(await pending.list()).toHaveLength(1)

    expect(await saveHandle(before, 1)).toBe(false)
    expect(savedState).toEqual(encodeClientState(receiver.handle.state))
    const restoredState = decodeClientState(savedState)
    if (restoredState == null) throw new Error('invalid saved state')
    const restored = await restoreGroup({
      state: restoredState,
      credential: receiver.handle.credential,
    })
    await expect(restored.decrypt(sealed, { expectedAAD: aad })).rejects.toThrow()
    expect(await pending.list()).toHaveLength(1)
  })
})
