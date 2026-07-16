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

## Phase 2: Anchor topic model and Remove detection

The topic must be derived from an anchor captured at the last Remove, and rotate exactly when a
Remove is applied — no sooner (non-removal commits keep it stable), no later.

**Exit criteria:** roster-set diff flags a Remove (including an Add+Remove in one commit) and only a
Remove; the online app topic is anchor-derived and rotates on a Remove but is stable across
non-removal commits; a removed member cannot derive the post-removal topic.

### Question 2.1: Does a roster-set diff around `processCommit` detect a Remove — and only a Remove — including Add+Remove in one commit?

- **Assumption:** capturing `GroupHandle.listMembers()` DIDs before applying a commit and comparing to
  after reliably yields "a Remove happened" iff some leaf present-before is absent-after; an
  Add-only or Update-only commit yields no removal; an Add+Remove commit still flags the removal;
  external-commit rejoin (add) does not flag.
- **Done when:** a test drives commits of each shape (add-only, update/no-op, remove-only,
  add+remove, external-commit add) and asserts the diff's removal verdict matches for each.
- **Spec excerpt:** "detect a Remove by diffing the roster around application: capture
  `GroupHandle.listMembers()` DIDs before `processCommit`, compare to after; **any leaf
  present-before-and-absent-after means a Remove was applied** → rotate the anchor. This is robust to
  the Add+Remove-in-one-commit case (a count check is not) and to self-removal/leave. External-commit
  rejoin only *adds* a leaf, so it correctly does not rotate. No `@kumiai/mls` change."
- **Verify:** `pnpm run build && rtk proxy pnpm run lint && pnpm test`

### Question 2.2: Does an anchor-derived app topic stay stable across non-removal commits and rotate (drop old sub, subscribe new) on a Remove?

- **Assumption:** new peer state `anchorSecret`/`anchorEpoch`, captured from `exportSecret()` at the
  last Remove and fed to `protocolTopic`/`inboxTopic`, holds the topic constant while epochs advance
  without a Remove; applying a Remove updates the anchor, drops the old (log-class, safe) app
  subscription, and subscribes the new topic; a live publisher and a live subscriber mid-segment
  agree on the topic.
- **Done when:** a test shows two online members exchanging app frames across several non-removal
  commits on one stable topic, then a Remove rotates both onto a new topic and delivery continues;
  `topic.ts` signatures unchanged.
- **Spec excerpt:** "`appTopic = protocolTopic(anchorSecret, anchorEpoch, name)` ... captured from
  `exportSecret()` at the **last commit containing a Remove**. Non-removal commits leave the topic
  stable; a Remove rotates it. ... On applying a Remove, update the anchor, drop the old subscription
  (safe — log-class), subscribe the new topic."
- **Verify:** `pnpm run build && rtk proxy pnpm run lint && pnpm test`

### Question 2.3: Is a removed member unable to derive or read the post-removal app topic?

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
  its MLS ciphertext names; at each Remove boundary it updates the anchor and moves to the next
  segment's topic. Delivered frames reach the host through the existing `handlers` map.
- **Done when:** a test seeds app frames across at least two segments separated by a Remove, brings a
  peer up cold, and asserts the handler receives every frame's plaintext in publish order.
- **Spec excerpt:** "walk the commit log epoch by epoch (deriving each `exportSecret()`), pulling
  **once per segment** — the run of epochs between two removals is one stable topic — to head,
  decrypting each frame under the epoch its MLS ciphertext names; at each Remove boundary update the
  anchor and move to the next segment's topic. ... Delivered frames reach the host through the
  existing `handlers` map — no new host delivery API."
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
