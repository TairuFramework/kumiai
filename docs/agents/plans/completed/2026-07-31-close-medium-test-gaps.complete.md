# Close the medium test gaps

**Status:** complete. Branch `test/close-medium-test-gaps`, 14 commits off `main` at `6c0162e`.
**Goal:** retire the Medium section of `next/2026-07-07-test-gaps.md` — five entries from the
2026-07-02 audit (commit `bb343d9`).

## The governing decision, and why it mattered

Every committed test had to be **mutation-verified**: break the source it guards, confirm the test
fails with a decisive message, restore. And the same mutation ran *before* the test was written, as
a probe — if the suite stayed green the gap was real; if it went red the gap was already covered and
no test was written.

That protocol cost one mutation per entry and paid for itself several times over. Four premises
inherited from the audit doc turned out false, and the probes are what caught them:

- **`mutex.test.ts` covers the mutex, not the handle** — false. `group.test.ts:3010-3080` had
  covered the handle since 2026-07-12, with a sharper assertion (`readMessageEpoch(ciphertext)`
  against the post-commit epoch) than the planned test would have made.
- **`wrapCommitPolicy` wraps a combined default-plus-caller callback** — false. `combined`
  (`packages/mls/src/group-handle.ts:797-802`) *selects*: `if (callerPolicy != null) return
  callerPolicy(incoming)`. The first caller-path test rested on the wrong reading and did not
  isolate the caller branch at all.
- **The three `hub-mux.ts` disposed guards are one probe** — false. They are not peers: `:357` was
  already covered (`hub-mux-subscribe-failure.test.ts:211-237`), `:337` is provably unobservable
  (`subscriptions` is mux-local and no reader distinguishes `asking` from `held`), and only `:341`
  was a real gap.
- **A post-dispose rebuild leaks a mux retain into the hub** — false. `mux.dispose()` deliberately
  leaves `subscriptions` standing (`packages/rpc/src/hub-mux.ts:721-726`), so `retain` finds every
  topic held and never re-subscribes. Measured: zero post-dispose hub calls. The leak is real but
  purely local — `listeners`/`refcount` repopulation.

The lesson worth keeping: partial premise-verification reads like diligence and isn't. Two of the
seven predicted tests were correctly never written.

## How the five entries settled

- **`CommitRejectedError`'s captured payload** — closed by
  `packages/mls/test/commit-rejected-payload.test.ts`, both policy paths. Isolating the caller path
  needed a commit the *default* policy would accept, which meant routing carol's role grant through
  a real `createInvite`/`commitInvite` so it folds into `candidateRoster`; a bare Add is rejected by
  `policy.ts:182` for its own reason and proves nothing. Verified asymmetrically: mutating the
  shared capture fails both tests, mutating the dispatch selector fails only the caller-path one.
- **`hub-tunnel` teardown** — half was already covered (`transport-ack.test.ts:301` asserts
  `onSessionEnd` on a peer's frame). The local half is closed by
  `packages/hub-tunnel/test/transport-teardown.test.ts`, on both the `dispose()` and abort paths.
  The trap: `sendSessionEnd` returns early on a null `lockedSessionID`, so a transport built with an
  auto session ID and no traffic publishes nothing — such a test asserts against a vacuum and passes
  in both runs. Construct with a string `sessionID`.
- **Interleaved `encrypt`/`processMessage`** — **void, not fixed.** Already covered since
  2026-07-12, see above.
- **Peer dispose races** — closed by `packages/rpc/test/peer-dispose-race.test.ts` plus a shipped
  fix (below). Of the two races, the commit-tail one needed a roster-changing Remove commit to force
  anchor rotation, so the queued rebuild asks for genuinely *new* topics rather than ones init left
  held.
- **Encrypt from a restored handle after an epoch change** — **settled as not isolable.** The
  sibling test at `app-lane-delivery.test.ts:604` proves a restored member's epoch-3 secrets match
  its peer's, via successful decrypt; it does not exercise the outbound path at all. But no mutation
  reachable from that test's shape can separate "decrypt right, seal wrong", because `processCommit`
  mutates the handle in place and never calls `adopt()` — restore, walk and reseal share one mutable
  object. A test was written, proven unable to fail, and discarded. The reachable variant is filed
  at `backlog/2026-07-31-mls-rpc-author-path-stale-handle-reseal.md`.

## The one shipped change

`packages/rpc/src/peer.ts` gained a `disposed` flag, set as `dispose()`'s first *synchronous*
statement, and an `assertLive()` check at eight entry points — the four `withReady` protocol calls
plus `commit`, `replay`, `recover` and `resync`. Changeset: `minor`.

The defect was real but not the one predicted. `withReady` awaits the same promise `dispose()`
derives from, so a `to()` queued before init settled resumed *first* — early enough to build a
directed client that teardown disposed a microtask later, handing the caller a live-looking `Client`
over an already-aborted transport. The mirror ordering reported `Unknown protocol: chat`, blaming a
protocol that is fine for a peer that is gone. Nothing leaked: teardown does walk `runtime.directed`.

The guard was extended past `withReady` deliberately. The original justification for leaving the
lane calls unguarded — that `peer-dispose-heal.test.ts` depends on them settling across dispose —
did not survive reading that test: its lane calls are issued while `ready` is already settled, so a
guard placed after `await ready` runs long before `disposed` is set. Leaving them unguarded left a
post-dispose `resync()` able to rebuild an epoch onto a disposed mux, and a post-dispose `commit()`
able to publish to the hub. The rule is now simply: a disposed peer refuses everything.

Placement matters and is the part to preserve: the check sits *after* `await ready`, not before. A
pre-await check misses the queued case entirely, which is the whole race.

## Also on the branch

`tests/integration/test/hub-tunnel-echo.test.ts` re-homed from an inline in-memory double onto the
real hub-server wire (`createWireHub`), assertions unchanged — it was the last file in that suite
not crossing the wire. No real-hub semantic differences surfaced.

## Follow-on

- `backlog/2026-07-31-close-medium-test-gaps-residuals.md` — four items, notably that `replay` and
  `recover` post-dispose guards remain unpinned (`commit`'s is pinned, because its damage reaches
  the hub) and that `onCommitDelivery` is still unguarded.
- `backlog/2026-07-31-mls-rpc-author-path-stale-handle-reseal.md` — the reachable variant of the
  restored-handle gap.
