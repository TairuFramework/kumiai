import type { StoredMessage } from '@kumiai/hub-protocol'
import { toB64 } from '@sozai/codec'
import { describe, expect, test, vi } from 'vitest'

import { createEncryptedHubTunnelTransport } from '../src/encrypted-transport.js'
import { encodeEnvelope } from '../src/envelope.js'
import { BackpressureError } from '../src/errors.js'
import type { ObservabilityEvent } from '../src/events.js'
import { encodeFrame, type HubFrame } from '../src/frame.js'
import type { HubReceiveSubscription, MailboxHub } from '../src/transport.js'

const decodeControl = vi.hoisted(() => ({ fail: false }))
vi.mock('../src/frame.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/frame.js')>()
  return {
    ...original,
    decodeFrame: (bytes: Uint8Array) => {
      if (decodeControl.fail) throw new TypeError('unexpected decoder failure')
      return original.decodeFrame(bytes)
    },
  }
})

type Gate = { promise: Promise<void>; release: () => void }
function gate(): Gate {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function fixture(
  options: { ack?: (sequenceID: string) => void | Promise<void>; parkedReturn?: boolean } = {},
) {
  const acked: Array<string> = []
  const pending: Array<StoredMessage> = []
  const outstanding = new Map<string, StoredMessage>()
  const redelivered: Array<string> = []
  const returnedWithAcks: Array<Array<string>> = []
  const readers = new Set<(result: IteratorResult<StoredMessage>) => void>()
  const hub: MailboxHub = {
    publish: async () => ({ sequenceID: 'outbound' }),
    subscribe: () => {},
    unsubscribe: () => {},
    receive: (): HubReceiveSubscription => {
      for (const message of outstanding.values()) {
        pending.push(message)
        redelivered.push(message.sequenceID)
      }
      let closed = false
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            if (closed) return Promise.resolve({ done: true, value: undefined })
            const message = pending.find((item) => !acked.includes(item.sequenceID))
            if (message != null) {
              pending.splice(pending.indexOf(message), 1)
              return Promise.resolve({ done: false, value: message })
            }
            return new Promise<IteratorResult<StoredMessage>>((resolve) => readers.add(resolve))
          },
          return: () => {
            returnedWithAcks.push([...acked])
            closed = true
            if (options.parkedReturn) return new Promise<IteratorResult<StoredMessage>>(() => {})
            for (const resolve of readers) resolve({ done: true, value: undefined })
            readers.clear()
            return Promise.resolve({ done: true, value: undefined })
          },
        }),
        ack: (sequenceID) => {
          acked.push(sequenceID)
          outstanding.delete(sequenceID)
          return options.ack?.(sequenceID)
        },
      }
    },
  }
  const deliver = (sequenceID: string, plaintext: Uint8Array) => {
    const message: StoredMessage = {
      sequenceID,
      senderDID: 'did:peer:remote',
      topicID: 'topic:in',
      payload: encodeEnvelope({ v: 1, groupID: 'group-1', ciphertext: toB64(plaintext) }),
    }
    outstanding.set(sequenceID, message)
    const resolve = readers.values().next().value
    if (resolve != null) {
      readers.delete(resolve)
      resolve({ done: false, value: message })
    } else {
      pending.push(message)
    }
  }
  return { hub, acked, deliver, pending, outstanding, redelivered, returnedWithAcks }
}

const frame = (seq: number): Uint8Array => {
  const value: HubFrame = {
    v: 1,
    sessionID: 'session-1',
    kind: 'message',
    seq,
    body: { header: {}, payload: { typ: 'test', seq } },
  }
  return encodeFrame(value)
}

function transport(
  hub: MailboxHub,
  options: {
    decrypt?: (bytes: Uint8Array) => Promise<Uint8Array>
    inboxCapacity?: number
    drainTimeoutMs?: number
    onEvent?: (event: ObservabilityEvent) => void
    signal?: AbortSignal
  } = {},
) {
  return createEncryptedHubTunnelTransport({
    hub,
    encryptor: {
      encrypt: async (bytes) => bytes,
      decrypt: options.decrypt ?? (async (bytes) => bytes),
    },
    groupID: 'group-1',
    sessionID: 'session-1',
    localDID: 'did:peer:local',
    sendTopicID: 'topic:out',
    receiveTopicID: 'topic:in',
    inboxCapacity: options.inboxCapacity,
    drainTimeoutMs: options.drainTimeoutMs,
    onEvent: options.onEvent,
    signal: options.signal,
  })
}

describe('encrypted tunnel acknowledges spent receive keys', () => {
  test('a decrypt completing during disposal is acked before disposal resolves and is not redelivered', async () => {
    const { hub, acked, deliver, outstanding, redelivered, returnedWithAcks } = fixture()
    const started = gate()
    const release = gate()
    const receiver = transport(hub, {
      decrypt: async (bytes) => {
        started.release()
        await release.promise
        return bytes
      },
    })
    deliver('in-flight', frame(0))
    await started.promise
    const disposing = receiver.dispose()
    release.release()
    await disposing
    expect(acked).toEqual(['in-flight'])
    expect(returnedWithAcks).toEqual([['in-flight']])
    expect(outstanding.size).toBe(0)
    const replacement = transport(hub)
    await replacement.dispose()
    expect(redelivered).toEqual([])
    expect(acked).toEqual(['in-flight'])
  })

  test('a decryptor that aborts the transport synchronously is still drained before close', async () => {
    const { hub, acked, deliver, returnedWithAcks } = fixture()
    const controller = new AbortController()
    const release = gate()
    const receiver = transport(hub, {
      signal: controller.signal,
      decrypt: (bytes) => {
        controller.abort()
        return release.promise.then(() => bytes)
      },
    })
    deliver('aborting', frame(0))
    await vi.waitFor(() => expect(controller.signal.aborted).toBe(true))
    release.release()
    await vi.waitFor(() => expect(acked).toEqual(['aborting']))
    expect(returnedWithAcks).toEqual([['aborting']])
    await receiver.dispose()
  })

  test('acks the decrypted frame that overflows the inbox', async () => {
    const { hub, acked, deliver } = fixture()
    const receiver = transport(hub, { inboxCapacity: 1 })
    deliver('first', frame(0))
    deliver('overflow', frame(1))
    await vi.waitFor(() => expect(acked).toContain('overflow'))
    await expect(receiver.read()).rejects.toBeInstanceOf(BackpressureError)
    await receiver.dispose()
  })

  test('acks a decrypted frame before unexpected frame decode teardown', async () => {
    const { hub, acked, deliver } = fixture()
    decodeControl.fail = true
    const receiver = transport(hub)
    try {
      deliver('bad-frame', frame(0))
      await expect(receiver.read()).rejects.toBeInstanceOf(TypeError)
      expect(acked).toEqual(['bad-frame'])
    } finally {
      decodeControl.fail = false
      await receiver.dispose()
    }
  })

  test('acks a normally handled frame exactly once at the hub', async () => {
    const { hub, acked, deliver } = fixture()
    const receiver = transport(hub)
    deliver('handled', frame(0))
    expect((await receiver.read()).value).toEqual({ header: {}, payload: { typ: 'test', seq: 0 } })
    expect(acked).toEqual(['handled'])
    await receiver.dispose()
  })

  test('disposal does not wait for an idle parked inner next or return', async () => {
    const { hub } = fixture({ parkedReturn: true })
    const receiver = transport(hub)
    await expect(
      Promise.race([
        receiver.dispose(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('dispose hung')), 100)),
      ]),
    ).resolves.toBeUndefined()
  })

  test('a never-settling decrypt expires the drain and reports it', async () => {
    const { hub, deliver, returnedWithAcks } = fixture()
    const started = gate()
    const events: Array<ObservabilityEvent> = []
    const receiver = transport(hub, {
      decrypt: async () => {
        started.release()
        return await new Promise<Uint8Array>(() => {})
      },
      drainTimeoutMs: 20,
      onEvent: (event) => events.push(event),
    })
    deliver('stuck', frame(0))
    await started.promise
    await expect(
      Promise.race([
        receiver.dispose(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('dispose hung')), 200)),
      ]),
    ).resolves.toBeUndefined()
    expect(events).toContainEqual({ type: 'decrypt-drain-timeout', timeoutMs: 20 })
    expect(returnedWithAcks).toEqual([[]])
  })

  test.each(['throw', 'reject'] as const)('reports a hub ack %s without retry', async (failure) => {
    const error = new Error(`ack ${failure}`)
    const { hub, acked, deliver } = fixture({
      ack: () => {
        if (failure === 'throw') throw error
        return Promise.reject(error)
      },
    })
    const events: Array<ObservabilityEvent> = []
    const receiver = transport(hub, { onEvent: (event) => events.push(event) })
    deliver('ack-failure', frame(0))
    await receiver.read()
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: 'ack-failed', sequenceID: 'ack-failure', error }),
    )
    expect(acked).toEqual(['ack-failure'])
    await receiver.dispose()
  })
})
