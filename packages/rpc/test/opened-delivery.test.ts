import { AsyncLocalStorage } from 'node:async_hooks'
import { encodeEventFrame } from '@kumiai/broadcast'
import { EventEmitter } from '@sozai/event'
import { describe, expect, test, vi } from 'vitest'

import type { PendingAppFrame } from '../src/crypto.js'
import type { GroupTransaction, HandlerCompletion } from '../src/handler-completion.js'
import { combineDurableHandlers } from '../src/handlers.js'
import { createHostBoundary, wrapPeerHost } from '../src/host-boundary.js'
import {
  assertOpenedDeliveryEntry,
  createOpenedAppHandler,
  normaliseOpenedAppHandler,
  OpenedDeliveryReentryError,
} from '../src/opened-delivery.js'
import {
  completeTestRecord,
  createFakeCrypto,
  createTestCompletion,
} from './fixtures/fake-crypto.js'
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
const record: PendingAppFrame = completeTestRecord(
  {
    frame: { id: 'saved-frame', protocol: 'chat', topicID: 'old-topic', segment: 4, position: 'Z' },
    payload: encodeEventFrame('posted', { text: 'original' }),
    senderDID: 'alice',
  },
  { groupID: 'group', incarnation: 1 },
  'posted',
  4,
)
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
      completion: { ...createTestCompletion(record.frame), complete: async () => {} },
      openedDeliveryContext: deliveryContext(),
      localDID: 'bob',
      protocols,
      handlers: { chat: { posted: handler } },
    })
    await deliver.deliver(record)
    expect(handler).toHaveBeenCalledWith({
      data: { text: 'original' },
      message: { payload: { iss: 'alice' } },
      frame: record.frame,
      epoch: record.epoch,
      incarnation: record.frame.incarnation,
      idempotencyKey: record.idempotencyKey,
    })
    await deliver.deliver({ ...record, senderDID: 'bob' })
    await deliver.deliver({ ...record, payload: encodeEventFrame('posted', { text: 42 }) })
    expect(handler).toHaveBeenCalledTimes(1)
    await expect(
      deliver.deliver({ ...record, frame: { ...record.frame, protocol: 'unknown' } }),
    ).rejects.toThrow()
    await expect(
      deliver.deliver({ ...record, payload: encodeEventFrame('unknown', { text: 'original' }) }),
    ).rejects.toThrow()
  })

  test('handler mutation cannot change the saved frame identity', async () => {
    const saved = { ...record, frame: { ...record.frame } }
    const deliver = createOpenedAppHandler({
      completion: { ...createTestCompletion(record.frame), complete: async () => {} },
      openedDeliveryContext: deliveryContext(),
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
    await deliver.deliver(saved)
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
      completion: { ...createTestCompletion(record.frame), complete: async () => {} },
      openedDeliveryContext: deliveryContext(),
      localDID: 'bob',
      protocols,
      handlers: { chat: { posted: () => {} } },
    })
    await expect(
      deliver.deliver({ ...record, payload: encodeEventFrame('toString', {}) }),
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
        {
          ...record,
          frame: { ...record.frame, groupID: 'memory-group', procedure: 'chat/posted' },
          payload: encodeEventFrame('chat/posted', { text: 'original' }),
        },
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
      frame: {
        ...record.frame,
        groupID: 'memory-group',
        procedure: 'chat/posted',
        id,
        position: String(index + 1),
      },
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
            ? [
                {
                  ...record,
                  frame: { ...record.frame, groupID: 'memory-group', procedure: 'chat/posted' },
                  payload: encodeEventFrame('chat/posted', { text: 'original' }),
                },
              ]
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

function deliveryContext() {
  const storage = new AsyncLocalStorage<object>()
  return {
    run: <T>(token: object, fn: () => T) => storage.run(token, fn),
    get: () => storage.getStore(),
  }
}
function policyFixture() {
  const openedDeliveryContext = deliveryContext()
  const ownership = new AsyncLocalStorage<object>()
  const tx: GroupTransaction = {
    providerID: 'test',
    groupID: record.frame.groupID,
    onCommit() {},
    onRollback() {},
  }
  let saved: PendingAppFrame | undefined = structuredClone(record)
  const complete = vi.fn(async (_ids: Array<string>) => {
    expect(openedDeliveryContext.get()).toBeUndefined()
    saved = undefined
  })
  const transact = vi.fn(
    async (
      _ids: Array<string>,
      handle: (tx: GroupTransaction, records: Array<PendingAppFrame>) => Promise<void>,
    ) => {
      expect(openedDeliveryContext.get()).toBeUndefined()
      if (saved === undefined) return
      await ownership.run(tx, () => handle(tx, [structuredClone(saved as PendingAppFrame)]))
      saved = undefined
    },
  )
  const completion: HandlerCompletion<GroupTransaction> = {
    key: { groupID: record.frame.groupID, incarnation: record.frame.incarnation },
    complete,
    transact,
  }
  return {
    localDID: 'bob',
    protocols,
    completion,
    openedDeliveryContext,
    ownership,
    tx,
    complete,
    transact,
    pending: () => saved,
  }
}

describe('opened completion policies', () => {
  test('legacy and omitted mode handlers complete after success outside ownership', async () => {
    for (const legacy of [true, false]) {
      const f = policyFixture()
      let fail = true
      const handle = vi.fn(async (context) => {
        expect(f.ownership.getStore()).toBeUndefined()
        expect(context).toMatchObject({
          frame: record.frame,
          idempotencyKey: record.idempotencyKey,
          epoch: 4,
          incarnation: 1,
        })
        expect(context).not.toHaveProperty('tx')
        if (fail) throw new Error('retry')
      })
      const opened = createOpenedAppHandler({
        ...f,
        handlers: { chat: { posted: legacy ? handle : { handle } } },
      })
      await expect(opened.deliver(record)).rejects.toThrow('retry')
      expect(f.pending()).toBeDefined()
      expect(f.complete).not.toHaveBeenCalled()
      fail = false
      await opened.deliver(record)
      expect(f.complete).toHaveBeenCalledExactlyOnceWith([record.frame.id])
      expect(f.transact).not.toHaveBeenCalled()
    }
  })
  test('transactional dispatch uses saved records and one supplied transaction', async () => {
    const f = policyFixture()
    const handle = vi.fn(async (context) => {
      expect(context.data).toEqual({ text: 'original' })
      expect(context.tx).toBe(f.tx)
      expect(f.ownership.getStore()).toBe(f.tx)
    })
    const policy = Object.defineProperty({ handle }, 'mode', { value: 'transactional' }) as {
      mode: 'transactional'
      handle: typeof handle
    }
    const opened = createOpenedAppHandler({
      ...f,
      handlers: { chat: { posted: policy } },
    })
    await opened.deliver({
      ...record,
      epoch: 99,
      payload: encodeEventFrame('posted', { text: 'forged' }),
    })
    await opened.deliver(record)
    expect(handle).toHaveBeenCalledOnce()
    expect(handle.mock.calls[0]?.[0]).toMatchObject({
      epoch: record.epoch,
      idempotencyKey: record.idempotencyKey,
    })
    expect(f.transact).toHaveBeenCalledTimes(2)
    expect(f.complete).not.toHaveBeenCalled()
  })
  test('standalone opened helper retains lifecycle context after await', async () => {
    for (const mode of ['at-least-once', 'transactional'] as const) {
      const f = policyFixture()
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const opened = createOpenedAppHandler({
        ...f,
        handlers: {
          chat: {
            posted: {
              mode,
              async handle() {
                await Promise.resolve()
                expect(() =>
                  assertOpenedDeliveryEntry(f.openedDeliveryContext, { key: f.completion.key }),
                ).toThrow(OpenedDeliveryReentryError)
                expect(() =>
                  assertOpenedDeliveryEntry(f.openedDeliveryContext, {
                    key: { groupID: 'independent', incarnation: 1 },
                  }),
                ).not.toThrow()
                entered.resolve()
                await release.promise
              },
            },
          },
        },
      })
      const delivering = opened.deliver(record)
      await Promise.race([entered.promise, delivering])
      expect(() =>
        assertOpenedDeliveryEntry(f.openedDeliveryContext, { key: f.completion.key }),
      ).not.toThrow()
      release.resolve()
      await delivering
      expect(() =>
        createOpenedAppHandler({
          ...f,
          openedDeliveryContext: undefined as never,
          handlers: { chat: { posted: async () => {} } },
        }),
      ).toThrow(TypeError)
    }
  })
  test('normalisation rejects mismatched binding before invocation', async () => {
    const f = policyFixture()
    const raw = vi.fn(async () => {
      expect(f.openedDeliveryContext.get()).toBeDefined()
    })
    const opened = normaliseOpenedAppHandler({ ...f, deliver: raw })
    expect(opened.completion).toBe(f.completion)
    expect(opened.openedDeliveryContext).toBe(f.openedDeliveryContext)
    expect(normaliseOpenedAppHandler({ ...f, deliver: opened })).toBe(opened)
    expect(() =>
      normaliseOpenedAppHandler({ ...f, deliver: opened, completion: { ...f.completion } }),
    ).toThrow()
    expect(() =>
      normaliseOpenedAppHandler({
        ...f,
        deliver: opened,
        openedDeliveryContext: deliveryContext(),
      }),
    ).toThrow()
    await expect(
      opened.deliver({ ...record, frame: { ...record.frame, incarnation: 2 } }),
    ).rejects.toThrow()
    await expect(opened.deliver({ ...record, epoch: undefined as never })).rejects.toThrow()
    await expect(
      opened.deliver({ ...record, idempotencyKey: undefined as never }),
    ).rejects.toThrow()
    expect(raw).not.toHaveBeenCalled()
    await opened.deliver(record)
    expect(raw).toHaveBeenCalledOnce()
    expect(f.complete).toHaveBeenCalledOnce()
  })
  test('handler failure isolates its lane', async () => {
    for (const mode of ['at-least-once', 'transactional'] as const) {
      const f = policyFixture()
      const seen: Array<string> = []
      let fail = true
      const handler = combineDurableHandlers([
        {
          mode,
          async handle() {
            seen.push('first')
          },
        },
        {
          mode,
          async handle() {
            seen.push('second')
            if (fail) throw new Error('A')
          },
        },
      ])
      const opened = createOpenedAppHandler({ ...f, handlers: { chat: { posted: handler } } })
      await expect(opened.deliver(record)).rejects.toThrow('A')
      expect(f.pending()).toBeDefined()
      expect(f.complete).not.toHaveBeenCalled()
      const other = policyFixture()
      await createOpenedAppHandler({
        ...other,
        handlers: { chat: { posted: async () => {} } },
      }).deliver(record)
      expect(other.complete).toHaveBeenCalledOnce()
      fail = false
      await opened.deliver(record)
      expect(seen).toEqual(['first', 'second', 'first', 'second'])
    }
  })
})

test('opened helper validates every protocol before installing listeners', () => {
  const f = policyFixture()
  const installed = vi.spyOn(EventEmitter.prototype, 'on')
  try {
    expect(() =>
      createOpenedAppHandler({
        ...f,
        protocols: { chat: protocols.chat, other: protocols.chat },
        handlers: {
          chat: { posted: async () => {} },
          other: { posted: { mode: 'invalid', handle: async () => {} } as never },
        },
      }),
    ).toThrow()
    expect(() =>
      createOpenedAppHandler({
        ...f,
        handlers: { chat: { posted: { mode: 'transactional' } as never } },
      }),
    ).toThrow()
    expect(installed).not.toHaveBeenCalled()
  } finally {
    installed.mockRestore()
  }
})
test('ignored opened records complete without invoking a durable callback', async () => {
  const f = policyFixture()
  const handle = vi.fn(async () => {})
  const opened = createOpenedAppHandler({ ...f, handlers: { chat: { posted: handle } } })
  await opened.deliver({ ...record, senderDID: f.localDID })
  expect(handle).not.toHaveBeenCalled()
  expect(f.complete).toHaveBeenCalledExactlyOnceWith([record.frame.id])
})

test('unknown protocol and missing handler retain pending', async () => {
  const f = policyFixture()
  const opened = createOpenedAppHandler({ ...f, handlers: { chat: {} as never } })
  await expect(opened.deliver(record)).rejects.toThrow('Missing opened handler')
  await expect(
    opened.deliver({ ...record, frame: { ...record.frame, protocol: 'unknown' } }),
  ).rejects.toThrow('Unknown opened protocol')
  expect(f.pending()).toBeDefined()
  expect(f.complete).not.toHaveBeenCalled()
  expect(f.transact).not.toHaveBeenCalled()
})

test('wrong retention ingress never enters a completion policy', async () => {
  const f = policyFixture()
  const handle = vi.fn(async () => {})
  const opened = createOpenedAppHandler({
    ...f,
    protocols: { chat: { posted: { type: 'event', retain: 'ephemeral' } } },
    handlers: { chat: { posted: handle } },
  })
  await expect(opened.deliver(record)).rejects.toThrow()
  const retained = createOpenedAppHandler({
    ...f,
    protocols: { chat: { ...protocols.chat, typing: { type: 'event', retain: 'ephemeral' } } },
    handlers: { chat: { posted: handle, typing: handle } },
  })
  await expect(
    retained.deliver({ ...record, payload: encodeEventFrame('typing', {}) }),
  ).rejects.toThrow()
  expect(handle).not.toHaveBeenCalled()
  expect(f.complete).not.toHaveBeenCalled()
  expect(f.transact).not.toHaveBeenCalled()
})
