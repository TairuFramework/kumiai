# Design: the control-ledger lane

**Status:** design, revision 4 (2026-07-13). Reviewed three times by kubun in
`2026-07-13-control-ledger-lane-review.md`; G1–G12 are folded in below.
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

4. **`HubStore` is a mailbox, not a log.** `fetch` is a per-recipient delivery queue, and
   `publish` snapshots its recipients from the topic's subscribers *at publish time*. A
   member invited at epoch N who subscribes after two further commits have landed is never
   sent those commits — there is no backlog to ask for. It is stranded on arrival, today,
   independent of everything above. Two further consequences, both load-bearing for D1:
   **a publish with no recipients stores nothing at all** (`memoryStore.publish`:
   `if (recipients.size === 0) return sequenceID` — the sequence is burned and no row is
   written), and **`ack` deletes** — `removeDelivery` refcounts a message down and GCs it
   out of `topicMessages` when its last recipient acks. What looks like a topic log is
   derivative of delivery. Retention is a function of who has read a message, not of the
   topic.

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

#### The `HubStore` contract change: a log alongside the mailbox

`HubStore` is a **`hub-protocol` contract that hosts implement** — kubun backs it with SQL
over SQLite and Postgres. So the head lives in the host's database, and this is a contract
change every host with a hub must migrate for. `hub-protocol` *defines* the semantics; the
`HubStore` implementation *provides* them.

**This is not a field addition. `HubStore` gains a log.** Today, as problem 4 sets out,
messages are retained as a function of delivery: a publish with no subscribers is not
stored, and the last ack deletes the row. A CAS head over that is incoherent — the head
would advance past frames that were never stored, or that a reader's own ack destroyed, and
no peer could ever pull them. So:

- **Messages are retained per topic, independently of delivery.** A publish is appended to
  the topic's log whether or not anyone is subscribed. This is the system of record.
- **Delivery rows govern push only.** They remain an optimization — a wakeup signal — and
  `ack` deletes a *delivery*, never a log entry.
- **Trim governs the log**, by depth and age, and is the only thing that removes an entry.
  Trim moves `oldest` and never touches `head`.

**The trim window on `commitTopic` is a group-liveness parameter, not a storage parameter
(G12).** It decides one thing: *how long a member may be offline and still resume by
pulling, rather than by healing.* A peer offline longer than the window comes back trimmed
out, and every such peer runs `recover()` — a rendezvous, an external commit, and a CAS
contention (G10). Tuned like a message-queue backlog (hours, or a few thousand frames), the
rare fallback becomes the common path for the most common client: kubun's peers are phones,
and offline-for-a-week is ordinary. So:

- **Default the `commitTopic` window to 90 days**, and treat any depth bound as a runaway
  guard set far above expected volume, never as the primary policy. Hosts tune it from
  member offline behaviour, not from disk pressure.
- **Retention is now unconditional** (that is the point of G7), so the log grows with commit
  volume — and D1 raises commit volume by an order of magnitude by design. It is still
  small: a commit frame is a few KB, so a group committing 100 times a day for 90 days
  retains on the order of tens of MB. Storage is cheap; recovery storms are not.
- A host that shortens this window is choosing to convert the late-joiner fix back into a
  recovery path. The design says so out loud because the failure is silent and shows up as
  load, not as an error.

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

**`sequenceID` gains an ordering contract.** The design compares sequenceIDs in five places
— `expectedHead` equality, `head` against the cursor, `oldest` against the cursor, `after`
as an exclusive cursor, and the byzantine tiebreak. The type is `string` and its order has
never been specified; `memoryStore` works only because `formatSequenceID` happens to
`padStart(12, '0')`. A host that mints `String(counter)` unpadded, or a UUID, satisfies the
type and silently breaks every one of those comparisons (`"10" < "9"`). The contract now
requires:

- sequenceIDs are **lexicographically ordered, strictly increasing within a topic** —
  byte-comparable, so a fixed-width zero-padded encoding, not a bare decimal and not a UUID;
- the sequenceID is **minted by the store inside the CAS transaction**, not by the process.
  kubun mints from an in-process counter lazily seeded from `max(sequence_id)`, so two hub
  processes on one database already collide. Survivable for a mailbox; fatal for a head,
  because the head *is* a sequenceID.

**Atomicity is a contract requirement, not an implementation detail.** The head comparison,
**the sequence mint**, the append, and the head advance MUST happen in **one transaction**.
A read-then-write CAS is a race — precisely the race D1 exists to eliminate. A host reading
"the head is a scalar" could reasonably implement it as three statements; the contract
forbids that in words, and the conformance suite must catch it.

The head is **hub-assigned** — a `sequenceID`, which only the store mints. A member cannot
choose it, so a malicious member cannot wedge the lane by publishing a bogus head token.
This is why the CAS condition is not a member-supplied value. The payload stays opaque: the
hub sequences bytes it cannot read.

`fetchTopic` is gated on subscription, so it exposes a topic's log only to members who
already derive that topic from the group secret.

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

**Only the commit lane becomes a log (G9).** Publish-time recipient snapshotting strands
late subscribers on *every* lane, not just this one. The rendezvous lane and the app lane
keep the mailbox semantics, deliberately: a recovery requester subscribes before it asks, so
it cannot miss its own reply, and app data has the host's own sync behind it. This is a
decision, not an omission — a new lane that needs history must opt into `fetchTopic`, and a
new lane that assumes a late subscriber sees anything published before it subscribed is
wrong.

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
   `build()` again against the now-current handle.

**The retry bound is a deadline, not an attempt count.** At the commit rate D1 is designed
for, with several active admins, five consecutive CAS losses on a busy group is not rare —
an attempt count turns ordinary contention into a thrown error. `commit` retries until a
configurable deadline (default 30s), with a large attempt ceiling retained only as a
runaway guard. Losing a CAS is the expected path, not an error path.

`build()` must read the host's *current* handle on every call — it is a closure, so this is
natural — and must have no side effects until `onAccepted` runs.

**A throw from `onAccepted` is the crash window, reached by a likelier route (G8).** The hub
has accepted; the group has advanced; the host failed to adopt — a DB write failed, a
Welcome send failed. `commit()` is therefore **not atomic**, and a host must not assume it
is. The peer treats a throw exactly as it treats the crash: it does not retry the commit
(the commit is already in the log and other members are applying it), it surfaces the
failure, and the peer heals by external-commit rejoin and re-enacts its entries. See
"Host-side impact".

Because a loser's commit is never published, the commit topic under an honest hub contains
only accepted commits.

#### One serialized lane; heal never runs nested (G13)

`commit()` holds the per-group mutex for its whole run, and its first step *pulls and
processes* frames — which is what fires the heal triggers. So heal is reachable from inside
the mutex, and `recover()` both mutates the handle and ends by re-enacting entries through
`commit()`. Nesting it either way is broken: take the mutex and a heal triggered inside
`commit()`'s pull deadlocks (twice over, on the tail call); skip the mutex and a concurrent
`commit()` builds against the pre-rejoin handle while `recover()` swaps it out — the exact
hazard the mutex exists for, on the path where the handle is least stable.

**All three operations — pull, `commit()`, `recover()` — are top-level operations on one
serialized per-group lane. None of them ever calls another. The mutex is never re-entered.**

- A heal trigger fired while processing a frame **records the condition and returns**. It
  does not heal in place. The pull finishes, the enclosing `commit()` unwinds and releases
  the lane, and its caller sees a retryable outcome.
- `recover()` then runs as its **own** lane operation, taking the mutex itself.
- Re-enactment after a successful heal is a **subsequent** `commit()`, queued on the lane
  after `recover()` releases it — which is just "heal is two commits, not one" (G10) falling
  out of the concurrency rule rather than being bolted onto it.
- A `commit()` that was in flight when heal was triggered re-enters the lane behind
  `recover()` and rebuilds, if it is still within its deadline.

#### Heal: `recover()` is a CAS loop of its own (G10)

Three paths reach heal — the trim strand, the losing branch of a byzantine double-accept,
and a crash or an `onAccepted` throw after acceptance. All three end in an **external
commit**, which changes the ratchet tree and must therefore land on `commitTopic` like any
other commit. That means every question D1 answers for `commit()` must also be answered
here, on the path where the group is *already* fragile.

- **The external commit is CAS'd**, at `reconciledHead`, seeded from `fetchTopic` exactly as
  a fresh member seeds it (G1's mechanism). Publishing it unconditionally would re-open the
  fork D1 exists to close, on the worst possible path.
- **Losing the CAS is the likely case, not the edge case** — heal runs precisely when the
  group is under commit pressure, and two peers healing concurrently (routine, given G12)
  race each other. But a heal retry is **not** shaped like `commit()`'s: the peer cannot
  simply rebuild, because its GroupInfo is now **stale** — it describes a ratchet tree the
  winning commit has already changed. It must discard the GroupInfo, re-request it, and
  rebuild the external commit from the fresh one.
- **Heal is two commits, not one.** `joinGroupExternal` returns `{ commitMessage, group }`
  and carries no entry envelope, so it cannot re-enact anything. The entries ride a
  *subsequent* ordinary `commit()`, which contends on the CAS like any other. "Rejoin and
  re-enact" is two acts, and the second one can lose.

```
recover(deadline):                          # a top-level lane operation; holds the mutex
  loop until deadline:
    pull commitTopic to the end             # may resolve the strand outright: nothing to heal
    requestID = fresh
    request = mls.createRecoveryRequest(requestID)   # ephemeral HPKE key, signed (D2)
    publish request on rendezvousTopic, await a sealed reply
    pending = mls.applyRecovery(sealed, requestID)   # opens with the ephemeral key,
                                                     # builds the external commit; null if unopenable
    publish pending.commit to commitTopic with expectedHead = reconciledHead
      accepted     -> pending.onAccepted()            # adopt the rejoined handle
                      reconciledHead = returned sequenceID
                      gather the ledger bodies the GroupInfo did not carry (D3)
                      return { advanced: true, reenact: <entries discarded on the way in> }
      HeadMismatch -> discard the GroupInfo AND the external commit built from it
                      (the GroupInfo describes a tree the winner already changed)
                      continue the loop
  deadline exceeded -> return { advanced: false }

# The caller re-enacts `reenact` via an ordinary commit() — a SEPARATE lane operation,
# queued after recover() releases the mutex. recover() never calls commit().
```

The peer's own entry tokens survive all of this untouched: they are epoch-independent, so a
discarded external commit costs nothing but the round trip.

#### Heal triggers

Retained for the two cases CAS cannot cover. Both triggers are single-observation; the
timing heuristic in revision 1 is gone (G4).

- **Trim strand.** After a pull, `head > reconciledHead` but the intervening frames are no
  longer retained (`oldest` is past the cursor). The peer knows in one observation that they
  were trimmed, with no waiting. Action: `recover()`.
- **Byzantine double-accept.** The peer records, per epoch it has applied, the sequenceID of
  the commit it applied there. A fork is: **a valid commit at an epoch for which this peer
  holds a recorded applied-commit sequenceID, whose sequenceID differs from the recorded
  one.** "A valid commit at an epoch the peer has already passed" — revision 2's trigger —
  is *not* the test, and using it would be a bug: a late joiner pulling from `oldest` walks
  frames from before it was invited, a rejoined peer walks a log that predates its new leaf,
  and a re-seeded peer walks frames it never held. None of them ever "passed" those epochs.
  Every one of them would diagnose a fork on its first pull and escalate to `recover()`,
  turning the late-joiner fix into a recovery storm. **No record for that epoch → not a
  fork, just history.** Tiebreak, when it really is a fork: the branch whose conflicting
  commit carries the **lower** hub sequenceID wins — both peers can evaluate this once they
  see both frames. The loser rejoins by external commit onto the winner's branch and
  re-enacts its entries; entry tokens are epoch-independent, so re-enactment needs no
  re-signing.
- **Unrecoverable partition.** A hub that never shows a peer the other branch prevents
  convergence entirely. That is DoS, and out of scope.

### D2 — Recovery: seal GroupInfo to a requester-supplied ephemeral key, authorized by the roster

**Sealing to the requester's MLS leaf does not work, and the reason is instructive (G14).**
Revision 3 argued: "commits rotate only the committer's path, and a peer that lost a CAS
race never rotated at all", so the requester still holds the leaf private key the responder
can see. The first clause is true. The conclusion inverts for exactly the peers heal exists
to serve, because **the committer's path is whose path a commit rotates** — every Commit
carries an UpdatePath installing a fresh leaf HPKE key for its author (kumiai depends on
this: `envelope-fold` resolves the committer from "the commit's own UpdatePath leaf
credential"), and the new private key lives only in the derived post-commit state:

| Heal path | Committed? | Leaf key in the responder's tree | Can open a leaf-sealed reply |
|---|---|---|---|
| Trim strand (offline too long) | No | its old key, still held | **Yes** |
| Crash / `onAccepted` threw | Yes — the hub accepted it | its **new** key, installed by the commit every other member applied | **No** — that private key died with the unpersisted `newGroup` |
| Byzantine double-accept, losing branch | Yes — it merged its own | on the winner's branch, its **old** key, which its own merge rotated away | **No** — it holds only the new key, from a branch nobody else has |

Only the trim-strand peer — the one that was merely behind — could open its own rescue. The
two peers whose state is genuinely broken, and for whom `recover()` is the sole exit, could
not. D1 step 5 already half-knew this ("the pre-commit leaf key material is retained, which
the heal path needs"), but that reasoning covers the *discarded* commit; on the
*accepted-then-crashed* commit the tree moved and the key moved with it.

**So the reply is sealed to an ephemeral key the requester mints, and authorization stays on
the roster.** The requester generates an HPKE keypair per `recover()` call and puts the
public half in the rendezvous request, signed by its DID identity key. The responder:

1. verifies the request signature against the DID it names;
2. checks that DID has a leaf in the **current ratchet tree** — authorization remains
   intrinsic and roster-based, the property D2 refuses to give up: a removed member gets
   nothing, with no policy check a host could forget;
3. seals the framed `MLSMessage(GroupInfo)` to the **ephemeral** public key, AAD binding
   `groupID`, `requesterDID`, and `requestID` exactly as before.

This keeps every property the leaf-sealing argument was defending, and drops the one
assumption that fails. It also still answers the objection that killed DID-key sealing — a
stolen DID key would let an attacker *ask*, but the reply is sealed to an ephemeral public
key the attacker does not hold, so a stolen identity key alone buys nothing readable.

The request is now **signed**, which changes the replay analysis: a replayed request re-seals
GroupInfo to the same ephemeral key only its original minter can open, so replay buys
amplification and nothing else — bounded, as before, by responder jitter, storm-collapse
suppression, and the roster filter. A *forged* request now fails signature verification
outright, where previously it was merely useless.

**mls grows two primitives**, over the X25519 HPKE already in `mls/crypto.ts`:

```ts
sealGroupInfo({ group, requesterDID, requestID, recipientKey }): Promise<Uint8Array>
openSealedGroupInfo({ sealed, requesterDID, requestID, privateKey }): Promise<Uint8Array>
```

`sealGroupInfo` throws if `requesterDID` has no leaf in the current tree. `openSealedGroupInfo`
returns the framed `MLSMessage(GroupInfo)`, which feeds the existing `joinGroupExternal`
unchanged, and rejects anything whose AAD does not bind the caller's own DID and request.

**The `GroupMLS` port follows the ephemeral key**, and — because the heal path's external
commit is CAS'd (G10) — `applyRecovery` returns a `PendingCommit` rather than applying:

```ts
type GroupMLS = {
  // ...processCommit, exportRecoverySecret, getLedgerEntries unchanged
  /** Mint the ephemeral keypair + sign the rendezvous request. The private half is retained
   *  by the host, keyed by requestID, until applyRecovery consumes it. */
  createRecoveryRequest(requestID: string): Promise<Uint8Array>
  /** Verify signature, check the roster, seal to the request's ephemeral key. Returns null
   *  for a request whose DID has no leaf — the responder simply stays silent. */
  exportGroupInfo(request: Uint8Array): Promise<Uint8Array | null>
  /** Open with the retained ephemeral private key and build the external commit. Returns
   *  null for bytes it cannot open (hub-injected, or sealed to another request). The peer
   *  CASes the returned commit; the handle is adopted only in onAccepted. */
  applyRecovery(sealed: Uint8Array, requestID: string): Promise<PendingCommit | null>
}
```

`requestID` is still minted by the requester, per `recover()` call, and is still a
correlation id rather than an authorization token — the signature and the roster check carry
authorization now.

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

**Classify by epoch first; unwrap only what you can apply (G11).** The blob is sealed under
the *pre-commit* epoch secret, so a peer walking history — the late joiner, the rejoiner,
the re-seeded peer, all of which the design now expects to do exactly this — reaches frames
whose blob it can never open, including the commit that added it. Unwrapping is therefore a
*consequence* of "I can apply this frame", never a precondition of reading it. A naive
implementation that unwraps before classifying sees ordinary history as a decryption
failure: the cursor still advances (both rows say advance), but the frame is logged as
poison, and that lie costs someone a day the first time they debug a real log.

| Frame | Cursor |
|---|---|
| Applied | advance; record this epoch → sequenceID for the D1 fork check |
| At an epoch this peer has no recorded applied-commit for (pre-join, pre-rejoin, re-seeded history) | advance, **no fork check, no unwrap attempt** — history, not a fork and not poison |
| At an epoch this peer *has* a record for, with a different sequenceID | advance; the fork trigger (D1) |
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
| `mls` | Group state, authority, `ledger_head`, ledger tokens, GroupInfo sealing/opening, the recovery request's ephemeral key and signature | Transport; ordering across peers |
| `rpc` (`GroupPeer`) | The serialized per-group lane (pull, `commit`, `recover` — never nested), the CAS loops, retry/rebase, the pull cursor, body framing, the resolver, gather, fork detection, heal triggers | MLS state; entry semantics |
| Host | Persist handle state; author entries; app reducers; migrate its `HubStore` | Ordering, authority, integrity, body distribution, body storage |

## Host-side impact

Named so the work is sized honestly. These are the host's to absorb.

- **Every host with a hub rebuilds the storage model of its `HubStore`.** This is the
  largest item in the design, and it is not a column or two. Today retention is a function
  of delivery: a publish with no subscribers stores nothing, and the last ack deletes the
  row. The store must instead **retain messages per topic independently of delivery**, with
  trim (by depth and age) as the only thing that removes an entry; delivery rows become a
  push-wakeup optimization, and `ack` stops deleting messages. On top of that: a per-topic
  head, a unique `publishID`, a topic-log read path, sequenceIDs that are lexicographically
  ordered and **minted by the database inside the CAS transaction** rather than by an
  in-process counter (kubun's current counter collides across two hub processes on one
  database — survivable for a mailbox, fatal for a head). A host that reads this as "add a
  head column" will under-scope it by a wide margin.
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

## Accepted exposure: a removed member keeps `commitTopic`

`commitTopic` is non-rotating and derived from `exportRecoverySecret()`, which a removed
member knows permanently, and `fetchTopic` authorizes on subscription. Under mailbox
semantics such a member could only ever receive what was published while it was subscribed;
under a retained log it can re-pull the topic's whole retained history at any time.

**No confidentiality delta.** Post-removal frames carry bodies wrapped under epoch secrets
it cannot derive, and the commits themselves are MLS-authenticated; pre-removal frames it
already had. What it gains is **durable metadata** — commit cadence, frame sizes, group
liveness — and a free hub-resource drain.

Revoking the subscription on removal is the obvious mitigation and is *not* available
cheaply: the hub is blind to the roster by design, so it cannot know a removal happened, and
rotating `commitTopic` on removal would break the one property the topic exists for — that a
peer stranded on any epoch can still find the rendezvous. Accepted and named; revisit only
if metadata exposure to ex-members becomes a stated requirement.

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

- **`HubStore` conformance suite**, run against the memory store and **exported from
  `hub-protocol` for hosts to run against their own store** — it is the contract, and every
  clause below exists because a plausible implementation gets it wrong:
  - **The log is real: publish to a topic with zero subscribers, then subscribe and pull
    the frame.** The single test that proves retention is not a function of delivery. Every
    store passes today's tests and fails this one.
  - **Ack does not delete:** subscriber acks a frame, then pulls it again via `fetchTopic`.
  - **Trim is the only deleter:** `head` survives a trim while `oldest` moves.
  - **Ordering:** sequenceIDs sort lexicographically across a 9→10 boundary. A store minting
    unpadded decimals passes the type and fails here.
  - **CAS:** two publishes at the same head — one accepted, one `HeadMismatchError`, nothing
    stored for the loser; the empty-topic sentinel (`null`); a replayed `publishID` returns
    the original sequenceID and appends nothing.
  - **Concurrent CAS under real parallelism:** N racing publishes at the same head yield
    exactly one accepted append. This must run against a real database over **separate
    connections** — not N `await`s on one connection, which the obvious in-memory version
    does and which a non-transactional, process-counter store passes while being broken.
  - `fetchTopic` refuses a non-subscriber.
- **Concurrent commits.** Two admins commit at epoch N against one hub: one wins, the loser
  rebases and its entries land in a later commit. No fork, no lost entries.
- **Same-device concurrency.** Two concurrent `peer.commit` calls serialize; both commits
  land; neither builds against a superseded handle.
- **Late joiner.** A member is invited, two further commits land before it subscribes, and it
  converges by pulling the log — with no `recover()` and **no fork diagnosis**, walking
  frames from epochs it never held (the G5 regression test).
- **`onAccepted` throws.** The commit is in the log, the host failed to adopt: `commit()`
  surfaces the failure, does not retry the commit, and the peer heals by rejoin.
- **First-delivery resolution.** Three-member group, an admin enacts an entry, the third
  member has never seen the body: it applies the commit on first delivery, no gather.
- **Offline catch-up.** A member offline across several enacting commits reconnects and
  converges, with no host-side backfill code.
- **Trim strand.** The intervening commits are trimmed; the peer detects it in one
  observation (`head > reconciledHead`, `oldest` past the cursor) and heals.
- **Heal loses the CAS.** A commit lands between the rejoining peer's GroupInfo request and
  its external-commit publish: the peer takes `HeadMismatchError`, **discards the GroupInfo**
  (not just the commit), re-requests, rebuilds, and converges. The regression test for G10 —
  a peer that merely retried the same external commit against a changed tree would wedge.
- **Two peers heal concurrently.** Both hold GroupInfo at the same epoch; one wins, the other
  re-requests and converges. Both end up in the roster, and neither loses its entries.
- **Heal re-enacts.** After a rejoin, the peer's discarded entries land via an ordinary
  `commit()` — a second commit, which itself contends normally.
- **History is not poison.** A late joiner pulling from `oldest` walks frames whose body blob
  it cannot unwrap (including its own add-commit) and classifies none of them as malformed
  (the G11 regression test).
- **Sealing.** A reply opens for the requester and fails to open for every other member and
  for the hub. A reply replayed at another member or another request is rejected by the AAD
  check. A removed member's request is refused (no leaf in the current tree). A request with
  a bad signature is refused. **A peer whose own commit was accepted and then lost (the crash
  path) recovers** — the G14 regression test, which a leaf-sealed design fails: it holds no
  private key matching the leaf the responder can see.
- **Heal never nests.** A heal triggered while `commit()` is pulling does not deadlock: the
  trigger records, `commit()` unwinds and releases the lane, `recover()` runs as its own
  operation, and the re-enactment is a later `commit()` (the G13 regression test).
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
- A peer that must heal converges even under commit pressure: its external commit is CAS'd,
  and losing the race costs it a re-request, not a wedge.
- A member offline for the trim window's duration resumes by pulling, not by healing.
