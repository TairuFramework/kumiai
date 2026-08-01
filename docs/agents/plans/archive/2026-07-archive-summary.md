# 2026-07 Archive Summary

Created 2026-08-01. Twelve completed plans consolidated here, each unreferenced by `next/`,
`backlog/`, the roadmap, both milestones, and source at the time of archiving. The seventeen July
records still cited from live docs stay in `completed/`.

The retired audit-remediation milestone is a separate document —
[`2026-07-audit-remediation.md`](./2026-07-audit-remediation.md).

## Plans Completed

- **host-ledger-lane** (2026-07-13, complete — provenance only) — Kubun's original R1/R2/R3
  requirements as the first host to drive the control ledger end to end. All three were implemented
  by the control-ledger lane work two days later; this record existed to preserve where the
  requirements came from.

- **control-ledger-lane** (2026-07-15, complete) — made the control ledger deliverable and
  convergent between peers. The MLS core already treated the ledger as authoritative — a commit's
  envelope names the entries it enacts, and `foldEnvelope` refuses any commit whose entries were not
  admin-authored at their own position — but the envelope is cleartext AAD carrying ids only, so a
  receiver that had never seen an entry *body* threw `MissingLedgerEntriesError` and stalled
  permanently. The lane gets bodies from author to member, resolves concurrent commits
  deterministically, and heals a peer that fell off the group's line, without a host-side store and
  without weakening the MLS authority model. Breaking release.

- **conformance-suite-runs-against-one-implementation** (2026-07-19, closed) — `hub-conformance`
  was the contract for a hub and ran against exactly one implementation (`createMemoryStore`) while
  every peer- and tunnel-level test in the repo ran against a double. Closed on
  `feat/app-lane-delivery`: both suites now run against every implementation *and* every double.
  The principle outlived the fix — it is why the repo now treats a double answering where its real
  port refuses as the defect class to design against.

- **live-lane-read-position** (2026-07-19, closed) — the app lane had two deliverers and one read
  position, and only the drain kept it. Closed by the hub carrying a `logPosition` on every
  log-class push, so the live lane has a read position too; the `appSegmentLoaded` latch the plan
  described no longer exists and the drain dedupes by position instead.

- **app-lane-delivery** (2026-07-21, complete, PR #7) — app messages were push-only and dropped if
  nobody was listening; a member that closed the app, lost its connection, or joined late never saw
  them. Logged app events became durable and pullable, and a returning peer drains what it missed
  without the host asking. Filed as "publish `retain: 'log'`" — a one-line flag — and was not:
  app frames never went through `mux.publish` at all, flowing instead through `BroadcastClient` over
  a `BroadcastBus`. The gap between the filed shape and the real one is the record's main lesson.

- **reserved-namespace-rename** (2026-07-21, complete, PR #7) — kumiai reserved two namespaces and
  neither was named after kumiai. The `group.*` case was live rather than theoretical: an unknown
  `group.*` entry type did not get ignored, it **rejected the whole commit**, so a host defining
  `group.settings` hit a wall. Renamed to the `kumiai.` / `kumiai/` prefixes by ruling — one
  coordinated break for hosts to migrate against once. The surviving surface is documented in
  [`docs/reference/reserved-namespaces.md`](../../../reference/reserved-namespaces.md).

- **hub-receive-lifecycle** (2026-07-24, complete) — made the hub push lane deliver each frame
  exactly once, in order, with bounded memory and typed errors. From the 2026-07-02 audit finding
  set, via the audit-remediation milestone.

- **add-proposal-roster-binding** (2026-07-26, complete) — `commitInvite` refused to author a commit
  whose key package disagreed with the roster that same commit grants, but the invariant held only
  where the commit was *authored*. A receiver could not see the divergence: `defaultCommitPolicy`
  accepted any Add from an admin sender without looking at the added leaf. This closed the receive
  side, so a modified or buggy write path cannot land what the send side refuses to build.

- **key-package-codec** (2026-07-26, complete) — nothing in the stack converted an MLS `KeyPackage`
  to the `string` the hub stores, or back. `@kumiai/mls` only.

- **last-resort-keypackage** (2026-07-26, complete) — closed the residual left by the key-package
  drain hardening of 2026-07-25, which made the drain rate-bounded but left a DID whose pool ran dry
  unjoinable. Spanned `mls`, `hub-protocol`, `hub-server`, `hub-conformance`, and `hub-client`.

- **last-resort-provisioning** (2026-07-27, complete) — `@kumiai/mls` could generate a last-resort
  key package, the hub could store and serve one without consuming it, and `hub-client` could upload
  one. **Nothing decided when to do any of that**, so until a host wired it by hand no DID had one.
  This created `@kumiai/mls-hub` to own that decision — the mechanism had shipped first, and the
  policy came after.

- **ordinary-keypackage-pool** (2026-07-27, complete) — `mls-hub` kept the last-resort slot filled;
  nothing kept the ordinary pool filled, so a host that uploaded once at enrolment eventually served
  every join from its reusable last-resort package — the forward-secrecy loss the pool exists to
  prevent. Replenishment now covers both.
