# Probe report — anchor at the last ROSTER CHANGE: stable, rotating, and AGREED

**Status: ANSWERED — YES, with one bounded exception that is NOT the persistence question.**

Deriving the app topics from an anchor at the last roster change holds the topic stable within a
segment, rotates it on any roster change, and keeps every member agreeing on it — including the
decisive case of a member whose peer boots at a later epoch than the anchor. The agreement is
native: no exchange, no negotiation, no persistence.

The exception: an **external-commit rejoin by a member the roster still holds** changes no DID, so
the approved set-inequality predicate cannot see it and no member rotates. This contradicts the
spec's "recovery re-synchronizes the anchor for free", and it is not fixable within this probe's
scope. Details in **Concerns**, and it is the reason one test the brief expected me to invert is
left asserting what it already asserted. Nothing was weakened to make anything pass.

---

## Changes

### Detection widened (the one behavioural change)

`packages/rpc/src/roster.ts` — `detectRemoval` → **`detectRosterChange`**, set difference → set
**inequality** (`:22`). Size compare, then membership:

```ts
export function detectRosterChange(before: Array<string>, after: Array<string>): boolean {
  const held = new Set(before)
  const present = new Set(after)
  if (held.size !== present.size) return true
  for (const did of held) {
    if (!present.has(did)) return true
  }
  return false
}
```

The size compare is what catches the Add (the old loop only ever saw losses); the membership loop
still catches the Remove and the Add+Remove-in-one-commit case. Sets on both sides, so duplicate
leaves for one DID do not read as a change — asserted at
`packages/rpc/test/peer-roster-change-detect.test.ts:176`.

Doc-comment rewritten to the corrected rationale: the anchor must be ≥ every current member's join
(MLS ratchets forward — a member added at E cannot export an earlier epoch's secret) **and** after
every removal (forward secrecy), and `max(last add, last remove)` is the only epoch that is both.

### Call site and export

- `packages/rpc/src/peer.ts:49` — import renamed.
- `packages/rpc/src/peer.ts:848` — the predicate at the apply site; comment now states that every
  member applying the same commit runs the same diff and lands on the same epoch, which is *why*
  the anchor is agreed rather than merely local.
- `packages/rpc/src/peer.ts:799-804` — noted that `rosterBefore` is read unconditionally because
  whether the diff is needed is not knowable until the apply has destroyed the answer.
- `packages/rpc/src/index.ts:81` — export renamed.

### Kept from the previous probe, as instructed

The derivation swap is untouched and correct: `protocolTopic(anchor.secret, anchor.epoch, name)`
(`peer.ts:289`), `selfInbox = inboxTopic(anchor.secret, anchor.epoch, localDID)` (`:296`), the
acceptor's `resolveSendTopic` (`:326`), `createDirectedClient` (`:385-386`). `wrap`/`unwrap` still
on live `crypto`; the `secret` module var still gone; `epoch` still kept for `frameCommit`.
`topic.ts` untouched. `peer.ts` was already carrying the committed anchor machinery (the `anchor`
var `:276`, `anchorEpoch()` `:1533`, the genesis seed `:1499`) — I changed none of its structure,
only the predicate that drives it and the doc comments that described the old invariant.

### Doc comments re-stated to the corrected invariant

`peer.ts:218-224` (`anchorEpoch`), `:231-234` (`ProtocolRuntime.topicID`), `:268-285` (the `anchor`
var — now carries the two-constraint argument), `:285-288` (`buildEpoch`), `:1496-1501` (the genesis
seed — now states that a member booting over a freshly-added handle seeds at its own add epoch,
which is the same epoch every existing member rotates to; that sentence *is* the agreement).

---

## Tests re-inverted (which, and why)

The previous probe wrote these to the old "rotate only on Remove" invariant.

| File | Was | Now | Why |
|---|---|---|---|
| `peer-roster-change-detect.test.ts:68` (renamed from `peer-remove-detect.test.ts`) | add-only → anchor stays `1` | add-only → anchor **`2`** | An add-only commit rotates. Dave joins at 2 and can export no secret older than it. |
| `peer-roster-change-detect.test.ts:100` | external rejoin → anchor stays `1` | rejoin of a DID the roster **lost** → anchor **`2`** | Bob's roster gains `dave`, so the DID set moves. |
| `peer-roster-change-detect.test.ts:127` | *(new)* | rejoin of a DID the roster **still holds** → anchor stays `1` | The predicate's honest edge, pinned rather than left to be discovered. See Concerns. |
| `peer-roster-change-detect.test.ts:154+` | `detectRemoval` set-difference unit cases | `detectRosterChange` set-inequality | `add-only` flips `false`→`true` — the exact case the old predicate missed. |
| `peer-app-topic.test.ts:105-118` (old) | add-only folded into the "stable" test as a non-rotating commit | replaced with a **ledger-only** commit; the add-only case promoted to its own rotation test (`:200`) | An Add is no longer a non-event, so it cannot serve as filler in a stability test. The stability test now uses update/no-op + ledger-only, exactly as the brief specifies. |
| `peer-recovery.test.ts:45-63` | anchor stays `1` | **still `1`**, comment corrected, divergence now asserted | Not inverted — see Concerns. The brief predicted rotation; the approved predicate cannot produce it. |
| `peer-commit-lane.test.ts:47`, `peer-control-lanes.test.ts:145,194` | "dropped no leaf" | "touched no leaf" | Wording only. These commits carry no roster op, so they were already right; the *reason* they hold changed. |

`peer-control-lanes.test.ts:20-83` needed no inversion — the previous probe had already given it a
genuine roster change (a Remove) to drive its real subject, "a rotation never unsubscribes". That
subject is preserved intact.

Renamed `peer-remove-detect.test.ts` → **`peer-roster-change-detect.test.ts`** (via `git mv`); the
old name had become a misnomer.

---

## The agreement test, and its mutation result

`packages/rpc/test/peer-app-topic.test.ts:264-355` — *"a member booting at a later epoch than the
anchor derives the same topic and exchanges events"*.

The setup separates the anchor from every peer's live epoch, so that nothing but the anchor can
explain agreement:

1. Alice boots at epoch 1 with `['alice','bob']`. Anchor = 1.
2. Two non-roster-changing commits — an update and a ledger enact. Alice's live epoch → **3**, her
   anchor stays **1**: a whole segment of drift.
3. Dave is added by a commit framed at 3. Alice applies it → live epoch 4, and her anchor **jumps
   1 → 4 in one step**, skipping the two epochs she actually walked through.
4. Dave's peer boots over a handle already at **4** — the epoch his Welcome left him at, two past
   where Alice's peer booted. He seeds his anchor there natively. He never applies the add commit
   at all: it is framed at 3 and he is at 4.

Both land on 4. `protocolTopic(secret, 4, 'room')` is one topic ID, asserted equal (`:340`), and
then asserted **on the wire**: Alice→Dave and Dave→Alice both deliver, and a `fetchTopic` as Dave
finds exactly the two frames on that one topic (`:353`). Neither peer could have reached the
other's number by any local means — Alice cannot know Dave's boot epoch, and Dave's handle can
export nothing from before his add. The add commit is the only thing they share, and it is what
puts them on the same topic.

### Mutation check — required, and it passes

Temporarily reverted `detectRosterChange` to the removal-only set difference (the pre-correction
predicate) and re-ran:

```
 FAIL  test/peer-app-topic.test.ts > every member agrees on the anchor, including one that boots
       after it > a member booting at a later epoch than the anchor derives the same topic and
       exchanges events
AssertionError: expected 1 to be 4 // Object.is equality

- Expected
+ Received

- 4
+ 1

 ❯ test/peer-app-topic.test.ts:318:38
    318|     expect(alice.peer.anchorEpoch()).toBe(4)
       |                                      ^
```

Under the mutation Alice's anchor stays at **1** while Dave's seeds at **4**: the two derive
different topic IDs and the group silently partitions on Dave's arrival — no Remove anywhere in the
scenario. Repo-wide the mutation took **6 tests red** (193 pass → 187 pass / 6 fail), the agreement
test among them. Mutation reverted; `git diff packages/rpc/src/roster.ts` confirms the clean
predicate is what is in the tree, and the suite is back to 193 passing.

The test therefore fails for exactly the reason the brief requires it to.

---

## Verify

`pnpm run build && rtk proxy pnpm run lint && pnpm test`, repo root:

```
 Tasks:    8 successful, 8 total
Cached:    8 cached, 8 total
  Time:    22ms >>> FULL TURBO

$ biome check --write ./packages ./tests
Checked 214 files in 168ms. No fixes applied.

@kumiai/broadcast:test:unit:  Test Files  8 passed (8)
@kumiai/broadcast:test:unit:       Tests  35 passed (35)
@kumiai/hub-protocol:test:unit:  Test Files  1 passed (1)
@kumiai/hub-protocol:test:unit:       Tests  8 passed (8)
@kumiai/mls:test:unit:  Test Files  25 passed (25)
@kumiai/mls:test:unit:       Tests  306 passed (306)
@kumiai/hub-tunnel:test:unit:  Test Files  20 passed (20)
@kumiai/hub-tunnel:test:unit:       Tests  63 passed (63)
@kumiai/hub-server:test:unit:  Test Files  5 passed (5)
@kumiai/hub-server:test:unit:       Tests  69 passed (69)
@kumiai/rpc:test:unit:  Test Files  32 passed (32)
@kumiai/rpc:test:unit:       Tests  193 passed | 1 skipped (194)

 Tasks:    30 successful, 30 total
```

Green. The 1 skip is pre-existing and unrelated. `@kumiai/rpc` went 190 → 193 (3 net new: the
add-rotation test, the agreement test, the rejoin-edge test; the unit cases moved rather than grew).

---

## Surprises

**1. The anchor is the POST-commit epoch, not the epoch the commit is framed at.** A commit framed
at 3 leaves the anchor at 4, because `enact` advances before `anchor` is captured. The spec's prose
("a member added at epoch E seeds its anchor at E") reads as if the add commit's own framing epoch
were the anchor. It is not, and it does not need to be — the joiner's handle boots at the *post*-add
epoch, which is the same 4, so the two still meet. The prose and the code agree on the outcome while
disagreeing on the label. I drafted the agreement test to the spec's label first and it failed;
worth fixing the prose before it misleads someone again.

**2. The brief's expectation for `peer-recovery.test.ts` was wrong, and the old assertion was
accidentally right.** The brief lists it as inverted-by-the-old-probe and requiring re-inversion to
"rotate". It does not rotate — for a reason unrelated to the old removal-only model. See below.

---

## Concerns

**1. (Material) The set-inequality predicate cannot see an external-commit rejoin, and the spec
claims it can.** The spec asserts "An external-commit rejoin adds a leaf, so it rotates too" and
"recovery re-synchronizes the anchor for free". Both are false under the approved predicate,
because the two clauses of the spec are inconsistent with each other:

- "the two DID sets differ at all" is a statement about **DIDs**;
- "a rejoin adds a **leaf**" is a statement about **leaves**.

An external commit with `resync: true` removes the rejoiner's old leaf and adds a new one for the
same DID. The leaf multiset changes; **the DID set does not**. So the diff sees nothing — not for
the rejoiner, and not for the members applying the rejoin. Measured in `peer-recovery.test.ts`:
after Eve's successful rejoin at epoch 4, `eve.peer.anchorEpoch() === 1` and
`carol.peer.anchorEpoch() === dave.peer.anchorEpoch() === 3`. They are partitioned, and the heal did
not close it. I have asserted all three (`peer-recovery.test.ts:56-63`) so the hole is recorded
rather than latent, and pinned the predicate's edge directly at
`peer-roster-change-detect.test.ts:127`.

This is **not** the persistence question (Q2.3), though Q2.3 is tangled in it. Two distinct causes
stack here:

- *Boot re-seed (Q2.3):* Carol anchors at 3 only because she booted at 3. Expected, in-scope-to-
  ignore, and the brief said so.
- *Rejoin blind spot (this question):* the rejoin is the event that ought to have reunited them, and
  it is invisible. Persistence alone does **not** fix it — a rejoined handle is fresh and cannot
  export the anchor epoch's secret however faithfully the peer remembered which epoch that was. It
  needs the rejoin to rotate everyone, which needs the predicate to see it.

I did not fix it, deliberately. Making it rotate correctly requires *both* sides to rotate, and the
members applying the external commit have no way to know it was one: `readCommitHeader` returns
`{ epoch, committerDID }` and nothing more, and the port exposes only `rosterDIDs()` — DIDs, not
leaves. Closing this means widening the port API (an `external` flag on the header, or a leaf-level
roster read). That is a redesign, and the brief said to report rather than redesign. **Flagging it
as the natural successor question to Q2.3, and noting the spec text needs correcting either way.**

**2. `detectRosterChange` is now misnamed relative to what it detects.** It detects a *DID-set*
change, not a roster change — the gap in concern 1 is exactly the difference. The name is the
brief's and I kept it, but it papers over the distinction that bites. `detectMemberSetChange` would
not have let this hide.

**3. The double's epoch-independent `exportSecret()` hides the real failure mode.** Every app-topic
assertion here varies with the anchor *epoch* alone; with a real ratcheting MLS, a peer anchored at
an epoch it cannot export the secret for does not derive a *different* topic — it derives *nothing*
and fails differently. The agreement test proves the two peers compute the same anchor epoch, which
is the property in question, but it cannot prove Dave *can* export epoch 4's secret. He can, by
construction (he boots there). Alice's ability to export 4's secret at the moment she rotates is
likewise real. So the conclusion holds — but nothing in this suite would catch a regression that
anchors somewhere underivable. Worth a real-MLS integration test before this leaves probe status.

**4. Out of scope, untouched, and confirmed still broken:** a restart re-seeds the anchor from the
live epoch and still partitions (Q2.3). No anchor persistence was implemented. Nothing in the
required tests needed it — the agreement test boots Dave *fresh*, which is precisely why it does not
need persistence to pass.
