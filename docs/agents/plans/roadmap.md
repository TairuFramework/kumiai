# kumiai roadmap

**Created:** 2026-07-23. Synthesized from `next/`, `backlog/`, `completed/`, the three milestone
docs, and `docs/agents/architecture.md`.

Goals and sequencing only — each phase links the docs that hold the detail.

## Where this repo is

Ten packages, all `0.4.x`. The MLS group stack is functionally built: identity and membership, the
control ledger, the commit and app lanes, the hub subsystem, group RPC, and two contract suites that
run against every implementation *and* every double. What remains is debt, hardening, and surface.

**1.0 is intended but distant.** That decision shapes the whole roadmap: the pre-1.0 API milestone
is a checklist to consult when you are already opening a package's surface, not a queue to drain.
See "Phase 4" below.

## Phase 1 — correctness debt

The oldest work in the repo. Extracted by the 2026-07-02 audit, then stalled from 2026-07-07 to
2026-07-23 behind a sequencing instruction that gated high-severity findings on medium ones.
Unblocked at the 2026-07-23 triage.

1. ~~High-severity correctness~~ — **done** (2026-07-24), see
   [completed](./completed/2026-07-24-high-severity-correctness.complete.md). `to()` gated on
   `ready`, `resync()` under the commit mutex, and the durable-ack relay reconnected across five
   severed points.
2. [`GroupAnchor.version` enforcement](./next/2026-07-23-group-anchor-version-enforcement.md) —
   small, and ship-before-needed: the cost of deferring grows with every release that goes out
   without it.
3. [Hub `receive` lifecycle](./next/2026-07-07-hub-receive-lifecycle.md) — duplicate and unordered
   delivery, leaked handlers, swallowed writes.
4. [Anycast soundness](./next/2026-07-07-anycast-soundness.md) — success-only suppression. One fast
   *failing* responder currently suppresses every healthy one.

Two of these sit **underneath** work that already shipped on top of them: the retention semantics in
`5eb220a` define mailbox reclamation in terms of acks that nothing sends. That inversion is why this
phase leads.

## Phase 2 — hardening and the trust boundary

1. [Key-package + subscribe caps](./next/2026-07-07-hub-keypackage-subscribe-caps.md) — Sybil
   key-package drain, upload quotas, rate-limit hygiene. DoS class, no confidentiality impact.
2. [External-commit amplification](./next/2026-07-18-external-commit-amplification.md) — what the
   committer signature check did not close.
3. [Exporter secret surface](./next/2026-07-16-exporter-secret-surface.md) — the only item in the
   portfolio with a **live security consequence outside this repo**. A host that hand-rolls
   `GroupCrypto.exportSecret` lets an evicted member keep reading the rotated topic. Nothing fails
   loudly; the group works, removals remove, the monitor stays quiet. The single symptom is that the
   evicted member can still name and read the topic.

   The seam is watched only from inside this repo. The actionable half is making
   `rpc-conformance` the **documented obligation** of implementing the ports, so a host writing its
   own `GroupCrypto` is told where it is writing it that the suite is not optional. See "External
   dependencies" for the half that is not actionable here.

## Phase 3 — test gaps

[Close test gaps](./next/2026-07-07-test-gaps.md) — persist→restore path, real-hub integration,
concurrency tests. Deliberately after Phases 1–2 rather than alongside: most of its listed hooks
are regression guards for defects those phases fix, so writing them first means writing them twice.

Phases 1 and 2 each carry their own test obligations regardless; this is the residue.

## Phase 4 — pre-1.0 API surface

Consult, do not drain. Every item costs a `minor` while the packages are 0.x and a `major` after,
which is the whole reason the grouping exists — none is a correctness bug, and none has a filed
consumer pushing on it.

- [pre-1.0 breaking API surface](./milestones/pre-1.0-breaking-api.md)
- [non-breaking API work](./milestones/non-breaking-api.md)

**How to use it:** when you are already breaking a package's surface for a filed reason, check the
milestone for a neighbour worth taking in the same `minor`. Bundling is nearly free; a second break
later is not. One ordering constraint exists — the mls AAD parameter must land before `@kumiai/rpc`
can bind its sealed bytes to a topic context.

The non-breaking milestone has one item that does *not* wait: `GroupAnchor.version` enforcement,
already scheduled in Phase 1.

## Ongoing infrastructure

[Infra batch](./next/2026-07-07-infra-batch.md) and
[infra cleanup](./backlog/2026-07-07-infra-cleanup.md) — mechanical, land opportunistically rather
than as a phase. Nothing here blocks development. The batch's two highest-priority findings were
retired on 2026-07-23: CI lint was never actually broken, and releases stay manual by decision.

## External dependencies

Items this repo cannot close on its own. Recorded so they stay visible, not scheduled.

- **Kubun's `GroupCrypto.exportSecret`.** The concrete instance behind Phase 2's third item. If
  Kubun already delegates to `@kumiai/mls-rpc`, that work is prevention; if it hand-rolls one, it is
  live and security-relevant. Kubun is not on this machine and has no owner in this repo.
- **`['kumiai']` log records reaching a sink**
  ([logging-reaches-a-sink](./next/2026-07-19-logging-reaches-a-sink.md)). An app calling
  `@sozai/log`'s `setup()` with no argument configures logging that routes nothing under
  `['kumiai']`, so the console fallback stays out of the way and the record is dropped — the peer
  goes silently deaf through the most ordinary setup an app can perform. Every candidate fix is a
  `sozai`-level or logtape-level decision, not `hub-mux`'s.
- **Release automation.** Manual `changeset publish` by decision (2026-07-23). No stack repo has a
  publish workflow — kigu offers none either — so automating it is a stack-wide change if it is ever
  wanted.

## Not on this roadmap

`backlog/` holds fourteen items behind the four above: per-package hardening docs from the same
2026-07-02 audit, four relocated from enkaku at the 0.18 split, and the API-surface docs Phase 4
indexes. Promote at triage, not from here.

One backlog item is recorded as **stale**: `mls-capability-revocation.md`'s premise was closed by the
permission-enforcement work — a removed member has no leaf, so a resync is refused outright, and the
capability layer it proposed to revoke no longer exists.
