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
    const dispatcher = createWakeDispatcher({ registry, sender, debounceMs: 60_000 })

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
    const dispatcher = createWakeDispatcher({ registry, sender, debounceMs: 60_000 })

    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    for (const sequenceID of ['002', '003', '004']) {
      dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-b', sequenceID })
    }
    expect(sent).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(60_000)
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
    const dispatcher = createWakeDispatcher({ registry, sender, debounceMs: 60_000 })

    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(65_000)
    expect(sent).toHaveLength(1)
    dispatcher.dispose()
  })

  test('online cancels the trailing ping — the device is already draining', async () => {
    const registry = createMemoryWakeRegistry()
    await registry.put(registration)
    const { sender, sent } = createRecordingSender()
    const dispatcher = createWakeDispatcher({ registry, sender, debounceMs: 60_000 })

    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '002' })
    dispatcher.online('did:key:alice')

    await vi.advanceTimersByTimeAsync(65_000)
    expect(sent).toHaveLength(1)
    dispatcher.dispose()
  })

  // `sent` staying at 1 above is satisfied just as well by an `online` that cancelled the timer but
  // LEFT the entry in `pending`. That stale entry is silent and permanent: every later `notify`
  // takes the "window already open" branch and increments a counter behind a dead timer, so the
  // device is never woken again for the life of the process. Only a fresh leading edge afterwards
  // distinguishes the two.
  test('online clears the entry, so the next frame is a fresh leading edge', async () => {
    const registry = createMemoryWakeRegistry()
    await registry.put(registration)
    const { sender, sent } = createRecordingSender()
    const dispatcher = createWakeDispatcher({ registry, sender, debounceMs: 60_000 })

    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '002' })
    dispatcher.online('did:key:alice')

    // The device went back to sleep and a new frame landed. It must ping IMMEDIATELY, with a
    // `count` restarted at 1 — not be folded into the window `online` was supposed to have closed.
    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-c', sequenceID: '003' })
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(openWakeHint(sent[1].body, opener)).toEqual({
      topicID: 'topic-c',
      sequenceID: '003',
      count: 1,
    })
    dispatcher.dispose()
  })

  // The re-arm behind a trailing summary. Without it, the summary leaves no window, so the very
  // next frame pings immediately and the coalescing the debounce exists for is undone — roughly
  // double the ping rate under sustained traffic, which no other assertion here would notice.
  test('a fresh window opens behind the trailing summary, so traffic stays coalesced', async () => {
    const registry = createMemoryWakeRegistry()
    await registry.put(registration)
    const { sender, sent } = createRecordingSender()
    const dispatcher = createWakeDispatcher({ registry, sender, debounceMs: 60_000 })

    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '002' })
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(sent).toHaveLength(2))

    // Traffic is still flowing. This frame must be SUPPRESSED into the window the summary re-armed,
    // not treated as a fresh leading edge.
    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '003' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent).toHaveLength(2)

    // …and collected by that window's own summary when it closes.
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(sent).toHaveLength(3))
    expect(openWakeHint(sent[2].body, opener)).toEqual({
      topicID: 'topic-a',
      sequenceID: '003',
      count: 1,
    })
    dispatcher.dispose()
  })

  test('sends nothing for a DID with no registration', async () => {
    const registry = createMemoryWakeRegistry()
    const { sender, sent } = createRecordingSender()
    const dispatcher = createWakeDispatcher({ registry, sender, debounceMs: 60_000 })

    dispatcher.notify({ did: 'did:key:nobody', topicID: 'topic-a', sequenceID: '001' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(sent).toHaveLength(0)
    dispatcher.dispose()
  })

  test('a gone verdict deletes the registration', async () => {
    const registry = createMemoryWakeRegistry()
    await registry.put(registration)
    const { sender } = createRecordingSender('gone')
    const dispatcher = createWakeDispatcher({ registry, sender, debounceMs: 60_000 })

    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' })
    await vi.waitFor(async () => {
      expect(await registry.get('did:key:alice')).toBeNull()
    })
    dispatcher.dispose()
  })

  test('a retry verdict reports and keeps the registration', async () => {
    const registry = createMemoryWakeRegistry()
    await registry.put(registration)
    const { sender, sent } = createRecordingSender('retry')
    const errors: Array<{ did: string }> = []
    const dispatcher = createWakeDispatcher({
      registry,
      sender,
      debounceMs: 60_000,
      onError: (params) => errors.push({ did: params.did }),
    })

    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' })
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    // Proves the error came out of the `retry` branch, not from an exception upstream of
    // `sender.send` (which would also produce one error and leave the registration untouched).
    expect(sent).toHaveLength(1)
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
      debounceMs: 60_000,
      onError: (params) => errors.push(params.error),
    })

    expect(() =>
      dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' }),
    ).not.toThrow()
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    // Identifies the error as the one the fake sender threw, not some other exception that
    // happens to leave `errors` at length 1 (e.g. one thrown upstream of `sender.send`).
    expect(errors[0]).toBeInstanceOf(Error)
    expect((errors[0] as Error).message).toBe('provider exploded')
    dispatcher.dispose()
  })

  test('dispose cancels a pending trailing ping and rejects any notify after teardown', async () => {
    const registry = createMemoryWakeRegistry()
    await registry.put(registration)
    const { sender, sent } = createRecordingSender()
    const dispatcher = createWakeDispatcher({ registry, sender, debounceMs: 60_000 })

    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    // Arms a pending trailing summary before teardown, so a live `clearTimeout` loop is required
    // to stop it.
    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '002' })
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    dispatcher.dispose()
    // Resource fact, not a behavioural one: the timer callback already bails out once `pending`
    // is cleared (it reads `pending.get(did)` first and finds nothing), so an uncancelled timer
    // is inert by construction and a missing `clearTimeout` loop would not show up in `sent`.
    // `vi.getTimerCount()` is what actually distinguishes "cancelled" from "merely made harmless".
    expect(vi.getTimerCount()).toBe(0)
    // Must be a no-op: the `disposed` guard, not merely an emptied pending map (`pending` was
    // cleared by dispose, so without the guard this would open a brand-new leading-edge window).
    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '003' })

    await vi.advanceTimersByTimeAsync(65_000)
    expect(sent).toHaveLength(1)
  })

  test('a hanging sender never delays notify, and the window still coalesces behind it', async () => {
    const registry = createMemoryWakeRegistry()
    await registry.put(registration)
    const sent: Array<{ registration: WakeRegistration; body: Uint8Array }> = []
    const order: Array<string> = []
    const sender: WakeSender = {
      send(params) {
        order.push('sender:called')
        sent.push(params)
        // Never resolves: a hanging provider must not block the caller or the coalescing window.
        return new Promise<never>(() => {})
      },
    }
    const dispatcher = createWakeDispatcher({ registry, sender, debounceMs: 60_000 })

    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' })
    order.push('notify:returned')
    // Structural, not wall-clock: `send` runs inside the fire-and-forget async task, which only
    // starts once the current synchronous call stack — including this `notify()` call — has
    // unwound. If `notify` ever awaited the sender directly, `sender:called` would already be in
    // `order` by this point.
    expect(order).toEqual(['notify:returned'])
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '002' })
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    dispatcher.dispose()
  })
})
