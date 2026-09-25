import type { ProtocolDefinition } from '@enkaku/protocol'
import { describe, expect, test, vi } from 'vitest'

import { PeerDisposedError } from '../src/errors.js'
import { createGroupPeer } from '../src/peer.js'
import { createFakeCrypto, type FakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'

const SHORT_BOB = 'did:peer:4zBobShort'
const LONG_BOB = `${SHORT_BOB}:eyLongFormSuffix`
const chat = {
  'chat/echo': { type: 'request', param: { type: 'object' }, result: { type: 'string' } },
} as const satisfies ProtocolDefinition
type Protocols = { chat: typeof chat }

function makePeer(
  hub: FakeHub,
  localDID: string,
  handlers: Record<string, unknown> = {},
  crypto?: FakeCrypto,
) {
  return createGroupPeer<Protocols>({
    hub,
    crypto: crypto ?? createFakeCrypto({ epoch: 1, localDID }),
    localDID,
    protocols: { chat },
    handlers: { chat: handlers } as never,
  })
}

function countAbortListeners(signal: AbortSignal): { added: () => number; removed: () => number } {
  let adds = 0
  let removes = 0
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  vi.spyOn(signal, 'addEventListener').mockImplementation((...args) => {
    if (args[0] === 'abort') adds += 1
    add(...args)
  })
  vi.spyOn(signal, 'removeEventListener').mockImplementation((...args) => {
    if (args[0] === 'abort') removes += 1
    remove(...args)
  })
  return { added: () => adds, removed: () => removes }
}

function stalledPeer(hub: FakeHub) {
  const base = createFakeCrypto({ epoch: 1, localDID: 'alice' })
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const crypto: FakeCrypto = {
    ...base,
    exportSecret: async (label, length) => {
      await gate
      return base.exportSecret(label, length)
    },
  }
  return { peer: makePeer(hub, 'alice', {}, crypto), release }
}

const deadline = () =>
  new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('gather waited on readiness')), 100)
  })

describe('protocol gather streaming', () => {
  test('forwards onReply and signal, with the normalized sender DID', async () => {
    const hub = new FakeHub()
    const alice = makePeer(hub, 'alice')
    const bob = makePeer(hub, LONG_BOB, { 'chat/echo': () => 'hello' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const controller = new AbortController()
    const seen: Array<{ senderDID: string; value: string }> = []
    const gathered = alice.protocol('chat').gather('chat/echo', {
      param: {},
      quorum: 99,
      timeoutMs: 1000,
      signal: controller.signal,
      onReply(reply) {
        seen.push(reply)
        controller.abort()
      },
    })
    const replies = await Promise.race([gathered, deadline()])
    expect(replies).toEqual([{ senderDID: SHORT_BOB, value: 'hello' }])
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(replies[0])
    await Promise.all([alice.dispose(), bob.dispose()])
  })

  test('abort while waiting on ready resolves promptly without sending', async () => {
    const hub = new FakeHub()
    const { peer, release } = stalledPeer(hub)
    const controller = new AbortController()
    const gathered = peer.protocol('chat').gather('chat/echo', {
      param: {},
      signal: controller.signal,
      timeoutMs: 1000,
    })
    controller.abort()
    try {
      expect(await Promise.race([gathered, deadline()])).toEqual([])
      expect(hub.published).toEqual([])
    } finally {
      release()
      await peer.dispose()
      await gathered.catch(() => {})
    }
  })

  test('abort while waiting on ready still rejects for a disposed peer', async () => {
    const hub = new FakeHub()
    const { peer, release } = stalledPeer(hub)
    const controller = new AbortController()
    const gathered = peer.protocol('chat').gather('chat/echo', {
      param: {},
      signal: controller.signal,
    })
    const disposing = peer.dispose()
    controller.abort()
    try {
      await expect(Promise.race([gathered, deadline()])).rejects.toBeInstanceOf(PeerDisposedError)
    } finally {
      release()
      await disposing
      await gathered.catch(() => {})
    }
  })

  test('ready winning removes its abort listener', async () => {
    const hub = new FakeHub()
    const peer = makePeer(hub, 'alice')
    const controller = new AbortController()
    const listeners = countAbortListeners(controller.signal)
    expect(
      await peer.protocol('chat').gather('chat/echo', {
        param: {},
        signal: controller.signal,
        timeoutMs: 20,
      }),
    ).toEqual([])
    expect(listeners.added()).toBe(listeners.removed())
    expect(listeners.added()).toBeGreaterThan(0)
    await peer.dispose()
  })

  test('ready rejecting removes its abort listener and preserves the error', async () => {
    const hub = new FakeHub()
    const error = new Error('initialization failed')
    const base = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const crypto: FakeCrypto = {
      ...base,
      exportSecret: () => {
        throw error
      },
    }
    const peer = makePeer(hub, 'alice', {}, crypto)
    const controller = new AbortController()
    const listeners = countAbortListeners(controller.signal)
    await expect(
      peer.protocol('chat').gather('chat/echo', {
        param: {},
        signal: controller.signal,
      }),
    ).rejects.toBe(error)
    expect(listeners.added()).toBe(listeners.removed())
    expect(listeners.added()).toBeGreaterThan(0)
    await peer.dispose()
  })
})
