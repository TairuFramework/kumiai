# MLS group permission enforcement + control ledger — Plan

**Stage:** executing
**Mode:** learning-loop
**Spec:** `docs/superpowers/specs/2026-07-09-mls-permission-enforcement-design.md`

## Why learning-loop

The spec's architecture rests on five claims read out of `ts-mls@2.0.0-rc.13` type
declarations and kubun source, none of which have been executed:

1. `createCommit` round-trips `authenticatedData` through a `PrivateMessage`, and it is
   readable before decryption.
2. `joinGroupExternal` emits a `PublicMessage` whose UpdatePath leaf credential is reachable
   without processing the message, and whose `senderLeafIndex` is `undefined`.
3. Not assigning `newState` is a clean rollback — and stays clean once the pre-pass adds a
   ledger and roster to unwind alongside it.
4. `group_context_extensions` proposals actually reach `IncomingMessageCallback`, so the
   anchor guard has something to reject.
5. The `ord` field on `LedgerEntry` is needed at all. It was invented during spec
   self-review; neither kubun nor the user asked for it.

If (1) or (2) is false the control envelope has no carrier and the spec changes shape. So
Phase 1 probes ts-mls before any `@kumiai/mls` code is written. Claim (5) is probed in
Phase 2 with a default of **deleting the field**.

Command note: the machine's `rtk` shim intercepts `pnpm run <script>`. Every verify command
below uses `pnpm exec` / `pnpm --filter … exec`, which is not intercepted.

---

## Phase 1: ts-mls capability probes

No `@kumiai/mls` source changes. A scratch test file, `packages/mls/test/ts-mls-probe.test.ts`,
that exercises ts-mls directly. It is deleted at the end of the phase — its findings live in
the decision log, not in the suite.

Exit criteria: all four claims confirmed against real ts-mls behaviour, or the spec updated
to match what ts-mls actually does.

### Question 1.1: Does `authenticatedData` survive a commit round trip, and is it readable before decryption?

- **Assumption:** `createCommit({ authenticatedData })` produces a `PrivateMessage` whose
  `authenticatedData` field is byte-identical on the receiving side, readable from the decoded
  frame without holding the epoch secrets; and mutating those bytes in flight makes
  `processMessage` fail (AEAD AAD covers them).
- **Done when:** a test creates a 2-member group, commits with a non-empty
  `authenticatedData`, reads the bytes off the encoded/decoded wire message before any
  `processMessage` call, asserts equality; a second test flips one byte and asserts
  `processMessage` throws.
- **Spec excerpt:**
  > **`authenticatedData` is cleartext but authenticated.** `PrivateMessage.authenticatedData`
  > is a plaintext field of the framed message (`privateMessage.d.ts:10-17`), readable before
  > decryption, yet covered both by `PrivateContentAAD` (so tampering breaks the AEAD) and by
  > the signed `FramedContentTBS`. `createCommit` and `joinGroupExternal` already accept it.
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/ts-mls-probe.test.ts`
- **If false:** the control envelope has no carrier. Stop; the spec needs a new distribution
  channel (most likely a by-value `AppAck`-style proposal or an out-of-band signed bundle
  keyed by commit hash). Do not proceed to Phase 2.

### Question 1.2: Is an external commit a `PublicMessage` with a reachable UpdatePath leaf credential?

- **Assumption:** `joinGroupExternal` emits a `PublicMessage` (cleartext), the joiner's
  credential is reachable at the commit's UpdatePath leaf node without processing the
  message, and the receiving callback sees `senderLeafIndex === undefined`.
- **Done when:** a test has a third identity join an existing group by external commit; the
  receiver decodes the message, extracts the DID from the UpdatePath leaf credential, and
  asserts it equals the joiner's DID. A `commitPolicy` installed on the receiver records the
  `senderLeafIndex` it was handed; the test asserts it is `undefined`, and records what
  `proposals` contained.
- **Spec excerpt:**
  > For an external-init commit `senderLeafIndex` is `undefined`, and the joiner's credential
  > lives in the commit's UpdatePath leaf rather than in `proposals` — the synchronous callback
  > cannot see who is committing. But `joinGroupExternal` emits a `PublicMessage`, which is
  > cleartext, so `processMessage` decodes it in the async pre-pass, resolves the path leaf's
  > DID, and hands the callback a precomputed verdict.
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/ts-mls-probe.test.ts`
- **If false:** the `external_init` row of the policy table cannot be enforced. Fall back to
  rejecting all external commits by default with an opt-out option, and record the gap.

### Question 1.3: Do `group_context_extensions` proposals reach the callback, and does `'reject'` leave state untouched?

- **Assumption:** a commit carrying a `group_context_extensions` proposal surfaces in
  `incoming.proposals` with `proposalType === defaultProposalTypes.group_context_extensions`,
  the proposal's new extensions are inspectable (so the anchor type can be detected), and
  returning `'reject'` leaves the receiver at its pre-commit epoch with a still-usable handle.
- **Done when:** a test commits a group-context-extensions change; a receiver policy asserts
  it sees the proposal, reads the proposed extension types, returns `'reject'`; the test then
  asserts the receiver's epoch is unchanged **and** that the receiver can still decrypt a
  subsequent application message from a peer that also rejected it.
- **Spec excerpt:**
  > | `group_context_extensions` | `admin`, and rejected outright if it touches the anchor extension type |
  >
  > On reject, or on any thrown verification, none of the three fields are assigned. Rollback is
  > simply not assigning — no state is mutated in place, so there is nothing to undo. This is
  > how the existing reject path already behaves (`group.ts:350-357`).
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/ts-mls-probe.test.ts`
- **If false:** kubun's existing `anchorImmutabilityPolicy` is also broken and the anchor is
  not actually immutable. That is a finding worth surfacing immediately, independent of this
  work.

### Question 1.4: Does a by-reference proposal carry a `senderLeafIndex` distinct from the committer's?

- **Assumption:** `ProposalWithSender.senderLeafIndex` is per-proposal. When admin Alice
  commits a Remove proposed by-reference by member Bob, the callback sees the proposal's
  `senderLeafIndex` as Bob's leaf, not Alice's.
- **Done when:** a 3-member test where Bob proposes a Remove by reference, Alice commits it,
  and Carol's policy asserts `proposals[0].senderLeafIndex !== commitSenderLeafIndex` and
  equals Bob's leaf index.
- **Spec excerpt:**
  > `ProposalWithSender.senderLeafIndex` is per-proposal, because a commit may include
  > by-reference proposals authored by other members. Checking only the committer would let an
  > admin launder a non-admin's Remove by committing it. Each proposal is checked against
  > `p.senderLeafIndex ?? commit.senderLeafIndex`.
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/ts-mls-probe.test.ts`
- **If false:** the laundering attack is unpreventable at the proposal level and the policy
  must fall back to the committer's permission alone. Record the weakening in the spec.

---

## Phase 2: Ledger primitives

Ports from kubun, made generic. Pure functions, no MLS coupling, no `GroupHandle`.
New files: `packages/mls/src/anchor.ts`, `ledger.ts`, `fold.ts`, `roster.ts`.

Exit criteria: `foldRoster` reproduces kubun's `foldAdminRoster` semantics, plus `groupID`
scoping and the empty-admin guard, with no clock anywhere in the module.

### Question 2.1: Can `GroupAnchor` be made generic without breaking kubun's `recoverySecret`?

- **Assumption:** kubun's `recoverySecret` is not read by anything generic, so an opaque
  `app?: Uint8Array` slot carries it without kumiai knowing what it is; the extension type
  (`0xf100`), the encode/decode, and `groupAnchorCapabilities()` move over unchanged.
- **Done when:** `anchor.ts` exports `GroupAnchor` (`creatorDID`, `version`, `app?`),
  `GROUP_ANCHOR_EXTENSION_TYPE`, encode/decode with tolerant `null`-on-malformed decode,
  `buildGroupAnchorExtension`, `groupAnchorCapabilities()`, `readGroupAnchor(handle)`. A test
  writes an anchor with a non-empty `app`, reads it back through a real `createGroup` +
  `readGroupAnchor`, and asserts byte equality of `app`. A second test asserts an
  anchor extension present but undecodable **throws** (corruption ≠ absence), while a group
  with no anchor extension returns `null`.
- **Spec excerpt:**
  > - `anchor.ts` — `GroupAnchor` (`creatorDID`, `version`, `app?: Uint8Array`), extension type
  >   `0xf100`, encode/decode, `groupAnchorCapabilities()`, `readGroupAnchor(handle)`.
  >
  > Its `recoverySecret` moves into the anchor's `app` slot.
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/anchor.test.ts`

### Question 2.2: Does `groupID` on `LedgerEntry` actually stop the cross-group replay?

- **Assumption:** signing `groupID` into the claim and dropping mismatched entries in the
  fold closes the replay hole, and nothing else does — in particular, content-addressing does
  not, because the replayed bytes are identical.
- **Done when:** `ledger.ts` exports `LedgerEntry` (with `groupID`), `VerifiedLedgerEntry`,
  `signLedgerEntry`, `verifyLedgerEntry`, `ledgerEntryDigest`. A test signs *"creator grants
  Mallory admin"* in group A, computes its digest, folds it into group B (same creator DID),
  and asserts Mallory is **not** an admin of B and the entry appears in `onDrop`. A control
  test asserts the same entry folded into group A **does** promote Mallory, and that both
  folds saw the same `ledgerEntryDigest` (proving content-addressing was no defence).
  `verifyLedgerEntry` returns `null` — never throws — on unparseable, `alg: 'none'`, or
  structurally malformed input, including a missing `groupID`.
- **Spec excerpt:**
  > Kubun's entry is `{type, subject, value, hlc}` — nothing binds it to a group. […] When one
  > DID creates two groups (the common case for a real user), an entry from group A reading
  > *"creator grants Mallory admin"* can be lifted verbatim into a commit in group B. Its issuer
  > is B's creator, so B's fold accepts it and Mallory becomes an admin of a group she was never
  > promoted in. Content-addressing does not help: the bytes are identical, so the id matches.
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/ledger.test.ts`

### Question 2.3: Can `foldLedger` serve both consumers with the sort pushed out to the caller — and is `ord` needed at all?

- **Assumption (a):** removing the internal `(hlc, entryID)` sort from `foldLedger` and folding
  in caller-supplied order preserves every other property (pure, anchor-seeded,
  authority-against-state-so-far, drop-never-throw).
- **Assumption (b), the one under probe:** kubun needs `ord` on the *signed* entry.
  **Default: delete the field.** It is only justified if kubun cannot recover its HLC ordering
  from data it already holds.
- **Done when:** `fold.ts` exports `LedgerReducer`, `FoldInput`, `FoldDrop`, `foldLedger`
  with no sort and no `hlc`. Tests cover: determinism under a shuffled input array *given a
  fixed caller order*; state-so-far rotation (Alice grants Bob; Bob revokes Alice; Bob's
  earlier grants survive); unrelated `type` dropped, unauthorized issuer dropped, neither
  throws; `onDrop` fires once per drop with a reason.
  **Then the probe:** re-implement kubun's `foldAdminRoster` + `isLedgerAdminAtHLC` call sites
  against this fold, using only `FoldInput` ordering supplied by the caller. Kubun's store
  already persists an `hlc` column alongside each entry token, so the caller can sort on the
  stored column before folding. If that holds, `ord` never ships and the `LedgerEntry` type
  is `{type, groupID, subject, value}`. Record the finding either way.
- **Spec excerpt:**
  > `foldLedger` does not sort. It folds the entries in the order the caller supplies, because
  > the two consumers derive order from different places: kumiai from the authenticated epoch
  > chain, kubun from `ord` (its HLC) with the entry id as tie-break.
  >
  > ```ts
  > /** Consumer-supplied total-order key, signed with the rest of the claim.
  >  *  `@kumiai/mls` never reads it — its entries are ordered by the epoch chain
  >  *  and their position in the envelope. Kubun sets it to its HLC. */
  > ord?: string
  > ```
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/fold.test.ts`
- **Note:** deleting `ord` means the spec's `LedgerEntry` block changes. Update the spec in the
  same commit as the finding, per the learning-loop's critical rule.

### Question 2.4: Does the role reducer hold under demotion, self-demotion, and the empty-admin guard?

- **Assumption:** `Map<normalizedDID, GroupPermission>` seeded `{creatorDID: 'admin'}` with
  `verifyAuthority = stateSoFar.get(issuer) === 'admin'` expresses every rule the spec needs;
  "any admin may demote any admin" needs no extra guard beyond "never empty the admin set".
- **Done when:** `roster.ts` exports the `'group.role'` entry type, `RosterState`,
  `roleReducer`, `foldRoster`. Tests: creator is admin at seed with an empty ledger; admin
  promotes member to admin; admin demotes another admin (accepted); the **last** admin
  demoting themselves is dropped and the roster keeps them; a `member` issuing any role entry
  is dropped; an entry whose `subject` is not yet a member is still recorded (roster is
  DID-keyed, not leaf-keyed, and an entry may precede the Add in the same commit).
- **Spec excerpt:**
  > Roster state is `Map<normalizedDID, GroupPermission>`, seeded from the anchor as
  > `{creatorDID: 'admin'}`. […] The role entry is `{type: 'group.role', groupID, subject,
  > value: GroupPermission}`. `verifyAuthority` is kubun's rule unchanged: the issuer must be an
  > admin in the state accumulated from strictly-earlier entries. Any admin may demote any admin.
  >
  > Demotion is `value: 'member'`; kubun's separate `'revoked'` value disappears […] One
  > additional fold guard: an entry that would empty the admin set is dropped.
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/roster.test.ts`
- **Open:** the last bullet ("entry may precede the Add") is an assumption about ordering
  inside a single envelope. If it turns out an invite's role entry must land *after* the Add,
  say so — it constrains `createInvite`.

### Question 2.5: Does the roster subsume the capability chain as the membership proof?

Read-only research. No code beyond a spike, if one is needed to settle it.

- **Assumption:** once every member has an admin-signed, anchor-rooted `group.role` entry, the
  invite's `capabilityChain` is a second, redundant membership proof with strictly worse
  properties — unbounded depth, no total order, no revocation primitive. If so, `Invite` can
  drop `capabilityChain`/`capabilityToken` in favour of the role entry, and the two hard
  requirements of `docs/agents/plans/next/2026-07-10-member-relay-invite.md` (bounded chain
  depth; transitive revocation of `A→R` invalidating `R→B`) dissolve rather than needing
  designs.
- **Context.** That item reports a real defect: `createInvite` chains the invitee's capability
  from `group.rootCapability` (`group.ts:489,496`) rather than from the inviter's own chain, so
  only the group creator can produce a chain that validates. A promoted admin fails too. Its
  requirement 3 (bound the depth) and requirement 4 (design transitive revocation) exist *only
  because the chain is load-bearing*. Kubun's open-circles spec independently lists
  "ledger-derivable group membership (inviter-signed member entries, full joiner-verifiability)"
  as blocked backlog, because "group membership lives in the MLS roster and store rows, not in
  ledger entries, so it cannot be verified by a fold". This spec's roster is exactly that.
- **Done when** the following are answered, with file:line evidence:
  1. What does `validateGroupCapability` establish that a folded roster does not? (`aud` binding
     to the joiner; `res`/`act` scoping; `exp`.) Which of those does the role entry already carry
     or trivially gain?
  2. Does anything outside membership consume a *group* capability? Trace `createGroupCapability`
     / `delegateGroupMembership` consumers across `packages/` and `kubun/packages/plugin-p2p`.
     Kubun's per-document `document/write` grants (`store-received-grant.ts`) are a different
     capability axis — confirm they do not chain from the group root.
  3. Can `processWelcome` fold a roster before trusting anything? It needs the anchor, which
     lives in the GroupContext carried by the Welcome's GroupInfo. Establish whether the anchor
     is readable *before* `mlsJoinGroup`, or only after.
  4. If the chain stays: what is the depth cap, and where is it enforced?
- **Spec excerpt:**
  > Roster state is `Map<normalizedDID, GroupPermission>`, seeded from the anchor as
  > `{creatorDID: 'admin'}`. […] `verifyAuthority` is kubun's rule unchanged: the issuer must be
  > an admin in the state accumulated from strictly-earlier entries.
  >
  > - `createInvite` signs the invitee's role entry and returns it. `Invite` gains two fields:
  >   `recipientDID` […] and `ledgerEntries` (the joiner's roster bootstrap).
- **Verify:** no command — this question produces a written finding and, if the answer is yes, a
  spec amendment before Phase 3 begins.
- **Timing.** Asked *in* Phase 2, before the ledger and roster types solidify, because the answer
  changes `Invite` and possibly `MemberCredential`. Answering it in Phase 5 means shipping an
  unbounded-depth chain beside a roster that made it redundant.
- **Default if unresolved:** keep the chain, fix it per Question 5.4, cap the depth, and hand
  transitive revocation to `backlog/mls-capability-revocation.md`.

---

## Phase 3: Envelope and policy

New files: `packages/mls/src/envelope.ts`, `policy.ts`. Still no `GroupHandle` changes —
`defaultCommitPolicy` is written as a pure function of (candidate roster, precomputed
external verdict, incoming message), so it is testable without a live group.

Exit criteria: the policy table is enforced by a function whose only inputs are already-folded
local state.

### Question 3.1: Is `ControlEnvelope` decodable fail-closed from arbitrary bytes?

- **Assumption:** `v` alone gives fail-closed versioning; no `requires` field is needed.
- **Done when:** `envelope.ts` exports `ControlEnvelope`, `encodeControlEnvelope`,
  `decodeControlEnvelope`. Tests: round-trip with and without `entries`, with and without
  `app`; `v: 2` decodes to a rejection sentinel (not a throw — the caller turns it into a
  commit rejection); garbage bytes reject; an *absent* `authenticatedData` (zero length) is a
  valid "no control data" envelope, not an error, so ordinary commits from clients that
  predate this are… **decide:** rejected or accepted? Spec says the anchor is load-bearing and
  groups must be recreated, which argues for accepting an empty envelope as `{v: 1}`. State the
  choice in the decision log.
- **Spec excerpt:**
  > ```ts
  > export type ControlEnvelope = {
  >   /** Unknown version ⇒ reject the commit. */
  >   v: 1
  >   /** Content-addressed ids of the control-ledger entries this commit enacts, in
  >    *  fold order. Absent when the commit changes no roles. */
  >   entries?: Array<string>
  >   /** Opaque consumer payload. */
  >   app?: Uint8Array
  > }
  > ```
  > **No `requires` field.** […] `v` alone gives fail-closed behaviour.
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/envelope.test.ts`

### Question 3.2: Does the policy table hold as a pure function?

- **Assumption:** every row of the table is decidable from (candidate roster, per-proposal
  sender leaf → DID, precomputed external verdict), with no I/O.
- **Done when:** `policy.ts` exports `defaultCommitPolicy` and `MissingLedgerEntriesError`.
  One test per row, driven with hand-built `incoming` values and a hand-built roster:
  `add` by member rejected / by admin accepted; `remove` of a third party by member rejected;
  self-`remove` by member accepted; `update` by member accepted; `psk`/`reinit` by member
  rejected; `group_context_extensions` by admin accepted, by admin **touching the anchor type**
  rejected, by member rejected; `external_init` with a roster DID accepted, with a stranger
  rejected, with extra proposals beyond `external_init` + self-leaf `Remove` rejected;
  empty commit by member accepted; application message never consulted.
  Plus the laundering case from 1.4: admin commits a member's by-reference Remove ⇒ rejected.
- **Spec excerpt:**
  > | Proposal | Required of the proposal's sender |
  > |---|---|
  > | `add` | `admin` |
  > | `remove` | `admin`, or self-removal (removed leaf == sender leaf) |
  > | `update` | nothing — MLS already binds an Update to its own leaf |
  > | `psk`, `reinit` | `admin` |
  > | `group_context_extensions` | `admin`, and rejected outright if it touches the anchor extension type |
  > | `external_init` | committer DID ∈ roster, and the commit carries only `external_init` plus a Remove of that same DID's prior leaf |
  >
  > A commit with no proposals (key rotation) is allowed to any member. Application messages are
  > never checked.
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/policy.test.ts`
- **Open:** mapping a `senderLeafIndex` to a DID requires reading the leaf credential out of
  the *pre-commit* ratchet tree. Confirm ts-mls exposes that off `ClientState` synchronously.
  If it does not, the DID map must be precomputed in the pre-pass alongside the roster.

---

## Phase 4: `GroupHandle` three-phase `processMessage`

Changes in place: `packages/mls/src/group.ts`, `types.ts`.

Exit criteria: a live 3-member group where a member's Remove of a third party is rejected by
every peer, the group stays at its epoch, and every peer remains able to decrypt.

### Question 4.1: Does the async pre-pass compose with the sync callback?

- **Assumption:** decoding the frame, resolving entry bodies, verifying them, and folding a
  candidate roster can all happen *before* `mlsProcessMessage`, leaving the callback a pure
  lookup.
- **Done when:** `processMessage` and `decrypt` share a pre-pass that: decodes the message;
  reads and decodes the envelope (unknown `v` ⇒ reject); resolves `entries[]` via
  `#ledger` then `GroupOptions.resolveLedgerEntries`; throws `MissingLedgerEntriesError { ids }`
  when unresolved or no resolver; verifies each token, dropping `groupID` mismatches; folds a
  candidate roster from `#ledger ∪ new`; for a `PublicMessage` external commit, resolves the
  UpdatePath leaf DID and precomputes the verdict. The handle exposes `roster` (getter) and
  `applyLedgerEntries(tokens)`.
- **Spec excerpt:**
  > 1. **Async pre-pass.** Decode the framed message. Read `authenticatedData` into a
  >    `ControlEnvelope`; unknown `v` rejects. Resolve `entries[]` bodies (ids already held are
  >    free); unresolved ⇒ `MissingLedgerEntriesError`. […]
  > 2. **Sync callback.** Reads the candidate roster and the precomputed external verdict.
  > 3. **Commit.** Only on accept are `#state`, `#ledger`, and `#roster` assigned.
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/group.test.ts`

### Question 4.2: Is "don't assign" still a clean rollback with three fields?

- **Assumption:** `#state`, `#ledger`, `#roster` are all replaced wholesale on accept, so a
  reject or a throw leaves the handle exactly as it was, and the handle stays usable.
- **Done when:** a test rejects a commit, then asserts `epoch`, `roster`, and the ledger id set
  are unchanged **and** the handle decrypts a following application message from a peer that
  also rejected. A second test throws from inside the pre-pass (unresolvable entry) and asserts
  the same three fields are untouched, then resolves the bodies and retries the *same* message
  successfully.
- **Spec excerpt:**
  > On reject, or on any thrown verification, none of the three fields are assigned. Rollback is
  > simply not assigning — no state is mutated in place, so there is nothing to undo.
  >
  > Unresolved ids, or no resolver, throw `MissingLedgerEntriesError { ids }` and leave the
  > handle at its pre-commit epoch; the caller fetches the bodies over the group's encrypted
  > channel and retries.
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/group.test.ts`

### Question 4.3: Is the candidate roster folded before the commit applies?

- **Assumption:** a commit that promotes Bob and is authored by Bob must be judged against the
  roster *without* his promotion — i.e. the fold sees the new entries, but authority is
  evaluated state-so-far, so a self-promotion by a non-admin is dropped and the commit fails.
- **Done when:** a test where member Bob signs `{subject: bob, value: 'admin'}`, rides it in
  his own commit's envelope, and commits an Add. Every peer drops the entry (Bob is not an
  admin in state-so-far), then rejects the Add. The group stays at its epoch. A control test:
  admin Alice signs the same entry, rides it in a commit that Bob then uses to Add — accepted.
- **Spec excerpt:**
  > The candidate roster is folded *before* the commit is applied, which is the correct
  > semantics: a commit that promotes Bob and is itself authored by Bob must be judged against
  > the roster without his promotion.
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/group.test.ts`

### Question 4.4: Does an anchorless group fail closed?

- **Assumption:** without an anchor there is no roster seed, so `restoreGroup` and
  `processWelcome` must throw rather than install a permissive policy.
- **Done when:** `createGroup` always writes the anchor and `createKeyPackageBundle` always
  advertises the extension type. Tests: `restoreGroup` over a serialized anchorless state
  throws; `processWelcome` into an anchorless group throws; a key package that does not
  advertise `0xf100` is refused by `commitInvite`.
- **Spec excerpt:**
  > A handle whose GroupContext carries no anchor has no seed and cannot fold a roster —
  > `restoreGroup` and `processWelcome` throw rather than silently installing a policy that
  > would accept everything.
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/group.test.ts`

---

## Phase 5: Layer 1 hardening

Changes in place: `capability.ts`, `credential.ts`, `types.ts`, `group.ts`. These close the
origin item's Medium and Low findings. No new design — each has a test that fails before.

Exit criteria: every finding in `docs/agents/plans/next/2026-07-07-mls-permission-enforcement.md`
**and** `docs/agents/plans/next/2026-07-10-member-relay-invite.md` has a test that fails on the
pre-change code.

### Question 5.1: Does narrowing `GroupPermission` to `'admin' | 'member'` break anything?

- **Assumption:** `'read'` has no producer outside `extractPermission` and no consumer
  anywhere; removing it is source-compatible for kubun, which only ever passes `'member'`.
- **Done when:** `GroupPermission = 'admin' | 'member'`; `extractPermission` maps `act: '*'`
  to `admin` and everything else to `member`; a grep across `packages/` and `../kubun` shows no
  remaining reference; the docs say plainly that MLS cannot express read-only membership and
  observers do not belong in the group.
- **Spec excerpt:**
  > It is unenforceable. A group member holds the epoch secrets — that is what membership *is*
  > in MLS. A `read` member derives the same application keys as anyone else […] Shipping the
  > level is a promise the library cannot keep.
- **Verify:** `pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`

### Question 5.2: Do the invite-path checks close the trust-the-inviter findings?

- **Assumption:** `Invite` needs two new fields (`recipientDID`, `ledgerEntries`), and with
  them each finding becomes a one-line assertion.
- **Done when:**
  - `Invite` gains `recipientDID` and `ledgerEntries: Array<string>`; `createInvite` signs the
    invitee's `'group.role'` entry and returns it there.
  - `commitInvite` asserts the key package credential's DID equals `invite.recipientDID`, and
    that the committer holds `admin`.
  - `processWelcome` asserts `normalizeDID(capToken.payload.aud) === normalizeDID(identity.id)`,
    derives `permission` via `extractPermission(capToken)` instead of copying
    `invite.permission`, and asserts `chain.at(-1) === invite.capabilityToken`.
  - `createInvite` and `removeMember` check `group.credential.permission` locally, each with a
    comment stating it is an honest-client guard and the receiving-side policy is the real
    enforcement.
  - A test per bullet, each failing on the pre-change code: a mismatched key package DID; a
    non-admin committer; a capability minted for someone else; an invite claiming `admin` over
    a `member` capability; a chain whose tail is not the invite's token.
- **Spec excerpt:**
  > - `commitInvite` asserts the key package credential's DID equals `invite.recipientDID`, and
  >   that the committer holds `admin`.
  > - `processWelcome` asserts `normalizeDID(capToken.payload.aud) === normalizeDID(identity.id)`,
  >   derives `permission` via `extractPermission(capToken)` rather than trusting
  >   `invite.permission`, and asserts `chain.at(-1) === invite.capabilityToken`.
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/group.test.ts test/credential.test.ts`

### Question 5.3: Does rejecting `/` and `*` in `groupID` close the prefix confusion?

- **Assumption:** the `res.startsWith('group/${groupID}/')` check is safe once a `groupID`
  cannot itself contain a separator or a wildcard.
- **Done when:** `createGroupCapability` and `validateGroupCapability` both reject a `groupID`
  containing `/` or `*`. A test asserts a capability for group `a/x` (`res: 'group/a/x/*'`) can
  no longer be minted, and that validating it against group `a` fails.
- **Spec excerpt:**
  > `capability.ts` rejects a `groupID` containing `/` or `*` in both create and validate,
  > closing the prefix confusion where `res: 'group/a/x/*'` satisfies the
  > `res.startsWith('group/a/')` check for group `a`.
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/capability.test.ts`

### Question 5.4: Can a non-creator admin serve an invite?

Folds in `docs/agents/plans/next/2026-07-10-member-relay-invite.md`. Shape depends on the
answer to Question 2.5 — if the chain is dropped, only the tests below survive.

- **Assumption:** `createInvite` chains the invitee's capability from `group.rootCapability`
  (`group.ts:489`) and ships `[group.rootCapability, memberCapStr]` (`group.ts:496`), so a
  non-creator inviter's own membership link is missing and `checkDelegationChain` fails with an
  audience mismatch. The inviter's own chain is already on the handle — `credential.capabilityChain`
  (`types.ts:50`, populated at `group.ts:618`, exposed at `group.ts:188`, and already persisted by
  kubun's `groups/mls-state.ts`). The fix is to read it, not to store it.
- **Correction to the origin item.** Its requirement 2 ("`GroupHandle` must retain the full
  capability chain, not just element zero") is already satisfied; nothing is lost. And its
  headline — "a plain member cannot serve an invite at all" — is superseded by this spec: `add`
  requires `admin` in the roster, so a plain member's Add is rejected by every peer no matter how
  well-formed its chain. The defect is that a **non-creator admin** cannot invite. Kubun's
  open-circles spec reaches the same precondition independently ("caller must be admin of the
  named `groupID`").
- **Done when:**
  - `createInvite` delegates with `parentCapability = group.credential.capabilityChain.at(-1)`
    and ships `capabilityChain: [...group.credential.capabilityChain, memberCapStr]`. For the
    creator both reduce to today's values, since its chain is `[rootCapability]`.
  - `checkDelegationChain` enforces a maximum chain depth, stated in the docs.
  - Tests, each failing on the pre-change code: creator invites a member; that member is promoted
    to admin and invites a third party, whose `processWelcome` validates; a fourth hop validates;
    a plain member's invite produces a chain that validates but an Add commit that every peer
    rejects (chain validity and commit authority are independent); depth beyond the cap is
    refused.
- **Spec excerpt** (from the origin item):
  > `createInvite` builds the invitee's chain from the inviter's `rootCapability` rather than
  > from the inviter's own chain, so the inviter's own membership link is dropped. Only the
  > creator — for whom "root capability" and "own chain" coincide — can produce a chain that
  > validates.
  >
  > The `GroupPermission` level is irrelevant here: a member promoted to `admin` still fails,
  > because `rootCapability` is the creator's root regardless of permission.
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/group.test.ts test/capability.test.ts`

---

## Phase 6: Integration and close-out

Exit criteria: full suite green; the origin item deleted; the kubun follow-up written.

### Question 6.1: Does the whole thing hold across real peers?

- **Assumption:** the four scenarios in the spec's Integration section pass against real
  transports, not stubs.
- **Done when:** `tests/integration/mls-permissions.test.ts` covers:
  - three-member group; a `member`'s Remove of a third party is rejected by every peer and the
    group stays at its epoch, while their self-removal is accepted
  - promote-then-commit in a single round trip (the entry rides the commit that uses it)
  - `MissingLedgerEntriesError` thrown, bodies resolved out of band, retry succeeds
  - resync by a roster member accepted; by a stranger rejected
- **Verify:** `pnpm exec turbo run test:types test:unit && pnpm --filter @kumiai/integration-tests exec tsc --noEmit --skipLibCheck && pnpm --filter @kumiai/integration-tests exec vitest run`
  *(mirrors CI: `.github/workflows/build-test.yml` runs `pnpm run test` at the root, then
  `pnpm run test` inside `tests/integration`, whose script is `tsc --noEmit --skipLibCheck &&
  vitest run`.)*

### Question 6.2: Close the loop

- **Done when:**
  - `docs/agents/plans/next/2026-07-07-mls-permission-enforcement.md` and
    `docs/agents/plans/next/2026-07-10-member-relay-invite.md` are deleted (brainstorming produced
    a spec; both items' findings are covered by Phase 5's criteria).
  - A changeset records the breaking `GroupPermission` narrowing and the new `Invite` fields.
  - Kubun's open-circles spec is told that `serveGroupInvite` is unblocked for any **admin**, not
    only the creator, and that its backlogged "ledger-derivable group membership" line is now
    satisfied by the roster.
  - The kubun migration item is written into kubun's `docs/agents/plans/next/` — **only now**,
    per the user's instruction, once the implementation has settled and the `ord` question is
    answered. It must name: the four files kubun deletes, `recoverySecret` → anchor `app`, the
    deletion of `anchorImmutabilityPolicy`, the `groupID` backfill question, and the
    self-reported-`hlc` backdating exposure.
- **Verify:** `pnpm exec biome check ./packages ./tests && pnpm exec turbo run test:types test:unit`

---

## Decision Log

<!-- One entry per question, filled in after the probe runs, before the next question starts.
     Format: ### Q<n.n>: <one-line finding> — then what was learned, and what (if anything)
     it changed in the spec. -->
