import { expect, test } from 'vitest'

import { asLogPosition } from '../src/cursor.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { makeMLSPeer } from './fixtures/peer.js'

test('operation step refuses a retained expired intent whose outcome already landed', async () => {
  const hub = new FakeHub()
  const bob = makeMLSPeer(hub, 'bob', new Uint8Array(32).fill(87))
  try {
    await bob.peer.resync()
    const intent = {
      id: 'settled-operation',
      kind: 'rotation' as const,
      revokes: false,
      body: new TextEncoder().encode(JSON.stringify({ tokens: [] })),
      seq: 1,
      enqueuedAt: 0,
      deadline: 1,
      stage: 'intent' as const,
    }
    const landed = {
      id: intent.id,
      opID: intent.id,
      at: 1,
      kind: 'landed' as const,
      position: asLogPosition('000000000001'),
    }
    await bob.control.apply({ putOperations: [intent], putOutcomes: [landed] }, 'settled')
    const refusal = await bob.controlWalk.stepOperation(intent.id).then(
      () => null,
      (error: unknown) => error,
    )
    expect((await bob.control.load()).outcomes).toEqual([landed])
    expect(refusal).toEqual(new Error('Operation already settled'))
    expect((await bob.control.load()).operations).toEqual([intent])
    expect(hub.published).toEqual([])
  } finally {
    await bob.peer.dispose()
  }
})

test('operation step refuses missing and stale FIFO heads', async () => {
  const bob = makeMLSPeer(new FakeHub(), 'bob', new Uint8Array(32).fill(87))
  try {
    await bob.peer.resync()
    await expect(bob.controlWalk.stepOperation('missing')).rejects.toThrow(
      'Missing queued operation',
    )
    const head = {
      id: 'fifo-head',
      kind: 'rotation' as const,
      revokes: false,
      body: new TextEncoder().encode(JSON.stringify({ tokens: [] })),
      seq: 1,
      enqueuedAt: Date.now(),
      deadline: Date.now() + 30_000,
      stage: 'intent' as const,
    }
    const next = { ...head, id: 'fifo-next', seq: 2 }
    await bob.control.apply({ putOperations: [head, next] }, 'queue')
    await expect(bob.controlWalk.stepOperation(next.id)).rejects.toThrow(
      'Stale operation: not the durable FIFO head',
    )
    expect((await bob.control.load()).operations).toEqual([head, next])
    expect((await bob.control.load()).outcomes).toEqual([])
  } finally {
    await bob.peer.dispose()
  }
})
