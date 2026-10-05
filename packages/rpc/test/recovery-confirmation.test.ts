import { afterEach, expect, test, vi } from 'vitest'

import type { RecoveryVerdict } from '../src/crypto.js'
import {
  confirmationTag,
  createRecoveryCache,
  waitForRecoveryConfirmation,
} from '../src/recovery-confirmation.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'

afterEach(() => vi.useRealTimers())

test('outcome caches evict oldest records at the cap and release secrets on expiry', async () => {
  vi.useFakeTimers()
  const release = vi.fn((value: Uint8Array) => value.fill(0))
  const cache = createRecoveryCache(release)
  const first = new Uint8Array([1])
  cache.set('0', first, Date.now() + 100)
  for (let index = 1; index <= 1024; index++)
    cache.set(String(index), new Uint8Array([1]), Date.now() + 100)
  expect(cache.get('0')).toBeUndefined()
  expect(first).toEqual(new Uint8Array([0]))
  expect(cache.get('1024')).toBeDefined()
  await vi.advanceTimersByTimeAsync(100)
  expect(cache.get('1024')).toBeUndefined()
  expect(release).toHaveBeenCalledTimes(1025)
  expect(vi.getTimerCount()).toBe(0)
})

test.each([false, true])(
  'superseded outranks refusal during one settle round, and confirmation wins immediately: %s',
  async (confirm) => {
    const options = { members: ['alice', 'bob'], groupID: 'precedence' }
    const alice = createMemoryGroupMLS({ ...options, localDID: 'alice' })
    const bob = createMemoryGroupMLS({ ...options, localDID: 'bob' })
    const requestID = 'precedence-ask'
    const request = await bob.createRecoveryRequest(requestID)
    const pending = await bob.applyRecovery(await alice.sealGroupInfo(request), requestID)
    if (pending == null || 'renewalRequired' in pending) throw new Error('No pending recovery')
    const position = 'position'
    const commitDigest = 'digest'
    const key = await pending.confirmationKey(position, commitDigest)
    const tag = confirmationTag(key, requestID)
    vi.useFakeTimers()
    const waiters = new Map<
      string,
      { receive: (sealed: Uint8Array) => void; dispose: () => void }
    >()
    const send = vi.fn(async () => {})
    const outcome = waitForRecoveryConfirmation({
      port: bob,
      pending,
      groupID: 'precedence',
      requestID,
      position,
      commitDigest,
      key,
      deadline: Date.now() + 1000,
      timeoutMs: 100,
      send,
      waiters,
    })
    const receive = async (value: RecoveryVerdict) => {
      const sealed = await alice.sealRecoveryVerdict(request, value)
      waiters.get(requestID)?.receive(sealed)
      await vi.advanceTimersByTimeAsync(0)
    }
    const binding = { groupID: 'precedence', requestID, position, commitDigest }
    await receive({ ...binding, verdict: 'refused', reason: 'floor' })
    await vi.advanceTimersByTimeAsync(20)
    await receive({ ...binding, verdict: 'superseded' })
    if (confirm) {
      await receive({ ...binding, verdict: 'confirmed', epoch: pending.epoch, tag })
      expect(await outcome).toEqual({ kind: 'confirmed', position, epoch: pending.epoch })
      expect(vi.getTimerCount()).toBe(0)
    } else {
      await vi.advanceTimersByTimeAsync(80)
      expect(await outcome).toEqual({ kind: 'superseded' })
    }
    expect(waiters.size).toBe(0)
    expect(send).toHaveBeenCalledTimes(2)
    expect(key).toEqual(new Uint8Array(32))
  },
)
