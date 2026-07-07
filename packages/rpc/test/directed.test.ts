import type { Client } from '@enkaku/client'
import type { ProtocolDefinition } from '@enkaku/protocol'
import type { ProcedureHandlers } from '@enkaku/server'
import type { Unwrap } from '@kumiai/broadcast'
import { describe, expect, test } from 'vitest'

import { createDirectedClient, createInboxAcceptor } from '../src/directed.js'
import { createHubMux } from '../src/hub-mux.js'
import { inboxTopic } from '../src/topic.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'

const SECRET = new Uint8Array(32).fill(3)
const EPOCH = 1

const protocol = {
  'rpc/double': { type: 'request', param: { type: 'object' }, result: { type: 'object' } },
} as const satisfies ProtocolDefinition

type Protocol = typeof protocol
type Handlers = ProcedureHandlers<Protocol>

function member(hub: FakeHub, localDID: string, handlers: Record<string, unknown>) {
  const crypto = createFakeCrypto({ localDID })
  const mux = createHubMux({ hub, localDID })
  const acceptor = createInboxAcceptor({
    mux,
    localDID,
    selfInboxTopic: inboxTopic(SECRET, EPOCH, localDID),
    resolveSendTopic: (senderDID) => inboxTopic(SECRET, EPOCH, senderDID),
    protocol,
    handlers: handlers as Handlers,
    wrap: crypto.wrap,
    unwrap: crypto.unwrap,
  })
  return { mux, acceptor }
}

describe('directed RPC', () => {
  test('a directed request reaches the target inbox server and returns its reply', async () => {
    const hub = new FakeHub()
    const bob = member(hub, 'bob', {
      'rpc/double': (ctx: { param: { n: number } }) => ({ n: ctx.param.n * 2 }),
    })
    const aliceCrypto = createFakeCrypto({ localDID: 'alice' })
    const aliceMux = createHubMux({ hub, localDID: 'alice' })
    const { client, dispose } = createDirectedClient<Protocol>({
      mux: aliceMux,
      localDID: 'alice',
      memberDID: 'bob',
      secret: SECRET,
      epoch: EPOCH,
      getRandomID: () => 'session-a-b',
      wrap: aliceCrypto.wrap,
      unwrap: aliceCrypto.unwrap,
    })

    const result = await client.request('rpc/double', { param: { n: 21 } })
    expect(result).toEqual({ n: 42 })

    await dispose()
    await aliceMux.dispose()
    await bob.acceptor.dispose()
    await bob.mux.dispose()
  })

  test('two callers to the same member are served independently', async () => {
    const hub = new FakeHub()
    const bob = member(hub, 'bob', {
      'rpc/double': (ctx: { param: { n: number } }) => ({ n: ctx.param.n * 2 }),
    })

    type CallerEntry = {
      mux: ReturnType<typeof createHubMux>
      client: Client<Protocol>
      dispose: () => Promise<void>
      n: number
    }
    const callers: Array<CallerEntry> = ['alice', 'carol'].map((localDID, i) => {
      const callerCrypto = createFakeCrypto({ localDID })
      const mux = createHubMux({ hub, localDID })
      const { client, dispose } = createDirectedClient<Protocol>({
        mux,
        localDID,
        memberDID: 'bob',
        secret: SECRET,
        epoch: EPOCH,
        getRandomID: () => `session-${localDID}`,
        wrap: callerCrypto.wrap,
        unwrap: callerCrypto.unwrap,
      })
      return { mux, client, dispose, n: (i + 1) * 10 }
    })

    const results = await Promise.all(
      callers.map((c) => c.client.request('rpc/double', { param: { n: c.n } })),
    )
    expect(results).toEqual([{ n: 20 }, { n: 40 }])

    for (const c of callers) {
      await c.dispose()
      await c.mux.dispose()
    }
    await bob.acceptor.dispose()
    await bob.mux.dispose()
  })
})

describe('directed RPC security', () => {
  const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms))

  test('the hub never sees directed request plaintext', async () => {
    const hub = new FakeHub()
    const bob = member(hub, 'bob', {
      'rpc/double': (ctx: { param: { n: number } }) => ({ n: ctx.param.n * 2 }),
    })
    const aliceCrypto = createFakeCrypto({ localDID: 'alice' })
    const aliceMux = createHubMux({ hub, localDID: 'alice' })
    const { client, dispose } = createDirectedClient<Protocol>({
      mux: aliceMux,
      localDID: 'alice',
      memberDID: 'bob',
      secret: SECRET,
      epoch: EPOCH,
      getRandomID: () => 'session-a-b',
      wrap: aliceCrypto.wrap,
      unwrap: aliceCrypto.unwrap,
    })

    const result = await client.request('rpc/double', { param: { n: 21 } })
    expect(result).toEqual({ n: 42 })

    // 42 and 21 must not appear as plaintext JSON on any published inbox frame.
    const onWire = hub.published.map((m) => new TextDecoder().decode(m.payload)).join('|')
    expect(onWire.includes('"n":21')).toBe(false)
    expect(onWire.includes('"n":42')).toBe(false)

    await dispose()
    await aliceMux.dispose()
    await bob.acceptor.dispose()
    await bob.mux.dispose()
  })

  test('a spliced frame from another sender is dropped, not served', async () => {
    const hub = new FakeHub()
    const calls: Array<number> = []
    const bob = member(hub, 'bob', {
      'rpc/double': (ctx: { param: { n: number } }) => {
        calls.push(ctx.param.n)
        return { n: ctx.param.n * 2 }
      },
    })
    const aliceCrypto = createFakeCrypto({ localDID: 'alice' })
    const aliceMux = createHubMux({ hub, localDID: 'alice' })
    const { client, dispose } = createDirectedClient<Protocol>({
      mux: aliceMux,
      localDID: 'alice',
      memberDID: 'bob',
      secret: SECRET,
      epoch: EPOCH,
      getRandomID: () => 'session-a-b',
      wrap: aliceCrypto.wrap,
      unwrap: aliceCrypto.unwrap,
    })
    await client.request('rpc/double', { param: { n: 1 } })
    expect(calls).toEqual([1])

    // Mallory forges a frame carrying alice's sessionID onto bob's inbox. It
    // unwraps to senderDID 'mallory' != the session's bound 'alice', so it is
    // dropped and never reaches the handler.
    const mallory = createFakeCrypto({ localDID: 'mallory' })
    const forgedFrame = JSON.stringify({
      v: 1,
      sessionID: 'session-a-b',
      seq: 99,
      kind: 'message',
      body: { header: {}, payload: { typ: 'request', rid: 'x', prc: 'rpc/double', prm: { n: 7 } } },
    })
    await hub.publish({
      // NOT 'bob': FakeHub excludes the publisher from its own topic's delivery,
      // so a self-published frame never reaches bob's drain. Model the hub
      // injecting the frame.
      senderDID: 'hub',
      topicID: inboxTopic(SECRET, EPOCH, 'bob'),
      payload: await mallory.wrap(new TextEncoder().encode(forgedFrame)),
    })
    await flush()
    expect(calls).toEqual([1]) // handler NOT invoked with n:7

    await dispose()
    await aliceMux.dispose()
    await bob.acceptor.dispose()
    await bob.mux.dispose()
  })

  test('an async unwrap with variable latency does not reorder inbound frames', async () => {
    const hub = new FakeHub()
    const calls: Array<number> = []
    const bobCrypto = createFakeCrypto({ localDID: 'bob' })
    const bobMux = createHubMux({ hub, localDID: 'bob' })

    // Real MLS decrypt has variable latency. Delay the *first* frame's unwrap
    // longer than the second's: if inbound processing were not serialized,
    // the second frame would win the race and dispatch before the first —
    // either double-creating a session for a still-unseen sessionID, or
    // feeding the established tunnel a frame out of wire order (dropped as
    // stale seq). Serializing onto a tail promise means the second frame's
    // unwrap cannot even *start* until the first has fully dispatched, so no
    // amount of latency skew can reorder them.
    let seen = 0
    const delayedUnwrap: Unwrap = async (bytes) => {
      const index = seen++
      const delayMs = index === 0 ? 20 : 2
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      return bobCrypto.unwrap(bytes)
    }

    const bobAcceptor = createInboxAcceptor({
      mux: bobMux,
      localDID: 'bob',
      selfInboxTopic: inboxTopic(SECRET, EPOCH, 'bob'),
      resolveSendTopic: (senderDID) => inboxTopic(SECRET, EPOCH, senderDID),
      protocol,
      handlers: {
        'rpc/double': (ctx: { param: { n: number } }) => {
          calls.push(ctx.param.n)
          return { n: ctx.param.n * 2 }
        },
      } as unknown as Handlers,
      wrap: bobCrypto.wrap,
      unwrap: delayedUnwrap,
    })

    const aliceCrypto = createFakeCrypto({ localDID: 'alice' })
    const aliceMux = createHubMux({ hub, localDID: 'alice' })
    const { client, dispose } = createDirectedClient<Protocol>({
      mux: aliceMux,
      localDID: 'alice',
      memberDID: 'bob',
      secret: SECRET,
      epoch: EPOCH,
      getRandomID: () => 'session-a-b',
      wrap: aliceCrypto.wrap,
      unwrap: aliceCrypto.unwrap,
    })

    // Fire both requests on the same session without awaiting the first, so
    // both frames land on bob's inbox back-to-back and race at the unwrap
    // layer (the first frame is the slow one).
    const [first, second] = await Promise.all([
      client.request('rpc/double', { param: { n: 5 } }),
      client.request('rpc/double', { param: { n: 9 } }),
    ])
    expect(first).toEqual({ n: 10 })
    expect(second).toEqual({ n: 18 })
    expect(calls).toEqual([5, 9]) // handler invoked in wire order, not unwrap-completion order

    await dispose()
    await aliceMux.dispose()
    await bobAcceptor.dispose()
    await bobMux.dispose()
  })
})
