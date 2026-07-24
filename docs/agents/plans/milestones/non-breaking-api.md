# Milestone: non-breaking API work

**Origin:** the same four API-surface audits of 2026-07-20 that produced
[pre-1.0 breaking API surface](./pre-1.0-breaking-api.md), plus the final whole-change review of
`feat/app-lane-delivery`. Filed at the 2026-07-23 triage.

Peer to that milestone on the other side of one axis: **what a change costs to take**. Everything
here can land in any release without breaking a consumer, so none of it is racing 1.0.

That makes this the short list — most API-shape debt breaks something. It is worth keeping separate
anyway, because "no version deadline" is exactly the property that lets these be picked up as
filler alongside unrelated work, and because one of them has a deadline of a different kind.

## Index

### Ship-before-needed — has its own urgency

- **~~`GroupAnchor.version` enforcement~~** — **shipped 2026-07-24**, see
  [completed](../completed/2026-07-24-group-anchor-version-enforcement.complete.md). Enforcing the
  version was non-breaking (`CURRENT_VERSION` is the only writer, so nothing in the wild carries
  another value), but *deferring* it was the "degraded" class from the forward-compatibility work: a
  later fix would forever carry a sniffing rule for the unversioned era, and a build that tolerates
  unknown versions silently cannot be taught to stop. It was the one remaining format in the repo
  where a version was declared and never checked. `decodeGroupAnchor` now withholds `app` from a
  future-version anchor while the member still joins (accept-and-withhold over fail-closed).

  Shipped ahead of its "next release that ships" deadline.

### Ordinary debt — no deadline

- **[`deriveTopicID` NUL-injectivity](../backlog/2026-07-07-broadcast-robustness.md)** — non-breaking
  *if fixed by rejection*. Rejecting NUL in `label`/`scope` closes the hole and preserves every
  already-derived topic ID, because no current caller passes one. Re-encoding the HKDF `info` is the
  more principled fix and rotates every existing topic ID — a data break. The choice of fix is what
  decides which milestone this belongs to; it is filed here on the assumption of rejection.

  Unreachable today regardless: every caller passes a fixed, code-controlled label and scope. It
  stays unreachable only while no caller derives a topic from untrusted input.

- **[The `0xf102` hatch reads wider than it opens](../backlog/2026-07-07-mls-api-hardening.md)** —
  a documentation correction, no code change required. The reserved third control extension type can
  be *installed* into a live group without re-admitting members, but only empty: the guard at
  `packages/mls/src/policy.ts:99-118` admits the added entry only when it is not already installed,
  the list grew by exactly one, and its `extensionData` is a zero-length `Uint8Array` — then strips
  it before the positional compare. Populating it is still a policy change every peer must
  ship before any peer can commit it. The changeset's "escape hatches with a closing window" framing
  invites the stronger read, so the narrower truth should be stated at the reservation itself.

## Checked and dropped

- **Hub port types moving out of `hub-tunnel`** — listed here and on
  [pre-1.0 breaking API surface](./pre-1.0-breaking-api.md) on 2026-07-23 pending a structural
  check, since a package-boundary move is non-breaking only if the moved types are structurally
  identical. The check found the premise false: `@kumiai/hub-protocol` declares none of
  `HubBase`/`MailboxHub`/`LogHub`/`HubReceiveSubscription`/`HubPublishParams`, so there is nothing
  to move them to. They are hub-tunnel's own port and already the shared one — `@kumiai/rpc` imports
  them from `@kumiai/hub-tunnel`, and `@kumiai/hub-conformance` re-declares structural subsets by
  design. The three data types the packages do share (`HubPublishParams`, `HubFetchTopicParams`,
  `HubFetchTopicResult`) are structurally identical to their hub-protocol counterparts.

  Full reasoning in
  [hub protocol/server cleanup](../backlog/2026-07-07-hub-protocol-server-cleanup.md). The one real
  defect it turned up — `LogHub.publish` typed narrower than `HubStore.publish`, dropping `deduped`
  — is breaking, and moved to the other milestone.

## Exit criteria

- `GroupAnchor.version` enforced, in the next release that ships.
- The other items closed, or moved to the breaking milestone if their chosen fix turns out to
  break something.

No 1.0 gate — an item still open here at 1.0 is not a failure.
