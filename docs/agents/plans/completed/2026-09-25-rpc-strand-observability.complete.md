# Expose commit strand and recovery lifecycle to the host — complete

**Date:** 2026-09-25
**Status:** complete
**Packages:** `@kumiai/rpc` (patch intent, additive API; ships in the 0.10 band release with the
`rosterEntries` break already on main)
**Origin:** Kubun `GroupHealthMonitor`, which inferred strand and recovery state by counting
`epoch-stale` signals, and which also calls `GroupPeer.recover()` itself.

## Goal

Tell the host, once per stranded episode, why the commit lane decided this peer is stranded and how
strong that evidence is; tell it when a recovery attempt starts and how it ends; make automatic healing
and consumer `recover()` single-flight with one owner for re-enact entries. A host observer never changes
the commit walk or the recovery outcome.

## What was built

- **`onStrand(observation)`** on `GroupPeerParams`: `groupID`, `position`, `commitDigest`, `localEpoch`,
  `claimedEpoch`, `kind`, `confidence`. Fires once per **episode** (first strand until `succeeded` or
  `bootstrapped`); a second observation fires only on strictly stronger confidence.
- **Confidence levels**, stated against the malicious-hub model (read, drop, reorder, inject, lie):
  - `own-unmerged` / `authenticated`: PrivateMessage sender data, opened with this epoch's sender-data
    secret, names this device's leaf. Proves this device sealed a commit at this epoch that the hub now
    places in the log. Commit content and hub acceptance are **not** verified: a hub can alter
    ciphertext past the sampled prefix of a captured frame, including one whose publish it rejected.
  - `fork-losing` / `observed`: different commit bytes at an epoch this peer enacted; the other commit is
    unauthenticated and the tiebreak position is the hub's.
  - `ahead` and `unknown-version` / `claimed`: cleartext epoch or unreadable frame, forgeable by any
    commit-topic publisher.
- **`onRecovery(event)`**: `started`, then exactly one `succeeded` or `failed` (`no-responder`,
  `bootstrap-failed`, `deadline`, `disposed`, `error`), plus a later `bootstrapped` (same `attemptID`)
  when a rejoin's bootstrap completes after its attempt ended. Every event carries `attemptID` and
  `trigger` (`automatic` | `consumer`).
- **Lane-safe delivery**: notices queue in a host outbox flushed after the producing `runSerial`
  operation settles; throws and rejections are swallowed.
- **Single-flight recovery**: `activeRecovery` is installed before the first await and cleared before
  terminal notices flush, so a joiner shares the running attempt and a retry from a terminal observer
  starts a new one. Bodies stay serialized.
- **One owner for re-enact entries**: the `pendingReenact` stash, drained by `recover()`, `commit()`
  and `replay()` alike, so `recover()` may return entries an earlier automatic heal left. Nothing is
  handed out twice.
- **Behaviour changes, documented in the changeset**: a failed rendezvous publish now rejects
  `recover()` instead of silently waiting out the deadline (typed `RendezvousOutcome`); an unsupported
  handshake version is classified before its kind, so a future-version frame with an unknown kind heals
  instead of being dropped as malformed.

## Key decisions

- **Episodes, not per-frame events**: one strand is one observation, so a health monitor maps it
  directly instead of counting.
- **Ownership follows observed adoption.** Once the rejoin's handle is adopted (detected by the epoch
  change, not by whether `onAccepted` resolved, because the real adapter adopts and then persists), the
  snapshot moves to `awaitingBootstrap`, the enacted commit is recorded in `appliedByEpoch`, and the
  strand gate lifts. A later lane bootstrap repairs any skipped anchor capture or epoch rebuild before
  it emits `bootstrapped`. Before adoption, the snapshot stays with the retry, and each attempt unions
  it with the current ledger.
- **The ledger gather owns the lane until its writes finish**: a reply may not touch the handle after
  the gather settles; a gather does not resolve while a `bootstrapLedger` is in flight and then reports
  the real outcome; dispose settles gathers promptly and a disposed peer never finalizes a bootstrap.

## Verification

Forced gate (`Cached: 0`) and the integration suite green; rpc 514 unit tests. The branch went through
five blind Codex reviews. Every finding was fixed test-first and mutation-checked (the guard removed, the
test confirmed failing, the guard restored): lost re-enact entries after a landed rejoin, persist
failure after adoption, a stale-snapshot retry, observer retries joining a finished attempt, a missed
fork after adoption, stale ledger replies writing to the handle, slow disposal of ledger gathers, and a
post-disposal `bootstrapped`.

## Follow-on

- `docs/agents/plans/backlog/2026-09-25-mls-rpc-persist-after-mutate.md`: the adapter mutates the
  handle before persisting, so a failed persist leaves memory ahead of storage.
- Kubun adoption is Kubun-side work, tracked in Kubun's `next/`.
