import { AsyncLocalStorage } from 'node:async_hooks'
import { encodeEventFrame } from '@kumiai/broadcast'
import { describe, expect, test, vi } from 'vitest'

import type { PendingAppFrame } from '../src/crypto.js'
import { createHostBoundary, wrapPeerHost } from '../src/host-boundary.js'
import { createOpenedAppHandler, OpenedDeliveryReentryError } from '../src/opened-delivery.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { makeMLSPeer } from './fixtures/peer.js'

const protocols = {
  chat: {
    posted: {
      type: 'event',
      retain: 'log',
      data: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  },
} as const
const record: PendingAppFrame = {
  frame: { id: 'saved-frame', protocol: 'chat', topicID: 'old-topic', segment: 4, position: 'Z' },
  payload: encodeEventFrame('posted', { text: 'original' }),
  senderDID: 'alice',
}
function observe(promise: Promise<void>) {
  let state = 'pending'
  void promise.then(
    () => {
      state = 'resolved'
    },
    () => {
      state = 'rejected'
    },
  )
  return () => state
}

describe('opened delivery', () => {
  test('stored delivery reuses validation and authenticated sender policy', async () => {
    const handler = vi.fn()
    const deliver = createOpenedAppHandler({
      localDID: 'bob',
      protocols,
      handlers: { chat: { posted: handler } },
    })
    await deliver(record)
    expect(handler).toHaveBeenCalledWith({
      data: { text: 'original' },
      message: { payload: { iss: 'alice' } },
      frame: record.frame,
    })
    await deliver({ ...record, senderDID: 'bob' })
    await deliver({ ...record, payload: encodeEventFrame('posted', { text: 42 }) })
    expect(handler).toHaveBeenCalledTimes(1)
    await expect(
      deliver({ ...record, frame: { ...record.frame, protocol: 'unknown' } }),
    ).rejects.toThrow()
    await expect(
      deliver({ ...record, payload: encodeEventFrame('unknown', { text: 'original' }) }),
    ).rejects.toThrow()
  })

  test('handler mutation cannot change the saved frame identity', async () => {
    const saved = { ...record, frame: { ...record.frame } }
    const deliver = createOpenedAppHandler({
      localDID: 'bob',
      protocols,
      handlers: {
        chat: {
          posted: (context) => {
            if (context.frame !== undefined) context.frame.id = 'changed-by-handler'
          },
        },
      },
    })
    await deliver(saved)
    expect(saved.frame.id).toBe('saved-frame')
  })

  test('delivery context remains usable after the public host boundary closes', async () => {
    const storage = new AsyncLocalStorage<object>()
    const context = {
      run: <T>(token: object, fn: () => T): T => storage.run(token, fn),
      get: () => storage.getStore(),
    }
    const boundary = createHostBoundary()
    const host = wrapPeerHost(boundary, { openedDeliveryContext: context })
    boundary.close()
    const token = {}
    await expect(
      Promise.resolve().then(() =>
        host.openedDeliveryContext.run(token, async () => {
          await Promise.resolve()
          expect(host.openedDeliveryContext.get()).toBe(token)
        }),
      ),
    ).resolves.toBeUndefined()
  })

  test('unknown inherited procedures cannot complete opened records', async () => {
    const deliver = createOpenedAppHandler({
      localDID: 'bob',
      protocols,
      handlers: { chat: { posted: () => {} } },
    })
    await expect(
      deliver({ ...record, payload: encodeEventFrame('toString', {}) }),
    ).rejects.toThrow()
  })

  test('durable peers require an async opened delivery context', () => {
    const crypto = createFakeCrypto({ epoch: 1, localDID: 'bob' })
    crypto.pending = { list: async () => [], complete: async () => {} }
    expect(() =>
      makeMLSPeer(new FakeHub(), 'bob', new Uint8Array(32).fill(88), {
        crypto,
        openedDeliveryContext: undefined,
      }),
    ).toThrow(TypeError)
  })

  test('disposal does not release an opened drain waiter', async () => {
    const handler = Promise.withResolvers<void>()
    const completion = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const completing = Promise.withResolvers<void>()
    const crypto = createFakeCrypto({ epoch: 1, localDID: 'bob' })
    const complete = vi.fn(async () => {
      completing.resolve()
      await completion.promise
    })
    crypto.pending = {
      list: async () => [
        { ...record, payload: encodeEventFrame('chat/posted', { text: 'original' }) },
      ],
      complete,
    }
    const peer = makeMLSPeer(new FakeHub(), 'bob', new Uint8Array(32).fill(88), {
      crypto,
      handlers: {
        'chat/posted': async () => {
          entered.resolve()
          await handler.promise
        },
      },
    }).peer
    await entered.promise
    const drain = peer.drainOpened()
    const state = observe(drain)
    await peer.dispose()
    const drained = peer.drained()
    const drainedState = observe(drained)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(state()).toBe('pending')
    expect(drainedState()).toBe('pending')
    handler.resolve()
    await completing.promise
    expect(state()).toBe('pending')
    expect(drainedState()).toBe('pending')
    completion.resolve()
    await drain
    await drained
    expect(complete).toHaveBeenCalledOnce()
  })

  test('disposal stops callback admission during an opened drain', async () => {
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const completing = Promise.withResolvers<void>()
    const completion = Promise.withResolvers<void>()
    const crypto = createFakeCrypto({ epoch: 1, localDID: 'bob' })
    const pending = ['first', 'second'].map((id, index) => ({
      ...record,
      frame: { ...record.frame, id, position: String(index + 1) },
      payload: encodeEventFrame('chat/posted', { text: id }),
    }))
    crypto.pending = {
      list: async () => [...pending],
      complete: async (id) => {
        completing.resolve()
        await completion.promise
        const index = pending.findIndex((record) => record.frame.id === id)
        if (index !== -1) pending.splice(index, 1)
      },
    }
    const seen: Array<string> = []
    const peer = makeMLSPeer(new FakeHub(), 'bob', new Uint8Array(32).fill(88), {
      crypto,
      handlers: {
        'chat/posted': async ({ frame }: { frame?: PendingAppFrame['frame'] }) => {
          seen.push(frame?.id ?? 'missing')
          entered.resolve()
          await (frame?.id === 'first' ? first.promise : second.promise)
        },
      },
    }).peer
    await entered.promise
    const drainState = observe(peer.drainOpened())
    await peer.dispose()
    const drained = peer.drained()
    const drainedState = observe(drained)
    try {
      first.resolve()
      await completing.promise
      expect(drainState()).toBe('pending')
      expect(drainedState()).toBe('pending')
      completion.resolve()
      await vi.waitFor(() => expect(pending[0]?.frame.id).toBe('second'))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(seen).toEqual(['first'])
      expect(pending.map((record) => record.frame.id)).toEqual(['second'])
      expect(drainState()).toBe('pending')
      await drained
    } finally {
      first.resolve()
      second.resolve()
      completion.resolve()
      await peer.dispose()
      await drained
    }
  })

  test.each(['drainOpened', 'dispose', 'drained'] as const)(
    'handler cannot await its own peer %s after an await',
    async (method) => {
      const crypto = createFakeCrypto({ epoch: 1, localDID: 'bob' })
      let pending = true
      crypto.pending = {
        list: async () =>
          pending
            ? [{ ...record, payload: encodeEventFrame('chat/posted', { text: 'original' }) }]
            : [],
        complete: async () => {
          pending = false
        },
      }
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let result: unknown
      const peer = makeMLSPeer(new FakeHub(), 'bob', new Uint8Array(32).fill(88), {
        crypto,
        handlers: {
          'chat/posted': async () => {
            await release.promise
            void peer[method]().catch((error: unknown) => {
              result = error
            })
            await new Promise((resolve) => setTimeout(resolve, 10))
            entered.resolve()
          },
        },
      }).peer
      release.resolve()
      await entered.promise
      expect(result).toBeInstanceOf(OpenedDeliveryReentryError)
      await peer.drainOpened()
      expect(pending).toBe(false)
      await peer.dispose()
      await peer.drained()
    },
  )
})
