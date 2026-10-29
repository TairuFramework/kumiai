import { expect, test, vi } from 'vitest'

import { PeerDisposedError } from '../src/errors.js'
import type { EpochRuntime, EpochRuntimeParams } from '../src/peer-epoch.js'
import * as epochRuntime from '../src/peer-epoch.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { buildLedgerCommit, makeMLSPeer, type Protocols } from './fixtures/peer.js'

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { promise, release: () => resolve() }
}

test('dispose releases seal waiters while drained still waits for an accepted host callback', async () => {
  const accepted = gate()
  const accepting = gate()
  const waiting = gate()
  const createEpochRuntime = epochRuntime.createEpochRuntime
  // Specialise the spy to this fixture's protocols to avoid recursive generic inference.
  const observed = epochRuntime as unknown as {
    createEpochRuntime: (params: EpochRuntimeParams<Protocols>) => EpochRuntime
  }
  // Observe the real seal loop entering its barrier, without changing the barrier's lifetime.
  const runtime = vi.spyOn(observed, 'createEpochRuntime').mockImplementation((params) => {
    return createEpochRuntime({
      ...params,
      sealBarrier: () => {
        const barrier = params.sealBarrier()
        if (barrier != null) waiting.release()
        return barrier
      },
    })
  })
  const alice = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(0xc1))
  try {
    await alice.peer.replay()
    const build = buildLedgerCommit(alice, ['role:alice=admin'])
    const committing = alice.peer
      .commit(async () => {
        const pending = await build()
        return {
          ...pending,
          onAccepted: async () => {
            accepting.release()
            await accepted.promise
            await pending.onAccepted()
          },
        }
      })
      .catch((error: unknown) => error)
    await accepting.promise
    const sending = alice.peer
      .protocol('chat')
      .dispatch('chat/changed', { data: {} })
      .catch((error: unknown) => error)
    await waiting.promise

    await alice.peer.dispose()
    expect(await sending).toBeInstanceOf(PeerDisposedError)

    let drained = false
    const draining = alice.peer.drained().then(() => {
      drained = true
    })
    // Pass teardown's microtasks while the host callback remains explicitly gated.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(drained).toBe(false)
    accepted.release()
    await draining
    expect(drained).toBe(true)
    expect(await committing).toBeInstanceOf(PeerDisposedError)
  } finally {
    accepted.release()
    runtime.mockRestore()
  }
}, 2000)

test('dispose waits for a transport write already inside host crypto', async () => {
  const alice = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(0xc2))
  await alice.peer.replay()
  const sealing = gate()
  const sealed = gate()
  const accepting = gate()
  const accepted = gate()
  const wrap = alice.crypto.wrap
  const wrapping = vi.spyOn(alice.crypto, 'wrap').mockImplementation(async (...args) => {
    sealing.release()
    await sealed.promise
    return wrap(...args)
  })
  try {
    const sending = alice.peer
      .protocol('chat')
      .dispatch('chat/changed', { data: {} })
      .catch((error: unknown) => error)
    await sealing.promise
    const build = buildLedgerCommit(alice, ['role:alice=admin'])
    const committing = alice.peer
      .commit(async () => {
        const pending = await build()
        return {
          ...pending,
          onAccepted: async () => {
            accepting.release()
            await accepted.promise
            throw new Error('host acceptance failed')
          },
        }
      })
      .catch((error: unknown) => error)
    await accepting.promise
    let disposed = false
    const disposing = alice.peer.dispose().then(() => {
      disposed = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(disposed).toBe(false)
    // The late rotation failure must not replace the disposal refusal for the suspended seal.
    accepted.release()
    await committing
    sealed.release()
    await disposing
    expect(disposed).toBe(true)
    expect(await sending).toBeInstanceOf(PeerDisposedError)
    await alice.peer.drained()
  } finally {
    accepted.release()
    sealed.release()
    wrapping.mockRestore()
  }
}, 2000)
