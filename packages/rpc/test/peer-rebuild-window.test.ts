import { BroadcastClient } from '@kumiai/broadcast'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { PeerDisposedError } from '../src/errors.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { makeMLSPeer, type TestPeer } from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 50))

const MEMBERS = ['alice', 'bob', 'carol']

/**
 * Holds ONE peer's epoch teardown open: its `BroadcastClient.dispose` waits on `release()`, every
 * other client disposes normally. That peer sits between `teardownEpoch` emptying its runtimes and
 * `buildEpoch` installing the next ones, while the other member rotates unimpeded.
 */
async function holdTeardownOf(member: TestPeer) {
  // The peer's own client, captured off a dispatch: nothing else names it from outside.
  let held: BroadcastClient | undefined
  const dispatchSpy = vi.spyOn(BroadcastClient.prototype, 'dispatch').mockImplementation(function (
    this: BroadcastClient,
  ) {
    held = this
    return Promise.resolve()
  })
  await member.peer.protocol('chat').dispatch('chat/changed', { data: {} })
  dispatchSpy.mockRestore()
  if (held == null) throw new Error('no client captured')

  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered = false
  const dispose = BroadcastClient.prototype.dispose
  vi.spyOn(BroadcastClient.prototype, 'dispose').mockImplementation(function (
    this: BroadcastClient,
    ...args: Parameters<BroadcastClient['dispose']>
  ) {
    if (this !== held) return dispose.apply(this, args)
    entered = true
    return gate.then(() => dispose.apply(this, args))
  })
  return { release, entered: () => entered }
}

/**
 * One of each protocol call: ephemeral dispatch (`n: 1`), request (`n: 2`), gather (`n: 3`), `to`.
 * Separate statements: one tuple of all four surface calls overflows TS instantiation depth.
 */
function callEach(member: TestPeer): Array<Promise<unknown>> {
  const chat = member.peer.protocol('chat')
  const dispatching: Promise<unknown> = chat.dispatch('chat/changed', { data: { n: 1 } })
  const requesting: Promise<unknown> = chat.request('chat/echo', {
    param: { n: 2 },
    timeoutMs: 1000,
  })
  const gathering: Promise<unknown> = chat.gather('chat/echo', {
    param: { n: 3 },
    quorum: 1,
    timeoutMs: 1000,
  })
  const directing: Promise<unknown> = chat.to('alice')
  return [dispatching, requesting, gathering, directing]
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('calls landing mid-rebuild wait for the next epoch', () => {
  /**
   * `teardownEpoch` empties the runtimes before it awaits child disposal, and only `buildEpoch`
   * fills them again. A call reaching `surfaceFor` in that window used to throw
   * `Unknown protocol: chat` — for a live peer and a registered protocol.
   */
  test('ephemeral dispatch, request, gather and to() are served on the new epoch', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0xa4)
    const aliceSaw: Array<unknown> = []
    const alice = makeMLSPeer(hub, 'alice', recoverySecret, {
      epoch: 1,
      members: MEMBERS,
      handlers: {
        'chat/changed': (ctx: { data: unknown }) => void aliceSaw.push(ctx.data),
        'chat/echo': (ctx: { param: unknown }) => ctx.param,
      },
    })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, members: MEMBERS })
    await flush()

    const hold = await holdTeardownOf(bob)
    await publishCommit({ hub, senderDID: 'admin', recoverySecret, epoch: 1, removes: ['carol'] })
    await flush()
    expect(hold.entered()).toBe(true)
    expect(alice.peer.anchorEpoch()).toBe(2)

    const settled = Promise.allSettled(callEach(bob))
    await flush()
    hold.release()
    const [dispatched, requested, gathered, directed] = await settled

    expect(dispatched).toEqual({ status: 'fulfilled', value: undefined })
    expect(requested).toEqual({ status: 'fulfilled', value: { n: 2 } })
    expect(gathered).toEqual({
      status: 'fulfilled',
      value: [{ senderDID: 'alice', value: { n: 3 } }],
    })
    expect(directed?.status).toBe('fulfilled')
    await flush()
    expect(aliceSaw).toEqual([{ n: 1 }])
    expect(bob.peer.anchorEpoch()).toBe(2)

    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('a gather aborted while it waits resolves empty before the rebuild ends', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0xa6)
    const alice = makeMLSPeer(hub, 'alice', recoverySecret, {
      epoch: 1,
      members: MEMBERS,
      handlers: { 'chat/echo': (ctx: { param: unknown }) => ctx.param },
    })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, members: MEMBERS })
    await flush()

    const hold = await holdTeardownOf(bob)
    await publishCommit({ hub, senderDID: 'admin', recoverySecret, epoch: 1, removes: ['carol'] })
    await flush()
    expect(hold.entered()).toBe(true)

    const controller = new AbortController()
    const gathered = bob.peer
      .protocol('chat')
      .gather('chat/echo', { param: {}, quorum: 1, timeoutMs: 1000, signal: controller.signal })
    await flush()
    controller.abort()
    await expect(gathered).resolves.toEqual([])

    hold.release()
    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('a peer disposed while a call waits rejects the call as disposed', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0xa5)
    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1, members: MEMBERS })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, members: MEMBERS })
    await flush()

    const hold = await holdTeardownOf(bob)
    await publishCommit({ hub, senderDID: 'admin', recoverySecret, epoch: 1, removes: ['carol'] })
    await flush()
    expect(hold.entered()).toBe(true)

    const settled = Promise.allSettled(callEach(bob))
    await flush()
    const disposed = bob.peer.dispose()
    hold.release()
    const results = await settled
    for (const result of results) {
      expect(result.status).toBe('rejected')
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(PeerDisposedError)
    }
    await disposed

    await alice.peer.dispose()
  })
})
