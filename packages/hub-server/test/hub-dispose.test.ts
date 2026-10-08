import type { AnyClientMessageOf, AnyServerMessageOf } from '@enkaku/protocol'
import { DirectTransports } from '@enkaku/transport'
import { createCapability } from '@kokuin/capability'
import { randomIdentity, stringifyToken } from '@kokuin/token'
import type { HubProtocol, HubStore } from '@kumiai/hub-protocol'
import { fromUTF, toB64, toB64U } from '@sozai/codec'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createHub } from '../src/hub.js'
import { createMemoryStore } from '../src/memoryStore.js'

type HubTransports = DirectTransports<
  AnyServerMessageOf<HubProtocol>,
  AnyClientMessageOf<HubProtocol>
>

const PURGE_INTERVAL = 1_000

function createDeferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function setup(store: HubStore = createMemoryStore()) {
  const transports: HubTransports = new DirectTransports()
  const hub = createHub({
    transport: transports.server,
    store,
    identity: randomIdentity(),
    purge: { interval: PURGE_INTERVAL },
  })
  return { hub, transports }
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await vi.advanceTimersByTimeAsync(0)
  return settled
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createHub dispose', () => {
  test('dispose waits for an in-flight purge', async () => {
    const store = createMemoryStore()
    const gate = createDeferred()
    const purge = vi.spyOn(store, 'purge').mockImplementation(async () => {
      await gate.promise
      return []
    })
    const { hub, transports } = setup(store)

    await vi.advanceTimersByTimeAsync(PURGE_INTERVAL)
    expect(purge).toHaveBeenCalledTimes(1)

    const disposing = hub.dispose()
    expect(await isSettled(disposing)).toBe(false)

    gate.resolve()
    await disposing
    await transports.dispose()
  })

  test('dispose waits for older purges after the latest finishes', async () => {
    const store = createMemoryStore()
    const older = createDeferred()
    const latest = createDeferred()
    vi.spyOn(store, 'purge')
      .mockImplementationOnce(async () => {
        await older.promise
        return []
      })
      .mockImplementationOnce(async () => {
        await latest.promise
        return []
      })
    const { hub, transports } = setup(store)
    await vi.advanceTimersByTimeAsync(PURGE_INTERVAL * 2)
    latest.resolve()
    await vi.advanceTimersByTimeAsync(0)
    const disposing = hub.dispose()
    await vi.advanceTimersByTimeAsync(PURGE_INTERVAL * 3)
    expect(await isSettled(disposing)).toBe(false)
    older.resolve()
    await disposing
    await transports.dispose()
  })

  test('no purge starts after dispose', async () => {
    const store = createMemoryStore()
    const purge = vi.spyOn(store, 'purge')
    const { hub, transports } = setup(store)

    await hub.dispose()
    await vi.advanceTimersByTimeAsync(PURGE_INTERVAL * 5)
    expect(purge).not.toHaveBeenCalled()
    await transports.dispose()
  })

  test('dispose disposes the server', async () => {
    const { hub, transports } = setup()
    let disposed = false
    hub.server.disposed.then(() => {
      disposed = true
    })

    await hub.dispose()
    await vi.advanceTimersByTimeAsync(0)
    expect(disposed).toBe(true)
    await transports.dispose()
  })

  test('dispose is idempotent', async () => {
    const { hub, transports } = setup()

    const first = hub.dispose()
    const second = hub.dispose()
    expect(second).toBe(first)
    await first
    await transports.dispose()
  })

  test('disposing the server directly still stops the purge', async () => {
    const store = createMemoryStore()
    const purge = vi.spyOn(store, 'purge')
    const { hub, transports } = setup(store)

    await hub.server.dispose()
    await vi.advanceTimersByTimeAsync(PURGE_INTERVAL * 5)
    expect(purge).not.toHaveBeenCalled()
    await transports.dispose()
  })

  test('verifyToken is applied to delegated capabilities', async () => {
    vi.useRealTimers()
    const hubIdentity = randomIdentity()
    const delegator = randomIdentity()
    const client = randomIdentity()
    const verifyToken = vi.fn()
    const transports: HubTransports = new DirectTransports()
    const hub = createHub({
      transport: transports.server,
      store: createMemoryStore(),
      identity: hubIdentity,
      accessRules: { 'hub/*': { allow: [delegator.id] } },
      verifyToken,
      purge: false,
    })

    const capability = await createCapability(delegator, {
      sub: delegator.id,
      aud: client.id,
      act: '*',
      res: '*',
    })
    const topicID = toB64U(new Uint8Array(32).fill(1))
    const message = await client.signToken({
      typ: 'request',
      prc: 'hub/v1/publish',
      rid: 'r1',
      prm: { topicID, payload: toB64(fromUTF('hello')) },
      aud: hubIdentity.id,
      sub: delegator.id,
      cap: stringifyToken(capability),
      iat: Math.floor(Date.now() / 1000),
    } as const)
    await transports.client.write(message as unknown as AnyClientMessageOf<HubProtocol>)
    const response = await transports.client.read()

    expect(response.value?.payload.typ).toBe('result')
    expect(verifyToken).toHaveBeenCalled()

    await hub.dispose()
    await transports.dispose()
  })
})
