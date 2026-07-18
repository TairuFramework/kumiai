# Probe report — a refused subscribe is swallowed, and the default retention sits on the cap

**Status: DONE.** All changes uncommitted on `feat/app-lane-delivery`.

## What was wrong

`hub-mux.ts` gated the hub subscribe on the **refcount**, which it had already bumped, and threw the
rejection away:

```ts
const next = (refcount.get(topicID) ?? 0) + 1
refcount.set(topicID, next)
if (next === 1) void Promise.resolve(hub.subscribe(localDID, topicID, options)).catch(() => {})
```

So a refused subscribe left a count claiming the topic was held, nothing ever asked again, and every
later `fetchTopic` died of `NotSubscribedError` forever — into callers written to swallow. A peer
that applied no commit and delivered no app frame, reporting nothing anywhere.

Two things made it live rather than theoretical: the real hub **refuses** a retention above its
ceiling rather than clamping, and rpc's default (30 days) sat *exactly on* `DEFAULT_MAX_RETENTION`.

## Item 2 — what surface a refusal reaches the host through

This was the real decision, and I argued it three ways before settling. The requirement is that a
peer whose subscribe was refused **cannot report itself healthy**.

- **Retry with backoff** answers a dropped socket and nothing else. `RetentionExceededError` is a
  settled answer; retrying it is a busy loop against a result that will not change. Kept, bounded,
  for transient failures only.
- **Raising into the caller** cannot be the whole answer. `retainTopic` is called for its effect and
  returns before the hub has answered, and the two callers that would catch it — the commit-lane
  seed (`peer.ts:1543`) and the app-segment load — are precisely the ones already written to
  swallow.
- **A host callback** is optional by nature, and an optional notice cannot *be* the guarantee: an
  unwired host would be exactly as blind as before.

**So the guarantee is a latch, and the callback sits on top of it.** A refused topic is recorded as
refused, and every `publish`, `bus.publish`, `mailbox.publish` and `fetchTopic` on it throws the
hub's own error — the *reason*, not the `NotSubscribedError` symptom that names the mux's own
failure as the caller's mistake. A peer that cannot receive on a topic does not go on transmitting
there as though it were whole. That holds whatever the host wired.

`onSubscribeFailed` (on `HubMuxParams`, threaded through `GroupPeerParams`) exists on top because a
peer that only **reads** a topic calls nothing that could throw. The latch cannot reach it; the
notice can. Its doc comment says explicitly that it is optional in a different sense from
`onAppWindowPruned` — that one reports an absence a host loses nothing by ignoring.

### A design hole the peer-level test found

My first implementation made *any* later `retain` re-ask after a refusal, per done-when 2. The
peer-level test went red on `subscriberCount === 0`: the bus transport subscribes the same app topic
with **no options**, which succeeded, so the peer ended up subscribed at the hub's *default*
retention with the latch cleared — a **silent downgrade**, exactly what `RetentionExceededError`
exists to refuse to perform. That is worse than the bug it replaced.

The rule is now: a refusal is a refusal *of a request*. A **permanent** refusal of `retention: N` is
re-asked only by a retain carrying a **different explicit** window; a retain with no window does not
clear it, because a caller with no opinion about retention must not overrule the one that had an
opinion and was refused. A **retry-exhausted** failure carries no answer at all, so any retain
re-asks. Pinned by `a later retain with no window does not quietly settle for the hub default`.

## Item 4 — the default vs the ceiling

Moved both defaults to **28 days** (`DEFAULT_APP_LOG_RETENTION_SECONDS` now *is*
`DEFAULT_COMMIT_LOG_RETENTION_SECONDS`, so they cannot drift apart silently). Four weeks, not thirty
days, and the two days are the margin: a default sitting exactly on the reference ceiling leaves the
documented per-member override nowhere to go — every upward move is refused outright.

Both are exported and asserted, not just documented: `hub-mux-subscribe-failure.test.ts` fails if
they drift apart or up to `DEFAULT_MAX_RETENTION`, and `peer-control-lanes.test.ts` now reads the
constants instead of restating `30 * 24 * 60 * 60`. The architecture doc's "aligned by choice" note
was updated to 28 days with the margin explained, and its footgun paragraph replaced by a table of
the new behaviour.

## Item 3 — the doubles

`FakeHub` and `DurableFakeHub` take `{ maxRetention }`, defaulting to `DEFAULT_MAX_RETENTION`
(2_592_000 — the memory store's own), and refuse `requested > max` with `RetentionExceededError`
exactly as `memoryStore.subscribe` does. `FakeHub` also gained `failSubscribeOnce(topic, count)` for
an injected *transport* failure — the distinction the whole retry policy turns on — and
`subscribeAttempts(topic)`, which is how "does not spin" is counted.

They throw **synchronously**, which `HubBase.subscribe` allows (`Promise<void> | void`). That is
deliberate: the old code's `Promise.resolve(...).catch()` caught only a rejection, so a fixture that
can throw synchronously is a fixture that can show the difference. Keeping `subscribe` synchronous
also left every existing sync `subscriberCount` assertion intact.

`packages/hub-tunnel/test/fixtures/fake-hub.ts` is **still infallible** — out of scope by the
probe's own boundary. Filed as the cheap first step in the plan below.

## Mutation checks

**Restore the swallow** (`catch { return }` in `attemptSubscribe`) → **6 red**, including the
peer-level one:

```
❯ test/hub-mux-subscribe-failure.test.ts (12 tests | 6 failed)
  × the refusal reaches the host instead of being swallowed
      AssertionError: expected [] to have a length of 1 but got +0   (hub-mux-subscribe-failure.test.ts:40)
  × a refusal leaves no phantom refcount: a later retain asks again
      AssertionError: expected 1 to be 2                             (:79)
  × a transient failure is retried until it succeeds, and is not reported
      AssertionError: expected 1 to be 3                             (:106)
  × a later retain with no window does not quietly settle for the hub default
      Error: expected error to be instance of RetentionExceededError (:147)
  × a transient failure that never heals ends as a reported failure, not a silent loop
      AssertionError: expected 1 to be 3                             (:174)
  × cannot report itself healthy: the host is told and the lane fails loudly
      AssertionError: expected [] to deeply equal [ Array(1) ]       (:213)
```

**Make the doubles infallible again** → **8 red**, all four doubles clauses among them:

```
❯ test/hub-mux-subscribe-failure.test.ts (12 tests | 8 failed)
  × the refusal reaches the host instead of being swallowed
  × a refusal leaves no phantom refcount: a later retain asks again
  × a later retain with no window does not quietly settle for the hub default
  × cannot report itself healthy: the host is told and the lane fails loudly
  × FakeHub refuses a retention above its ceiling, and never clamps it
  × FakeHub defaults its ceiling to the memory store's, so a default fixture is no laxer than a default hub
  × DurableFakeHub refuses a retention above its ceiling, and never clamps it
  × DurableFakeHub defaults its ceiling to the memory store's, so a default fixture is no laxer than a default hub

AssertionError: expected 1 to be +0   // hub.subscriberCount('topic:refused')  (:37)
```

**Third, unasked for, to prove the "does not spin" clause has teeth** —
`isPermanentSubscribeFailure` returns `false` for everything → **5 red**, including the spin clause
itself (`a permanent refusal is asked exactly once`, and the phantom-refcount clause reporting
`expected 4 to be 1` attempts). Without this the clause could have passed vacuously.

All three reverted by hand (no `git checkout`/`restore`/`stash`); `grep -rn MUTATION packages/`
returns nothing.

## Verification

- `pnpm run build` → `Tasks: 8 successful, 8 total`
- `rtk proxy pnpm run lint` → `Checked 226 files in 212ms. No fixes applied.`
- `pnpm exec turbo run test:types test:unit --force` (cache off) → `Tasks: 30 successful, 30 total`
  — rpc 239 passed / 1 skipped, mls 309, hub-tunnel 65, hub-server 69, hub-client 5, broadcast 35,
  hub-protocol 8.
- `tests/integration`: `tsc --noEmit` clean, `vitest run` → 23 passed.

No existing test was weakened. `peer-control-lanes.test.ts` changed only from a restated literal to
the exported constants, which is strictly tighter.

## Docs

- `docs/agents/plans/next/2026-07-16-mux-swallows-subscribe-failure.md` folded in and deleted.
- `docs/agents/architecture.md` retention section rewritten: 28 days with the margin argued, and a
  new "A subscribe the hub refuses" subsection describing transient/permanent/latched behaviour and
  the no-silent-downgrade rule.
- **Conformance suite point: filed, not done.** The suite takes a `HubStore`; the doubles are
  `LogHub`s, and they are not variants of one shape (params-object vs positional `subscribe`;
  `fetch`/`ack`/`purge`/`trim` absent from `LogHub` entirely; the load-bearing clauses are about
  storage semantics the doubles do not model). Bridging needs an adapter that would *implement* what
  the suite checks, so the suite would be testing the adapter. Filed as
  `docs/agents/plans/next/2026-07-18-conformance-suite-runs-against-one-implementation.md`, leaning
  on splitting out a `testLogHubConformance`, with the hub-tunnel double's ceiling as the cheap
  first step.

## Concerns

1. **`onSubscribeFailed` is a new `GroupPeerParams` field**, slightly past a literal reading of "the
   retention defaults in `peer.ts`". Without it the mux-level callback would be dead code, and a
   pure-consumer peer would have no surface at all. Six lines; easy to drop if the scope call goes
   the other way.
2. **The retry schedule is wall-clock `setTimeout`** (`[100, 500, 2_000, 10_000]` by default,
   injectable via `subscribeRetryDelaysMs`). A peer disposed mid-backoff checks `disposed` and
   stops, but the timer itself is not cancelled — it holds a handle for up to 10s after dispose. Not
   a leak, but it would keep a Node process alive marginally longer than dispose implies.
3. **`publish` now throws on a refused topic.** That is the deliberate lever that makes the peer
   un-healthy-looking without host wiring, but it does mean a peer refused on its *commit* topic
   fails `commit()` with `RetentionExceededError` rather than the `NotSubscribedError` it used to.
   Better, and a behaviour change worth knowing about.
4. **The hub-tunnel double is still infallible**, by scope boundary. Until it is fixed, the tunnel
   suite still cannot see a hub say no.
5. **`isPermanentSubscribeFailure` recognises only `RetentionExceededError`.** An authorization
   refusal, if one is ever added, would be retried through the schedule and then latched as
   non-permanent — correct behaviour, wrong label, and a slow start.
