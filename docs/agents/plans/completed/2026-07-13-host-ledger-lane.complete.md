# Host requirements: the control-ledger lane

**Priority:** 2 — blocks kubun from becoming a pure consumer of the 0.2 control ledger; R3 is a soundness question, not a convenience.
**Origin:** kubun's adoption of `@kumiai/mls` 0.2 permission enforcement (kubun `feat/peer-connect-abstraction`, 2026-07-12). Kubun is the first host to drive the control ledger end to end; these are the gaps it hit.

## Context

`@kumiai/mls` 0.2 made the control ledger authoritative: a commit's envelope names the entries it enacts, `foldEnvelope` refuses any commit whose entries were not admin-authored at their own position, and `ledger_head` chains the enacted ids into the GroupContext. That core is sound and complete.

What it does not do is get an entry *body* from the author to the other members. The envelope is cleartext AAD and deliberately carries ids only, so a receiver that has never seen a body cannot resolve it and throws `MissingLedgerEntriesError`. The library leaves that to the host via `GroupOptions.resolveLedgerEntries` — but every host will need the same thing, and getting it wrong is not a local mistake: a member that cannot resolve an entry cannot apply the commit that enacts it, and stalls permanently.

Kubun built that rail by hand (a `control/ledgerEntry` broadcast event, a `control/ledgerCatchup` gather, a body store, and a publish-bodies-before-the-commit ordering rule). None of it is kubun-specific. It is the id→body half of a design kumiai owns, and it belongs here.

## Already present — do not rebuild

Listed so this work does not duplicate 0.2. Kubun's migration initially missed several of these and re-implemented them; the fix on the kubun side is to consume them.

| Capability | Where |
|---|---|
| Commit envelope (ids, fold order, versioned) | `envelope.ts` — `ControlEnvelope`, `encode`/`decodeControlEnvelope` |
| Authority: issuer must be admin at its own position | `envelope-fold.ts` — `foldEnvelope` |
| Integrity: enacted ids chained into GroupContext | `head.ts` — `ledger_head`, `extendHead`, `computeHead` |
| Receiving-side commit gate | `policy.ts` — `defaultCommitPolicy` |
| Ordered ledger log, with ids and verified forms | `GroupHandle.ledger` — `Array<LedgerLogEntry>` |
| Accepted-commit entry sink for the consumer | `GroupHandleParams.onLedgerEntries` |
| Body resolution hook | `GroupHandleParams.resolveLedgerEntries` |
| Enact arbitrary-typed entries on a commit | `commitLedgerEntries` |
| Current roster | `GroupHandle.roster` |

A host that uses all of these writes no ordering code, no authority code, and no integrity code. That is the target state.

## R1 — Ship the ledger body lane in `@kumiai/rpc`

**Required.** The lane is transport, so it belongs in `rpc` beside the handshake and recovery lanes, not in `mls` (which has no transport and must not grow one).

`createGroupPeer` already runs internal lanes the consumer never sees. The ledger lane is a third one, gated on a new optional port:

- **Host port.** A `GroupLedger` port supplying body persistence: fetch bodies by id, store bodies, and enumerate what the host holds for a group. The host backs it with its own database; the peer owns the protocol and the ordering rules.
- **Distribution.** On `localCommitted`, the peer publishes the bodies the commit enacts *before* it fans the commit out on the handshake topic, so a receiver's `resolveLedgerEntries` can succeed on first delivery. This ordering rule is the whole point of moving the lane here: today each host has to know it, and a host that gets it backwards strands its peers.
- **Resolution.** The peer exposes a resolver the host wires into its `GroupHandle` as `resolveLedgerEntries`: serve from the host's store, and on a miss, gather the missing bodies from current members over the lane. Kubun's `control/ledgerCatchup` becomes this.
- **Redelivery contract.** `MissingLedgerEntriesError` must remain a *retryable* outcome, distinct from a corrupt or policy-rejected commit. A host that cannot resolve on this delivery must be able to leave the commit unacked so the hub redelivers, without the peer treating the commit as poison. Document this; kubun had to discover it by stranding a member.

Kubun's implementation (`packages/plugin-p2p/src/groups/broadcast.ts`, `group-protocols.ts`) is a working reference for the protocol shape and the gather semantics — every member replies with its entries, the requester re-verifies every token.

## R2 — `GroupMLS.exportGroupInfo` is not implementable as contracted

**Required.** `@kumiai/rpc`'s `GroupMLS` port contracts:

> `exportGroupInfo(requesterDID)` — Export current group state for a recovery responder, **sealed to the requesting member's MLS leaf so only that requester (not the hub, not other members) can open it.**

`@kumiai/mls` exports `exportGroupInfo({ group })`. It takes no requester and performs no sealing; the result is a plain framed `MLSMessage(GroupInfo)` carrying the ratchet tree and `external_pub` — enough for anyone who sees it, including the relaying hub, to mount an external join.

There is no sealing primitive in `mls`, so no host can satisfy the `rpc` contract. Kubun's `GroupMLS` implementation therefore fails closed: its `exportGroupInfo` throws rather than hand the hub a usable GroupInfo, and its `applyRecovery` is likewise unwired. **Deep recovery is dead for every host today.**

Resolve one of two ways:

1. **`mls` grows the sealing primitive** — `exportGroupInfo` takes the requester's DID, resolves that member's leaf, and seals the GroupInfo to it. The `rpc` contract then holds as written. Preferred: the contract is the right one, and the alternative leaks group state to the relay.
2. **The `rpc` contract drops the sealing claim** — and the recovery lane is explicitly documented as exposing the ratchet tree to whatever carries it, with hosts told not to run it over an untrusted relay. This is a downgrade and should only be chosen if sealing is genuinely out of reach.

This is not a kubun preference. Until it is resolved, the `GroupMLS` port asks hosts for something the library cannot give them, and every host either leaks or stubs.

## R3 — Concurrent commits fork the group

**Required — decide before R1 is implemented; kubun's control-plane design depends on the answer.**

kumiai's commit model is apply-then-announce: `localCommitted` is documented as announcing "a Commit the consumer just produced (and already applied locally)". With one committer that is fine. With two, it is not.

Two admins both at epoch N each author a commit, apply it locally, and fan it out. Each receives the other's commit at what is now, for them, a stale epoch. Neither can apply it. Both are at epoch N+1 with **different** states. This is not a lost race a loser can retry — it is a group fork, and the only exit is the recovery lane, which R2 shows is not usable.

Today this is rare because commits are rare (invite, remove, promote). Kubun's next step moves its whole control plane — circle definitions, circle membership, group settings — onto `commitLedgerEntries`, because that is what makes the ledger authoritative and the host a consumer. That raises commit frequency by an order of magnitude and makes concurrent admin action ordinary rather than exceptional. **Kubun cannot make that move until forking has an answer.**

The two shapes worth weighing:

1. **Heal the fork.** Accept that forks happen, and make recovery work: fix R2, and give the peer a way to detect that it has forked (its commit was never echoed, or a peer rejects it at a stale epoch) and rejoin by external commit, discarding its own commit and re-enacting its entries on the healed state. Entry tokens are epoch-independent, so re-enacting costs nothing — the entries do not need re-signing. This keeps the apply-then-announce model.
2. **Prevent the fork.** Serialize commits per group at the hub: a commit is applied locally only once the hub has accepted it as the successor to epoch N, and a peer that loses discards its unapplied commit and rebases before retrying. This makes the hub a sequencer for the handshake topic rather than a blind mailbox — a real change to what the hub is, and it needs weighing against the hub's blind-relay property.

Shape 1 is smaller, preserves the hub's blindness, and heals whatever forks already occur in production. Shape 2 removes the failure mode instead of recovering from it. Either is workable; the choice is kumiai's to make, and R2's resolution is a prerequisite for shape 1.

## Non-goals

- No change to the authority model, the roster, `ledger_head`, or the commit policy. They are sound.
- Kubun's app-level reducers (`circle.def`, `circle.member`, `group.settings`) stay in kubun. kumiai orders and authorizes entries; it never interprets them.
- Nothing here needs the `app` slot of `ControlEnvelope`.

## Acceptance

- A host implements only a `GroupLedger` body store and its own reducers. It writes no ordering, no authority, no integrity, and no body-distribution code.
- A three-member group where an admin enacts an entry: the third member, who has never seen the body, applies the commit on first delivery.
- A member offline across several enacting commits catches up on reconnect, over the lane, with no host-side backfill logic.
- `GroupMLS.exportGroupInfo` is implementable by a host without leaking group state to the relay (R2), or its contract says plainly that it does not.
- Two admins enacting entries concurrently converge — no permanent fork, no lost entries (R3).
