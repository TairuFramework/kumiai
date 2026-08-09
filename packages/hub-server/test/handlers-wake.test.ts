import { Client } from '@enkaku/client'
import type { AnyClientMessageOf, AnyServerMessageOf } from '@enkaku/protocol'
import { DirectTransports } from '@enkaku/transport'
import { randomIdentity } from '@kokuin/token'
import type { HubProtocol, WakeRegistration, WakeRegistry, WakeSender } from '@kumiai/hub-protocol'
import { HUB_ERROR_CODES, openWakeHint } from '@kumiai/hub-protocol'
import { createMemoryWakeRegistry } from '@kumiai/hub-wake'
import { p256 } from '@noble/curves/nist.js'
import { fromUTF, toB64 } from '@sozai/codec'
import { describe, expect, test, vi } from 'vitest'

import { createHandlers } from '../src/handlers.js'
import type { CreateHubParams } from '../src/hub.js'
import { createHub } from '../src/hub.js'
import { createMemoryStore } from '../src/memoryStore.js'
import { HubClientRegistry } from '../src/registry.js'
import type { WakeDispatcher } from '../src/wake.js'

type HubTransports = DirectTransports<
  AnyServerMessageOf<HubProtocol>,
  AnyClientMessageOf<HubProtocol>
>

// `CreateHubParams.wake` requires a `sender`, which nothing here ever calls: the dispatcher's
// `notify` only fires from the publish fan-out, wired in a later task. This double stands in so
// the harness can exercise the real `createHub` wake wiring with just a registry.
const NOOP_WAKE_SENDER: WakeSender = { send: async () => 'delivered' }

type TestHubOptions = Omit<CreateHubParams, 'identity' | 'store' | 'transport' | 'wake'> & {
  wake?: { registry: WakeRegistry }
}

// Reuse the harness pattern from hub.test.ts: a hub over an in-memory transport with an
// authenticated client DID, collapsed to a single pre-connected client since every test here
// only needs one caller.
async function createTestHub(
  options: TestHubOptions,
): Promise<{ client: Client<HubProtocol>; clientDID: string; dispose: () => Promise<void> }> {
  const { wake, ...hubOptions } = options
  const store = createMemoryStore()
  const hubIdentity = randomIdentity()
  const transports: HubTransports = new DirectTransports()
  const hub = createHub({
    ...hubOptions,
    identity: hubIdentity,
    store,
    transport: transports.server,
    wake: wake == null ? undefined : { registry: wake.registry, sender: NOOP_WAKE_SENDER },
  })
  const clientIdentity = randomIdentity()
  const client = new Client<HubProtocol>({
    transport: transports.client,
    identity: clientIdentity,
    serverID: hubIdentity.id,
  })

  async function dispose(): Promise<void> {
    await hub.server.dispose()
    await transports.dispose()
  }

  return { client, clientDID: clientIdentity.id, dispose }
}

// P-256 keypair for a recipient endpoint, as in test/wake.test.ts. Only the dispatch path cares
// that a registration is well-formed enough to seal a hint against; nothing here opens it.
const recipientPrivateKey = p256.utils.randomSecretKey()
const recipientAuthSecretBytes = crypto.getRandomValues(new Uint8Array(16))
const recipientPublicKeyB64u = Buffer.from(p256.getPublicKey(recipientPrivateKey, false)).toString(
  'base64url',
)
const recipientAuthSecretB64u = Buffer.from(recipientAuthSecretBytes).toString('base64url')
// Opens what `sealWakeHint` sealed, so a test can assert the hint's actual contents rather than
// just that something was sent.
const recipientOpener = { privateKey: recipientPrivateKey, authSecret: recipientAuthSecretBytes }

function createRecordingSender(): {
  sender: WakeSender
  sent: Array<{ registration: WakeRegistration; body: Uint8Array }>
} {
  const sent: Array<{ registration: WakeRegistration; body: Uint8Array }> = []
  const sender: WakeSender = {
    async send(params) {
      sent.push(params)
      return 'delivered'
    },
  }
  return { sender, sent }
}

const PAIR_TOPIC = 'topic-a'

// Tight real-time poll rather than a fixed sleep: resolves the instant the predicate turns true
// instead of gambling a fixed delay is long enough (and wasting it when the event is instant).
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil: condition not met before timeout')
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

type TestHubPairOptions = Omit<CreateHubParams, 'identity' | 'store' | 'transport' | 'wake'> & {
  wake?: { registry: WakeRegistry; sender: WakeSender; debounceMs?: number }
}

type TestPublisher = {
  publish: (param: {
    topicID: string
    payload: string
    retain?: 'log' | 'mailbox'
  }) => Promise<{ sequenceID: string }>
}

/**
 * Two authenticated clients sharing one hub, both subscribed to `topic-a`. The second DID
 * (`offlineDID`) has no live receive channel — and so no entry in the hub's client registry —
 * until `bringOnline()` opens one. That lets one harness exercise both the "no live channel"
 * wake path and its "online, no wake" counterpart.
 */
async function createTestHubPair(options: TestHubPairOptions): Promise<{
  publisher: TestPublisher
  publisherDID: string
  offlineDID: string
  bringOnline: () => Promise<void>
  dispose: () => Promise<void>
}> {
  const { wake, ...hubOptions } = options
  const store = createMemoryStore()
  const hubIdentity = randomIdentity()
  const publisherTransports: HubTransports = new DirectTransports()
  const subscriberTransports: HubTransports = new DirectTransports()
  const hub = createHub({
    ...hubOptions,
    identity: hubIdentity,
    store,
    transport: publisherTransports.server,
    wake:
      wake == null
        ? undefined
        : { registry: wake.registry, sender: wake.sender, debounceMs: wake.debounceMs },
  })
  hub.server.handle(subscriberTransports.server)

  const publisherIdentity = randomIdentity()
  const publisherClient = new Client<HubProtocol>({
    transport: publisherTransports.client,
    identity: publisherIdentity,
    serverID: hubIdentity.id,
  })
  const subscriberIdentity = randomIdentity()
  const subscriberClient = new Client<HubProtocol>({
    transport: subscriberTransports.client,
    identity: subscriberIdentity,
    serverID: hubIdentity.id,
  })

  await publisherClient.request('hub/v1/subscribe', { param: { topicID: PAIR_TOPIC } })
  await subscriberClient.request('hub/v1/subscribe', { param: { topicID: PAIR_TOPIC } })

  let subscriberChannel: ReturnType<typeof subscriberClient.createChannel> | undefined

  async function bringOnline(): Promise<void> {
    subscriberChannel = subscriberClient.createChannel('hub/v1/receive', { param: {} })
    subscriberChannel.readable.getReader()
    // Observe the bind (registry.bindReceiveWriter) directly rather than sleeping a fixed guess at
    // how long it takes: a busy CI runner can make a fixed delay too short (flaky) or needlessly
    // long (slow) — polling the actual registry state is exact either way.
    await waitUntil(() => hub.registry.isWriterBound(subscriberIdentity.id))
  }

  async function dispose(): Promise<void> {
    if (subscriberChannel != null) {
      subscriberChannel.close()
      await subscriberChannel.catch(() => {})
    }
    await hub.server.dispose()
    await Promise.all([publisherTransports.dispose(), subscriberTransports.dispose()])
  }

  return {
    publisher: {
      publish: (param) => publisherClient.request('hub/v1/publish', { param }),
    },
    publisherDID: publisherIdentity.id,
    offlineDID: subscriberIdentity.id,
    bringOnline,
    dispose,
  }
}

describe('hub/v1/wake/register', () => {
  test('stores a registration for the authenticated caller', async () => {
    const registry = createMemoryWakeRegistry()
    const { client, clientDID, dispose } = await createTestHub({ wake: { registry } })

    await expect(
      client.request('hub/v1/wake/register', {
        param: {
          kind: 'webpush',
          endpoint: 'https://push.example/a',
          publicKey: recipientPublicKeyB64u,
          authSecret: recipientAuthSecretB64u,
        },
      }),
    ).resolves.toEqual({ registered: true })

    // The full stored object, not a subset: a handler that swapped publicKey/authSecret or
    // dropped a field would still pass a partial assertion. Everything the sender fed in must
    // round-trip verbatim, and the DID must be the authenticated caller's, not a wire field.
    expect(await registry.get(clientDID)).toEqual({
      did: clientDID,
      kind: 'webpush',
      endpoint: 'https://push.example/a',
      publicKey: recipientPublicKeyB64u,
      authSecret: recipientAuthSecretB64u,
    })
    await dispose()
  })

  test('carries expiresAt through to the stored registration', async () => {
    const registry = createMemoryWakeRegistry()
    const { client, clientDID, dispose } = await createTestHub({ wake: { registry } })
    const expiresAt = Math.floor(Date.now() / 1000) + 3600

    await client.request('hub/v1/wake/register', {
      param: {
        kind: 'webpush',
        endpoint: 'https://push.example/a',
        publicKey: recipientPublicKeyB64u,
        authSecret: recipientAuthSecretB64u,
        expiresAt,
      },
    })

    expect((await registry.get(clientDID))?.expiresAt).toBe(expiresAt)
    await dispose()
  })

  test('replaces a previous registration', async () => {
    const registry = createMemoryWakeRegistry()
    const { client, clientDID, dispose } = await createTestHub({ wake: { registry } })

    await client.request('hub/v1/wake/register', {
      param: {
        kind: 'webpush',
        endpoint: 'https://push.example/old',
        publicKey: recipientPublicKeyB64u,
        authSecret: recipientAuthSecretB64u,
      },
    })
    await client.request('hub/v1/wake/register', {
      param: {
        kind: 'expo',
        endpoint: 'ExponentPushToken[xxx]',
        publicKey: recipientPublicKeyB64u,
        authSecret: recipientAuthSecretB64u,
      },
    })

    expect((await registry.get(clientDID))?.kind).toBe('expo')
    await dispose()
  })

  test('refuses when the hub has no wake support', async () => {
    const { client, dispose } = await createTestHub({})
    await expect(
      client.request('hub/v1/wake/register', {
        param: {
          kind: 'webpush',
          endpoint: 'https://push.example/a',
          publicKey: recipientPublicKeyB64u,
          authSecret: recipientAuthSecretB64u,
        },
      }),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.wakeNotSupported })
    await dispose()
  })

  // The schema asks only for `minLength: 1`, so key material the hub can NEVER use registers
  // happily and answers `registered: true`. Every subsequent frame for that DID then fails inside
  // `sealWakeHint` — one error per frame, forever, since a seal failure is not a `gone` verdict and
  // nothing ever removes the entry. The device believes it is reachable and is never woken: exactly
  // the outcome `WakeNotSupportedError` exists to prevent, arriving through another door.
  test('refuses a publicKey that is not a 65-byte uncompressed P-256 point', async () => {
    const registry = createMemoryWakeRegistry()
    const { client, clientDID, dispose } = await createTestHub({ wake: { registry } })

    await expect(
      client.request('hub/v1/wake/register', {
        param: {
          kind: 'webpush',
          endpoint: 'https://push.example/a',
          publicKey: 'AAAA',
          authSecret: recipientAuthSecretB64u,
        },
      }),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.invalidPayload })
    // Refused, not stored-then-refused: nothing may be left behind for the dispatcher to find.
    expect(await registry.get(clientDID)).toBeNull()
    await dispose()
  })

  test('refuses an authSecret that is not 16 bytes', async () => {
    const registry = createMemoryWakeRegistry()
    const { client, clientDID, dispose } = await createTestHub({ wake: { registry } })

    await expect(
      client.request('hub/v1/wake/register', {
        param: {
          kind: 'webpush',
          endpoint: 'https://push.example/a',
          publicKey: recipientPublicKeyB64u,
          authSecret: 'BBBB',
        },
      }),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.invalidPayload })
    expect(await registry.get(clientDID)).toBeNull()
    await dispose()
  })

  test('refuses key material that is not base64url at all', async () => {
    const registry = createMemoryWakeRegistry()
    const { client, clientDID, dispose } = await createTestHub({ wake: { registry } })

    await expect(
      client.request('hub/v1/wake/register', {
        param: {
          kind: 'webpush',
          endpoint: 'https://push.example/a',
          publicKey: '!!!not base64!!!',
          authSecret: recipientAuthSecretB64u,
        },
      }),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.invalidPayload })
    expect(await registry.get(clientDID)).toBeNull()
    await dispose()
  })

  test('rejects a wire-supplied did instead of silently ignoring it', async () => {
    const registry = createMemoryWakeRegistry()
    const { client, dispose } = await createTestHub({ wake: { registry } })

    // The param schema declares no `did` property and sets `additionalProperties: false`, so a
    // caller trying to name another DID must be rejected outright — not accepted with the extra
    // field quietly dropped, which would leave an attacker unsure whether their attempt to
    // redirect someone else's wakes was refused or merely ignored.
    // `EK08` is enkaku's own schema-validation rejection ("Invalid protocol message"): the
    // request never reaches the handler at all, because `additionalProperties: false` on the
    // param schema is the thing actually doing the rejecting.
    await expect(
      client.request('hub/v1/wake/register', {
        param: {
          did: 'did:key:attacker',
          kind: 'webpush',
          endpoint: 'https://push.example/a',
          publicKey: recipientPublicKeyB64u,
          authSecret: recipientAuthSecretB64u,
        } as never,
      }),
    ).rejects.toMatchObject({ code: 'EK08' })
    expect(await registry.get('did:key:attacker')).toBeNull()
    await dispose()
  })
})

describe('hub/v1/wake/unregister', () => {
  test('refuses when the hub has no wake support', async () => {
    const { client, dispose } = await createTestHub({})
    await expect(client.request('hub/v1/wake/unregister', { param: {} })).rejects.toMatchObject({
      code: HUB_ERROR_CODES.wakeNotSupported,
    })
    await dispose()
  })

  test('removes the registration', async () => {
    const registry = createMemoryWakeRegistry()
    const { client, clientDID, dispose } = await createTestHub({ wake: { registry } })

    await client.request('hub/v1/wake/register', {
      param: {
        kind: 'webpush',
        endpoint: 'https://push.example/a',
        publicKey: recipientPublicKeyB64u,
        authSecret: recipientAuthSecretB64u,
      },
    })
    await expect(client.request('hub/v1/wake/unregister', { param: {} })).resolves.toEqual({
      unregistered: true,
    })
    expect(await registry.get(clientDID)).toBeNull()
    await dispose()
  })

  // `register` consumed a token and `unregister` did not, so the pair was asymmetric in exactly
  // the direction that matters: the uncounted half is the one an abusive caller uses, and here it
  // is the half that writes to a durable registry. subscribe/unsubscribe already charge both.
  test('consumes the per-DID rate limit, like register and unsubscribe', async () => {
    const registry = createMemoryWakeRegistry()
    const { client, dispose } = await createTestHub({
      wake: { registry },
      rateLimits: { perDID: { rate: 0, burst: 1 } },
    })

    await expect(client.request('hub/v1/wake/unregister', { param: {} })).resolves.toEqual({
      unregistered: false,
    })
    await expect(client.request('hub/v1/wake/unregister', { param: {} })).rejects.toMatchObject({
      code: 'EK01',
    })
    await dispose()
  })

  test('reports false when there was nothing to remove', async () => {
    const registry = createMemoryWakeRegistry()
    const { client, dispose } = await createTestHub({ wake: { registry } })
    await expect(client.request('hub/v1/wake/unregister', { param: {} })).resolves.toEqual({
      unregistered: false,
    })
    await dispose()
  })
})

describe('wake on publish', () => {
  test('wakes a subscriber with no live receive channel', async () => {
    const registry = createMemoryWakeRegistry()
    const { sender, sent } = createRecordingSender()
    const { publisher, offlineDID, dispose } = await createTestHubPair({
      wake: { registry, sender },
    })
    await registry.put({
      did: offlineDID,
      kind: 'webpush',
      endpoint: 'https://push.example/a',
      publicKey: recipientPublicKeyB64u,
      authSecret: recipientAuthSecretB64u,
    })

    const { sequenceID } = await publisher.publish({ topicID: 'topic-a', payload: 'aGk' })

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    // The hint's contents are what tell a woken device WHAT to fetch — assert them, not just that
    // something was sent. `did` alone is covered by the registry lookup (a wrong DID finds no
    // registration), but `topicID`/`sequenceID` are only ever asserted at the dispatcher level in
    // wake.test.ts, never through this fan-out hook.
    expect(openWakeHint(sent[0].body, recipientOpener)).toEqual({
      topicID: 'topic-a',
      sequenceID,
      count: 1,
    })
    await dispose()
  })

  test('does NOT wake a subscriber that is online', async () => {
    // Same harness, but the second client holds an open hub/v1/receive channel.
    const registry = createMemoryWakeRegistry()
    const { sender, sent } = createRecordingSender()
    const { publisher, offlineDID, bringOnline, dispose } = await createTestHubPair({
      wake: { registry, sender },
    })
    await registry.put({
      did: offlineDID,
      kind: 'webpush',
      endpoint: 'https://push.example/a',
      publicKey: recipientPublicKeyB64u,
      authSecret: recipientAuthSecretB64u,
    })
    await bringOnline()

    await publisher.publish({ topicID: 'topic-a', payload: 'aGk' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sent).toHaveLength(0)
    await dispose()
  })

  test('wakes on a log-class publish too — a commit is what a sleeping device most needs', async () => {
    const registry = createMemoryWakeRegistry()
    const { sender, sent } = createRecordingSender()
    const { publisher, offlineDID, dispose } = await createTestHubPair({
      wake: { registry, sender },
    })
    await registry.put({
      did: offlineDID,
      kind: 'webpush',
      endpoint: 'https://push.example/a',
      publicKey: recipientPublicKeyB64u,
      authSecret: recipientAuthSecretB64u,
    })

    await publisher.publish({ topicID: 'topic-a', payload: 'aGk', retain: 'log' })

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    await dispose()
  })

  test('never wakes the sender itself', async () => {
    const registry = createMemoryWakeRegistry()
    const { sender, sent } = createRecordingSender()
    const { publisher, publisherDID, dispose } = await createTestHubPair({
      wake: { registry, sender },
    })
    await registry.put({
      did: publisherDID,
      kind: 'webpush',
      endpoint: 'https://push.example/a',
      publicKey: recipientPublicKeyB64u,
      authSecret: recipientAuthSecretB64u,
    })

    await publisher.publish({ topicID: 'topic-a', payload: 'aGk' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sent).toHaveLength(0)
    await dispose()
  })

  test('reconnecting cancels the pending trailing summary', async () => {
    // A short (but not knife-edge) debounce window so the trailing summary — if not cancelled —
    // arrives on real timers within the test's own budget. 30ms was too tight: publish #2's full
    // RPC round trip, plus createChannel, plus the server-side bind, all had to land inside 30ms of
    // publish #1's notify, which a busy CI runner cannot promise. 300ms leaves that headroom.
    const registry = createMemoryWakeRegistry()
    const { sender, sent } = createRecordingSender()
    const { publisher, offlineDID, bringOnline, dispose } = await createTestHubPair({
      wake: { registry, sender, debounceMs: 300 },
    })
    await registry.put({
      did: offlineDID,
      kind: 'webpush',
      endpoint: 'https://push.example/a',
      publicKey: recipientPublicKeyB64u,
      authSecret: recipientAuthSecretB64u,
    })

    // Leading edge: the first offline publish wakes immediately and opens the coalescing window.
    await publisher.publish({ topicID: 'topic-a', payload: 'aGk' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    // A second offline publish inside the window arms a trailing summary.
    await publisher.publish({ topicID: 'topic-a', payload: 'aGk' })

    // The device reconnects before the window closes: `online()` must cancel the pending timer.
    await bringOnline()
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(sent).toHaveLength(1)
    await dispose()
  })

  // The positive control for the test above, which without it passes for the wrong reason: with a
  // `debounceMs` that never reached the dispatcher, the default is 10 s and the trailing ping could
  // not have fired inside a 600 ms wait whether `online()` cancelled it or not. This is the same
  // window with no reconnect, so the summary MUST arrive — which is also the only thing pinning
  // `debounceMs` end to end, through `createHub`'s pass-through and into the dispatcher.
  test('with no reconnect, the trailing summary DOES arrive inside the configured window', async () => {
    const registry = createMemoryWakeRegistry()
    const { sender, sent } = createRecordingSender()
    const { publisher, offlineDID, dispose } = await createTestHubPair({
      wake: { registry, sender, debounceMs: 300 },
    })
    await registry.put({
      did: offlineDID,
      kind: 'webpush',
      endpoint: 'https://push.example/a',
      publicKey: recipientPublicKeyB64u,
      authSecret: recipientAuthSecretB64u,
    })

    await publisher.publish({ topicID: 'topic-a', payload: 'aGk' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const { sequenceID } = await publisher.publish({ topicID: 'topic-a', payload: 'aGk' })

    await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 2000 })
    // The summary, not a second leading edge: it names the LATEST frame and counts the window.
    expect(openWakeHint(sent[1].body, recipientOpener)).toEqual({
      topicID: 'topic-a',
      sequenceID,
      count: 1,
    })
    await dispose()
  })
})

describe('createHub wake wiring', () => {
  // The `wake` variant of HubStoreErrorEvent and its STORE_ERROR_CONSEQUENCE text are reachable
  // ONLY through the `onError` callback createHub hands the dispatcher. The throwing-dispatcher
  // test above asserts a `{ method: 'wake' }` event too, but that one comes out of the fan-out
  // loop's own catch — it would still pass with the dispatcher's reporter unwired, and then an
  // operator with `onStoreError` configured would see every retry verdict and every sender throw
  // vanish silently.
  test('a retry verdict reaches the host onStoreError hook', async () => {
    const registry = createMemoryWakeRegistry()
    const events: Array<{ method: string; did?: string; error?: unknown }> = []
    const { publisher, offlineDID, dispose } = await createTestHubPair({
      onStoreError: (event) => events.push(event),
      wake: { registry, sender: { send: async () => 'retry' } },
    })
    await registry.put({
      did: offlineDID,
      kind: 'webpush',
      endpoint: 'https://push.example/a',
      publicKey: recipientPublicKeyB64u,
      authSecret: recipientAuthSecretB64u,
    })

    await publisher.publish({ topicID: 'topic-a', payload: 'aGk' })

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toEqual({ method: 'wake', did: offlineDID, error: expect.any(Error) })
    await dispose()
  })

  // Timers are `unref`'d, so a dispatcher that outlives its hub hangs nothing and shows up in no
  // other assertion — it just keeps a live coalescing window, and its trailing ping, per disposed
  // hub. A host that creates and disposes hubs accumulates them.
  test('disposing the server disposes the dispatcher, cancelling its pending window', async () => {
    const registry = createMemoryWakeRegistry()
    const { sender, sent } = createRecordingSender()
    const { publisher, offlineDID, dispose } = await createTestHubPair({
      wake: { registry, sender, debounceMs: 500 },
    })
    await registry.put({
      did: offlineDID,
      kind: 'webpush',
      endpoint: 'https://push.example/a',
      publicKey: recipientPublicKeyB64u,
      authSecret: recipientAuthSecretB64u,
    })

    await publisher.publish({ topicID: 'topic-a', payload: 'aGk' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    // Arms a trailing summary, then tears the hub down before the window closes.
    await publisher.publish({ topicID: 'topic-a', payload: 'aGk' })
    await dispose()

    // Well past the window: the summary must never fire, because dispose cleared its timer.
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(sent).toHaveLength(1)
  })
})

describe('a throwing wake dispatcher', () => {
  test('does not abort delivery to the remaining subscribers', async () => {
    // Handlers exercised directly (as in handlers.test.ts), not through a hub/transport pair: the
    // point here is the fan-out loop's own resilience to a misbehaving `dispatcher`, not wire
    // plumbing. `createWakeDispatcher`'s own `notify` cannot throw, but `dispatcher` is
    // caller-injectable through `CreateHandlersParams.wake.dispatcher`, so a third-party
    // implementation can.
    const registry = new HubClientRegistry()
    const store = createMemoryStore()
    const senderDID = 'did:key:sender'
    const onlineDID = 'did:key:online'
    const offlineDID = 'did:key:offline'

    // Subscribed in this order so `getSubscribers` yields the throwing (offline) recipient FIRST:
    // an unguarded throw during its turn would abort the loop before it ever reaches `onlineDID`.
    await store.subscribe({ subscriberDID: offlineDID, topicID: 'topic-a' })
    await store.subscribe({ subscriberDID: onlineDID, topicID: 'topic-a' })

    const delivered: Array<unknown> = []
    registry.register(onlineDID)
    registry.bindReceiveWriter(
      onlineDID,
      (message) => delivered.push(message),
      () => {},
    )

    let notifyCalls = 0
    const throwingDispatcher: WakeDispatcher = {
      notify: () => {
        notifyCalls++
        throw new Error('dispatcher exploded')
      },
      online: () => {},
      dispose: () => {},
    }
    const storeErrors: Array<{ method: string; did?: string }> = []
    const handlers = createHandlers({
      registry,
      store,
      wake: { registry: createMemoryWakeRegistry(), dispatcher: throwingDispatcher },
      onStoreError: (event) => storeErrors.push(event),
    })

    const result = await handlers['hub/v1/publish']({
      message: {
        header: {},
        payload: { typ: 'request', prc: 'hub/v1/publish', rid: '1', iss: senderDID },
      },
      param: { topicID: 'topic-a', payload: toB64(fromUTF('hi')) },
    } as never)

    expect(result).toMatchObject({ sequenceID: expect.any(String) })
    expect(notifyCalls).toBe(1)
    // The live subscriber, iterated AFTER the throwing one, still got its frame.
    expect(delivered).toHaveLength(1)
    // The throw was reported, not swallowed silently.
    expect(storeErrors).toEqual([{ method: 'wake', did: offlineDID, error: expect.any(Error) }])
  })
})
