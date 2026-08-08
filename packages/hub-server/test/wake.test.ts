import { openWakeHint, type WakeRegistration, type WakeSender } from '@kumiai/hub-protocol'
import { createMemoryWakeRegistry } from '@kumiai/hub-wake'
import { p256 } from '@noble/curves/nist.js'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createWakeDispatcher } from '../src/wake.js'

const privateKey = p256.utils.randomSecretKey()
const authSecret = crypto.getRandomValues(new Uint8Array(16))
const opener = { privateKey, authSecret }

const registration: WakeRegistration = {
  did: 'did:key:alice',
  kind: 'webpush',
  endpoint: 'https://push.example/alice',
  publicKey: Buffer.from(p256.getPublicKey(privateKey, false)).toString('base64url'),
  authSecret: Buffer.from(authSecret).toString('base64url'),
}

function createRecordingSender(verdict: 'delivered' | 'gone' | 'retry' = 'delivered') {
  const sent: Array<{ registration: WakeRegistration; body: Uint8Array }> = []
  const sender: WakeSender = {
    async send(params) {
      sent.push(params)
      return verdict
    },
  }
  return { sender, sent }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createWakeDispatcher', () => {
  test('sends immediately on the first frame — the leading edge', async () => {
    const registry = createMemoryWakeRegistry()
    await registry.put(registration)
    const { sender, sent } = createRecordingSender()
    const dispatcher = createWakeDispatcher({ registry, sender, debounceMs: 1000 })

    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    expect(openWakeHint(sent[0].body, opener)).toEqual({
      topicID: 'topic-a',
      sequenceID: '001',
      count: 1,
    })
    dispatcher.dispose()
  })

  test('coalesces a burst into one trailing ping carrying the latest frame', async () => {
    const registry = createMemoryWakeRegistry()
    await registry.put(registration)
    const { sender, sent } = createRecordingSender()
    const dispatcher = createWakeDispatcher({ registry, sender, debounceMs: 1000 })

    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    for (const sequenceID of ['002', '003', '004']) {
      dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-b', sequenceID })
    }
    expect(sent).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(openWakeHint(sent[1].body, opener)).toEqual({
      topicID: 'topic-b',
      sequenceID: '004',
      count: 3,
    })
    dispatcher.dispose()
  })

  test('no trailing ping when nothing followed the leading edge', async () => {
    const registry = createMemoryWakeRegistry()
    await registry.put(registration)
    const { sender, sent } = createRecordingSender()
    const dispatcher = createWakeDispatcher({ registry, sender, debounceMs: 1000 })

    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(5000)
    expect(sent).toHaveLength(1)
    dispatcher.dispose()
  })

  test('online cancels the trailing ping — the device is already draining', async () => {
    const registry = createMemoryWakeRegistry()
    await registry.put(registration)
    const { sender, sent } = createRecordingSender()
    const dispatcher = createWakeDispatcher({ registry, sender, debounceMs: 1000 })

    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '002' })
    dispatcher.online('did:key:alice')

    await vi.advanceTimersByTimeAsync(5000)
    expect(sent).toHaveLength(1)
    dispatcher.dispose()
  })

  test('sends nothing for a DID with no registration', async () => {
    const registry = createMemoryWakeRegistry()
    const { sender, sent } = createRecordingSender()
    const dispatcher = createWakeDispatcher({ registry, sender, debounceMs: 1000 })

    dispatcher.notify({ did: 'did:key:nobody', topicID: 'topic-a', sequenceID: '001' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(sent).toHaveLength(0)
    dispatcher.dispose()
  })

  test('a gone verdict deletes the registration', async () => {
    const registry = createMemoryWakeRegistry()
    await registry.put(registration)
    const { sender } = createRecordingSender('gone')
    const dispatcher = createWakeDispatcher({ registry, sender, debounceMs: 1000 })

    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' })
    await vi.waitFor(async () => {
      expect(await registry.get('did:key:alice')).toBeNull()
    })
    dispatcher.dispose()
  })

  test('a retry verdict reports and keeps the registration', async () => {
    const registry = createMemoryWakeRegistry()
    await registry.put(registration)
    const { sender } = createRecordingSender('retry')
    const errors: Array<{ did: string }> = []
    const dispatcher = createWakeDispatcher({
      registry,
      sender,
      debounceMs: 1000,
      onError: (params) => errors.push({ did: params.did }),
    })

    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' })
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(await registry.get('did:key:alice')).not.toBeNull()
    dispatcher.dispose()
  })

  test('a throwing sender is reported, not propagated', async () => {
    const registry = createMemoryWakeRegistry()
    await registry.put(registration)
    const errors: Array<unknown> = []
    const dispatcher = createWakeDispatcher({
      registry,
      sender: {
        async send() {
          throw new Error('provider exploded')
        },
      },
      debounceMs: 1000,
      onError: (params) => errors.push(params.error),
    })

    expect(() =>
      dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' }),
    ).not.toThrow()
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    dispatcher.dispose()
  })
})
