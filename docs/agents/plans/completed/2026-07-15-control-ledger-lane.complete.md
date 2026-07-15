# Control-ledger lane — complete

**Status:** complete. Shipped on `feat/control-ledger-lane`.
**Implements:** the host requirements in [2026-07-13-host-ledger-lane.complete.md](./2026-07-13-host-ledger-lane.complete.md) (R1/R2/R3), the gaps Kubun hit as the first host to drive the control ledger end to end.

## Goal

Make the control ledger deliverable and convergent between peers: get an entry *body* from its author to
every member, let concurrent commits resolve deterministically, and let a peer that fell off the group's
line heal — all without a host-side store and without weakening the MLS authority model.

## What was built

Three design decisions, each with the crypto and the failure-mode hardening a real host needs:

**D1 — the commit topic is a compare-and-set log.** Commits publish to a single serialized lane keyed by
the group's lifelong recovery secret, CAS'd against the log head (`expectedHead`/`HeadMismatchError`). A
peer pulls the log to convergence and is woken by a live push; the lane is a mutex never re-entered, with
journal-replay at step 0 of every operation so a peer that crashed on its own commit heals from it instead
of adopting it. Concurrent commits fork deterministically: the loser rejoins the winner and re-enacts only
the entries the winner never had. A peer with positive evidence it is off the line (its own un-merged
commit, a frame framed ahead of it, or the losing side of a fork) is **stranded** and refuses to commit
until a rejoin lands — refusing on positive evidence only, never on suspicion, so a body-less "poison"
frame the whole group steps over never wedges it.

**D2 — recovery seals GroupInfo to a requester-minted ephemeral key, authorized by the roster.** A stranded
peer publishes a signed request carrying a per-request ephemeral HPKE public key; a member seals the
group's GroupInfo to that key and rejoins the peer by external commit. HPKE base mode authenticates no
responder, so the reply also carries a **membership attestation** the responder signs and binds to the
group, the request, and a digest of the exact GroupInfo bytes — the requester refuses any reply whose
signer holds no leaf in its own last-known tree, and any GroupInfo whose group id or immutable genesis
anchor differs. Without that attestation an observer of the public rendezvous could seal a forged GroupInfo
and hijack a peer.

**D3 — entry bodies ride in the commit frame, no host store.** The commit frame carries the bodies sealed
under the epoch secret the commit is framed at; a receiver resolves them from the frame, never from a host
callback. A rejoined peer whose ledger is empty against a live head (a roster reset — every admin promoted
since genesis is invisible) gathers the whole ordered ledger over the same rendezvous, head-verified before
a single entry is folded, sealed to its ephemeral key. A ledger gather is epoch-independent (the peer that
most needs it may be at an older epoch than every responder), which is why it is HPKE to an ephemeral key
and not the epoch secret.

## Hardening (branch review, all findings closed)

A multi-reviewer pass surfaced four Criticals and a long tail of Importants/Minors, all closed with tests
that distinguish the correct behaviour from the plausible-wrong one:

- The recovery reply was authenticated only in the request direction (the seal authenticated *who may
  receive*, not *who sealed* or *which group's data*) — closed by the D2 attestation and by making
  `sealLedger` read the ledger from its own handle rather than a caller parameter.
- A failed heal cleared the stale-epoch commit gate and a peer raced the head onto a private branch; a
  `dispose()` during an in-flight heal hung the lane. Both fixed (`stranded` flag, drain the recovery
  waiters before clearing timers).
- The hub-protocol conformance suite had holes a plausible SQL host walks through (derived `head`,
  `unsubscribe` as a deleter, the `retain: mailbox` default, trim/depth counting mailbox frames) plus two
  real `memoryStore` bugs — the suite is the deliverable a host implements, now 24 clauses.
- A mailbox lane could silently lose a CAS through a tunnel wrapper, and a deduped publish was re-fanned to
  every subscriber. Fixed by splitting the publish param types so a mailbox lane cannot represent a
  conditional publish, and returning `{ sequenceID, deduped }`.
- `commit()`/`replay()` discarded the ledger-completeness refusal `recover()` honors, so a peer could
  commit against a roster-reset handle — `commit()` now throws `RecoveryRequiredError` (a return means the
  commit landed; a silent return of unbuilt work would be a false success).

## Status and release position for Kubun

Complete, reviewed, full suite green. **This is a breaking release for Kubun.** Packages needing a
breaking (pre-1.0 = MINOR) bump: **rpc** (the `GroupMLS` port gains eight methods and retypes
`applyRecovery`; `GroupPeer`/`GroupPeerParams` change; the in-memory `createMemoryGroupMLS` is removed to
test fixtures; handshake topic split into commit + rendezvous; recovery codecs retyped), **hub-protocol**
(the `HubStore` port: `publish` returns `PublishResult`, `subscribe` takes `SubscribeParams`, new
`fetchTopic`/`trim`), **hub-tunnel** (`HubLike*` → `MailboxHub*`; new `LogHub`), and **hub-server** (index
unchanged but must move in lockstep with the new `HubStore` contract). **mls** gained symbols only — a
non-breaking feature MINOR despite the `GroupMLS`-port auth redesign it enables.

## Key invariants a maintainer must not break

- The journal is replayed before the pull in *every* lane operation, or a peer that crashed on its own
  commit adopts it instead of healing from it.
- `stranded` (the commit gate) fires on positive evidence of being behind, never on poison — gating on
  poison rebuilds the group-death hazard where one unresolvable frame kills the group permanently.
- App-topic derivation uses the *per-epoch* secret; the commit/rendezvous topics use the *lifelong*
  recovery secret. A removed member can follow the control plane for life (accepted) but is cut off from
  the data plane by forward secrecy.

## Follow-on

App-lane delivery — a member cannot receive app traffic from an epoch it slept through — is a real,
separate bug (it predates this work). Design approved; tracked in
[2026-07-15-app-lane-delivery.md](../next/2026-07-15-app-lane-delivery.md). It is **additive to rpc** (a
later non-breaking MINOR), so it does not gate this release.
