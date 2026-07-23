# Three high-severity correctness fixes — design

**Branch:** `fix/high-severity-correctness`
**Source:** `docs/agents/plans/next/2026-07-23-high-severity-correctness.md`, Phase 1 item 1 of
`docs/agents/plans/roadmap.md`. Origin is the 2026-07-02 audit (commit `bb343d9`).

Three findings, two of them small and local to `packages/rpc/src/peer.ts`, one a severed relay
across four packages.

## Premise correction

The source doc calls finding 3 a dead contract: "`HubReceiveSubscription` declares `ack?` …
nothing in `transport.ts` or `encrypted-transport.ts` ever calls it". That is true of hub-tunnel and
false of the system. Traced against `d96dfb1`, the ack contract is live end to end elsewhere:

| Layer | State |
|---|---|
| `HubStore.ack({recipientDID, sequenceIDs})` | live; `memoryStore.ts:376`, conformance clauses at `hub-conformance/src/index.ts:86,125,201,738` |
| wire `hub/v1/receive`, `{ack: Array<string>}` | live; `hub-client/src/client.ts:62-64`, `hub-server/test/hub.test.ts:183` "ack drains the store" |
| `hub-mux` drain, `rpc/src/hub-mux.ts:475-481` | live; builds an `ack` closure per message and hands it to each listener |
| `peer.ts:1297` commit lane, `:1317` rendezvous lane | live; both call `ack()` |

So the source doc's option B — "delete the contract, drop the `ack` member" — is not available.
Deleting it breaks a working commit-lane path.

What is actually broken is narrower: **five relay points forward a message and drop its ack.** The
commit and rendezvous lanes ack; the app lane, the inbox lane, and every directed tunnel do not.

| Relay point | How the ack is lost |
|---|---|
| `rpc/src/open-once.ts:58` | `mux.onInbound(topicID, (message) => {...})` — the second parameter is never bound. The app and inbox lanes. |
| `rpc/src/hub-mux.ts:498` | `bus.subscribe` forwards `(message) => onMessage(message.payload)`; `BroadcastBus`'s callback has no ack parameter to forward to |
| `rpc/src/hub-mux.ts:512-558` | the `mailbox` facade's `receive` builds its subscription from `sinks` with no `ack` member at all |
| `hub-tunnel/src/encrypted-transport.ts:127-134` | `wrapHub`'s `receive` returns `{[Symbol.asyncIterator], return}`, structurally dropping `ack` |
| `hub-tunnel/src/transport.ts:313-383` | the read pump never acks — though with the two layers above severed it currently has nothing to call |

This matters more than when the audit filed it. `HubPublishParams.retain` (`transport.ts:50-56`)
now defines the `mailbox` class as "removed once every delivery is acked, or when it ages out", so
retention semantics shipped in `5eb220a` rest on a contract three of four lanes do not satisfy. A
mailbox-class entry on those lanes is reclaimed only by ageing out.

## Fix 1 — `to()` gated on `ready`

`peer.protocol(name)` returns four methods. Three are wrapped in `withReady`; `to` is not
(`peer.ts:1943-1946`). Called before init completes it reaches `surfaceFor` (`:647`) with no
protocol registered.

It has two pre-ready failure modes, not the one the source doc names: `Unknown protocol: <name>`
at `:649` for a name that is perfectly valid, and `Peer is not started` at `:669` when `inboxLane`
is still null. Both are misleading errors for a timing bug.

**Change.** `ProtocolSurface.to` (`peer.ts:258`) becomes
`(memberDID: string) => Promise<Client<Protocol>>`, and `:1946` wraps in `withReady` like its
siblings. Uniform surface, and the timing bug is fixed rather than relabelled.

Rejected: keeping it sync and throwing one explicit not-ready error — non-breaking, but the caller
still cannot use `to()` before init, it only learns why. Also rejected: returning a lazy client
that awaits `ready` internally — callable at any time, but it adds a deferral layer inside the
directed client and moves failures to first use.

This is a breaking change on `@kumiai/rpc`'s public surface: a MINOR while the package is 0.x. It
pairs with the `ProtocolSurface` phantom-type-parameter retyping filed in
`docs/agents/plans/backlog/rpc-api-surface.md` if that lands in the same window.

## Fix 2 — `resync()` under the commit mutex

`resync()` is `peer.ts:1952-1955`:

```ts
resync: async () => {
  await ready
  await rebuildEpoch()
},
```

Restated from the source doc, whose named mechanism (`handshakeTail`) no longer exists. It is now
`commitTail`, taken through `runSerial` (`:794-805`) — "the group's commit mutex: every commit-lane
operation serialized through one tail".

Every other `rebuildEpoch()` call site runs under `runSerial`: `:1305` under `:1298`; `:1575` and
`:1682` under `:1573`; `:1698` under `:1697`; `:1770` and `:1860` under `:1767`; and `:1287` inside
`reconcileCommits`, reached only from `:1596` and `:1779`, both inside `runSerial` blocks.
`resync()` is the sole caller taking no lock, so a host-called `resync()` can interleave with an
inbound-commit rebuild and run two concurrent teardown/build cycles over shared
`runtimes`/`secret`/`epoch` state.

**Change.** `await ready; await runSerial(() => rebuildEpoch())`.

Two things the implementation must confirm rather than assume. `runSerial` is explicitly **not
reentrant** (`:791-792`) — a task calling it again waits on a tail including itself — so this is
safe only while `rebuildEpoch` does not itself take the lock and `resync` remains a top-level entry
point. Both hold today; verify at implementation time. Second, `runSerial` clears `journalReplayed`
when an operation takes the mutex; a rebuild that does not replay therefore leaves it false, which
is the conservative state `pullCommits` requires. No journal-invariant change.

## Fix 3 — reconnect the ack relay

### 3a. Topic scope on `receive`

`HubBase.receive` (`hub-tunnel/src/transport.ts:113`) gains an optional second parameter:

```ts
export type HubReceiveOptions = { topicID?: string }
receive: (subscriberDID: string, options?: HubReceiveOptions) => HubReceiveSubscription
```

Needed because the mux's `sinks` are not topic-filtered (`hub-mux.ts:489`): every message reaches
every sink, and each consumer discards on topic mismatch. A refcount that counted all sinks as
pending holders would leave a commit frame waiting on tunnels that will never ack it, making TTL
expiry the usual outcome rather than a backstop. Consumers must be filtered before they are
counted, and a sink cannot be filtered without knowing its topic.

An **added optional parameter is additive**: an implementation declaring fewer parameters stays
assignable, so every existing double and both conformance suites keep compiling. The tunnel passes
`receiveTopicID` at `transport.ts:220` and keeps its own topic filter at `:367` — `HubReceiveOptions`
is a scope a hub is free to ignore (its own docblock says so), so the consumer-side filter stays
load-bearing rather than becoming redundant.

### 3b. Mux refcount, mirroring `memoryStore`

`memoryStore` already implements this policy one layer down, and the mux mirrors it rather than
inventing a parallel one:

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

Two properties carried up deliberately, both easy to get wrong by re-deriving:

- **A set of holder identities, not an integer counter.** Idempotent: a holder that acks twice
  cannot free the frame early. A counter would.
- **The free is class-conditional** (`:163`) — a log-class frame survives every ack; only mailbox
  frames are delivery-derived. Acking must not be taken to imply reclamation. The mux relays the
  ack upstream and lets the store apply the class rule, so the mux's own tracking assumes nothing
  about class.

**Change**, in the drain (`hub-mux.ts:460-491`), per message:

1. Compute the interested holder set **before** fan-out — the topic's `onInbound` listeners, plus
   sinks whose topic scope matches or is absent.
2. Track it as a `Set` of holder references keyed by delivery position.

   The existing ack closure notes that the position "never leaves this closure" (`:476-479`). That
   invariant is about never crossing the delivery sequence with the topic's log sequence, not about
   lexical scope — keying the pending map by delivery position keeps it, so long as the value is
   still named for what it is and never reaches a log cursor.

3. When a holder acks, delete it. At size 0, fire `subscription.ack?.(position)` upstream, once.
4. An empty interested set is left pending, not acked: it is exactly the shape of a message that
   arrived before its listener was registered (a returning member's backlog lands the instant the
   channel opens, ahead of `initControlLanes` wiring the first `onInbound`), so acking here would
   report a frame nobody read as durably handled. The TTL sweep below prunes it unacked if nothing
   ever does.
5. A sweep prunes entries past a TTL **without acking**, mirroring `purge`. The frame stays in the
   hub mailbox, is redelivered on reconnect, and the hub's age bound reclaims it. Acking on give-up
   would report a broken consumer as durable success — the false-success the conventions skill's
   placeholder rule forbids.

TTL default 60s, configurable on `HubMuxParams`: far above any real local handling time, far below
the store's 30-day age bound. A listener that throws is already swallowed at `:485`, so it never
acks and its claim expires — the correct outcome.

### 3c. The five severed relays

- **`open-once.ts:58`** — bind the `ack` parameter and fire it when that message's link in the
  `opening` chain settles, including on unwrap failure: a frame that cannot be opened has still
  been handled, and leaving it unacked would redeliver an undecryptable frame forever.
- **`hub-mux.ts:512-558`** — give the sink subscription an `ack` member wired to the refcount under
  that sink's own identity.
- **`hub-mux.ts:498`** — forward the ack as `BroadcastBus.subscribe`'s new second callback
  argument, consumed at `broadcast/src/transport.ts:138`. Widening
  `subscribe(topicID, onMessage: (payload: Uint8Array) => void)` (`broadcast/src/bus.ts:7`) to pass
  a second argument is additive for the same reason as 3a — a one-parameter callback stays
  assignable. `createMemoryBus` needs no change: an in-process bus that never redelivers
  legitimately omits ack, exactly as `HubReceiveSubscription.ack?` is documented optional for one.
- **`encrypted-transport.ts:127-134`** — forward `ack` on the wrapped subscription, and pass
  `options` through `receive`. This wrapper re-writes the payload and nothing else; the same
  reasoning already keeps `logPosition` from being dropped at `:113-116`.
- **`transport.ts:313-383`** — the read pump acks every frame it resolves: enqueued, topic
  mismatched, deduped, and decode-failed are all handled outcomes. A frame dropped and never acked
  is redelivered forever.

### 3d. Conformance clauses

`ConformanceReceiveSubscription.ack` (`hub-conformance/src/log-hub.ts:29`) has a type and no
behavioural clause. The coverage tripwire (`hub-tunnel/test/hub-conformance.test.ts:7-20`) fails to
compile only when a hub member has no *type* counterpart in the suite, never when it has no *test* —
which is how a severed relay survived unnoticed under a suite explicitly built to catch drift.

Add clauses at the LogHub seam mirroring the `HubStore` suite's "ack deletes the delivery, not the
log entry" (`hub-conformance/src/index.ts:201`):

- an acked mailbox frame is not redelivered to a fresh `receive` for that subscriber
- a log frame survives every ack and still serves from `fetchTopic`

This is the enforcement mechanism, chosen over extracting a shared refcount primitive. The store's
version is not cleanly extractable — `removeEntry` (`:132-149`) is woven into `deliveries`,
`topicLogs` and `entries`, so pulling out a shared helper means refactoring a store pinned by 24
conformance clauses, as part of a correctness fix. The repo's own discipline for keeping
independent implementations in sync is the contract suite, not code reuse.

## Testing

Redelivery is invisible against a hub that never redelivers, so the tunnel and mux tests need a
double that does. Beyond the conformance clauses:

- `resync()` racing an inbound Commit — already listed in `next/2026-07-07-test-gaps.md`
- `to()` awaited before init resolves — same
- TTL expiry prunes the entry and sends no upstream ack
- a holder acking twice does not free a frame still pending for another holder
- an app-lane mailbox frame is acked once its `open-once` consumer has opened it
- a decode-failed tunnel frame is acked, not redelivered

## Blast radius

- `@kumiai/rpc` — **breaking** (MINOR while 0.x): `ProtocolSurface.to` returns a Promise
- `@kumiai/hub-tunnel` — additive: `HubReceiveOptions`, the `receive` parameter, ack calls
- `@kumiai/broadcast` — additive: the `subscribe` callback's second argument
- `@kumiai/hub-conformance` — additive: new clauses

Ports change, so both contract suites run against the real implementations **and** every double,
per `AGENTS.md`.

## Out of scope

- Extracting a shared refcount primitive and refactoring `memoryStore` onto it. Recorded here as
  the rejected alternative to 3d, not filed as follow-on work — the conformance clauses are the
  intended answer.
- The `ProtocolSurface` phantom-type-parameter retyping
  (`docs/agents/plans/backlog/rpc-api-surface.md`). Fix 1 opens the same type, so bundling is cheap
  if that work is scheduled in this window; it is not scheduled here.
- Strengthening the coverage tripwire to catch a member with a type counterpart but no behavioural
  clause. Real, and the reason this defect survived, but it is a change to how the suite is
  verified rather than to what it verifies.
