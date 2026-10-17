import { stdout } from 'node:process'
import { createSigningIdentity } from '@kokuin/token'
import { afterEach, describe, expect, expectTypeOf, test, vi } from 'vitest'

import { checkpointServiceHostMembers } from '../src/checkpoint.js'
import type { CheckpointService } from '../src/checkpoint-types.js'
import type { PendingRecovery } from '../src/crypto.js'
import { PeerDisposedError } from '../src/errors.js'
import {
  capturedRecoveryHostMembers,
  checkpointHostMembers,
  createHostBoundary,
  peerHostFields,
  pendingRecoveryHostMembers,
  recoveryRequestHostParameters,
  wrapPeerHost,
  wrapPendingRecovery,
} from '../src/host-boundary.js'
import { notifyHost } from '../src/host-notice.js'
import type { GroupPeerMLSParams, GroupPeerParams } from '../src/peer.js'
import type { GroupProtocolDefinition } from '../src/protocol.js'

afterEach(() => vi.restoreAllMocks())

test('recovery comparison epoch crosses the host boundary as data', async () => {
  expect(recoveryRequestHostParameters).toEqual(['data', 'data', 'data'])
  const createRecoveryRequest = vi.fn(
    async (_id: string, _deadline?: number, _comparison?: number) => ({
      request: new Uint8Array([1]),
      requestKey: new Uint8Array(32),
    }),
  )
  const host = wrapPeerHost(createHostBoundary(), { mls: { createRecoveryRequest } })
  await host.mls.createRecoveryRequest('comparison', 30000, 12)
  expect(createRecoveryRequest).toHaveBeenCalledWith('comparison', 30000, 12)
})

test.each(['checkRosterAbsence', 'sealRosterAbsence', 'authoriseForkRecovery'] as const)(
  'captured recovery host operation drains and fences disposal: %s',
  async (name) => {
    expect(capturedRecoveryHostMembers).toHaveProperty(name, 'host')
    const boundary = createHostBoundary()
    const pause = gate()
    const callback = vi.fn(async () => {
      await pause.promise
      return null
    })
    const host = wrapPeerHost(boundary, { mls: { capturedRecovery: { [name]: callback } } })
    const invoke = Reflect.get(host.mls.capturedRecovery, name) as () => Promise<null>
    const pending = invoke()
    boundary.close()
    let drained = false
    const draining = boundary.drained(Promise.resolve()).then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    pause.release()
    await pending
    await draining
    expect(() => invoke()).toThrow(PeerDisposedError)
    expect(callback).toHaveBeenCalledOnce()
  },
)

test.each(Object.keys(checkpointServiceHostMembers))(
  'checkpoint service survives host wrapping: %s',
  async (name) => {
    const boundary = createHostBoundary()
    const pause = gate()
    const input = { bytes: new Uint8Array([7]) }
    const output = { bytes: new Uint8Array([9]) }
    let received: typeof input | undefined
    const callback = vi.fn(async (value: typeof input) => {
      received = value
      await pause.promise
      return output
    })
    const service = Object.fromEntries(
      Object.keys(checkpointServiceHostMembers).map((method) => [method, callback]),
    ) as unknown as CheckpointService
    const host = wrapPeerHost(boundary, { checkpoints: service })
    expect(peerHostFields).toHaveProperty('checkpoints', 'port')
    const invoke = Reflect.get(host.checkpoints, name) as (
      value: typeof input,
    ) => Promise<typeof output>
    const pending = invoke(input)
    input.bytes[0] = 8
    expect(received?.bytes).toEqual(new Uint8Array([7]))
    boundary.close()
    let drained = false
    const draining = boundary.drained(Promise.resolve()).then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    pause.release()
    const result = await pending
    result.bytes[0] = 10
    expect(output.bytes).toEqual(new Uint8Array([9]))
    await draining
    expect(() => invoke(input)).toThrow(PeerDisposedError)
    expect(callback).toHaveBeenCalledOnce()
  },
)

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
  pause.release()
  await call
  await drain
  expect(settled).toBe(true)
  expect(() => callable()).toThrow(PeerDisposedError)
}

describe('host invocation boundary', () => {
  test('keeps core safety subscriptions live after host callbacks close', async () => {
    const boundary = createHostBoundary()
    const sinks = new Set<(reason: 'fork-halted') => void>()
    const host = wrapPeerHost(boundary, {
      mls: {
        onSafetyHold(latch: (reason: 'fork-halted') => void) {
          sinks.add(latch)
          return () => {
            sinks.delete(latch)
          }
        },
      },
    })
    boundary.close()
    await boundary.drained(Promise.resolve())
    const held: Array<string> = []
    const unsubscribe = host.mls.onSafetyHold((reason) => held.push(reason))
    for (const sink of sinks) sink('fork-halted')
    expect(held).toEqual(['fork-halted'])
    unsubscribe()
    for (const sink of sinks) sink('fork-halted')
    expect(held).toEqual(['fork-halted'])
  })

  test('nullable core safety subscription fences late and malformed host notifications', () => {
    const boundary = createHostBoundary()
    let supply: ((reason: unknown) => void) | undefined
    const host = wrapPeerHost(boundary, {
      mls: {
        onSafetyChanged(sink: (reason: unknown) => void) {
          supply = sink
          return () => {}
        },
      },
    })
    const reasons: Array<unknown> = []
    const unsubscribe = host.mls.onSafetyChanged((reason) => {
      reasons.push(reason)
    })
    supply?.('fork-halted')
    supply?.({ reason: null })
    supply?.(null)
    unsubscribe()
    supply?.('recovery-unavailable')
    expect(reasons).toEqual(['fork-halted', null])
  })

  test('waits for a paused method and refuses its later invocation', async () => {
    const output = vi.spyOn(stdout, 'write').mockImplementation(() => true)
    await assertPaused('host.write', async (pause) => {
      await pause
    })
    expect(output).not.toHaveBeenCalled()
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
      markBindingUnusable: () => {},
      serialize: () => bytes,
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
    const recovery = wrapPendingRecovery(boundary, receiver)
    expect(recovery.commit).toBe(bytes)
    const accepting = recovery.onAccepted(() => ({
      mutationID: crypto.randomUUID(),
      changes: { deleteRejoin: true },
    }))
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
    expect(() =>
      recovery.onAccepted(() => ({
        mutationID: crypto.randomUUID(),
        changes: { deleteRejoin: true },
      })),
    ).toThrow(PeerDisposedError)
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
    expect(peerHostFields.hub).toBe('transport')
    expect(peerHostFields.runtime).toBe('runtime')
    expect(peerHostFields.protocols).toBe('data')
    expect(peerHostFields.handlers).toBe('handlers')
    expect(peerHostFields.appOutbox).toBe('port')
    expect(peerHostFields.appOutboxLimit).toBe('data')
    expect(peerHostFields.onAppOutboxCleared).toBe('callback')
    expect(pendingRecoveryHostMembers.onAccepted).toBe('host')
    expect(pendingRecoveryHostMembers.epoch).toBe('data')
    expect(pendingRecoveryHostMembers.confirmationKey).toBe('host')
    expect(pendingRecoveryHostMembers.judgeVerdict).toBe('host')
  })

  test('counts a notice even though notifyHost abandons its promise and swallows errors', async () => {
    const output = vi.spyOn(stdout, 'write').mockImplementation(() => true)
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
    expect(output).not.toHaveBeenCalled()
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

test('validation host methods drain and refuse after dispose', async () => {
  const boundary = createHostBoundary()
  const pause = gate()
  const source = {
    key: { groupID: 'group', incarnation: 1 },
    stateVersion: 1,
    identity: { groupID: 'group', incarnation: 1, epoch: 1, authenticator: new Uint8Array([1]) },
  }
  const validation = {
    source,
    readCommitHeader: async () => null,
    verifyOwn: async () => false,
    validateFrame: async () => {
      await pause.promise
      return { kind: 'unavailable' as const, reason: 'missing-key' as const }
    },
  }
  const selected = wrapPeerHost(boundary, {
    validation: { restoreValidation: async () => validation },
  })
  const restored = await selected.validation.restoreValidation()
  const validating = restored.validateFrame()
  boundary.close()
  let drained = false
  const drainage = boundary.drained(Promise.resolve()).then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  expect(restored.source).toBe(source)
  pause.release()
  await validating
  await drainage
  expect(drained).toBe(true)
  await expect(selected.validation.restoreValidation()).rejects.toBeInstanceOf(PeerDisposedError)
  expect(() => restored.readCommitHeader()).toThrow(PeerDisposedError)
  expect(() => restored.validateFrame()).toThrow(PeerDisposedError)
  expect(() => restored.verifyOwn()).toThrow(PeerDisposedError)
})

test('captured authentication and returned acceptance are drained and preserve caller errors', async () => {
  const boundary = createHostBoundary()
  const pause = gate()
  const failure = new Error('capture reader failed')
  const captured = {
    async applyRecovery() {
      await pause.promise
      throw failure
    },
    async restoreRecovery() {
      throw failure
    },
    async reconcileCapture() {
      throw failure
    },
    async sealGroupInfo() {
      throw failure
    },
  }
  const selected = wrapPeerHost(boundary, { mls: { capturedRecovery: captured } })
  const work = selected.mls.capturedRecovery.applyRecovery()
  boundary.close()
  let drained = false
  const draining = boundary.drained(Promise.resolve()).then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  pause.release()
  await expect(work).rejects.toBe(failure)
  await draining
  expect(drained).toBe(true)
  expect(() => selected.mls.capturedRecovery.reconcileCapture()).toThrow(PeerDisposedError)
})

test('captured returned callbacks drain acceptance and expose source as data', async () => {
  const boundary = createHostBoundary()
  const pause = gate()
  const source = Object.freeze({ key: { groupID: 'g', incarnation: 1 } })
  const target = Object.freeze({ targetID: 'hub' })
  const pending = {
    source,
    target,
    epoch: 1,
    commit: new Uint8Array([1]),
    serialize: () => new Uint8Array(),
    markBindingUnusable() {},
    confirmationKey: async () => new Uint8Array(),
    judgeVerdict: () => 'advisory',
    async onAccepted() {
      await pause.promise
    },
  }
  const selected = wrapPeerHost(boundary, {
    mls: {
      capturedRecovery: {
        applyRecovery: async () => pending,
        restoreRecovery: async () => pending,
        reconcileCapture: async () => ({ kind: 'retry' }),
        sealGroupInfo: async () => new Uint8Array(),
      },
    },
  })
  const restored = await selected.mls.capturedRecovery.restoreRecovery()
  expect(restored.source).toBe(source)
  expect(restored.target).toBe(target)
  const accepting = restored.onAccepted()
  boundary.close()
  let drained = false
  const draining = boundary.drained(Promise.resolve()).then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  pause.release()
  await accepting
  await draining
  expect(() => restored.serialize()).toThrow(PeerDisposedError)
  expect(() => restored.onAccepted()).toThrow(PeerDisposedError)
})

test.each(Object.keys(checkpointHostMembers))(
  'checkpoint %s drains before disposal',
  async (method) => {
    await assertPaused(`checkpoints.${method}`, (pause) => pause)
  },
)

test('dispose drains late condition callbacks', async () => {
  expect(peerHostFields).toHaveProperty('onNotMember', 'callback')
  const boundary = createHostBoundary()
  const pause = gate()
  const onNotMember = vi.fn(
    async (_input: { evidence: Uint8Array; requestID: string; requestKey: Uint8Array }) => {
      await pause.promise
    },
  )
  const host = wrapPeerHost(boundary, { onNotMember })
  const pending = host.onNotMember({
    evidence: new Uint8Array([1]),
    requestID: 'request',
    requestKey: new Uint8Array(32),
  })
  boundary.close()
  let drained = false
  const draining = boundary.drained(Promise.resolve()).then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  pause.release()
  await pending
  await draining
  expect(() =>
    host.onNotMember({
      evidence: new Uint8Array(),
      requestID: 'late',
      requestKey: new Uint8Array(32),
    }),
  ).toThrow(PeerDisposedError)
  expect(onNotMember).toHaveBeenCalledOnce()
})
