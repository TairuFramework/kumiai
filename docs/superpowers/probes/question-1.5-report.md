# Probe report — Question 1.5

**Does `fetchTopic` read the log, gated on subscription — end to end?**

**Answer: yes. The lane is reachable over a real client and a real server, and all five things
cross the wire — each one proven by deleting it and watching a test go red**, not by watching a
call succeed.

Status: **DONE_WITH_CONCERNS** — everything green (27/27 tasks, integration 23/23). The concerns
are one deliberate deviation from the brief (`HubLike`, §6) and two things the existing protocol
assumes about the mailbox that a future lane will trip over (§7). Nothing committed.

---

## 1. The wire surface

**New procedure: `hub/topic/fetch`** (`packages/hub-protocol/src/protocol.ts:79-118`), a `request`,
following the shape of `hub/keypackage/fetch` exactly. `hub/receive` was not touched.

```
param:  { topicID, after?, limit? }      // NOTE: no subscriberDID
result: { messages: [{ sequenceID, senderDID, topicID, payload(base64) }],
          head: string|null, oldest: string|null }
```

**`subscriberDID` is not a wire field, and the existing procedures were already doing this
correctly** — that is the finding the brief asked me to check for, and it is a *good* one. Every hub
handler derives the caller from `getClientDID(ctx)` (`packages/hub-server/src/handlers.ts:54-60`),
which reads `ctx.message.payload.iss` — the **verified issuer** of the signed message — and throws
if it is missing. `hub/publish`, `hub/subscribe`, `hub/receive` and its acks all do this; none takes
a DID from the body. The new handler does the same
(`handlers.ts:172-177`): `const subscriberDID = getClientDID(ctx)`. A `subscriberDID` in the params
would let any member read any topic's log by naming someone else, so the protocol test now asserts
its **absence** from the schema, alongside `additionalProperties: false`
(`packages/hub-protocol/test/protocol.test.ts:21-31`).

The handler reads the **log**, via `store.fetchTopic` — not the delivery rows, which are right there
and keyed by topic and would have "worked" for every online peer.

Threading (`handlers.ts:126-141`, `:163-168`; `packages/hub-client/src/client.ts:71-96`):
`retain`, `expectedHead`, `publishID` on publish; `retention` on subscribe.

**One subtlety that would have been a silent bug:** `expectedHead: null` (the empty-topic sentinel,
a *conditional* publish) and an *absent* `expectedHead` (an *unconditional* publish) are different
requests. Both the client and the handler therefore spread the key only when the caller actually set
it — `...('expectedHead' in params ? { expectedHead: params.expectedHead } : {})` — rather than
passing `params.expectedHead` unconditionally, which would turn every mailbox publish into a
conditional one against `undefined`. The wire schema is `type: ['string', 'null']`, and the protocol
test pins it.

---

## 2. Do all five actually arrive server-side? Proven by deletion

Asserting "the call succeeded" proves nothing here: **every one of these degrades silently to
today's behaviour if it never arrives.** So the integration test does two things — it asserts the
params the **server handed the store** (via a recording `HubStore` wrapper,
`tests/integration/test/hub-log-lane.test.ts:33-52`), and it asserts a behavioural consequence that
is impossible without the field.

Then I checked the tests are not vacuous by **deleting each field from the client, rebuilding, and
re-running**. Every one goes red, and the failures are worth reading:

| Field dropped | Result | The failure |
|---|---|---|
| `retain` | **3 of 6 fail** | `expected [ undefined, undefined ] to deeply equal [ undefined, 'log' ]` — the server received no class, and the zero-subscriber pull returns `[]`. This is the nightmare in the brief: every commit published mailbox-class, ack GC eats the log. |
| `expectedHead` | 1 fails | `expected undefined to be null` — the sentinel arrived as an absent field, so the CAS silently became unconditional. |
| `publishID` | 1 fails | `Error: Publish to topic:log-lane expected head null, but the head is 000000000001` — **the replay became an ordinary new publish and failed its CAS.** The restart-replay brick, reproduced end to end over the wire. Same shape as the row-hung store in question 1.4. |
| `retention` | 1 fails | `expected undefined to be 2592000` — the request never reached the store, so the 30-day window would have silently become the hub default. |
| `fetchTopic` | — | the procedure is the test; without it there is no pull lane at all. |

Baseline with all five restored: `PASS (6) FAIL (0)`.

That table is the deliverable of this question. Each row is a silent downgrade that no existing test
in the repo would have caught.

---

## 3. The three errors cross the wire as distinguishable errors

Enkaku's error reply carries a free-form `code` string
(`@enkaku/protocol/lib/schemas/error.d.ts`) and the client rejects with a `RequestError` exposing
`.code`. So:

- `packages/hub-protocol/src/errors.ts:1-12` defines `HUB_ERROR_CODES` —
  `HUB_HEAD_MISMATCH`, `HUB_NOT_SUBSCRIBED`, `HUB_RETENTION_EXCEEDED`.
- `hubErrorCodeOf(error)` (`errors.ts:36-42`) maps a thrown store error to its code; the server's
  `rethrowAsHandlerError` (`handlers.ts:62-77`) re-raises it as a `HandlerError` with that code, and
  passes anything else through untouched.
- `hubErrorFromCode(code, message)` (`errors.ts:44-60`) rebuilds the named class on the client side,
  so a caller branches on `instanceof HeadMismatchError` rather than on a string.

**Can a client tell a lost CAS from a dead hub?** Yes, and that is exactly the assertion:
`hubErrorFromCode(error.code, error.message)` returns a `HeadMismatchError` instance for the CAS
loser, and returns **`null` for anything without a hub code** — which is what a transport failure,
a timeout or an enkaku `EK0x` is. The peer lane's retry loop turns on that distinction, so it is
tested for all three errors, over the wire, in the integration test.

---

## 4. The integration test

`tests/integration/test/hub-log-lane.test.ts`, over a real `HubClient`, a real `createHub` server
and `DirectTransports`. Six cases:

1. **`a peer subscribing after the fact pulls frames published with zero subscribers`** — the
   deliverable, and the end-to-end form of the load-bearing clause. Alice publishes two `retain: 'log'`
   frames to a topic **nobody is subscribed to**; Bob then connects, subscribes, and pulls both,
   with `head` and `oldest`, plus the exclusive cursor and the limit. **A delivery-row implementation
   of `fetchTopic` returns `[]` here** — it retained nothing, because no delivery row was ever
   written.
2. `the retention class crosses the wire` — a mailbox frame and a log frame on one topic, both
   acked by every subscriber; the mailbox one is gone, the log one is still there and still `head`.
3. `expectedHead crosses the wire` — the loser gets `HUB_HEAD_MISMATCH`, maps to `HeadMismatchError`,
   and nothing was stored for it.
4. `publishID crosses the wire` — a replay carrying a stale `expectedHead` returns the original
   sequenceID.
5. `retention crosses the wire` — a subscribe above the maximum is refused with
   `HUB_RETENTION_EXCEEDED`, is not clamped, and creates no subscription.
6. `the topic log is gated on subscription` — a non-subscriber gets `HUB_NOT_SUBSCRIBED`.

```
$ pnpm exec vitest run test/hub-log-lane.test.ts
PASS (6) FAIL (0)
```

---

## 5. Verify

`rtk proxy pnpm run build`: `Tasks: 7 successful, 7 total`

`rtk proxy pnpm run lint`:

```
$ biome check --write ./packages ./tests
Checked 167 files in 189ms. No fixes applied.
```

`rtk proxy pnpm test`:

```
@kumiai/mls:test:unit:           Tests 265 passed (265)
@kumiai/broadcast:test:unit:     Tests  35 passed (35)
@kumiai/hub-protocol:test:unit:  Tests   8 passed (8)
@kumiai/hub-tunnel:test:unit:    Tests  63 passed (63)
@kumiai/hub-client:test:unit:    Tests   5 passed (5)
@kumiai/rpc:test:unit:           Tests  68 passed (68)
@kumiai/hub-server:test:unit:    Tests  56 passed (56)

 Tasks:    27 successful, 27 total
```

Integration: `PASS (23) FAIL (0)` (17 existing + the 6 new).

`hub.test.ts` is **untouched** and green; `hub/receive` and the mailbox path were not modified.

One existing test needed updating and it was a *correct* failure, not a casualty:
`packages/hub-protocol/test/protocol.test.ts` asserts the exact procedure inventory, so adding a
procedure broke it by design. It now includes `hub/topic/fetch` and gained three assertions pinning
the new wire surface (no `subscriberDID`; `retain`'s enum; `expectedHead`'s `['string','null']`).

---

## 6. Deliberate deviation: I did not add `fetchTopic` to `hub-tunnel`'s `HubLike`

The brief's "done when" lists `hub-tunnel`'s `HubLike`. I did not touch it, and want that visible
rather than buried.

`HubLike` (`packages/hub-tunnel/src/transport.ts:42-48`) is the **tunnel's** view of a hub:
`publish`, `subscribe`, `unsubscribe?`, `receive`, `events?`. It exists so a tunnel can push frames
and drain a mailbox — it is a *mailbox* abstraction, and the tunnel has no use for a log: it is a
point-to-point transport, not a lane that replays history. Nothing in `hub-tunnel` or `rpc` would
call `fetchTopic`, and the peer lane in Phase 3 pulls the commit log through **`hub-client`**, which
is where I put it.

Adding an optional `fetchTopic?` to `HubLike` today would be an unused method on an interface with
four implementations (two of them test fakes) — speculative surface the conventions rule out. **If
Phase 3's peer lane turns out to sit behind `HubLike` rather than beside it, this is a two-line
addition then, with a caller to justify it.** Flagging rather than deciding.

---

## 7. What surprised me: two places the existing protocol assumes the mailbox

### 7.1 `hub/publish`'s live fan-out pushes log frames to connected subscribers too

`handlers.ts:143-152` (unchanged by me) live-delivers every accepted publish to connected
subscribers via the registry. That now includes `retain: 'log'` frames — so a commit is **both**
pushed down `hub/receive` *and* retained in the log for pulling. A peer that is online gets the
commit twice: once as a push, once when it pulls. That is not wrong (the pull is idempotent, and the
delivery row is what the ack clears), but **it means the commit lane's client must not treat the
push and the pull as independent streams**, or it will process every online commit twice. Nothing in
the store or the wire prevents this; it is a client-side ordering concern for Phase 3, and it is the
kind of thing that works perfectly in every test until two peers are online at once.

### 7.2 `hub/receive`'s cursor is a *delivery* cursor, and it looks exactly like a log cursor

Both `hub/receive`'s `after` and `hub/topic/fetch`'s `after` are sequenceIDs, look identical on the
wire, and mean **different things**: one is a position in the recipient's delivery queue, the other a
position in the topic's log. They are not interchangeable — a peer that stores "my cursor" once and
feeds it to both will silently mis-page, because the delivery queue is a different (and shorter, and
per-recipient) sequence than the log. The types cannot tell them apart; both are `string`. Worth a
distinct name in the peer lane's state (`deliveryCursor` vs `logCursor`) rather than one `after`.

### 7.3 A smaller one: the authorize hook has no `fetch` action

`AuthorizeHook` is `(did, 'publish' | 'subscribe', topicID)`. `hub/topic/fetch` is gated on
*subscription* (the spec's design: "it exposes a topic's log only to members who already derive that
topic from the group secret"), so it needs no new action — a member cannot subscribe to a topic it
cannot derive, and `hub/subscribe` is already authorized. I left the hook alone deliberately. But a
host that wants to authorize reads *separately* from subscribes has no hook to do it with, and that
is now a one-word change (`'publish' | 'subscribe' | 'fetch'`) that nobody will think to make until
they need it.
