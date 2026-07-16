# App-lane delivery — plan

**Stage:** executing
**Mode:** learning-loop
**Spec:** docs/superpowers/specs/2026-07-16-app-lane-delivery-design.md

> Verify command for every question (run from repo root):
> `pnpm run build && rtk proxy pnpm run lint && pnpm test`
> (`pnpm run lint` alone is intercepted by the local `rtk` shim → eslint; use `rtk proxy` for real
> biome output. See global machine notes.)
>
> Convention reminder for every probe: code, comments, and test names never reference plan
> questions, decision numbers, or phase labels. Capture the invariant directly. `type` not
> `interface`; `Array<T>`; no `any`; capital `ID`; `#fields`. Do not edit `lib/`.

---

## Phase 1: Per-procedure retention — logged events become pullable

Foundation. Everything downstream (drain, anchor rotation, pruned signal) assumes **logged events**
are retained and pullable, while ephemeral events and all RPC stay live. Retention is a per-procedure
property of the group protocol definition; only events may be `log` (correlation is always ephemeral).
Validate that split before building on it.

**Exit criteria:** a `retain:'log'` event published to an app topic is both live-pushed to an online
subscriber AND independently retrievable via `mux.fetchTopic`; an ephemeral event is live-pushed but
**not** returned by `fetchTopic`; declaring `retain:'log'` on a `request`/`gather` procedure is
rejected at definition time; RPC (`request`/`gather`/`reply`) is unchanged; existing rpc tests stay
green. `@kumiai/broadcast` public surface unchanged except at most one additive optional field if the
`retain` marker lands on `defineGroupProtocol`.

### Question 1.1: Does a per-procedure `retain:'log'` marker make a logged event pull-drainable while ephemeral events and RPC stay live?

- **Assumption:** an event procedure can declare `retain:'log'` (additive field on
  `defineGroupProtocol` or an rpc-side sidecar — pick the cleaner in Step 1); a logged event publishes
  via `mux.publish({ retain:'log' })`, an ephemeral event via the existing live path; the send API
  stays a single `dispatch(prc, data)` routing by the declared retention; the receive side is
  unchanged; the definition rejects `retain:'log'` on a `request`/`gather` procedure.
- **Done when:** a test shows (a) an online subscriber receives a logged event live AND a fresh
  `mux.fetchTopic` on that topic returns the same (wrapped) frame; (b) an ephemeral event is received
  live but `mux.fetchTopic` does **not** return it; (c) declaring `retain:'log'` on a
  `request`/`gather` procedure is a definition-time error; `request`/`gather` still work; existing
  `peer-control-lanes.test.ts` and the non-skipped app tests pass.
- **Spec excerpt:** "Only events may be `log`. `request` / `gather` / `reply` are always ephemeral ...
  Retention is declared per procedure in the group protocol definition — not chosen per call. An event
  procedure marks `retain: 'log'`; the default is ephemeral ... The protocol definition is also where
  the guardrail is enforced: declaring `retain: 'log'` on a `request` / `gather` procedure is rejected
  at definition time ... The send API stays a single `dispatch(prc, data)` that routes by the
  procedure's declared retention ... A topic may carry both classes — `fetchTopic` returns only
  `retain:'log'` frames."
- **Open (decide in Step 1):** `retain` marker home (additive `defineGroupProtocol` field vs. rpc
  sidecar); the publish seam so a logged event reaches `mux.publish` while live traffic is untouched.
- **Verify:** `pnpm run build && rtk proxy pnpm run lint && pnpm test`

---

## Phase 2: Anchor topic model and roster-change detection

The topic must be derived from an anchor captured at the last **roster change** (add or remove), and
rotate exactly when the roster changes — no sooner (update/no-op/ledger-only commits keep it stable),
no later. **Every member must agree on that anchor**, including one whose peer boots at a later epoch
than the anchor (a late joiner, a rejoin, a restart).

> **Corrected 2026-07-16, mid-phase.** The original design anchored at the last **Remove**. Q2.2's
> probe proved that unimplementable: the anchor secret is `exportSecret(anchorEpoch)` and MLS ratchets
> forward, so a member added after that Remove can never derive it — and binding the topic to a
> per-peer boot-time seed silently partitions the group (measured: a peer booting at epoch 3 against a
> group anchored at 1 received **0** messages, where per-epoch derivation delivered 1). The anchor must
> be `max(last add, last remove)` = the last roster change, and durably persisted. See spec §2.

**Exit criteria:** roster-set diff flags any roster change (add, remove, add+remove in one commit) and
only a roster change; the app topic is anchor-derived, stable across non-roster-changing commits, and
rotates on a roster change; **a member booting at a later epoch than the group's anchor agrees with the
group** (joiner, rejoin) and a **restart restores the persisted anchor** rather than re-seeding; a
removed member cannot derive the post-removal topic.

### Question 2.1: Does a roster-set diff around `processCommit` detect a roster change, including Add+Remove in one commit? — ANSWERED (see decision log), needs amendment

Answered 2026-07-16 and committed (`47c2659`) as **removal** detection (`detectRemoval`, set
difference). Per the §2 correction it must become **roster-change** detection (`detectRosterChange`,
set **inequality**) so an Add rotates too. Small amend, carried by Q2.2's probe rather than re-run
standalone: rename + widen the predicate, invert the add-only and external-rejoin cases in
`peer-remove-detect.test.ts` (they must now rotate), keep the add+remove and update/no-op cases.

### Question 2.2: Does an anchor-derived app topic stay stable within a segment, rotate on a roster change, and stay AGREED across members booting at different epochs?

- **Assumption:** peer state `anchorSecret`/`anchorEpoch`, captured from `exportSecret()` at the last
  roster change and fed to `protocolTopic`/`inboxTopic`, holds the topic constant while epochs advance
  without a roster change; a roster change updates the anchor, drops the old (log-class, safe) app
  subscription, and subscribes the new topic; and — the decisive part — a member whose peer boots at a
  **later epoch than the anchor** still agrees, because its own add is itself a roster change that
  rotates every existing member onto the joiner's add epoch, whose secret the joiner natively holds.
- **Done when:**
  - two online members exchange logged app frames across several non-roster-changing commits on one
    stable topic, asserted on the wire (all frames on the one topic ID; the per-epoch topics the group
    would otherwise have used have zero subscribers);
  - a roster change (remove, and separately an add) rotates both onto a new topic and delivery
    continues;
  - **anchor agreement:** a member added/rejoining at a later epoch derives the same topic as an
    existing member and they exchange messages — the case the old design failed. This test must fail if
    the anchor is seeded per-peer from the live epoch.
  - `topic.ts` signatures unchanged.
- **Spec excerpt:** "the anchor sits at the last commit that changed the roster — an Add or a Remove ...
  The anchor epoch must be one every current member holds the secret for, so it must be ≥ the newest
  member's join epoch ... and after every removal ... `max(last add, last remove)` = the last roster
  change ... a member added at epoch E seeds its anchor at E, and every existing member rotates to E on
  applying that same add — they agree natively, each holding E's secret."
- **Verify:** `pnpm run build && rtk proxy pnpm run lint && pnpm test`

### Question 2.3: Does an external-commit rejoin rotate the anchor, so a recovering member agrees with the group?

- **Assumption:** a resync rejoin changes no DID and no occupied leaf index, so no diff can see it; but
  it is structurally detectable pre-apply (`senderType === new_member_commit`), and
  `GroupHandle.readExternalCommit` (`group-handle.ts:178-198`) already does exactly that. Surfacing it
  as an optional `external` on `CommitHeader` costs nothing at the call site — the lane already calls
  `readCommitHeader` on every frame (`classifyCommit`, `peer.ts:~704`). Rotating on
  `rosterChanged || external`, plus the rejoining peer setting its own anchor at the rejoined epoch,
  makes rejoiner and group land on the same post-commit epoch.
- **Done when:** a test rejoins a member by external commit against a group whose anchor is older than
  the rejoin epoch, and asserts (a) every member applying the external commit rotates to the rejoin's
  post-commit epoch, (b) the rejoiner anchors there too, and (c) they exchange logged events on one
  agreed topic. `peer-recovery.test.ts`'s pinned three-way divergence is **inverted** — it now
  converges. Mutation-check: dropping the `external` term turns it red.
- **Spec excerpt:** "A rejoin does NOT self-synchronize — it needs an explicit signal ... An
  external-commit rejoin by a member the roster still holds changes no DID ... Worse, it changes no
  occupied leaf index either: ts-mls's resync blanks the member's old leaf and then places the new one at
  the leftmost blank — the leaf it just blanked ... So a rejoin rotates the anchor on an explicit
  external-commit signal, not a roster diff ... the anchor is ≥ every current member's effective join,
  and a rejoiner's effective join is its rejoin epoch."
- **Also fix:** `GroupHandle.listMembers()`'s doc comment (`group-handle.ts:526-528`) advertises the
  before/after diff idiom as the way to detect membership change — unsound for rejoin. Correct it.
- **Verify:** `pnpm run build && rtk proxy pnpm run lint && pnpm test`

### Question 2.4: Does a durably persisted anchor survive a restart without partitioning? ✅

- **Assumption:** a member rebooting over a handle already past the anchor epoch cannot re-export that
  epoch's secret, so `{anchorSecret, anchorEpoch}` must be persisted and restored at construction
  rather than re-seeded from the live epoch. Restored, it derives the same topic as a member that never
  restarted.
- **Done when:** a test boots a peer, advances the group past the anchor with non-roster-changing
  commits, restarts the peer over the same handle, and asserts it (a) restores the persisted anchor
  (not the live epoch) and (b) still receives logged events from a member that never restarted.
  Mutation-check: removing the restore turns it red.
- **Spec excerpt:** "A restart is the one case derivation cannot cover: a member rebooting at epoch 12
  whose last roster change was epoch 5 cannot re-export `secret@5`, and re-seeding from the live epoch
  would put it on a topic no one else uses — a silent, permanent partition triggered by a phone
  restarting ... `{anchorSecret, anchorEpoch}` is persisted alongside the handle and restored on
  construction."
- **Open (decide in Step 1):** where the anchor persists — the existing commit journal, a new additive
  port method, or host-persisted state alongside the handle.
- **Verify:** `pnpm run build && rtk proxy pnpm run lint && pnpm test`

### Question 2.5: Is a removed member unable to derive or read the post-removal app topic? ✅

- **Assumption:** because the anchor feeds the **per-epoch** `exportSecret()` (never the lifelong
  recovery secret), a member removed at the rotation commit cannot derive the new epoch's secret,
  cannot compute the new topic, and cannot read frames on it.
- **Done when:** a test removes a member, has the remaining members publish on the rotated topic, and
  asserts the removed member (a) cannot derive the topic ID from anything it holds, and (b) receives
  nothing.
- **Spec excerpt:** "**Load-bearing:** the anchor must feed the **per-epoch** `exportSecret()`, never
  the lifelong recovery secret (which removed members keep for life). A topic derived from the
  recovery secret plus a guessable epoch number would cut nobody off."
- **Verify:** `pnpm run build && rtk proxy pnpm run lint && pnpm test`

---

## Phase 3: Returning-member drain

The riskiest phase — the per-segment drain interacts with the existing commit-lane walk and is where
the spec is most likely to move.

**Exit criteria:** a returning peer drains each segment (run of epochs between removals) to head under
the correct per-epoch keys, in order, across a rotation boundary; all three original loss scenarios
are delivered by pull; the skipped test is un-skipped and green.

### Question 3.1: Does a peer-internal per-segment drain deliver retained app frames in order under the correct per-epoch keys, across a rotation boundary?

- **Assumption:** on coming up / reconnecting, the peer walks the commit log epoch by epoch, deriving
  each `exportSecret()`, pulling **once per segment** to head, decrypting each frame under the epoch
  its MLS ciphertext names; at each **roster-change** boundary it updates the anchor and moves to the
  next segment's topic. Delivered frames reach the host through the existing `handlers` map.
- **Corrected 2026-07-16:** this entry said "Remove boundary" and "between two removals", which
  predates the Question 2.2 anchor correction — the anchor sits at the last **roster change** (add OR
  remove), so a segment is the run between roster changes. Spec §5 is correct; the plan was stale.
- **Done when:** a test seeds app frames across at least two segments separated by a Remove, brings a
  peer up cold, and asserts the handler receives every frame's plaintext in publish order.
- **Spec excerpt:** "walk the commit log epoch by epoch (deriving each `exportSecret()`), pulling
  **once per segment** — the run of epochs between two roster changes is one stable topic — to head,
  decrypting each frame under the epoch its MLS ciphertext names; at each roster-change boundary
  update the anchor and move to the next segment's topic. ... Delivered frames reach the host through
  the existing `handlers` map — no new host delivery API."
- **Verify:** `pnpm run build && rtk proxy pnpm run lint && pnpm test`

### Question 3.2: Are all three loss scenarios delivered by pull, with the skipped test un-skipped?

- **Assumption:** the drain closes each of (epoch never held; own-epoch published after the leaving
  commit; own-epoch after restart). The fixture can register an app handler so the plaintext is
  observable.
- **Done when:** `packages/rpc/test/peer-app-drain.test.ts:72` is un-skipped and passes asserting the
  **plaintext the handler received** (not absence of error); the fixture registers an app handler;
  the non-skipped restart test still passes; **mutation check** — reverting the log-class publish
  (Q1.1) and reverting the anchor update (Q2.2) each turns a decisive test red.
- **Spec excerpt:** "Un-skip and complete `packages/rpc/test/peer-app-drain.test.ts:72`; give the peer
  test fixture an app-handler registration ... Assert the **plaintext the handler received**, not the
  absence of an error. ... **Mutation-check** the decisive tests."
- **Verify:** `pnpm run build && rtk proxy pnpm run lint && pnpm test`

---

## Phase 4: Pruned-window signal

**Exit criteria:** when the drain finds the hub's oldest retained frame is newer than the cursor it
needs, the peer emits an event naming the group (not a silent gap), shaped to feed a host health
condition; a member away beyond the window triggers it.

### Question 4.1: Does the drain detect a below-retention gap and emit a pruned-window event (not a silent drop)?

- **Assumption:** the drain can tell a genuine gap (hub oldest-retained newer than the needed cursor)
  from a clean pull; on a gap it emits an rpc event naming the group, carrying the gap boundary as a
  cursor/sequence (no wall-clock — the host renders time from its own HLC); the event shape drops into
  a host health condition.
- **Done when:** a test forces the hub to prune below a peer's needed cursor, brings the peer back,
  and asserts (a) the surviving frames are still delivered, and (b) the pruned-window event fires and
  names the group; **mutation check** — reverting the emit turns the test red.
- **Spec excerpt:** "When the internal drain finds the hub's oldest retained frame is newer than the
  cursor it needs (a gap below the retention floor), the peer emits a **pruned-window event** naming
  the group. The payload carries what rpc knows (the group, and the gap boundary as a cursor/sequence
  ...). It deliberately does **not** carry a wall-clock ... The event is shaped to feed Kubun's inert
  `GroupHealthMonitor` as a new health condition (e.g. `'app-window-pruned'`)."
- **Open (decide in Step 1):** exact event name + payload type, and where on the peer surface it is
  exposed (emitter vs callback) so it lands cleanly in `GroupHealthMonitor`.
- **Verify:** `pnpm run build && rtk proxy pnpm run lint && pnpm test`

---

## Phase 5: Retention default and architecture doc

**Exit criteria:** members subscribe app topics with a 30-day retention request;
`docs/agents/architecture.md` documents the retention-class / lane concept map.

### Question 5.1: Do members request a 30-day retention on app-topic subscribe, overridable up to the operator cap?

- **Assumption:** app-topic subscribes pass `SubscribeParams.retention` = 30 days by default; the
  value is a member-carried default (the hub operator's `maxRetention` remains the real cap); a
  per-member override is possible.
- **Done when:** app-lane subscribes carry the 30-day retention request; a test asserts the value on
  the subscribe call; override path exercised.
- **Spec excerpt:** "Members request **30 days** by default via `SubscribeParams.retention` ... aligned
  to the commit window ... this is a default members carry, not a new mechanism. Per-member override
  up to the operator cap remains possible."
- **Verify:** `pnpm run build && rtk proxy pnpm run lint && pnpm test`

### Question 5.2: Does `docs/agents/architecture.md` now carry the retention-class / lane concept map?

- **Assumption:** the 14-line stub can be expanded into the durable overview: the two retention
  classes, the three lanes (commit / rendezvous / app), the anchor model, and usage examples.
- **Done when:** `docs/agents/architecture.md` documents retention classes, lanes, and the app-lane
  anchor model, consistent with the shipped code. (Docs-only — no code verify needed, but build/lint
  must still pass.)
- **Spec excerpt:** "**Expand `docs/agents/architecture.md`** (currently a 14-line stub) with the
  retention-class / lane concept map and usage examples — the durable home for the architecture
  overview."
- **Verify:** `pnpm run build && rtk proxy pnpm run lint && pnpm test`

---

## Decision Log

### 2026-07-16 — Question 3.1 (first attempt): BLOCKED, and the brief was wrong

**The block, and it is correct.** The brief specified drain-AFTER-apply (`processCommit` → capture the
new anchor → drain the segment just left, holding its anchor as pending in a multi-slot store). The
probe refused it and proved why at the peer level rather than arguing it: at that site every frame of
the segment just left is already undecryptable — `cannot open bytes sealed at epoch 1: this member is
at 2` — and the same frame opens one `processCommit` earlier.

**The error was mine: two different secrets, conflated.** The anchor is a **topic-derivation** secret —
it names WHERE frames live. It is not a message key and opens nothing; frames are sealed and opened by
`crypto.wrap`/`unwrap`, bound to the handle. So retaining a segment's anchor past the apply buys
nothing: it fetches ciphertext the peer can no longer open. **The multi-slot store is dead and Q2.4's
single slot stands** — crash before the apply and the single slot already restores it; crash after and
the frames are gone whatever the store holds. Done-when #2 asked the probe to assert the opposite of the
port contract; there was no green test for its own mutation to redden, which is how it surfaced.

**Spec §5 was right the whole time** — "walk epoch by epoch (deriving each `exportSecret()`) …
decrypting each frame under the epoch its ciphertext names" is drain-BEFORE-apply. Same hook site the
brief named, opposite side of it. The plan followed the brief; the spec did not need changing.

### 2026-07-16 — Fact: ts-mls retains exactly 4 past epochs, and the drain must not lean on it

**Measured, not reasoned** (`docs/superpowers/probes/ts-mls-past-epoch-decrypt.md` — a throwaway script
driving ts-mls directly). A `ClientState` at epoch N CAN decrypt application messages sealed at N-1 …
N-4; at epoch 8, epoch 2 gives `ValidationError: Cannot process message, epoch too old`.

- `ClientState.historicalReceiverData: Map<bigint, EpochReceiverData>` snapshots each departing epoch's
  secret tree, ratchet tree, sender-data secret and group context on every transition, evicting all but
  the most recent `retainKeysForEpochs` (**default 4**, `keyRetentionConfig.js:1-6`).
- **Structural, not an API limit:** eviction collects the dropped epoch's secrets into `consumed`, which
  `group-handle.ts:800` **zeroes**. No recovery path.
- Application messages only — a past-epoch commit or proposal throws by design.
- `@kumiai/mls` preserves this fully and never sets `clientConfig`, so the default always applies.

**Why the drain must not use it.** The window is spent by **epoch transitions, not time** — the
catch-up walk destroys the very keys it would need. A member away four commits could read; a member away
a week could not. That is a correctness cliff disguised as a working design, and it fails silently for
exactly the users this work exists for. Batching in chunks of ≤4 was available and **rejected**: it
couples the drain's correctness to an undeclared default of a dependency that kumiai never sets and does
not expose. Four is not a contract; it is a value we currently get by accident.

**Consequence — the fake's strictness becomes the contract.** `createFakeCrypto.unwrap` opens only at
the sealing epoch; real MLS opens a 4-epoch window. Interleaved decryption sits inside both, so a drain
green against the fake is correct in production — the fake is conservative, not wrong. But that was an
accident, and `GroupCrypto.unwrap`'s doc is silent on the question, which is the gap this question fell
into. State it: rpc requires `unwrap` to open frames sealed at the handle's CURRENT epoch, and the drain
never relies on past-epoch decryption.

**Noted, not acted on:** a fresh joiner's window is empty (`joinGroup` → `new Map()`) — correct by
design, a joiner must not read pre-join content (§4). Out-of-order reads within one epoch are bounded by
`retainKeysForGenerations: 10`; draining in log order reads each sender in generation order, inside the
bound.

**Hub-fake audit (clean).** `FakeHub`/`DurableFakeHub` are faithful on all ten properties the drain
relies on, checked against `types.ts`, `memoryStore.ts` and `@kumiai/hub-conformance`: log-class-only,
not delivery-filtered, exclusive `after`, retained without subscribers, `head` surviving trim,
limit-after-class-filter, subscription-gated fetch.

### 2026-07-16 — Question 2.5: the removed member is blind, and the doubles were hiding it

**Findings:** Confirmed, and **no `src/` change was needed** — the property already held. All the work
was making it provable, because nothing in the suite could see it. Verify green: rpc 200 passed / 1 skip,
mls 307, 30/30.

**Both doubles denied the property, in the same way, one file apart.**

- `fake-crypto.ts:78` was `exportSecret: () => secret` — a **fixed** value at every epoch, i.e. exactly
  "a lifelong secret plus a guessable epoch number", the shape the spec names as the bug. It also
  contradicted its own port doc ("an epoch-bound topic-derivation secret", `crypto.ts:4`). Now
  epoch-derived via `fakeEpochSecret(epoch, base)`, documented as **a mix, not a ratchet** — it models
  none of MLS's one-wayness and must not pretend to.
- `memory-group-mls.ts:544` (found by the probe, not predicted): a removed member **applied its own
  removal and advanced**, exporting the post-removal secret and rotating onto the group's topic. The
  property was inexpressible against it whatever the anchor sealed from. Now a Commit removing
  `localDID` is `{advanced: false}`, matching the real UpdatePath exclusion. No existing test ever
  removed its own local peer, which is why it survived.

**The assertion is the topic ID, not the delivery.** Every secret Carol still holds (recovery secret,
her last per-epoch secret) × every epoch number 0–6 — they are counters, so she can name them all —
against the group's topic read from a member's own anchor store. Mutation (seal the anchor from the
recovery secret): red, saying `carol derives the group's topic from the recovery secret, hers for life,
at epoch 2`. Nothing in the suite could catch that before.

**A prediction in the brief was wrong, and the probe was right to say so.** I claimed reverting the fake
would make that mutation stop being caught. It does not: the test catches it via the **recovery secret**,
which the fake never supplied (it comes from `mls.exportRecoverySecret()`). The fixture fix is
load-bearing in the other direction — **old fake + correct, unmutated code → the test fails**, because
Carol's fixed per-epoch secret *is* the group's. Against the old fake, a correct implementation and the
named bug are the same object.

**The exporter secret was the untested half in `@kumiai/mls` too.** `crypto.test.ts`'s existing
`member removal with forward secrecy` covers **message decryption** only — what a removed member can
READ. The topic derives from the **exporter** secret, which decides what it can NAME. Added alongside:
a removed member's state is stuck at the pre-removal epoch, still produces the old exporter secret for
life, and differs from the group's at every label.

**Known gap — the two halves are proved in places that never meet.** `@kumiai/mls` exposes no
exporter-secret surface; the host derives it from ts-mls itself. So a host implementing `exportSecret()`
as `exportRecoverySecret()` passes everything on both sides. See the `next/` item.

**Honest limit:** "she receives nothing" is true and asserted but catches no bug — once she is correctly
stranded, her epoch number alone keeps her off the topic. Only the topic-ID assertion has teeth.

### 2026-07-16 — Question 2.4: the anchor is persisted state, in a store of its own

**Findings:** Confirmed. A new `AnchorStore` (`packages/rpc/src/anchor.ts`) — `load()`/`save()`, one
slot, never cleared — **required alongside `mls`/`journal`** in `GroupPeerMLSParams`, on that type's own
existing argument: both failures are silent, and the type is what stops a host wiring either. The three
anchor captures collapsed into one `captureAnchor()` that exports and saves; construction restores
before `initControlLanes`, and an empty store means first boot and only first boot. Mutation (drop the
restore): `anchorEpoch()` returned the live epoch 3 instead of the persisted 1. Verify green: rpc 198
passed / 1 skip, 30/30.

**Rejected — the commit journal.** It is a single-slot store for one *pending* commit, cleared on
outcome (`commit.ts:99`). The anchor is state a peer holds for its whole life in the group. Same shape,
opposite lifecycle.

**Accepted residual — the crash window.** `processCommit` is durable, then rpc computes the anchor, then
`save()`. A crash between leaves a persisted anchor one rotation stale, and the peer stays off the
group's topic **until the next roster change** — which in a settled group could be weeks, not "briefly".
Closing it needs the anchor inside the same durable write as the handle, which this layer cannot reach:
the anchor exists only once the port has committed and returned. Recorded as a `KNOWN BOUND` comment on
`captureAnchor`, not a TODO. Revisit only as an `@kumiai/mls`-side change.

**`load()` is trusted, by construction.** A well-formed but wrong anchor (stale backup, a store shared
across groups) puts the peer on a dead topic with exactly the silence this work exists to remove. rpc
has nothing to validate it against — that the handle cannot re-derive it is the premise — so the port
contract carries it. Not a gap; a boundary.

**The fixtures modelled the bug (found by the probe, fixed after).** Thirteen restart sites across four
test files carried `mls`/`crypto`/`journal` into the restarted peer and took a **fresh** anchor store.
They passed only because their anchor never rotated — at an unrotated anchor, restoring and re-seeding
land on the same epoch and are indistinguishable, so threading the store through them was
*unfalsifiable*. Fixed structurally rather than by hand: `makeMLSPeer` gained `restartOf: TestPeer`,
carrying a dead peer's handle, crypto, journal, anchor store and Welcome record **as one** (explicit
options still override — a restart onto a different journal is a real scenario), so dropping a piece
stops being writable. Covered by one test that rotates the anchor *before* the restart and goes through
the shared fixture; mutation (drop `restartOf?.anchorStore`) reddens that test **and only** that test —
which is itself the proof that the other twelve never covered this.

### 2026-07-16 — Question 2.3: an external-commit rejoin rotates the anchor

**Findings:** Confirmed. `CommitHeader` gains an optional `external`; the lane rotates on
`rosterChanged || external`, and the rejoining peer captures its own anchor at the rejoined epoch (it
never `processCommit`s its own commit — the handle is adopted in `PendingRecovery.onAccepted`). Rejoiner
and group land on the same post-commit epoch and exchange logged events on one topic. Q2.2's pinned
three-way divergence is now convergence. Mutation (drop `|| external`): `expected 1 to be 4` — alice
stuck at 1 while eve reached 4, the exact partition. Verify green: rpc 194 passed / 1 skip, mls 306,
30/30.

**The probe's finding, and the fix it was scoped out of:** `@kumiai/mls`'s `readCommitHeader` **already
computed** the external branch (`group-handle.ts:747`) — it needs it to resolve a committer that holds
no pre-commit leaf — and then **discarded the fact**, returning `{epoch, committerDID}`. So the rpc port
declared `external`, the memory fake implemented it, and **no real host could populate it**: the hole
would have been closed in tests and left open in production. The brief's "mls doc-only" constraint was
simply wrong. Fixed here (additive: `external: true` on the external branch only, absent = member
commit), and asserted on the **real** path in `packages/mls/test/commit-header.test.ts` — which already
drives a genuine `resync: true` rejoin — plus a member-commit case pinning `external` undefined.
Mutation-checked: dropping `external: true` → `expected undefined to be true`, 1 failed / 305 passed.

**Spec impact:** none — §2/§3 already carry the explicit-signal model. Blast radius: `@kumiai/mls` is now
touched with **behaviour** (one additive field), not doc-only.

**Learned:**
- A rotation tears down **listeners** but never **subscriptions** (`hub-mux` refcounts locally and never
  unsubscribes), so a rejoiner keeps its stale pre-rejoin topic subscription **by design**. The probe
  could not simply mirror `peer-recovery.test.ts`'s subscriber assertion; it replaced it with the
  decisive fact (all three members on the rejoin epoch's topic). A "no longer subscribed" assertion after
  a rotation would be asserting something the architecture deliberately does not do.
- `readExternalCommit` is **module-private**, not a `GroupHandle` method (the Q2.2 brief said otherwise).
  The corrected `listMembers()` doc therefore points at the structural property rather than at a callable.
- `peer-roster-change-detect.test.ts`'s rejoin case gained a direct `detectRosterChange(...) === false`
  assertion alongside the rotation — preserving its subject (the predicate's blind spot) rather than
  hiding it now that the rotation happens for a different reason.

### 2026-07-16 — Question 2.2: anchor at the last roster change — stable, rotating, agreed (with one known hole)

**Findings:** Confirmed for adds/removes. Deriving app topics from `anchor.secret`/`anchor.epoch` holds
a segment stable, rotates on any roster change, and members **agree natively** — no exchange, no
persistence. The agreement test is decisive: alice boots at 1 and drifts to live epoch 3 with anchor
still 1; dave is added by a commit framed at 3, alice's anchor jumps **1→4 in one step**; dave boots
over a handle already at 4 and **never applies the add commit** (framed at 3, he is at 4). Both land on
4, asserted on the wire both directions. Mutation check (revert to removal-only detection):
`expected 1 to be 4`, 6 tests red. Verify green: rpc 193 passed / 1 skip, 30/30.

`detectRemoval` → `detectRosterChange` (set difference → set **inequality**; the size compare is what
catches an Add). Derivation swap kept from the earlier attempt; `secret` module var removed, `epoch`
kept (`frameCommit:956` reads it). `topic.ts` untouched. `peer-remove-detect.test.ts` renamed to
`peer-roster-change-detect.test.ts`.

**KNOWN HOLE (open — closed by Q2.3):** an **external-commit rejoin changes no DID**, so the DID-set
predicate cannot see it and nobody rotates. The spec's claim that "recovery re-synchronizes the anchor
for free" was **wrong**. Measured: after eve's rejoin, eve anchors at 1 while carol and dave anchor at
3. `peer-recovery.test.ts` was deliberately NOT inverted — the old assertion was accidentally right; its
reasoning comment was corrected and the three-way divergence pinned so the hole is recorded, not latent.

**Spec impact:** §2/§3 corrected — the "recovery re-synchronizes for free" claim removed; the rejoin
needs an explicit external-commit signal (Q2.3). Also corrected: the anchor lands on the **post-commit**
epoch, not the commit's framing epoch ("a member added at epoch E seeds at E" was mislabelled — outcome
right, label wrong).

**Learned:**
- **ts-mls resync reuses the old leaf index.** Verified against the library's own tree primitives: a
  rejoin blanks the old leaf then takes the **leftmost blank** — the leaf it just blanked (RFC 9420
  §12.4.3.2; `createCommit.js:255-265`, `ratchetTree.js:111-131`). Even removing the rightmost leaf does
  not shrink the tree (re-padded to `2^d-1`). So **an occupied-leaf-index diff is blind to a rejoin** —
  and kumiai's `joinGroupExternal` types `resync` as the literal `true` (`group-welcome.ts:176`), so
  every kumiai rejoin is that path. Not an edge case; the only case.
- An index diff is also blind to a same-commit Remove(X)+Add(Y) (Remove frees the index, Add takes it —
  `clientState.js:678-697`), which the DID-set diff **catches**. DID-set is strictly better than indices.
- The exact rejoin signal already exists in our own wrapper: `readExternalCommit`
  (`group-handle.ts:178-198`) — pre-apply, structural (`senderType === new_member_commit`), pulling the
  joiner's DID from the commit's own UpdatePath leaf credential.
- `GroupHandle.listMembers()`'s doc comment (`group-handle.ts:526-528`) **advertises the before/after
  diff idiom**, which is unsound for rejoin. Misleading doc worth fixing.
- Sealing the anchor into the recovery reply (the rejected alternative) would have bought nothing:
  frames are sealed under their **sending** epoch, so a member rejoining at R cannot decrypt epochs
  < R whatever topic they are on — the anchor secret would only let it fetch ciphertext it cannot open,
  while adding attested-payload surface where a mistake is an anchor-injection channel.

### 2026-07-16 — Question 2.1: roster-set diff detects a Remove (incl. Add+Remove)

**Findings:** Confirmed. Reading member DIDs before `processCommit` and diffing against after flags a
Remove iff a leaf present-before is absent-after — a **set** difference, not a count, so a commit
carrying both an Add and a Remove (leaf count unchanged) is detected. Add-only, update/no-op, and an
external-commit rejoin do not flag. Landed additively: `rosterDIDs()` on the `GroupMLS` port, a pure
`detectRemoval` helper (`roster.ts`), and a capture at the apply site in `pullCommits` that rotates
anchor state (`{secret, epoch}` from the post-commit per-epoch secret) on a detected removal. Observable
via a new `anchorEpoch()` getter. Verify green: `pnpm run build && rtk proxy pnpm run lint && pnpm test`
→ rpc 188 passed / 1 skip, 30/30 tasks; new `peer-remove-detect.test.ts` 12/12 (5 lane-driven shapes +
7 `detectRemoval` units).

**Spec impact:** none — matches §3 as written. Blast radius: `GroupMLS` port gains a **required**
additive method `rosterDIDs()` (Kubun adapter must implement it: `listMembers()→DIDs` — the tracked
Kubun follow-up). No `@kumiai/mls` core change.

**Learned:**
- The roster before-read must be unconditional at the apply site (it must precede the apply that would
  change the roster); the after-read + diff run only when the commit advanced, since only an applied
  commit moves the roster.
- Anchor state must be seeded at genesis **before** the seed pull, so a removal the seed pull applies
  rotates the anchor rather than being overwritten by a later re-seed.
- `anchor.secret` is captured but has no reader until Q2.2's topic derivation consumes it (recorded
  the anchor as a single `{secret, epoch}` object so the not-yet-read secret rides cleanly, no
  write-only-local lint warning).

### 2026-07-16 — Question 1.1: per-procedure retention makes logged events pull-drainable

**Findings:** Confirmed. An `event` procedure declaring `retain: 'log'` in the rpc-owned
`defineGroupProtocol` publishes via `mux.publish({ retain: 'log' })`; the frame is live-pushed to
online subscribers AND returned by `mux.fetchTopic`. An ephemeral event (default) is live-only — not
returned by `fetchTopic`. Both classes coexist on one app topic; `fetchTopic` returns only the logged
frames. The guardrail (`retain:'log'` on a `request`/`gather` procedure) is rejected at the type level
(constraint clause, one clean `// @ts-expect-error`) and by a runtime throw at definition time. No
`@kumiai/mls` change; `@kumiai/broadcast` gained only additive exports (see below). Verify green:
`pnpm run build && rtk proxy pnpm run lint && pnpm test` → rpc 176 passed / 1 pre-existing skip,
30/30 tasks.

**Spec impact:** none beyond what the pre-probe discussion already folded (kind × retention;
correlation always ephemeral; declared per procedure). Blast radius refined: `@kumiai/broadcast` is
touched, but only **additively** — `encode`, `buildEventMessage`, `encodeEventFrame` now exported so
the log lane and `BroadcastClient.dispatch` share one event-frame encoder (byte-identity no longer
duplicated). rpc's `app-frame.ts` removed.

**Learned:**
- The type guardrail must be a type-parameter **constraint**, not a mapped **parameter** type: under
  `const` inference a mapped parameter type reverse-maps and collapses the offending entry to `never`,
  scattering the error across every property. The constraint form lands exactly one error on the
  `retain` line. (Reusable pattern for "this field only valid on entries of shape X".)
- Receive is naturally unified: a `retain:'log'` publish and a mailbox publish land on the same topic
  and reach subscribers through the same mux drain, so only the **publish** path branches by
  retention — live receive is untouched. The returning-member drain (Phase 3) reads the same log via
  `fetchTopic`.
- `retentionOf` reads a runtime `.retain` off the definition, so the marker only takes effect through
  rpc's `defineGroupProtocol`; a protocol authored another way defaults to ephemeral (correct).
- `GroupProtocolDefinition` export shape changed (was `= ProtocolDefinition`, now rpc's
  `Record<string, GroupProcedureDefinition>`) — a structural superset; Kubun's typecheck against it is
  a migration-branch follow-up, not verified here.
