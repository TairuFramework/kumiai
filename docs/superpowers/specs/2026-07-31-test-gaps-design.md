# Close the medium test gaps

**Status:** design, approved 2026-07-31.
**Retires:** the Medium section of `docs/agents/plans/next/2026-07-07-test-gaps.md`.
**Origin:** 2026-07-02 audit (commit `bb343d9`), re-verified 2026-07-28, re-verified again here.

Five entries, seven pieces of work. Each entry ends one of two ways: a test with proven teeth, or a
documented "already covered by X". Both retire the entry.

## Premises re-verified 2026-07-31

The doc's Medium section was checked against current source before designing. Two entries had
drifted:

- **hub-tunnel teardown was half stale.** `transport-ack.test.ts:301` already asserts `onSessionEnd`
  fires on a peer's `session-end` frame. What is uncovered is the local teardown path: `dispose()`
  publishing a `session-end` frame and calling `hub.unsubscribe`.
- **"dispose() during an in-flight handshake" names a thing that no longer exists.** `handshakeTail`
  was removed on `fix/high-severity-correctness`. The item is re-scoped to two live races: dispose
  against a queued commit-tail rebuild, and dispose against an establishing directed `to()` session.

One note in the doc is also stale in the reader's favour: it says the integration suite is "not run"
by the repo gate. CI does run it — `.github/workflows/build-test.yml` passes
`integration-tests-dir: tests/integration` to the kigu reusable workflow. Only local `pnpm test`
skips it, so a test placed there costs a manual local run, not CI coverage.

The other three premises hold. All twenty `CommitRejectedError` uses are `instanceof` or `toThrow`;
`hub-tunnel-echo.test.ts:141` builds a `createInMemoryHub()`; the restore test at
`app-lane-delivery.test.ts:604` decrypts from a restored handle but never seals from one.

## Approach

One branch, package-ordered, every test mutation-verified. No source changes unless a probe exposes
a defect.

The mutation step is not a formality bolted on at the end. It does two jobs with one command: it
proves the gap is real before a test is written, and it proves the test bites after. Two of these
five entries turned out partly stale on inspection alone, so paying one mutation per entry is
cheap.

### Per-test protocol

1. **Probe.** Mutate the source the gap names, run the package suite, confirm it stays green. Green
   means the gap is real. Red means the gap is already covered — record which test caught it and
   delete the entry instead of writing a test.
2. **Write** the test against unmutated source; confirm it passes.
3. **Re-mutate**, confirm the new test fails with a decisive message, restore, confirm green.

### Mutation targets

Named now so step 1 is not improvised.

| # | Gap | Mutation |
|---|-----|----------|
| 1 | `CommitRejectedError` payload | `throw new CommitRejectedError([], undefined)` — drop the capture |
| 2 | hub-tunnel teardown | delete `sendSessionEnd()` and the `hub.unsubscribe` call in `teardown` (`transport.ts:271,274`) |
| 3 | dispose vs commit tail | remove the `disposed` early-returns in `hub-mux.ts` (`:337,341,357`) |
| 4 | dispose vs directed `to()` | none — the probe is "does anything fail today"; `withReady` (`peer.ts:1981`) has no disposed check, so expect a defect rather than a passing guard |
| 5 | interleaved `encrypt`/`processMessage` | replace `mutexFor(this).run(async () => {…})` with a bare call in `encrypt` (`group-handle.ts:618`) |
| 6 | echo on a real hub | none — harness re-home, not an assertion gap |
| 7 | restored handle seals | seal at the pre-restore epoch secret |

### Order

mls (1, 5) → hub-tunnel (2) → rpc (3, 4) → integration (6, 7). Ascending dependency order, and it
front-loads the two entries most likely to come back "already covered" or "not observable".

## The seven contracts

### 1. `CommitRejectedError` payload

New file `packages/mls/test/commit-rejected-payload.test.ts`. `group.test.ts` is over three
thousand lines; do not grow it.

Two tests, both reaching the capture through `wrapCommitPolicy` — `group-handle.ts:816` wraps the
combined default-plus-caller callback, so both paths converge on one seam:

- **Default-on rejection.** Bob, a member, commits an Add of carol; alice rejects it. Catch the
  error and assert `proposals` holds one Add proposal and `senderLeafIndex` equals bob's leaf.
- **Caller policy.** A `commitPolicy` returning `'reject'` on an otherwise-valid admin commit. The
  same two fields asserted.

Catch with `try`/`catch` plus `expect.assertions`, not `rejects.toThrow` — the point is reading
fields off the caught object, and `toThrow` cannot do that.

### 2. hub-tunnel teardown

New file `packages/hub-tunnel/test/transport-teardown.test.ts`. `transport-lifecycle.test.ts`
covers abort and idle raising interruptions; teardown *publication* is a distinct contract and
belongs beside it, not inside it.

`FakeHub` with recording wrappers. Construct with a string `sessionID` so `lockedSessionID` is set
at construction (`transport.ts:208`) — `sendSessionEnd` returns early on a null session ID, so a
transport that has seen no traffic would otherwise publish nothing and the test would assert against
a vacuum. Then `await transport.dispose()` and assert:

- a frame published to `sendTopicID` decodes as `kind: 'session-end'` carrying the session ID;
- `hub.unsubscribe` was called with `(localDID, receiveTopicID)`.

A second test asserts the same on the abort-signal path, since `teardown()` is shared by every
path that reaches it.

### 3. dispose against a queued commit-tail rebuild

New file `packages/rpc/test/peer-dispose-race.test.ts`.

Queue an inbound Commit so a rebuild is pending, call `dispose()`, let everything settle. Assert no
`hub.subscribe` lands after dispose returned. Record subscribe calls against a `disposed` marker the
test flips after `await peer.dispose()` — a bare call count cannot distinguish "subscribed during
init" from "subscribed after teardown", which is the whole question.

### 4. dispose against an establishing directed `to()`

Same file. Call `const pending = peer.protocol('chat').to(bobDID)` before init settles, then
`await peer.dispose()`, then `await pending`.

The contract: `to()` rejects, or resolves to a client owning no live subscription. Either is
defensible and the test pins whichever the code does. The untenable outcome is a directed client
registered into a torn-down runtime, holding a mux retain nothing will release.

`withReady` (`peer.ts:1981`) awaits `ready` and has no disposed check, and `dispose()` awaits the
same promise, so the untenable outcome is the likely one. If the probe confirms it, the fix — a
`disposed` flag checked in `withReady` — lands on this branch with the test. If the fix turns out
larger than that, the test lands pinning current behaviour and the fix gets its own entry rather
than growing this branch.

### 5. Interleaved `encrypt` and `processMessage` on one `GroupHandle`

New file `packages/mls/test/handle-concurrency.test.ts`. `mutex.test.ts` covers the mutex in
isolation; nothing covers the handle that depends on it.

Fire both on one handle without awaiting between, then await both. Assert the ciphertext opens at
exactly one epoch on the peer and the handle's post-state is the committed epoch — no torn read of
`#state`.

**Named risk.** `encrypt`'s body may not await between reading `#state` and using it, in which case
removing the mutex is unobservable from outside and step 3 cannot make the test bite. If that is
what happens, the outcome is no test, recorded as "serialization not observably distinguishable at
this seam" — not a green test that proves nothing.

### 6. Echo test on the real hub

Edit `tests/integration/test/hub-tunnel-echo.test.ts` in place. Replace `createInMemoryHub()` at
:141 with `createWireHub()` from `./log-hub-over-wire.js` plus `hub.connect(identity)` per side.
Assertions unchanged — the point is the transport crossing the real hub-server wire, not new
behaviour. Needs `randomIdentity()` DIDs in place of the `'client'` and `'server'` string DIDs, and
an `await hub.dispose()` at the end.

If the test fails against the real hub, that is a finding about real-hub semantics the in-memory
double was hiding, which is the reason for the change. Triage it before touching the assertions.

### 7. A restored handle seals after a rotation it walked to

Extends the fixture at `tests/integration/test/app-lane-delivery.test.ts:604`, which already
restores bob's handle and walks it to `epoch 3n`.

After the walk, bob dispatches a chat message. Assert alice opens it and sees the text. The existing
test proves a restored handle can *decrypt* across epochs it did not itself reach; this proves it
can *seal* at the epoch it walked to.

## Verification before completion

1. `pnpm test` forced, with `Cached: 0` confirmed on every package. Cached results do not count.
2. `pnpm --filter @kumiai/integration-tests test` run manually — local `pnpm test` does not include
   it.
3. `rtk proxy pnpm run lint`.
4. Every written test mutation-verified per the protocol above; every deleted entry recorded with
   the name of the test that already covered it.
5. `docs/agents/plans/next/2026-07-07-test-gaps.md` updated: the Medium section retired, each entry
   moved to "What was verified closed and deleted" with its outcome, or moved to backlog if it
   turned into a defect fix rather than a test.

## Out of scope

- The low-priority residue in `backlog/2026-07-28-test-gaps-low.md`.
- The peer-init drain race and the other open findings in
  `backlog/2026-07-07-rpc-peer-lifecycle-hardening.md`. If entry 4 exposes the `withReady` defect,
  only that defect is fixed here.
- Any refactor of the fixtures these tests build on, beyond what a test needs to exist.
