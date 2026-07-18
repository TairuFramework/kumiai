# Probe brief — a refused subscribe is swallowed, and the default retention sits exactly on the cap

Implementation probe in `/Users/paul/dev/yulsi/kumiai`, branch `feat/app-lane-delivery`. Do NOT switch
branches, do NOT commit. Leave changes uncommitted.

**Never run `git checkout`, `git restore`, or `git stash` on a file with uncommitted work.**

## The defect

`packages/rpc/src/hub-mux.ts:112-116`:

```ts
const next = (refcount.get(topicID) ?? 0) + 1
refcount.set(topicID, next)
if (next === 1) void Promise.resolve(hub.subscribe(localDID, topicID, options)).catch(() => {})
```

The refcount is bumped **before** the subscribe and the rejection is swallowed. Commit and app topics
are retained for the peer's whole life and never released (`hub-mux.ts:96-102`), so the count never
returns to zero and **the subscribe is never retried**.

The hub gates topic pulls on the caller's own subscription (`memoryStore.ts:310-315`), so every later
`fetchTopic` throws `NotSubscribedError` forever. The commit lane's seed swallows that too
(`peer.ts:1543`) and `loadAppSegment` raises into swallowing callers. **Net: a peer that never applies a
commit and never delivers an app frame, reporting no error anywhere.**

**Why it is live, not theoretical.** The real hub **refuses** a retention above its ceiling rather than
clamping — stated at `hub-tunnel/src/transport.ts:77-81`, thrown at `memoryStore.ts:391-397`, asserted by
the conformance suite. This branch added the only retention-carrying subscribes (`peer.ts:501`,
`peer.ts:959`), `appLogRetentionSeconds` is host-settable, and the default (30 days, `2_592_000`) sits
**exactly on** `DEFAULT_MAX_RETENTION` (`memoryStore.ts:52`). One second more from a host, or one
operator with a tighter cap, and the peer silently stops working.

**No double can produce this.** Every hub double's `subscribe` is infallible: `fake-hub.ts:135-143`,
`durable-fake-hub.ts:45-52`, `hub-tunnel/test/fixtures/fake-hub.ts:64-70`.

## Approved approach (follow it; BLOCKED if it fights the code — do not redesign)

1. **A failed subscribe must not leave a phantom refcount.** Bump only on success, or roll back on
   failure — a topic the hub refused is not a topic this peer is subscribed to, and the data structure
   must not claim otherwise.
2. **A failed subscribe must be visible.** Decide the surface and argue it: a retry with backoff, a host
   callback, or raising into the caller. The requirement is that a peer whose subscribe was refused
   **cannot report itself healthy**. Whatever you choose, a permanent refusal (`RetentionExceededError`
   is permanent — retrying it forever is a busy loop against a settled answer) must reach the host, and
   a transient one must be retried.
3. **Make the doubles able to refuse.** Give the hub doubles a fallible `subscribe` that enforces a
   retention ceiling the way the real store does. This is the finding that hid it, and leaving the
   doubles infallible means the next such defect hides too.
4. **The default must not sit on the ceiling.** Move rpc's default below `DEFAULT_MAX_RETENTION`, or
   make the relationship explicit and tested so the two cannot drift into equality unnoticed. Say which
   and why. Both defaults are documented as "aligned by choice" (`docs/agents/architecture.md`) — if you
   move one, address the other and the doc.

## Done when (all required)

1. **A refused subscribe is not silent.** A peer whose subscribe the hub refuses surfaces it; assert on
   the host-visible surface, not on internal state. Must fail against today's code.
2. **No phantom refcount.** After a refusal, a later retain of the same topic tries the subscribe again
   rather than assuming it is already held.
3. **A transient failure recovers**; a permanent refusal does not spin.
4. **The doubles refuse what the hub refuses** — a retention above the ceiling fails in the rpc suite.
5. **Mutation checks (required, paste each):** restore the swallow → (1) goes red; make the doubles
   infallible again → (4) goes red. Invert by hand.
6. Whole suite green (rpc, mls, 30/30 turbo). Do not weaken an existing test.

## Note

`docs/agents/plans/next/2026-07-16-mux-swallows-subscribe-failure.md` filed this earlier with less
evidence. Fold it in and delete the file. The architecture doc's footgun note about this
(`docs/agents/architecture.md`, retention section) must be updated to describe the fixed behaviour.

The audit's structural point is worth acting on if it is cheap: `@kumiai/hub-conformance` runs against
exactly one implementation, so the three doubles the rpc and tunnel suites actually run against are
checked by nothing. If pointing the conformance suite at them is more than a small change, file it
instead.

## Scope boundary

`hub-mux.ts`, the retention defaults, the hub doubles, and their tests ONLY. **Out of scope:**
`classify.ts`, `readCommitHeader`, the app-lane drain's ceiling/stall logic, and anything under
`packages/hub-tunnel/` (two other probes are working those concurrently).

## Conventions

`kigu:conventions` + repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`; capital
`ID`; `#fields`; never edit `lib/`.

## Verify (repo root, paste real output)

`pnpm run build && rtk proxy pnpm run lint && pnpm test`

## Report contract

Full report → `docs/superpowers/probes/sec-2-report.md`. Return ONLY: status, uncommitted-changes note,
one-line test summary, concerns. No full diff.
