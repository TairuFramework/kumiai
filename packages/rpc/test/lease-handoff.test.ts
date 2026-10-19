import { afterEach, expect, test, vi } from 'vitest'

import { createAppOutboxAcceptance } from '../src/app-outbox.js'
import type { SendAdmission } from '../src/crypto.js'
import { createLogDelivery } from '../src/log-delivery.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryAppOutbox } from './fixtures/outbox.js'
import { makeMLSPeer } from './fixtures/peer.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test.each(['seal', 'put', 'resend'] as const)(
  'sealed frame hands off when rotation closes admission at %s',
  async (flip) => {
    vi.useFakeTimers()
    let epoch = 1
    let held = false
    let flipNext = flip === 'seal'
    const store = createMemoryAppOutbox()
    const admission = (): SendAdmission =>
      held ? { epoch, admissible: false, reason: 'rotation-required' } : { epoch, admissible: true }
    const queue = createAppOutboxAcceptance({ outbox: store, limit: 4, admission })
    const publish = vi.fn(async () => {})
    const seal = vi.fn(async () => {
      if (flipNext) held = true
      return {
        topicID: 'app',
        payload: new Uint8Array([epoch]),
        floor: { epoch, position: null, covered: true },
      }
    })
    const delivery = createLogDelivery({
      queue,
      ready: async () => {},
      floor: () => ({ epoch, position: null, covered: true }),
      held: () => held,
      handoffHeld: () => false,
      probe: async () => ({ head: null, oldest: null, gap: false, messages: [] }),
      pull: async () => {},
      heal: async () => {},
      seal,
      put: async (entry) => {
        await store.put(entry)
        if (flip === 'put') held = true
      },
      publish,
      remove: store.remove,
      clear: store.clear,
      cleared: () => {},
      deliveredWindowMs: 60_000,
      deliveredLimit: 4,
    })
    try {
      await queue.accept({ protocol: 'chat', prc: 'posted', data: new Uint8Array([1]) })
      await queue.accept({ protocol: 'chat', prc: 'posted', data: new Uint8Array([2]) })
      delivery.trigger()
      await vi.advanceTimersByTimeAsync(0)
      if (flip === 'resend') {
        expect(publish).toHaveBeenCalledTimes(2)
        epoch = 2
        flipNext = true
        delivery.rejoined(1)
        await vi.advanceTimersByTimeAsync(1_000)
        expect(publish).toHaveBeenCalledTimes(3)
      } else {
        expect(publish).toHaveBeenCalledTimes(1)
        delivery.certify(1, delivery.beginWalk())
        delivery.trigger()
        await vi.advanceTimersByTimeAsync(0)
        expect(queue.entries()).toHaveLength(1)
        await expect(
          queue.accept({ protocol: 'chat', prc: 'posted', data: new Uint8Array([3]) }),
        ).rejects.toMatchObject({ reason: 'rotation-required' })
        await vi.advanceTimersByTimeAsync(1_000)
        expect(publish).toHaveBeenCalledTimes(1)
        epoch = 2
        held = false
        flipNext = false
        delivery.trigger()
        await vi.advanceTimersByTimeAsync(0)
        expect(publish).toHaveBeenCalledTimes(2)
        expect(queue.entries()).toEqual([])
      }
    } finally {
      delivery.close()
      queue.close()
    }
  },
)

test('admission flips between outbox snapshot and seal and the sealed frame still publishes', async () => {
  const hub = new FakeHub()
  const secret = new Uint8Array(32).fill(61)
  const member = makeMLSPeer(hub, 'alice', secret)
  let rotated = false
  vi.spyOn(member.mls, 'sendAdmission').mockImplementation(() =>
    rotated
      ? { epoch: 1, admissible: false, reason: 'rotation-required' }
      : { epoch: 1, admissible: true },
  )
  const original = member.crypto.wrap.bind(member.crypto)
  vi.spyOn(member.crypto, 'wrap').mockImplementation(async (...args) => {
    const frame = await original(...args)
    rotated = true
    return frame
  })
  try {
    await member.peer
      .protocol('chat')
      .dispatch('chat/posted', { data: { text: 'last generation' } })
    await vi.waitFor(() =>
      expect(hub.published.some((frame) => frame.logPosition != null)).toBe(true),
    )
    await expect(
      member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'next' } }),
    ).rejects.toMatchObject({ reason: 'rotation-required' })
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test.each([false, true])(
  'a post-seal hold blocks publication (explicit handoff hold=%s)',
  async (explicit) => {
    vi.useFakeTimers()
    let held = false
    const store = createMemoryAppOutbox()
    const queue = createAppOutboxAcceptance({
      outbox: store,
      limit: 4,
      admission: () => ({ epoch: 1, admissible: true }),
    })
    const publish = vi.fn(async () => {})
    const delivery = createLogDelivery({
      queue,
      ready: async () => {},
      floor: () => ({ epoch: 1, position: null, covered: true }),
      held: () => held,
      ...(explicit ? { handoffHeld: () => held } : {}),
      probe: async () => ({ head: null, oldest: null, gap: false, messages: [] }),
      pull: async () => {},
      heal: async () => {},
      seal: async () => {
        held = true
        return {
          topicID: 'app',
          payload: new Uint8Array([1]),
          floor: { epoch: 1, position: null, covered: true },
        }
      },
      put: store.put,
      publish,
      remove: store.remove,
      clear: store.clear,
      cleared: () => {},
      deliveredWindowMs: 60_000,
      deliveredLimit: 4,
    })
    try {
      await queue.accept({ protocol: 'chat', prc: 'posted', data: new Uint8Array([1]) })
      delivery.trigger()
      await vi.advanceTimersByTimeAsync(0)
      expect(publish).not.toHaveBeenCalled()
      expect(queue.entries()).toHaveLength(1)
    } finally {
      delivery.close()
      queue.close()
    }
  },
)
