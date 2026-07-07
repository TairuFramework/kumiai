# RPC directed-lane + recovery security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** planning
**Mode:** tasks

**Goal:** Encrypt and authenticate the `@kumiai/rpc` directed 1:1 lane against a malicious hub, seal recovery replies to the requesting member, and cap the recovery requestID.

**Architecture:** Directed frames are sealed with the same `GroupCrypto.wrap`/`unwrap` primitive the broadcast lane already uses (whole-frame, so the hub sees only ciphertext), and the authenticated `senderDID` recovered by `unwrap` — never the hub-asserted `senderDID` — drives session identity and reply routing. The client wraps its hub view with a small sealed-`HubLike` adapter; the inbox acceptor owns a single sealed drain and feeds decrypted frames into a per-session in-memory transport, binding each session to its authenticated sender. Recovery replies become 1:1 via a `GroupMLS` contract change (`exportGroupInfo(requesterDID)` returns sealed bytes) plus a `requesterDID` field on the recovery request.

**Tech Stack:** TypeScript (ESM, `#fields`, `Array<T>`, capital `ID`/`DID`), vitest, `@enkaku/*` RPC, `@kumiai/broadcast` (`ByteTransform`/`Unwrap`/`UnwrapResult`), `@kumiai/hub-tunnel` (`HubLike`, `createHubTunnelTransport`), `@sozai/codec` (`fromUTF`/`toUTF`).

## Global Constraints

- pnpm only. Run scripts as `rtk proxy pnpm run <script>` or invoke the tool directly (`pnpm exec vitest ...`, `pnpm exec biome check ...`).
- Conventions: `type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID`/`DID`/`HTTP`/`JWT`; ES `#fields`, never `private`/`readonly`. Do not edit generated files (`lib/`).
- Threat model: the hub is an adversary. Sender identity is trusted ONLY when recovered from MLS `unwrap`, never from the hub-asserted `message.senderDID` / signed-message `iss`.
- Non-goal: member-to-member confidentiality on the directed lane (group `wrap`, same guarantee as broadcast). Recovery replies are 1:1.
- Run rpc tests with: `pnpm --filter @kumiai/rpc exec vitest run` (append `<file>` to scope a single file). Run from `/Users/paul/dev/yulsi/kumiai`.

---

## File Structure

- Create: `packages/rpc/src/directed-crypto.ts` — `sealDirectedHub`, a `HubLike` wrapper that seals outbound payloads with `wrap`, opens inbound with `unwrap` (stamping the recovered `senderDID`), and optionally drops frames whose recovered sender ≠ an expected DID. Used by the directed client.
- Modify: `packages/rpc/src/directed.ts` — client uses `sealDirectedHub`; acceptor rewritten to own a sealed drain + per-session in-memory transport with sender binding.
- Modify: `packages/rpc/src/peer.ts` — thread `crypto.wrap`/`crypto.unwrap` into the directed client and acceptor; thread `requesterDID` through the recovery request/reply.
- Modify: `packages/rpc/src/recovery.ts` — `{ requestID, requesterDID }` request codec; length caps on both decoded IDs.
- Modify: `packages/rpc/src/crypto.ts` — `GroupMLS.exportGroupInfo(requesterDID: string)`.
- Modify: `packages/rpc/src/memory-group-mls.ts` — model sealing: `exportGroupInfo(requesterDID)` tags the requester; `applyRecovery` opens only bytes sealed to the instance's `localDID`.
- Create: `packages/rpc/test/directed-crypto.test.ts` — unit tests for `sealDirectedHub`.
- Modify: `packages/rpc/test/directed.test.ts` — pass crypto to the fixtures; add confidentiality + sender-binding tests.
- Modify: `packages/rpc/test/group-mls.test.ts`, `packages/rpc/test/peer-handshake-recovery.test.ts` — adapt to the sealed recovery contract.

---

## Task 1: `sealDirectedHub` sealed HubLike adapter

**Files:**
- Create: `packages/rpc/src/directed-crypto.ts`
- Test: `packages/rpc/test/directed-crypto.test.ts`

**Interfaces:**
- Consumes: `HubLike`, `HubPublishParams`, `HubReceiveSubscription`, `StoredMessage` from `@kumiai/hub-tunnel`/`@kumiai/hub-protocol`; `ByteTransform`, `Unwrap`, `UnwrapResult` from `@kumiai/broadcast`.
- Produces: `sealDirectedHub(params: SealDirectedHubParams): HubLike` where
  `SealDirectedHubParams = { hub: HubLike; wrap: ByteTransform; unwrap: Unwrap; expectedSenderDID?: string }`.
  Outbound: `publish` seals `payload` with `wrap`. Inbound: `receive` opens each message with `unwrap`, replaces `senderDID` with the recovered one, drops messages that fail to open, and — when `expectedSenderDID` is set — drops messages whose recovered `senderDID` ≠ it.

- [ ] **Step 1: Write the failing test**

Create `packages/rpc/test/directed-crypto.test.ts`:

```ts
import { describe, expect, test } from 'vitest'

import { sealDirectedHub } from '../src/directed-crypto.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'

const PLAINTEXT = new TextEncoder().encode('directed-secret')

async function drainOne(sub: ReturnType<FakeHub['receive']>): Promise<{
  senderDID: string
  payload: Uint8Array
}> {
  const { value } = await sub[Symbol.asyncIterator]().next()
  return { senderDID: value.senderDID, payload: value.payload }
}

describe('sealDirectedHub', () => {
  test('publish seals the payload (hub sees ciphertext, not plaintext)', async () => {
    const hub = new FakeHub()
    const alice = createFakeCrypto({ localDID: 'alice' })
    const sealed = sealDirectedHub({ hub, wrap: alice.wrap, unwrap: alice.unwrap })
    await sealed.publish({ senderDID: 'alice', topicID: 't', payload: PLAINTEXT })
    const onWire = hub.published[0].payload
    expect(Buffer.from(onWire).includes(Buffer.from(PLAINTEXT))).toBe(false)
  })

  test('receive opens the payload and stamps the recovered senderDID', async () => {
    const hub = new FakeHub()
    const alice = createFakeCrypto({ localDID: 'alice' })
    const bob = createFakeCrypto({ localDID: 'bob' })
    const bobView = sealDirectedHub({ hub, wrap: bob.wrap, unwrap: bob.unwrap })
    hub.subscribe('bob', 't')
    const sub = bobView.receive('bob')
    await hub.publish({ senderDID: 'lying-hub', topicID: 't', payload: await alice.wrap(PLAINTEXT) })
    const got = await drainOne(sub)
    expect(got.senderDID).toBe('alice')
    expect(got.payload).toEqual(PLAINTEXT)
  })

  test('receive drops frames whose recovered sender != expectedSenderDID', async () => {
    const hub = new FakeHub()
    const alice = createFakeCrypto({ localDID: 'alice' })
    const mallory = createFakeCrypto({ localDID: 'mallory' })
    const bob = createFakeCrypto({ localDID: 'bob' })
    const bobView = sealDirectedHub({
      hub,
      wrap: bob.wrap,
      unwrap: bob.unwrap,
      expectedSenderDID: 'alice',
    })
    hub.subscribe('bob', 't')
    const sub = bobView.receive('bob')
    await hub.publish({ senderDID: 'bob', topicID: 't', payload: await mallory.wrap(PLAINTEXT) })
    await hub.publish({ senderDID: 'bob', topicID: 't', payload: await alice.wrap(PLAINTEXT) })
    const got = await drainOne(sub)
    expect(got.senderDID).toBe('alice') // mallory's frame was skipped
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/directed-crypto.test.ts`
Expected: FAIL — `Cannot find module '../src/directed-crypto.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/rpc/src/directed-crypto.ts`:

```ts
import type { ByteTransform, Unwrap, UnwrapResult } from '@kumiai/broadcast'
import type { StoredMessage } from '@kumiai/hub-protocol'
import type { HubLike, HubPublishParams, HubReceiveSubscription } from '@kumiai/hub-tunnel'

export type SealDirectedHubParams = {
  hub: HubLike
  wrap: ByteTransform
  unwrap: Unwrap
  /** When set, inbound frames whose recovered senderDID != this are dropped. */
  expectedSenderDID?: string
}

function normalizeUnwrap(result: Uint8Array | UnwrapResult): UnwrapResult {
  return result instanceof Uint8Array ? { payload: result } : result
}

/**
 * Wrap a HubLike so directed frames are sealed with `wrap` on publish and opened
 * with `unwrap` on receive. The recovered MLS `senderDID` replaces the
 * hub-asserted one (a lying hub cannot forge it); frames that fail to open, or
 * whose recovered sender != `expectedSenderDID`, are dropped.
 */
export function sealDirectedHub(params: SealDirectedHubParams): HubLike {
  const { hub, wrap, unwrap, expectedSenderDID } = params
  return {
    async publish(publishParams: HubPublishParams): Promise<{ sequenceID: string }> {
      const sealed = await wrap(publishParams.payload)
      return hub.publish({
        senderDID: publishParams.senderDID,
        topicID: publishParams.topicID,
        payload: sealed,
      })
    },
    subscribe: (subscriberDID, topicID) => hub.subscribe(subscriberDID, topicID),
    unsubscribe: (subscriberDID, topicID) => hub.unsubscribe?.(subscriberDID, topicID),
    receive(subscriberDID): HubReceiveSubscription {
      const inner = hub.receive(subscriberDID)
      const innerIterator = inner[Symbol.asyncIterator]()
      const iterator: AsyncIterator<StoredMessage> = {
        async next(): Promise<IteratorResult<StoredMessage>> {
          while (true) {
            const result = await innerIterator.next()
            if (result.done) {
              return { value: undefined as unknown as StoredMessage, done: true }
            }
            const message = result.value
            let opened: UnwrapResult
            try {
              opened = normalizeUnwrap(await unwrap(message.payload))
            } catch {
              continue // un-openable (garbage / another lane) — drop
            }
            if (expectedSenderDID != null && opened.senderDID !== expectedSenderDID) {
              continue
            }
            return {
              value: {
                sequenceID: message.sequenceID,
                senderDID: opened.senderDID ?? message.senderDID,
                topicID: message.topicID,
                payload: opened.payload,
              },
              done: false,
            }
          }
        },
        return(): Promise<IteratorResult<StoredMessage>> {
          innerIterator.return?.()
          return Promise.resolve({ value: undefined as unknown as StoredMessage, done: true })
        },
      }
      return {
        [Symbol.asyncIterator]() {
          return iterator
        },
        return() {
          inner.return?.()
        },
      }
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/directed-crypto.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/rpc/src/directed-crypto.ts packages/rpc/test/directed-crypto.test.ts
git commit -m "feat(rpc): sealDirectedHub adapter for encrypted+authenticated directed frames"
```

---

## Task 2: Seal + authenticate the directed lane end-to-end

The directed client and inbox acceptor are interdependent (a sealed client cannot round-trip against a plaintext server), so they change together, along with the `peer.ts` wiring that constructs both.

**Files:**
- Modify: `packages/rpc/src/directed.ts` (client + acceptor)
- Modify: `packages/rpc/src/peer.ts:126-133` (acceptor construction), `packages/rpc/src/peer.ts:166-179` (client construction)
- Modify: `packages/rpc/test/directed.test.ts`

**Interfaces:**
- Consumes: `sealDirectedHub` (Task 1); `crypto.wrap: ByteTransform`, `crypto.unwrap: Unwrap` from the `GroupCrypto` on `peer.ts`.
- Produces:
  - `DirectedClientParams` gains `wrap: ByteTransform` and `unwrap: Unwrap`.
  - `InboxAcceptorParams` gains `wrap: ByteTransform` and `unwrap: Unwrap`.
  - Directed frames on the wire are ciphertext; the inbox server sees only MLS-authenticated senders.

- [ ] **Step 1: Update the directed test fixtures to thread crypto**

In `packages/rpc/test/directed.test.ts`, the two members share a group key so they can open each other's frames; each stamps its own DID. Replace the `member` helper and the two `createDirectedClient` call sites so both sides get `wrap`/`unwrap`.

At the top, add the import and per-member crypto:

```ts
import { createFakeCrypto } from './fixtures/fake-crypto.js'
```

Replace the `member` helper:

```ts
function member(hub: FakeHub, localDID: string, handlers: Record<string, unknown>) {
  const crypto = createFakeCrypto({ localDID })
  const mux = createHubMux({ hub, localDID })
  const acceptor = createInboxAcceptor({
    mux,
    localDID,
    selfInboxTopic: inboxTopic(SECRET, EPOCH, localDID),
    resolveSendTopic: (senderDID) => inboxTopic(SECRET, EPOCH, senderDID),
    protocol,
    handlers: handlers as Handlers,
    wrap: crypto.wrap,
    unwrap: crypto.unwrap,
  })
  return { mux, acceptor }
}
```

In BOTH `createDirectedClient<Protocol>({ ... })` calls (the single-caller test and the `['alice','carol'].map` test), add the caller's crypto. For the first test:

```ts
const aliceCrypto = createFakeCrypto({ localDID: 'alice' })
const aliceMux = createHubMux({ hub, localDID: 'alice' })
const { client, dispose } = createDirectedClient<Protocol>({
  mux: aliceMux,
  localDID: 'alice',
  memberDID: 'bob',
  secret: SECRET,
  epoch: EPOCH,
  getRandomID: () => 'session-a-b',
  wrap: aliceCrypto.wrap,
  unwrap: aliceCrypto.unwrap,
})
```

For the `['alice', 'carol'].map((localDID, i) => { ... })` test, inside the callback:

```ts
const callerCrypto = createFakeCrypto({ localDID })
const mux = createHubMux({ hub, localDID })
const { client, dispose } = createDirectedClient<Protocol>({
  mux,
  localDID,
  memberDID: 'bob',
  secret: SECRET,
  epoch: EPOCH,
  getRandomID: () => `session-${localDID}`,
  wrap: callerCrypto.wrap,
  unwrap: callerCrypto.unwrap,
})
```

- [ ] **Step 2: Run the directed tests to verify they fail**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/directed.test.ts`
Expected: FAIL — `wrap`/`unwrap` are not accepted params yet / directed round-trip breaks.

- [ ] **Step 3: Add crypto to the directed client**

In `packages/rpc/src/directed.ts`, add imports and extend `DirectedClientParams`, then build the client tunnel over a sealed hub bound to the target member:

```ts
import type { ByteTransform, Unwrap } from '@kumiai/broadcast'
// ...existing imports...
import { sealDirectedHub } from './directed-crypto.js'
```

```ts
export type DirectedClientParams = {
  mux: HubMux
  localDID: string
  memberDID: string
  secret: Uint8Array
  epoch: number
  wrap: ByteTransform
  unwrap: Unwrap
  getRandomID?: () => string
}
```

Replace the transport construction inside `createDirectedClient`:

```ts
export function createDirectedClient<Protocol extends ProtocolDefinition>(
  params: DirectedClientParams,
): { client: Client<Protocol>; dispose: () => Promise<void> } {
  const { mux, localDID, memberDID, secret, epoch, wrap, unwrap } = params
  const getRandomID = params.getRandomID ?? defaultRandomID
  // Replies are authored by `memberDID`; drop anything a lying hub injects under
  // a different MLS sender.
  const sealedHub = sealDirectedHub({ hub: mux.hubLike, wrap, unwrap, expectedSenderDID: memberDID })
  const transport = createHubTunnelTransport({
    hub: sealedHub,
    sessionID: getRandomID(),
    localDID,
    sendTopicID: inboxTopic(secret, epoch, memberDID),
    receiveTopicID: inboxTopic(secret, epoch, localDID),
  }) as ClientTransportOf<Protocol>
  const client = new Client<Protocol>({ transport, serverID: memberDID })
  return {
    client,
    dispose: async () => {
      await client.dispose()
    },
  }
}
```

- [ ] **Step 4: Rewrite the inbox acceptor to own a sealed drain + per-session transport**

Still in `packages/rpc/src/directed.ts`, add `StoredMessage` and codec imports and replace `InboxAcceptorParams` + `createInboxAcceptor`. The acceptor unwraps each inbound frame itself (single decrypt), binds each session to the authenticated sender, and feeds decrypted frame bytes into a per-session in-memory `HubLike` that seals its replies. This avoids relying on synchronous sink ordering, which whole-frame encryption would otherwise break.

```ts
import type { ByteTransform, Unwrap, UnwrapResult } from '@kumiai/broadcast'
import type { StoredMessage } from '@kumiai/hub-protocol'
import { createHubTunnelTransport, decodeFrame, type HubLike } from '@kumiai/hub-tunnel'
```

```ts
function normalizeUnwrap(result: Uint8Array | UnwrapResult): UnwrapResult {
  return result instanceof Uint8Array ? { payload: result } : result
}

export type InboxAcceptorParams<Protocol extends ProtocolDefinition> = {
  mux: HubMux
  localDID: string
  selfInboxTopic: string
  /** Map an authenticated senderDID to the topic we send replies on (their inbox). */
  resolveSendTopic: (senderDID: string) => string
  protocol: Protocol
  handlers: ProcedureHandlers<Protocol>
  wrap: ByteTransform
  unwrap: Unwrap
}

type ServerSession = {
  senderDID: string
  feed: (frameBytes: Uint8Array) => void
  dispose: () => Promise<void>
}

/**
 * Accept directed RPC. A single sealed drain of `selfInboxTopic` opens each
 * inbound frame with `unwrap`, binds every session to the MLS-authenticated
 * sender recovered from the ciphertext, and feeds decrypted frame bytes into a
 * per-session in-memory transport whose replies are sealed with `wrap`. Frames
 * whose recovered sender does not match the session binding are dropped, so a
 * malicious hub can neither read the lane nor forge/splice a sender.
 */
export function createInboxAcceptor<Protocol extends ProtocolDefinition>(
  params: InboxAcceptorParams<Protocol>,
): { dispose: () => Promise<void> } {
  const { mux, localDID, selfInboxTopic, resolveSendTopic, protocol, handlers, wrap, unwrap } =
    params
  const server = new Server<Protocol>({ protocol, handlers, requireAuth: false })
  const sessions = new Map<string, ServerSession>()

  const createSession = (senderDID: string): ServerSession => {
    const queue: Array<StoredMessage> = []
    let resolveNext: ((result: IteratorResult<StoredMessage>) => void) | undefined
    let closed = false
    const sessionHub: HubLike = {
      async publish(publishParams) {
        const sealed = await wrap(publishParams.payload)
        return mux.hubLike.publish({
          senderDID: publishParams.senderDID,
          topicID: publishParams.topicID,
          payload: sealed,
        })
      },
      subscribe() {},
      unsubscribe() {},
      receive() {
        const iter: AsyncIterator<StoredMessage> = {
          next() {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift() as StoredMessage, done: false })
            }
            if (closed) {
              return Promise.resolve({ value: undefined as unknown as StoredMessage, done: true })
            }
            return new Promise((resolve) => {
              resolveNext = resolve
            })
          },
          return() {
            closed = true
            return Promise.resolve({ value: undefined as unknown as StoredMessage, done: true })
          },
        }
        return {
          [Symbol.asyncIterator]: () => iter,
          return() {
            closed = true
            if (resolveNext != null) {
              const resolve = resolveNext
              resolveNext = undefined
              resolve({ value: undefined as unknown as StoredMessage, done: true })
            }
          },
        }
      },
    }
    const tunnel = createHubTunnelTransport({
      hub: sessionHub,
      sessionID: { auto: true },
      localDID,
      sendTopicID: resolveSendTopic(senderDID),
      receiveTopicID: selfInboxTopic,
    })
    void server.handle(tunnel as ServerTransportOf<Protocol>)
    return {
      senderDID,
      feed: (frameBytes) => {
        const message: StoredMessage = {
          sequenceID: '',
          senderDID,
          topicID: selfInboxTopic,
          payload: frameBytes,
        }
        if (resolveNext != null) {
          const resolve = resolveNext
          resolveNext = undefined
          resolve({ value: message, done: false })
        } else {
          queue.push(message)
        }
      },
      dispose: async () => {
        closed = true
        if (resolveNext != null) {
          const resolve = resolveNext
          resolveNext = undefined
          resolve({ value: undefined as unknown as StoredMessage, done: true })
        }
        await tunnel.dispose()
      },
    }
  }

  const unsubscribe = mux.onInbound(selfInboxTopic, (message) => {
    void (async () => {
      let opened: UnwrapResult
      try {
        opened = normalizeUnwrap(await unwrap(message.payload))
      } catch {
        return // un-openable — drop
      }
      const senderDID = opened.senderDID
      if (senderDID == null) return // no authenticated sender — drop
      let frame: ReturnType<typeof decodeFrame>
      try {
        frame = decodeFrame(opened.payload)
      } catch {
        return
      }
      const existing = sessions.get(frame.sessionID)
      if (frame.kind === 'session-end') {
        if (existing != null && existing.senderDID === senderDID) {
          sessions.delete(frame.sessionID)
          void existing.dispose()
        }
        return
      }
      if (frame.kind !== 'message') return
      if (existing != null) {
        if (existing.senderDID === senderDID) existing.feed(opened.payload)
        return // sender mismatch on an established session — splice attempt, drop
      }
      const session = createSession(senderDID)
      sessions.set(frame.sessionID, session)
      session.feed(opened.payload)
    })()
  })

  return {
    dispose: async () => {
      unsubscribe()
      const pending = [...sessions.values()].map((session) => session.dispose())
      sessions.clear()
      await Promise.allSettled(pending)
      await server.dispose()
    },
  }
}
```

- [ ] **Step 5: Thread crypto through `peer.ts`**

In `packages/rpc/src/peer.ts`, pass `crypto.wrap`/`crypto.unwrap` where the acceptor and directed client are built.

In `buildEpoch` (the `createInboxAcceptor(...)` call, ~line 126):

```ts
      const acceptor = createInboxAcceptor<ProtocolDefinition>({
        mux,
        localDID,
        selfInboxTopic: inboxTopic(secret, epoch, localDID),
        resolveSendTopic: (senderDID) => inboxTopic(secret, epoch, senderDID),
        protocol: protocol as ProtocolDefinition,
        handlers: handlers[name] as unknown as ProcedureHandlers<ProtocolDefinition>,
        wrap: crypto.wrap,
        unwrap: crypto.unwrap,
      })
```

In `surfaceFor`'s `to(memberDID)` (the `createDirectedClient(...)` call, ~line 169):

```ts
        const created = createDirectedClient<ProtocolDefinition>({
          mux,
          localDID,
          memberDID,
          secret,
          epoch,
          wrap: crypto.wrap,
          unwrap: crypto.unwrap,
          ...(getRandomID != null ? { getRandomID } : {}),
        })
```

- [ ] **Step 6: Run the directed tests to verify they pass**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/directed.test.ts`
Expected: PASS (both existing tests — the round-trip now works encrypted).

- [ ] **Step 7: Add confidentiality + sender-binding tests**

Append to `packages/rpc/test/directed.test.ts` a new `describe`:

```ts
describe('directed RPC security', () => {
  const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms))

  test('the hub never sees directed request plaintext', async () => {
    const hub = new FakeHub()
    const bob = member(hub, 'bob', {
      'rpc/double': (ctx: { param: { n: number } }) => ({ n: ctx.param.n * 2 }),
    })
    const aliceCrypto = createFakeCrypto({ localDID: 'alice' })
    const aliceMux = createHubMux({ hub, localDID: 'alice' })
    const { client, dispose } = createDirectedClient<Protocol>({
      mux: aliceMux,
      localDID: 'alice',
      memberDID: 'bob',
      secret: SECRET,
      epoch: EPOCH,
      getRandomID: () => 'session-a-b',
      wrap: aliceCrypto.wrap,
      unwrap: aliceCrypto.unwrap,
    })

    const result = await client.request('rpc/double', { param: { n: 21 } })
    expect(result).toEqual({ n: 42 })

    // 42 and 21 must not appear as plaintext JSON on any published inbox frame.
    const onWire = hub.published.map((m) => new TextDecoder().decode(m.payload)).join('|')
    expect(onWire.includes('"n":21')).toBe(false)
    expect(onWire.includes('"n":42')).toBe(false)

    await dispose()
    await aliceMux.dispose()
    await bob.acceptor.dispose()
    await bob.mux.dispose()
  })

  test('a spliced frame from another sender is dropped, not served', async () => {
    const hub = new FakeHub()
    const calls: Array<number> = []
    const bob = member(hub, 'bob', {
      'rpc/double': (ctx: { param: { n: number } }) => {
        calls.push(ctx.param.n)
        return { n: ctx.param.n * 2 }
      },
    })
    const aliceCrypto = createFakeCrypto({ localDID: 'alice' })
    const aliceMux = createHubMux({ hub, localDID: 'alice' })
    const { client, dispose } = createDirectedClient<Protocol>({
      mux: aliceMux,
      localDID: 'alice',
      memberDID: 'bob',
      secret: SECRET,
      epoch: EPOCH,
      getRandomID: () => 'session-a-b',
      wrap: aliceCrypto.wrap,
      unwrap: aliceCrypto.unwrap,
    })
    await client.request('rpc/double', { param: { n: 1 } })
    expect(calls).toEqual([1])

    // Mallory forges a frame carrying alice's sessionID onto bob's inbox. It
    // unwraps to senderDID 'mallory' != the session's bound 'alice', so it is
    // dropped and never reaches the handler.
    const mallory = createFakeCrypto({ localDID: 'mallory' })
    const forgedFrame = JSON.stringify({
      v: 1,
      sessionID: 'session-a-b',
      seq: 99,
      kind: 'message',
      body: { header: {}, payload: { typ: 'request', rid: 'x', prc: 'rpc/double', prm: { n: 7 } } },
    })
    await hub.publish({
      senderDID: 'bob',
      topicID: inboxTopic(SECRET, EPOCH, 'bob'),
      payload: await mallory.wrap(new TextEncoder().encode(forgedFrame)),
    })
    await flush()
    expect(calls).toEqual([1]) // handler NOT invoked with n:7

    await dispose()
    await aliceMux.dispose()
    await bob.acceptor.dispose()
    await bob.mux.dispose()
  })
})
```

- [ ] **Step 8: Run the full rpc suite**

Run: `pnpm --filter @kumiai/rpc exec vitest run`
Expected: PASS — including `test/peer.test.ts` (`directed request via .to(memberDID)`) and `test/integration.test.ts` (`directed request/stream/channel`), which now exercise the sealed lane through `createGroupPeer`.

- [ ] **Step 9: Commit**

```bash
git add packages/rpc/src/directed.ts packages/rpc/src/peer.ts packages/rpc/test/directed.test.ts
git commit -m "feat(rpc): encrypt and authenticate the directed 1:1 lane against a malicious hub"
```

---

## Task 3: Seal recovery replies to the requester + cap requestID

**Files:**
- Modify: `packages/rpc/src/recovery.ts`
- Modify: `packages/rpc/src/crypto.ts:50`
- Modify: `packages/rpc/src/memory-group-mls.ts`
- Modify: `packages/rpc/src/peer.ts` (`recover`, `handleRecoveryRequest`, `onHandshakeMessage`)
- Modify: `packages/rpc/test/group-mls.test.ts`, `packages/rpc/test/peer-handshake-recovery.test.ts`

**Interfaces:**
- Consumes: `GroupMLS.exportGroupInfo`, `applyRecovery` from `crypto.ts`.
- Produces:
  - `encodeRecoveryRequest(requestID: string, requesterDID: string): Uint8Array`
  - `decodeRecoveryRequest(payload: Uint8Array): { requestID: string; requesterDID: string }`
  - `GroupMLS.exportGroupInfo(requesterDID: string): Promise<Uint8Array>` returns bytes sealed to the requester.
  - `createMemoryGroupMLS` gains an optional `localDID`; `applyRecovery` opens only bytes sealed to it.

- [ ] **Step 1: Write the failing recovery-codec test**

Append to `packages/rpc/test/handshake.test.ts` (it already covers handshake framing) a new block — or create `packages/rpc/test/recovery.test.ts`:

```ts
import { describe, expect, test } from 'vitest'

import { decodeRecoveryRequest, encodeRecoveryRequest } from '../src/recovery.js'

describe('recovery request codec', () => {
  test('round-trips requestID and requesterDID', () => {
    const bytes = encodeRecoveryRequest('req-1', 'did:key:alice')
    expect(decodeRecoveryRequest(bytes)).toEqual({
      requestID: 'req-1',
      requesterDID: 'did:key:alice',
    })
  })

  test('rejects an over-long requestID', () => {
    expect(() => encodeRecoveryRequest('x'.repeat(200), 'did:key:alice')).toThrow(/requestID/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/recovery.test.ts`
Expected: FAIL — `encodeRecoveryRequest` takes one arg / decode returns a string.

- [ ] **Step 3: Update the recovery codec with the requesterDID field and caps**

Replace the request codec in `packages/rpc/src/recovery.ts` and add the cap to the reply decode. Full file:

```ts
import { fromUTF, toUTF } from '@sozai/codec'

/**
 * Payload codecs for the recovery rendezvous carried on the handshake lane. A
 * request names a `requestID` (so replies correlate and redundant responders can
 * observe-and-suppress) and the `requesterDID` the responder seals its reply to;
 * a reply echoes the `requestID` and carries the sealed GroupInfo.
 */

/** Cap on decoded ID lengths — these become attacker-controlled map keys. */
const MAX_REQUEST_ID_BYTES = 128
const MAX_REQUESTER_DID_BYTES = 512

export function encodeRecoveryRequest(requestID: string, requesterDID: string): Uint8Array {
  const rid = fromUTF(requestID)
  const did = fromUTF(requesterDID)
  if (rid.length > MAX_REQUEST_ID_BYTES) {
    throw new Error('recovery request requestID is too long')
  }
  if (did.length > MAX_REQUESTER_DID_BYTES) {
    throw new Error('recovery request requesterDID is too long')
  }
  const out = new Uint8Array(2 + rid.length + 2 + did.length)
  const view = new DataView(out.buffer)
  view.setUint16(0, rid.length, true)
  out.set(rid, 2)
  view.setUint16(2 + rid.length, did.length, true)
  out.set(did, 2 + rid.length + 2)
  return out
}

export function decodeRecoveryRequest(payload: Uint8Array): {
  requestID: string
  requesterDID: string
} {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  if (payload.length < 2) {
    throw new Error('recovery request is too short')
  }
  const ridLen = view.getUint16(0, true)
  if (ridLen > MAX_REQUEST_ID_BYTES) {
    throw new Error('recovery request requestID is too long')
  }
  if (payload.length < 2 + ridLen + 2) {
    throw new Error('recovery request is truncated')
  }
  const requestID = toUTF(payload.subarray(2, 2 + ridLen))
  const didLen = view.getUint16(2 + ridLen, true)
  if (didLen > MAX_REQUESTER_DID_BYTES) {
    throw new Error('recovery request requesterDID is too long')
  }
  if (payload.length < 2 + ridLen + 2 + didLen) {
    throw new Error('recovery request is truncated')
  }
  const requesterDID = toUTF(payload.subarray(2 + ridLen + 2, 2 + ridLen + 2 + didLen))
  return { requestID, requesterDID }
}

export function encodeRecoveryReply(requestID: string, groupInfo: Uint8Array): Uint8Array {
  const rid = fromUTF(requestID)
  if (rid.length > MAX_REQUEST_ID_BYTES) {
    throw new Error('recovery reply requestID is too long')
  }
  const out = new Uint8Array(2 + rid.length + groupInfo.length)
  new DataView(out.buffer).setUint16(0, rid.length, true)
  out.set(rid, 2)
  out.set(groupInfo, 2 + rid.length)
  return out
}

export function decodeRecoveryReply(payload: Uint8Array): {
  requestID: string
  groupInfo: Uint8Array
} {
  if (payload.length < 2) {
    throw new Error('recovery reply is too short')
  }
  const ridLen = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(
    0,
    true,
  )
  if (ridLen > MAX_REQUEST_ID_BYTES) {
    throw new Error('recovery reply requestID is too long')
  }
  if (payload.length < 2 + ridLen) {
    throw new Error('recovery reply is truncated')
  }
  return {
    requestID: toUTF(payload.subarray(2, 2 + ridLen)),
    groupInfo: payload.subarray(2 + ridLen),
  }
}
```

- [ ] **Step 4: Run the codec test to verify it passes**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/recovery.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Change the `GroupMLS` contract**

In `packages/rpc/src/crypto.ts`, update the `exportGroupInfo` signature and its doc comment:

```ts
  /**
   * Export current group state for a recovery responder, sealed to the
   * requesting member's MLS leaf so only that requester (not the hub, not other
   * members) can open it.
   */
  exportGroupInfo(requesterDID: string): Promise<Uint8Array>
  /** Re-sync from a sealed recovery reply, returning whether the epoch advanced. */
  applyRecovery(groupInfo: Uint8Array): Promise<{ advanced: boolean }>
```

- [ ] **Step 6: Write the failing sealing test for the memory port**

Replace the `exportGroupInfo + applyRecovery` test in `packages/rpc/test/group-mls.test.ts` and add a wrong-recipient case. Update the two existing call sites (lines ~22-28 and ~33-34) to pass `localDID` and a `requesterDID`:

```ts
  test('exportGroupInfo + applyRecovery jumps a stranded peer forward', async () => {
    const live = createMemoryGroupMLS({ recoverySecret: new Uint8Array(32).fill(1), localDID: 'live' })
    // advance live to epoch 2
    await live.processCommit(Uint8Array.from([1]), { senderDID: 'live' })
    await live.processCommit(Uint8Array.from([1]), { senderDID: 'live' })
    const stranded = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      localDID: 'stranded',
    })
    const groupInfo = await live.exportGroupInfo('stranded')
    expect(await stranded.applyRecovery(groupInfo)).toEqual({ advanced: true })
    expect(stranded.epoch()).toBe(2)
  })

  test('a member other than the requester cannot open the sealed GroupInfo', async () => {
    const live = createMemoryGroupMLS({ recoverySecret: new Uint8Array(32).fill(1), localDID: 'live' })
    await live.processCommit(Uint8Array.from([1]), { senderDID: 'live' })
    const eve = createMemoryGroupMLS({ recoverySecret: new Uint8Array(32).fill(1), localDID: 'eve' })
    const sealed = await live.exportGroupInfo('stranded') // sealed to 'stranded', not 'eve'
    expect(await eve.applyRecovery(sealed)).toEqual({ advanced: false })
  })

  test('applyRecovery is a no-op when already current', async () => {
    const mls = createMemoryGroupMLS({ recoverySecret: new Uint8Array(32).fill(1), localDID: 'self' })
    expect(await mls.applyRecovery(await mls.exportGroupInfo('self'))).toEqual({ advanced: false })
  })
```

(Leave the other `createMemoryGroupMLS` tests in the file that never call `exportGroupInfo` unchanged.)

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/group-mls.test.ts`
Expected: FAIL — `exportGroupInfo` still takes no arg / no `localDID` sealing.

- [ ] **Step 8: Model sealing in the memory port**

In `packages/rpc/src/memory-group-mls.ts`, add `localDID`, seal the requester into the exported bytes, and open only bytes sealed to this instance's `localDID`:

```ts
import { fromUTF, toUTF } from '@sozai/codec'

import type { CommitContext, GroupMLS } from './crypto.js'

export type MemoryGroupMLS = GroupMLS & {
  epoch: () => number
  commits: () => number
  lastSender: () => string | undefined
}

export type MemoryGroupMLSOptions = {
  recoverySecret?: Uint8Array
  epoch?: number
  /** This member's DID — modelled recipient of GroupInfo sealed to its leaf. */
  localDID?: string
  /** Called whenever the modelled epoch advances (e.g. to keep a GroupCrypto in step). */
  onAdvance?: (epoch: number) => void
}
```

Add seal/open helpers and rewrite `exportGroupInfo`/`applyRecovery` inside `createMemoryGroupMLS`:

```ts
export function createMemoryGroupMLS(options: MemoryGroupMLSOptions = {}): MemoryGroupMLS {
  const recoverySecret = options.recoverySecret ?? new Uint8Array(32).fill(0x33)
  const localDID = options.localDID
  let epoch = options.epoch ?? 0
  let commits = 0
  let lastSender: string | undefined

  const advance = (to: number): void => {
    epoch = to
    options.onAdvance?.(epoch)
  }

  // Seal = [didLen(2)][requesterDID][epoch(1)]. NOT real crypto — a test double
  // that models "only the sealed-to member can open it".
  const seal = (requesterDID: string, epochByte: number): Uint8Array => {
    const did = fromUTF(requesterDID)
    const out = new Uint8Array(2 + did.length + 1)
    new DataView(out.buffer).setUint16(0, did.length, true)
    out.set(did, 2)
    out[2 + did.length] = epochByte
    return out
  }

  const open = (sealed: Uint8Array): number | undefined => {
    if (sealed.length < 3) return undefined
    const didLen = new DataView(sealed.buffer, sealed.byteOffset, sealed.byteLength).getUint16(
      0,
      true,
    )
    if (sealed.length < 2 + didLen + 1) return undefined
    const sealedTo = toUTF(sealed.subarray(2, 2 + didLen))
    // A member with a set localDID can open only bytes sealed to it. When unset,
    // the double is permissive (used by wiring tests that don't assert sealing).
    if (localDID != null && sealedTo !== localDID) return undefined
    return sealed[2 + didLen]
  }

  return {
    epoch: () => epoch,
    commits: () => commits,
    lastSender: () => lastSender,
    async processCommit(commit: Uint8Array, context: CommitContext) {
      lastSender = context.senderDID
      if (commit.length === 0) {
        return { advanced: false }
      }
      commits += 1
      advance(epoch + 1)
      return { advanced: true }
    },
    async exportGroupInfo(requesterDID: string) {
      return seal(requesterDID, epoch)
    },
    async applyRecovery(groupInfo: Uint8Array) {
      const target = open(groupInfo)
      if (target == null || target <= epoch) {
        return { advanced: false }
      }
      advance(target)
      return { advanced: true }
    },
    exportRecoverySecret() {
      return recoverySecret
    },
  }
}
```

- [ ] **Step 9: Run the memory-port test to verify it passes**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/group-mls.test.ts`
Expected: PASS.

- [ ] **Step 10: Thread `requesterDID` through `peer.ts`**

In `packages/rpc/src/peer.ts`:

Change `handleRecoveryRequest` to accept the decoded request object and pass the requester to `exportGroupInfo`:

```ts
  const handleRecoveryRequest = (request: { requestID: string; requesterDID: string }): void => {
    const { requestID, requesterDID } = request
    if (mls == null || handshakeTopicID == null) return
    if (suppressedRequests.has(requestID) || pendingReplies.has(requestID)) return
    const port = mls
    const topicID = handshakeTopicID
    const timer = setTimeout(() => {
      pendingReplies.delete(requestID)
      void (async () => {
        try {
          const groupInfo = await port.exportGroupInfo(requesterDID)
          await mux.bus.publish(
            topicID,
            encodeHandshakeFrame(
              HANDSHAKE_KIND.recoveryReply,
              encodeRecoveryReply(requestID, groupInfo),
            ),
          )
        } catch {
          // a failed reply just means another responder (or a retry) covers it
        }
      })()
    }, getReplyDelayMs())
    pendingReplies.set(requestID, timer)
  }
```

Update the dispatch in `onHandshakeMessage` (the `recoveryRequest` branch) — it already passes the decoded value, now an object:

```ts
        if (frame.kind === HANDSHAKE_KIND.recoveryRequest) {
          handleRecoveryRequest(decodeRecoveryRequest(frame.payload))
          ack()
          return
        }
```

In `recover`, send the local DID as the requester:

```ts
      void Promise.resolve(
        mux.bus.publish(
          topicID,
          encodeHandshakeFrame(
            HANDSHAKE_KIND.recoveryRequest,
            encodeRecoveryRequest(requestID, localDID),
          ),
        ),
      ).catch(() => {})
```

- [ ] **Step 11: Update the recovery integration test helper**

In `packages/rpc/test/peer-handshake-recovery.test.ts`, pass `localDID` into the port so the requester ('eve') can open GroupInfo sealed to it:

```ts
  const mls = createMemoryGroupMLS({
    recoverySecret,
    epoch,
    localDID,
    onAdvance: (e) => crypto.setEpoch(e),
  })
```

- [ ] **Step 12: Run the full rpc suite**

Run: `pnpm --filter @kumiai/rpc exec vitest run`
Expected: PASS — recovery rendezvous still storm-collapses and advances the stranded peer, now with a reply sealed to the requester.

- [ ] **Step 13: Commit**

```bash
git add packages/rpc/src/recovery.ts packages/rpc/src/crypto.ts packages/rpc/src/memory-group-mls.ts packages/rpc/src/peer.ts packages/rpc/test/recovery.test.ts packages/rpc/test/group-mls.test.ts packages/rpc/test/peer-handshake-recovery.test.ts
git commit -m "feat(rpc): seal recovery replies to the requester and cap recovery IDs"
```

---

## Final verification

- [ ] **Full workspace check**

Run: `pnpm --filter @kumiai/rpc exec vitest run` then `pnpm exec biome check packages/rpc` and `pnpm --filter @kumiai/rpc run build:types`
Expected: all green — tests pass, no lint errors, types build.

---

## Self-review notes (author)

- **Spec coverage:** Critical (directed plaintext) → Task 2 whole-frame `wrap`/`unwrap`. High #1 (`requireAuth:false` forgery) → Task 2 session binding + authenticated `senderDID` routing. High #3 (GroupInfo leak) → Task 3 sealed `exportGroupInfo(requesterDID)`. Low (unbounded requestID key) → Task 3 codec caps. Tests: hub-can't-read (T2 s7), splice/forgery drop (T2 s7), recovery seal + wrong-recipient (T3 s6), requestID cap (T3 s1). All spec sections mapped.
- **Type consistency:** `wrap: ByteTransform`, `unwrap: Unwrap` used identically in `directed-crypto.ts`, `directed.ts`, and `peer.ts`. `exportGroupInfo(requesterDID: string)` matches its call in `handleRecoveryRequest` and the memory port. `encodeRecoveryRequest(requestID, requesterDID)` matches the `recover` call and `decodeRecoveryRequest` return shape.
- **Open item deferred to execution:** whether to also encrypt Commit frames on the handshake lane — out of scope here (finding only covers the recovery reply); Commits are MLS-integrity-protected. Not blocking.
