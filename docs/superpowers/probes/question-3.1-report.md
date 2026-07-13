# Probe report — Question 3.1

**Does the pull-driven commit lane seed and catch up correctly?**

**Status: DONE_WITH_CONCERNS.** The lane lands, the late joiner converges by pulling, and both
wrong-but-passing implementations are proven wrong by mutation. The concerns are listed at the end —
the load-bearing ones are (1) the pull hands a peer back **its own commit frames**, which push never
did, and (2) a peer that recovers past commits still sitting in the log will re-apply them, because
nothing classifies a stale-epoch frame yet (that is 3.4).

---

## 1. The lane's shape

### Topic split

`packages/rpc/src/topic.ts`

- `COMMIT_LABEL = 'enkaku/commit/v1'` (`topic.ts:8`), `RENDEZVOUS_LABEL = 'enkaku/rendezvous/v1'`
  (`topic.ts:11`).
- `commitTopic(recoverySecret)` — `topic.ts:47` — commits only, retained as a log, read by pull.
- `rendezvousTopic(recoverySecret)` — `topic.ts:60` — recovery request/reply, mailbox, push-delivered.
- Both `deriveTopicID(recoverySecret, 0, LABEL)`: non-rotating, epoch-independent, derivable by a
  peer stranded on any epoch. `handshakeTopic` / `HANDSHAKE_LABEL` are **deleted** — the single topic
  is gone, not deprecated.

Both are subscribed once in `initControlLanes` (`peer.ts:397`) and released only in `dispose`
(`peer.ts:519`). Neither is rebuilt by `rebuildEpoch`, so `resync` does not touch them.

### Where the cursor lives

`peer.ts:223`:

```ts
let reconciledHead: LogPosition | null = null
```

`null` means "this peer has processed nothing from this topic", and it is what makes the pull read
from the **oldest retained frame** rather than from anywhere it guessed.

### Where the pull happens

`pullCommits` (`peer.ts:313`) is **the only place a commit frame is ever read**. It loops
`mux.fetchTopic` from the cursor until the log is drained (`COMMIT_FETCH_LIMIT = 100`,
`peer.ts:43`), and is called from exactly three places:

| caller | `file:line` | why |
|---|---|---|
| seeding, at init | `peer.ts:419` | the commits published before this peer subscribed |
| the wakeup | `peer.ts:370` `onCommitDelivery` → `reconcileCommits` (`peer.ts:358`) | a delivery landed |
| after a local commit | `peer.ts:441` | no push comes back for a frame this peer published |

### Where the cursor advances

Inside `pullCommits`, once per frame, on **four** paths (`peer.ts:332–351`):

- the frame is this peer's own commit, already applied → step over it, advance
- the frame does not decode → dropped as malformed, advance
- the frame is not a commit (a stray rendezvous/garbage frame on the commit topic) → dropped, advance
- `processCommit` returned → advance

and on **no** path when `processCommit` **throws**: the throw propagates out of `pullCommits`, the
cursor keeps its last value, and the next pull re-reads that frame. The cursor, not the ack, is what
makes the lane retry. Acking is now pure delivery bookkeeping — `onCommitDelivery` acks immediately
and unconditionally (`peer.ts:371`).

### How a pushed frame is prevented from being processed as a frame

`peer.ts:363–376`:

```ts
const onCommitDelivery = (_message: StoredMessage, ack: () => void): void => {
  ack()
  void runSerial(async () => {
    await ready
    await reconcileCommits()
  }).catch(() => { /* the cursor did not advance; the next wakeup reads those frames again */ })
}
```

The message is bound to `_message` and **never read**. There is no decode, no `processCommit`, and no
cursor write on this path — the only thing a delivery does is schedule a pull. This is trap 1: an
accepted `retain: 'log'` publish is pushed *and* appended, so every online peer sees each commit
twice; a lane that also processed the pushed copy applies every commit twice. Proven in §5.

---

## 2. The two cursors, and how they are kept apart

`packages/rpc/src/cursor.ts` (new). Both positions are `string` on the wire, and `hub/receive`'s
`after` and `hub/topic/fetch`'s `after` mean different things — a delivery-queue position versus a
log position. They are branded apart:

```ts
declare const logPositionBrand: unique symbol
declare const deliveryPositionBrand: unique symbol
export type LogPosition = string & { readonly [logPositionBrand]: true }
export type DeliveryPosition = string & { readonly [deliveryPositionBrand]: true }
```

- **`LogPosition`** — the domain of `fetchTopic`'s `after`/`head`/`oldest`, and of the sequenceID a
  `retain: 'log'` publish returns. `reconciledHead: LogPosition | null` (`peer.ts:223`).
- **`DeliveryPosition`** — the domain of `hub/receive`'s `after` and of `ack`. It lives in exactly one
  place: hub-mux's ack closure (`hub-mux.ts:136–142`), where the delivered sequenceID is named
  `asDeliveryPosition(...)` and handed to `subscription.ack`. It never escapes that closure.

**Does the type system stop them being crossed? Yes, and this is the one thing I would not have got
right without the brief.** They do not share an alias, and neither is assignable to the other nor to
a bare `string` slot expecting the other brand. Concretely: `message.sequenceID` on a pushed frame is
a plain `string`, so `reconciledHead = message.sequenceID` **does not compile** — the pushed frame's
position cannot become the cursor by accident. Minting a `LogPosition` requires calling
`asLogPosition`, which appears in exactly two places, both fed from a log source: the entries of a
`fetchTopic` result (`peer.ts:331`) and the sequenceID a log publish returned (`peer.ts:438`).

There is deliberately **no `deliveryCursor` in the peer**: the peer holds no delivery-queue position
at all (hub-mux drains `hub.receive` with no `after` and acks per message). The name exists on the
type, at the one boundary where a delivery position is a value, so that the two can never be silently
unified later.

---

## 3. The late-joiner test — the deliverable

`packages/rpc/test/peer-commit-lane.test.ts:66`. A member joins at epoch 1 (its Welcome's epoch); two
further commits land **before it subscribes**; it converges by pulling.

```ts
test('a member that subscribes after commits have landed converges by pulling them', async () => {
  await publishCommit(hub, 'alice', recoverySecret, new Uint8Array([1]))
  await publishCommit(hub, 'alice', recoverySecret, new Uint8Array([2]))

  const dave = makeMLSPeer(hub, 'dave', recoverySecret, 1)
  await flush()

  expect(dave.mls.epoch()).toBe(3)          // reached the group's epoch
  expect(dave.mls.commits()).toBe(2)        // by applying both missed commits, once each
  const secret = await dave.crypto.exportSecret()
  expect(hub.subscriberCount(protocolTopic(secret, 3, 'chat'))).toBe(1)   // app lane rebuilt there
  expect(hub.subscriberCount(protocolTopic(secret, 1, 'chat'))).toBe(0)
  expect(recoveryRequests(hub, recoverySecret)).toHaveLength(0)           // no recover(), no heal
})
```

On the "raises no fork diagnosis" clause: **the peer has no diagnosis surface today** — there is no
fork/heal signal in `GroupPeer` or `GroupMLS` to assert on (fork classification is 3.4's). What the
current code *could* spuriously do is ask the group for help, so the assertion is against the wire:
**zero recovery requests on the rendezvous topic**, plus an exact commit count (2, not 3, not 4), so
neither a spurious heal nor a double-apply passes silently.

```
 ✓ test/peer-commit-lane.test.ts (6 tests) 300ms
   ✓ a member that subscribes after commits have landed converges by pulling them
   ✓ a peer that has processed nothing seeds from the log, not from the head
   ✓ two peers online: one commit, one apply each
   ✓ a committer does not apply its own commit again when it reads the log back
   ✓ a frame the peer cannot use is dropped, and the cursor steps over it
   ✓ a hub that cannot serve a topic log cannot run the commit lane

 Test Files  17 passed (17)
      Tests  77 passed (77)
```

---

## 4. The mutation check — head-seeded cursor

Replaced the seed at `peer.ts:419` with the wrong-but-obvious one: read the head at subscribe time
and set the cursor to it, processing nothing.

```ts
// MUTATION (question 3.1's wrong-but-passing seeding) — seed the cursor from the
// topic's head at subscribe time. Reverted below.
const seed = await mux.fetchTopic({ topicID: commitTopicID, limit: 1 })
reconciledHead = seed.head == null ? null : asLogPosition(seed.head)
```

Result — **75 of 77 still pass**, exactly as the brief predicted. Every online-peer test is green;
only the two late-joiner tests fall:

```
PASS (75) FAIL (2)

1. the commit lane is pull-driven a member that subscribes after commits have landed converges by pulling them
   AssertionError: expected 1 to be 3 // Object.is equality
       at packages/rpc/test/peer-commit-lane.test.ts:81:30

2. the commit lane is pull-driven a peer that has processed nothing seeds from the log, not from the head
   AssertionError: expected +0 to be 2 // Object.is equality
       at packages/rpc/test/peer-commit-lane.test.ts:108:32
```

`expected 1 to be 3` is the joiner stranded on the epoch it was invited at, CAS-ready against a head
whose commits it never applied. Reverted; suite back to 77/77.

---

## 5. The two-peers-online test — and its own mutation check

`packages/rpc/test/peer-commit-lane.test.ts:113`:

```ts
test('two peers online: one commit, one apply each', async () => {
  const bob = makeMLSPeer(hub, 'bob', recoverySecret)
  const carol = makeMLSPeer(hub, 'carol', recoverySecret)
  await flush()
  await publishCommit(hub, 'alice', recoverySecret, new Uint8Array([1]))
  await flush()

  expect(bob.mls.commits()).toBe(1)      // not 2 — the pushed copy is a wakeup, not a frame
  expect(bob.mls.epoch()).toBe(2)
  expect(carol.mls.commits()).toBe(1)
  expect(carol.mls.epoch()).toBe(2)
})
```

Passing is not enough — the test has to *discriminate*. Mutated `onCommitDelivery` to process the
pushed payload as well as pulling:

```ts
// MUTATION: process the pushed copy as a frame, as well as pulling. Reverted below.
const pushed = decodeHandshakeFrame(_message.payload)
if (pushed.kind === HANDSHAKE_KIND.commit) {
  const { advanced } = await mls.processCommit(pushed.payload, { senderDID: _message.senderDID })
  if (advanced) await rebuildEpoch()
}
```

```
PASS (71) FAIL (6)

1. the commit lane is pull-driven two peers online: one commit, one apply each
   AssertionError: expected 2 to be 1 // Object.is equality
       at packages/rpc/test/peer-commit-lane.test.ts:126:31
...
4. the commit lane across a disconnect a redelivered commit is not applied twice; a missed one is caught up by the pull
   AssertionError: expected 3 to be 2 // Object.is equality
5. control lane lifecycle a Commit advances and resyncs every receiver
   AssertionError: expected 3 to be 2 // Object.is equality
```

Every commit applied twice, by every online receiver. Reverted.

---

## 6. Existing `rpc` tests that encoded the old push-driven contract

`rpc` had 68 tests. All 68 still exist in substance; **one of them asserted the behaviour this
question replaces**, and three more were retargeted at the split topics.

1. **`peer-handshake-replay.test.ts` → `peer-commit-reconnect.test.ts` — this one encoded the bug.**
   Its name was *"acked Commits are not redelivered; missed Commits replay on reconnect"*, and it
   asserted `hub.ackedCount('bob')` as the mechanism: the peer got its missed commits **because the
   hub redelivered unacked frames**, and avoided reprocessing **because it had acked**. That is
   exactly the "do not ack, so the hub redelivers" retry the spec removes. Rewritten deliberately as
   *"a redelivered commit is not applied twice; a missed one is caught up by the pull"*: redelivery is
   now just another wakeup, and the assertion is that the **cursor** — not the ack — is what makes the
   second delivery a no-op and the missed commit arrive. The `ackedCount` assertions are gone: acking
   is no longer load-bearing for commits, so asserting on it would re-encode the old contract.

2. `peer-handshake.test.ts` → `peer-control-lanes.test.ts`. The lifecycle test asserted **one**
   handshake subscription; it now asserts two topics, distinct, both surviving resync and both
   dropped on dispose. `localCommitted` is asserted to publish `retain: 'log'` (head moves).

3. `peer-handshake-recovery.test.ts` → `peer-recovery.test.ts`. Retargeted at `rendezvousTopic`;
   storm-collapse and timeout behaviour unchanged.

4. `topic.test.ts` gained the split (`commitTopic !== rendezvousTopic`, both non-rotating).

Net: **77 tests, all green.**

---

## 7. Changes outside `rpc` (necessary, and the peer could not be built without them)

`HubLike` — the port the peer is handed — **had no way to read a log**. It grew three things
(`packages/hub-tunnel/src/transport.ts:36–95`):

- `HubPublishParams.retain?: 'log' | 'mailbox'` — without it the commit lane cannot append a frame
  that outlives its last ack, and the whole question is moot.
- `HubLike.subscribe(subscriberDID, topicID, options?: HubSubscribeOptions)` with
  `{ retention?: number }` — the log window, asked for at subscribe time. Back-compatible: existing
  2-arg implementations still satisfy the type.
- `HubLike.fetchTopic?` — **optional**, deliberately. The directed/session/encrypted hub wrappers
  (`directed.ts:99`, `directed-crypto.ts:24`, `encrypted-transport.ts:30`) are mailbox-only views with
  no log to serve, and forcing them to fake one would be a lie. So the peer instead **refuses to run**
  on a hub that omits it (`peer.ts:399`), rather than silently degrading to push — which is the same
  stranding failure in a different costume. Asserted:
  *"a hub that cannot serve a topic log cannot run the commit lane"* → `rejects.toThrow(/pull-driven/)`.

`HubMux` grew `publish({ retain })`, `fetchTopic(...)` and `canFetchTopic` (`hub-mux.ts:40–56`).

**A live bug in the test fixtures, exposed by the log:** `FakeHub`/`DurableFakeHub` minted
sequenceIDs as `String(++seq)` — a bare decimal, where `"10" < "9"`. That is fine for a mailbox and
**fatal for a log**: `after` is an exclusive cursor compared lexicographically, so the pull would skip
or re-read frames past the tenth commit. Both fixtures now zero-pad to 12 like the real store
(`memoryStore.ts:47`). The store contract's own comment warns about exactly this; the fixtures
predated it.

---

## 8. What 3.2–3.7 will need that this lane does not have

Nothing was stubbed, but the lane's shape forced two decisions to the surface:

1. **The pull hands a peer back its own commit frames — push never did.** The hub excludes a sender
   from its own delivery, but a *log* is not delivery-filtered, so the committer reads its own frame
   back and would apply a commit it had already applied. Handled here with an in-memory
   `selfCommitted: Set<LogPosition>` (`peer.ts:231`, consumed at `peer.ts:332`), populated from the
   sequenceID the publish returns. **This does not survive a restart**, and it is 3.3's journal that
   should replace it — a peer that crashes between publishing and recording will re-apply its own
   commit on restart. **3.3 must own this**; the Set is the smallest correct thing that does not reach
   into the journal.

2. **A recovered peer will re-apply the stale commits still in the log.** After `applyRecovery` jumps
   a peer to epoch M, its `reconciledHead` is unchanged, so the next pull walks frames from epochs it
   has already passed. The spec's answer is "dropped, and the cursor still advances" — but *dropping*
   requires classifying a frame as stale-epoch, and that is **3.4's table**, so I did not build it.
   Today `MemoryGroupMLS.processCommit` advances on any non-empty commit, so it would double-advance.
   **No test covers this because the recovery tests have no commit frames on the topic** — the hole is
   real and invisible. 3.4/3.5 must close it, and should add exactly that test.

Also handed forward, smaller:

- **The trimmed-backlog gap is not detected.** `fetchTopic` with an `after` below `oldest` returns from
  `oldest` — silently skipping the trimmed frames. The peer has `oldest` in the reply and does not
  compare it to its cursor. That comparison *is* the recovery trigger ("my backlog was trimmed, I must
  heal"), and it belongs to 3.5.
- **Retry has no timer.** A `processCommit` that throws leaves the cursor put, and the lane retries on
  the *next wakeup* — which may never come if the group is quiet. Nothing pulls on reconnect either
  (`HubLike.events` is unused). D3's business.
- **No CAS.** `localCommitted` publishes unconditionally — no `expectedHead`, no `publishID`
  (3.3). `expectedHead` and `publishID` are already on `HubStore`/`HubClient` from phase 1 but are
  deliberately not plumbed through `HubLike`, since nothing here would use them.
- **A failed seed is swallowed** (`peer.ts:419`) so a hub hiccup at init does not permanently wedge the
  peer's `ready`. It leaves the cursor null and retries on the next wakeup, but nothing surfaces the
  failure to the host.

---

## 9. Verify

```
$ rtk proxy pnpm run build
 Tasks:    7 successful, 7 total
Cached:    5 cached, 7 total
  Time:    874ms

$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 173 files in 148ms. No fixes applied.

$ rtk proxy pnpm test
@kumiai/hub-server:test:unit:       Tests  56 passed (56)
@kumiai/hub-client:test:unit:       Tests  5 passed (5)
@kumiai/rpc:test:unit:         Test Files  17 passed (17)
@kumiai/rpc:test:unit:              Tests  77 passed (77)
 Tasks:    27 successful, 27 total

$ cd tests/integration && rtk proxy pnpm test
$ tsc --noEmit --skipLibCheck && vitest run
 Test Files  4 passed (4)
      Tests  23 passed (23)

$ pnpm exec tsc --noEmit --skipLibCheck   # packages/rpc, incl. tests
TypeScript: No errors found
```

Not committed.

---

## 10. The port split (follow-up)

Concern #3 above — `fetchTopic` optional on `HubLike`, plus a runtime refusal — is resolved by
drawing the type distinction the refusal was standing in for. `HubLike` was naming two different
things: the real hub a host wires into `GroupPeer`, which **must** serve a log, and the mailbox-shaped
adapter views built inside `rpc`, which are not hubs and have no log. Split and renamed.

### Final type shapes

`packages/hub-tunnel/src/transport.ts`:

- **`MailboxHub`** (`transport.ts:83`) — `publish`, `subscribe`, `unsubscribe?`, `receive`, `events?`.
  **No `fetchTopic`.** Publish and push-delivery over topics; a subscriber sees only what is published
  after it subscribes.
- **`LogHub = MailboxHub & { fetchTopic: (...) => Promise<HubFetchTopicResult> }`** (`transport.ts:101`)
  — `fetchTopic` **required**. A hub that also retains a readable per-topic log.
- Satellites renamed: `MailboxHubEvent` (`:25`), `MailboxHubEventListener` (`:30`),
  `MailboxHubEvents` (`:32`). `HubPublishParams` (with `retain`) and `HubSubscribeOptions` stay on
  `MailboxHub` — an adapter can still forward a `retain: 'log'` publish to the real hub underneath,
  and the publish shape stays uniform.

### Call sites that moved

| site | `file:line` | now |
|---|---|---|
| `GroupPeerParams.hub` | `peer.ts:46` | **`LogHub`** |
| `HubMuxParams.hub` | `hub-mux.ts:15` | **`LogHub`** |
| `HubMux.hubLike` → **`HubMux.mailbox`** | `hub-mux.ts:44` | `MailboxHub` (renamed; reads better at its two call sites) |
| `directed.ts` session hub + tunnel wiring | `directed.ts:36`, `directed.ts:102` | `mux.mailbox` |
| `sealDirectedHub` | `directed-crypto.ts:24` | `MailboxHub` in, `MailboxHub` out |
| `encrypted-transport` `wrapHub` | `encrypted-transport.ts:30` | `MailboxHub` |
| `HubTunnelTransportParams.hub` | `transport.ts:108` | `MailboxHub` |
| test fixtures `FakeHub` / `DurableFakeHub` | `test/fixtures/*.ts` | `implements LogHub` |
| `tests/integration/test/hub-tunnel-echo.test.ts` | `:22` | `MailboxHub` |

Deleted: `HubMux.canFetchTopic`, `HubMux.fetchTopic`'s reject-if-absent branch, and the runtime
refusal that was at `peer.ts:399`. `HubMux.fetchTopic` now calls `hub.fetchTopic` unconditionally —
it can no longer be handed a hub without one.

### Did any of the four adapters turn out to need a log?

**No.** `mux.mailbox`, `sealDirectedHub`, `directed.ts`'s `sessionHub` and `encrypted-transport`'s
`wrapHub` are **unchanged in substance** — not one of them gained a method, and none of them fakes a
log. Each is a per-session or per-peer view that carries directed RPC frames, never a commit. That is
the confirmation the split was the right cut: the optional `fetchTopic` existed solely because these
four could not satisfy a required one, and none of them ever wanted to.

### What happened to the refusal test

`"a hub that cannot serve a topic log cannot run the commit lane"` had no runtime behaviour left to
assert, so it was **replaced, not deleted**, by a type-level assertion —
`"a hub with no log cannot be wired into a peer at all"` (`test/peer-commit-lane.test.ts:190`). It
builds a `MailboxHub` and puts `@ts-expect-error` on the `hub:` property of a `createGroupPeer` call
inside a function that is never invoked: the assertion *is* the compile error, and `test:types`
(`tsc -p tsconfig.test.json`) is what runs it.

**It discriminates.** Making the hub assignable (`hub: mailboxOnly as unknown as LogHub`) turns the
directive unused and fails the build:

```
test/peer-commit-lane.test.ts(205,9): error TS2578: Unused '@ts-expect-error' directive.
TypeScript: 1 errors in 1 files
```

Reverted. The stranding failure is now caught at the host's wiring, at compile time, instead of at the
peer's first `await`.

### Verify (after the split)

```
$ rtk proxy pnpm run build
 Tasks:    7 successful, 7 total

$ rtk proxy pnpm run lint
Checked 173 files in 146ms. No fixes applied.

$ rtk proxy pnpm test
@kumiai/mls:test:unit:              Tests  283 passed (283)
@kumiai/hub-tunnel:test:unit:       Tests  63 passed (63)
@kumiai/hub-server:test:unit:       Tests  56 passed (56)
@kumiai/broadcast:test:unit:        Tests  35 passed (35)
@kumiai/rpc:test:unit:              Tests  77 passed (77)
 Tasks:    27 successful, 27 total

$ cd tests/integration && rtk proxy pnpm test
      Tests  23 passed (23)
```

Still 77 `rpc` tests: the refusal test became the type-level one, one for one. Not committed.
