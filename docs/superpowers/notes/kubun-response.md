# Kubun's response to the permission-work impact note

**Status:** ephemeral working note. Written 2026-07-10 against `kubun-impact.md` (kumiai `feat/mls-permission-enforcement` @ `fa38c32`) and kubun `feat/peer-connect-abstraction` @ `1d19644e`.

Direction agreed. Kubun will not pre-emptively migrate. Five items below; **2 and 3 are API-shape decisions that get more expensive the later they land**, and 3 comes with a bug you can use as its justification.

---

## 1. Question 2.5, answered: no. Drop `capabilityChain`.

Kubun does not depend on group capabilities for anything beyond membership.

- `parentCapability` appears nowhere in kubun.
- `groupAnchorCapabilities()` is called at exactly two sites: group creation (`groups/manager.ts:172`) and join (`context/join.ts:26`).
- `rootCapability` is persisted (`groups/mls-state.ts:20,33`) for one purpose: restoring the MLS handle (`groups/mls-group-handle.ts:10` → `restoreGroup`). Nothing reads it to authorize anything.
- Per-document write delegation (`groups/store-received-grant.ts`, `packages/store-delegation`) is a separate axis. Its tokens do not chain from the group root.

So if the admin-signed `group.role` roster subsumes membership proof, `Invite` can drop `capabilityChain` outright. The relay item's remaining requirements — bound the chain depth, design transitive revocation — exist only because the chain is load-bearing, and dissolve with it. They are marked contingent in `plans/next/2026-07-10-member-relay-invite.md`.

## 2. The shared `LedgerEntry` must keep a host-defined ordering field

The impact note has kubun deleting `groups/ledger-entry.ts` and importing `signLedgerEntry`/`verifyLedgerEntry`, while keeping "the HLC clock" — and separately says kumiai's ledger "has no clock, it orders by the MLS epoch chain."

Those are in tension. Kubun's entry is `{ type, subject, value, hlc }`, and **every** kubun application fold evaluates authority *at the entry's own HLC*, not at fold time: `isAdminAtHLC` (`groups/admin-roster.ts:208`), `isOpenAtHLC` (`groups/circle-reducers.ts`), and the circle-member rule that composes them. Four sub-ledgers depend on it: `admin.role`, `circle.def`, `circle.member`, `group.settings`.

If the exported entry type drops `hlc` in favour of epoch ordering, kubun cannot reuse it and the deletion in the table does not happen. Please keep `hlc`, or add a generic opaque ordering slot that kumiai ignores the way it will ignore `app`. Kubun does not need kumiai to *interpret* the field — only to sign over it and hand it back.

## 3. If `foldLedger`/`LedgerReducer` move into the library, cross-ledger dependencies become the library's problem to name

This is not hypothetical. Kubun shipped a fold rule this week where `circle.member` authorization depends on the `group.settings` sub-ledger (a self-join is valid only if the circle was open at the entry's HLC). A code review found the defect:

- Each entry type has its own projection and its own watermark.
- The single-frame ingest path reprojects **only** the sub-ledger the arriving entry belongs to (`groups/broadcast.ts:717-793`).
- Deliver `M` (self-join @hlc 100) before `S` (settings open the circle @hlc 50) and `M` is folded against empty settings, dropped as unauthorized — and the watermark advances anyway. `S` then reprojects settings only. Nothing re-triggers the member projection. A re-broadcast of `M` is a digest duplicate and reprojects nothing.
- Two peers with identical ledgers hold permanently different projections. Only a full catch-up heals it.

**Your `admin.role` dependency has exactly this shape already**: `circle.def`, `circle.member`, and `group.settings` all gate on `isAdminAtHLC`, but an `admin.role` grant arriving after an admin-issued entry reprojects only the roster, dropping that entry permanently.

The lesson for the library API: a `LedgerReducer` whose `verifyAuthority` reads state derived from *another* entry type cannot be safely driven by a per-type incremental applier unless the dependency is declared. Two ways out:

- Don't expose incremental apply at all — make `foldLedger` full-replay only, and let hosts cache.
- Let a reducer declare `dependsOn: Array<entryType>`, so the host knows which arrivals invalidate which projections.

Either is fine. Silence is not: every host will re-implement the trigger, and get it wrong the same way we did. Kubun is fixing its instance now; the fix is host-side today, but the abstraction is about to become yours.

## 4. "A relay must be an admin" — is `admin` the right granularity?

If `add` requires `admin` in the roster, then every device that can onboard a joiner can also evict any member. Consequences:

- A plain member can never invite anyone. Not a bug, but a product-visible policy.
- Any CLI or hub that onboards joiners must be trusted with eviction.

For shopping-lists this is inert — the CLI creates the group and is its admin. But kubun's open-circles design deliberately pushed *circle* entry down to the joiner precisely so that onboarding would not require trusting the onboarder with authority over others. Making `add` admin-only pulls that trust back up.

Is there room for an `invite` permission distinct from `admin` — Add without Remove? If the spec already intends this, say so; if it doesn't, this is the one place the design narrows something kubun wanted open.

## 5. Invite-seeded ledger completeness: omission, not forgery

`Invite` gains `ledgerEntries`; kubun already folds them at join (`context/join.ts:88-92` → `applyInviteControlState` → `applyLedgerEntries`). Every entry is individually signed, so a malicious inviter cannot forge one.

It can **omit** one. Drop the entry revoking Mallory's admin and the joiner folds a stale roster that disagrees with every other peer, permanently, with no signature check able to notice — absence has no signature.

If entries ride commits' `authenticatedData`, the joiner can in principle validate the batch against the epoch chain and detect gaps. That property is what makes invite seeding safe, and it should be stated in the spec rather than left implicit. Kubun has the identical hole today, so this is us reporting our own bug as much as reviewing yours.

---

## Confirmations

- **`authenticatedData` is unused in `plugin-p2p`.** Grep is empty. Claiming it for `ControlEnvelope` costs kubun nothing.
- **`Invite.recipientDID` matches what kubun already enforces by hand**: `serveGroupInvite` throws when `joinRequest.did !== callerDID` (`context/peer.ts:124`). Same semantics, better placed.
- **`GroupPermission` narrowing to `admin | member` is source-compatible.** Kubun imports the type at `groups/manager.ts:9`; the only invite site passes `'member'`. Kubun's `'read' | 'write'` axis is per-document and untouched, as your note says.
- **Cross-group replay is real in kubun today.** `LedgerEntry` (`groups/ledger-entry.ts:20`) has no `groupID`; `foldAdminRoster` seeds `{anchor.creatorDID}` and accepts any entry whose issuer is in the set. Two groups, one creator, entry lifts verbatim. Filed kubun-side; your `groupID` binding is the fix. Please make the mismatch drop non-throwing and logged — kubun folds hostile input on the ingest path and must not abort a batch.

## Two things kumiai does not fix, which kubun owns

- **HLC backdating.** Your note flags it; kubun confirms it and it is worse than the note suggests. `foldAdminRoster.verifyAuthority` is `state.admins.has(verified.issuer)` over entries sorted by HLC (`groups/admin-roster.ts:38-39`). A demoted admin signs "grant Mallory admin" claiming an `hlc` from when it still held the role; the fold reaches that point with the issuer still in the set and applies it. The later revoke does not remove Mallory. **A demoted admin can retroactively promote anyone, permanently.** Kumiai is not exposed because the protocol assigns epoch order rather than the signer asserting it — which is precisely the property kubun's HLC ledgers lack. Filed kubun-side.
- **`groupID` backfill** on existing persisted application-ledger entries. Kubun's call.
