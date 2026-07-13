# Design: the control-ledger lane

**Status:** design, approved 2026-07-13. Supersedes the requirements in
`2026-07-13-host-ledger-lane.md` (R1/R2/R3), which stays as the origin record.
**Scope:** `@kumiai/mls`, `@kumiai/rpc`, `@kumiai/hub-protocol`, `@kumiai/hub-server`,
`@kumiai/hub-tunnel`.

## Problem

`@kumiai/mls` 0.2 made the control ledger authoritative — a commit's envelope names the
entries it enacts, `foldEnvelope` refuses entries not admin-authored at their own
position, and `ledger_head` chains the enacted ids into the GroupContext. That core is
sound. Three things around it are not:

1. **Bodies never travel.** The envelope is ids-only, so a receiver that has never seen
   an entry body throws `MissingLedgerEntriesError` and cannot apply the commit. The
   library leaves the id→body half to the host. Every host needs it, and a host that
   gets the ordering backwards strands its peers permanently.
2. **Recovery is dead.** `GroupMLS.exportGroupInfo` is contracted to return group state
   *sealed to the requesting member's leaf*. `mls` has no sealing primitive, so no host
   can satisfy it. Every host either leaks the ratchet tree to the relay or stubs the
   method out.
3. **Concurrent commits fork the group.** kumiai is apply-then-announce. Two admins at
   epoch N both commit, both apply locally, both fan out — neither can apply the other's
   commit, and the group is split with no exit. Rare today only because commits are
   rare; kubun's move of its whole control plane onto `commitLedgerEntries` raises commit
   frequency by an order of magnitude.

## Design decisions

Three decisions, taken in dependency order. Ordering is decided first because it changes
the peer's commit API, which the body lane rides on; sealing is decided second because
the heal path depends on it.

### D1 — Ordering: hub CAS sequencer, with heal as the floor

**A byzantine hub can fork the group under any design.** CAS acceptance is an
unauthenticated claim: a lying hub can tell two admins they both won and partition
delivery. So fork *handling* is a floor we cannot remove. CAS is not a soundness
guarantee — it is what removes forks from the honest-hub common case, which is the case
kubun's 10× commit rate actually creates. We build both.

**Threat delta of CAS against a compromised hub.** No confidentiality or authenticity
loss: accept/reject is a routing decision, MLS keeps both branches sealed and
authenticated, and the hub gains no read or forge power. Three deltas, all
availability/consistency class:

- *Censorship becomes deniable.* A hub can reject one admin's CAS forever while
  accepting another's. She believes she lost an honest race and retries, cooperating
  with her own censorship. The ceiling is unchanged (the hub could always drop her
  commit), but the failure goes from loud — she has already applied locally and diverges
  visibly — to silent.
- *Forks remain possible.* See above. The heal path is retained for exactly this.
- *The hub becomes stateful.* A lost or rolled-back head stalls the commit lane. Safety
  is unaffected (peers reject stale-epoch commits by MLS epoch); it is another way to
  stall, i.e. DoS.

Accepted. The hub can already drop, delay, reorder and partition; none of this raises
its ceiling.

#### The hub primitive: conditional publish

`HubPublishParams` grows an optional `expectedHead?: string`. The hub keeps, per topic,
`head` — the `sequenceID` of the last accepted publish on that topic.

- `expectedHead` absent → append unconditionally, advance `head`.
- `expectedHead` present and equal to `head` → append, advance `head`, return the new
  `sequenceID`.
- `expectedHead` present and different → reject with `HeadMismatch`. Nothing is stored.
- `expectedHead` is the empty-topic sentinel (`null`) → accepted only if the topic has
  never had an accepted publish.

The head is **hub-assigned**. A member cannot choose it, so a malicious member cannot
wedge the lane by publishing a bogus head token — the reason not to let the condition be
a member-supplied value. The payload stays opaque: the hub sequences bytes it cannot
read. Trimming the topic log does not touch `head`, which is a scalar.

#### Topic split

Today's single handshake topic carries commits *and* recovery frames, and any publish
would move the head. It splits:

- `commitTopic(recoverySecret)` — commits only, CAS'd.
- `rendezvousTopic(recoverySecret)` — recovery request/reply, unconditional.

Both remain non-rotating and derived from `exportRecoverySecret()`, so a peer stranded on
any epoch still shares both rendezvous with the live group. Both are subscribed for the
peer's whole life, never rebuilt on resync.

#### The peer's commit state machine

`GroupPeer.localCommitted(commit)` — apply-then-announce — is **removed**. It is replaced
by `GroupPeer.commit(build)`:

```ts
type PendingCommit = {
  /** Framed MLSMessage(Commit) bytes. */
  commit: Uint8Array
  /** Signed ledger-entry tokens this commit enacts. Empty for a commit that enacts none. */
  bodies: Array<string>
  /** Called only if the hub accepts. The host adopts newGroup here and sends any Welcome. */
  onAccepted: () => Promise<void>
}

commit: (build: () => Promise<PendingCommit>) => Promise<void>
```

1. Call `build()`. The host has produced `newGroup` via `commitLedgerEntries` /
   `commitInvite` / `removeMember` but has **not** adopted it. mls commits are
   non-mutating — they return a derived handle and never advance the source — so the
   host's live handle is still the pre-commit one.
2. Frame `[commit][wrap(bodies)]` (see D3) and publish to `commitTopic` with
   `expectedHead` = the sequenceID of the last commit this peer applied, or the
   empty-topic sentinel.
3. **Accepted** → record the returned sequenceID as the applied head, call
   `onAccepted()`, rebuild the epoch.
4. **HeadMismatch** → drop the `PendingCommit` untouched. Discarding costs nothing, and
   the pre-commit leaf key material is retained — which the heal path needs. Wait for the
   inbound lane to drain the winning commit (the host's handle rebases as it applies),
   then call `build()` again against the now-current handle. Bounded retries
   (default 5), then throw.

The peer tracks one scalar, `appliedHead` — the `sequenceID` of the last commit it
applied, whether its own (from the CAS publish result) or an inbound one (from
`StoredMessage.sequenceID`). It is the `expectedHead` of the next CAS. It is also
retained per applied epoch, so the byzantine tiebreak below can compare the sequenceID of
a conflicting commit against the one this peer applied at that same epoch.

Because a loser's commit is never published, the commit topic under an honest hub
contains only accepted commits. Stale-epoch commits all but vanish from the lane.

`build()` must read the host's *current* handle each call — it is a closure, so this is
natural — and must be free of side effects until `onAccepted` runs.

#### Heal

Retained for the two cases CAS cannot cover. Both have deterministic triggers; neither
uses a timing heuristic.

- **Trim strand.** The peer's `expectedHead` is behind and the intervening commits have
  been trimmed from the hub's topic log, so it can never drain and its CAS will reject
  forever. Trigger: `HeadMismatch` with no inbound commit able to advance it. Action:
  `recover()`.
- **Byzantine double-accept.** Detected the moment a peer receives a *valid* commit
  framed at an epoch it has already passed. Tiebreak: the branch whose conflicting commit
  carries the **lower hub sequenceID** wins — both peers can evaluate this once they see
  both frames. The loser rejoins by external commit onto the winner's branch and re-enacts
  its entries. Entry tokens are epoch-independent, so re-enactment needs no re-signing.
- **Unrecoverable partition.** A hub that never shows a peer the other branch prevents
  convergence entirely. This is DoS and is out of scope.

### D2 — Recovery: seal GroupInfo to the requester's MLS leaf

The reachable requester population is exactly "still holds MLS state, but stale or
forked": the rendezvous topic is derived from `exportRecoverySecret()`, which comes from
MLS state, so a peer that lost its state entirely cannot even derive the topic to ask on.
That population is precisely the one that still holds its **leaf HPKE private key** —
commits rotate only the committer's path, and a peer that lost a CAS race never rotated
at all. So sealing to the leaf serves everyone who can ask, and nobody who cannot.

Sealing to the requester's DID keyAgreement key was considered and rejected: it would
make a stolen DID key alone sufficient to pull group state with no MLS material, and it
would require re-deriving the rendezvous from an identity-based secret. Full-device-loss
recovery is a separate problem — such a member should be re-invited by an admin, not
self-serve a rejoin.

**mls grows the sealing side:**

```ts
exportGroupInfo({ group, requesterDID, requestID }): Promise<{ sealed: Uint8Array }>
```

- Resolve `requesterDID`'s leaf in the current ratchet tree by credential identity. No
  leaf → throw. A removed member gets nothing: authorization is intrinsic, not a policy
  check a host could forget.
- HPKE-seal the framed `MLSMessage(GroupInfo)` to that leaf's `encryption_key`, using the
  X25519 HPKE already present in `mls/crypto.ts`, MLS-style labeled encryption.
- AAD binds `groupID`, `requesterDID`, and `requestID`, so a reply cannot be replayed at
  another member, another group, or another request.

**mls grows the opening side:**

```ts
openGroupInfo({ group, sealed, requestID }): Promise<Uint8Array>  // framed MLSMessage(GroupInfo)
```

Decrypts with the caller's own leaf HPKE private key and verifies the AAD binds its own
DID and the request it issued. Output feeds the existing `joinGroupExternal` unchanged.

**rpc's `GroupMLS` contract then holds as written.** `exportGroupInfo(requesterDID)`
returns sealed bytes; `applyRecovery(sealed)` returns `{ advanced: false }` for anything
it cannot open — hub-injected bytes, or a reply sealed to another member — which is what
`peer.ts` already expects. Responders additionally ignore rendezvous requests naming a
DID with no leaf in the current tree: a free filter against a hub spamming requests.

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
the commit either. It processes the topic in sequence order, and each commit's blob is
unwrappable by the time that commit is the next one it can apply.

The MLS control envelope stays ids-only. This is the transport frame, not the AAD.

**Resolution and catch-up.** The peer supplies the resolver the host wires into
`GroupHandleParams.resolveLedgerEntries`. It serves from the bodies unwrapped from the
in-flight frame; on a miss — external-commit rejoin, or a trimmed backlog — it gathers the
missing ids from current members over the encrypted app lane. Serving a gather needs one
new `GroupMLS` method:

```ts
getLedgerEntries(ids: Array<string>): Promise<Array<string>>  // signed tokens, from handle.ledger
```

The requester re-verifies every returned token and checks each digest against the id it
asked for, so a lying responder can only fail to answer, never inject.

**Redelivery contract.** `peer.ts` today ends inbound handshake processing in a bare
`catch` that never acks, so *any* permanently-failing commit is redelivered forever.
Inbound commits are classified:

| Outcome | Action |
|---|---|
| Applied | ack |
| Stale / already-superseded epoch | ack, drop, run the D1 fork check |
| Malformed, or policy-rejected (`CommitRejectedError`) | ack — poison, never retry |
| `MissingLedgerEntriesError` | **do not ack**; gather the missing ids, bounded retries; on exhaustion, ack and escalate to `recover()` |

`MissingLedgerEntriesError` remains the one retryable outcome, and it is now the rare one.

## Component boundaries

| Component | Owns | Does not |
|---|---|---|
| `hub-server` / `hub-protocol` / `hub-tunnel` | Per-topic head, conditional publish, `HeadMismatch` | Read payloads; know what a commit is |
| `mls` | Group state, authority, `ledger_head`, ledger tokens, GroupInfo sealing/opening | Transport; ordering across peers |
| `rpc` (`GroupPeer`) | Commit CAS loop, retry/rebase, body framing, resolver, gather, fork detection, heal trigger | MLS state; entry semantics |
| Host (kubun) | Persist handle state; author entries; app-level reducers | Ordering, authority, integrity, body distribution |

## Non-goals

- No change to the authority model, the roster, `ledger_head`, or the commit policy.
- Host reducers (`circle.def`, `circle.member`, `group.settings`) stay in the host. kumiai
  orders and authorizes entries; it never interprets them.
- Nothing here needs the `app` slot of `ControlEnvelope`.
- Full-device-loss recovery (no MLS state at all) is out of scope; such a member is
  re-invited.
- Hub-partition DoS is out of scope.

## Testing

- **Hub CAS.** Two publishes at the same head: one accepted, one `HeadMismatch`, nothing
  stored for the loser. Empty-topic sentinel. Head survives a trim.
- **Concurrent commits.** Two admins commit at epoch N against a shared hub: one wins,
  the loser rebases and its entries land in a later commit. No fork, no lost entries.
- **First-delivery resolution.** Three-member group, an admin enacts an entry, the third
  member has never seen the body: it applies the commit on first delivery, no gather.
- **Offline catch-up.** A member offline across several enacting commits reconnects and
  converges with no host-side backfill code.
- **Sealing.** A responder's reply opens for the requester and fails to open for every
  other member and for the hub. A reply replayed at another member or another request is
  rejected by the AAD check. A removed member's request is refused.
- **Redelivery.** A commit with unresolvable bodies is retried, not acked; a malformed
  commit is acked once and never redelivered.
- **Fork heal.** A simulated lying hub double-accepts; the lower-sequenceID branch wins,
  the loser rejoins by external commit, and its entries are re-enacted.

## Acceptance

- A host writes no ordering, no authority, no integrity, and no body-distribution code —
  and no body store.
- Two admins enacting entries concurrently converge, with no permanent fork and no lost
  entries, against an honest hub.
- A third member who has never seen an entry body applies the enacting commit on first
  delivery.
- A member offline across several enacting commits catches up on reconnect over the lane.
- `GroupMLS.exportGroupInfo` is implementable by a host without leaking group state to the
  relay.
- A permanently-failing commit is acked and never redelivered forever.
