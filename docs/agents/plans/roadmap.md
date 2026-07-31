# kumiai roadmap

**Created:** 2026-07-23. **Rewritten 2026-07-28** after a triage that merged eleven docs into five,
deleted one whose premise was void, and retired the audit-remediation milestone to `archive/`.

Goals and sequencing only — each phase links the docs that hold the detail.

## Where this repo is

Ten packages, all `0.4.x`. The MLS group stack is functionally built: identity and membership, the
control ledger, the commit and app lanes, the hub subsystem, group RPC, key-package provisioning, and
two contract suites that run against every implementation *and* every double. What remains is debt,
hardening, and surface.

**1.0 is intended but distant.** That decision shapes the whole roadmap: the pre-1.0 API milestone is
a checklist to consult when you are already opening a package's surface, not a queue to drain. See
"Phase 3" below.

`next/` holds three items. That is deliberate — the 2026-07-28 triage demoted everything whose own
header said "low", "design question", or "latent", so what is left is work with a home in this repo
and a reason to do it now.

## What shipped since the last roadmap

The 2026-07-23 roadmap's Phases 1 and 2 are **complete**, and a workstream that did not exist when it
was written shipped alongside them.

- **Correctness debt (old Phase 1)** — all four items landed 2026-07-24: high-severity correctness,
  `GroupAnchor.version` enforcement, the hub `receive` lifecycle, and anycast soundness.
- **Hardening (old Phase 2, item 1)** — [key-package + subscribe
  caps](./completed/2026-07-25-hub-keypackage-subscribe-caps.complete.md), 2026-07-25.
- **Key-package provisioning** — seven completions across 2026-07-26 to 2026-07-28, none of them on
  any roadmap: [invite recipient
  binding](./completed/2026-07-26-bind-keypackage-recipient.complete.md), [the Add-proposal roster
  binding](./completed/2026-07-26-add-proposal-roster-binding.complete.md), [the key-package
  codec](./completed/2026-07-26-key-package-codec.complete.md), [last-resort key
  packages](./completed/2026-07-26-last-resort-keypackage.complete.md) and [their automatic
  provisioning](./completed/2026-07-27-last-resort-provisioning.complete.md), [the ordinary
  pool](./completed/2026-07-27-ordinary-keypackage-pool.complete.md), and [retryable provisioning
  results](./completed/2026-07-28-provisioning-retryable-result.complete.md). `@kumiai/mls-hub` is
  now a real package with a real surface, and it is the only one in the repo returning `Result`.

The audit-remediation milestone that sequenced the first two groups reached 7 of 8 and was
[retired](./archive/2026-07-audit-remediation.md). Its last open item is Phase 2's test gaps below.

## Phase 1 — the trust boundary

The only phase with a live security consequence. Two docs, both partly unclosable from inside this
repo, which is the point of having them written down.

1. [Security residuals](./next/2026-07-16-security-residuals.md) — merged 2026-07-28 from the
   exporter-secret and external-commit docs. Two sections:
   - **A host that hand-rolls `GroupCrypto.exportSecret`** lets an evicted member keep reading the
     rotated topic. Nothing fails loudly; the group works, removals remove, the monitor stays quiet.
     The single symptom is that the evicted member can still name and read the topic. The actionable
     half is making `rpc-conformance` the **documented obligation** of implementing the ports.
   - **The commit-lane `ahead` storm**, which no signature check can close — the bound belongs to
     whoever gates publish authorization on the commit topic. Plus one open question worth an
     afternoon: whether a replayed genuine external commit can steer anything once the group has
     moved on. It was never tested, and "plausible" is not a security property.
2. **Errors reach a sink** — **done 2026-07-29**, summary at
   [`completed/2026-07-29-errors-reach-a-sink.complete.md`](./completed/2026-07-29-errors-reach-a-sink.complete.md).
   Both halves of the retired `logging-reaches-a-sink` doc are closed: a root logger in
   `@sozai/log`'s `getDefaultConfig()` (released as 0.3.0) means rpc's reports no longer vanish into
   a default `setup()` that routes them nowhere, and `hub-server` gained an `onStoreError` hook at
   the three sites where a store failure is deliberately not a request failure — including the
   last-resort slot read that returned 200 forever. Residuals in
   [`backlog/2026-07-29-hub-server-store-error-residuals.md`](./backlog/2026-07-29-hub-server-store-error-residuals.md).

## Phase 2 — test gaps

[Close test gaps](./completed/2026-07-07-test-gaps.complete.md), re-verified against source 2026-07-28: nine of its
original entries had been closed by later work, two carried stale line numbers, and the low-priority
residue moved to [backlog](./backlog/2026-07-28-test-gaps-low.md).

Its one high entry — the app-lane drain's **retention guard surviving deletion with the whole rpc
suite green** — was **closed 2026-07-28**, and not the way it was filed. The test existed and forged
the right frame; it was neutralised by a `createFakeCrypto` generation collision that killed the
forged frame at `unwrap`, forty lines above the guard. One line and a comment in the fixture setup;
the test now fails on the mutation. See the doc for the general shape, which is the part worth
keeping: *a negative assertion behind a forged frame is only as good as the forge*.

Its five mediums are **done 2026-07-31**, summary at
[`completed/2026-07-31-close-medium-test-gaps.complete.md`](./completed/2026-07-31-close-medium-test-gaps.complete.md).
They settled four ways, not one: two closed by mutation-verified tests, one voided against a test
that had landed 2026-07-12, one closed by a test plus a shipped `@kumiai/rpc` fix (a disposed peer
now refuses every host call instead of handing back a client over an aborted transport), and one
settled as not-isolable with no test written. Four premises inherited from the 2026-07-02 audit were
disproved by probes along the way — the reason the protocol runs the mutation *before* writing the
test, not only after. Residuals in
[`backlog/2026-07-31-close-medium-test-gaps-residuals.md`](./backlog/2026-07-31-close-medium-test-gaps-residuals.md);
the one genuinely new gap it surfaced is
[`backlog/2026-07-31-mls-rpc-author-path-stale-handle-reseal.md`](./backlog/2026-07-31-mls-rpc-author-path-stale-handle-reseal.md).

Phase 2 is closed. Nothing remains in `next/`.

## Phase 3 — pre-1.0 API surface

Consult, do not drain. Every item costs a `minor` while the packages are 0.x and a `major` after,
which is the whole reason the grouping exists — none is a correctness bug, and none has a filed
consumer pushing on it.

- [pre-1.0 breaking API surface](./milestones/pre-1.0-breaking-api.md)
- [non-breaking API work](./milestones/non-breaking-api.md)

**How to use it:** when you are already breaking a package's surface for a filed reason, check the
milestone for a neighbour worth taking in the same `minor`. Bundling is nearly free; a second break
later is not. One ordering constraint exists — the mls AAD parameter must land before `@kumiai/rpc`
can bind its sealed bytes to a topic context.

**A caution added 2026-07-28.** Two items on that milestone said "take this with the key-package caps
work, which touches these anyway". That work shipped 2026-07-25 and took neither — `HubStore` stayed
positional (and `storeKeyPackage` *gained* a positional parameter), and `KeyPackageFetchLimits` kept
its now-inaccurate name. A "take it with the next thing that opens this file" plan only works if
whoever opens the file reads the milestone. Treat that as evidence about the mechanism, not just
about those two items.

## Ongoing — pick up alongside other work

Not a phase. Each is real, none blocks anything, and every one is cheapest taken while you are
already in the file.

- [Infra debt](./backlog/2026-07-07-infra.md) — merged 2026-07-28 from the batch and cleanup docs.
  Manifests, turbo graph, hooks, a missing root `LICENSE`, three kigu-side CI items.
- [rpc directed lane](./backlog/rpc-directed-lane.md) — merged 2026-07-28; carries one decision worth
  making before a durable hub backs that lane.
- [Blocked on ts-mls](./backlog/ts-mls-upstream.md) — merged 2026-07-28. Three items waiting on
  upstream exports: the stable v2 pin, the `decryptSenderData` reimplementation, and peer4 leaf
  rotation. Check all three whenever a new ts-mls lands.
- The per-package hardening docs from the 2026-07-02 audit: [rpc peer
  lifecycle](./backlog/2026-07-07-rpc-peer-lifecycle-hardening.md), [rpc API
  surface](./backlog/rpc-api-surface.md), [hub-tunnel
  reliability](./backlog/2026-07-07-hub-tunnel-reliability.md), [broadcast
  robustness](./backlog/2026-07-07-broadcast-robustness.md), [mls API
  hardening](./backlog/2026-07-07-mls-api-hardening.md), [hub protocol/server
  cleanup](./backlog/2026-07-07-hub-protocol-server-cleanup.md).

## Design questions — brainstorm before code

Three questions where the answer decides the code, not the other way round. None is a defect.

- [Roster grants and revocation](./backlog/mls-roster-grants-and-revocation.md) — merged 2026-07-28
  from three docs that were one subject. What an invite may grant, why revocation would split the
  committer's Add verdict from the receiver's, and why removal today evicts a leaf but leaves the
  grant standing. **Read all three sections before designing revocation** — the second is the reason
  it is not a small change.
- [Stack-wide `Result` adoption](./backlog/2026-07-28-stack-wide-result-adoption.md) — `mls-hub` set
  the precedent; whether anything else should follow. Read what it cost before deciding.
- [Extracting the FIFO mutex to
  `@sozai/async`](./backlog/sozai-async-mutex-extraction.md) — cross-repo, worth doing when `@sozai`
  is next opened for other reasons.

## External dependencies

Items this repo cannot close on its own. Recorded so they stay visible, not scheduled.

- **Kubun's `GroupCrypto.exportSecret`.** The concrete instance behind Phase 1's first item. If Kubun
  already delegates to `@kumiai/mls-rpc`, that work is prevention; if it hand-rolls one, it is live
  and security-relevant. Kubun is not on this machine and has no owner in this repo.
- ~~**`['kumiai']` log records reaching a sink.**~~ **Not an external dependency after all**
  (2026-07-28). The fix is a root logger in `@sozai/log`'s `getDefaultConfig()`, and `@sozai` is a
  working directory on this machine. It is a cross-repo *release* dependency, not an unowned one —
  see Phase 1. Recorded because "blocked on another repo" and "needs a release from another repo"
  were being treated as the same thing.
- **A stable `ts-mls` 2.0.0**, and two missing exports behind it. See the merged doc above.
- **Release automation.** Manual `changeset publish` by decision (2026-07-23). No stack repo has a
  publish workflow — kigu offers none either — so automating it is a stack-wide change.

## Deleted at the 2026-07-28 triage

- **`backlog/hub-group-member-expiry.md`** — void. Its premise was `hub/group/join`,
  `addGroupMember`, and `removeGroupMember`; none of the three exists anywhere in `hub-protocol/src`
  or `hub-server/src`. The hub is topic-based, so there is no persisted group roster to accumulate
  ghosts in.
- **`next/2026-07-27-ciphersuite-per-call-construction.md`** — measured rather than assumed, and the
  measurement closed it. `resolveMlsContext` costs ~6µs; one `createKeyPackageBundle` costs 40ms, so
  ciphersuite construction is 0.06% of a `mint()`. The doc's premise that two async constructors made
  it non-trivial was wrong — both resolve immediately against already-loaded modules.
