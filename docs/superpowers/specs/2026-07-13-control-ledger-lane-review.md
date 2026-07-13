# Review: the control-ledger lane design

**Reviewer:** kubun (the host driving the requirements in `2026-07-13-host-ledger-lane.md`).
**Subject:** `2026-07-13-control-ledger-lane-design.md`.
**Verdict:** the design answers R1/R2/R3. D3 is a better answer than the requirement asked for — bundling bodies in the commit frame under the pre-commit epoch secret makes first-delivery stranding impossible by construction and removes the host body store entirely. D1's honesty about CAS (not a soundness guarantee; heal is the floor a byzantine hub forces) is the right framing.

Four gaps. G1 blocks implementation.

## G1 — A fresh member cannot form its first CAS

D1 defines `expectedHead` as "the `sequenceID` of the last commit **this peer applied**".

A member that joined by Welcome has applied *no* commit from `commitTopic`. The commits that built the group predate its membership and sit at epochs it cannot process. Its `appliedHead` is therefore undefined, and its first commit has no legal `expectedHead`:

- the empty-topic sentinel is wrong — the topic is not empty;
- omitting `expectedHead` publishes unconditionally, opting out of the very mechanism CAS exists to provide.

The same hole appears in two more places: a peer whose backlog was trimmed, and a peer that rejoined by external commit during heal. All three are peers that legitimately hold current MLS state but have applied nothing from the topic.

**Fix.** Decouple "the head I must CAS against" from "the commit I last applied". The hub should expose the topic's current head — returned from `fetch`, or carried on the subscription — and a peer seeds `appliedHead` from it at join, at resync, and after an external-commit rejoin. The scalar then means "the head I have reconciled to", which is what the CAS actually needs.

Without this, D1 has no entry point for anyone but the group's creator.

## G2 — `HubStore` is host-implemented; the CAS is a store obligation

The component table assigns the per-topic head and conditional publish to `hub-server` / `hub-protocol` / `hub-tunnel`. But `HubStore` is a *contract* in `hub-protocol` that the host implements. Kubun implements it in `packages/hub/src/hub-store.ts` — SQL-backed, with its own migrations, over both SQLite and Postgres.

So D1 is a `HubStore` contract change, and the head lives in the host's database, not in `hub-server`. Two consequences the design should state:

- **Atomicity is a requirement, not an implementation detail.** A read-then-write CAS is a race, and this particular race is the one D1 exists to eliminate. The contract must require that the head comparison, the append, and the head advance happen in a single transaction. Say so, because a host reading the design's `head`-as-a-scalar description could reasonably implement it as three statements.
- **Every host with a hub pays a migration.** Worth naming in the design so the work is sized honestly.

The boundary table should read: hub-protocol *defines* conditional publish and `HeadMismatch`; the `HubStore` implementation *provides* it atomically.

## G3 — No local serialization on `peer.commit`

CAS resolves races between devices. It says nothing about two concurrent callers on the *same* device.

Both call `build()` against the same handle, both publish, one takes a `HeadMismatch` and retries for nothing. Worse, `build()` runs concurrently against a handle the other caller is about to supersede — exactly the hazard `commitLedgerEntries` warns about ("two commits issued from the same source handle both frame at that handle's epoch and diverge").

`peer.commit` needs a per-group mutex. Kubun serializes this today in its handle registry; if the peer owns the commit loop, the peer owns the serialization.

## G4 — The trim-strand trigger is a timing heuristic

D1 claims both heal triggers are deterministic. The byzantine one is: a *valid* commit framed at an epoch the peer has already passed is observable in one step.

The trim-strand trigger is not. "`HeadMismatch` with no inbound commit able to advance it" can only be evaluated by waiting for an inbound commit that never comes.

**Fix falls out of G1.** If the hub returns its current head, a peer that sees `head > appliedHead` and cannot fetch the intervening commits knows immediately that they were trimmed. One observation, no wait.

## Host-side impacts — not gaps, but size the plan

These are kubun's to absorb. Listed because the design reads as a smaller host change than it is.

- **Removing `localCommitted` inverts the host's commit path.** Kubun applies the commit and adopts `newGroup` up front (`withHandleReplacing`). Under D1 it must build without adopting and adopt only inside `onAccepted` — and because `build()` re-runs on every retry, an invite re-mints both the Commit *and* the Welcome each time. This is a rewrite of the host's commit paths, not a call-site swap. Fine, but say it.
- **Welcome delivery is not durable across CAS acceptance.** Once the hub accepts, the group has advanced whether or not the Welcome reaches the invitee. A crash between acceptance and `onAccepted`'s send leaves the invitee added to a group they never received keys for. The answer may simply be "an admin re-invites", but the design should say which.

## What matches

Recorded so it does not get relitigated: the envelope stays ids-only; host reducers stay in the host; `handle.ledger` and `onLedgerEntries` are consumed rather than rebuilt; sealing to the leaf (not the DID key) is the right call and the reachability argument for it is sound; the acceptance criteria are the ones the host would have written.
