import type { AnyClientMessageOf, AnyServerMessageOf } from '@enkaku/protocol'
import { DirectTransports } from '@enkaku/transport'
import { randomIdentity } from '@kokuin/token'
import type { HubProtocol } from '@kumiai/hub-protocol'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { HubStoreErrorEvent } from '../src/handlers.js'
import { createHub, type HubPurgeOptions } from '../src/hub.js'
import { createMemoryStore } from '../src/memoryStore.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setup(
  params: {
    reaper?: (params: { olderThan: number }) => Promise<Array<unknown>>
    purge?: HubPurgeOptions
    failPurge?: boolean
  } = {},
) {
  const store = Object.assign(
    createMemoryStore(),
    params.reaper == null ? {} : { purgeSubscriptions: params.reaper },
  )
  const purge = vi.spyOn(store, 'purge')
  if (params.failPurge) purge.mockRejectedValue(new Error('purge failed'))
  const errors: Array<HubStoreErrorEvent> = []
  const transports = new DirectTransports<
    AnyServerMessageOf<HubProtocol>,
    AnyClientMessageOf<HubProtocol>
  >()
  const hub = createHub({
    transport: transports.server,
    store,
    identity: randomIdentity(),
    purge: { interval: 1000, ...params.purge },
    onStoreError: (event) => {
      errors.push(event)
    },
  })
  return { hub, transports, errors, purge }
}

test.each([
  { olderThan: 20, subscriptionOlderThan: 5, expected: 20 },
  { olderThan: 20, expected: 7776000 },
  { olderThan: 9000000, expected: 9000000 },
])(
  'tick reaps subscriptions after message purge with window $expected',
  async ({ expected, ...options }) => {
    const gate = Promise.withResolvers<Array<string>>()
    const reaper = vi.fn(async () => [])
    const { hub, transports, purge } = setup({ reaper, purge: options })
    purge.mockReturnValue(gate.promise)
    try {
      await vi.advanceTimersByTimeAsync(1000)
      expect(purge).toHaveBeenCalledWith({ olderThan: options.olderThan })
      expect(reaper).not.toHaveBeenCalled()
      gate.resolve([])
      await vi.advanceTimersByTimeAsync(0)
      expect(reaper).toHaveBeenCalledExactlyOnceWith({ olderThan: expected })
    } finally {
      gate.resolve([])
      await hub.dispose()
      await transports.dispose()
    }
  },
)

test('dispose waits for an in-flight subscription purge', async () => {
  const gate = Promise.withResolvers<Array<unknown>>()
  const reaper = vi.fn(() => gate.promise)
  const { hub, transports } = setup({ reaper })
  try {
    await vi.advanceTimersByTimeAsync(1000)
    expect(reaper).toHaveBeenCalledOnce()
    let disposed = false
    const disposing = hub.dispose().then(() => {
      disposed = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(disposed).toBe(false)
    gate.resolve([])
    await disposing
    expect(disposed).toBe(true)
  } finally {
    gate.resolve([])
    await hub.dispose()
    await transports.dispose()
  }
})

test('subscription purge failures reach the error hook and later ticks still purge', async () => {
  const error = new Error('reaper failed')
  const reaper = vi.fn().mockRejectedValueOnce(error).mockResolvedValue([])
  const { hub, transports, errors, purge } = setup({ reaper })
  try {
    await vi.advanceTimersByTimeAsync(2000)
    expect(errors).toEqual([{ method: 'purgeSubscriptions', error }])
    expect(purge).toHaveBeenCalledTimes(2)
    expect(reaper).toHaveBeenCalledTimes(2)
  } finally {
    await hub.dispose()
    await transports.dispose()
  }
})

test('message purge failure still permits subscription purge', async () => {
  const reaper = vi.fn(async () => [])
  const { hub, transports, errors } = setup({ reaper, failPurge: true })
  try {
    await vi.advanceTimersByTimeAsync(1000)
    expect(errors).toMatchObject([{ method: 'purge' }])
    expect(reaper).toHaveBeenCalledOnce()
  } finally {
    await hub.dispose()
    await transports.dispose()
  }
})

test('a memory store without subscription reaping ticks without error', async () => {
  const { hub, transports, errors, purge } = setup()
  try {
    await vi.advanceTimersByTimeAsync(1000)
    expect(purge).toHaveBeenCalledOnce()
    expect(errors).toEqual([])
  } finally {
    await hub.dispose()
    await transports.dispose()
  }
})
