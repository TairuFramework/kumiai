import { expect, test, vi } from 'vitest'

import { SendNotAdmissibleError } from '../src/errors.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { makeMLSPeer } from './fixtures/peer.js'

test('recovery-only startup never reads lost private state or opens application work', async () => {
  const hub = new FakeHub()
  const mls = createMemoryGroupMLS({ localDID: 'alice' })
  const epoch = vi.spyOn(mls, 'readEpoch').mockRejectedValue(new Error('Private state unavailable'))
  const anchor = vi.spyOn(mls, 'exportRecoverySecret')
  const member = makeMLSPeer(hub, 'alice', new Uint8Array(32).fill(8), { mls, recoveryOnly: true })
  try {
    await member.peer.replay()
    expect(epoch).not.toHaveBeenCalled()
    expect(anchor).toHaveBeenCalled()
    expect(() => member.peer.protocol('chat')).toThrow(SendNotAdmissibleError)
    expect(hub.published).toEqual([])
    expect(await member.appOutbox.list()).toEqual([])
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('recovery-only construction never asks application crypto for private state', async () => {
  const crypto = createFakeCrypto({ epoch: 1, localDID: 'alice' })
  const epoch = vi.spyOn(crypto, 'epoch').mockImplementation(() => {
    throw new Error('Private crypto state unavailable')
  })
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(9), {
    crypto,
    recoveryOnly: true,
  })
  try {
    await member.peer.replay()
    expect(epoch).not.toHaveBeenCalled()
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('recovery-only peers reject new control work without saving an intent', async () => {
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(10), {
    recoveryOnly: true,
  })
  try {
    await expect(
      member.peer.enqueue({
        id: 'rotation',
        kind: 'rotation',
        revokes: false,
        body: new Uint8Array([1]),
      }),
    ).rejects.toBeInstanceOf(SendNotAdmissibleError)
    expect((await member.control.load()).operations).toEqual([])
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('recovery-only startup preserves queued control intents without invoking private MLS', async () => {
  const mls = createMemoryGroupMLS({ localDID: 'alice' })
  await mls.persistInitialState()
  const intent = {
    id: 'queued',
    kind: 'rotation' as const,
    revokes: false,
    body: new Uint8Array([1]),
    stage: 'intent' as const,
    seq: 1,
    enqueuedAt: Date.now(),
    deadline: Date.now() + 30_000,
  }
  await mls.control().apply({ putOperations: [intent] }, 'queued-intent')
  const epoch = vi.spyOn(mls, 'readEpoch').mockRejectedValue(new Error('Lost private state'))
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(11), {
    mls,
    recoveryOnly: true,
  })
  try {
    await member.peer.replay()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(epoch).not.toHaveBeenCalled()
    expect((await member.control.load()).operations).toEqual([intent])
    await expect(member.peer.resync()).rejects.toBeInstanceOf(SendNotAdmissibleError)
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})
