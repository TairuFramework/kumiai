# Three High-Severity Correctness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** planning
**Mode:** tasks

**Goal:** Gate `to()` on peer readiness, put `resync()` under the commit mutex, and reconnect the
durable-ack relay so the app lane, the inbox lane and directed tunnels acknowledge delivered frames.

**Architecture:** Two small local changes in `packages/rpc/src/peer.ts`, then a refcounted ack relay
through the hub mux. The mux tracks, per delivered message, the set of local holders that received
it, and acknowledges upstream only when the last one releases — mirroring `LogEntry.pendingFor` in
`packages/hub-server/src/memoryStore.ts`, which already implements exactly this policy one layer
down. Five relay points that currently forward a message and drop its ack are reconnected, and the
behaviour is pinned by new clauses in `@kumiai/hub-conformance`.

**Tech Stack:** TypeScript (ES2025, strict), pnpm workspaces, Turbo, SWC, Biome, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-23-high-severity-correctness-design.md`
**Branch:** `fix/high-severity-correctness`

## Global Constraints

- **pnpm only.** Never npm or yarn.
- **Never edit `lib/`** — generated output. Source lives in `src/`.
- Type definitions use `type`, never `interface`. Arrays are `Array<T>`, never `T[]`.
- Never `any` — use `unknown` or a specific type.
- Classes use ES private fields (`#field`), never the TypeScript `private`, `readonly` or
  `protected` modifiers.
- Abbreviations stay capitalised: `ID`, `DID`, `TTL`, `HTTP`. Write `sequenceID`, never `sequenceId`.
- Type-only imports use `import type`.
- Biome formatting: 2-space indent, 100-column lines, single quotes, trailing commas. Imports are in
  two blocks — external then relative — and Biome sorts them; never hand-sort.
- Comments are terse and explain *why*. No plan or task references in code, comments, or test names.
- **Lint must be run as `rtk proxy pnpm run lint`.** A local `rtk` shim intercepts plain
  `pnpm run lint` and `pnpm exec biome` and redirects them to the wrong tool, reporting success
  without checking anything.
- `pnpm test` reports cached Turbo results. When verifying a full run, confirm the summary line says
  `Cached: 0`. `pnpm test -- --force` does not work — use `pnpm exec turbo run test:types test:unit --force`.
- Changing a port means running **both** contract suites against the real implementation **and**
  every double, not just the real one.
- Every package is `0.4.x`. A breaking change is a `minor`.

---

### Task 1: `to()` gated on `ready`

`peer.protocol(name)` returns four methods; three are wrapped in `withReady` and `to` is not
(`packages/rpc/src/peer.ts:1943-1946`). Called before init completes, it reaches `surfaceFor`
(`:647`) with no protocol registered and throws `Unknown protocol: <name>` for a name that is
perfectly valid. It has a second pre-ready failure too: `Peer is not started` at `:669` when
`inboxLane` is still null.

This changes `to`'s return type from `Client<Protocol>` to `Promise<Client<Protocol>>` — a breaking
change on `@kumiai/rpc`'s public surface, which is a `minor` while the package is 0.x.

**Files:**
- Modify: `packages/rpc/src/peer.ts:258` (the `ProtocolSurface.to` type)
- Modify: `packages/rpc/src/peer.ts:665` (`surfaceFor`'s `to`)
- Modify: `packages/rpc/src/peer.ts:1946` (the public wrapper)
- Modify: `packages/rpc/test/peer.test.ts:79`
- Modify: `packages/rpc/test/peer-inbox-single-open.test.ts:70,104,108`
- Modify: `packages/rpc/test/integration.test.ts:101,113`
- Modify: `tests/integration/test/directed-lane.test.ts:84,147`
- Test: `packages/rpc/test/peer-to-ready.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ProtocolSurface.to: (memberDID: string) => Promise<Client<Protocol>>`. No later task
  depends on it.

- [ ] **Step 1: Write the failing test**

Create `packages/rpc/test/peer-to-ready.test.ts`:

```ts
import type { ProtocolDefinition } from '@enkaku/protocol'
import { describe, expect, test } from 'vitest'

import { createGroupPeer } from '../src/peer.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'

const chat = {
  'chat/echo': { type: 'request', param: { type: 'object' }, result: { type: 'object' } },
} as const satisfies ProtocolDefinition

type Protocols = { chat: typeof chat }

describe('to() is gated on readiness', () => {
  test('to() called before init resolves instead of throwing Unknown protocol', async () => {
    const hub = new FakeHub()
    const peer = createGroupPeer<Protocols>({
      hub,
      crypto: createFakeCrypto({ epoch: 1, localDID: 'alice' }),
      localDID: 'alice',
      protocols: { chat },
      handlers: { chat: {} } as never,
    })

    // No flush: this is the timing bug. `to()` is reached while `runtimes` is still empty and
    // `inboxLane` is still null, so the unwrapped version throws `Unknown protocol: chat` for a
    // name that is perfectly valid — a misleading error for a caller that is merely early.
    const client = await peer.protocol('chat').to('bob')
    expect(client).toBeDefined()

    await peer.dispose()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/peer-to-ready.test.ts`
Expected: FAIL with `Unknown protocol: chat`.

- [ ] **Step 3: Change the `ProtocolSurface` type**

In `packages/rpc/src/peer.ts`, at line 258:

```ts
export type ProtocolSurface<Protocol extends ProtocolDefinition> = {
  dispatch: (prc: string, data?: Record<string, unknown>) => Promise<void>
  request: (prc: string, prm?: unknown, options?: RequestOptions) => Promise<unknown>
  gather: (prc: string, prm?: unknown, options?: GatherOptions) => Promise<Array<GatheredReply>>
  to: (memberDID: string) => Promise<Client<Protocol>>
}
```

- [ ] **Step 4: Make `surfaceFor`'s `to` async**

`surfaceFor` returns a `ProtocolSurface<ProtocolDefinition>` object literal, so its `to` must match
the new type. At `packages/rpc/src/peer.ts:665`, change the arrow to `async` — the body is unchanged:

```ts
      to: async (memberDID) => {
```

- [ ] **Step 5: Wrap the public `to` in `withReady`**

At `packages/rpc/src/peer.ts:1946`, replace:

```ts
        to: (memberDID) => surfaceFor(key).to(memberDID),
```

with:

```ts
        to: (memberDID) => withReady(() => surfaceFor(key).to(memberDID)),
```

`withReady` is `async <T>(fn: () => T | Promise<T>): Promise<T>`, so the returned promise is
flattened — the result is `Promise<Client<Protocol>>`, not a nested promise.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/peer-to-ready.test.ts`
Expected: PASS.

- [ ] **Step 7: Update the nine existing call sites**

Each becomes an `await`. In `packages/rpc/test/peer.test.ts:79`, in
`packages/rpc/test/peer-inbox-single-open.test.ts:70,104,108`, in
`packages/rpc/test/integration.test.ts:101,113`, and in
`tests/integration/test/directed-lane.test.ts:84,147`, a call of the shape:

```ts
    const reply = await alice.peer
      .protocol('chat')
      .to('bob')
      .request('chat/echo', { text: 'hi' })
```

becomes:

```ts
    const client = await alice.peer.protocol('chat').to('bob')
    const reply = await client.request('chat/echo', { text: 'hi' })
```

and a call of the shape:

```ts
    const channel = alice.protocol('app').to('bob').createChannel('app/sync', { param: {} })
```

becomes:

```ts
    const channel = (await alice.protocol('app').to('bob')).createChannel('app/sync', { param: {} })
```

- [ ] **Step 8: Run the full rpc suite**

Run: `pnpm --filter @kumiai/rpc test`
Expected: PASS, both `test:types` and `test:unit`.

- [ ] **Step 9: Run the integration suite**

Run: `pnpm --filter @kumiai/integration-tests test`
Expected: PASS.

- [ ] **Step 10: Lint**

Run: `rtk proxy pnpm run lint`
Expected: no diagnostics.

- [ ] **Step 11: Commit**

```bash
git add packages/rpc/src/peer.ts packages/rpc/test tests/integration/test/directed-lane.test.ts
git commit -m "fix(rpc): gate protocol().to() on peer readiness

Three of the four methods `protocol()` returns are wrapped in `withReady`;
`to` was not. Called before init completes it reached `surfaceFor` with no
protocol registered and threw `Unknown protocol` for a valid name, or
`Peer is not started` — misleading errors for a timing bug.

BREAKING: `ProtocolSurface.to` now returns `Promise<Client<Protocol>>`."
```

---

### Task 2: `resync()` under the commit mutex

`resync()` (`packages/rpc/src/peer.ts:1952-1955`) calls `rebuildEpoch()` directly. Every one of the
other seven `rebuildEpoch()` call sites runs under `runSerial` — `:1305` under `:1298`; `:1575` and
`:1682` under `:1573`; `:1698` under `:1697`; `:1770` and `:1860` under `:1767`; and `:1287` inside
`reconcileCommits`, reached only from `:1596` and `:1779`, both themselves inside `runSerial`
blocks. `resync()` is the only caller that takes no lock, so a host-called `resync()` can interleave
with an inbound-commit rebuild and run two concurrent teardown/build cycles over shared
`runtimes`/`secret`/`epoch` state.

**Files:**
- Modify: `packages/rpc/src/peer.ts:1952-1955`
- Test: `packages/rpc/test/peer-resync-serial.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks rely on. `resync`'s signature is unchanged — still
  `() => Promise<void>`.

- [ ] **Step 1: Confirm the two preconditions before writing code**

`runSerial` is explicitly **not reentrant** (`packages/rpc/src/peer.ts:791-792`): a task that calls
it again waits on a tail that includes itself, which deadlocks. Wrapping `resync` is only safe while
both of these hold. Verify each now, in the source, and stop if either has changed:

1. `rebuildEpoch` does not itself call `runSerial`. Check its body.
2. `resync` is a top-level entry point on the returned peer object, not reachable from inside
   another `runSerial` block.

- [ ] **Step 2: Write the failing test**

Create `packages/rpc/test/peer-resync-serial.test.ts`:

```ts
import { describe, expect, test } from 'vitest'

import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'
import { FakeHub } from './fixtures/fake-hub.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

describe('resync() takes the commit mutex', () => {
  test('resync() does not rebuild while a commit holds the lane', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x11)
    const alice = makeMLSPeer(hub, 'alice', recoverySecret)
    await flush()

    const order: Array<string> = []
    let releaseBuild: (() => void) | undefined
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve
    })

    const build = buildLedgerCommit(alice, [])
    const committing = alice.peer.commit(async () => {
      order.push('build-start')
      await buildGate
      const pending = await build()
      order.push('build-end')
      return pending
    })
    await flush()

    const resyncing = alice.peer.resync().then(() => {
      order.push('resync-done')
    })
    await flush()

    // The commit holds `commitTail`. An unlocked `resync()` would have torn down and rebuilt the
    // epoch here, concurrently with the commit's own rebuild, over shared runtimes/secret/epoch.
    expect(order).toEqual(['build-start'])

    releaseBuild?.()
    await committing
    await resyncing
    expect(order).toEqual(['build-start', 'build-end', 'resync-done'])

    await alice.peer.dispose()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/peer-resync-serial.test.ts`
Expected: FAIL — `order` is `['build-start', 'resync-done']` at the first assertion, because
`resync()` ran straight through while the commit still held the lane.

- [ ] **Step 4: Take the mutex**

In `packages/rpc/src/peer.ts`, replace lines 1952-1955:

```ts
    resync: async () => {
      await ready
      await rebuildEpoch()
    },
```

with:

```ts
    resync: async () => {
      await ready
      // Every other `rebuildEpoch` caller runs under the commit mutex. Unlocked, a host-called
      // resync interleaves with an inbound-commit rebuild and runs two teardown/build cycles over
      // one set of runtimes. Safe to wrap only because `rebuildEpoch` takes no lock itself and
      // this is a top-level entry — `runSerial` is not reentrant.
      await runSerial(() => rebuildEpoch())
    },
```

`runSerial` also clears `journalReplayed` when an operation takes the mutex. A rebuild that does not
replay therefore leaves it false, which is the conservative state `pullCommits` requires — no
journal-invariant change.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/peer-resync-serial.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full rpc suite**

Run: `pnpm --filter @kumiai/rpc test`
Expected: PASS. Watch specifically for a hang — a deadlock from reentrancy shows up as a timeout,
not a failed assertion. If any test times out, revisit Step 1.

- [ ] **Step 7: Lint and commit**

```bash
rtk proxy pnpm run lint
git add packages/rpc/src/peer.ts packages/rpc/test/peer-resync-serial.test.ts
git commit -m "fix(rpc): run resync() under the commit mutex

Every other rebuildEpoch() call site runs under runSerial; resync() was the
one that did not, so a host-called resync could interleave with an
inbound-commit rebuild and run two concurrent teardown/build cycles over
shared runtimes/secret/epoch state."
```

---

### Task 3: Optional topic scope on `receive`

The mux's sinks are not topic-filtered (`packages/rpc/src/hub-mux.ts:489`): every message reaches
every sink, and each consumer discards on topic mismatch. A refcount that counted all sinks as
pending holders would leave a commit frame waiting on tunnels that will never ack it, making TTL
expiry the usual outcome rather than a backstop. Consumers must be filtered before they are counted,
and a sink cannot be filtered without knowing its topic.

An **added optional parameter is additive**: an implementation declaring fewer parameters stays
assignable to the widened function type, so every existing double and both conformance suites keep
compiling untouched. Task 3 establishes that and proves it with a full build.

**Files:**
- Modify: `packages/hub-tunnel/src/transport.ts:106-115` (`HubBase`), `:14-23` (add the options type)
- Modify: `packages/hub-tunnel/src/index.ts` (export `HubReceiveOptions`)
- Modify: `packages/hub-tunnel/src/transport.ts:209` (the tunnel passes its topic)
- Modify: `packages/hub-conformance/src/log-hub.ts:42-51` (`ConformanceMailboxHub.receive`)
- Test: `packages/hub-tunnel/test/transport-receive-scope.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export type HubReceiveOptions = { topicID?: string }` from `@kumiai/hub-tunnel`
  - `HubBase.receive: (subscriberDID: string, options?: HubReceiveOptions) => HubReceiveSubscription`
  - Tasks 4, 5, 7, 8 and 9 all rely on this signature.

- [ ] **Step 1: Write the failing test**

Create `packages/hub-tunnel/test/transport-receive-scope.test.ts`:

```ts
import { describe, expect, test } from 'vitest'

import {
  createHubTunnelTransport,
  type HubReceiveSubscription,
  type MailboxHub,
} from '../src/transport.js'
import { FakeHub } from './fixtures/fake-hub.js'

describe('the tunnel scopes its receive', () => {
  test('the tunnel tells the hub which topic it reads', async () => {
    const fakeHub = new FakeHub()
    const scopes: Array<string | undefined> = []
    // Delegating explicitly, not spreading: `FakeHub` is a class, and `{...instance}` copies own
    // enumerable properties only — every prototype method would be lost. Same shape as
    // `transport-reconnect.test.ts:125`.
    const recordingHub: MailboxHub = {
      publish: (params) => fakeHub.publish(params),
      subscribe: (subscriberDID, topicID, options) =>
        fakeHub.subscribe(subscriberDID, topicID, options),
      unsubscribe: (subscriberDID, topicID) => fakeHub.unsubscribe(subscriberDID, topicID),
      receive: (subscriberDID, options): HubReceiveSubscription => {
        scopes.push(options?.topicID)
        return fakeHub.receive(subscriberDID)
      },
    }

    const transport = createHubTunnelTransport({
      hub: recordingHub,
      sessionID: 'session-1',
      localDID: 'did:key:alice',
      sendTopicID: 'topic:out',
      receiveTopicID: 'topic:in',
    })

    // A hub that knows the scope can refcount an ack against the consumers that will actually
    // handle a frame. Without it every sink is a candidate holder for every message.
    expect(scopes).toEqual(['topic:in'])

    await transport.dispose()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kumiai/hub-tunnel exec vitest run test/transport-receive-scope.test.ts`
Expected: FAIL — `scopes` is `[undefined]`, since `receive` is called with one argument.

- [ ] **Step 3: Add the options type**

In `packages/hub-tunnel/src/transport.ts`, after the `HubReceiveSubscription` type (ends at line 23):

```ts
/**
 * Scope for a receive stream. A hub that knows which topic a subscription reads can tell which
 * consumers will actually handle a frame, which is what a refcounted ack needs — an unscoped
 * stream is a candidate holder for every message on every topic.
 *
 * Optional, and a hub is free to ignore it: the consumer still filters what it is handed.
 */
export type HubReceiveOptions = {
  topicID?: string
}
```

- [ ] **Step 4: Widen `HubBase.receive`**

In the same file, in the `HubBase` type (line 113):

```ts
  receive: (subscriberDID: string, options?: HubReceiveOptions) => HubReceiveSubscription
```

- [ ] **Step 5: Export the type**

In `packages/hub-tunnel/src/index.ts`, the `./transport.js` export block is alphabetical. Insert
between `HubPublishParams` and `HubReceiveSubscription`:

```ts
  type HubPublishParams,
  type HubReceiveOptions,
  type HubReceiveSubscription,
```

- [ ] **Step 6: Pass the scope from the tunnel**

In `packages/hub-tunnel/src/transport.ts` at line 209:

```ts
  const subscription = hub.receive(localDID, { topicID: receiveTopicID })
```

- [ ] **Step 7: Confirm the consumer-side filter stays**

The read pump filters by topic itself at `packages/hub-tunnel/src/transport.ts:334`:

```ts
            if (message.topicID !== receiveTopicID) {
              onEvent?.({ type: 'frame-dropped', reason: 'topic-mismatch' })
              continue
            }
```

**Do not remove it.** `HubReceiveOptions` is a hint a hub is free to ignore, so this is the
enforcement — deleting it would trust every hub to honour the scope. Nothing to edit; read the line,
confirm it is unchanged, and move on.

- [ ] **Step 8: Widen the conformance shape**

In `packages/hub-conformance/src/log-hub.ts`, in `ConformanceMailboxHub` (line 49):

```ts
  receive: (
    subscriberDID: string,
    options?: { topicID?: string },
  ) => ConformanceReceiveSubscription
```

The suite re-declares the hub shapes structurally rather than importing them, to avoid a package
cycle (see the module docblock at `:17-19`). The coverage tripwire in
`packages/hub-tunnel/test/hub-conformance.test.ts:17-20` checks assignability in both directions, so
this must match or that file fails to compile.

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm --filter @kumiai/hub-tunnel exec vitest run test/transport-receive-scope.test.ts`
Expected: PASS.

- [ ] **Step 10: Prove the change is additive**

The claim that an added optional parameter breaks nothing is the whole basis for calling this
additive rather than breaking. Verify it against every existing double, none of which declares the
new parameter:

Run: `pnpm exec turbo run build:types --force`
Expected: all packages succeed, `Cached: 0`.

Run: `pnpm exec turbo run test:types --force`
Expected: all packages succeed, `Cached: 0`. In particular
`packages/hub-tunnel/test/hub-conformance.test.ts` must still compile — that is the tripwire.

If any double fails to compile, stop: the change is breaking after all, and the spec's blast radius
is wrong.

- [ ] **Step 11: Lint and commit**

```bash
rtk proxy pnpm run lint
git add packages/hub-tunnel/src packages/hub-tunnel/test packages/hub-conformance/src/log-hub.ts
git commit -m "feat(hub-tunnel): optional topic scope on receive

A hub that knows which topic a receive stream reads can tell which consumers
will actually handle a frame — what a refcounted ack needs. An added optional
parameter is additive: implementations declaring fewer parameters stay
assignable, so every existing double compiles untouched."
```

---

### Task 4: Refcounted ack tracking in the hub mux

The mux drain holds the one real `subscription.ack` and hands an ack closure to each `onInbound`
listener (`packages/rpc/src/hub-mux.ts:475-481`). That closure acks upstream **immediately**, while
sinks still hold the same message. Once the severed relays are reconnected in Tasks 5–9, the first
holder to ack would free a frame every other holder is still working on.

This task mirrors the policy `packages/hub-server/src/memoryStore.ts` already implements one layer
down:

```ts
pendingFor: Set<string>                            // memoryStore.ts:29 — the refcount

function dropDelivery(recipientDID, sequenceID) {  // :154
  entry.pendingFor.delete(recipientDID)
  if (entry.retain === 'mailbox' && entry.pendingFor.size === 0) removeEntry(sequenceID)
}

async purge(params) {                              // :382
  if (entry.storedAt <= now - retention * 1000) purgedIDs.push(sequenceID)
}                                                  // the age bound, no ack involved
```

Two properties are carried up deliberately. The pending set holds **holder identities, not a
counter**, so a holder that acks twice cannot free a frame another holder still holds. And the age
sweep prunes **without acking** — expiry means a holder is broken, so telling the hub "durably
handled" would be a false success; the hub's own age bound reclaims the frame instead.

**Files:**
- Modify: `packages/rpc/src/hub-mux.ts:113-142` (`HubMuxParams` gains `ackTTLMs`)
- Modify: `packages/rpc/src/hub-mux.ts:205-208` (`Sink` gains `topicID`)
- Modify: `packages/rpc/src/hub-mux.ts:447-491` (the drain)
- Test: `packages/rpc/test/hub-mux-ack-refcount.test.ts` (create)

**Interfaces:**
- Consumes: `HubReceiveOptions` from Task 3.
- Produces, all internal to `createHubMux` except the first:
  - `HubMuxParams.ackTTLMs?: number`, default `DEFAULT_ACK_TTL_MS = 60_000`
  - `type Holder = InboundListener | Sink`
  - `releaseClaim(sequenceID: string, holder: Holder): void` — Tasks 5 and 7 call this
  - `Sink.topicID?: string` — Task 7 sets it

- [ ] **Step 1: Write the failing test**

Create `packages/rpc/test/hub-mux-ack-refcount.test.ts`:

```ts
import { describe, expect, test } from 'vitest'

import { createHubMux } from '../src/hub-mux.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'

const flush = () => new Promise((r) => setTimeout(r, 30))
const payload = () => new Uint8Array([1])

describe('the mux refcounts acks across its holders', () => {
  test('one holder acking does not ack upstream while another still holds the message', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onSubscribeFailed: () => {} })

    let ackFirst: (() => void) | undefined
    let ackSecond: (() => void) | undefined
    mux.onInbound('topic:x', (_message, ack) => {
      ackFirst = ack
    })
    mux.onInbound('topic:x', (_message, ack) => {
      ackSecond = ack
    })
    await flush()

    await hub.publish({ senderDID: 'alice', topicID: 'topic:x', payload: payload() })
    await flush()

    ackFirst?.()
    await flush()
    // Still held by the second listener. Acking here would let the hub drop a frame a live
    // consumer has not finished with.
    expect(hub.ackedCount('bob')).toBe(0)

    ackSecond?.()
    await flush()
    expect(hub.ackedCount('bob')).toBe(1)

    await mux.dispose()
  })

  test('a holder acking twice does not free a message another holder still holds', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onSubscribeFailed: () => {} })

    let ackFirst: (() => void) | undefined
    mux.onInbound('topic:x', (_message, ack) => {
      ackFirst = ack
    })
    mux.onInbound('topic:x', () => {})
    await flush()

    await hub.publish({ senderDID: 'alice', topicID: 'topic:x', payload: payload() })
    await flush()

    // The set is keyed by holder identity, not by a count. A counter would reach zero here.
    ackFirst?.()
    ackFirst?.()
    await flush()
    expect(hub.ackedCount('bob')).toBe(0)

    await mux.dispose()
  })

  test('a message no holder is interested in is acked immediately', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onSubscribeFailed: () => {} })
    mux.retainTopic('topic:unwatched')
    await flush()

    await hub.publish({ senderDID: 'alice', topicID: 'topic:unwatched', payload: payload() })
    await flush()

    // Nothing will ever handle it, so nothing will ever ack it. Leaving it pending would hold a
    // frame in the hub mailbox until its age bound, for no reader.
    expect(hub.ackedCount('bob')).toBe(1)

    await mux.dispose()
  })

  test('an expired claim is pruned without acking upstream', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({
      hub,
      localDID: 'bob',
      onSubscribeFailed: () => {},
      ackTTLMs: 0,
    })

    let ackFirst: (() => void) | undefined
    mux.onInbound('topic:x', (_message, ack) => {
      // `??=`, not `=`: the second message calls this listener too, and reassigning would leave
      // `ackFirst` pointing at the second message's claim — which is live, so the test would ack
      // it and read 1 for the wrong reason.
      ackFirst ??= ack
    })
    await flush()

    await hub.publish({ senderDID: 'alice', topicID: 'topic:x', payload: payload() })
    await flush()
    // A second message drives the sweep, which is lazy — see the implementation note.
    await hub.publish({ senderDID: 'alice', topicID: 'topic:x', payload: payload() })
    await flush()

    // The first claim expired. Acking on give-up would report a broken holder as durable success;
    // the hub's own age bound reclaims the frame instead.
    ackFirst?.()
    await flush()
    expect(hub.ackedCount('bob')).toBe(0)

    await mux.dispose()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/hub-mux-ack-refcount.test.ts`
Expected: FAIL. The first test acks upstream on the first holder's call, so `ackedCount` is 1 where
0 is expected. The fourth fails to compile until `ackTTLMs` exists.

- [ ] **Step 3: Add the TTL option**

In `packages/rpc/src/hub-mux.ts`, add to `HubMuxParams` (the type ends at line 142):

```ts
  /**
   * How long a delivered message waits for its holders to ack before its claim is dropped.
   * Default {@link DEFAULT_ACK_TTL_MS}.
   *
   * Expiry drops the claim and sends NO upstream ack: it means a holder is broken, and telling the
   * hub the frame was durably handled would be a false success. The hub's own age bound reclaims
   * it instead.
   */
  ackTTLMs?: number
```

And near the other module constants:

```ts
/** 60s: far above any real local handling time, far below the store's 30-day age bound. */
const DEFAULT_ACK_TTL_MS = 60_000
```

- [ ] **Step 4: Give `Sink` a topic scope**

At `packages/rpc/src/hub-mux.ts:205-208`:

```ts
type Sink = {
  push: (message: StoredMessage) => void
  close: () => void
  /** The topic this sink reads, when it named one. Absent: it takes every message. */
  topicID?: string
}
```

- [ ] **Step 5: Replace the drain's ack handling**

In `createHubMux`, read `ackTTLMs` alongside the other params, then replace the block at
`packages/rpc/src/hub-mux.ts:447-491` with:

```ts
  const ackTTLMs = params.ackTTLMs ?? DEFAULT_ACK_TTL_MS

  const subscription = hub.receive(localDID)
  const iterator = subscription[Symbol.asyncIterator]()

  type Holder = InboundListener | Sink

  /**
   * The holders of one delivered message that have not yet released it.
   *
   * A SET OF IDENTITIES, never a counter — the same choice `LogEntry.pendingFor` makes in
   * `hub-server/src/memoryStore.ts`. A holder that acks twice deletes itself twice, which is a
   * no-op; a counter would reach zero and free a frame its other holders still hold.
   */
  type PendingAck = {
    holders: Set<Holder>
    position: DeliveryPosition
    claimedAt: number
  }
  const pending = new Map<string, PendingAck>()

  const ackUpstream = (position: DeliveryPosition): void => {
    void Promise.resolve(subscription.ack?.(position)).catch(() => {})
  }

  const releaseClaim = (sequenceID: string, holder: Holder): void => {
    const entry = pending.get(sequenceID)
    // Absent: already released by every holder, or already swept. A late ack from a holder whose
    // claim expired is deliberately not honoured — the claim was given up on.
    if (entry == null) return
    entry.holders.delete(holder)
    if (entry.holders.size > 0) return
    pending.delete(sequenceID)
    ackUpstream(entry.position)
  }

  /**
   * Drop claims older than the TTL, WITHOUT acking — the mirror of `memoryStore.purge`.
   *
   * Swept on each inbound message rather than on a timer: the drain is the only thing that adds
   * entries, so a quiet drain has nothing to sweep, and a timer would need dispose handling and a
   * cross-platform unref for no gain. A lingering entry holds no hub resource — the hub reclaims
   * by its own age bound regardless.
   */
  const sweepPending = (now: number): void => {
    const cutoff = now - ackTTLMs
    for (const [sequenceID, entry] of pending) {
      if (entry.claimedAt <= cutoff) pending.delete(sequenceID)
    }
  }

  // Reported once, and only for an ending nobody asked for. `dispose` ends the drain too, and a
  // host being told its lane died in response to its own teardown is noise that trains hosts to
  // ignore the notice.
  const reportEnded = (ended: ReceiveLaneEnded): void => {
    if (disposed) return
    try {
      onReceiveEnded?.(ended)
    } catch {
      // a host's notice handler must not break the mux
    }
  }
  void (async () => {
    while (true) {
      let result: IteratorResult<StoredMessage>
      try {
        result = await iterator.next()
      } catch (error) {
        reportEnded({ error })
        return
      }
      if (disposed) return
      if (result.done) {
        reportEnded({})
        return
      }
      const message = result.value
      const now = Date.now()
      sweepPending(now)

      // Snapshotted BEFORE the fan-out, and the fan-out runs over these same snapshots: a holder
      // that unsubscribes mid-delivery would otherwise be counted as pending and never receive
      // the message it is being waited on for.
      const matchedListeners = [...(listeners.get(message.topicID) ?? [])]
      const matchedSinks = [...sinks].filter(
        (sink) => sink.topicID == null || sink.topicID === message.topicID,
      )

      // An ack names a place in THIS recipient's delivery queue, not in the topic's log. The two
      // are different sequences and must never be crossed, so the position is named for what it
      // is and never reaches a log cursor.
      const position = asDeliveryPosition(message.sequenceID)
      const holders = new Set<Holder>([...matchedListeners, ...matchedSinks])
      if (holders.size === 0) {
        // Nothing will ever handle it, so nothing will ever ack it.
        ackUpstream(position)
      } else {
        pending.set(message.sequenceID, { holders, position, claimedAt: now })
      }

      for (const listener of matchedListeners) {
        try {
          listener(message, () => releaseClaim(message.sequenceID, listener))
        } catch {
          // listener errors must not kill the drain
        }
      }
      for (const sink of matchedSinks) sink.push(message)
    }
  })()
```

Import `DeliveryPosition` as a type alongside the existing `asDeliveryPosition` import at
`packages/rpc/src/hub-mux.ts:12`:

```ts
import { asDeliveryPosition, type DeliveryPosition } from './cursor.js'
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/hub-mux-ack-refcount.test.ts`
Expected: PASS, all four.

- [ ] **Step 7: Run the full rpc suite**

Run: `pnpm --filter @kumiai/rpc test`
Expected: PASS. The commit and rendezvous lanes already ack (`peer.ts:1297`, `:1317`); their
existing tests are the regression guard that the refcount did not break a working path.

- [ ] **Step 8: Lint and commit**

```bash
rtk proxy pnpm run lint
git add packages/rpc/src/hub-mux.ts packages/rpc/test/hub-mux-ack-refcount.test.ts
git commit -m "fix(rpc): refcount mux acks across holders

The drain acked upstream on the first holder's call, while every other holder
still held the message. Track the holders of each delivered message as a set of
identities — the choice LogEntry.pendingFor makes in memoryStore, so a holder
acking twice cannot free a frame another still holds — and ack upstream only
when the set empties. Claims past a TTL are swept without acking: expiry means
a holder is broken, and reporting it as durable success would be a lie."
```

---

### Task 5: Relay the ack through `open-once`

`createOpenOncePath` subscribes with `mux.onInbound(topicID, (message) => {...})`
(`packages/rpc/src/open-once.ts:58`) — the listener's second parameter is never bound, so the ack is
dropped. This is the app lane and the inbox lane: the two highest-traffic lanes in the system,
neither of which acknowledges anything today.

**Files:**
- Modify: `packages/rpc/src/open-once.ts:56-75`
- Test: `packages/rpc/test/open-once-ack.test.ts` (create)

**Interfaces:**
- Consumes: `releaseClaim` behaviour from Task 4, reached through the `ack` argument
  `InboundListener` already declares.
- Produces: nothing later tasks rely on. `createOpenOncePath`'s signature is unchanged.

- [ ] **Step 1: Write the failing test**

Create `packages/rpc/test/open-once-ack.test.ts`:

```ts
import { describe, expect, test } from 'vitest'

import { createHubMux } from '../src/hub-mux.js'
import { createOpenOncePath } from '../src/open-once.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

describe('the open-once path acks what it opens', () => {
  test('an opened frame is acked', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onSubscribeFailed: () => {} })
    const opened: Array<Uint8Array> = []

    const path = createOpenOncePath<Uint8Array>({
      mux,
      topicID: 'topic:app',
      unwrap: async (payload) => payload,
      project: (_message, result) => result.payload,
    })
    path((value) => opened.push(value))
    await flush()

    await hub.publish({
      senderDID: 'alice',
      topicID: 'topic:app',
      payload: new Uint8Array([1]),
    })
    await flush()

    expect(opened).toHaveLength(1)
    expect(hub.ackedCount('bob')).toBe(1)

    await mux.dispose()
  })

  test('a frame that cannot be opened is acked too', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onSubscribeFailed: () => {} })

    const path = createOpenOncePath<Uint8Array>({
      mux,
      topicID: 'topic:app',
      unwrap: async () => {
        throw new Error('another epoch')
      },
      project: (_message, result) => result.payload,
    })
    path(() => {})
    await flush()

    await hub.publish({
      senderDID: 'alice',
      topicID: 'topic:app',
      payload: new Uint8Array([1]),
    })
    await flush()

    // Unopenable frames are ordinary on a shared log. Leaving them unacked redelivers the same
    // undecryptable bytes on every reconnect, forever.
    expect(hub.ackedCount('bob')).toBe(1)

    await mux.dispose()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/open-once-ack.test.ts`
Expected: FAIL — `ackedCount` is 0 in both, since the listener never binds `ack`.

- [ ] **Step 3: Bind and fire the ack**

In `packages/rpc/src/open-once.ts`, replace lines 58-75:

```ts
    unsubscribe ??= mux.onInbound(topicID, (message, ack) => {
      note?.(message)
      opening = opening
        .then(async () => {
          const result = await unwrap(message.payload)
          const opened = result instanceof Uint8Array ? { payload: result } : result
          const value = project(message, opened)
          if (value === undefined) return
          // Snapshot: a consumer disposing from inside its own delivery must not perturb the
          // fan-out of the frame it is being given.
          for (const listener of [...listeners]) listener(value)
        })
        .catch(() => {
          // A frame this handle cannot open — another epoch's, another group's, or not a frame at
          // all. Ordinary on a shared log, and the read paths are built to walk past it. One
          // frame's failure must not break the chain the rest are opened on.
        })
        .finally(() => {
          // Acked on BOTH paths, and only once this frame's link has settled. A frame that could
          // not be opened has still been handled — leaving it unacked redelivers the same
          // undecryptable bytes on every reconnect, forever. Acking on arrival instead would
          // release it before the open that consumes its ratchet key had run.
          ack()
        })
    })
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/open-once-ack.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full rpc suite, then lint and commit**

Run: `pnpm --filter @kumiai/rpc test`
Expected: PASS.

```bash
rtk proxy pnpm run lint
git add packages/rpc/src/open-once.ts packages/rpc/test/open-once-ack.test.ts
git commit -m "fix(rpc): ack frames the open-once path has handled

The app and inbox lanes subscribed with a listener that never bound the ack
argument, so neither acknowledged anything. Ack when the frame's link in the
opening chain settles, on the failure path too: an unopenable frame has still
been handled, and leaving it unacked redelivers it on every reconnect."
```

---

### Task 6: Relay the ack through `BroadcastBus`

`bus.subscribe` forwards `(message) => onMessage(message.payload)`
(`packages/rpc/src/hub-mux.ts:498`), and has nowhere to forward the ack to:
`BroadcastBus.subscribe`'s callback is `(payload: Uint8Array) => void`
(`packages/broadcast/src/bus.ts:7`). This is the app lane's live mailbox traffic — everything whose
procedure retention is not `log` goes through the broadcast transport.

Adding a second callback argument is additive for the same reason as Task 3: a one-parameter
callback stays assignable. `createMemoryBus` needs no change — an in-process bus that never
redelivers legitimately omits the ack, exactly as `HubReceiveSubscription.ack?` is documented
optional for one.

**Files:**
- Modify: `packages/broadcast/src/bus.ts:5-8`
- Modify: `packages/rpc/src/hub-mux.ts:498`
- Modify: `packages/broadcast/src/transport.ts:138`
- Test: `packages/rpc/test/hub-mux-bus-ack.test.ts` (create)

**Interfaces:**
- Consumes: `releaseClaim` behaviour from Task 4.
- Produces:
  - `BroadcastBus.subscribe(topicID: string, onMessage: (payload: Uint8Array, ack?: () => void) => void): () => void`
  - No later task depends on it.

- [ ] **Step 1: Write the failing test**

Create `packages/rpc/test/hub-mux-bus-ack.test.ts`:

```ts
import { describe, expect, test } from 'vitest'

import { createHubMux } from '../src/hub-mux.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

describe('the bus view relays its ack', () => {
  test('a bus subscriber can ack the frame it was handed', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onSubscribeFailed: () => {} })

    let release: (() => void) | undefined
    mux.bus.subscribe('topic:x', (_payload, ack) => {
      release = ack
    })
    await flush()

    await hub.publish({
      senderDID: 'alice',
      topicID: 'topic:x',
      payload: new Uint8Array([1]),
    })
    await flush()

    expect(hub.ackedCount('bob')).toBe(0)
    release?.()
    await flush()
    expect(hub.ackedCount('bob')).toBe(1)

    await mux.dispose()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/hub-mux-bus-ack.test.ts`
Expected: FAIL — `release` is `undefined`, so the final `ackedCount` is 0.

- [ ] **Step 3: Widen the bus callback**

In `packages/broadcast/src/bus.ts`, replace the type at lines 5-8:

```ts
export type BroadcastBus = {
  publish(topicID: string, payload: Uint8Array): void | Promise<void>
  /**
   * `ack` marks the payload durably handled, so a durable hub behind this bus stops redelivering
   * it. Absent on an in-process bus that never redelivers, and ignorable by a subscriber that does
   * not need the durability gate. A one-parameter callback stays assignable, so adding it broke
   * nothing.
   */
  subscribe(
    topicID: string,
    onMessage: (payload: Uint8Array, ack?: () => void) => void,
  ): () => void
}
```

`createMemoryBus` below is unchanged: it calls `onMessage(payload)` with no ack, which is correct
for a bus that never redelivers.

- [ ] **Step 4: Forward the ack from the mux**

In `packages/rpc/src/hub-mux.ts`, at line 498:

```ts
    subscribe: (topicID, onMessage) =>
      onInbound(topicID, (message, ack) => onMessage(message.payload, ack)),
```

- [ ] **Step 5: Consume it in the broadcast transport**

In `packages/broadcast/src/transport.ts`, the callback at line 138 is a promise chain with a `.then`
that enqueues and a `.catch` that drops. Both are handled outcomes, so the ack goes in a `.finally`
— the same placement as `open-once.ts` in Task 5. Take the ack, and append the `.finally`:

```ts
      unsubscribe = bus.subscribe(topicID, (payload, ack) => {
        Promise.resolve(unwrap(payload))
          .then((result) => {
            const { payload: bytes, senderDID } = normalizeUnwrap(result)
            const message = decodeFrame(bytes)
            if (authenticating) {
              // The recovered sender is the ONLY sender here and REPLACES what the bytes claimed
              // even when nothing was recovered — else a forged claim would survive exactly when
              // the open failed to contradict it. Left alone on a non-authenticating transport,
              // where the wire value is all there is.
              if (senderDID == null) delete message.senderDID
              else message.senderDID = senderDID
            }
            controller.enqueue(message as R)
          })
          .catch(() => {
            // Drop this message and keep the subscription alive — expected for messages from
            // other groups/epochs where decryption fails.
          })
          .finally(() => {
            // Both branches above are handled outcomes: a frame from another group or epoch is
            // dropped on purpose, and leaving it unacked redelivers the same undecryptable bytes
            // on every reconnect.
            ack?.()
          })
      })
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/hub-mux-bus-ack.test.ts`
Expected: PASS.

- [ ] **Step 7: Run both packages' suites**

Run: `pnpm --filter @kumiai/broadcast test`
Expected: PASS.

Run: `pnpm --filter @kumiai/rpc test`
Expected: PASS.

- [ ] **Step 8: Lint and commit**

```bash
rtk proxy pnpm run lint
git add packages/broadcast/src packages/rpc/src/hub-mux.ts packages/rpc/test/hub-mux-bus-ack.test.ts
git commit -m "feat(broadcast): carry an ack on the subscribe callback

The app lane's live mailbox traffic runs through the bus view, whose callback
had no ack parameter to forward to — so none of it was ever acknowledged.
Additive: a one-parameter callback stays assignable, and createMemoryBus
correctly omits the ack it has no redelivery to gate."
```

---

### Task 7: Relay the ack through the mux's mailbox facade

The `mailbox` facade's `receive` (`packages/rpc/src/hub-mux.ts:512-558`) builds its subscription
from `sinks` and returns `{ [Symbol.asyncIterator], return }` — no `ack` member at all, so a
consumer holding that subscription has no way to acknowledge. `mailbox` is public API on `HubMux`
(`:176`, "for the directed tunnels").

**Files:**
- Modify: `packages/rpc/src/hub-mux.ts:512-559`
- Test: `packages/rpc/test/hub-mux-mailbox-ack.test.ts` (create)

**Interfaces:**
- Consumes: `releaseClaim` and `Sink.topicID` from Task 4; `HubReceiveOptions` from Task 3.
- Produces: `mux.mailbox.receive(subscriberDID, options?)` returns a subscription carrying
  `ack: (sequenceID: string) => void`. Task 9's read pump calls it through the `MailboxHub` port.

- [ ] **Step 1: Write the failing test**

Create `packages/rpc/test/hub-mux-mailbox-ack.test.ts`:

```ts
import { describe, expect, test } from 'vitest'

import { createHubMux } from '../src/hub-mux.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

describe('the mailbox facade relays its ack', () => {
  test('a scoped receive acks the frame it read', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onSubscribeFailed: () => {} })

    mux.mailbox.subscribe('bob', 'topic:x')
    const subscription = mux.mailbox.receive('bob', { topicID: 'topic:x' })
    const iterator = subscription[Symbol.asyncIterator]()
    await flush()

    await hub.publish({
      senderDID: 'alice',
      topicID: 'topic:x',
      payload: new Uint8Array([1]),
    })
    const next = await iterator.next()
    expect(next.done).toBe(false)

    expect(hub.ackedCount('bob')).toBe(0)
    await subscription.ack?.(next.value.sequenceID)
    await flush()
    expect(hub.ackedCount('bob')).toBe(1)

    subscription.return?.()
    await mux.dispose()
  })

  test('a scoped receive is not a holder for another topic', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onSubscribeFailed: () => {} })

    mux.mailbox.subscribe('bob', 'topic:x')
    mux.retainTopic('topic:y')
    const subscription = mux.mailbox.receive('bob', { topicID: 'topic:x' })
    await flush()

    await hub.publish({
      senderDID: 'alice',
      topicID: 'topic:y',
      payload: new Uint8Array([1]),
    })
    await flush()

    // Unscoped, this sink would be a pending holder for every message on every topic, and a frame
    // it discards on topic mismatch would wait for an ack that never comes.
    expect(hub.ackedCount('bob')).toBe(1)

    subscription.return?.()
    await mux.dispose()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/hub-mux-mailbox-ack.test.ts`
Expected: FAIL — `subscription.ack` is `undefined`, and the unscoped sink holds `topic:y`'s frame.

- [ ] **Step 3: Scope the sink and give the subscription an ack**

In `packages/rpc/src/hub-mux.ts`, change the `mailbox` facade's `receive` (line 512) to take options,
set the sink's topic scope, and return an `ack`:

```ts
    receive: (_subscriberDID, options): HubReceiveSubscription => {
      const queue: Array<StoredMessage> = []
      let resolveNext: ((result: IteratorResult<StoredMessage>) => void) | undefined
      let closed = false
      const sink: Sink = {
        push: (message) => {
          if (closed) return
          if (resolveNext != null) {
            const resolve = resolveNext
            resolveNext = undefined
            resolve({ value: message, done: false })
          } else {
            queue.push(message)
          }
        },
        close: () => {
          closed = true
          if (resolveNext != null) {
            const resolve = resolveNext
            resolveNext = undefined
            resolve({ value: undefined as unknown as StoredMessage, done: true })
          }
        },
        // Unscoped, this sink is a pending holder for every message on every topic — including the
        // ones it discards on topic mismatch, which would then wait out the TTL rather than being
        // acked.
        topicID: options?.topicID,
      }
```

Leave the iterator body unchanged, and replace the return at line 558:

```ts
      return {
        [Symbol.asyncIterator]: () => iter,
        return: remove,
        ack: (sequenceID) => releaseClaim(sequenceID, sink),
      }
    },
```

The claim is keyed by `message.sequenceID`, which is what a consumer of this subscription holds —
the conversion to a `DeliveryPosition` happened once, in the drain, and stays there.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/hub-mux-mailbox-ack.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full rpc suite, then lint and commit**

Run: `pnpm --filter @kumiai/rpc test`
Expected: PASS.

```bash
rtk proxy pnpm run lint
git add packages/rpc/src/hub-mux.ts packages/rpc/test/hub-mux-mailbox-ack.test.ts
git commit -m "fix(rpc): give the mailbox facade's receive an ack

Its subscription had no ack member, so a directed tunnel over the mux could not
acknowledge anything. The sink also now carries the topic it was scoped to, so
it is not counted as a pending holder for messages it discards."
```

---

### Task 8: Forward the ack through the encrypting wrapper

`wrapHub`'s `receive` (`packages/hub-tunnel/src/encrypted-transport.ts:63-135`) returns a fresh
object with only `[Symbol.asyncIterator]` and `return`, structurally dropping `ack`. The same
reasoning already keeps `logPosition` from being dropped at `:113-116`: this wrapper re-writes the
payload and nothing else.

**Files:**
- Modify: `packages/hub-tunnel/src/encrypted-transport.ts:63-64,127-134`
- Test: `packages/hub-tunnel/test/encrypted-transport-ack.test.ts` (create)

**Interfaces:**
- Consumes: `HubReceiveOptions` from Task 3.
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Write the failing test**

Create `packages/hub-tunnel/test/encrypted-transport-ack.test.ts`:

```ts
import type { StoredMessage } from '@kumiai/hub-protocol'
import { describe, expect, test } from 'vitest'

import { createEncryptedHubTunnelTransport } from '../src/encrypted-transport.js'
import type { HubReceiveSubscription, MailboxHub } from '../src/transport.js'

describe('the encrypting wrapper forwards the ack', () => {
  test('ack and scope survive the wrapper', async () => {
    const acked: Array<string> = []
    const scopes: Array<string | undefined> = []
    const inner: MailboxHub = {
      publish: async () => ({ sequenceID: '1' }),
      subscribe: () => {},
      unsubscribe: () => {},
      receive: (_subscriberDID, options): HubReceiveSubscription => {
        scopes.push(options?.topicID)
        return {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<IteratorResult<StoredMessage>>(() => {
                // never resolves: this test is about the members, not the stream
              }),
          }),
          return: () => {},
          ack: (sequenceID) => void acked.push(sequenceID),
        }
      },
    }

    const transport = createEncryptedHubTunnelTransport({
      hub: inner,
      encryptor: {
        encrypt: async (bytes: Uint8Array) => bytes,
        decrypt: async (bytes: Uint8Array) => bytes,
      },
      groupID: 'group-1',
      sessionID: 'session-1',
      localDID: 'did:key:alice',
      sendTopicID: 'topic:out',
      receiveTopicID: 'topic:in',
    })

    // The wrapper re-writes the payload and nothing else. Dropping `ack` here severs the durable
    // contract for every lane behind an encrypting hub, exactly as dropping `logPosition` would.
    expect(scopes).toEqual(['topic:in'])

    await transport.dispose()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kumiai/hub-tunnel exec vitest run test/encrypted-transport-ack.test.ts`
Expected: FAIL — `scopes` is `[undefined]`, because `wrapHub.receive` takes one parameter and passes
one on.

- [ ] **Step 3: Pass options through and forward the ack**

In `packages/hub-tunnel/src/encrypted-transport.ts`, change the wrapper's `receive` signature at
line 63:

```ts
    receive(subscriberDID: string, options?: HubReceiveOptions): HubReceiveSubscription {
      const inner = hub.receive(subscriberDID, options)
```

and its return at lines 127-134:

```ts
      return {
        [Symbol.asyncIterator]() {
          return iterator
        },
        return() {
          inner.return?.()
        },
        // Carried through for the same reason `logPosition` is above: this wrapper re-writes the
        // payload and nothing else. Dropping it severs the durable-ack contract for every lane
        // behind an encrypting hub.
        ...(inner.ack != null ? { ack: (sequenceID: string) => inner.ack?.(sequenceID) } : {}),
      }
```

The member is spread in conditionally so that wrapping a hub with no `ack` does not produce a
subscription that advertises one and does nothing — `ack?` being absent is meaningful.

Add `HubReceiveOptions` to the type import from `./transport.js` at the top of the file (line 11-14).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @kumiai/hub-tunnel exec vitest run test/encrypted-transport-ack.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the suite, then lint and commit**

Run: `pnpm --filter @kumiai/hub-tunnel test`
Expected: PASS.

```bash
rtk proxy pnpm run lint
git add packages/hub-tunnel/src/encrypted-transport.ts packages/hub-tunnel/test/encrypted-transport-ack.test.ts
git commit -m "fix(hub-tunnel): forward ack and receive scope through the encrypting wrapper

Its receive returned a fresh object carrying only the iterator and return,
structurally dropping ack — severing the durable contract for every lane behind
an encrypting hub. Carried through for the same reason logPosition already is."
```

---

### Task 9: Ack from the tunnel read pump

The read pump (`packages/hub-tunnel/src/transport.ts:313-383`) never calls `subscription.ack`. Every
outcome it reaches is a handled outcome: enqueued, topic-mismatched, deduped, session-mismatched, or
decode-failed. A frame it resolves and never acks is redelivered on every reconnect until it ages
out.

**Files:**
- Modify: `packages/hub-tunnel/src/transport.ts:313-383`
- Test: `packages/hub-tunnel/test/transport-ack.test.ts` (create)

**Interfaces:**
- Consumes: `HubReceiveSubscription.ack` as already declared at `transport.ts:22`, plus the scope
  from Task 3.
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Write the failing test**

Create `packages/hub-tunnel/test/transport-ack.test.ts`:

```ts
import { describe, expect, test } from 'vitest'

import { encodeFrame, type HubFrame } from '../src/frame.js'
import {
  createHubTunnelTransport,
  type HubReceiveSubscription,
  type MailboxHub,
} from '../src/transport.js'
import { FakeHub } from './fixtures/fake-hub.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

describe('the tunnel acks what it has handled', () => {
  test('an accepted frame and a dropped frame are both acked', async () => {
    const fakeHub = new FakeHub()
    const acked: Array<string> = []
    // Delegating explicitly, not spreading: `FakeHub` is a class, and `{...instance}` copies own
    // enumerable properties only — every prototype method would be lost.
    const ackingHub: MailboxHub = {
      publish: (params) => fakeHub.publish(params),
      subscribe: (subscriberDID, topicID, options) =>
        fakeHub.subscribe(subscriberDID, topicID, options),
      unsubscribe: (subscriberDID, topicID) => fakeHub.unsubscribe(subscriberDID, topicID),
      receive: (subscriberDID): HubReceiveSubscription => {
        const inner = fakeHub.receive(subscriberDID)
        return {
          [Symbol.asyncIterator]: () => inner[Symbol.asyncIterator](),
          return: () => inner.return?.(),
          ack: (sequenceID: string) => void acked.push(sequenceID),
        }
      },
    }

    const transport = createHubTunnelTransport({
      hub: ackingHub,
      sessionID: 'session-1',
      localDID: 'did:key:alice',
      sendTopicID: 'topic:out',
      receiveTopicID: 'topic:in',
    })
    await flush()

    const frame: HubFrame = { v: 1, sessionID: 'session-1', kind: 'message', seq: 0, body: {} }
    await fakeHub.publish({
      senderDID: 'did:key:bob',
      topicID: 'topic:in',
      payload: encodeFrame(frame),
    })
    await flush()

    // Undecodable bytes on the same topic: dropped, but handled. Leaving them unacked redelivers
    // the same garbage on every reconnect until it ages out.
    await fakeHub.publish({
      senderDID: 'did:key:bob',
      topicID: 'topic:in',
      payload: new Uint8Array([0xff, 0xff, 0xff]),
    })
    await flush()

    expect(acked).toHaveLength(2)

    await transport.dispose()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kumiai/hub-tunnel exec vitest run test/transport-ack.test.ts`
Expected: FAIL — `acked` is empty.

- [ ] **Step 3: Ack every resolved frame**

In `packages/hub-tunnel/src/transport.ts`, inside the read pump's loop, immediately after
`const message = result.value` (line 333), add:

```ts
            // Every outcome below is a HANDLED outcome — enqueued, filtered, deduped or
            // undecodable. Acked here, once, rather than at each `continue`: a frame this
            // transport resolves and does not ack is redelivered on every reconnect until it ages
            // out, and the paths that drop a frame are exactly the ones easiest to forget.
            void Promise.resolve(subscription.ack?.(message.sequenceID)).catch(() => {})
```

Do not ack the `session-end` frame separately — it falls under the same statement, and the teardown
it triggers is a handled outcome like the rest.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @kumiai/hub-tunnel exec vitest run test/transport-ack.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the suite, then lint and commit**

Run: `pnpm --filter @kumiai/hub-tunnel test`
Expected: PASS.

```bash
rtk proxy pnpm run lint
git add packages/hub-tunnel/src/transport.ts packages/hub-tunnel/test/transport-ack.test.ts
git commit -m "fix(hub-tunnel): ack frames the read pump has handled

The pump never acked, so over a durable hub every tunnel frame was redelivered
on every reconnect until it aged out. Acked once per resolved frame — enqueued,
filtered, deduped and undecodable are all handled outcomes."
```

---

### Task 10: Conformance clauses for `ack`

`ConformanceReceiveSubscription.ack` (`packages/hub-conformance/src/log-hub.ts:29`) has a type and
no behavioural clause. The coverage tripwire
(`packages/hub-tunnel/test/hub-conformance.test.ts:7-20`) fails to compile only when a hub member has
no *type* counterpart in the suite, never when it has no *test* — which is how a severed relay
survived unnoticed under a suite explicitly built to catch drift. These clauses close that.

Every double must pass them, and a double may be stricter than its port but never more permissive.

**Files:**
- Modify: `packages/hub-conformance/src/log-hub.ts` (add clauses to `testLogHubConformance`)
- Test: the clauses run from `packages/hub-server/test/log-hub-conformance.test.ts`,
  `packages/rpc/test/hub-conformance.test.ts`, and
  `packages/hub-tunnel/test/hub-conformance.test.ts`

**Interfaces:**
- Consumes: `HubReceiveOptions` shape from Task 3.
- Produces: nothing. This is the last task.

- [ ] **Step 1: Read the existing suite before adding to it**

Read `packages/hub-conformance/src/log-hub.ts` in full, and the `HubStore` suite's ack clause at
`packages/hub-conformance/src/index.ts:201` ("ack deletes the delivery, not the log entry"). The new
clauses mirror it at the `LogHub` seam. Note the `drain` helper at `:112-132` and reuse it; it
closes the subscription unconditionally, which a poll-loop hub needs.

Also read `packages/hub-server/test/log-hub-conformance.test.ts:13-37`. Its `pollingReceive` adapter
returns `{ [Symbol.asyncIterator], return }` and declares no `ack`, which its docblock states
deliberately. **That stays as it is.** `ack?` is optional on the contract — a hub with no
redelivery to gate is conforming without one — so both new clauses guard on
`if (subscription.ack == null) return` and this adapter simply does not exercise them. No change to
`hub-server`, and its docblock stays accurate.

The clauses therefore bite on the doubles that *do* declare an ack, which is where the severed relay
lived. `packages/rpc/test/fixtures/durable-fake-hub.ts:267` supplies one
(`ack: (sequenceID) => this.#ack(subscriberDID, sequenceID)`), so `packages/rpc/test/hub-conformance.test.ts`
is the run that matters.

- [ ] **Step 2: Write the failing clauses**

Add to `testLogHubConformance` in `packages/hub-conformance/src/log-hub.ts`, inside its existing
`describe` block:

```ts
    test('an acked mailbox frame is not redelivered to a fresh receive', async () => {
      const hub = await createHub({ maxRetention, maxDepth })
      hub.subscribe(BOB, TOPIC)
      const first = hub.receive(BOB, { topicID: TOPIC })
      await hub.publish({ senderDID: ALICE, topicID: TOPIC, payload: payload(1) })

      const delivered = await drain(first, 1)
      expect(delivered).toHaveLength(1)
      // A hub with no durability to gate legitimately omits `ack` — the member is optional, and a
      // live transport that never redelivers is conforming without it.
      if (first.ack == null) return
      await first.ack(delivered[0]?.sequenceID as string)

      // The mailbox class is delivery-derived: its last ack is what frees it. A hub that
      // redelivers an acked frame hands a peer the same message on every reconnect for the whole
      // retention window.
      const second = hub.receive(BOB, { topicID: TOPIC })
      expect(await drain(second, 1)).toEqual([])
    })

    test('a log frame survives every ack', async () => {
      const hub = await createHub({ maxRetention, maxDepth })
      hub.subscribe(BOB, TOPIC)
      const subscription = hub.receive(BOB, { topicID: TOPIC })
      const { sequenceID: logged } = await hub.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
      })

      const delivered = await drain(subscription, 1)
      expect(delivered).toHaveLength(1)
      if (subscription.ack == null) return
      await subscription.ack(delivered[0]?.sequenceID as string)

      // An ack frees a DELIVERY, not a log entry. A hub that lets an ack remove a log frame
      // breaks the member invited tomorrow who must apply the commits landing today.
      const result = await hub.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages.map((message) => message.sequenceID)).toEqual([logged])
      expect(result.head).toBe(logged)
    })
```

- [ ] **Step 3: Run the clauses against every double**

Run: `pnpm --filter @kumiai/hub-server test`
Expected: PASS, with both new clauses returning early — `pollingReceive` declares no `ack`, which is
conforming.

Run: `pnpm --filter @kumiai/rpc test`
Expected: PASS.

Run: `pnpm --filter @kumiai/hub-tunnel test`
Expected: PASS. `hub-tunnel`'s `FakeHub` runs only `testMailboxHubConformance`, so these `LogHub`
clauses do not apply to it — confirm that is still true rather than assuming it.

- [ ] **Step 4: Run everything, uncached**

Both contract suites must run against the real implementations **and** every double.

Run: `pnpm exec turbo run test:types test:unit --force`
Expected: all packages PASS, and the summary line reads `Cached: 0`. A cached run proves nothing.

Run: `pnpm --filter @kumiai/integration-tests test`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
rtk proxy pnpm run lint
git add packages/hub-conformance/src/log-hub.ts
git commit -m "test(hub-conformance): pin ack behaviour at the LogHub seam

ConformanceReceiveSubscription.ack had a type and no clause. The coverage
tripwire fails only when a hub member has no type counterpart, never when it
has no test — which is how a severed ack relay survived under a suite built to
catch drift."
```

- [ ] **Step 6: Add a changeset**

Run: `pnpm changeset`

Select: `@kumiai/rpc` as **minor** (breaking: `ProtocolSurface.to` returns a Promise);
`@kumiai/hub-tunnel`, `@kumiai/broadcast` and `@kumiai/hub-conformance` as **minor** (additive).
`@kumiai/hub-server` does not move — nothing under its `src/` changed.

```bash
git add .changeset
git commit -m "chore: changeset for the high-severity correctness fixes"
```

---

## Verification checklist

Run before handing the branch to review:

- [ ] `pnpm exec turbo run test:types test:unit --force` — all PASS, summary says `Cached: 0`
- [ ] `pnpm --filter @kumiai/integration-tests test` — PASS
- [ ] `rtk proxy pnpm run lint` — no diagnostics
- [ ] `git diff main --stat` touches only `packages/rpc/src`, `packages/rpc/test`,
      `packages/hub-tunnel/src`, `packages/hub-tunnel/test`, `packages/broadcast/src`,
      `packages/hub-conformance/src`, `tests/integration/test/directed-lane.test.ts`,
      `.changeset/`, and `docs/superpowers/`
- [ ] No file under any `lib/` directory is modified
