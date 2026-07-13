# Design: the control-ledger lane

**Status:** design, revision 2 (2026-07-13). Revision 1 was reviewed by kubun in
`2026-07-13-control-ledger-lane-review.md`; G1–G4 are folded in below.
**Supersedes:** the requirements in `../../agents/plans/next/2026-07-13-host-ledger-lane.md`
(R1/R2/R3), which stays as the origin record.
**Scope:** `@kumiai/mls`, `@kumiai/rpc`, `@kumiai/hub-protocol`, `@kumiai/hub-server`,
`@kumiai/hub-tunnel`. Hosts implementing `HubStore` pay a migration.

## Problem

`@kumiai/mls` 0.2 made the control ledger authoritative — a commit's envelope names the
entries it enacts, `foldEnvelope` refuses entries not admin-authored at their own
position, and `ledger_head` chains the enacted ids into the GroupContext. That core is
sound. Three things around it are not:

1. **Bodies never travel.** The envelope is ids-only, so a receiver that has never seen
   an entry body throws `MissingLedgerEntriesError` and cannot apply the commit. The
   library leaves the id→body half to the host. Every host needs it, and a host that gets
   the ordering backwards strands its peers permanently.
2. **Recovery is dead.** `GroupMLS.exportGroupInfo` is contracted to return group state
   *sealed to the requesting member's leaf*. `mls` has no sealing primitive, so no host
   can satisfy it. Every host either leaks the ratchet tree to the relay or stubs the
   method out.
3. **Concurrent commits fork the group.** kumiai is apply-then-announce. Two admins at
   epoch N both commit, both apply locally, both fan out — neither can apply the other's
   commit, and the group is split with no exit. Rare today only because commits are rare;
   kubun's move of its whole control plane onto `commitLedgerEntries` raises commit
   frequency by an order of magnitude.

A fourth, surfaced while reviewing D1 and fixed here as a consequence of it:

4. **The commit lane is a mailbox, not a log.** `HubStore.fetch` is a per-recipient
   delivery queue, and `publish` snapshots its recipients from the topic's subscribers *at
   publish time*. A member invited at epoch N who subscribes after two further commits
   have landed is never sent those commits — there is no backlog to ask for. It is
   stranded on arrival, today, independent of everything above.

## Design decisions

Taken in dependency order: ordering first, because it changes the peer's commit API that
the body lane rides on; sealing second, because the heal path depends on it.

### D1 — Ordering: the commit topic becomes a CAS'd log

**A byzantine hub can fork the group under any design.** CAS acceptance is an
unauthenticated claim: a lying hub can tell two admins they both won and partition
delivery. Fork *handling* is therefore a floor we cannot remove. CAS is not a soundness
guarantee — it is what removes forks from the honest-hub common case, which is the case
kubun's 10× commit rate actually creates. We build both.

**Threat delta of CAS against a compromised hub.** No confidentiality or authenticity
loss: accept/reject is a routing decision, MLS keeps both branches sealed and
authenticated, and the hub gains no read or forge power. Three deltas, all
availability/consistency class:

- *Censorship becomes deniable.* A hub can reject one admin's CAS forever while accepting
  another's. She believes she lost an honest race and retries, cooperating with her own
  censorship. The ceiling is unchanged — the hub could always drop her commit — but the
  failure goes from loud (she has already applied locally and diverges visibly) to silent.
- *Forks remain possible.* See above. The heal path is retained for exactly this.
- *The hub becomes stateful.* A lost or rolled-back head stalls the commit lane. Safety is
  unaffected (peers reject stale-epoch commits by MLS epoch); it is another way to stall,
  i.e. DoS.

Accepted. The hub can already drop, delay, reorder and partition; none of this raises its
ceiling.

#### The `HubStore` contract change

`HubStore` is a **`hub-protocol` contract that hosts implement** — kubun backs it with SQL
over SQLite and Postgres. So the head lives in the host's database, and this is a contract
change every host with a hub must migrate for. `hub-protocol` *defines* the semantics; the
`HubStore` implementation *provides* them.

```ts
export type PublishParams = {
  senderDID: string
  topicID: string
  payload: Uint8Array
  /**
   * Compare-and-set on the topic's head. Absent: append unconditionally. Present: append
   * only if the topic's current head is exactly this value, where `null` means "the topic
   * has never had an accepted publish". On mismatch, throw HeadMismatchError and store
   * nothing.
   */
  expectedHead?: string | null
  /**
   * Idempotency key. Republishing an already-accepted publishID returns its original
   * sequenceID instead of appending again. Reserved for the durable-commit journal in
   * "Deferred" below; hosts persist it and enforce uniqueness now, so closing that gap
   * later costs no second migration.
   */
  publishID?: string
}

export type FetchTopicParams = {
  /** Authorization: the caller must be a current subscriber of topicID. */
  subscriberDID: string
  topicID: string
  /** Exclusive cursor: messages after this sequenceID. Absent: from the oldest retained. */
  after?: string
  limit?: number
}

export type FetchTopicResult = {
  messages: Array<StoredMessage>
  /** The topic's current head: the sequenceID of the last accepted publish, or null. */
  head: string | null
  /** The oldest sequenceID still retained for this topic, or null if the log is empty. */
  oldest: string | null
}

export type HubStore = {
  // ...existing members unchanged
  publish(params: PublishParams): Promise<string>
  fetchTopic(params: FetchTopicParams): Promise<FetchTopicResult>
}
```

**Atomicity is a contract requirement, not an implementation detail.** The head
comparison, the append, and the head advance MUST happen in a single transaction. A
read-then-write CAS is a race — and it is precisely the race D1 exists to eliminate. A
host reading "the head is a scalar" could reasonably implement it as three statements; the
contract must forbid that in words, and the conformance suite must catch it.

The head is **hub-assigned** — it is a `sequenceID`, which only the store mints. A member
cannot choose it, so a malicious member cannot wedge the lane by publishing a bogus head
token. This is why the CAS condition is not a member-supplied value. The payload stays
opaque: the hub sequences bytes it cannot read.

`fetchTopic` is gated on subscription, so it exposes a topic's log only to members who
already derive that topic from the group secret. Trimming (by depth or age) moves `oldest`
and never touches `head`.

#### Topic split

Today's single handshake topic carries commits *and* recovery frames, and any publish would
move the head. It splits:

- `commitTopic(recoverySecret)` — commits only, CAS'd, read as a log.
- `rendezvousTopic(recoverySecret)` — recovery request/reply, unconditional, push-delivered.

Both remain non-rotating and derived from `exportRecoverySecret()`, so a peer stranded on
any epoch still shares both rendezvous with the live group. Both are subscribed for the
peer's whole life, never rebuilt on resync.

#### The commit lane is pull-driven

The peer drives `commitTopic` by **pull**, not by delivery. It keeps one cursor,
`reconciledHead` — the sequenceID of the last commit frame it has *processed*, whether it
applied that frame or dropped it as stale or malformed.

- **Seeding (G1).** A peer that has applied nothing from the topic — a fresh member from a
  Welcome, a peer whose backlog was trimmed, a peer that just rejoined by external commit —
  seeds its cursor by *reading the log*, not by guessing. It subscribes first, then calls
  `fetchTopic` from its last known cursor (or from the oldest retained frame), processes
  every frame it can, and sets `reconciledHead` to what it reached. A frame framed at an
  epoch it has already passed is dropped and still advances the cursor. This is also what
  closes problem 4: the late-subscribing joiner *pulls* the commits it missed instead of
  being stranded, and needs no recovery at all.
- **Push is only a wakeup.** The subscription still delivers commit frames; the peer treats
  a delivery as a hint to pull, and takes the frames from the pull. Delivery order,
  redelivery, and the store's exclusion of the sender from its own recipients all stop
  mattering for commits.
- **Ack becomes cursor-advance.** "Do not ack, so the hub redelivers" is no longer how the
  commit lane retries; the cursor simply does not advance. See D3.

#### The peer's commit state machine

`GroupPeer.localCommitted(commit)` — apply-then-announce — is **removed**. It is replaced by
`GroupPeer.commit(build)`:

```ts
type PendingCommit = {
  /** Framed MLSMessage(Commit) bytes. */
  commit: Uint8Array
  /** Signed ledger-entry tokens this commit enacts. Empty for a commit that enacts none. */
  bodies: Array<string>
  /** Runs only if the hub accepts. The host adopts newGroup here and sends any Welcome. */
  onAccepted: () => Promise<void>
}

commit: (build: () => Promise<PendingCommit>) => Promise<void>
```

**`commit` holds a per-group mutex for its whole run (G3).** CAS resolves races between
devices; it says nothing about two callers on the same device. Two concurrent `build()`
calls would both frame at the same handle's epoch and diverge — exactly the hazard
`commitLedgerEntries` documents. The peer owns the commit loop, so the peer owns the
serialization.

Inside the mutex:

1. Pull `commitTopic` to the end and process everything. `reconciledHead` is now current.
2. Call `build()`. The host has produced `newGroup` via `commitLedgerEntries` /
   `commitInvite` / `removeMember` but has **not** adopted it — mls commits are
   non-mutating, returning a derived handle and never advancing the source, so the host's
   live handle is still the pre-commit one.
3. Frame `[commit][wrap(bodies)]` (see D3) and publish to `commitTopic` with
   `expectedHead: reconciledHead`.
4. **Accepted** → set `reconciledHead` to the returned sequenceID, run `onAccepted()`,
   rebuild the epoch.
5. **`HeadMismatchError`** → drop the `PendingCommit` untouched. Discarding costs nothing,
   and the pre-commit leaf key material is retained, which the heal path needs. Go back to
   step 1: pull the winning commit, let the host's handle rebase as it applies, and call
   `build()` again against the now-current handle. Bounded retries (default 5), then throw.

`build()` must read the host's *current* handle on every call — it is a closure, so this is
natural — and must have no side effects until `onAccepted` runs.

Because a loser's commit is never published, the commit topic under an honest hub contains
only accepted commits.

#### Heal

Retained for the two cases CAS cannot cover. Both triggers are single-observation; the
timing heuristic in revision 1 is gone (G4).

- **Trim strand.** After a pull, `head > reconciledHead` but the intervening frames are no
  longer retained (`oldest` is past the cursor). The peer knows in one observation that they
  were trimmed, with no waiting. Action: `recover()`.
- **Byzantine double-accept.** A valid commit framed at an epoch the peer has already
  passed. Tiebreak: the branch whose conflicting commit carries the **lower** hub sequenceID
  wins — both peers can evaluate this once they see both frames, and the peer retains, per
  applied epoch, the sequenceID of the commit it applied there. The loser rejoins by
  external commit onto the winner's branch and re-enacts its entries; entry tokens are
  epoch-independent, so re-enactment needs no re-signing.
- **Unrecoverable partition.** A hub that never shows a peer the other branch prevents
  convergence entirely. That is DoS, and out of scope.

### D2 — Recovery: seal GroupInfo to the requester's MLS leaf

The reachable requester population is exactly "still holds MLS state, but stale or forked":
the rendezvous topic is derived from `exportRecoverySecret()`, which comes from MLS state,
so a peer that lost its state entirely cannot even derive the topic to ask on. That
population is precisely the one that still holds its **leaf HPKE private key** — commits
rotate only the committer's path, and a peer that lost a CAS race never rotated at all. So
sealing to the leaf serves everyone who can ask, and nobody who cannot.

Sealing to the requester's DID keyAgreement key was considered and rejected: it would make a
stolen DID key alone sufficient to pull group state with no MLS material, and it would
require re-deriving the rendezvous from an identity-based secret. Full-device-loss recovery
is a separate problem — such a member should be re-invited by an admin, not self-serve a
rejoin.

**mls grows the sealing side:**

```ts
exportGroupInfo({ group, requesterDID, requestID }): Promise<{ sealed: Uint8Array }>
```

- Resolve `requesterDID`'s leaf in the current ratchet tree by credential identity. No leaf
  → throw. A removed member gets nothing: authorization is intrinsic, not a policy check a
  host could forget.
- HPKE-seal the framed `MLSMessage(GroupInfo)` to that leaf's `encryption_key`, using the
  X25519 HPKE already present in `mls/crypto.ts`, MLS-style labeled encryption.
- AAD binds `groupID`, `requesterDID`, and `requestID`, so a reply cannot be replayed at
  another member, another group, or another request.

**mls grows the opening side:**

```ts
openGroupInfo({ group, sealed, requestID }): Promise<Uint8Array>  // framed MLSMessage(GroupInfo)
```

Decrypts with the caller's own leaf HPKE private key and verifies the AAD binds its own DID
and the request it issued. Output feeds the existing `joinGroupExternal` unchanged.

**rpc's `GroupMLS` contract then holds as written.** `exportGroupInfo(requesterDID)` returns
sealed bytes; `applyRecovery(sealed)` returns `{ advanced: false }` for anything it cannot
open — hub-injected bytes, or a reply sealed to another member — which is what `peer.ts`
already expects. Responders additionally ignore rendezvous requests naming a DID with no
leaf in the current tree: a free filter against a hub spamming requests.

### D3 — Bodies: bundled with the commit, no host store

**No `GroupLedger` host port.** `GroupHandle` already exposes `ledgerTokens` — the signed
tokens, "the canonical persistent and wire form, the only thing that can be handed to
another party" — and the host already persists handle state. A body store would duplicate
what the handle holds. The host implements nothing.

**The commit frame carries the bodies.** The frame becomes `[commit bytes][wrapped body
blob]`, where the blob is the signed tokens the commit enacts, encrypted with
`GroupCrypto.wrap` under the **pre-commit** epoch secret. Every peer that can apply the
commit is at that epoch and holds that secret; the hub never sees a body.

This deletes the publish-bodies-before-the-commit ordering rule entirely. Body delivery is
atomic with the commit, so first-delivery stranding is impossible by construction rather
than merely retryable. A peer further behind cannot unwrap the blob — but it cannot apply
the commit either. It processes the log in sequence order, and each commit's blob is
unwrappable by the time that commit is the next one it can apply.

The MLS control envelope stays ids-only. This is the transport frame, not the AAD.

**Resolution and catch-up.** The peer supplies the resolver the host wires into
`GroupHandleParams.resolveLedgerEntries`. It serves from the bodies unwrapped from the
in-flight frame; on a miss — an external-commit rejoin, whose GroupInfo carries no ledger —
it gathers the missing ids from current members over the encrypted app lane. Serving a
gather needs one new `GroupMLS` method:

```ts
getLedgerEntries(ids: Array<string>): Promise<Array<string>>  // signed tokens, from handle.ledger
```

The requester re-verifies every returned token and checks each digest against the id it
asked for, so a lying responder can only fail to answer, never inject.

**Cursor-advance rule.** Replaces revision 1's ack table, now that the commit lane is pulled
rather than delivered. For each frame processed from `commitTopic`:

| Outcome | Cursor |
|---|---|
| Applied | advance |
| Stale / already-superseded epoch | advance (drop the frame, run the D1 fork check) |
| Malformed, or policy-rejected (`CommitRejectedError`) | advance (poison — never retry) |
| `MissingLedgerEntriesError` | **do not advance**; gather the missing ids, retry the frame (bounded); on exhaustion, advance and escalate to `recover()` |

`MissingLedgerEntriesError` remains the one retryable outcome, and D3 makes it the rare one.
This also repairs today's bug in `peer.ts`, whose bare `catch` never acks, so *any*
permanently-failing commit is redelivered forever.

## Component boundaries

| Component | Owns | Does not |
|---|---|---|
| `hub-protocol` | *Defines* conditional publish, `fetchTopic`, `HeadMismatchError`, the atomicity requirement, the conformance suite | Implement storage |
| `HubStore` implementations (`hub-server` memory store; each host's DB store) | *Provide* the per-topic head, the atomic CAS, the readable log | Read payloads; know what a commit is |
| `mls` | Group state, authority, `ledger_head`, ledger tokens, GroupInfo sealing/opening | Transport; ordering across peers |
| `rpc` (`GroupPeer`) | The commit mutex, the CAS loop, retry/rebase, the pull cursor, body framing, the resolver, gather, fork detection, heal triggers | MLS state; entry semantics |
| Host | Persist handle state; author entries; app reducers; migrate its `HubStore` | Ordering, authority, integrity, body distribution, body storage |

## Host-side impact

Named so the work is sized honestly. These are the host's to absorb.

- **Every host with a hub pays a `HubStore` migration:** a per-topic head, a unique
  `publishID`, and a topic-log read path, with the CAS in one transaction.
- **Removing `localCommitted` inverts the host's commit path.** A host that applies the
  commit and adopts `newGroup` up front (kubun's `withHandleReplacing`) must instead build
  without adopting and adopt only inside `onAccepted`. Because `build()` re-runs on every
  retry, an invite re-mints both the Commit *and* the Welcome each time. This is a rewrite
  of the host's commit paths, not a call-site swap.
- **Welcome delivery is not durable across CAS acceptance.** Once the hub accepts, the group
  has advanced whether or not `onAccepted` ran. A crash in that window leaves the committer
  unable to apply even its own commit — MLS merges a pending commit, it does not process one
  — so it heals by external-commit rejoin and re-enacts its entries. An invite lost this way
  leaves an **orphan leaf**: a member added to the tree who never received keys. The repair
  is an admin remove + re-invite. Accepted as a crash-window rarity, not a steady-state
  hazard.

## Deferred

- **Closing the crash window.** A durable pending-commit journal (commit bytes, `newGroup`
  state, any Welcome) written before publish, plus republish-by-`publishID` on restart to
  learn the outcome, would make commit acceptance and local adoption atomic. `publishID` is
  in the contract *now* so this costs no second host migration when we do it.
- **Full-device-loss recovery** (no MLS state at all). Such a member is re-invited.
- **Hub-partition DoS.** Out of scope.

## Non-goals

- No change to the authority model, the roster, `ledger_head`, or the commit policy.
- Host reducers (`circle.def`, `circle.member`, `group.settings`) stay in the host. kumiai
  orders and authorizes entries; it never interprets them.
- Nothing here needs the `app` slot of `ControlEnvelope`.

## Testing

- **`HubStore` conformance suite**, run against the memory store and exported for hosts to
  run against theirs: two publishes at the same head — one accepted, one `HeadMismatchError`,
  nothing stored for the loser; the empty-topic sentinel (`null`); a replayed `publishID`
  returns the original sequenceID and appends nothing; `head` survives a trim while `oldest`
  moves; `fetchTopic` refuses a non-subscriber; **concurrent CAS under real parallelism — N
  racing publishes at the same head yield exactly one accepted append** (the test that
  catches a non-transactional implementation).
- **Concurrent commits.** Two admins commit at epoch N against one hub: one wins, the loser
  rebases and its entries land in a later commit. No fork, no lost entries.
- **Same-device concurrency.** Two concurrent `peer.commit` calls serialize; both commits
  land; neither builds against a superseded handle.
- **Late joiner.** A member is invited, two further commits land before it subscribes, and it
  converges by pulling the log — with no `recover()`.
- **First-delivery resolution.** Three-member group, an admin enacts an entry, the third
  member has never seen the body: it applies the commit on first delivery, no gather.
- **Offline catch-up.** A member offline across several enacting commits reconnects and
  converges, with no host-side backfill code.
- **Trim strand.** The intervening commits are trimmed; the peer detects it in one
  observation (`head > reconciledHead`, `oldest` past the cursor) and heals.
- **Sealing.** A reply opens for the requester and fails to open for every other member and
  for the hub. A reply replayed at another member or another request is rejected by the AAD
  check. A removed member's request is refused.
- **Cursor-advance.** A commit with unresolvable bodies is retried without advancing; a
  malformed commit advances the cursor once and is never retried.
- **Fork heal.** A simulated lying hub double-accepts; the lower-sequenceID branch wins, the
  loser rejoins by external commit, and its entries are re-enacted.

## Acceptance

- A host writes no ordering, no authority, no integrity, and no body-distribution code — and
  no body store. Its only new obligation is the `HubStore` migration.
- Two admins enacting entries concurrently converge against an honest hub, with no permanent
  fork and no lost entries.
- Two concurrent commits on the same device both land.
- A member invited while commits are in flight converges by pulling the log, without
  recovery.
- A third member who has never seen an entry body applies the enacting commit on first
  delivery.
- `GroupMLS.exportGroupInfo` is implementable by a host without leaking group state to the
  relay.
- A permanently-failing commit is dropped once and never retried forever.
