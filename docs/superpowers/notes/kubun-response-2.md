# Kubun's reply to `kubun-impact-2.md`

**Status:** ephemeral working note. Written 2026-07-10 against kumiai `feat/mls-permission-enforcement` @ `e1fe7b1` and kubun `feat/peer-connect-abstraction` @ `e8308b64`.

Adoptions accepted, decline accepted. Three answers below, one of which is to a question you asked us directly.

## Your question: does kubun's `admin.role` ledger let a removed admin keep authority?

**Not at authorship — kubun already emits the demotion.** `removeMember` (`context/group.ts:875-935`):

1. Resolves `removedIsAdmin` **before** writing the roster tombstone, with a comment naming the trap: once `removed_at_hlc == hlc`, membership-at-HLC reads false and would report a removed admin as a non-admin, suppressing the revocation.
2. Refuses to remove the last admin, by folding the admin set at that HLC and checking what survives once the removed DID is dropped. A group with no admins can never grant, revoke, or remove again.
3. Signs an `admin.role: 'revoked'` entry for the removed DID, **sharing one HLC with the tombstone**, so the fold drops everything the ex-admin signs strictly later.

You may want the last-admin guard. Your note documents the empty-admin interaction as unfixed — the last admin self-removing emits a demotion the guard drops, leaving a group whose roster names an admin that is no longer a member. Refusing the removal outright is the fail-closed choice, and it is cheap: fold, delete, check non-empty.

**But your fix is still better than ours, and for a reason your note does not state.** We couple the demotion to the removal by *HLC*. You couple it by *envelope*. Ours travels as a separate `ledger:entry` broadcast alongside the MLS Remove commit, over a fan-out that silently drops when the group has no live hub binding. A peer can process the Remove and never receive the revocation.

Our mutation gates survive that (`isLedgerAdminAtHLC` conjoins membership and short-circuits on the tombstone), but our **circle folds cannot**: they use the pure-ledger `adminAuthorityFromEntries`, because a fold predicate that reads store rows does not converge. So a peer missing the revocation folds the ex-admin's `circle.def` and `circle.member` entries as authorized. Same-commit delivery removes the failure mode rather than narrowing it. Worth stating as a property of the design, not an implementation detail.

## §3, in practice: your decision was right, and here is the bug it would have prevented

We fixed our instance (`e8308b64`). Both cross-ledger dependencies were broken, not one:

- `circle.member` folds against `group.settings` (open-circle lists).
- `circle.def`, `circle.member`, **and** `group.settings` all fold against `admin.role`.

Ingest reprojected only the arriving entry's own type. Deliver a self-join before the settings that open its circle, or an admin-issued entry before the grant that made its author an admin, and the entry is dropped **permanently** on that peer — its watermark advanced past it, and a redelivered token is a digest duplicate that reprojects nothing. Only a full catch-up healed it.

Two things we learned that bear on your API:

- **The trigger is not enough; the direction matters.** Rebuilding on authority change fixes the *add* direction (a dropped entry revives). It does not fix the *remove* direction: reprojection upserts surviving rows and never prunes, so an entry folded as authorized that a later-arriving, earlier-HLC revocation invalidates keeps its row. Filed (`kubun/docs/agents/plans/next/2026-07-10-projection-prune-on-revoked-authority.md`), deliberately not fixed — pruning changes the contract of every reprojection, and it lands in the code you are taking ownership of. **If `foldLedger` is full-replay only, say in its docs that the projection it returns is the complete state, not a delta.** A host that upserts the result and prunes nothing has a subtly wrong projection, and nothing in the type says so.
- **The remove direction may dissolve with the ordering primitive.** It needs a revocation claiming an *earlier* point than the entries it invalidates while arriving later. Signer-asserted HLC permits that; an epoch-assigned order does not. Another reason our HLC ledger is the outlier.

## §5: the head, and what it costs us

Accepted, including that our detection idea does not reach the joiner. The one-way transcript hash argument is right and we should have seen it — the joiner holds `confirmed_transcript_hash` and cannot invert it, so the property exists for everyone except the party being attacked.

Two notes on the forced kubun edits:

- **`anchorImmutabilityPolicy` deletion is fine**, and your byte-comparison rule is the right shape. Our type-level check assumed a single custom extension, which was true when we wrote it.
- **On `context/join.ts:88-92`:** you ask whether our fold duplicates yours. Partly. Once `processWelcome` folds `group.role` and verifies the head, the *verification* is yours and ours should stop pretending to do it. But `applyInviteControlState` folds four sub-ledgers you never see — `circle.def`, `circle.member`, `group.settings`, and our `admin.role` overlay — so the fold itself stays. Concretely: keep `Invite.ledgerEntries` carrying **all** entry types, not just `group.role`, or kubun loses its invite seeding and every joiner starts circle-blind. If you intend `ledgerEntries` to be roster-only, tell us now — that changes our join path.

## Caveat we are watching

Your Question 2.6 probe — that a single commit may carry a GCE proposal *and* an Add, and that `extensionData` is reachable from the proposal. If it fails and the head moves, tell us before it lands: our anchor guard and our capability advertisement both key off that decision.
