# MLS group permission enforcement + control ledger

**Date:** 2026-07-09
**Origin:** `docs/agents/plans/next/2026-07-07-mls-permission-enforcement.md` (June 2026
enkaku audit merged with the 2026-07-02 kumiai audit, commit `bb343d9`), milestone
`milestones/2026-07-audit-remediation.md`.

## Problem

`GroupPermission` travels in group capabilities but is never enforced on MLS operations.
Absent a caller-supplied `commitPolicy`, `processMessage` accepts add and remove commits
from any leaf: a non-admin member can remove members and every peer accepts it.
`processWelcome` additionally trusts inviter-controlled fields — it never checks the
validated capability's `aud` against the joining identity, and copies `invite.permission`
verbatim into the stored `MemberCredential`, so a token granting a lesser permission can
yield a locally trusted `admin` credential.

Enforcing a committer's permission requires every member to resolve *committer leaf → DID →
permission*. Today `MemberCredential` is local state, never distributed. That missing
distribution channel is the whole of the design work; the rest is mechanical hardening.

## Constraints discovered

Two facts about ts-mls (`2.0.0-rc.13`) decide the shape of the solution.

**`IncomingMessageCallback` is synchronous.** Its signature is
`(incoming) => IncomingMessageAction` (`incomingMessageAction.d.ts:6-13`) — not a promise.
No DID resolution, token verification, or network lookup can run inside it. Enforcement
must be decidable from local, already-verified state.

**`authenticatedData` is cleartext but authenticated.** `PrivateMessage.authenticatedData`
is a plaintext field of the framed message (`privateMessage.d.ts:10-17`), readable before
decryption, yet covered both by `PrivateContentAAD` (so tampering breaks the AEAD) and by
the signed `FramedContentTBS`. `createCommit` and `joinGroupExternal` already accept it.

Consequences: an out-of-band async permission lookup is impossible, and anything ridden in
`authenticatedData` is visible to the delivery service.

## Prior art: kubun

`kubun/packages/plugin-p2p` (a downstream consumer of `@kumiai/mls`) has already built most
of this layer for its own application-level control operations:

- `groups/group-anchor.ts` — custom GroupContext extension `0xf100` baked at `createGroup`
  carrying `creatorDID`. Immutable, authenticated by the GroupInfo signature, so every
  joiner reads the same epoch-0 admin. Ships `groupAnchorCapabilities()` (a member leaf must
  advertise the extension type per RFC 9420) and `anchorImmutabilityPolicy` (rejects any
  `group_context_extensions` proposal).
- `groups/ledger-entry.ts` — `signLedgerEntry` / `verifyLedgerEntry` / `ledgerEntryDigest`.
  A signed claim `{type, subject, value, hlc}`; issuer is the verified `iss`; the id is a
  multibase SHA-256 multihash over the token bytes.
- `groups/ledger-fold.ts` — `LedgerReducer` + `foldLedger`. Seeds from the anchor, sorts by
  a total order, and evaluates each entry's authority **against the state accumulated from
  strictly-earlier entries, never the final state**. That is what makes rotation sound: an
  admin may revoke the very admin who granted them, without retroactively voiding their own
  earlier grants.
- `groups/admin-roster.ts` — `adminRosterReducer`, seeded `{admins: {creatorDID}}`, with
  `verifyAuthority: (verified, state) => state.admins.has(verified.issuer)`.
- Joiner bootstrap: ledger entries ride in the invite (`context/join.ts:91`).

Kubun does **not** have receiving-side commit authorization. `groups/group-mls.ts:90` and
`groups/mls-codec.ts:28` pass only `anchorImmutabilityPolicy`; the admin check happens at
the sender API (`context/group.ts:791`, before `removeMember`). That is the same
honest-client-only guard this spec exists to close, one layer up the stack.

## Approach

`@kumiai/mls` takes ownership of the generic authority layer. Kubun keeps the parts that
are genuinely application-specific.

| Piece | Today | After |
|---|---|---|
| `GroupAnchor` GroupContext extension | kubun, with kubun's `recoverySecret` field | `@kumiai/mls`, generic (`creatorDID`, `version`, opaque `app`) |
| `signLedgerEntry` / `verifyLedgerEntry` / `ledgerEntryDigest` | kubun | `@kumiai/mls` (depends only on `@kokuin/token`) |
| `foldLedger` / `LedgerReducer` | kubun, sorts internally by `(hlc, entryID)` | `@kumiai/mls`, ordering supplied by the caller |
| role reducer | kubun, `admin` / `revoked` over a `Set` | `@kumiai/mls`, `GroupPermission` (`admin` / `member`) over a `Map` |
| ledger persistence, HLC clock, `role`-column projection, broadcast fan-out | kubun (`P2PStoreAPI`) | unchanged, stays kubun |
| **default commit policy** | *nobody* | `@kumiai/mls` — new |

### Rejected alternatives

**A permission map inside a GroupContext extension.** Mutating it requires a
`group_context_extensions` proposal on every role change, which collides head-on with the
anchor immutability that kubun depends on, and grows the GroupContext without bound. (A
fixed-size *digest* in the GroupContext is a different proposition and is adopted below — see
"The ledger head". The objection was to the unbounded map, and to blanket anchor immutability,
which Q1.3 showed is unnecessary.)

**The capability chain embedded in the MLS leaf credential.** Distribution would be free and
self-authenticating, but a leaf is signed by its own owner, so no admin could ever demote
anyone — only the target could re-sign their leaf. Promote/demote is a requirement.

**An application-supplied async resolver (hub lookup).** Impossible: the callback is
synchronous. It would also make enforcement network-dependent and non-convergent — two
members could reach different verdicts on the same commit at the same epoch.

## Ordering: MLS epochs, not HLC

Kubun's ledger carries an `hlc` because it orders application control operations authored
offline and replicated by CRDT, with no MLS event to hang them on; `isLedgerAdminAtHLC`
must reconcile author and receiver on "was X admin at the moment X authored this op".

This ledger answers exactly one question — *is this committer authorized to make this
commit?* — and MLS already totally orders commits. Role entries therefore ride in the
`authenticatedData` of the commit that enacts them, and their position in the ledger is that
commit's position in the epoch chain.

Three properties follow:

1. **No clock.** No HLC, no self-reported timestamp, no tie-break heuristic. Fold order is
   the epoch chain, then position within the envelope's `entries` array.
2. **No divergence.** An authorizing entry arrives *with* the commit it authorizes, so
   acceptance is a pure function of (prior ledger, this message). Without this, Alice
   promotes Bob, Bob commits a Remove, and a Carol who has not yet received the promotion
   rejects the commit and forks.
3. **No backdating.** A self-reported `hlc` is a claim inside the signed entry. A member
   demoted at `t5`, who was admin at `t1`, can sign a revoke claiming `hlc: t1`; the
   state-so-far fold finds them admin at `t1` and applies it (`ledger-fold.ts:85-89`).
   Kubun's exposure here is unverified and out of scope for this spec — see Migration. An
   MLS-epoch position is assigned by the protocol, not asserted by the signer.

## The control envelope

`authenticatedData` is claimed by `@kumiai/mls` and given a structure. Consumers get an
opaque `app` slot.

```ts
/** Cleartext on the wire; authenticated by the AEAD AAD and the FramedContent signature. */
export type ControlEnvelope = {
  /** Unknown version ⇒ reject the commit. A client that cannot interpret
   *  authority-bearing data must not accept a commit that depends on it. */
  v: 1
  /** Content-addressed ids of the control-ledger entries this commit enacts, in
   *  fold order. Every entry is admin-issued and covered by `ledger_head`.
   *  Absent when the commit writes no ledger entries. */
  entries?: Array<string>
  /** Opaque consumer payload. Never verified, never ordered, never chained. */
  app?: Uint8Array
}
```

**Ids, not a digest.** Entry ids *are* digests (`ledgerEntryDigest`). Carrying the ordered
id list rather than one hash over the set costs a few dozen bytes and tells the receiver
exactly which bodies to await, how many, and in what order, while leaking nothing beyond
"this commit carries k control entries". Entry *bodies* never touch `authenticatedData`, so
the delivery service learns no member DIDs and no role changes.

**Body resolution.** `GroupOptions` gains
`resolveLedgerEntries?: (ids: Array<string>) => Promise<Array<string>>`, invoked in the async
pre-pass before `mlsProcessMessage`. Ids already held locally are free. Unresolved ids, or
no resolver, throw `MissingLedgerEntriesError { ids }` and leave the handle at its
pre-commit epoch; the caller fetches the bodies over the group's encrypted channel and
retries. New joiners bootstrap from `Invite.ledgerEntries`, as kubun already does.

**No `requires` field.** A list of authority-relevant entry types the commit depends on was
considered and cut. `v` alone gives fail-closed behaviour, and introducing an authority-
relevant entry type is exactly the occasion to bump `v`.

## The ledger head

Every entry is individually signed, so a malicious inviter cannot forge one. It can **omit** one.
Drop the entry demoting Mallory from `Invite.ledgerEntries` and the joiner folds a stale roster
that disagrees with every other peer, permanently. Absence has no signature.

The commit transcript already commits to every envelope — `ConfirmedTranscriptHashInput.content`
is a `FramedContentCommit`, and `FramedContent` carries `authenticatedData`
(`framedContent.d.ts:39`). So an *existing member*, who saw every commit, can detect a gap. A
*joiner* holds only the final `confirmed_transcript_hash` and cannot invert it. The party that
needs the property does not have it.

A second GroupContext extension, `0xf101`, carries a running hash over the ledger:

```ts
/** GroupContext extension 0xf101. Fixed size, rewritten on every role-changing commit. */
export type LedgerHead = { v: 1; head: Uint8Array }

// genesis, written by createGroup:
head₀ = SHA256(domainSeparator ‖ groupID)
// each commit whose envelope carries entries, in envelope order:
headₙ = SHA256(headₙ₋₁ ‖ id₁ ‖ … ‖ idₖ)
```

A hash **chain** over ordered ids, not a digest over a set. An existing member verifies a head
update by extending its own chain by the arriving ids — `O(k)`, no refold. A joiner recomputes
from the genesis constant across `Invite.ledgerEntries` in order and compares against the head it
reads from its GroupContext after `mlsJoinGroup`. Omission, reordering, and truncation all break
the recomputation. This is incremental *hashing*, not incremental *folding* — it does not reopen
the hazard that keeps `foldLedger` full-replay only.

**The head is not trusted because an admin wrote it.** It is trusted because the group would
otherwise have rejected the commit. Every receiving member checks the proposed head against the
chain extension it computes from its own ledger, and rejects on mismatch. It lives in the
GroupContext, not in GroupInfo, precisely because GroupInfo is signed by whoever exported it —
and for a Welcome that is the inviter, the party being defended against. The GroupContext enters
the confirmed transcript hash, so a lie forks the epoch.

The inviter's choice becomes: deliver the complete ledger, or the joiner refuses to join
(`LedgerIncompleteError`).

Three consequences.

**The anchor guard is a byte comparison, not a type check.** A `group_context_extensions`
proposal replaces the entire extensions list rather than patching one entry, so every head update
re-includes the anchor. A policy rejecting "any GCE touching the anchor type" would reject every
head update. The rule: the anchor extension must be present and byte-identical to the current
one, and nothing but `ledger_head` may differ.

**Leaf capabilities advertise both extension types.** RFC 9420 requires a member's leaf to
advertise every custom GroupContext extension type or the added leaf is refused. The helper
formerly called `groupAnchorCapabilities()` advertises `0xf100` and `0xf101`, at both
`createGroup` and `createKeyPackageBundle`.

**Head updates ride only role-changing commits.** An empty commit, an Update, a self-Remove
carries no entries, so no head change and no GCE proposal. Otherwise every member commit would
require `admin`, which is exactly the restriction we do not want. Symmetrically, a GCE proposal
that moves the head without a corresponding `entries` list in the envelope is rejected.

## Two slots: the ledger notarizes, `app` does not

The ledger carries entries of **any** type. `@kumiai/mls` interprets exactly one — `group.role` —
and for every other type it acts as notary and transport: it verifies the signature, binds the
entry to the group, orders it by the epoch chain, covers it with `ledger_head`, stores it, and
surfaces it to the consumer, which folds it with its own reducer through the exported
`foldLedger`. Transport and interpretation are different jobs, and only the second requires
understanding the type.

Alongside sits `app`: opaque bytes, unverified, unordered, uncovered by the head.

### Which slot?

**If losing an entry would grant something, it is a ledger entry and an admin signs it.**

That rule is the whole of the split, and it is not arbitrary — it is where omission stops being
safe. Consider what an omission actually does:

| Omitted | Effect on the joiner |
|---|---|
| a `group.role` demotion | grants stale admin authority to a demoted member |
| an admin entry closing a circle | grants: the joiner thinks it is still open, and folds later self-joins as valid |
| a member's self-join claim | denies: the joiner does not know the member is in the circle, and serves it nothing |

The dangerous omissions are exactly the admin-authored ones. A self-claim can only attenuate or
exercise its own author's standing, so losing it fails closed. The admin/member line is therefore
not an arbitrary place to draw the verification boundary — it is precisely where completeness
starts to matter.

This lands the authorization and its exercise in different slots, which is correct.
**The admin opens the circle** — a verified ledger entry, omission-detectable. **The member
exercises it** — an `app` payload, omission-safe. Kubun's open-circle design already relies on
this: its own spec concedes that the self-join premise ("the issuer is a group member") is not
ledger-derivable, cannot be verified by a fold, and cannot be enforced at ingest; enforcement
lives in the serve gate, local to the victim. Self-joins were never authority-bearing, and lose
nothing by living in `app`.

**The exception to watch.** A self-claim whose omission *grants* breaks the reasoning. The shape is
self-revocation — "X revokes X's own key" — where dropping it leaves peers trusting X. A consumer
that puts self-revocation in `app` has put grant-bearing state in the unverified slot. kumiai's own
revocation is admin demotion, so the library is consistent by construction; a consumer must apply
the rule for itself.

### The admin-issuer invariant

"The ledger is admin-authored" is enforced, not merely arranged. Without enforcement it would hold
only as a side effect of the GCE gate — and an admin could then carry a member-signed entry of an
app type, which kumiai, not knowing that type's rules, would store as verified.

So, while folding an envelope's entries in order, kumiai asserts that **every** entry's issuer is
an admin in the state accumulated from strictly-earlier entries, whatever the entry's type, and
**rejects the commit** if one is not. Not a silent drop: a non-admin entry in an envelope is
anomalous, and dropping it would leave `ledger_head` covering an entry the ledger does not hold.

It must be state-so-far and not a pre-commit snapshot, or an envelope carrying
`[promote Bob, entry-issued-by-Bob]` would fail. One pass, one rule: fold the roster across the
whole ordered list; every entry's issuer must be an admin at its own position; `group.role` entries
additionally mutate the roster.

The library therefore guarantees the invariant without understanding a single application entry
type.

### Type namespace

`group.*` is reserved for `@kumiai/mls`. An unknown `group.*` type rejects the commit — fail-closed,
like an unknown envelope `v`. Any other type is passed through to the consumer unread.

### Growth

`ledger_head` chains from genesis, so a joiner recomputes across every entry that ever rode an
envelope, and the ledger cannot be pruned without breaking the recomputation. Admin actions are
rare, so the un-prunable set is the small one — while per-member claims, which are not, live in
`app` and are prunable at will. A signed checkpoint (`(head, roster snapshot, count)` an admin
attests, letting a joiner start from it) goes to `backlog/mls-ledger-checkpoint.md`, to be designed
against a real growth measurement rather than speculatively.

## `LedgerEntry` must carry `groupID`

Kubun's entry is `{type, subject, value, hlc}` — nothing binds it to a group. `foldLedger`
seeds `admins = {anchor.creatorDID}` and accepts any entry whose issuer is in the set so
far. When one DID creates two groups (the common case for a real user), an entry from group
A reading *"creator grants Mallory admin"* can be lifted verbatim into a commit in group B.
Its issuer is B's creator, so B's fold accepts it and Mallory becomes an admin of a group
she was never promoted in. Content-addressing does not help: the bytes are identical, so the
id matches.

The generic `LedgerEntry` carries `groupID`, and `foldLedger` drops every entry whose
`groupID` differs from the group being folded.

```ts
export type LedgerEntry<TValue = unknown> = {
  type: string
  groupID: string
  subject: string
  value: TValue
  /** Consumer-supplied total-order key, signed with the rest of the claim.
   *  `@kumiai/mls` never reads it — its entries are ordered by the epoch chain
   *  and their position in the envelope. Kubun sets it to its HLC. */
  ord?: string
}
```

`ord` is a kubun requirement, not a speculative one. Every kubun application fold evaluates
authority at the entry's own HLC rather than at fold time — `isAdminAtHLC`, `isOpenAtHLC`, and
the circle-member rule that composes them — across four sub-ledgers (`admin.role`, `circle.def`,
`circle.member`, `group.settings`). Kubun needs the shared signer to cover the field and hand it
back; it does not need kumiai to interpret it, exactly as with the anchor's `app` slot.

`foldLedger` does not sort. It folds the entries in the order the caller supplies, because
the two consumers derive order from different places: kumiai from the authenticated epoch
chain, kubun from `ord` (its HLC) with the entry id as tie-break. Pushing the sort out of
the fold is what lets one fold serve both without kumiai taking a clock. `foldLedger` keeps
its other properties unchanged — pure, seeds from the anchor, evaluates authority against
state-so-far, drops rather than throws on an unauthorized or unrelated entry. The drop is
non-throwing by contract: kubun folds hostile input on its ingest path and must not abort a
batch.

### The fold is full-replay only

`foldLedger` takes the whole entry set and replays it. No incremental apply is exported, and no
per-type watermark.

This is a deliberate refusal, prompted by a defect kubun shipped and found in review. A reducer
whose `verifyAuthority` reads state derived from *another* entry type cannot be driven safely by
a per-type incremental applier. Kubun's `circle.member` self-join is authorized only if the
circle was open at the entry's HLC, which is a `group.settings` fact; deliver the self-join before
the settings entry and it folds against empty settings, is dropped as unauthorized, and the
watermark advances anyway. Nothing re-triggers the projection. A re-broadcast is a digest
duplicate and reprojects nothing. Two peers holding identical ledgers hold permanently different
state, healed only by a full catch-up.

kumiai has one reducer and no cross-ledger dependency, so its own roster fold is already a full
replay of `#ledger ∪ new` on every pre-pass. Exporting an incremental applier would hand every
host a footgun the library never needed. Hosts that want speed cache the projection themselves and
own the invalidation. If a future reducer genuinely needs cross-type authority, the fold gains a
declared `dependsOn` before it gains an incremental applier — not after.

**What `foldLedger` returns is the complete state, not a delta.** This is stated in its docs
because the type cannot say it and a host will otherwise get it wrong in one direction only.
Rebuilding a projection on authority change fixes the *add* direction — an entry dropped as
unauthorized revives once its author's grant arrives. It does not fix the *remove* direction: a
host that upserts the fold's result into a table and prunes nothing keeps rows for entries that a
later-arriving revocation invalidated. The projection is silently wrong, and nothing in the
signature warns you. A host replacing its projection wholesale is correct; a host merging into it
is not.

Kubun hit exactly this (`kubun/docs/agents/plans/next/2026-07-10-projection-prune-on-revoked-authority.md`).
Note that the remove direction requires a revocation claiming an *earlier* point than the entries
it invalidates while arriving later — which a signer-asserted HLC permits and an epoch-assigned
order does not. kumiai cannot reach the state; a host with a clock can.

## Roster and authority rules

`GroupPermission` narrows to `'admin' | 'member'`. The `'read'` level is removed — see
"There is no read-only member" below.

Roster state is `Map<normalizedDID, GroupPermission>`, seeded from the anchor as
`{creatorDID: 'admin'}`. The anchor is therefore load-bearing: `createGroup` always writes
it, and `createKeyPackageBundle` always advertises its extension type so an anchored group
can be joined. A handle whose GroupContext carries no anchor has no seed and cannot fold a
roster — `restoreGroup` and `processWelcome` throw rather than silently installing a policy
that would accept everything. Groups created before this change must be recreated; kumiai is
pre-1.0 and kubun writes the anchor already.

The role entry is `{type: 'group.role', groupID, subject, value: GroupPermission}`.
`verifyAuthority` is kubun's rule unchanged: the issuer must be an admin in the state
accumulated from strictly-earlier entries. Any admin may demote any admin.

Demotion is `value: 'member'`; kubun's separate `'revoked'` value disappears. One additional fold
guard: an entry that would empty the admin set is dropped, so the roster cannot be emptied.

### Removal demotes the removed

Leaving the MLS group is not, by itself, a roster operation — and that is a hole. The fold's
authority rule asks only whether the *issuer* was an admin in the state so far. A removed admin
therefore keeps ledger authority forever: it cannot commit, having no leaf, but a colluding
current member can carry its signed role entry in that member's own commit envelope, and every
peer folds it as authorized.

The blast radius is narrow — `add` checks the proposal's sender, so the colluder adds nobody, and
`external_init` demands a prior leaf the removed admin no longer has. What it yields is a roster
corrupted indefinitely by someone the group evicted. That reads as a defect in this spec, not as
a feature missing from `backlog/mls-capability-revocation.md`.

So: **a Remove of a leaf whose DID holds `admin` must be accompanied, in the same commit's
envelope, by a `group.role` entry demoting that DID to `member`.** A commit that removes an admin
without it is rejected. Removing a plain member needs no entry — the roster already says
`member`, so envelopes stay small.

Resolving the removed leaf's DID needs the *pre-commit* ratchet tree, which the pre-pass already
walks to map each proposal's `senderLeafIndex`.

Coupling the demotion to the removal **by envelope** rather than by timestamp is a property of the
design, not an implementation detail. The entry that strips authority arrives inside the commit
that strips membership, over the same authenticated channel, or neither arrives. Kubun couples the
two by HLC and ships the demotion as a separate broadcast, over a fan-out that silently drops when
a group has no live hub binding; a peer can process the Remove and never receive the revocation,
and its pure-ledger circle folds — which cannot read membership rows without diverging — then fold
the ex-admin's entries as authorized. Same-commit delivery removes that failure mode instead of
narrowing it.

**Removing the last admin is refused.** The empty-admin fold guard drops an entry that would empty
the admin set, which would leave the roster naming an admin who is no longer a member — the
inconsistency in miniature. The policy therefore rejects the Remove itself, self-removal included:
a last admin must promote someone before leaving. Fail-closed, and cheap — fold, drop the removed
DID, check the admin set is non-empty. A group with no admin can never add, remove, or promote
again, so an unrecoverable group is a worse outcome than a trapped admin who has one obvious way
out. (Kubun reached the same rule independently at `context/group.ts:875-935`.)

### The default commit policy

| Proposal | Required of the proposal's sender |
|---|---|
| `add` | `admin` |
| `remove` | `admin`, or self-removal (removed leaf == sender leaf). Removing an `admin` additionally requires a demotion entry for that DID in the envelope |
| `update` | nothing — MLS already binds an Update to its own leaf |
| `psk`, `reinit` | `admin` |
| `group_context_extensions` | `admin`; the anchor extension must be present and byte-identical to the current one; only `ledger_head` may differ; and the head must equal the receiver's own chain extended by the envelope's ids |
| `external_init` | committer DID ∈ roster, and the commit carries only `external_init` plus a Remove of that same DID's prior leaf |

A commit with no proposals (key rotation) is allowed to any member. Application messages are
never checked.

A commit whose envelope carries `entries` must also carry the matching `ledger_head` GCE
proposal, and a `ledger_head` GCE proposal without `entries` is rejected. The two move together
or not at all.

### The committer filters pending proposals

Receiver-side rejection alone lets any member stall the group.

ts-mls absorbs pending by-reference proposals into the next commit automatically
(`createCommit.js:111`). So a non-admin proposes a `group_context_extensions` — or an `add`, or a
`psk` — and the next member to commit, however innocently, has it folded into their commit. Every
peer evaluates that commit, finds a proposal whose sender lacks the permission for it, and rejects
the whole thing. The committer did nothing wrong and their commit is refused by the entire group.
Repeat the proposal and no epoch ever advances.

This is authenticated griefing, not a break: the proposal names its author, and an admin can
remove them. But the victim looks like the offender, and the group stalls until someone reads the
proposal set.

So the commit wrappers filter the pending-proposal set before calling `createCommit`, dropping any
proposal that the local policy would reject on receipt. Sender-side filtering, receiver-side
enforcement — the same division as the honest-client guards on `createInvite` and `removeMember`.
A modified client that skips the filter produces a commit the group refuses, which is the correct
outcome and costs only the modified client.

The filter runs against the same `defaultCommitPolicy`, so the two can never disagree.

### There is no `invite` permission

Kubun asked whether `add` should require full `admin`, or a narrower `invite` level — Add without
Remove — so that a hub or CLI could onboard joiners without being trusted to evict members.

It is enforceable, unlike `'read'`, so the argument that killed that level does not apply. It is
declined on cost. The roster's authority rule stops being "the issuer is an admin" and becomes
"an admin for any value, or an `invite` holder when the value is `member` and the subject is not
already in the roster" — the second clause existing solely to stop an inviter demoting an admin.
The `group_context_extensions` row acquires a matching exception, since an `invite` holder must
move the `ledger_head`. Two conditionals in the two places that most want one obvious rule, for a
level whose only named consumer (kubun's shopping-lists CLI) is the group creator and therefore
already an admin.

Invites are admin-only. Widening the union later is additive for value producers; the rule it
would complicate is the one we would rather keep simple until a topology demands otherwise.

### Per-proposal sender, not committer

`ProposalWithSender.senderLeafIndex` is per-proposal, because a commit may include
by-reference proposals authored by other members. Checking only the committer would let an
admin launder a non-admin's Remove by committing it. Each proposal is checked against
`p.senderLeafIndex ?? commit.senderLeafIndex`.

### External commits are resolved in the pre-pass

For an external-init commit `senderLeafIndex` is `undefined`, and the joiner's credential
lives in the commit's UpdatePath leaf rather than in `proposals` — the synchronous callback
cannot see who is committing. But `joinGroupExternal` emits a `PublicMessage`, which is
cleartext, so `processMessage` decodes it in the async pre-pass, resolves the path leaf's
DID, and hands the callback a precomputed verdict. This is the same hook
`backlog/mls-capability-revocation.md` needs: a revoked DID's resync is refused here.

### There is no read-only member

`GroupPermission` loses its `'read'` level. Two independent reasons.

It is unenforceable. A group member holds the epoch secrets — that is what membership *is*
in MLS. A `read` member derives the same application keys as anyone else and can encrypt a
valid message that every peer decrypts and accepts. No receiver can reject it on role
grounds without first decrypting it, and by then the sender has already demonstrated it
holds the key. MLS cannot express read-only membership. Shipping the level is a promise the
library cannot keep: a caller grants `read`, believes they created an observer, and did not.

It is also dead. `'read'` is produced in exactly one place (`credential.ts:91`) and named in
one type (`capability.ts:11`). No caller anywhere passes it — kubun's single invite site
passes `'member'` (`context/group.ts:626`), and its roster reducer only ever knew
`admin`/`revoked`. Kubun's own `'read' | 'write'` (`access-default-token.ts`, `broadcast.ts`)
is a different axis — per-document access — unrelated to `GroupPermission`.

Removing it makes every distinction the type expresses one the commit policy actually
enforces: `admin` gates add/remove/psk/reinit/gce, `member` may send and self-remove. Nothing
is left advisory. This resolves the origin item's third design-sketch point ("document
advisory semantics") by deleting the advisory semantics instead of documenting them. The
docs state plainly that observers do not belong in the group.

Cost: a breaking change to `GroupPermission` and one branch out of `extractPermission`
(`act: '*'` still maps to `admin`). Pre-1.0, one consumer, and that consumer never used the
value.

## Module layout

New files in `packages/mls/src/`:

- `anchor.ts` — `GroupAnchor` (`creatorDID`, `version`, `app?: Uint8Array`), extension type
  `0xf100`, encode/decode, `controlCapabilities()` (advertises `0xf100` and `0xf101`),
  `readGroupAnchor(handle)`.
- `head.ts` — `LedgerHead`, extension type `0xf101`, genesis constant, `extendHead(head, ids)`,
  `readLedgerHead(context)`, `LedgerIncompleteError`.
- `ledger.ts` — `LedgerEntry`, `VerifiedLedgerEntry`, `signLedgerEntry`,
  `verifyLedgerEntry`, `ledgerEntryDigest`.
- `fold.ts` — `LedgerReducer`, `FoldInput`, `FoldDrop`, `foldLedger` (full replay only).
- `roster.ts` — role entry type, `RosterState`, `roleReducer`, `foldRoster`.
- `envelope.ts` — `ControlEnvelope`, encode/decode.
- `policy.ts` — `defaultCommitPolicy`, `MissingLedgerEntriesError`.

`group.ts` changes in place. `capability.ts` keeps `GroupPermission` and loses the group
membership capability machinery, pending the consumer trace.

## `GroupHandle` changes

The handle holds `#roster: RosterState` and `#ledger: Map<entryID, VerifiedLedgerEntry>`.
Both are derived, never authoritative: the ledger is the source of truth, the roster is its
fold. `roster` gains a public getter. `applyLedgerEntries(tokens)` verifies, folds, and
merges — this is what kubun calls from its broadcast handler.

The ledger holds entries of every type, so the consumer needs them. `GroupOptions` gains
`onLedgerEntries?: (entries: Array<VerifiedLedgerEntry>) => void`, invoked **after** a commit is
accepted, with the entries that commit admitted, in fold order. It cannot influence acceptance:
application entry types never gate a commit, only `group.role` does. The consumer folds what it
receives with its own `LedgerReducer` through the exported `foldLedger`, and the entries it is
handed are already signature-verified, group-bound, admin-issued, ordered, and head-covered.

`ControlEnvelope.app` is surfaced the same way and carries none of those guarantees.

`processMessage` becomes three phases.

1. **Async pre-pass.** Decode the framed message. Read `authenticatedData` into a
   `ControlEnvelope`; unknown `v` rejects. Resolve `entries[]` bodies (ids already held are
   free); unresolved ⇒ `MissingLedgerEntriesError`. Verify each token and drop any whose
   `groupID` mismatches. Fold a *candidate* roster from `#ledger ∪ new`. For a
   `PublicMessage` external commit, resolve the UpdatePath leaf's DID and precompute its
   verdict.
2. **Sync callback.** Reads the candidate roster and the precomputed external verdict. A
   pure lookup with no I/O — all the `IncomingMessageCallback` signature permits.
3. **Commit.** Only on accept are `#state`, `#ledger`, and `#roster` assigned.

The candidate roster is folded *before* the commit is applied, which is the correct
semantics: a commit that promotes Bob and is itself authored by Bob must be judged against
the roster without his promotion.

On reject, or on any thrown verification, none of the three fields are assigned. Rollback is
simply not assigning — no state is mutated in place, so there is nothing to undo. This is
how the existing reject path already behaves (`group.ts:350-357`).

`decrypt` shares the same pre-pass, since it too may encounter a commit.

## The roster replaces the capability chain

Membership is today an Enkaku capability delegation chain rooted at the creator, carried in the
invite and validated once by `processWelcome`. Once every member holds an admin-signed,
anchor-rooted `group.role` entry, that chain is a *second* membership proof with strictly worse
properties: it grows one link per relay hop, has no total order, and has no revocation primitive.

It is removed. `Invite` becomes:

```ts
export type Invite = {
  groupID: string
  /** The DID this invite was minted for. Checked against the key package at commitInvite. */
  recipientDID: string
  inviterID: string
  /** The complete control ledger, every type, in fold order. Verified against
   *  `ledger_head`, so an inviter cannot omit an entry. */
  ledgerEntries: Array<string>
  /** Opaque host seeding. Unverified — an inviter may omit or corrupt it, and the
   *  consumer must be able to fail closed when it does. */
  app?: Uint8Array
}
```

`permission` leaves the invite too — it is a claim in the joiner's signed role entry, which is the
only place it can be trusted. Two sources that can disagree is how a confused deputy is built.

Evidence for the removal, gathered in Q2.5:

- Nothing that the chain proves is lost. Signature, group scoping, permission level, and
  root-from-creator are each carried by a signed role entry at equal or greater strength. The
  only chain-exclusive properties are `exp` (supported at `capability.ts:39,59-60`, set by no mint
  site, and out of scope here) and `jti` revocation (present in `@kokuin/capability`, never wired,
  and weaker than the roster's demotion, which the epoch chain orders).
- The `aud`-to-joiner binding is **not enforced today**. `capability.ts:28,55` mint it;
  `validateGroupCapability` (`capability.ts:95-124`) never reads it. The chain does not bind the
  capability to the joiner.
- The chain's entire authorization value is spent at one call site: `validateGroupCapability`
  inside `processWelcome` (`group.ts:587`).
- Kubun does not depend on group capabilities for anything beyond membership. `parentCapability`
  appears nowhere in it; `groupAnchorCapabilities()` is called only at create and join;
  `rootCapability` is persisted (`groups/mls-state.ts:20,33`) solely to restore the MLS handle.
  Per-document `document/write` grants are self-issued with a document `res` and no
  `parentCapability` (`kubun/…/context/group.ts:1349-1357`); read grants chain off the document
  owner (`sync/authorize.ts:33`). Neither touches a group capability.

`GroupHandle.rootCapability` and `MemberCredential.capabilityChain` / `.capability` go with it.
Kubun stops serializing `rootCapability` in `groups/mls-state.ts` and stops passing it to
`restoreGroup`.

`processWelcome` no longer validates a chain. It joins, reads `ledger_head` from the resulting
GroupContext, recomputes the chain over `invite.ledgerEntries`, and asserts its own DID appears in
the folded roster. The anchor is not readable before `mlsJoinGroup` — the Welcome's GroupInfo is
encrypted to the joiner's key package and ts-mls exposes no decrypt-without-join helper — so
authorization moves after the join rather than before it. That is sound because `mlsJoinGroup`
verifies the GroupInfo signature, the signer's credential, the ratchet tree, and the confirmation
tag before returning any state; a joiner that fails the roster check discards it.

This dissolves the first four requirements of
`docs/agents/plans/next/2026-07-10-member-relay-invite.md`. There is no chain to build from the
inviter's own link, no depth to bound, and no transitive revocation to design. Its fifth — test
the non-creator invite path — stands, and is the reason the defect was never seen.

## Hardening folded in

What survives of the origin item's Medium and Low findings, once the chain is gone.

- `createInvite` signs the invitee's role entry and returns it in `Invite.ledgerEntries`. It
  checks `group.roster` for its own `admin` locally — an honest-client guard, documented as such;
  the receiving-side policy is the real enforcement. `removeMember` does the same.
- `commitInvite` asserts the key package credential's DID equals `invite.recipientDID`, and that
  the committer holds `admin`. Kubun enforces the first by hand today
  (`context/peer.ts:124`); this is the same semantics, better placed.
- `processWelcome` asserts the joiner's own DID is in the roster it folds, and that
  `invite.ledgerEntries` reproduces the authenticated `ledger_head`.
- The `aud` check, `extractPermission`, and the `chain.at(-1) === invite.capabilityToken`
  assertion are all moot — there is no chain and no capability token to check.
- `capability.ts`'s `groupID` prefix confusion (`res: 'group/a/x/*'` satisfying
  `res.startsWith('group/a/')`) is likewise moot on the membership path. The file's remaining
  users, if any, are traced before it is deleted or narrowed.

## Folded in: member-relay invites

> **Superseded in part.** Written before Q2.5 was answered. The capability chain is removed
> entirely — see "The roster replaces the capability chain". Requirements 1, 3, and 4 of the
> origin item dissolve rather than getting fixed; the two corrections below stand, and its
> requirement 5 (test the non-creator invite path) stands.


`docs/agents/plans/next/2026-07-10-member-relay-invite.md` (2026-07-10) reports that
`createInvite` chains the invitee's capability from `group.rootCapability` rather than from the
inviter's own chain, dropping the inviter's membership link. Only the group creator — for whom
the two coincide — produces a chain that validates. A member promoted to `admin` fails too, so
this spec's central flow (promote, then invite) walks straight into it. It touches the same three
surfaces as the hardening above, and lands here.

The fix is small: the inviter's chain is already on the handle as
`credential.capabilityChain`, so `createInvite` delegates from `chain.at(-1)` and ships
`[...chain, memberCap]`. Nothing needs to be stored that is not stored today.

Two corrections to that item. Its requirement that `GroupHandle` "retain the full capability
chain" is already met (`types.ts:50`, `group.ts:618`, persisted by kubun's
`groups/mls-state.ts`) — the chain is stored, just not read. And its framing, "a plain member
cannot serve an invite at all", does not survive this spec: `add` requires `admin` in the roster,
so a plain member's Add is refused by every peer however well-formed its chain. The defect is
that a **non-creator admin** cannot invite. Kubun's own open-circles spec independently adopts
the same precondition ("caller must be admin of the named `groupID`").

**Open question, to be answered before the ledger types solidify.** Once every member holds an
admin-signed, anchor-rooted `group.role` entry, the invite's capability chain is a second
membership proof with worse properties: unbounded depth, no total order, no revocation primitive.
The relay item's remaining two requirements — bound the chain depth, design transitive revocation
so revoking `A→R` invalidates `R→B` — exist only because the chain is load-bearing. If the roster
subsumes it, both dissolve, `Invite` drops `capabilityChain`, and kubun's backlogged
"ledger-derivable group membership" line closes as a side effect. If it does not, the chain stays,
gains a depth cap, and transitive revocation goes to `backlog/mls-capability-revocation.md`.

## Testing

Unit:

- fold determinism under shuffled entry order
- authority against state-so-far: Bob, granted by Alice, revokes Alice; Bob's earlier grants
  survive
- an entry that would empty the admin set is dropped
- a cross-group entry (mismatched `groupID`) is dropped, not thrown
- unknown envelope `v` rejects the commit
- per-proposal sender: an admin committing a `member`'s by-reference Remove is rejected
- a handle restored over an anchorless GroupContext throws rather than accepting everything
- a Remove of an admin without a demotion entry is rejected
- a GCE proposal altering the anchor's bytes is rejected; one altering only `ledger_head` is not
- `entries` without a head update, and a head update without `entries`, are both rejected

Integration (`tests/integration/`):

- three-member group; a `member`'s Remove of a third party is rejected by every peer and the
  group stays at its epoch, while their self-removal is accepted
- promote-then-commit in a single round trip (entry rides the commit that uses it)
- `MissingLedgerEntriesError` thrown, bodies resolved, retry succeeds
- resync by a roster member accepted; by a stranger rejected
- a creator promotes a member to admin; that admin invites a third party who joins (the
  non-creator invite path, which no test in either repo has ever driven)
- an inviter that omits one entry from `Invite.ledgerEntries` produces a joiner that throws
  `LedgerIncompleteError` rather than folding a stale roster
- a removed admin's role entry, relayed by a colluding member, is dropped by every peer

## Migration

`@kumiai/mls` is pre-1.0 and kubun is its only consumer, so this lands as a coordinated bump.

`GroupPermission` narrows to `'admin' | 'member'`. Kubun imports the type
(`groups/manager.ts:9`) but only ever passes `'member'`, so the narrowing is source-
compatible there.

Kubun deletes `group-anchor.ts`, `ledger-entry.ts`, `ledger-fold.ts`, and the reducer half of
`admin-roster.ts`, importing them from `@kumiai/mls` instead. It keeps its store, HLC clock,
`role`-column projection, and `isLedgerAdminAtHLC`. Its `recoverySecret` moves into the
anchor's `app` slot. `anchorImmutabilityPolicy` is deleted — the default policy subsumes it, and
narrows it: a GCE proposal that leaves the anchor bytes untouched is now legal, which is what
lets the `ledger_head` move at all.

Kubun stops serializing `rootCapability` (`groups/mls-state.ts:20,33`) and stops passing it to
`restoreGroup` (`groups/mls-group-handle.ts:10`). It reads no capability to authorize anything, so
nothing else changes on its invite or join path; it already ships ledger entries in the invite
(`context/join.ts:88-92`). `groupAnchorCapabilities()` becomes `controlCapabilities()` at its two
call sites (`groups/manager.ts:172`, `context/join.ts:26`).

`authenticatedData` is unused in `plugin-p2p`, so claiming it for `ControlEnvelope` costs kubun
nothing.

Its four sub-ledgers split along the rule above. `admin.role` becomes `group.role` and is ours.
`circle.def` and `group.settings` are admin-authored — omitting either grants — so they become
ledger entries of kubun's own types, notarized by kumiai and folded by kubun's reducers via
`onLedgerEntries`. They inherit `groupID` binding, epoch ordering, and omission-proofing for free.
`circle.member` splits: an admin-issued designation is a ledger entry; a member's self-join is an
`app` payload, where its omission denies rather than grants, and where kubun's serve gate already
enforces what a fold never could.

Two consequences kubun should weigh, neither of which this spec decides for it:

- Entries riding envelopes are ordered by the epoch chain rather than by a self-reported `hlc`.
  Migrating `circle.def` and `group.settings` onto envelopes retires the backdating vulnerability
  and the prune-direction bug for those ledgers, because both require asserting a position the
  protocol would otherwise assign. `isOpenAtHLC` becomes "at the entry's epoch position", which is
  the same predicate with a stronger clock.
- `ord` remains on the shared type for whatever kubun keeps on its HLC-ordered broadcast path.

Three kubun-side follow-ups this spec surfaces but does not fix:

- **HLC backdating**, for its application ledgers, which keep their HLC ordering.
  `foldAdminRoster.verifyAuthority` is `state.admins.has(verified.issuer)` over entries sorted by
  a self-reported `hlc` (`groups/admin-roster.ts:38-39`). A demoted admin signs "grant Mallory
  admin" claiming an `hlc` from when it still held the role; the fold reaches that point with the
  issuer still in the set and applies it, and the later revoke does not remove Mallory. **A
  demoted admin can retroactively promote anyone, permanently.** kumiai is not exposed: the
  protocol assigns epoch order rather than the signer asserting it.
- whether its existing application ledgers need a `groupID` backfill
- the cross-ledger incremental-projection defect (`groups/broadcast.ts:717-793`), which is
  host-side and which the full-replay-only fold declines to enable

## Out of scope

- `backlog/mls-capability-revocation.md`. This spec builds the hook it needs — the external-
  commit verdict in the pre-pass, and a ledger to carry revocation entries — but ships no
  revocation entry type.
- Capability expiry (`exp`) handling on role entries.
- Kubun's HLC backdating fix.
