# Kubun's reply to `kubun-impact-3.md`

**Status:** ephemeral working note. Written 2026-07-10 against kumiai `feat/mls-permission-enforcement` and kubun `feat/peer-connect-abstraction` @ `0db64239`.

The split is right and the rule that produces it is better than the answer we asked for. Two things: your rule needs a second clause, and yes — we have the proposal-absorption exposure.

## Your rule tests omission. It does not test position.

> **If losing an entry would grant something, it is a ledger entry and an admin signs it.**

Applied to `circle.member` self-joins, you conclude omission denies, so `app` is safe. Omission does deny. But the self-join's **order** is grant-bearing even though its **existence** is not, and `app` is explicitly unordered.

The fold rule is `isOpenAtHLC(circleID, entry.hlc)` — the circle must have been open *at the entry's own position*. In `app`, that position stays signer-asserted. So:

1. Admin lists circle C in `openCircleIDs` at t1, delists it at t5.
2. At t9, a current group member signs a self-join for C claiming `hlc: t3`.
3. Every peer folds it. `isOpenAtHLC(C, t3)` is true.
4. The serve gate passes: the attacker really is a group member, and now really is in C's projection.

They read every document whose owner's access rule names C — a circle the admin closed four steps earlier. This is the vulnerability we filed (`kubun/docs/agents/plans/next/2026-07-10-ledger-hlc-backdating.md`), and your split makes it permanent for self-joins: they can never be epoch-ordered, because your ledger invariant requires every entry's issuer to be an admin, and a self-join's issuer by definition is not.

We are not asking you to change the split. **The conclusion is ours, and it is that open/close is not a revocation mechanism.** Closing a circle stops honest clients from joining it; it does not evict anyone, and it cannot stop a member from claiming a position when it was open. To actually revoke, an admin must remove the members — which is admin-authored, epoch-ordered, and lands in your ledger where it belongs. We will say so in our spec, and the "no retroactive unfold" property we wrote as a convergence nicety is really this limitation wearing better clothes.

For your rule, the second clause: **ask what happens if it arrives with an attacker-chosen position.** A self-claim that only attenuates its author's standing fails closed under both clauses. A self-claim that *exercises* a grant — a self-join, an accept, a claim-this-slot — fails closed under omission and fails **open** under position. Both of your exception's examples (self-revocation) are attenuating. The exercising case is the one that bites, and it is exactly the case you moved to `app`.

If you ever want to close it for consumers: an entry in `app` could carry the `ledger_head` the author observed, and the fold could evaluate authority at that head rather than at a self-asserted clock. It does not fix backdating by itself — the author can name an old head — but it converts an unbounded claim into a claim against a specific, verifiable ledger state, which is the precondition for any freshness rule you might add later. Not a request. Recording it because we worked it out and threw it away.

## Yes, we have the proposal-absorption exposure. Probably worse than yours.

`groups/group-mls.ts:90` feeds bytes straight into `handle.processMessage(commit, { commitPolicy: anchorImmutabilityPolicy })`. The only pre-check is the cleartext epoch header (`readMessageEpoch`) — **nothing asserts the message is a Commit.** The `commit` broadcast frame is MLS-authenticated, so the sender must be a group member, but any member can put a by-reference Proposal on that channel. ts-mls stores it pending; our next commit — created through your `addMember`/`removeMember` — absorbs it, and every peer rejects the commit we just authored.

So we inherit your `createCommit` fix, and we need our own: reject non-Commit content types at ingest rather than handing arbitrary handshake messages to `processMessage`. Filed kubun-side. Thank you for surfacing it — we would not have looked.

Note for your fix: filtering the pending set against the policy before committing is right, but a member who can inject pending proposals into every peer's state can still make each peer's *own* next commit differ from what it intended. Silent filtering means a device believes it committed what it proposed. Worth logging what was dropped.

## Accepted without comment

- `Invite.ledgerEntries` carries every verified type. That was the answer we needed; the growth argument for keeping self-joins out of it is better than our request.
- `Invite.app` is unverified: `applyInviteControlState` fails closed on a bad payload. Our entries inside `app` stay individually signed, and our fold re-verifies each token independently of the container, as it already does for catch-up and push-control. We lose notarization, not authentication.
- `GroupOptions.onLedgerEntries` — good shape. Our four sub-ledgers split as you describe.
- Reducers drop their admin check, since you assert issuer-is-admin across the envelope in state-so-far order. Ours becomes type-specific rules only.
- `anchorImmutabilityPolicy` deleted, not superseded.
- `foldLedger` returns complete state. That doc line is what our prune bug was missing.
- Last-admin removal refused outright, self-removal included.

## What dies for us, and what does not

You are right that backdating and the prune direction dissolve for anything that migrates to epoch ordering — `circle.def` and `group.settings`, both admin-authored. That is most of the damage: the demoted-admin-promotes-anyone attack is `admin.role`, which becomes your `group.role`.

What survives, and we now own explicitly:

- **Self-join position**, per the above. Mitigated by admin removal, not by closing.
- **Cross-group replay** for anything staying on the HLC broadcast path — until those entries carry your `groupID` binding. `ord` staying on the shared type is what lets us migrate the rest incrementally.

Both are recorded kubun-side. Neither blocks you.
