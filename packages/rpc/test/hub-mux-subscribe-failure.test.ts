import { NotSubscribedError, RetentionExceededError } from '@kumiai/hub-protocol'
import { fromUTF } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import { createHubMux, type SubscribeFailure } from '../src/hub-mux.js'
import {
  createGroupPeer,
  DEFAULT_APP_LOG_RETENTION_SECONDS,
  DEFAULT_COMMIT_LOG_RETENTION_SECONDS,
} from '../src/peer.js'
import { defineGroupProtocol } from '../src/protocol.js'
import { protocolTopic } from '../src/topic.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { DEFAULT_MAX_RETENTION, FakeHub } from './fixtures/fake-hub.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

/** Fast enough to finish inside a test, long enough to be a real schedule rather than a no-op. */
const FAST_RETRIES = [1, 1, 1]

describe('a subscribe the hub refuses', () => {
  test('the refusal reaches the host instead of being swallowed', async () => {
    const hub = new FakeHub({ maxRetention: 100 })
    const failures: Array<SubscribeFailure> = []
    const mux = createHubMux({
      hub,
      localDID: 'bob',
      onSubscribeFailed: (failure) => failures.push(failure),
      subscribeRetryDelaysMs: FAST_RETRIES,
    })

    mux.retainTopic('topic:refused', { retention: 101 })
    await flush()

    // The peer is NOT a subscriber of it — the hub said no.
    expect(hub.subscriberCount('topic:refused')).toBe(0)

    // Surface 1, the notice: the only thing that can reach a host that merely READS a topic.
    expect(failures).toHaveLength(1)
    expect(failures[0]?.topicID).toBe('topic:refused')
    expect(failures[0]?.permanent).toBe(true)
    expect(failures[0]?.error).toBeInstanceOf(RetentionExceededError)

    // Surface 2, the enforcement, which needs no host wiring at all: every operation on the topic
    // fails with the REASON. Before the fix a fetch died of NotSubscribedError — the mux's own
    // unreported failure reported as the caller's mistake — and a publish carried on regardless,
    // so a peer that could receive nothing looked entirely healthy from the outside.
    await expect(mux.fetchTopic({ topicID: 'topic:refused' })).rejects.toThrow(
      RetentionExceededError,
    )
    await expect(
      mux.publish({ topicID: 'topic:refused', payload: fromUTF('x'), retain: 'log' }),
    ).rejects.toThrow(RetentionExceededError)
    await expect(mux.bus.publish('topic:refused', fromUTF('x'))).rejects.toThrow(
      RetentionExceededError,
    )
    await expect(
      mux.mailbox.publish({ senderDID: 'bob', topicID: 'topic:refused', payload: fromUTF('x') }),
    ).rejects.toThrow(RetentionExceededError)

    await mux.dispose()
  })

  test('a refusal leaves no phantom refcount: a later retain asks again', async () => {
    const hub = new FakeHub({ maxRetention: 100 })
    const mux = createHubMux({ hub, localDID: 'bob', subscribeRetryDelaysMs: FAST_RETRIES })

    mux.retainTopic('topic:again', { retention: 101 })
    await flush()
    expect(hub.subscribeAttempts('topic:again')).toBe(1)
    expect(hub.subscriberCount('topic:again')).toBe(0)

    // The old gate was the refcount, which a refused subscribe had already bumped, so this second
    // retain was a no-op forever. The topic is not held, so it is asked for again — and with THIS
    // caller's options, which may be the ones that fit.
    mux.retainTopic('topic:again', { retention: 50 })
    await flush()
    expect(hub.subscribeAttempts('topic:again')).toBe(2)
    expect(hub.subscriberCount('topic:again')).toBe(1)
    expect(hub.requestedRetention('topic:again')).toBe(50)

    // And the latch is cleared with it: the topic works again.
    await expect(mux.fetchTopic({ topicID: 'topic:again' })).resolves.toMatchObject({
      messages: [],
    })

    await mux.dispose()
  })

  test('a transient failure is retried until it succeeds, and is not reported', async () => {
    const hub = new FakeHub()
    const failures: Array<SubscribeFailure> = []
    const mux = createHubMux({
      hub,
      localDID: 'bob',
      onSubscribeFailed: (failure) => failures.push(failure),
      subscribeRetryDelaysMs: FAST_RETRIES,
    })

    // A hub that is unreachable, not one that has answered: two attempts fail, the third lands.
    hub.failSubscribeOnce('topic:flaky', 2)
    mux.retainTopic('topic:flaky', { retention: 60 })
    await flush()

    expect(hub.subscribeAttempts('topic:flaky')).toBe(3)
    expect(hub.subscriberCount('topic:flaky')).toBe(1)
    // A blip that healed is not a host's problem, and reporting it would train hosts to ignore it.
    expect(failures).toEqual([])
    await expect(mux.fetchTopic({ topicID: 'topic:flaky' })).resolves.toMatchObject({
      messages: [],
    })

    await mux.dispose()
  })

  test('a permanent refusal is asked exactly once — no spin against a settled answer', async () => {
    const hub = new FakeHub({ maxRetention: 100 })
    const mux = createHubMux({ hub, localDID: 'bob', subscribeRetryDelaysMs: FAST_RETRIES })

    mux.retainTopic('topic:settled', { retention: 101 })
    await flush()

    // The retry schedule has three entries and none of them is used: the hub has answered, and
    // the answer will not change for the asking.
    expect(hub.subscribeAttempts('topic:settled')).toBe(1)

    await mux.dispose()
  })

  test('a later retain with no window does not quietly settle for the hub default', async () => {
    const hub = new FakeHub({ maxRetention: 100 })
    const mux = createHubMux({ hub, localDID: 'bob', subscribeRetryDelaysMs: FAST_RETRIES })

    mux.retainTopic('topic:downgrade', { retention: 101 })
    await flush()
    expect(hub.subscribeAttempts('topic:downgrade')).toBe(1)

    // A listener registering on the same topic carries no window — a caller with no opinion about
    // retention. Re-asking on its behalf would subscribe at the hub's DEFAULT and clear the latch,
    // leaving the peer subscribed for far less than it asked for and told nothing: precisely the
    // silent downgrade `RetentionExceededError` exists to refuse to perform. So it does not.
    mux.onInbound('topic:downgrade', () => {})
    await flush()
    expect(hub.subscribeAttempts('topic:downgrade')).toBe(1)
    expect(hub.subscriberCount('topic:downgrade')).toBe(0)
    await expect(mux.fetchTopic({ topicID: 'topic:downgrade' })).rejects.toThrow(
      RetentionExceededError,
    )

    // Re-asking for the SAME window is equally pointless — the hub already answered it.
    mux.retainTopic('topic:downgrade', { retention: 101 })
    await flush()
    expect(hub.subscribeAttempts('topic:downgrade')).toBe(1)

    await mux.dispose()
  })

  test('a transient failure that never heals ends as a reported failure, not a silent loop', async () => {
    const hub = new FakeHub()
    const failures: Array<SubscribeFailure> = []
    const mux = createHubMux({
      hub,
      localDID: 'bob',
      onSubscribeFailed: (failure) => failures.push(failure),
      subscribeRetryDelaysMs: [1, 1],
    })

    hub.failSubscribeOnce('topic:dead', 99)
    mux.retainTopic('topic:dead', { retention: 60 })
    await flush()

    // The schedule is exhausted and then it stops: one first attempt plus two retries.
    expect(hub.subscribeAttempts('topic:dead')).toBe(3)
    expect(failures).toHaveLength(1)
    // Reported as NOT permanent — the hub never answered, the retries ran out.
    expect(failures[0]?.permanent).toBe(false)
    await expect(mux.fetchTopic({ topicID: 'topic:dead' })).rejects.toThrow(/injected transport/)

    await mux.dispose()
  })
})

const room = defineGroupProtocol({
  'room/typing': { type: 'event', data: { type: 'object' } },
})

type Protocols = { room: typeof room }

describe('a peer whose app-topic subscribe is refused', () => {
  test('cannot report itself healthy: the host is told and the lane fails loudly', async () => {
    const hub = new FakeHub({ maxRetention: 100 })
    const failures: Array<SubscribeFailure> = []
    const crypto = createFakeCrypto({ epoch: 1, localDID: 'bob' })
    const peer = createGroupPeer<Protocols>({
      hub,
      crypto,
      localDID: 'bob',
      protocols: { room },
      handlers: { room: {} } as never,
      // Above the operator's cap. A hub refuses this rather than clamping it, and before the fix
      // the peer went on as though it held the topic: no frame would ever reach it, and nothing
      // anywhere said so.
      appLogRetentionSeconds: 101,
      onSubscribeFailed: (failure) => failures.push(failure),
    })
    await flush()

    const secret = await crypto.exportSecret()
    const topicID = protocolTopic(secret, 1, 'room')

    expect(hub.subscriberCount(topicID)).toBe(0)
    expect(failures.map((f) => f.topicID)).toEqual([topicID])
    expect(failures[0]?.error).toBeInstanceOf(RetentionExceededError)

    // And a host that wired no callback still cannot mistake this peer for a working one: the
    // lane it cannot receive on is a lane it cannot transmit on either.
    await expect(peer.protocol('room').dispatch('room/typing', { text: 'hi' })).rejects.toThrow(
      RetentionExceededError,
    )

    await peer.dispose()
  })
})

describe('the retention defaults', () => {
  test('sit strictly below the reference hub ceiling, with room for a host to override upward', async () => {
    // Documented as "aligned by choice": the two windows coincide so there is no span in which a
    // member can rebuild its membership but not its messages.
    expect(DEFAULT_APP_LOG_RETENTION_SECONDS).toBe(DEFAULT_COMMIT_LOG_RETENTION_SECONDS)

    // And strictly below the ceiling, not ON it. A default sitting exactly on the ceiling means
    // the documented per-member override has nowhere to go: every upward move is refused, and the
    // peer is then not a subscriber of its own topics.
    expect(DEFAULT_COMMIT_LOG_RETENTION_SECONDS).toBeLessThan(DEFAULT_MAX_RETENTION)

    // The default is accepted by a default hub, and so is a modest override above it.
    const hub = new FakeHub()
    const mux = createHubMux({ hub, localDID: 'bob' })
    mux.retainTopic('topic:default', { retention: DEFAULT_COMMIT_LOG_RETENTION_SECONDS })
    mux.retainTopic('topic:over', { retention: DEFAULT_COMMIT_LOG_RETENTION_SECONDS + 86_400 })
    await flush()
    expect(hub.subscriberCount('topic:default')).toBe(1)
    expect(hub.subscriberCount('topic:over')).toBe(1)
    await mux.dispose()
  })
})

describe('the hub doubles refuse what a real hub refuses', () => {
  // The finding that HID the defect: every double's `subscribe` was infallible, so the mux's
  // failure path was unreachable from the rpc suite and nothing that ran here could see it
  // swallowing. `@kumiai/hub-conformance` runs against `createMemoryStore` alone, so the doubles
  // these suites actually execute against were checked by nothing.
  for (const [name, make] of [
    ['FakeHub', (max: number) => new FakeHub({ maxRetention: max })],
    ['DurableFakeHub', (max: number) => new DurableFakeHub({ maxRetention: max })],
  ] as const) {
    test(`${name} refuses a retention above its ceiling, and never clamps it`, async () => {
      const hub = make(100)
      // Refused, exactly as `memoryStore.subscribe` refuses it and as the conformance suite
      // asserts of any conforming store: `requested > max`, so the ceiling itself is allowed.
      expect(() => hub.subscribe('bob', 'topic:c', { retention: 101 })).toThrow(
        RetentionExceededError,
      )
      // Not clamped, not partially applied: bob is not a subscriber at all, and the hub gates a
      // topic pull on the caller's own subscription.
      await expect(hub.fetchTopic({ subscriberDID: 'bob', topicID: 'topic:c' })).rejects.toThrow(
        NotSubscribedError,
      )
      expect(hub.subscriberCount('topic:c')).toBe(0)

      hub.subscribe('bob', 'topic:c', { retention: 100 })
      expect(hub.subscriberCount('topic:c')).toBe(1)
    })

    test(`${name} defaults its ceiling to the memory store's, so a default fixture is no laxer than a default hub`, () => {
      // A double with a laxer ceiling than the store it stands in for silently stops modelling
      // the one refusal that matters, which is how this went unnoticed the first time.
      expect(DEFAULT_MAX_RETENTION).toBe(2_592_000)
      const hub = name === 'FakeHub' ? new FakeHub() : new DurableFakeHub()
      expect(() =>
        hub.subscribe('bob', 'topic:d', { retention: DEFAULT_MAX_RETENTION + 1 }),
      ).toThrow(RetentionExceededError)
      expect(() =>
        hub.subscribe('bob', 'topic:d', { retention: DEFAULT_MAX_RETENTION }),
      ).not.toThrow()
    })
  }
})
