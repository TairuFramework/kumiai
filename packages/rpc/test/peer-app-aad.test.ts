import { describe, expect, test } from 'vitest'

import { decodeAppAAD } from '../src/app-aad.js'
import type { GroupCrypto } from '../src/crypto.js'
import { createGroupPeer } from '../src/peer.js'
import { defineGroupProtocol } from '../src/protocol.js'
import { createMemoryAnchorStore } from './fixtures/anchor.js'
import { createMemoryAppCursorStore } from './fixtures/app-cursor.js'
import { memoryApplicationPorts } from './fixtures/app-publication.js'
import { createDurableTestCrypto, createTestCompletion } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { openedDeliveryContext } from './fixtures/opened-delivery.js'
import { memoryOperationHost } from './fixtures/peer.js'

const room = defineGroupProtocol({
  'room/posted': { type: 'event', retain: 'log', data: { type: 'object' } },
  'room/typing': { type: 'event', data: { type: 'object' } },
  'room/double': { type: 'request', param: { type: 'object' }, result: { type: 'object' } },
})

type Protocols = { room: typeof room }
type Aad = ReturnType<typeof decodeAppAAD>

function peer(hub: FakeHub, localDID: string, handlers: Record<string, unknown>) {
  const base = createDurableTestCrypto({ epoch: 1, localDID })
  const sealed: Array<Aad> = []
  const opened: Array<Aad> = []
  const crypto = {
    ...base,
    wrap: (bytes: Uint8Array, opts?: { aad?: Uint8Array }) => {
      sealed.push(decodeAppAAD(opts?.aad ?? new Uint8Array()))
      return base.wrap(bytes, opts)
    },
    unwrap: (bytes: Uint8Array, opts?: Parameters<GroupCrypto['unwrap']>[1]) => {
      opened.push(decodeAppAAD(opts?.expectedAAD ?? new Uint8Array()))
      return base.unwrap(bytes, opts)
    },
  }
  const mls = createMemoryGroupMLS({
    recoverySecret: new Uint8Array(32).fill(91),
    localDID,
    epoch: 1,
  })
  return {
    peer: createGroupPeer<Protocols>({
      completion: createTestCompletion(mls.control().key, crypto.pending),
      openedDeliveryContext,
      mls,
      ...memoryApplicationPorts(mls, crypto),
      appOutboxLimit: 16,
      ...memoryOperationHost(mls),
      anchorStore: createMemoryAnchorStore({ backing: mls.anchorStore() }),
      appCursorStore: createMemoryAppCursorStore(),
      hub,
      crypto,
      localDID,
      protocols: { room },
      handlers: { room: handlers } as never,
    }),
    sealed,
    opened,
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 40))

describe('versioned AAD through app and directed lanes', () => {
  test('publisher intent, live and retained opens, and directed requests/replies agree', async () => {
    const hub = new FakeHub()
    const seen: Array<string> = []
    const alice = peer(hub, 'alice', {})
    const bob = peer(hub, 'bob', {
      'room/posted': () => seen.push('posted'),
      'room/typing': () => seen.push('typing'),
      'room/double': (ctx: { param: { n: number } }) => ({ n: ctx.param.n * 2 }),
    })
    await flush()

    await alice.peer.protocol('room').dispatch('room/posted', { data: {} })
    await alice.peer.protocol('room').dispatch('room/typing', { data: {} })
    const directed = await alice.peer.protocol('room').to('bob')
    expect(await directed.request('room/double', { param: { n: 21 } })).toEqual({ n: 42 })
    await flush()

    expect(seen.toSorted()).toEqual(['posted', 'typing'])
    expect(alice.sealed).toContainEqual(expect.objectContaining({ intent: 'log' }))
    expect(alice.sealed.filter((aad) => aad?.intent === 'ephemeral').length).toBeGreaterThanOrEqual(
      2,
    )
    expect(bob.sealed).toContainEqual(expect.objectContaining({ intent: 'ephemeral' }))
    expect(bob.opened).toContainEqual(expect.objectContaining({ intent: 'log' }))
    expect(bob.opened.filter((aad) => aad?.intent === 'ephemeral').length).toBeGreaterThanOrEqual(2)
    expect(alice.opened).toContainEqual(expect.objectContaining({ intent: 'ephemeral' }))
    expect([...alice.sealed, ...bob.sealed, ...alice.opened, ...bob.opened]).not.toContain(null)

    await alice.peer.dispose()
    await bob.peer.dispose()
  })
})
