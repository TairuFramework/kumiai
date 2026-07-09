# MLS group permission enforcement + control ledger

**Date:** 2026-07-09
**Origin:** `docs/agents/plans/next/2026-07-07-mls-permission-enforcement.md` (June 2026
enkaku audit merged with the 2026-07-02 kumiai audit, commit `bb343d9`), milestone
`milestones/2026-07-audit-remediation.md`.

## Problem

`GroupPermission` (`admin` / `member` / `read`) travels in group capabilities but is never
enforced on MLS operations. Absent a caller-supplied `commitPolicy`, `processMessage`
accepts add and remove commits from any leaf: a `read`-level member can remove members and
every peer accepts it. `processWelcome` additionally trusts inviter-controlled fields —
it never checks the validated capability's `aud` against the joining identity, and copies
`invite.permission` verbatim into the stored `MemberCredential`, so a token granting `read`
can yield a locally trusted `admin` credential.

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
| role reducer | kubun, `admin` / `revoked` over a `Set` | `@kumiai/mls`, `GroupPermission` over a `Map` |
| ledger persistence, HLC clock, `role`-column projection, broadcast fan-out | kubun (`P2PStoreAPI`) | unchanged, stays kubun |
| **default commit policy** | *nobody* | `@kumiai/mls` — new |

### Rejected alternatives

**A permission map inside a GroupContext extension.** Mutating it requires a
`group_context_extensions` proposal on every role change, which collides head-on with the
anchor immutability that kubun depends on, and grows the GroupContext without bound.

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
   *  fold order. Absent when the commit changes no roles. */
  entries?: Array<string>
  /** Opaque consumer payload. */
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

`foldLedger` does not sort. It folds the entries in the order the caller supplies, because
the two consumers derive order from different places: kumiai from the authenticated epoch
chain, kubun from `ord` (its HLC) with the entry id as tie-break. Pushing the sort out of
the fold is what lets one fold serve both without kumiai taking a clock. `foldLedger` keeps
its other properties unchanged — pure, seeds from the anchor, evaluates authority against
state-so-far, drops rather than throws on an unauthorized or unrelated entry.

## Roster and authority rules

Roster state is `Map<normalizedDID, GroupPermission>`, seeded from the anchor as
`{creatorDID: 'admin'}`. The anchor is therefore load-bearing: `createGroup` always writes
it, and `createKeyPackageBundle` always advertises its extension type so an anchored group
can be joined. A handle whose GroupContext carries no anchor has no seed and cannot fold a
roster — `restoreGroup` and `processWelcome` throw rather than silently installing a policy
that would accept everything. Groups created before this change must be recreated; kumiai is
pre-1.0 and kubun writes the anchor already. The role entry is `{type: 'group.role', groupID, subject, value:
GroupPermission}`. `verifyAuthority` is kubun's rule unchanged: the issuer must be an admin
in the state accumulated from strictly-earlier entries. Any admin may demote any admin.

Demotion is `value: 'member'`; kubun's separate `'revoked'` value disappears, because
leaving a group is an MLS Remove, not a roster operation. One additional fold guard: an
entry that would empty the admin set is dropped, so a group cannot be bricked into a state
where nobody can add or remove.

The default commit policy enforces:

| Proposal | Required of the proposal's sender |
|---|---|
| `add` | `admin` |
| `remove` | `admin`, or self-removal (removed leaf == sender leaf) |
| `update` | nothing — MLS already binds an Update to its own leaf |
| `psk`, `reinit` | `admin` |
| `group_context_extensions` | `admin`, and rejected outright if it touches the anchor extension type |
| `external_init` | committer DID ∈ roster, and the commit carries only `external_init` plus a Remove of that same DID's prior leaf |

A commit with no proposals (key rotation) is allowed to any member. Application messages are
never checked.

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

### `read` is advisory at the MLS layer

A `read` member holds the epoch secrets. Nothing in MLS stops them encrypting an application
message. At this boundary the roster is really admin vs non-admin; the `member` / `read`
split exists for the application layer to enforce. `@kumiai/mls` documents this explicitly
rather than implying a guarantee it cannot make. (This is the origin item's third
design-sketch point.)

## Module layout

New files in `packages/mls/src/`:

- `anchor.ts` — `GroupAnchor` (`creatorDID`, `version`, `app?: Uint8Array`), extension type
  `0xf100`, encode/decode, `groupAnchorCapabilities()`, `readGroupAnchor(handle)`.
- `ledger.ts` — `LedgerEntry`, `VerifiedLedgerEntry`, `signLedgerEntry`,
  `verifyLedgerEntry`, `ledgerEntryDigest`.
- `fold.ts` — `LedgerReducer`, `FoldInput`, `FoldDrop`, `foldLedger`.
- `roster.ts` — role entry type, `RosterState`, `roleReducer`, `foldRoster`.
- `envelope.ts` — `ControlEnvelope`, encode/decode.
- `policy.ts` — `defaultCommitPolicy`, `MissingLedgerEntriesError`.

`capability.ts` and `group.ts` change in place.

## `GroupHandle` changes

The handle holds `#roster: RosterState` and `#ledger: Map<entryID, VerifiedLedgerEntry>`.
Both are derived, never authoritative: the ledger is the source of truth, the roster is its
fold. `roster` gains a public getter. `applyLedgerEntries(tokens)` verifies, folds, and
merges — this is what kubun calls from its broadcast handler.

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

## Hardening folded in

These close the origin item's Medium and Low findings and its sender-side design point.

- `createInvite` signs the invitee's role entry and returns it. `Invite` gains two fields:
  `recipientDID` (the DID the capability was minted for — today the invite carries only
  `inviterID`, so there is nothing to check a key package against) and `ledgerEntries` (the
  joiner's roster bootstrap).
- `commitInvite` asserts the key package credential's DID equals `invite.recipientDID`, and
  that the committer holds `admin`.
- `createInvite` and `removeMember` check `group.credential.permission` locally. These are
  honest-client guards — a modified client skips them — and are documented as such. The
  receiving-side policy is the real enforcement.
- `processWelcome` asserts `normalizeDID(capToken.payload.aud) === normalizeDID(identity.id)`,
  derives `permission` via `extractPermission(capToken)` rather than trusting
  `invite.permission`, and asserts `chain.at(-1) === invite.capabilityToken`.
- `capability.ts` rejects a `groupID` containing `/` or `*` in both create and validate,
  closing the prefix confusion where `res: 'group/a/x/*'` satisfies the
  `res.startsWith('group/a/')` check for group `a`.

## Testing

Unit:

- fold determinism under shuffled entry order
- authority against state-so-far: Bob, granted by Alice, revokes Alice; Bob's earlier grants
  survive
- an entry that would empty the admin set is dropped
- a cross-group entry (mismatched `groupID`) is dropped
- unknown envelope `v` rejects the commit
- per-proposal sender: an admin committing a `read` member's by-reference Remove is rejected
- a handle restored over an anchorless GroupContext throws rather than accepting everything

Integration (`tests/integration/`):

- three-member group; a `read` member's Remove is rejected by every peer and the group stays
  at its epoch
- promote-then-commit in a single round trip (entry rides the commit that uses it)
- `MissingLedgerEntriesError` thrown, bodies resolved, retry succeeds
- resync by a roster member accepted; by a stranger rejected

## Migration

`@kumiai/mls` is pre-1.0 and kubun is its only consumer, so this lands as a coordinated bump.

Kubun deletes `group-anchor.ts`, `ledger-entry.ts`, `ledger-fold.ts`, and the reducer half of
`admin-roster.ts`, importing them from `@kumiai/mls` instead. It keeps its store, HLC clock,
`role`-column projection, and `isLedgerAdminAtHLC`. Its `recoverySecret` moves into the
anchor's `app` slot. `anchorImmutabilityPolicy` is deleted — the default policy subsumes it.
Its own `LedgerEntry` gains `groupID` via the shared type.

Two kubun-side follow-ups this spec surfaces but does not fix:

- the self-reported `hlc` backdating exposure described above, for its application-level
  ledger, which keeps its HLC ordering
- whether its existing application ledgers need a `groupID` backfill

## Out of scope

- `backlog/mls-capability-revocation.md`. This spec builds the hook it needs — the external-
  commit verdict in the pre-pass, and a ledger to carry revocation entries — but ships no
  revocation entry type.
- Capability expiry (`exp`) handling on role entries.
- Kubun's HLC backdating fix.
