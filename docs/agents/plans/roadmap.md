# kumiai roadmap

**Created:** 2026-07-23. **Rewritten 2026-08-01** after a triage that emptied the last phase. The
previous rewrite (2026-07-28) merged eleven docs into five and retired the audit-remediation
milestone to `archive/`.

Goals and sequencing only — each item links the doc that holds the detail.

## Where this repo is

Eleven packages. The MLS group stack is functionally built: identity and membership, the control
ledger, the commit and app lanes, the hub subsystem, group RPC, key-package provisioning, and two
contract suites that run against every implementation *and* every double. What remains is debt,
hardening, and surface.

Versions share one band — `rpc` 0.4.3, `mls-rpc` 0.4.2, eight packages at 0.4.1, and `mls-hub`
brought onto the band at 0.4.0. **22 pending intents** and nothing has shipped since the 0.4.x line;
the next release takes the whole group to 0.5.0, `mls-hub`'s first published version included.
Releases are manual by decision (2026-07-23), so that backlog is a choice rather than a stall.

**1.0 is intended but distant.** That decision shapes everything below: the pre-1.0 API milestone is
a checklist to consult when you are already opening a package's surface, not a queue to drain.

## The phased era is over

Both campaigns this roadmap was built around are closed.

- **The trust boundary (old Phase 1).** Its two actionable halves shipped. A root logger in
  `@sozai/log`'s `getDefaultConfig()` plus `hub-server`'s `onStoreError` hook closed [errors reach a
  sink](./completed/2026-07-29-errors-reach-a-sink.complete.md) (2026-07-29), including the
  last-resort slot read that returned 200 forever. [The security
  residuals](./completed/2026-07-30-security-residuals.complete.md) (2026-07-30) made
  `rpc-conformance` the documented obligation of implementing the ports, and **answered the replay
  question** the doc had been carrying: a genuine external commit, captured and re-published, steers
  nothing. What is left of this phase is not work — it is Kubun's `exportSecret` and the ahead
  storm, both below under *External dependencies*.
- **Test gaps (old Phase 2).** The one high closed 2026-07-28 — and not the way it was filed: the
  test existed and forged the right frame, but a `createFakeCrypto` generation collision killed the
  forged frame at `unwrap`, forty lines above the guard it was meant to exercise. *A negative
  assertion behind a forged frame is only as good as the forge.* [The five
  mediums](./completed/2026-07-31-close-medium-test-gaps.complete.md) closed 2026-07-31, settling
  four different ways rather than one, and disproving four premises inherited from the 2026-07-02
  audit along the way — the reason the protocol runs the mutation *before* writing the test, not
  only after.

Nothing has replaced them, and this rewrite deliberately does not invent a successor. What is open
is a short `next/` queue of unrelated items, a milestone that says to consult it rather than drain
it, and a set of things this repo cannot close alone. Naming that is more useful than grouping three
small jobs under a phase heading.

**How to pick work now:** take something from `next/`; when you open a package's surface for any
reason, check the pre-1.0 milestone for a neighbour worth bundling in the same `minor`; take an
*Ongoing* item while you are already in the file.

## What else shipped since the last roadmap

- [**The live-handle seal guard**](./completed/2026-08-01-live-handle-seal-guard.complete.md)
  (2026-08-01) — filed as "a restarted member that *authors* a commit could seal at a pre-adopt
  handle, and no test in the repo can catch it." **Premise disproved:** three mutations modelling
  the defect were each caught by tests that already existed. What shipped instead is the smaller
  true thing — the `wrap` guard, previously a side effect of two tests named for other properties,
  now stated outright, and restart-then-author running against real MLS for the first time.
- [**hub-server store-error wire shape**](./completed/2026-07-29-store-error-wire-shape.complete.md)
  (2026-07-29) — the `onStoreError` event became a method-keyed union rather than a site-keyed one,
  closing three of the four residuals the sink work left.
- [**The applied-commit digest**](./completed/2026-07-30-applied-commit-digest.complete.md)
  (2026-07-30) — `appliedByEpoch` keyed the `fork` row on *sequenceID*, so the same commit
  re-published at a new position looked like a fork and triggered a group-wide heal. Now keyed on
  the commit itself. Filed by the security-residuals analysis: a direct consequence of answering the
  replay question instead of assuming it.

## What is open

### `next/` — two items

1. [**Test-gap residuals**](./next/2026-07-31-close-medium-test-gaps-residuals.md) — two mediums in
   shipped `@kumiai/rpc`. The `replay` and `recover` post-dispose guards were shipped unverified
   (deleting both leaves the whole suite green), and `onCommitDelivery` reaches `rebuildEpoch()`
   with no disposed check at all. Items 3 and 4 are low and ride along.
2. **The version lock and `mls-hub`'s first release** — settled on
   `chore/pnpm-native-versioning`: the band is enforced by `pnpm run check:versions`, release
   management moved to pnpm's own, and `mls-hub` publishes at the band version.

### The pre-1.0 API surface — consult, do not drain

- [pre-1.0 breaking API surface](./milestones/pre-1.0-breaking-api.md)
- [non-breaking API work](./milestones/non-breaking-api.md)

Every item costs a `minor` while the packages are 0.x and a `major` after, which is the whole reason
the grouping exists — none is a correctness bug, and none has a filed consumer pushing on it. One
ordering constraint: the mls AAD parameter must land before `@kumiai/rpc` can bind its sealed bytes
to a topic context.

**A caution, first recorded 2026-07-28.** Two items said "take this with the key-package caps work,
which touches these anyway". That work shipped 2026-07-25 and took neither — `HubStore` stayed
positional (and `storeKeyPackage` *gained* a positional parameter), and `KeyPackageFetchLimits` kept
its now-inaccurate name. A "take it with the next thing that opens this file" plan only works if
whoever opens the file reads the milestone. Treat that as evidence about the mechanism, not just
about those two items.

**`@kumiai/mls-hub` is on neither milestone** — it postdates the 2026-07-20 audits, so its surface is
unexamined rather than examined and clean. Noted on the breaking milestone; no item filed, because
none has been found.

### Ongoing — pick up alongside other work

Not a phase. Each is real, none blocks anything, and every one is cheapest taken while you are
already in the file.

- [Infra debt](./backlog/2026-07-07-infra.md) — manifests, turbo graph, hooks, a missing root
  `LICENSE`, three kigu-side CI items.
- [rpc directed lane](./backlog/rpc-directed-lane.md) — one decision worth making before a durable
  hub backs that lane.
- [Blocked on ts-mls](./backlog/ts-mls-upstream.md) — three items waiting on upstream exports. Check
  all three whenever a new ts-mls lands.
- [Test gaps, low](./backlog/2026-07-28-test-gaps-low.md) and [peer test-helper
  extraction](./backlog/2026-07-30-peer-test-helper-extraction.md) — test hygiene, no behaviour at
  stake.
- [hub-server store-error residuals](./backlog/2026-07-29-hub-server-store-error-residuals.md) — one
  item, and its trigger ("a fourth call site wired") has not fired.
- The per-package hardening docs from the 2026-07-02 audit: [rpc peer
  lifecycle](./backlog/2026-07-07-rpc-peer-lifecycle-hardening.md), [rpc API
  surface](./backlog/rpc-api-surface.md), [hub-tunnel
  reliability](./backlog/2026-07-07-hub-tunnel-reliability.md), [broadcast
  robustness](./backlog/2026-07-07-broadcast-robustness.md), [mls API
  hardening](./backlog/2026-07-07-mls-api-hardening.md), [hub protocol/server
  cleanup](./backlog/2026-07-07-hub-protocol-server-cleanup.md). Their line numbers reference
  `bb343d9` and have drifted — each doc says so in its own header.

### Design questions — brainstorm before code

Three questions where the answer decides the code, not the other way round. None is a defect.

- [Roster grants and revocation](./backlog/mls-roster-grants-and-revocation.md) — what an invite may
  grant, why revocation would split the committer's Add verdict from the receiver's, and why removal
  today evicts a leaf but leaves the grant standing. **Read all three sections before designing
  revocation** — the second is the reason it is not a small change.
- [Stack-wide `Result` adoption](./backlog/2026-07-28-stack-wide-result-adoption.md) — `mls-hub` set
  the precedent; whether anything else should follow. Read what it cost before deciding.
- [Extracting the FIFO mutex to `@sozai/async`](./backlog/sozai-async-mutex-extraction.md) —
  cross-repo, worth doing when `@sozai` is next opened for other reasons.

### External dependencies

Items this repo cannot close on its own. Recorded so they stay visible, not scheduled. They are not
all blocked the same way, and the difference matters:

**Unowned.**

- **Kubun's `GroupCrypto.exportSecret`.** A host that hand-rolls it lets an evicted member keep
  reading the rotated topic. Nothing fails loudly — the group works, removals remove, the monitor
  stays quiet, and the single symptom is that the evicted member can still name and read the topic.
  The reachable half is done: `rpc-conformance` is now the documented obligation of implementing the
  ports. Kubun is not on this machine and has no owner in this repo.

**Wrong layer — the fix does not live in this codebase.**

- [**The commit-lane `ahead` storm**](./backlog/2026-07-29-commit-lane-ahead-storm.md) — one publish
  claiming a high epoch makes every honest peer heal, and since `feat/app-lane-delivery` a single
  garbage byte in the frame's version field does it with no commit bytes behind it. No signature
  check closes this: verifying an external commit needs the group context of the epoch it was framed
  at, and an ahead-framed commit is by definition at an epoch the peer holds no context for. The
  bound belongs to whoever gates publish authorization on the commit topic.
- **The `processCommit` → anchor-save window** (see [architecture](../architecture.md), stated
  residuals). Closing it needs the anchor inside the same durable write as the handle — a write that
  belongs to the host's store, which rpc cannot reach.

**Waiting on someone else's release.**

- **A stable `ts-mls` 2.0.0**, and two missing exports behind it. See the merged doc above.
- **Release automation.** Manual `pnpm release` by decision (2026-07-23). No stack repo has a
  publish workflow — kigu offers none either — so automating it is a stack-wide change.
- **Three kigu-side CI items**, in the infra doc: no turbo cache persistence, and a TS-readiness
  step running `continue-on-error: true`.

Cross-repo is **not** the same as unowned. `@sozai` and `kigu` are working directories on this
machine; the `@sozai/log` root logger was miscategorised here until 2026-07-28, when it turned out
to need a release from a repo we own rather than action from a repo we do not.

## Deleted at the 2026-07-28 triage

Kept so neither gets re-filed.

- **`backlog/hub-group-member-expiry.md`** — void. Its premise was `hub/group/join`,
  `addGroupMember`, and `removeGroupMember`; none of the three exists anywhere in `hub-protocol/src`
  or `hub-server/src`. The hub is topic-based, so there is no persisted group roster to accumulate
  ghosts in.
- **`next/2026-07-27-ciphersuite-per-call-construction.md`** — measured rather than assumed, and the
  measurement closed it. `resolveMlsContext` costs ~6µs; one `createKeyPackageBundle` costs 40ms, so
  ciphersuite construction is 0.06% of a `mint()`. The doc's premise that two async constructors made
  it non-trivial was wrong — both resolve immediately against already-loaded modules.
