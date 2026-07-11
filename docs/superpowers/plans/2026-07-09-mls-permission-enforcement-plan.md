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

**Added by Phase 1 (Q1.1) and Q2.6.** Three gaps in kumiai's commit wrappers, all on the same
rewrite: `commitInvite` and `removeMember` do not forward `authenticatedData` to ts-mls's
`createCommit` (only `joinGroupExternal` does); no wrapper builds a mixed Add+GCE commit; none
issues or relays a standalone by-reference proposal. That rewrite lands in Phase 3 with the
envelope, which is the first thing that needs to *write* `authenticatedData`. Phase 2 stays pure.

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
- **Assumption (b) — ANSWERED, no probe needed.** `ord` **ships**. Kubun's response
  (`notes/kubun-response.md` §2) states the requirement directly: four sub-ledgers
  (`admin.role`, `circle.def`, `circle.member`, `group.settings`) evaluate authority at the
  entry's own HLC via `isAdminAtHLC` / `isOpenAtHLC`, so the shared signer must cover the field
  and hand it back. Kumiai still never reads it. The default-to-delete is withdrawn; the probe
  below is now a straight port.
- **Done when:** `fold.ts` exports `LedgerReducer`, `FoldInput`, `FoldDrop`, `foldLedger`
  with no sort and no `hlc`. Tests cover: determinism under a shuffled input array *given a
  fixed caller order*; state-so-far rotation (Alice grants Bob; Bob revokes Alice; Bob's
  earlier grants survive); unrelated `type` dropped, unauthorized issuer dropped, neither
  throws; `onDrop` fires once per drop with a reason.
  **Full replay only.** No incremental apply, no per-type watermark, no `dependsOn`. Kubun shipped
  and found a defect where a `circle.member` entry authorized against the `group.settings`
  sub-ledger arrives first, folds against empty settings, is dropped, and the watermark advances
  anyway — permanently divergent projections on identical ledgers
  (`kubun/…/groups/broadcast.ts:717-793`). kumiai's own roster fold is already a full replay per
  pre-pass, so refusing to export the incremental applier costs nothing and removes the footgun by
  construction. A test asserts `foldLedger` has no partial-input entry point.
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

### Question 2.4b: Is the admin-issuer invariant enforced across every entry type?

- **Assumption:** kumiai can guarantee "the ledger is admin-authored" without understanding a
  single application entry type, by asserting during the fold that every entry's issuer is an
  admin in the state accumulated from strictly-earlier entries — whatever the type — and rejecting
  the commit otherwise.
- **Done when:** the fold over an envelope's ordered entries checks the issuer of *every* entry
  against the running roster, and `group.role` entries additionally mutate it. Tests: an
  app-typed entry issued by an admin is stored and surfaced; the same entry issued by a member is
  **rejected**, not dropped (asserting the commit fails, and that `ledger_head` never covers an
  entry the ledger does not hold); `[promote Bob, entry-issued-by-Bob]` in one envelope is
  accepted, proving the check reads state-so-far rather than a pre-commit snapshot; an unknown
  `group.*` type rejects the commit; a non-`group.` type is passed through unread.
- **Spec excerpt:**
  > So, while folding an envelope's entries in order, kumiai asserts that **every** entry's issuer
  > is an admin in the state accumulated from strictly-earlier entries, whatever the entry's type,
  > and **rejects the commit** if one is not. Not a silent drop: a non-admin entry in an envelope
  > is anomalous, and dropping it would leave `ledger_head` covering an entry the ledger does not
  > hold.
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/roster.test.ts test/policy.test.ts`

### Question 2.5: Does the roster subsume the capability chain as the membership proof? — **ANSWERED: yes**

Read-only research, completed 2026-07-10. See the decision log. The chain is removed; `Invite`
becomes `{groupID, recipientDID, inviterID, ledgerEntries}`. Requirements 1, 3, and 4 of the relay
item dissolve. Question 5.3 dissolves. Question 5.4 shrinks to tests plus deletions. The original
framing is kept below for the record.

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

### Question 2.6: Can a single commit carry a `group_context_extensions` proposal and an Add?

A ts-mls capability probe, Phase-1 shaped, forced by the `ledger_head` design. Throwaway test.

- **Assumption:** a commit may carry a GCE proposal alongside an Add (RFC 9420 permits it), the
  receiving `commitPolicy` sees both proposals, and `proposal.groupContextExtensions.extensions[]`
  exposes each extension's `extensionData` — not merely its `extensionType`, which is all Q1.3
  established. The anchor guard is now a byte comparison, so `extensionData` must be reachable.
- **Done when:** an admin commits `[Add(bob), GCE([anchor, ledgerHead'])]` in one commit; a
  receiver's policy asserts it sees both proposals, reads the anchor's `extensionData` and finds
  it byte-identical to the current one, reads the new head, and accepts. A second test mutates one
  byte of the anchor in the proposed list and asserts the policy can detect it.
- **Spec excerpt:**
  > **The anchor guard is a byte comparison, not a type check.** A `group_context_extensions`
  > proposal replaces the entire extensions list rather than patching one entry, so every head
  > update re-includes the anchor. A policy rejecting "any GCE touching the anchor type" would
  > reject every head update.
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/ts-mls-probe.test.ts`
- **If false:** the head cannot ride the commit that changes roles, and must be moved (a separate
  commit, or out of the GroupContext entirely). Stop and revisit before Question 2.7.

### Question 2.7: Does the ledger head close the omission attack?

- **Assumption:** a hash chain over ordered entry ids, written to GroupContext extension `0xf101`
  and policed by every receiving member against its own chain, makes an inviter's omission from
  `Invite.ledgerEntries` detectable by the joiner.
- **Done when:** `head.ts` exports `LedgerHead`, the genesis constant, `extendHead(head, ids)`,
  `readLedgerHead(context)`, `LedgerIncompleteError`. Tests: genesis head is a pure function of
  the domain separator and `groupID`; `extendHead` is order-sensitive (swapping two ids changes
  the head); a joiner recomputing across the full ordered entry list reproduces the authenticated
  head; dropping any single entry — first, middle, or last — breaks it; a receiving member
  computing a head that disagrees with a proposed one rejects the commit.
- **Spec excerpt:**
  > **The head is not trusted because an admin wrote it.** It is trusted because the group would
  > otherwise have rejected the commit. Every receiving member checks the proposed head against
  > the chain extension it computes from its own ledger, and rejects on mismatch. It lives in the
  > GroupContext, not in GroupInfo, precisely because GroupInfo is signed by whoever exported it —
  > and for a Welcome that is the inviter, the party being defended against.
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/head.test.ts`

### Question 2.8: Does removal demote the removed?

- **Assumption:** a removed admin otherwise keeps ledger authority forever, because the fold's
  authority rule asks only whether the issuer was an admin in the state so far. Requiring a
  demotion entry in the removing commit's envelope closes it, and the empty-admin guard makes the
  last-admin self-removal a documented brick rather than a new failure mode.
- **Done when:** the policy rejects a Remove of a leaf whose DID holds `admin` unless the
  envelope carries a `group.role` entry demoting that DID. Tests: removing a plain member needs
  no entry; removing an admin without one is rejected; with one, accepted, and the roster no
  longer lists them as admin; a removed admin's later role entry, relayed by a colluding member
  in that member's own commit, is dropped by every peer; removing the **last** admin is rejected,
  self-removal included, and succeeds once another admin has been promoted.

### Question 2.9: Does the committer filter pending proposals?

Forced by Q2.6's third finding. Sender-side half of the policy.

- **Assumption:** ts-mls absorbs pending by-reference proposals into the next commit
  (`createCommit.js:111`), so any member can poison any other member's next commit. Filtering the
  pending set against the same `defaultCommitPolicy` before `createCommit` closes it, and the
  filter and the receiver can never disagree because they are the same function.
- **Done when:** kumiai's commit wrappers drop, before committing, every pending proposal the
  local policy would reject on receipt. Tests: non-admin Carol proposes a GCE by reference; admin
  Alice's next commit excludes it and is accepted by every peer; without the filter, that same
  commit is rejected by every peer (assert both, so the test proves the griefing vector exists
  rather than merely that the fix works); a legitimate by-reference proposal from an admin is
  still absorbed; the filter emits an observable notice per dropped proposal.
- **Spec excerpt:**
  > So the commit wrappers filter the pending-proposal set before calling `createCommit`, dropping
  > any proposal that the local policy would reject on receipt. Sender-side filtering,
  > receiver-side enforcement — the same division as the honest-client guards on `createInvite`
  > and `removeMember`.
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/policy.test.ts test/group.test.ts`
- **Spec excerpt:**
  > A removed admin therefore keeps ledger authority forever: it cannot commit, having no leaf,
  > but a colluding current member can carry its signed role entry in that member's own commit
  > envelope, and every peer folds it as authorized.
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/roster.test.ts test/policy.test.ts`

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
  > | `group_context_extensions` | `admin`, and the anchor extension present and byte-identical to the current one (the head redesign superseded the old "rejected if it touches the anchor type" rule, which would reject every legitimate head update) |
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

**Note (2026-07-10):** the *type* narrowing is pulled forward into Question 2.4, because
`roster.ts`'s value type must be exactly `'admin' | 'member'` and cannot import a `GroupPermission`
that still admits `'read'`. Q2.4 changes `capability.ts:11`, removes the dead `'read'` branch in
`extractPermission`, and fixes the two `credential.test.ts` cases. What remains for 5.1: the grep
sweep across `packages/` and `../kubun` proving no live reference survives, and the doc statement
that MLS cannot express read-only membership.

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

### 2026-07-10 — Question 1.1: `authenticatedData` round trip

**Findings:** CONFIRMED. The decoded `PrivateMessage.authenticatedData` is byte-equal to the
input, read off the framed message before `processMessage` and without epoch secrets. The frame
still decrypts and applies. Flipping one byte makes `processMessage` reject and the receiver
stays at its pre-commit epoch — `PrivateContentAAD` genuinely covers the field.

**Spec impact:** needs update. The spec says "`createCommit` and `joinGroupExternal` already
accept it." That is true of **ts-mls's** `createCommit`, not of kumiai's wrappers:
`commitInvite` and `removeMember` call through without `authenticatedData`, and there is no
generic commit wrapper. Only `joinGroupExternal` forwards it. Phase 2 gains a passthrough on the
commit wrappers, or the envelope has a carrier nothing can load.

**Learned:** the control envelope has a real, verified carrier at the ts-mls layer. The gap is
one level up, in kumiai's own API surface, and it is additive.

### 2026-07-10 — Question 1.2: external commit reachability

**Findings:** CONFIRMED. An external join decodes as `wireformats.mls_public_message` with no
epoch secrets; the joiner's DID parses out of `commit.path.leafNode.credential`; the receiving
`commitPolicy` is invoked with `senderLeafIndex === undefined`. The commit's inline proposal
types were `[3, 6]` — `remove` + `external_init`, **no Add**.

**Spec impact:** none. Confirms the design.

**Learned:** the joiner's credential is genuinely absent from `proposals`, so a synchronous
callback cannot see who is committing an external join. Resolving the path-leaf DID in the async
pre-pass is not one option among several — it is the only place the information exists.

### 2026-07-10 — Question 1.3: handle usable after a rejected commit

**Findings:** CONFIRMED, and more than asked. Bob and Carol both reject the same anchor-touching
`group_context_extensions` commit, both throw `CommitRejectedError`, both stay at epoch 2, and
Bob's next application message decrypts on Carol. Separately: the callback can read
`proposal.groupContextExtensions.extensions[].extensionType`, and the probe observed the anchor
type there.

**Spec impact:** none, but it upgrades a hope to a fact. The policy table's
"rejected outright if it touches the anchor extension type" is implementable; the anchor guard
does not have to blanket-reject every `group_context_extensions` proposal the way kubun's
`anchorImmutabilityPolicy` does.

**Learned:** rollback-by-non-assignment holds under a real two-peer reject, and peers that reject
the same commit converge rather than diverging.

### 2026-07-10 — Question 1.4: per-proposal sender

**Findings:** CONFIRMED. Bob (leaf 1) proposes Dave's removal by reference; Alice (leaf 0)
commits it; Carol's policy sees `proposals[0].senderLeafIndex === 1` against a commit
`senderLeafIndex === 0`.

**Spec impact:** none.

**Learned:** the laundering attack is preventable exactly as designed —
`p.senderLeafIndex ?? commit.senderLeafIndex` per proposal is sound. Mechanically, there is no
kumiai wrapper for a standalone by-reference proposal (`createProposal` must be called on ts-mls
directly), and every receiver must process the proposal before the commit that references it,
because the sender is resolved from the receiver's own `unappliedProposals`. The Phase 3
laundering test therefore drives ts-mls directly.

### 2026-07-10 — Question 2.5: does the roster subsume the capability chain?

**Findings:** yes, from both sides independently. Nothing the chain proves is lost — signature,
group scoping, permission level, root-from-creator are each carried by a signed role entry at
equal or greater strength. Its only exclusive properties are `exp` (supported at
`capability.ts:39,59-60`, set by no mint site, out of scope) and `jti` revocation (in
`@kokuin/capability`, never wired, weaker than roster demotion). The `aud`-to-joiner binding the
whole question was framed around **is not enforced today**: `capability.ts:28,55` mint it,
`validateGroupCapability` (`capability.ts:95-124`) never reads it. The chain's entire
authorization value is spent at one call site, `group.ts:587`. Kubun references it in zero places
and persists `rootCapability` only to restore the MLS handle; per-document grants are a separate
axis, self-issued with a document `res` and no `parentCapability`.

One genuine cost: the anchor is **not** readable before `mlsJoinGroup` — the Welcome's GroupInfo
is encrypted to the joiner's key package and ts-mls exposes no decrypt-without-join helper
(`inspectGroupInfo` decodes only *unencrypted* exported GroupInfo). Authorization moves after the
join. Sound, because `mlsJoinGroup` verifies the GroupInfo signature, signer credential, ratchet
tree, and confirmation tag before returning state.

Also learned, unprompted: a depth cap already exists (`DEFAULT_MAX_DELEGATION_DEPTH = 20`) and is
configurable through `validateGroupCapability`'s existing `options` — no `@kokuin/capability`
change would have been needed had we kept the chain.

**Spec impact:** large. `Invite` loses `capabilityToken`, `capabilityChain`, and `permission`.
`GroupHandle.rootCapability` and `MemberCredential.capabilityChain` / `.capability` go too. Kubun
stops serializing `rootCapability`. Relay-item requirements 1, 3, 4 dissolve; Question 5.3
dissolves; 5.4 shrinks to tests. Spec section "The roster replaces the capability chain" written.

**Learned:** two membership proofs that can disagree is how a confused deputy gets built. The one
with a total order and a revocation primitive wins.

### 2026-07-10 — Question 2.3(b): `ord` ships

**Findings:** answered by the consumer rather than by a probe. Kubun requires a signed ordering
slot: four sub-ledgers evaluate authority at the entry's own HLC (`isAdminAtHLC`, `isOpenAtHLC`,
and the circle-member rule composing them). It needs kumiai to sign over the field and hand it
back, not to interpret it.

**Spec impact:** the "default to deleting it" is withdrawn. `ord?: string` stays, documented as a
kubun requirement rather than as speculation.

**Learned:** the field was invented at spec self-review with no consumer asking for it, and turned
out to have one. Ask the consumer before probing.

### 2026-07-10 — fold API shape

**Findings:** kubun shipped and found in review a defect where per-type incremental projection
diverges permanently. A `circle.member` self-join authorized against the `group.settings`
sub-ledger, delivered first, folds against empty settings, is dropped as unauthorized, and the
watermark advances anyway; nothing re-triggers the projection and a re-broadcast is a digest
duplicate (`groups/broadcast.ts:717-793`).

**Spec impact:** `foldLedger` is full-replay only. No incremental apply, no watermark, no
`dependsOn` — the latter only if a future reducer genuinely needs cross-type authority, and before
an incremental applier rather than after.

**Learned:** kumiai's roster fold was already full-replay, so the safe API costs nothing. A
library that exports the incremental path hands every host the same bug.

### 2026-07-10 — invite-seeded ledger omission

**Findings:** every entry is signed, so an inviter cannot forge one — but it can omit one, and
absence has no signature. Kubun suggested the joiner could detect gaps against the epoch chain.
Checked: `ConfirmedTranscriptHashInput.content` is a `FramedContentCommit` and `FramedContent`
carries `authenticatedData` (`framedContent.d.ts:39`), so the transcript **does** commit to every
envelope — but a joiner holds only the final hash and cannot invert it. The property exists for
existing members, not for the party that needs it.

**Spec impact:** new section "The ledger head". GroupContext extension `0xf101` carries a hash
chain over ordered entry ids. Peers police the head against their own chain; a joiner recomputes
from genesis over `Invite.ledgerEntries`. Forces three changes: the anchor guard becomes a byte
comparison (a GCE proposal replaces the whole extension list), leaf capabilities advertise both
types, and head updates ride only role-changing commits. New Questions 2.6 and 2.7.

**Learned:** the spec's "rejected alternative" of a GroupContext permission map was rejected for
unboundedness and for colliding with blanket anchor immutability. Q1.3 removed the second reason,
and a fixed-size digest removes the first. A rejected alternative's *reasoning* can survive while
its *conclusion* stops generalizing.

### 2026-07-10 — no `invite` permission level

**Findings:** kubun asked for an `invite` level (Add without Remove) so a hub or CLI could onboard
without eviction rights. Enforceable, unlike `'read'`, so the argument that killed that level does
not apply. Declined on cost: the roster's authority rule would gain a second clause (an `invite`
holder may issue `value: 'member'` only for a subject not already in the roster, else it could
demote an admin), and the GCE row a matching exception, since an inviter must move the
`ledger_head`. Its only named consumer is already an admin.

**Spec impact:** `GroupPermission` stays `'admin' | 'member'`. Invites are admin-only. Recorded as
declined-with-reasons, not overlooked.

**Learned:** widening the union later is additive for value producers; the authority rule is what
resists it. Decide when a topology demands it.

### 2026-07-10 — removal must demote the removed

**Findings:** surfaced while reasoning about who may write the head. The fold's authority rule
asks only whether the *issuer* was an admin in the state so far, and an MLS Remove is not a roster
operation — so a removed admin keeps ledger authority indefinitely. It cannot commit, having no
leaf, but a colluding member can carry its signed role entry in that member's own commit envelope
and every peer folds it as authorized. Blast radius is narrow (`add` checks the proposal sender;
`external_init` demands a prior leaf) but the roster stays corrupted by someone the group evicted.

**Spec impact:** a Remove of a leaf holding `admin` must carry a demotion entry for that DID in
the same envelope, or the commit is rejected. New Question 2.8. The last-admin self-removal is a
documented brick — the guard keeps the roster non-empty while the group has no admin member, and
refusing to let the last admin leave would be worse.

**Learned:** a defect in *this* spec, not a feature missing from the revocation backlog. The
question "who may write the head" is what made it visible; the head itself did not cause it.

### 2026-07-10 — Question 2.6: GCE + Add in one commit

**Findings:** all three CONFIRMED, no stop condition tripped. `createCommit` accepts
`[Add(bob), GroupContextExtensions([anchor, ledgerHead'])]` in one commit and the receiving
callback sees both proposals. `extensionData` is reachable as a `Uint8Array` and byte-comparable
against the handle's own pre-commit `groupContext.extensions`; a single flipped anchor byte is
detected inside the synchronous callback and rejected, epoch unchanged. A standalone GCE proposal
issued by a non-admin and absorbed into another member's commit reports the *proposer's*
`senderLeafIndex`, as Q1.4 showed for Remove.

**Spec impact:** the `ledger_head` design stands unchanged. But Q3 exposed a defect that was not
on any list — see the next entry.

**Learned:** the anchor guard is enforceable entirely inside the synchronous callback, which is
what the whole head design was resting on. Two more kumiai wrapper gaps: no wrapper builds a mixed
Add+GCE commit, and none issues or relays a standalone GCE proposal. Both join the
`authenticatedData` passthrough on the Phase 2 commit-wrapper rewrite.

### 2026-07-10 — pending-proposal griefing

**Findings:** ts-mls absorbs pending by-reference proposals into the next commit automatically
(`createCommit.js:111`, demonstrated end to end by Q2.6's third test). A non-admin proposes a GCE
— or an `add`, or a `psk` — and the next member to commit, however innocently, has it folded in.
Every peer rejects that commit for a proposal its sender lacked permission to make. The committer
did nothing wrong; the group stalls.

**Spec impact:** new section "The committer filters pending proposals". The commit wrappers filter
the pending set against the same `defaultCommitPolicy` before calling `createCommit`. Sender-side
filtering, receiver-side enforcement.

**Learned:** a receiving-side policy is necessary and not sufficient. Anything the receiver rejects,
the sender must decline to carry — otherwise the rejection becomes a weapon aimed at the wrong
member. This generalizes: every row of the policy table is also a filter rule.

### 2026-07-10 — kubun's second reply

**Findings:**

1. Our suspicion about kubun's `admin.role` was **wrong at authorship**: `removeMember`
   (`context/group.ts:875-935`) already resolves `removedIsAdmin` before the tombstone, refuses to
   remove the last admin, and signs an `admin.role: 'revoked'` entry sharing one HLC with it. The
   record is corrected.
2. But kubun couples demotion to removal by **HLC**, and ships it as a separate broadcast over a
   fan-out that silently drops without a live hub binding. A peer can process the Remove and never
   receive the revocation; its pure-ledger circle folds (which cannot read membership rows without
   diverging) then fold the ex-admin's entries as authorized. Envelope coupling removes the failure
   mode rather than narrowing it.
3. Kubun asks us to refuse a last-admin removal outright rather than document the brick. They are
   right, and they had the rule already.
4. Their cross-ledger fix (`e8308b64`) found *both* dependencies broken, not one, and surfaced a
   direction asymmetry: rebuilding on authority change revives dropped entries but never prunes
   rows invalidated by a later-arriving, earlier-HLC revocation.

**Spec impact:** three edits. Same-commit delivery stated as a design property, not an incidental.
Last-admin removal refused, self-removal included. `foldLedger`'s docs must say the projection is
the complete state, not a delta — a host that merges rather than replaces is silently wrong in the
remove direction only.

**Learned:** the remove direction needs a revocation claiming an earlier point than the entries it
invalidates, while arriving later. Signer-asserted HLC permits it; epoch-assigned order does not.
kumiai cannot reach the state at all. That is the third distinct bug the no-clock decision has
retired, after fork divergence and backdating.

### 2026-07-10 — the ledger notarizes; `app` does not

**Findings:** kubun asked whether `Invite.ledgerEntries` is roster-only. Three options were put up
(split the slot / one list with a typed filter / one list and one chain). All three were wrong,
and the user proposed the fourth: the ledger carries **every** entry type with identical
guarantees, kumiai interprets only `group.role` and surfaces the rest to the consumer, and a
separate opaque `app` slot carries whatever does not want to be an entry.

The reason it is right emerged while checking it. Omission of an admin-authored entry **grants** —
a dropped demotion leaves stale admin authority, a dropped circle-closing leaves later self-joins
folding as valid. Omission of a member's self-claim **denies** — a peer that never learns of a
self-join simply serves that member nothing. So the admin/member line is exactly where omission
stops being safe, and the verification boundary belongs there. Kubun's own spec already concedes
the self-join premise is not fold-verifiable and enforces it at the serve gate, so self-joins lose
nothing by moving to `app`.

Two things fell out that we had been treating as costs. The GCE row stays single-clause (entries →
head → GCE → admin), so the conditional that killed the `invite` level is not reintroduced. And
the un-prunable head chain now covers only the *rare* data: admin actions. The fast-growing
per-member claims live in the prunable slot. Compaction stops being urgent.

**Spec impact:** new section "Two slots: the ledger notarizes, `app` does not", carrying the
choice rule (**if losing an entry would grant something, it is a ledger entry and an admin signs
it**), the admin-issuer invariant, the `group.*` reserved namespace, and the growth argument.
`Invite` gains `app?`. `GroupOptions` gains `onLedgerEntries`. `ControlEnvelope.entries` documented
as any-type. Migration section now splits kubun's four sub-ledgers along the rule.

Added refinement, not in the original proposal: the admin-issuer invariant is **enforced** rather
than arranged. While folding an envelope's entries in order, every entry's issuer must be an admin
in the state accumulated so far, whatever its type, and the commit is **rejected** if one is not —
not silently dropped, which would leave `ledger_head` covering an entry the ledger does not hold.
State-so-far, not a pre-commit snapshot, or `[promote Bob, entry-issued-by-Bob]` would fail.

**Learned:** "verified" is not a property everything wants more of. The question is what an
omission does. We had been about to buy completeness for data whose loss fails closed, and pay for
it with an un-prunable chain over the fastest-growing entries in the system.

### 2026-07-10 — `app` is a JSON value, and the anchor must never be re-encoded

**Findings:** the Q2.1 brief asked the probe to "pick an encoding that round-trips arbitrary bytes"
for `GroupAnchor.app`. The user asked why `app` needed to be bytes at all when the container is
already JSON. It doesn't: a `Uint8Array` field would be base64 inside JSON — a size tax and a
decode step on every consumer, for nothing — and kubun's actual payload (`recoverySecret`, base64
of 32 bytes) is a string already. There was no design decision, only an invented one.

All three slots become `app?: unknown`. `unknown` and not `any`, so the library cannot read the
value by accident; and not `extension`, which would collide with `GroupContextExtension` and with
`readGroupAnchorExtension` in the same file.

**Spec impact:** chasing the encoding surfaced a real hazard, unrelated to the answer. Every
`ledger_head` update is a GCE proposal, and a GCE proposal replaces the whole extension list, so
each one re-includes the anchor — which the receiving policy then byte-compares. **JSON does not
round-trip canonically.** A builder that re-encodes a decoded `GroupAnchor` rather than copying its
`extensionData` verbatim would make honest commits fail the comparison intermittently, and the
failure would look exactly like an attack. `anchor.ts` now exposes `readGroupAnchorExtension`, and
the discipline is written into the spec: decode to read, never to re-emit.

**Learned:** a question about a type surfaced a bug in a mechanism two sections away. The
byte-comparison guard was specified before anything that had to *produce* the bytes it compares,
so nothing had yet asked who builds them.

### 2026-07-10 — Question 2.1: generic `GroupAnchor`

**Findings:** DONE. `anchor.ts` ports kubun's anchor generically — `{creatorDID, version,
app?: unknown}`, both extension type constants, tolerant `null`-on-malformed decode,
`readGroupAnchor` (throws on corruption, null on absence), `readGroupAnchorExtension` (verbatim
bytes), `controlCapabilities()` advertising both `0xf100` and `0xf101`. Test-first, 8 tests, all
four verify commands green, full 120-test suite unregressed.

**Surprise:** `defaultCapabilities()` seeds *random GREASE values* into `.extensions`, so
`controlCapabilities()` output is non-deterministic beyond the two control types. Caught a flake in
the probe's own first-draft test. **Repo rule for the rest of Phase 2 and beyond: no test may
assert the exact contents of a capabilities `extensions` array — only that a specific type is
present, and its occurrence count.**

**Spec impact:** none beyond what the `app?: unknown` correction already recorded. `createGroup`'s
"always write an anchor" is deliberately *not* here — it arrives with the roster, when the anchor
becomes load-bearing as the seed.

**Learned:** the verbatim-bytes discipline read fine as usage (`readGroupAnchorExtension` did not
need renaming), so the anchor half of the byte-comparison guard is now real code with a doc comment
carrying the reason.

### 2026-07-10 — Question 2.2: `LedgerEntry` with `groupID`

**Findings:** DONE. `ledger.ts` ports kubun's `ledger-entry.ts` faithfully — `signLedgerEntry`
(`embedLongForm: true`), `verifyLedgerEntry` (null-never-throws), `ledgerEntryDigest` — with
`groupID` woven through the signed claim, the verify shape check, and the `VerifiedLedgerEntry`.
`ord` is conditional on both sides, so no `undefined` key is ever signed. 12 tests, full suite 132,
all four verify commands green. The replay test proves both halves: the group-A entry verifies
fine (validity was never the defence), a group-B fold drops it, and both folds see the *same*
`ledgerEntryDigest` — content-addressing is no defence, identical bytes.

**Surprise, and it is worth keeping:** the `alg: 'none'` rejection happens in two layers, not one.
A 2-segment unsigned token (`createUnsignedToken` + `stringifyToken`) is rejected by `verifyToken`
at the JWT *format* check ("expected 3 parts") — **before** the header's `alg` is read, so
`isVerifiedToken` is not what stops it. Only a well-formed 3-segment `alg: 'none'` token reaches the
header and is rejected by `isVerifiedToken`. The test asserts both paths, so a refactor of either
layer cannot silently reopen the hole. The forgery is constructible through the public API; the
defence holds.

**Spec impact:** none. The port matches the spec's `LedgerEntry` block exactly.

**Learned:** "`isVerifiedToken` rejects `alg: 'none'`" is true but incomplete — the format check is
the first gate, and the two must both be tested because the defence is usually attributed only to
the second.

### 2026-07-10 — Question 2.3: `foldLedger`, full-replay, caller-ordered

**Findings:** DONE. `fold.ts` ports kubun's fold with both decided departures — no internal sort
(`compareFoldInputs` deleted; folds in caller order) and replay-only (single `foldLedger` entry
point, no incremental applier). Seeds from the anchor, evaluates authority against state-so-far,
drops-never-throws with an `onDrop` observer, does not mutate the input. 8 tests, full suite 140,
all four verify commands green. Replay-only surface asserted at runtime
(`Object.keys(namespace) === ['foldLedger']`), chosen over a type-level check because value exports
*are* the runtime surface.

**My brief had a bug the probe caught.** The rotation example — "Alice grants Bob; Bob revokes
Alice; Bob's grant of Carol survives" — does not distinguish state-so-far from final state, because
Bob stays an admin throughout, so nothing separates the two semantics. For the property to bite,
the *issuer* of the surviving grant must be the party later revoked. The probe flipped it to Alice
grants Bob → Bob grants Carol → **Alice revokes Bob**: Carol survives only under state-so-far. I
corrected the same wording in the spec's testing section, where it originated.

**Spec impact:** the testing bullet corrected. No design change.

**Learned:** a state-so-far test is only real when the revoked party is the grantor of the entry
whose survival is asserted. The naive phrasing looks right and tests nothing — worth stating in the
roster step (Question 2.4), which reuses the same actors.

### 2026-07-10 — Question 2.4: the roster reducer

**Findings:** DONE. `roster.ts` generalizes kubun's admin reducer from an `admin`/`revoked` `Set`
to a `GroupPermission` `Map`, on the `foldLedger` from 2.3. `roleReducer` is the composable
seed/authority/apply; `foldRoster(entries, anchor, groupID, onDrop?)` is the safe entry point that
closes the two things the bare reducer cannot: `groupID` scoping (the anchor carries no group id,
so the group is passed explicitly — decision (a)) and the empty-admin guard. 25 tests across
roster + credential, full suite 149, all four verify green. The rotation test uses the corrected
form (Alice→Bob→Carol, Alice demotes Bob, Carol survives).

**Step 0 narrowing landed:** `GroupPermission = 'admin' | 'member'`; the dead `'read'` branch of
`extractPermission` removed (an `act:'read'` capability now throws "no recognized permission
level"); the two `credential.test.ts` cases assert the throw rather than losing coverage. Phase 5.1
keeps only the `../kubun` grep sweep and the docs prose.

**Two API-shape notes, neither blocking:**
- The empty-admin guard sits in `verifyAuthority` (it computes the would-be next state and checks
  the admin count survives), because `foldLedger` only routes `onDrop` from its type/authority
  checks. Side effect: a guard-drop reports reason `"issuer not authorized"`, which is misleading —
  the issuer *was* authorized; the entry would brick the group. Honest messaging needs `foldLedger`
  to carry a caller-supplied drop reason, which is a fold API change deferred rather than made
  mid-step. **Follow-up: give the empty-admin drop its own reason once the policy layer needs
  richer `onDrop` anyway.**
- `roleReducer` is exported bare, without scoping or the guard, mirroring kubun's
  `adminRosterReducer` / `foldAdminRoster` split. The doc comment warns it is the composable piece
  and `foldRoster` is the safe entry. Since the fold is replay-only there is no incremental-applier
  reason to need the bare reducer; the only consumer is someone building their own scoped fold.
  Left exported with the warning; revisit if nothing outside the package uses it.

**Spec impact:** none. Matches "Roster and authority rules".

**Learned:** decision (a) added a `groupID` parameter the spec's sketched `foldRoster` signature did
not show — because the anchor deliberately has no group id, and adding one would have been the wrong
fix (the probe correctly stopped short of touching the anchor).

### 2026-07-10 — Question 2.7: the ledger head hash chain

**Findings:** DONE. `head.ts` — pure `genesisHead` / `extendHead` / `computeHead`, a binary
encode/decode codec, the two `read*` handle helpers mirroring the anchor, and
`LedgerIncompleteError` / `assertHeadMatches`. 12 tests, full suite 161, all four verify green.
Domain separator `utf8("kumiai/mls/ledger-head/v1")`; each id length-framed with a 4-byte
big-endian prefix (proves `['ab','c'] ≠ ['a','bc']`); head extension is 33 bytes — one version byte
plus the 32 digest bytes, a canonical binary form so it can be byte-compared without the JSON
re-encode hazard.

**The probe caught a second bug in my spec.** The formula `headₙ = SHA256(headₙ₋₁ ‖ id₁ ‖ … ‖ idₖ)`
reads as one hash per batch, but that fails the composition property the design needs: a joiner
folds the whole `Invite.ledgerEntries` list at once, while existing members extend batch by batch,
and `SHA256(SHA256(h‖a)‖b) ≠ SHA256(h‖a‖b)`. Only a **per-id chain link** (`head ← SHA256(head ‖
frame(id))`, folded left to right) makes the two agree. The probe implemented per-id linking as the
only construction satisfying requirement #4 and flagged the spec's shorthand. Spec formula
corrected.

**Spec impact:** the head formula rewritten to per-id linking, with the composition reasoning
stated. No behavioural change to anything downstream — the corrected formula is what the code
already does.

**Learned:** two spec bugs now (2.3 rotation, 2.7 head formula), both mathematical shorthands that
looked right and were wrong, both caught by a probe writing the property as an executable test. The
learning loop is doing exactly what it is for — the assumptions that never ran are the ones that
were subtly false.

### 2026-07-10 — Phase 1 exit

All four claims confirmed on first attempt; no `BLOCKED`. The architecture stands. One piece of
added Phase 2 scope (the `authenticatedData` passthrough), two refinements (narrowed anchor
guard, direct ts-mls calls for by-reference proposals). The throwaway probe
(`packages/mls/test/ts-mls-probe.test.ts`) is deleted; its evidence is in
`docs/superpowers/probes/phase-1-report.md`.

### 2026-07-10 — Question 3.1: fail-closed `ControlEnvelope` decode

**Findings:** CONFIRMED. `v` alone is fail-closed; no `requires` field. `envelope.ts` exports
`ControlEnvelope`, `CONTROL_ENVELOPE_VERSION`, `DecodeResult`, `encodeControlEnvelope`,
`decodeControlEnvelope`. Decode is total — never throws — over 9 tests; full suite 170 (+9), tsc and
biome clean.

**Decisions recorded:**
- `DecodeResult = { ok: true; envelope } | { ok: false; reason }`. A rejection is a *value*, not a
  throw: an uninterpretable envelope is a normal outcome that maps to reject-the-commit, and the
  policy must decide without a try/catch. `reason` is log-only.
- **Empty/zero-length `authenticatedData` decodes to `{ v: 1 }`** — accept, not reject. An ordinary
  commit that writes no ledger entries (key rotation, Update, self-Remove, or a pre-envelope client)
  carries empty bytes; the anchor is load-bearing so every group has one, and rejecting empty would
  reject every ordinary commit.
- **Unknown extra JSON keys are tolerated and dropped** (carry only `v`/`entries`/`app`), matching
  the anchor/head tolerant-decode discipline. Rejecting unrecognized keys would be a `v` bump, not a
  change here.

**Spec impact:** none. The codec matches the spec's `ControlEnvelope` block verbatim, `app?: unknown`
included.

**Learned (machine note):** the `rtk` shim intercepts `pnpm exec biome check …` as well as
`pnpm run` — both print a fake pass and exit non-zero. Real biome output comes from
`rtk proxy pnpm run lint` (which runs `biome check --write`, so run it *before* staging) or the
binary directly. Brief verify lines updated to stop hard-coding `pnpm exec biome`.

### 2026-07-10 — Question 3.2: the commit policy as a pure function

**Findings:** CONFIRMED. `defaultCommitPolicy` decides every table row from `(roster, didOfLeaf,
anchorExtensionData, externalCommitDID, incoming)` with no I/O, live group, or crypto. `policy.ts`
exports `CommitPolicyContext`, `defaultCommitPolicy`, `MissingLedgerEntriesError`. 21 tests; full
suite 191 (+21); tsc and biome clean.

**The laundering attack (Q1.4) is closed in code.** Per proposal the effective sender is
`proposal.senderLeafIndex ?? commit.senderLeafIndex`; a test drives the real attack (admin
committer, member-authored by-reference Remove of a third party) and it rejects.

**`external_init` is judged at the commit level**, not per-proposal: `externalCommitDID` must be a
roster member and the commit's proposals must be exactly `{external_init, remove-of-that-DID's-leaf}`.

**GCE row — implemented:** admin sender + anchor present and byte-identical to `anchorExtensionData`
(mutation/absence/non-admin all reject). **Deferred** to Q2.4b / head-wiring: "nothing but
`ledger_head` may differ" and "a head move requires a matching envelope `entries` list", both of
which bind the policy to the envelope/head chain and are not resolvable in the pure table.

**Spec impact:** none to the design. The plan's own Q3.2 excerpt carried the *old* GCE rule
("rejected outright if it touches the anchor extension type"), which the ledger-head redesign
superseded — corrected in place to the byte-comparison rule, since the old rule would reject every
legitimate head update.

**Learned:** `isDefaultProposal()` does double duty — it is the fail-closed unknown-`group.*`/custom
row *and* the narrowing guard that lets a `switch` on `proposalType` see only default variants
(`ProposalCustom.proposalType` is a bare `number`). Worth reusing verbatim in the Phase-4 pre-pass.
Crypto-bearing proposal payloads (add/update/psk/reinit/external_init) need no fabrication in tests:
the policy reads only the type tag and sender for those rows, so a tag-only literal with an opaque
cast, confined to unread fields, is sound; `remove`/GCE (the inspected payloads) are fully typed.

### 2026-07-10 — Question 2.4b: the admin-issuer invariant across every entry type

**Findings:** CONFIRMED. `envelope-fold.ts` exports `foldEnvelope(baseRoster, entries, groupID)` and
`EnvelopeFoldResult`. One pass over the envelope's ordered entries, one rule: every issuer must be an
admin in the state-so-far (a mutating copy of the base roster), whatever the type. `group.role`
entries additionally mutate the roster (with the empty-admin guard); an unknown `group.*` rejects;
any non-`group.` type is surfaced verbatim, its `value` never inspected. 12 tests; full suite 203
(+12); tsc and biome clean.

**The strict/permissive split is the whole point.** `foldRoster` *drops* an unauthorized entry
silently (right for kubun's hostile ingest); `foldEnvelope` *rejects the commit* the moment one is
off (right for a kumiai envelope, so `ledger_head` never covers an entry the ledger does not hold).
A member-issued app entry rejects with the issuer named — a real test, not a drop.

**State-so-far proven by a pair.** `[promote Bob, entry-by-Bob]` accepts; the reorder rejects on
`bob-app`. The invariant subsumes `group.role`'s own authority rule — both are "issuer is admin in
state-so-far" — so there is exactly one check, not two.

**Spec impact:** none. Matches the "admin-issuer invariant" and "type namespace" spec sections.
`EnvelopeFoldResult` carries `entryID` on reject so the caller can log which entry failed.

**`roster.ts` touched:** `adminCount` promoted from module-private to exported and reused (no
reimplementation, no behaviour change).

**Process note:** the probe subagent died on a session limit *after* writing the module + tests but
*before* the full-suite run or its report file. I read the code, ran all four verify commands myself
(green), and recorded the finding here in place of the probe report. The learning-loop's "I verify,
not the probe" step caught this cleanly — the probe's own claim of success was never load-bearing.

### 2026-07-10 — Question 2.8: removal demotes the removed

**Findings:** CONFIRMED. A Remove is rejected unless the target's DID is `member` in the *candidate*
roster (post-`foldEnvelope`), checked before the self-removal shortcut, so an admin cannot self-remove
without a demotion in the same envelope. `CommitPolicyContext` split its single `roster` into
`baseRoster` (sender authority) and `candidateRoster` (removed-target demotion), making explicit the
distinction Q4.3 parked: a promotion riding a commit grants no commit authority (base), but a demotion
riding a commit does count against the removed target (candidate). 6 new tests; full suite 209 (+6);
tsc and biome clean.

**Layer separation.** The last-admin brick is rejected **upstream in `foldEnvelope`** (the required
self-demotion trips the empty-admin guard before any candidate roster exists), never in the policy.
`foldEnvelope` guarantees ≥1 admin survives; the policy enforces demote-before-remove. A colluding
admin cannot launder a demoted ex-admin's relayed ledger entry — `foldEnvelope` rejects it on
`non-admin issuer` (an explicit relay test was added).

**Spec impact:** none to the design. The base/candidate roster split is a Phase-4 wiring contract now
written into the type: the pre-pass folds `baseRoster` from `#ledger` and `candidateRoster` from
`#ledger ∪ envelope`, and hands both to the policy.

**Learned:** the demotion requirement collapses to a single candidate-roster predicate ("removed DID
is not still `admin`"), no separate "envelope carries a matching demotion entry" scan — because
`foldEnvelope` already applied the demotion into the candidate. Composition did the work a bespoke
check would have duplicated.

### 2026-07-10 — Phase 3 exit

All Phase 3 questions answered: 3.1 (envelope codec), 3.2 (pure policy table), 2.4b (admin-issuer
invariant), 2.8 (removal demotes). Exit criterion — *"the policy table is enforced by a function whose
only inputs are already-folded local state"* — is met: `defaultCommitPolicy` and `foldEnvelope` are
both pure over caller-supplied rosters and verified entries, no handle, no I/O, no live group. New
modules: `envelope.ts`, `policy.ts`, `envelope-fold.ts`. The base/candidate roster contract and the
`isDefaultProposal` narrowing guard are the two hand-offs into Phase 4. Full suite 209.

### 2026-07-10 — Question 4.0 (split) + 4.4: handle control state, anchored at creation, fails closed

**Split rationale:** plan-Q4.1 bundled the handle's *state* with the *pre-pass* that reads it. The
pre-pass has nothing to fold a candidate roster from until the handle holds a ledger, so state was
peeled off as Q4.0 (absorbing Q4.4's anchorless-fail-closed — same surface). User approved the split
and "keep driving through probes."

**Findings:** CONFIRMED, both. `GroupHandle` gains `#anchor`/`#ledger`/`#roster`, seeded in the
constructor from the anchor baked into the group's own GroupContext; getters `anchor`/`roster`; an
async `applyLedgerEntries(tokens)` (verify → dedup by content id → drop null/cross-group → refold
roster). `createGroup` now injects the default anchor + genesis head when absent (a caller-supplied
anchor with an `app` payload is left untouched); `createKeyPackageBundle` advertises the control
types via `controlCapabilities()`; `restoreGroup` gains `ledgerEntries?` and rehydrates. Full suite
214 (+5); tsc and biome clean.

**The anchorless guard lives in the constructor** — the single choke every construction path
(`createGroup`, `restoreGroup`, `processWelcome`, `commitInvite`, `removeMember`, `joinGroupExternal`)
flows through. `readGroupAnchor(this)` returns `null` → throw; corrupt → its own throw propagates.
Structurally impossible to hold an anchorless handle. This is stronger than the plan's "restoreGroup
and processWelcome throw" — every path is covered by construction, for free.

**Spec impact:** none to the design. It realizes the spec's "a handle whose GroupContext carries no
anchor has no seed and cannot fold a roster — throw rather than install a permissive policy."

**Surfaced a latent bug.** `external-rejoin.test.ts` used `0xf100` as an "arbitrary custom extension"
— which is now the real anchor type. The collision was invisible before this change (no group was
anchored); the probe caught it because ts-mls's extension bookkeeping now sees two `0xf100`s. Moved
the fixture to `0xf200`. Five test files changed meaning in total (anchor, head, group,
groupcontext-extension, external-rejoin); each preserves intent, the "absent → null" cases flipping
to "auto-anchored" and the corrupt-anchor throw moving from `readGroupAnchor` to `createGroup`.

**Two caveats, both deferred to Q4.1 (the pre-pass) where they belong:** (1) `#ledger` folds in
Map-insertion order, not the authenticated epoch-chain order the spec ultimately requires; (2) one
`as FoldInput<RoleValue>` cast where the mixed-type ledger meets role-specialized `foldRoster` (safe:
the fold drops non-role by type; the strict value/issuer gate is `foldEnvelope`).

**Learned:** anchoring at creation and reading the anchor back in the constructor turned Q4.4 from a
two-function check into a structural invariant — the fail-closed property is now a consequence of the
type existing, not a guard someone can forget to call. And auto-anchoring flushed out a test fixture
that had been squatting on a reserved extension type in silence.

### 2026-07-10 — Question 4.1: the async pre-pass for internal commits (+ 4.2 satisfied)

**Decisions taken (user-approved):** enforcement is **on by default** for anchored groups (a caller
`commitPolicy` overrides); the external-commit (PublicMessage) verdict is split to Q4.1b.

**Findings:** CONFIRMED. The async pre-pass composes with the synchronous ts-mls callback.
`processMessage` and `decrypt` share `#prepareCommitPipeline(decoded, opts)` → `{callback, capture,
applyOnAccept}`. A non-PrivateMessage-commit frame takes the exact pre-envelope path (caller policy
only), so external/PublicMessage and application messages are untouched. For a private commit the
pre-pass decodes the envelope, resolves + verifies entry bodies (content-addressing binds the
untrusted resolver's body to the requested id), folds a candidate roster off the pre-commit state,
and precomputes `didOfLeaf`/`anchorExtensionData`; the sync callback is a pure lookup
(`precomputedReject ? reject : callerPolicy ? caller : defaultCommitPolicy`). 10 new tests; full
suite 224; **0 existing tests changed** (every existing receiver-processed commit is admin-authored,
which the default policy accepts).

**Q4.2 (three-field rollback) is satisfied structurally, not by a separate probe.** `applyOnAccept`
— merge `#ledger`, adopt `#roster`, fire `onLedgerEntries` — runs only on accept; a reject or any
throw mutates nothing but `#state` (which ts-mls returns as the pre-commit state). `MissingLedgerEntriesError`
throws *inside the pre-pass, before `mlsProcessMessage`*, so the handle stays at its pre-commit epoch,
and it is not overridable by a caller policy (a test asserts it still throws under accept-all). The
Q4.1 test set already covers the reject-leaves-epoch and throw-then-retry cases Q4.2 named; a
dedicated 4.2 probe would be redundant. Mark 4.2 answered here.

**Spec impact:** none. Realizes the spec's three-phase `processMessage` (async pre-pass → sync
callback → commit-by-assignment) and "the default policy" being on by default.

**Deferred:** ledger-head/GCE coupling (a commit with `entries` but no matching head is accepted for
now), external-commit verdict (Q4.1b), standalone-proposal gating, commit-wrapper write side.

**Learned:** the sync/async tension the whole design was shaped around dissolves cleanly once the
pre-pass precomputes every input the callback needs — the callback never awaits, never resolves, never
folds. And "commit by assignment" makes rollback free: there is no undo because nothing is mutated
until the accept path runs `applyOnAccept`. One judgment call: `onLedgerEntries` fires only when
`surfaced` is non-empty (a no-op otherwise), rather than calling the sink with `[]`.

### 2026-07-10 — Question 4.3: authority is state-so-far, not post-commit

**Findings:** CONFIRMED on a live handle, test-only, no production change (the pre-pass already
implements it). Three tests in `group.test.ts`. Full suite 227.

**The property that matters:** a *validly* Alice-signed promotion of Bob, riding a commit **Bob**
authors to Add Carol, is **rejected** — `foldEnvelope` accepts the entry (candidate roster → Bob
admin), but the Add's sender authority is judged against the **base** roster (Bob still a member).
Promotion and its exercise cannot be atomic in one commit. This is the Q2.8 base/candidate split
composing exactly as intended; it passed on the first run. A member self-signing its own promotion is
rejected by the admin-issuer invariant (issuer not admin in state-so-far).

**Ordering finding (recorded):** entry **resolution precedes authority evaluation** — the pre-pass
gates in a fixed order: **resolve → fold/authority → policy**. The first draft of the self-bootstrap
test gave the receiver no resolver, so it threw `MissingLedgerEntriesError` (unresolvable body)
*before* `foldEnvelope` could reject the entry on admin-issuer grounds. Both fail closed, but they are
different errors in a fixed order: an *unresolvable* entry and an *unauthorized* entry surface
differently, and resolution wins. A caller that distinguishes them must know this. (The test now
supplies the token so it exercises the authority path and rejects with `CommitRejectedError`.)

**Spec impact:** none. Confirms "the candidate roster is folded before the commit is applied."

**Learned:** writing the behavioral test directly (rather than via a probe) caught a subtlety a green
probe would have hidden — the two fail-closed gates are ordered, and a naive test conflates them. The
gap was in my test, not the code, but surfacing it clarified the pre-pass's contract.

### 2026-07-10 — Question 5.2 decomposed (approved, not yet built)

Q5.2 as written in the plan is a convergence of many deferred pieces: dropping the capability chain
(Q2.5), the mixed Add+GCE write side (Q2.6), head write+verify (Q2.7), roster bootstrap, and
`MemberCredential` surgery. Too coupled for one probe. Decomposed, user-approved:

- **Q5.2a — invite seeds the roster (additive, next).** `Invite` gains `ledgerEntries: Array<string>`
  (keep `capabilityToken`/`capabilityChain`/`permission` for now — redundant per Q2.5, removed later).
  `createInvite` *additionally* signs a `group.role: member` entry for `recipientDID` (via
  `signLedgerEntry`, inviter identity) into `ledgerEntries`; the existing capability delegation stays.
  `commitInvite` forwards `authenticatedData = encodeControlEnvelope({ v:1, entries:[roleEntryId] })`
  to `createCommit` (the write-side passthrough — the Q1.1 gap) and guards that the committer is admin
  in its own roster. `processWelcome` folds `invite.ledgerEntries` into the roster
  (`applyLedgerEntries`) and asserts `recipientDID === identity.id`; existing chain validation stays.
  After this every invited member is in the roster as `member`, which is what makes Q4.1b's
  external-init roster check meaningful. Works *now* because the GCE-head coupling is still deferred,
  so a commit carrying entries without a head GCE is accepted by the Q4.1 pre-pass.
- **Then Q4.1b — external-init verdict.** Reopens the PublicMessage path the pre-pass passes through:
  resolve the UpdatePath-leaf DID into `externalCommitDID`, let `defaultCommitPolicy` run the
  external row (committer DID ∈ roster + exactly `{external_init, remove-of-self}`).
- **Deferred follow-ups (tracked):** head write+verify (Q2.7 wiring — commitInvite moves the head,
  processWelcome recomputes it; interim gap: an inviter can omit entries undetected) and the chain
  removal (Q2.5 subtraction — gut `capabilityToken`/`capabilityChain`/`permission` from `Invite` and
  `MemberCredential`, once roster-seeding is proven).

### Session handoff — 2026-07-10

**Where we are.** Phase 1 (ts-mls probes) ✓, Phase 2 (ledger primitives) ✓, Phase 3 (envelope +
policy) ✓, Phase 4 core ✓ (4.0/4.4 anchored handle state, 4.1 pre-pass, 4.2 rollback satisfied
structurally, 4.3 state-so-far authority). Full suite **227 green**, tree clean. Last commit
`dd9ad41`.

**Commits so far (feature):** `84f0114` anchor · `1cfdd5d` ledger · `1106382` fold · `940bacd` roster
· `722613d` head · `3ddaab0` envelope · `5344dcd` policy · `219b08a` admin-issuer invariant · `c89bf12`
removal-demotes · `cf57ff6` anchor-at-creation · `0a33475` pre-pass · `dd9ad41` state-so-far tests.

**Next session, in order:** Q5.2a (invite seeds the roster — brief above), then Q4.1b (external-init
verdict), then head write+verify, then chain removal (Q2.5), then Phase 5 residuals (5.1 grep sweep,
5.3 dissolved, 5.4 non-creator-admin invite tests) and Phase 6 (integration tests, delete origin
`next/` items, write the kubun migration item). Ephemeral kubun-impact notes remain untracked in
`docs/superpowers/notes/` for eventual reconciliation.

### 2026-07-11 — Question 5.2a: the invite seeds the roster

**Findings:** Confirmed, end to end. An invited member is now in every participant's control roster:
`createInvite` signs a `group.role` entry naming the invitee, `commitInvite` puts that entry's content
id in the commit's `authenticatedData` envelope, and each receiver's pre-pass resolves the body, folds
it, and admits the member as the Add applies. The write-side passthrough that had been missing since
Q1.1 is now closed — this is the first commit kumiai *emits* carrying a control envelope, and the
Q4.1 pre-pass read it back off the wire without a single change. Suite **234 green** (227 + 7), tsc
clean, biome clean.

**A latent bug the probe surfaced, unrelated to the question as written:** the `GroupHandle`
constructor unconditionally reset `#ledger = new Map()`, so a handle *derived* from another
(`commitInvite`/`removeMember`) silently reverted its roster to the anchor alone — dropping every
promotion the parent had folded. `processMessage` was unaffected (it mutates in place), which is why
227 tests never caught it: every committer in the suite was the creator, already the anchor admin. It
became load-bearing the moment `commitInvite` wrote an entry, since the handle it returns must hold
the entry it just wrote. Fixed by threading `ledger` through `GroupHandleParams`; the anchorless throw
stays exactly where it was. There is a test that fails without the fix.

**The `foldRoster` question (the one that decided the security story):** the Welcome path folds the
invite's entries through `applyLedgerEntries`, the *permissive* primitive — it verifies signatures and
drops cross-group tokens but does **not** enforce the admin-issuer invariant that `foldEnvelope` does.
That is sound only if the fold itself enforces authority, and it does: `foldRoster`'s `verifyAuthority`
requires `stateSoFar.roles.get(issuer) === 'admin'` (`roster.ts:77-86`), layered with groupID scoping
and the empty-admin guard. So a malicious inviter cannot promote anyone via the Welcome — its entries
are rooted at the anchor and grow only through admins-so-far, exactly as on the commit path. The
joiner trusts the *anchor*, never the inviter.

**The deployment requirement, now pinned by a test:** the envelope carries entry **ids, not bodies**.
A receiver holding neither the entry nor a `resolveLedgerEntries` resolver throws
`MissingLedgerEntriesError` on an Add commit and stays at its pre-commit epoch. This is not a bug — it
is the content-addressed design working — but it means *every deployment must wire a resolver*. The
test asserts the exact error, the exact missing id, the unchanged epoch, and the unchanged roster.

**Spec impact:** none.

**Learned:** the probe process died mid-run without writing its report, having updated four test files
but not `external-rejoin.test.ts` — leaving 5 failing tests and 9 type errors. Verifying by running
the commands myself (rather than trusting a report that never arrived) caught it immediately. Two of
that file's `commitInvite` sites also had to gain resolvers, which is itself the finding above
reproducing in a test written before the feature existed: *any* member processing someone else's Add
now needs to resolve the invitee's role entry. Guards were added at both `createInvite` and
`commitInvite` (the inviter/committer must be admin in its own roster) so a non-admin fails locally
rather than emitting a commit every receiver would reject.

**Still open (unchanged by this step):** the `ledger_head` extension does not move yet, so an inviter
can still omit entries from the envelope with no receiver detecting the omission. That is the next
piece after Q4.1b.

### 2026-07-11 — Question 5.2b: the invite carries the full ledger

**Findings:** The split-brain is closed. `#ledger` now retains the signed token alongside the verified
entry (`Map<id, {token, verified}>`), a `ledgerTokens` getter exports the ordered token list, and
`createInvite` ships `[...group.ledgerTokens, roleToken]`. A member who joins after a role change now
agrees with the group about who the admins are. The regression test was written first and failed
first with exactly the predicted `expected undefined to be 'admin'`. Suite **241 green**, tsc clean,
biome clean.

**The layering that settled the design.** Signed tokens are the source of truth: self-verifying,
replayable, and position-independent. Verified entries are a *derived cache* — `verifyLedgerEntry` is
one-way, and the cache exists only because `IncomingMessageCallback` is synchronous and cannot await
verification. The roster is the fold on top. Consequences: the persistent and wire form of the ledger
is just the ordered `Array<string>` of tokens (already the shape `restoreGroup` takes), and **no
`toJSON`/`fromJSON` of verified entries was added** — importing verified entries would write straight
into the cache the sync policy reads, letting anything that can write the store forge an `issuer`
without passing a signature check. Export is `ledgerTokens`, import is `applyLedgerEntries`, and
**import re-verifies**. No `OrderedMap` was built either: `Map` iteration is insertion-ordered by the
ECMAScript spec, and `applyLedgerEntries` already preserves position on a repeat.

**Entries carry no `prev` pointer, and must not.** Asked whether concurrent admin writes fork:
verified they cannot. Entries reach the ledger only inside MLS commits, and MLS totally-orders commits
by epoch — two admins committing from the same epoch produce one winner and one stale commit
(`ValidationError: Cannot process commit or proposal from former epoch`). There is no concurrency to
reconcile. Binding a prev-head into an entry would make it epoch-bound and single-use: the loser of
any commit race would have to re-sign it. An entry is a *claim*; position is assigned by the commit
that enacts it and attested by the `ledger_head` chain computed over the result. Keep them separate.

**A regression this step introduced, caught and fixed.** Growing `invite.ledgerEntries` to the whole
history silently grew the *commit envelope* too, because `commitInvite` derived one from the other —
harmless when the invite held one entry. So every Add re-played the entire history at every receiver,
and `foldEnvelope` (correctly) re-judged each replayed entry's issuer against the *present* roster: a
grant issued by a since-demoted admin reads as coming from a non-admin, and the commit is rejected.
**Any group that ever rotated its admins would freeze.** All 240 tests stayed green, because the only
receiver that reproduces it is one that is *up to date* with the demotion — a stale receiver still
folds the replay successfully. Fixed by un-conflating the two channels: the **invite** carries the
full history (a joiner has nothing to fold onto); the **commit envelope** names only what the commit
*enacts* (`invite.ledgerEntries` minus the entries the committer already holds). A permanent
regression test now covers it.

**Spec impact:** none, but the envelope/invite distinction is now load-bearing and should be stated
explicitly when the spec is next touched.

**Learned:** the probe reported the regression rather than papering over it, but its own repro and
mine initially disagreed — my first attempt *passed*, because I used a stale receiver and because
Ed25519 is deterministic (Alice signing the same `{subject, value}` twice yields a byte-identical
token and therefore the same content id, which dedups). Both details had to be right to see the bug.
Green tests proved nothing here; only reproducing the exact state did.

**New question raised (not yet scheduled) — the capability chain disagrees with the roster.**
`createInvite` builds `[group.rootCapability, memberCapStr]`, omitting the inviter's own membership
capability, so a *ledger-promoted* admin mints an invite whose chain never authorizes them. Nothing
validates at mint time, so it surfaces only at the joiner's `processWelcome`. This is the same class
of defect as 5.2b — the chain and the roster disagree about who is an admin — and it is dissolved
rather than fixed by the tracked chain-removal step (Q2.5), which deletes the chain outright. Do the
removal rather than repairing the chain.

### 2026-07-11 — Question 5.2c: entries ride commits, and the head proves it

**Findings:** The invariant holds: **every ledger entry reaches the group inside a commit, and every
commit that enacts entries extends the GroupContext head by exactly those ids, in envelope order.**
`commitLedgerEntries` is the admin write path that was missing entirely — before this, promotion and
demotion were impossible through the public API, and every test reached for `applyLedgerEntries`,
which is the receive/restore primitive and moves no head. That back door is precisely why the head had
never been verifiable. `applyLedgerEntries` remains, but it authors nothing.

An omitting inviter is now **caught**: dropping (or reordering) an entry in `invite.ledgerEntries`
makes `processWelcome` throw `LedgerIncompleteError` before anything is folded —
`expected=b6f71fbc5b6ce2f4 actual=b28f397c1107519c`. The deliberate fork is closed, as the accidental
one was in 5.2b. Suite **255 green**, tsc clean, biome clean.

**ts-mls accepted both GCE shapes** — a `group_context_extensions` proposal alongside an `Add` (every
`commitInvite` now emits `[add, gce]`) and a GCE-only commit (`commitLedgerEntries`). Its only relevant
constraint is that a commit cannot carry two GCE proposals; we emit exactly one. No design-changing
blocker, which was the risk the brief flagged.

`removeMember` gained an optional entries parameter, closing a gap found while briefing: the policy
requires a removed admin to have been demoted in the same commit, but nothing could sign the demotion
— so **removing an admin was impossible**.

**The head coupling is what makes entry injection admin-only.** Verified by running the attack: a
member holding a genuine, admin-signed promotion token naming *himself* cannot enact it
(`REJECTED: CommitRejectedError`, roster unchanged). Enacting entries requires moving the head; moving
the head requires a GCE proposal; GCE requires admin. A member's only permitted proposal is `update`,
which yields a valid commit — but attaching an envelope flips `commitEnactsEntries` and the commit dies
for want of a head move. Independently, `foldEnvelope` checks each entry's *issuer* is admin in
state-so-far, so even an admin cannot enact an entry signed by a non-admin or by a since-demoted admin.

**Spec impact:** none.

**A serious pre-existing bug this exposed (fixed next).** `signLedgerEntry` is deterministic (Ed25519),
so re-signing an identical claim yields a byte-identical token and therefore the **same content id**.
Because `#ledger` is a `Map` keyed by content id and both `applyLedgerEntries` and the envelope
narrowing dedup on it, **an admin cannot be demoted back to a role they previously held**: granting Bob
`member`, promoting him to `admin`, then demoting him to `member` re-signs the first entry, dedups to a
no-op, and Bob stays `admin` — silently, with every receiver accepting the commit. Reproduced directly.
Since removal now *requires* a demotion, this also makes "remove an admin who joined as a member"
impossible unless the demotion carries an `ord` — which is what the new removal test does, as a
deliberate, documented workaround pending the fix.

The root cause is a category error: `#ledger` is a *set of claims* keyed by content, but the ledger is
an **ordered log of enactments**, where the same claim recurring later is meaningful precisely because
it undoes what came between. `head.ts` already models it correctly — `extendHead` folds over an ordered
id list, repeats and all. The `Map` is the odd one out. Dedup was never buying security (the two real
gates are the head coupling and the issuer check), and it was silently eating legitimate demotions.

**Learned:** wiring the head is what surfaced the dedup bug — the head could not reproduce a list
containing the same id twice, which forced the duplicate to the surface. An integrity check earns its
keep before any attacker shows up, by making the model's own inconsistencies fail loudly.

### 2026-07-11 — Question 5.2d: the ledger is an ordered log, not a set of claims

**Findings:** An admin can now be demoted back to a role they previously held. `#ledger` became an
ordered `Array<LedgerLogEntry>` plus a content-keyed `#entryBodies` store for resolution; narrowing
moved from content-based to **positional** (`commitLedgerEntries` enacts exactly what it is given;
`commitInvite` slices `invite.ledgerEntries` past the committer's log length, and throws if the prefix
does not match its own log). The regression failed first with `expected 'admin' to be 'member'` and
passes after. Suite **261 green**, tsc clean, biome clean.

Verified independently: the re-signed demotion token has the **same content id** as the original grant
(Ed25519 is deterministic), yet the log holds all three enactments, the roster ends at `member`, and
`computeHead(groupID, ledgerTokens.map(ledgerEntryDigest))` — over an id list containing the repeat —
matches the head authenticated in the GroupContext. The log and the head chain agree, which is what
`head.ts` assumed from the start.

**Dedup was never a security control, and its removal was checked, not assumed.** Two gates do the real
work, both pinned by tests: (1) the head coupling makes enactment admin-only — a member holding a
genuine admin-signed promotion naming *himself* still cannot enact it; (2) `foldEnvelope` judges each
entry's *issuer* in the state-so-far at its own position, so an admin who has since been demoted has
their un-enacted tokens killed — a *current* admin trying to enact one of them is rejected. The only new
capability is that a current admin may re-enact a claim at a fresh position, which grants no power a
current admin lacks (they could sign an equivalent claim anyway) and is exactly the behaviour the fix
exists to allow.

`ord` is no longer needed to dodge a content collision: the removal test that stamped `ord: '1'` drops
it and passes. The `createInvite` duplicate-append guard added in 5.2c was removed — a role token the
ledger already holds is a legal re-grant, and positional narrowing handles it. `LedgerIncompleteError`'s
getters were renamed to `expectedHead`/`actualHead` so vitest can format an unexpected throw (its diff
formatter assigns to `expected`/`actual`, which previously threw `TypeError: Cannot set property
expected of Error which has only a getter`).

**Spec impact:** none, but the ledger's identity is now stated: an *ordered log of enactments*, not a
set of claims. Worth stating explicitly when the spec is next touched.

**Learned:** the head is what exposed this. A `Map` keyed by content id cannot represent a list holding
the same id twice, so wiring an integrity check that *can* forced the model's own inconsistency to the
surface — long before an attacker would have found it. The bug had been latent since the roster fold
was written; every test passed throughout, because no test had ever demoted anyone back to a role they
started with.

**New question raised (not yet scheduled) — the write path does not fail closed.** `commitWithEntries`
checks only that the *committer* is an admin; it never runs `foldEnvelope` over the entries it is about
to enact. So a committer can build a commit that advances its own log and head while every receiver
rejects it — forking itself off the group. Visible in the demoted-admin test, where the committer's own
fold drops the entry but the commit is still emitted. Not an escalation (the damage is self-inflicted
and receivers stay correct), but the write path should refuse to author a commit the group will reject.
Running `foldEnvelope` at commit time would close it.

### 2026-07-11 — The write path fails closed

**Findings:** `commitWithEntries` now folds the entries it is about to enact — through the same
`foldEnvelope` every receiver runs, against its own roster — and refuses to author a commit the group
would reject. Suite **261 green**, tsc clean, biome clean. Done directly rather than by probe; the
change is a dozen lines.

Before this, the write path failed **open**. Being an admin was the only check, but admin-ness is not
sufficient: an entry is judged by *its own issuer's* authority at the position it lands in, so a token
signed by a since-demoted admin is dead paper no matter who carries it. A committer could therefore
build a commit that advanced its own log and head while every receiver rejected it — forking itself off
the group. Self-inflicted rather than an escalation, but the asymmetry was real: the committer trusted
itself where its receivers would not.

**Two tests changed meaning, and both got stronger.**

The demoted-admin test previously *built* the stale commit and asserted receivers rejected it. Now the
write path refuses to build it. To keep the receiver-side proof — which is the one that actually
matters, since a malicious client can always skip the guard — the test now does both: it asserts
`commitLedgerEntries` throws, *and* forges the same commit by hand (`entryCommitBytes`: the envelope
plus the head move it implies) and asserts receivers still reject it. Defence in depth, both halves
pinned.

`a member-signed entry in the invite cannot promote` had a premise that no longer exists: it assumed an
honest inviter would happily commit a tampered invite and the *joiner* would quietly drop the bad entry.
That path is now unreachable, and should be — a silently-dropped entry would still be sitting in the
head chain, which is exactly the incoherence the head exists to prevent. Rewritten to assert the inviter
refuses to author it. The defensive-drop behaviour of the low-level primitive stays covered by
`applyLedgerEntries drops cross-group and member-signed tokens without throwing`.

**Spec impact:** none.

**Learned:** "the committer is an admin" reads like the natural guard and is the wrong one. Authority in
this design is per-entry and positional, never per-committer — the same insight that makes rotation
sound (state-so-far) makes the committer's own admin-ness insufficient. The write path had to run the
*receivers'* check, not its own.

### 2026-07-11 — Question 4.1b: enforce the policy on external-join commits

**Findings:** The commit policy now runs on external-join (PublicMessage `new_member_commit`) commits.
The pre-pass resolves `externalCommitDID` from the commit's own UpdatePath leaf credential and feeds
the already-written `evaluateExternalCommit` rule. Suite **263 green** (261 + 2), tsc clean, biome
clean.

**This closed a complete enforcement bypass, not a missing verdict.** Reproduced before the fix: a DID
in **no roster** external-joins with a leaked GroupInfo and is admitted — `#prepareCommitPipeline`
gated on `readPrivateCommit`, so a PublicMessage commit took the pre-envelope path with a `undefined`
callback and ts-mls applied *no policy at all*. Every membership guard built to date protected only the
PrivateMessage path. After the fix the stranger is rejected with `CommitRejectedError`, epoch unchanged,
roster byte-identical; verified independently.

**Legitimate resync survived untouched.** `external-rejoin.test.ts` — the load-bearing regression —
stayed fully green with **zero edits**. That is the proof the new enforcement admits real rejoins while
rejecting strangers: the resync shape (`{external_init, remove-of-self}`, rejoiner's DID on both the new
UpdatePath leaf and the removed stale leaf) agrees with the policy rule, so no design disagreement
surfaced.

The external branch enacts nothing: no envelope decode, no resolve, no `foldEnvelope`, no head move;
`candidateRoster` is the current roster unchanged. Its only precomputed reject is an unresolvable
committer DID (absent UpdatePath or a credential that does not parse) — which cannot be a valid resync.
`readExternalCommit` mirrors `readPrivateCommit`/`readMessageEpoch`, narrowing the `unknown` frame
structurally to `publicMessage.content.commit.path.leafNode.credential`.

**Spec impact:** none.

**Learned:** the policy machinery for external commits (`evaluateExternalCommit`, `externalCommitDID`,
the `external_init` routing) had been fully written since Phase 3 and was *dead code* — nothing reached
it, because the enforcement entry point only recognised PrivateMessage commits. A rule that is written
but never dispatched reads as "covered" in the source and is a live hole in the runtime. The gap was in
the wiring, not the rule; finding it needed running the actual external join, not reading policy.ts.
The design intent the rule encodes is now enforced: an external commit is a *resync of an existing
member*, never a new join — new members arrive through Welcome.

**A limit worth recording:** policy cases "remove targets a different leaf" and "external commit with
extra proposals" cannot be re-proven at the integration layer, because mutating a signed external
commit's proposal set invalidates the ts-mls signature — ts-mls crypto rejects it before the policy is
consulted. Those cases stay unit-tested against the pure rule in `policy.test.ts`, which is the correct
layer for them.

### 2026-07-11 — Question 2.5: remove the capability chain; the roster is the sole authority

**Findings:** The capability chain was dead weight and is gone. Deleted `capability.ts` outright
(`createGroupCapability`, `delegateGroupMembership`, `validateGroupCapability`); stripped
`rootCapability` from the handle and all ~15 construction sites; shrank `MemberCredential` to
`{id, groupID}` and `Invite` to `{groupID, inviterID, ledgerEntries}`. `GroupPermission` moved to its
semantic home in `roster.ts` (`RoleValue = GroupPermission`). **No enforcement assertion changed** —
every membership, rotation, and external-join test stayed green with intact assertions; the only edits
to them were mechanical shape updates (literals dropping removed fields). mls suite **246 green**,
integration hub-relay **10 green**, tsc clean, biome clean, zero dangling references.

**Why it was safe, confirmed against the code.** `processWelcome`'s old `validateGroupCapability` call
is fully subsumed by the ledger: the invite carries the full ordered ledger, the joiner verifies the
head (`assertHeadMatches`) before folding, and the roster fold applies the invitee's role entry only if
its issuer was admin-so-far. A forged invite from a non-admin yields a role entry the fold drops, and
the "invite names this identity" guard then throws. So a join is authorized by the ledger, signed by an
admin, and proven complete by the head — strictly stronger than a delegated token. A focused test now
pins it: `processWelcome` rejects an invite whose role entry is signed by a non-admin.

**Integration test rewired, not weakened.** `hub-relay.test.ts`'s capability-gated pub/sub block gated
a group topic on a per-member `validateGroupCapability` call. Its real subject is the authorize hook and
fan-out; `setupGroupHub` now takes the member DIDs directly (they were already known at the call site).
The fan-out and "not authorized" assertions are unchanged; the block is renamed to "authorized-DID
pub/sub" to match.

**Spec impact:** none — the spec already treated the chain as transitional. The capability-chain defect
recorded under 5.2b (a ledger-promoted admin minting an invite whose chain never authorized them) is
**dissolved** by this removal rather than repaired: there is no chain to be inconsistent with the roster.

**Verification caught lost coverage the probe missed.** The probe deleted `peer4-credential.test.ts`
wholesale because 5 of its 6 tests exercised `validateGroupCapability`. But the 6th tested
`populateCacheFromCredential` — a **surviving, exported** function — with no capability dependency.
Deleting it dropped real coverage of live code. Restored (adapted, in `credential.test.ts`), which is
why the final count is 246 not 245. The lesson: a probe's own green run does not surface *deleted*
coverage; only auditing what left the tree does.
