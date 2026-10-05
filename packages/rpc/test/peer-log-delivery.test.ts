import { decodeFrame, encodeEventFrame } from '@kumiai/broadcast'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { AppOutboxCleared } from '../src/log-delivery.js'
import type { RecoveryEvent, StrandObservation } from '../src/peer.js'
import { commitTopic, protocolTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryAppOutbox } from './fixtures/outbox.js'
import {
  buildLedgerCommit,
  buildRemoveCommit,
  makeMLSPeer,
  type TestPeer,
} from './fixtures/peer.js'
import { controlRecoveryClock, drainUntil } from './fixtures/recovery-clock.js'
import { deferred } from './fixtures/single-connection-host.js'

describe('recovery ordering', { concurrent: false }, () => {
  const secret = new Uint8Array(32).fill(15)
  const cleanup: Array<TestPeer> = []
  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map(async ({ peer }) => {
        await peer.dispose()
        await peer.drained()
      }),
    )
    vi.restoreAllMocks()
  })
  const flush = () => new Promise((resolve) => setTimeout(resolve, 60))
  function member(
    hub: FakeHub | DurableFakeHub,
    did: string,
    options: Parameters<typeof makeMLSPeer>[3] = {},
  ) {
    const result = makeMLSPeer(hub, did, secret, { members: ['alice', 'bob', 'carol'], ...options })
    cleanup.push(result)
    return result
  }

  test.each([false, true])(
    'detached sender catches up before publishing across roster change %s',
    async (roster) => {
      const hub = new DurableFakeHub()
      const received: Array<unknown> = []
      const alice = member(hub, 'alice', {
        handlers: { 'chat/posted': (ctx: { data: unknown }) => received.push(ctx.data) },
      })
      const bob = member(hub, 'bob')
      await flush()
      hub.detach('bob')
      await publishCommit({
        hub,
        senderDID: 'carol',
        recoverySecret: secret,
        epoch: 1,
        ...(roster ? { removes: ['carol'] } : {}),
      })
      await alice.peer.resync()
      const plaintext = { text: 'accepted while behind' }
      await bob.peer.protocol('chat').dispatch('chat/posted', { data: plaintext })
      await flush()
      expect(received).toEqual([plaintext])
      expect(bob.mls.epoch()).toBe(2)
      expect(await bob.appOutbox.list()).toEqual([])
    },
  )

  test('safe publication is acknowledged once and frees durable capacity', async () => {
    const hub = new FakeHub()
    const received: Array<unknown> = []
    member(hub, 'alice', {
      handlers: { 'chat/posted': (ctx: { data: unknown }) => received.push(ctx.data) },
    })
    const bob = member(hub, 'bob', { appOutboxLimit: 1 })
    await flush()
    await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'first' } })
    await flush()
    expect(received).toEqual([{ text: 'first' }])
    expect(await bob.appOutbox.list()).toEqual([])
    await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'second' } })
    await flush()
    expect(received).toEqual([{ text: 'first' }, { text: 'second' }])
    expect(hub.published.filter((m) => m.topicID !== commitTopic(secret))).toHaveLength(2)
  })

  test('two commits in one catch-up never publish at the intermediate epoch', async () => {
    const hub = new DurableFakeHub()
    const bob = member(hub, 'bob')
    await flush()
    hub.detach('bob')
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 1 })
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 2 })
    const epochs: Array<number | null> = []
    const wrap = bob.crypto.wrap.bind(bob.crypto)
    vi.spyOn(bob.crypto, 'wrap').mockImplementation(async (...args) => {
      const sealed = await wrap(...args)
      epochs.push(bob.crypto.frameEpoch(sealed))
      return sealed
    })
    await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'latest' } })
    await flush()
    expect(epochs).toEqual([3])
  })

  test('removeFailureRetriesRemovalOnly', async () => {
    const hub = new FakeHub()
    const store = createMemoryAppOutbox()
    let removals = 0
    const bob = member(hub, 'bob', {
      appOutbox: {
        ...store,
        remove: async (seq) => {
          if (++removals === 1) throw new Error('disk unavailable')
          await store.remove(seq)
        },
      },
    })
    await flush()
    await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'once' } })
    await flush()
    expect(removals).toBe(1)
    expect(await store.list()).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(await store.list()).toEqual([])
    expect(removals).toBe(2)
    expect(hub.published).toHaveLength(1)
  })

  test('own acceptance window holds publication until adoption finishes', async () => {
    const hub = new FakeHub()
    const gate = deferred<void>()
    const entered = deferred<void>()
    const bob = member(hub, 'bob')
    await flush()
    const original = bob.journal.markAccepted.bind(bob.journal)
    vi.spyOn(bob.journal, 'markAccepted').mockImplementation(async (...args) => {
      await original(...args)
      entered.resolve()
      await gate.promise
    })
    const committing = bob.peer.commit(buildLedgerCommit(bob, []))
    await entered.promise
    await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'window' } })
    await flush()
    expect(hub.published).toHaveLength(1)
    gate.resolve()
    await committing
    await flush()
    const apps = hub.published.filter((m) => m.topicID !== commitTopic(secret))
    expect(apps).toHaveLength(1)
    const app = apps[0]
    if (app == null) throw new Error('Missing application frame')
    expect(bob.crypto.frameEpoch(app.payload)).toBe(2)
  })

  test.each([
    { name: 'live', Hub: FakeHub },
    { name: 'durable', Hub: DurableFakeHub },
  ])(
    'physical removal reports gaps but removal of the cursor alone does not ($name)',
    async ({ Hub }) => {
      const hub = new Hub()
      hub.subscribe('reader', 'topic')
      const a = await hub.publish({
        senderDID: 'alice',
        topicID: 'topic',
        payload: new Uint8Array([1]),
        retain: 'log',
      })
      const b = await hub.publish({
        senderDID: 'alice',
        topicID: 'topic',
        payload: new Uint8Array([2]),
        retain: 'log',
      })
      hub.trim('topic', b.sequenceID)
      expect(
        await hub.fetchTopic({ subscriberDID: 'reader', topicID: 'topic', after: a.sequenceID }),
      ).toMatchObject({ gap: false })
      hub.trim('topic', '999999999999')
      expect(
        await hub.fetchTopic({ subscriberDID: 'reader', topicID: 'topic', after: a.sequenceID }),
      ).toMatchObject({ gap: true, head: b.sequenceID, messages: [] })
      expect(
        await hub.fetchTopic({ subscriberDID: 'reader', topicID: 'topic', after: b.sequenceID }),
      ).toMatchObject({ gap: false })
    },
  )

  test.each(['probe', 'put', 'publish', 'seal'] as const)(
    'retries a failed %s without another lane trigger',
    async (failure) => {
      const hub = new FakeHub()
      const store = createMemoryAppOutbox()
      let failed = false
      const bob = member(hub, 'bob', {
        appOutbox: {
          ...store,
          put: async (row) => {
            if (failure === 'put' && row.lastAttempt != null && !failed) {
              failed = true
              throw new Error('prepared write failed')
            }
            await store.put(row)
          },
        },
      })
      const received: Array<unknown> = []
      member(hub, 'alice', {
        handlers: { 'chat/posted': (ctx: { data: unknown }) => received.push(ctx.data) },
      })
      await flush()
      if (failure === 'probe') {
        const fetch = hub.fetchTopic.bind(hub)
        vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
          if (params.subscriberDID === 'bob' && params.topicID === commitTopic(secret) && !failed) {
            failed = true
            throw new Error('probe unavailable')
          }
          return fetch(params)
        })
      }
      if (failure === 'publish') {
        const publish = hub.publish.bind(hub)
        vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
          if (params.senderDID === 'bob' && params.retain === 'log' && !failed) {
            failed = true
            throw new Error('publish unavailable')
          }
          return publish(params)
        })
      }
      if (failure === 'seal') {
        const wrap = bob.crypto.wrap.bind(bob.crypto)
        vi.spyOn(bob.crypto, 'wrap').mockImplementation(async (...args) => {
          if (!failed) {
            failed = true
            throw new Error('seal unavailable')
          }
          return wrap(...args)
        })
      }
      await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: failure } })
      await flush()
      expect(failed).toBe(true)
      expect(await store.list()).toHaveLength(1)
      expect(hub.published).toEqual([])
      await vi.waitFor(async () => expect(await store.list()).toEqual([]), { timeout: 1800 })
      expect(received).toEqual([{ text: failure }])
      expect(hub.published).toHaveLength(1)
    },
  )

  test('covered poison walk certifies an acknowledged publication without resealing', async () => {
    const hub = new DurableFakeHub()
    const bob = member(hub, 'bob')
    await flush()
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 1 })
    await bob.peer.replay()
    hub.detach('bob')
    const publish = hub.publish.bind(hub)
    let injected = false
    vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
      const result = await publish(params)
      if (
        params.senderDID === 'bob' &&
        params.topicID !== commitTopic(secret) &&
        params.retain === 'log' &&
        !injected
      ) {
        injected = true
        await publish({
          senderDID: 'mallory',
          topicID: commitTopic(secret),
          payload: new Uint8Array([0]),
          retain: 'log',
        })
      }
      return result
    })
    await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'poison' } })
    await vi.waitFor(async () => expect(await bob.appOutbox.list()).toEqual([]))
    expect(hub.published.filter((m) => m.senderDID === 'bob')).toHaveLength(1)
    expect(bob.mls.epoch()).toBe(2)
  })

  test.each([false, true])(
    'trimmed commit behind publication rejoins and delivers with retained tail %s',
    async (tail) => {
      controlRecoveryClock()
      const hub = new DurableFakeHub()
      const received: Array<unknown> = []
      const notices: Array<StrandObservation> = []
      const alice = member(hub, 'alice', {
        handlers: { 'chat/posted': (ctx: { data: unknown }) => received.push(ctx.data) },
        recovery: { timeoutMs: 30, deadlineMs: 500, getDelayMs: () => 0 },
      })
      const bob = member(hub, 'bob', {
        onStrand: (notice) => {
          notices.push(notice)
        },
        onRecovery: (event) => {
          if (event.phase === 'started') hub.reattach('bob')
        },
        recovery: { timeoutMs: 30, deadlineMs: 500, getDelayMs: () => 0 },
      })
      await Promise.all([alice.peer.resync(), bob.peer.resync()])
      await alice.peer.commit(buildLedgerCommit(alice, []))
      await bob.peer.replay()
      hub.detach('bob')
      const publish = hub.publish.bind(hub)
      let injected = false
      vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
        if (
          params.senderDID === 'bob' &&
          params.topicID !== commitTopic(secret) &&
          params.retain === 'log' &&
          !injected
        ) {
          injected = true
          await alice.peer.commit(buildLedgerCommit(alice, []))
          if (tail)
            await publish({
              senderDID: 'mallory',
              topicID: commitTopic(secret),
              payload: new Uint8Array([0]),
              retain: 'log',
            })
          const head = hub.head(commitTopic(secret))
          if (head == null) throw new Error('Missing commit head')
          hub.trim(commitTopic(secret), tail ? head : '999999999999')
        }
        return publish(params)
      })
      await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'rejoined' } })
      await drainUntil(() => received.length === 1)
      expect(received).toEqual([{ text: 'rejoined' }])
      expect(notices[0]).toMatchObject({
        kind: 'retention-gap',
        confidence: 'claimed',
        commitDigest: null,
        claimedEpoch: null,
      })
      expect(bob.mls.epoch()).toBe(alice.mls.epoch())
      expect(
        hub.published.filter(
          (m) => m.senderDID === 'bob' && bob.crypto.frameEpoch(m.payload) != null,
        ),
      ).toHaveLength(2)
    },
  )

  test('lapse after enqueue holds the durable entry until renewal', async () => {
    const hub = new FakeHub()
    const store = createMemoryAppOutbox()
    const gate = deferred<void>()
    const entered = deferred<void>()
    const bob = member(hub, 'bob', {
      appOutbox: {
        ...store,
        put: async (row) => {
          if (row.lastAttempt == null) {
            entered.resolve()
            await gate.promise
          }
          await store.put(row)
        },
      },
    })
    await flush()
    const dispatch = bob.peer
      .protocol('chat')
      .dispatch('chat/posted', { data: { text: 'renewed' } })
    await entered.promise
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 1 })
    await bob.peer.replay()
    const admission = vi
      .spyOn(bob.mls, 'sendAdmission')
      .mockReturnValue({ epoch: 2, admissible: false, reason: 'lapsed' })
    gate.resolve()
    await dispatch
    await flush()
    expect(await store.list()).toMatchObject([{ lastAttempt: null }])
    expect(hub.published.filter((m) => m.senderDID === 'bob')).toEqual([])
    admission.mockRestore()
    await bob.peer.replay()
    await vi.waitFor(async () => expect(await store.list()).toEqual([]), { timeout: 1800 })
    expect(hub.published.filter((m) => m.senderDID === 'bob')).toHaveLength(1)
  })

  test('applied local removal durably clears accepted entries and reports their sequences', async () => {
    const hub = new DurableFakeHub()
    const notices: Array<AppOutboxCleared> = []
    const bob = member(hub, 'bob', {
      onAppOutboxCleared: (notice) => {
        notices.push(notice)
      },
    })
    await flush()
    hub.detach('bob')
    await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: secret,
      epoch: 1,
      removes: ['bob'],
    })
    await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'removed' } })
    await vi.waitFor(async () => expect(await bob.appOutbox.list()).toEqual([]), { timeout: 1800 })
    expect(hub.published.filter((m) => m.senderDID === 'bob')).toEqual([])
    expect(notices).toEqual([{ reason: 'removed', seqs: [0] }])
    expect(bob.mls.epoch()).toBe(1)
  })

  test('disposeDuringClearDoesNotReplayNotice', async () => {
    const hub = new DurableFakeHub()
    const store = createMemoryAppOutbox()
    const gate = deferred<void>()
    const entered = deferred<void>()
    const notices: Array<AppOutboxCleared> = []
    const bob = member(hub, 'bob', {
      onAppOutboxCleared: (notice) => {
        notices.push(notice)
      },
      appOutbox: {
        ...store,
        clear: async () => {
          entered.resolve()
          await gate.promise
          await store.clear()
        },
      },
    })
    await flush()
    hub.detach('bob')
    await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: secret,
      epoch: 1,
      removes: ['bob'],
    })
    await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'cleared' } })
    await entered.promise
    await bob.peer.dispose()
    let drained = false
    const draining = bob.peer.drained().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    gate.resolve()
    await draining
    expect(await store.list()).toEqual([])
    expect(notices).toEqual([])
    const replacement = member(hub, 'bob', {
      restartOf: bob,
      onAppOutboxCleared: (notice) => {
        notices.push(notice)
      },
    })
    await replacement.peer.replay()
    await flush()
    expect(notices).toEqual([])
  })

  test.each([false, true])(
    'delayed insertion publishes in reservation order after first insert rejection %s',
    async (reject) => {
      const hub = new FakeHub()
      const received: Array<unknown> = []
      member(hub, 'alice', {
        handlers: { 'chat/posted': (ctx: { data: unknown }) => received.push(ctx.data) },
      })
      const store = createMemoryAppOutbox()
      const gate = deferred<void>()
      const bob = member(hub, 'bob', {
        appOutbox: {
          ...store,
          put: async (row) => {
            if (row.seq === 0 && row.lastAttempt == null) {
              await gate.promise
              if (reject) throw new Error('insert rejected')
            }
            await store.put(row)
          },
        },
      })
      await flush()
      const first = bob.peer
        .protocol('chat')
        .dispatch('chat/posted', { data: { text: 'first' } })
        .catch((error: unknown) => error)
      await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'second' } })
      await flush()
      expect(received).toEqual([])
      gate.resolve()
      const result = await first
      if (reject) expect(result).toMatchObject({ message: 'insert rejected' })
      await vi.waitFor(
        () =>
          expect(received).toEqual(
            reject ? [{ text: 'second' }] : [{ text: 'first' }, { text: 'second' }],
          ),
        { timeout: 1500 },
      )
    },
  )

  test('non-rotating ratchet during seal pairs ciphertext with its own epoch floor', async () => {
    const hub = new FakeHub()
    const attempts: Array<{ epoch: number; floor: string | null }> = []
    const store = createMemoryAppOutbox()
    const bob = member(hub, 'bob', {
      appOutbox: {
        ...store,
        put: async (row) => {
          if (row.lastAttempt != null) attempts.push(row.lastAttempt)
          await store.put(row)
        },
      },
    })
    await flush()
    const wrap = bob.crypto.wrap.bind(bob.crypto)
    let injected = false
    vi.spyOn(bob.crypto, 'wrap').mockImplementation(async (...args) => {
      const sealed = await wrap(...args)
      if (!injected) {
        injected = true
        await bob.peer.commit(buildLedgerCommit(bob, []))
      }
      return sealed
    })
    await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'paired' } })
    await vi.waitFor(async () => expect(await store.list()).toEqual([]), { timeout: 300 })
    const apps = hub.published.filter((m) => m.topicID !== commitTopic(secret))
    expect(apps).toHaveLength(1)
    const app = apps[0]
    if (app == null) throw new Error('Missing application frame')
    expect(bob.crypto.frameEpoch(app.payload)).toBe(2)
    expect(attempts).toEqual([
      {
        epoch: 2,
        floor: hub.published.find((m) => m.topicID === commitTopic(secret))?.sequenceID,
        attempts: 1,
      },
    ])
  })

  test.each([false, true])(
    'restart republishes an unproven entry after acknowledged publication %s',
    async (published) => {
      const hub = new FakeHub()
      const received: Array<unknown> = []
      member(hub, 'alice', {
        handlers: { 'chat/posted': (ctx: { data: unknown }) => received.push(ctx.data) },
      })
      const store = createMemoryAppOutbox()
      const bob = member(hub, 'bob', {
        appOutbox: {
          ...store,
          remove: async () => {
            throw new Error('retain across crash')
          },
        },
      })
      await flush()
      if (!published) vi.spyOn(bob.crypto, 'wrap').mockRejectedValue(new Error('crash before seal'))
      await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'restored' } })
      await flush()
      expect(received).toHaveLength(published ? 1 : 0)
      expect(await store.list()).toHaveLength(1)
      await bob.peer.dispose()
      await bob.peer.drained()
      vi.restoreAllMocks()
      const replacement = member(hub, 'bob', { restartOf: bob, appOutbox: store })
      await vi.waitFor(async () => expect(await replacement.appOutbox.list()).toEqual([]))
      expect(received).toEqual(
        published ? [{ text: 'restored' }, { text: 'restored' }] : [{ text: 'restored' }],
      )
    },
  )

  test.each([undefined, 'false'])(
    'missing or non-boolean gap cannot certify or publish (%s)',
    async (gap) => {
      const hub = new FakeHub()
      const bob = member(hub, 'bob')
      await flush()
      const fetch = hub.fetchTopic.bind(hub)
      const spy = vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
        const result = await fetch(params)
        return params.topicID === commitTopic(secret)
          ? ({ ...result, gap } as unknown as Awaited<ReturnType<typeof fetch>>)
          : result
      })
      await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'checked' } })
      await flush()
      expect(await bob.appOutbox.list()).toMatchObject([{ lastAttempt: null }])
      expect(hub.published).toEqual([])
      spy.mockRestore()
      await vi.waitFor(async () => expect(await bob.appOutbox.list()).toEqual([]), {
        timeout: 1600,
      })
      expect(hub.published).toHaveLength(1)
    },
  )

  test('removed sender behind a gap durably holds rather than guessing its membership', async () => {
    const hub = new DurableFakeHub()
    const events: Array<RecoveryEvent> = []
    const bob = member(hub, 'bob', {
      recovery: { timeoutMs: 20, deadlineMs: 60, getDelayMs: () => 0 },
      onRecovery: (event) => {
        events.push(event)
      },
    })
    await flush()
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 1 })
    await bob.peer.replay()
    hub.detach('bob')
    await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: secret,
      epoch: 2,
      removes: ['bob'],
    })
    hub.trim(commitTopic(secret), '999999999999')
    await bob.peer
      .protocol('chat')
      .dispatch('chat/posted', { data: { text: 'unknown membership' } })
    await vi.waitFor(() => expect(events.some((event) => event.phase === 'failed')).toBe(true))
    expect(await bob.appOutbox.list()).toMatchObject([{ lastAttempt: null }])
    expect(
      hub.published.filter(
        (m) =>
          m.senderDID === 'bob' &&
          m.topicID !== commitTopic(secret) &&
          bob.crypto.frameEpoch(m.payload) != null,
      ),
    ).toEqual([])
  })

  test('fresh uncovered join with no at-risk entry never requests recovery', async () => {
    const hub = new FakeHub()
    const removed = await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: secret,
      epoch: 1,
    })
    hub.trim(commitTopic(secret), '999999999999')
    const events: Array<RecoveryEvent> = []
    member(hub, 'bob', {
      epoch: 2,
      onRecovery: (event) => {
        events.push(event)
      },
    })
    await flush()
    expect(events).toEqual([])
    expect(hub.head(commitTopic(secret))).toBe(removed.sequenceID)
  })

  test.each([1, 2])(
    'ratchet before acknowledgement preserves order across %s replacements',
    async (changes) => {
      const hub = new FakeHub()
      const received: Array<unknown> = []
      member(hub, 'alice', {
        handlers: { 'chat/posted': (ctx: { data: unknown }) => received.push(ctx.data) },
      })
      const bob = member(hub, 'bob')
      await flush()
      const publish = hub.publish.bind(hub)
      let injected = 0
      vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
        if (
          params.senderDID === 'bob' &&
          params.topicID !== commitTopic(secret) &&
          params.retain === 'log' &&
          injected < changes
        ) {
          injected++
          await bob.peer.commit(buildLedgerCommit(bob, []))
          await flush()
        }
        return publish(params)
      })
      await Promise.all([
        bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'first' } }),
        bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'second' } }),
      ])
      await vi.waitFor(() => expect(received).toEqual([{ text: 'first' }, { text: 'second' }]), {
        timeout: 1700,
      })
      const epochs = hub.published
        .filter((m) => m.senderDID === 'bob' && m.topicID !== commitTopic(secret))
        .map((m) => bob.crypto.frameEpoch(m.payload))
      expect(epochs).toEqual([
        ...Array.from({ length: changes }, (_, index) => index + 1),
        changes + 1,
        changes + 1,
      ])
    },
  )

  test('an uncovered fresh joiner recovers only after an acknowledged publication is at risk', async () => {
    const hub = new FakeHub()
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 1 })
    hub.trim(commitTopic(secret), '999999999999')
    const received: Array<unknown> = []
    member(hub, 'alice', {
      epoch: 2,
      handlers: { 'chat/posted': (ctx: { data: unknown }) => received.push(ctx.data) },
      recovery: { timeoutMs: 25, deadlineMs: 400, getDelayMs: () => 0 },
    })
    const events: Array<RecoveryEvent> = []
    const strands: Array<StrandObservation> = []
    const bob = member(hub, 'bob', {
      epoch: 2,
      onRecovery: (event) => {
        events.push(event)
      },
      onStrand: (notice) => {
        strands.push(notice)
      },
      recovery: { timeoutMs: 25, deadlineMs: 400, getDelayMs: () => 0 },
    })
    await flush()
    expect(events).toEqual([])
    await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'fresh' } })
    await vi.waitFor(async () => expect(await bob.appOutbox.list()).toEqual([]), { timeout: 1200 })
    expect(events.map((event) => event.phase)).toEqual(['started', 'succeeded'])
    expect(strands).toEqual([])
    expect(received).toEqual([{ text: 'fresh' }, { text: 'fresh' }])
  })

  test('failed gap recovery retries on backoff and delivers when a responder returns', async () => {
    const hub = new DurableFakeHub()
    const events: Array<RecoveryEvent> = []
    const bob = member(hub, 'bob', {
      onRecovery: (event) => {
        events.push(event)
        if (event.phase === 'started') hub.reattach('bob')
      },
      recovery: { timeoutMs: 20, deadlineMs: 100, getDelayMs: () => 0 },
    })
    await flush()
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 1 })
    await bob.peer.replay()
    hub.detach('bob')
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 2 })
    hub.trim(commitTopic(secret), '999999999999')
    await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'retry' } })
    await vi.waitFor(() => expect(events.some((event) => event.phase === 'failed')).toBe(true))
    expect(await bob.appOutbox.list()).toMatchObject([{ lastAttempt: null }])
    const received: Array<unknown> = []
    member(hub, 'alice', {
      epoch: 3,
      recovery: { timeoutMs: 20, deadlineMs: 100, getDelayMs: () => 0 },
      handlers: { 'chat/posted': (ctx: { data: unknown }) => received.push(ctx.data) },
    })
    await vi.waitFor(() => expect(received).toEqual([{ text: 'retry' }]), { timeout: 2000 })
    expect(events.some((event) => event.phase === 'succeeded')).toBe(true)
  })

  test('a removed member cannot open the replacement on the new segment topic', async () => {
    const hub = new DurableFakeHub()
    const received: Array<unknown> = []
    const alice = member(hub, 'alice', {
      handlers: { 'chat/posted': (ctx: { data: unknown }) => received.push(ctx.data) },
    })
    const bob = member(hub, 'bob')
    const carol = member(hub, 'carol')
    await flush()
    hub.detach('bob')
    await alice.peer.commit(buildRemoveCommit(alice, 'carol'))
    await alice.peer.replay()
    await flush()
    await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'survivors' } })
    await vi.waitFor(() => expect(received).toEqual([{ text: 'survivors' }]))
    const frame = hub.published.find((m) => m.senderDID === 'bob')
    if (frame == null) throw new Error('Missing publication')
    const current = alice.anchorStore.stored()
    const old = carol.anchorStore.stored()
    if (current == null || old == null) throw new Error('Missing anchor')
    expect(frame.topicID).toBe(protocolTopic(current.secret, current.epoch, 'chat'))
    expect(frame.topicID).not.toBe(protocolTopic(old.secret, old.epoch, 'chat'))
    await expect(Promise.resolve().then(() => carol.crypto.unwrap(frame.payload))).rejects.toThrow()
  })

  test('restored inventory yields after 64 entries before continuing in order', async () => {
    const hub = new FakeHub()
    const store = createMemoryAppOutbox()
    for (let seq = 0; seq < 100; seq++)
      await store.put({
        seq,
        protocol: 'chat',
        prc: 'chat/posted',
        data: encodeEventFrame('chat/posted', { seq }),
        lastAttempt: null,
      })
    const yielded = deferred<number>()
    const publish = hub.publish.bind(hub)
    let count = 0
    vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
      const result = await publish(params)
      if (++count === 64) setTimeout(() => yielded.resolve(count), 0)
      return result
    })
    const bob = member(hub, 'bob', { appOutbox: store })
    expect(await yielded.promise).toBe(64)
    await vi.waitFor(async () => expect(await bob.appOutbox.list()).toEqual([]), { timeout: 1200 })
    expect(hub.published).toHaveLength(100)
  })

  test('a walk begun before publication acknowledgement cannot retire a prepared attempt', async () => {
    const hub = new FakeHub()
    const gate = deferred<void>()
    const entered = deferred<void>()
    const bob = member(hub, 'bob')
    await flush()
    await bob.peer.commit(buildLedgerCommit(bob, []))
    const publish = hub.publish.bind(hub)
    vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
      if (params.senderDID === 'bob' && params.topicID !== commitTopic(secret)) {
        entered.resolve()
        await gate.promise
        throw new Error('prepared publication failed')
      }
      return publish(params)
    })
    await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'prepared only' } })
    await entered.promise
    await bob.peer.retryAppDelivery()
    await flush()
    expect(await bob.appOutbox.list()).toHaveLength(1)
    gate.resolve()
    await flush()
    expect(await bob.appOutbox.list()).toMatchObject([{ lastAttempt: { epoch: 2, attempts: 1 } }])
    expect(hub.published.filter((m) => m.topicID !== commitTopic(secret))).toEqual([])
  })

  test('failures back off exponentially from one second to the sixty-second cap', async () => {
    vi.useFakeTimers()
    const hub = new FakeHub()
    const bob = member(hub, 'bob')
    try {
      await bob.peer.resync()
      const wrap = bob.crypto.wrap.bind(bob.crypto)
      let attempts = 0
      vi.spyOn(bob.crypto, 'wrap').mockImplementation(async (...args) => {
        if (++attempts <= 8) throw new Error('seal unavailable')
        return wrap(...args)
      })
      await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'backoff' } })
      await vi.advanceTimersByTimeAsync(0)
      expect(attempts).toBe(1)
      for (const [index, delay] of [
        1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000,
      ].entries()) {
        await vi.advanceTimersByTimeAsync(delay - 1)
        expect(attempts).toBe(index + 1)
        await vi.advanceTimersByTimeAsync(1)
        expect(attempts).toBe(index + 2)
      }
      expect(await bob.appOutbox.list()).toEqual([])
      expect(hub.published).toHaveLength(1)
    } finally {
      await bob.peer.dispose()
      vi.useRealTimers()
    }
  })

  test('cursor-only pruning and unrelated positions do not strand a covered floor', async () => {
    const hub = new FakeHub()
    const events: Array<RecoveryEvent> = []
    const bob = member(hub, 'bob', {
      onRecovery: (event) => {
        events.push(event)
      },
    })
    await flush()
    await bob.peer.commit(buildLedgerCommit(bob, []))
    const own = hub.head(commitTopic(secret))
    if (own == null) throw new Error('Missing own commit')
    await hub.publish({
      topicID: 'unrelated',
      senderDID: 'alice',
      retain: 'log',
      payload: new Uint8Array([1]),
    })
    await hub.publish({
      topicID: commitTopic(secret),
      senderDID: 'alice',
      payload: new Uint8Array([1]),
    })
    const poison = await hub.publish({
      topicID: commitTopic(secret),
      senderDID: 'alice',
      retain: 'log',
      payload: new Uint8Array([1]),
    })
    hub.trim(commitTopic(secret), poison.sequenceID)
    expect(own < poison.sequenceID).toBe(true)
    await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'covered' } })
    await vi.waitFor(async () => expect(await bob.appOutbox.list()).toEqual([]))
    expect(events).toEqual([])
    expect(
      hub.published.filter((m) => m.senderDID === 'bob' && m.topicID !== commitTopic(secret)),
    ).toHaveLength(1)
  })

  test('removal waits for unresolved accepted puts and emits one clear notice', async () => {
    const hub = new FakeHub()
    const store = createMemoryAppOutbox()
    const gate = deferred<void>()
    const notices: Array<AppOutboxCleared> = []
    let clears = 0
    const bob = member(hub, 'bob', {
      onAppOutboxCleared: (notice) => {
        notices.push(notice)
      },
      appOutbox: {
        ...store,
        put: async (entry) => {
          if (entry.seq === 0 && entry.lastAttempt == null) await gate.promise
          await store.put(entry)
        },
        clear: async () => {
          clears++
          await store.clear()
        },
      },
    })
    await flush()
    const first = bob.peer
      .protocol('chat')
      .dispatch('chat/posted', { data: { text: 'pending put' } })
    await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'accepted put' } })
    await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: secret,
      epoch: 1,
      removes: ['bob'],
    })
    await flush()
    const before = { notices: [...notices], clears }
    gate.resolve()
    await first
    expect(before).toEqual({ notices: [], clears: 0 })
    await vi.waitFor(() => expect(notices).toEqual([{ reason: 'removed', seqs: [0, 1] }]), {
      timeout: 1500,
    })
    expect(await store.list()).toEqual([])
    expect(clears).toBe(1)
  })

  test('a failed removal clear retries the durable clear and reports once', async () => {
    const hub = new DurableFakeHub()
    const store = createMemoryAppOutbox()
    const notices: Array<AppOutboxCleared> = []
    let clears = 0
    const bob = member(hub, 'bob', {
      onAppOutboxCleared: (notice) => {
        notices.push(notice)
      },
      appOutbox: {
        ...store,
        clear: async () => {
          if (++clears === 1) throw new Error('clear unavailable')
          await store.clear()
        },
      },
    })
    await flush()
    hub.detach('bob')
    await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: secret,
      epoch: 1,
      removes: ['bob'],
    })
    await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'discarded' } })
    await vi.waitFor(() => expect(clears).toBe(1))
    expect(notices).toEqual([])
    expect(await store.list()).toHaveLength(1)
    await vi.waitFor(() => expect(notices).toEqual([{ reason: 'removed', seqs: [0] }]), {
      timeout: 1600,
    })
    expect(clears).toBe(2)
    expect(await store.list()).toEqual([])
    expect(hub.published.filter((m) => m.senderDID === 'bob')).toEqual([])
  })

  test('one reseal delivers the same plaintext to a member which read the original epoch', async () => {
    const hub = new FakeHub()
    const received: Array<unknown> = []
    let withholding = true
    const alice = member(hub, 'alice')
    const bob = member(hub, 'bob')
    const carol = member(hub, 'carol', {
      handlers: { 'chat/posted': (ctx: { data: unknown }) => received.push(ctx.data) },
    })
    await flush()
    const fetch = hub.fetchTopic.bind(hub)
    vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
      const result = await fetch(params)
      if (withholding && params.subscriberDID === 'carol' && params.topicID === commitTopic(secret))
        return { messages: [], head: null, oldest: null, ...{ gap: false } }
      return result
    })
    const publish = hub.publish.bind(hub)
    let injected = false
    vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
      if (
        !injected &&
        params.senderDID === 'bob' &&
        params.topicID !== commitTopic(secret) &&
        params.retain === 'log'
      ) {
        injected = true
        await alice.peer.commit(buildLedgerCommit(alice, []))
      }
      return publish(params)
    })
    await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'twice' } })
    await vi.waitFor(() => expect(received).toEqual([{ text: 'twice' }]))
    withholding = false
    await carol.peer.retryAppDelivery()
    await vi.waitFor(() => expect(received).toEqual([{ text: 'twice' }, { text: 'twice' }]), {
      timeout: 1700,
    })
    await bob.peer.replay()
    await flush()
    expect(
      hub.published.filter((m) => m.senderDID === 'bob' && m.topicID !== commitTopic(secret)),
    ).toHaveLength(2)
  })

  test('restart delivers an entry acknowledged at an epoch overtaken before its walk', async () => {
    const hub = new FakeHub()
    const received: Array<unknown> = []
    const alice = member(hub, 'alice', {
      handlers: { 'chat/posted': (ctx: { data: unknown }) => received.push(ctx.data) },
    })
    const store = createMemoryAppOutbox()
    const bob = member(hub, 'bob', { appOutbox: store })
    await flush()
    const old = bob.anchorStore.stored()
    if (old == null) throw new Error('Missing original anchor')
    const publish = hub.publish.bind(hub)
    const acknowledged = deferred<void>()
    const release = deferred<void>()
    vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
      if (params.senderDID === 'bob' && params.topicID !== commitTopic(secret)) {
        await alice.peer.commit(buildLedgerCommit(alice, []))
        const result = await publish(params)
        acknowledged.resolve()
        await release.promise
        return result
      }
      return publish(params)
    })
    await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'at-risk restart' } })
    await acknowledged.promise
    await bob.peer.dispose()
    release.resolve()
    await bob.peer.drained()
    expect(received).toEqual([])
    expect(await store.list()).toHaveLength(1)
    vi.restoreAllMocks()
    const replacement = member(hub, 'bob', { restartOf: bob, appOutbox: store })
    await vi.waitFor(async () => expect(await replacement.appOutbox.list()).toEqual([]))
    expect(received).toEqual([{ text: 'at-risk restart' }, { text: 'at-risk restart' }])
    const current = replacement.anchorStore.stored()
    if (current == null) throw new Error('Missing replacement anchor')
    const topics = [
      protocolTopic(old.secret, old.epoch, 'chat'),
      protocolTopic(current.secret, current.epoch, 'chat'),
    ]
    const apps = hub.published.filter((m) => m.senderDID === 'bob' && topics.includes(m.topicID))
    expect(apps.map((m) => bob.crypto.frameEpoch(m.payload))).toEqual([1, 2, 3])
  })

  test('retrying confirmed adoption repairs the floor after the host adopted then threw', async () => {
    const hub = new FakeHub()
    const received: Array<unknown> = []
    member(hub, 'alice', {
      handlers: { 'chat/posted': (ctx: { data: unknown }) => received.push(ctx.data) },
    })
    const bob = member(hub, 'bob')
    await flush()
    const apply = bob.mls.applyRecovery.bind(bob.mls)
    let failed = false
    vi.spyOn(bob.mls, 'applyRecovery').mockImplementation(async (...args) => {
      const pending = await apply(...args)
      if (pending == null || 'renewalRequired' in pending) return pending
      return {
        ...pending,
        onAccepted: async () => {
          await pending.onAccepted()
          if (!failed) {
            failed = true
            throw new Error('persist failed after adoption')
          }
        },
      }
    })
    await expect(bob.peer.recover()).rejects.toThrow('persist failed after adoption')
    await bob.peer.replay()
    const wrap = bob.crypto.wrap.bind(bob.crypto)
    let seals = 0
    vi.spyOn(bob.crypto, 'wrap').mockImplementation(async (...args) => {
      if (++seals > 1) throw new Error('unexpected repeat seal')
      return wrap(...args)
    })
    await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'confirmed retry' } })
    await vi.waitFor(() => expect(received).toEqual([{ text: 'confirmed retry' }]), {
      timeout: 300,
    })
    expect(await bob.appOutbox.list()).toEqual([])
    expect(seals).toBe(1)
  })

  test.each(['seal', 'catch-up'] as const)(
    'later entries preserve per-epoch order when a ratchet lands during %s',
    async (during) => {
      const hub = new DurableFakeHub()
      const received: Array<{ epoch: number; seq: number }> = []
      const alice = member(hub, 'alice', {
        handlers: {
          'chat/posted': (ctx: { data: { seq: number } }) => {
            received.push({ epoch: alice.mls.epoch(), seq: ctx.data.seq })
          },
        },
      })
      const bob = member(hub, 'bob')
      await flush()
      const anchor = bob.anchorStore.stored()
      if (anchor == null) throw new Error('Missing anchor')
      const appTopic = protocolTopic(anchor.secret, anchor.epoch, 'chat')
      const wrap = bob.crypto.wrap.bind(bob.crypto)
      const sealed = new Map<string, { seq: number; epoch: number | null }>()
      let seals = 0
      vi.spyOn(bob.crypto, 'wrap').mockImplementation(async (...args) => {
        if (++seals === 2 && during === 'seal') {
          await bob.peer.commit(buildLedgerCommit(bob, []))
          await flush()
        }
        const payload = await wrap(...args)
        const message = decodeFrame(args[0]) as { payload: { data: { seq: number } } }
        sealed.set(Array.from(payload).join(','), {
          seq: message.payload.data.seq,
          epoch: bob.crypto.frameEpoch(payload),
        })
        return payload
      })
      if (during === 'catch-up') {
        hub.detach('bob')
        const publish = hub.publish.bind(hub)
        let injected = false
        vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
          const result = await publish(params)
          if (!injected && params.senderDID === 'bob' && params.topicID === appTopic) {
            injected = true
            await alice.peer.commit(buildLedgerCommit(alice, []))
          }
          return result
        })
      }
      await Promise.all([
        bob.peer.protocol('chat').dispatch('chat/posted', { data: { seq: 0 } }),
        bob.peer.protocol('chat').dispatch('chat/posted', { data: { seq: 1 } }),
      ])
      await vi.waitFor(async () => expect(await bob.appOutbox.list()).toEqual([]))
      const published = hub.published
        .filter((frame) => frame.senderDID === 'bob' && frame.topicID === appTopic)
        .map((frame) => sealed.get(Array.from(frame.payload).join(',')))
      expect(published).toEqual([
        { epoch: 1, seq: 0 },
        { epoch: 2, seq: 0 },
        { epoch: 2, seq: 1 },
      ])
      await vi.waitFor(() =>
        expect(received.filter((entry) => entry.epoch === 2).map((entry) => entry.seq)).toEqual([
          0, 1,
        ]),
      )
      if (during === 'catch-up') {
        expect(
          [...sealed.values()].filter((entry) => entry.seq === 1).map((entry) => entry.epoch),
        ).toEqual([2, 2])
      }
    },
  )
})
