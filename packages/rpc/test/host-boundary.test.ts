import { stdout } from 'node:process'
import { createSigningIdentity } from '@kokuin/token'
import { describe, expect, expectTypeOf, test, vi } from 'vitest'

import type { PendingCommit } from '../src/commit.js'
import type { PendingRecovery } from '../src/crypto.js'
import { PeerDisposedError } from '../src/errors.js'
import {
  createHostBoundary,
  peerHostFields,
  pendingCommitHostMembers,
  pendingRecoveryHostMembers,
  wrapPeerHost,
  wrapPendingCommit,
  wrapPendingRecovery,
} from '../src/host-boundary.js'
import { notifyHost } from '../src/host-notice.js'
import type { GroupPeerMLSParams, GroupPeerParams } from '../src/peer.js'
import type { GroupProtocolDefinition } from '../src/protocol.js'

function gate() {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function assertPaused(path: string, invoke: (pause: Promise<void>) => unknown) {
  const boundary = createHostBoundary()
  const pause = gate()
  const method = path.split('.').at(-1) as string
  const port = boundary.wrap({ [method]: () => invoke(pause.promise) })
  const callable = port[method]
  if (callable == null) throw new Error('Missing host method')
  const call = callable()
  boundary.close()
  let settled = false
  const drain = boundary.drained(Promise.resolve()).then(() => {
    settled = true
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(settled).toBe(false)
  stdout.write(`${path}: method invoked -> close -> drain pending -> release\n`)
  pause.release()
  await call
  await drain
  expect(settled).toBe(true)
  expect(() => callable()).toThrow(PeerDisposedError)
  stdout.write(`${path}: settled -> drained -> late method invocation refused\n`)
}

describe('host invocation boundary', () => {
  test('waits for a paused method and refuses its later invocation', async () => {
    await assertPaused('host.write', async (pause) => {
      await pause
    })
  })

  test('selects named acceptance members without touching returned data', async () => {
    const boundary = createHostBoundary()
    const pause = gate()
    let calls = 0
    const data = Object.freeze({ validate: () => true })
    let inspected = 0
    const bytes = new Proxy(new Uint8Array([1]), {
      ownKeys(target) {
        inspected++
        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor(target, key) {
        inspected++
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    })
    const receiver = Object.freeze({
      epoch: 1,
      confirmationKey: async () => new Uint8Array(32),
      judgeVerdict: () => 'authoritative' as const,
      commit: bytes,
      bodies: [],
      kind: 'ledger' as const,
      journal: bytes,
      data,
      get onAccepted() {
        return async function (this: { data: typeof data }) {
          expect(this.data).toBe(data)
          calls++
          await pause.promise
        }
      },
    })
    const commit = wrapPendingCommit(boundary, receiver)
    const recovery = wrapPendingRecovery(boundary, receiver)
    expect(commit.commit).toBe(bytes)
    expect(recovery.commit).toBe(bytes)
    const accepting = recovery.onAccepted()
    boundary.close()
    let settled = false
    const drain = boundary.drained(Promise.resolve()).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    pause.release()
    await accepting
    await drain
    expect(() => commit.onAccepted()).toThrow(PeerDisposedError)
    expect(calls).toBe(1)
    expect(inspected).toBe(0)
  })

  test.each(Object.entries(peerHostFields).filter(([, kind]) => kind === 'callback'))(
    'drains and closes the selected construction callback %s',
    async (field) => {
      const boundary = createHostBoundary()
      const pause = gate()
      const callback = vi.fn(async () => pause.promise)
      const selected = wrapPeerHost(boundary, { [field]: callback })
      const invoking = selected[field]?.()
      boundary.close()
      let settled = false
      const drain = boundary.drained(Promise.resolve()).then(() => {
        settled = true
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(settled).toBe(false)
      pause.release()
      await invoking
      await drain
      expect(() => selected[field]?.()).toThrow(PeerDisposedError)
      expect(callback).toHaveBeenCalledTimes(1)
    },
  )

  test('classifies construction exclusions and named returned members', () => {
    expectTypeOf(peerHostFields).toMatchTypeOf<
      Record<
        keyof GroupPeerParams<Record<string, GroupProtocolDefinition>> | keyof GroupPeerMLSParams,
        string
      >
    >()
    expectTypeOf(pendingRecoveryHostMembers).toMatchTypeOf<Record<keyof PendingRecovery, string>>()
    expectTypeOf(pendingCommitHostMembers).toMatchTypeOf<Record<keyof PendingCommit, string>>()
    expect(peerHostFields.hub).toBe('transport')
    expect(peerHostFields.runtime).toBe('runtime')
    expect(peerHostFields.protocols).toBe('data')
    expect(peerHostFields.handlers).toBe('handlers')
    expect(pendingRecoveryHostMembers.onAccepted).toBe('host')
    expect(pendingRecoveryHostMembers.epoch).toBe('data')
    expect(pendingRecoveryHostMembers.confirmationKey).toBe('host')
    expect(pendingRecoveryHostMembers.judgeVerdict).toBe('host')
    expect(pendingCommitHostMembers.onAccepted).toBe('host')
  })

  test('counts a notice even though notifyHost abandons its promise and swallows errors', async () => {
    const boundary = createHostBoundary()
    const pause = gate()
    let calls = 0
    const callback = boundary.wrap(async () => {
      calls++
      await pause.promise
      throw new Error('observer error')
    })
    notifyHost(callback, undefined)
    boundary.close()
    let settled = false
    const drain = boundary.drained(Promise.resolve()).then(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    notifyHost(callback, undefined)
    expect(calls).toBe(1)
    pause.release()
    await drain
    stdout.write(
      'notifyHost: observer paused -> close -> late notice swallowed without host call -> rejection -> drained\n',
    )
  })

  test('preserves receiver, reused callable identity and synchronous results without counting a wrapper twice', async () => {
    const boundary = createHostBoundary()
    class Port {
      #value = 7
      read() {
        return this.#value
      }
    }
    const port = new Port()
    const wrapped = boundary.wrap(port)
    expect(wrapped.read()).toBe(7)
    expect(wrapped.read).toBe(wrapped.read)
    expect(boundary.wrap(wrapped)).toBe(wrapped)
    let calls = 0
    const shared = () => {
      calls++
      return 9
    }
    const aliases = boundary.wrap({ first: shared, second: shared })
    expect(aliases.first).toBe(aliases.second)
    expect(aliases.first()).toBe(9)
    expect(calls).toBe(1)
    boundary.close()
    await boundary.drained(Promise.resolve())
    expect(() => wrapped.read()).toThrow(PeerDisposedError)
  })

  test('settles synchronous throws, rejected promises and throwing or rejecting thenables', async () => {
    const syncBoundary = createHostBoundary()
    const syncError = new Error('sync')
    expect(() =>
      syncBoundary.wrap(() => {
        throw syncError
      })(),
    ).toThrow(syncError)
    syncBoundary.close()
    await syncBoundary.drained(Promise.resolve())
    for (const action of [
      () => {
        throw new Error('sync')
      },
      () => Promise.reject(new Error('promise')),
      () => ({
        // biome-ignore lint/suspicious/noThenProperty: Exercise thenable settlement.
        then() {
          throw new Error('then throws')
        },
      }),
      () => ({
        // biome-ignore lint/suspicious/noThenProperty: Exercise thenable rejection.
        then(_resolve: unknown, reject: (error: Error) => void) {
          reject(new Error('then rejects'))
        },
      }),
    ]) {
      const boundary = createHostBoundary()
      let rejected = false
      try {
        await (boundary.wrap(action)() as unknown)
      } catch (error) {
        rejected = true
        expect(error).toBeInstanceOf(Error)
      }
      expect(rejected).toBe(true)
      boundary.close()
      await boundary.drained(Promise.reject(new Error('teardown')))
    }
  })

  test('never inspects or wraps ordinary byte, token, schema or callable-bearing data', async () => {
    const boundary = createHostBoundary()
    const bytes = new Uint8Array([1, 2])
    const identity = createSigningIdentity(new Uint8Array(32).fill(0x75))
    const token = await identity.signToken({ sub: identity.id })
    const schema = { 'chat/echo': { type: 'request', param: { type: 'object' } } }
    let inspections = 0
    const values = [bytes, token, schema, { validate: () => true }].map(
      (value) =>
        new Proxy(value, {
          ownKeys(target) {
            inspections++
            return Reflect.ownKeys(target)
          },
          getOwnPropertyDescriptor(target, key) {
            inspections++
            return Reflect.getOwnPropertyDescriptor(target, key)
          },
        }),
    )
    for (const data of values) {
      const view = boundary.wrap({ data, read: () => data, readAsync: async () => data })
      expect(view.data).toBe(data)
      expect(view.read()).toBe(data)
      expect(await view.readAsync()).toBe(data)
    }
    expect(inspections).toBe(0)
  })

  test('supports frozen host objects and accessor-defined callables with their original receiver', async () => {
    const boundary = createHostBoundary()
    let getterCalls = 0
    const port = Object.freeze({
      value: 7,
      get read() {
        getterCalls++
        return function (this: { value: number }) {
          return this.value
        }
      },
      plain() {
        return this.value
      },
    })
    const wrapped = boundary.wrap(port)
    expect(wrapped.plain()).toBe(7)
    expect(wrapped.read()).toBe(7)
    boundary.close()
    await boundary.drained(Promise.resolve())
    const before = getterCalls
    expect(() => wrapped.read()).toThrow(PeerDisposedError)
    expect(getterCalls).toBe(before)
  })

  test('observes an abandoned rejecting callback while preserving its rejection for callers', async () => {
    const error = new Error('observer failed')
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const boundary = createHostBoundary()
      const callback = boundary.wrap(async () => {
        throw error
      })
      callback()
      boundary.close()
      await boundary.drained(Promise.resolve())
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).not.toHaveBeenCalled()
      const live = createHostBoundary()
      await expect(
        live.wrap(async () => {
          throw error
        })(),
      ).rejects.toBe(error)
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  test('requires close and waits for teardown without starting disposal', async () => {
    const boundary = createHostBoundary()
    await expect(boundary.drained(Promise.resolve())).rejects.toThrow('closed')
    const teardown = gate()
    boundary.close()
    let settled = false
    const drain = boundary.drained(teardown.promise).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    teardown.release()
    await drain
  })
})
