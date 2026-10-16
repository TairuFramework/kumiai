# Spec P 2.2e: fork detection, recovery escape hatches and hub migration

Date: 2026-10-16
Status: design, awaiting user approval
Baseline: `feat/spec-p-phase-2` at `2d86eb7`, Spec P r23
Supersedes: the "terminal halt" and "fork evidence halts" parts of `2026-10-14-spec-p-fork-checkpoints-design.md`. That
note stays the reference for checkpoint format, storage, cadence and budgets; everything below that contradicts it wins.
Carry-forwards read: `docs/superpowers/plans/2026-10-1{1,2,4,6}-spec-p-2-2{a,b,c,d}-carry-forward.md`.

## Intent

Groups must survive the realistic ways a hub fails (bugs, replica divergence, selective delivery, split views, the hub
going down) without a human babysitting every incident and without letting one peer roll the group back. 2.2e makes
forks visible, keeps the hub's surviving log as the single source of continuation, and gives the app explicit escape
hatches: move to another hub/topic, retire in favour of a successor group, lift a halt it reported. Detection and
surfacing are the core; helpers that act on the app's behalf are out of scope.

## Threat model (user, binding)

- The hub is blind: one append-only log per topic, CAS on head, opaque bytes. It never knows about branches or MLS.
  It cannot forge MLS. It can withhold, delay, reorder, replay and deliver selectively. DoS is the main concern.
- Non-delivery is accepted and undetectable in-band.
- Peers are trusted in intent but may be buggy. No single peer may roll the group back or steer it. Peers cannot
  elevate privileges: roles are admin-signed ledger entries refolded from genesis on every join/recovery
  (`packages/mls/src/group-welcome.ts:139`); routing is app-owned, not group state.

## How forks resolve (user decision)

A fork exists only when the hub served different logs to different devices. The branch that continues is whatever
the hub's log ends up holding: new commits can only CAS onto that head, and 2.2d recovery already moves a stranded
device onto it. That winner is arbitrary (whatever the hub's repair kept), not chosen by members or the app. kumiai
follows it. If the hub never heals, both sides continue; only checkpoints reveal it, and only manual recovery to an
app-supplied target fixes it.

Consequences: checkpoints never pick a winner, never halt, never switch. There is no fork handler and no ranking.
A lone buggy or malicious peer can at worst cause a spurious notification.

## Goals

1. Detect forks with member-signed checkpoints and notify the app with evidence and at-risk data.
2. When 2.2d recovery moves a device off an abandoned branch, report what was abandoned and let the app resend the
   device's own messages.
3. Surface "not a member of the surviving branch" as a distinct, authenticated, terminal condition.
4. Manual recovery: rejoin/move to a target supplied at call time (including a new hub when the old one is down), or
   retire in favour of a successor group the app created.
5. App can lift a halt it reported itself.
6. Surface spent-set corruption as a distinct condition.

## Non-goals

- Choosing a winning branch, merging branches, copying messages/state between branches or groups.
- Successor-group helpers or member migration (app owns it).
- Automatic hub migration or destination choice (app supplies targets).
- Out-of-band checkpoint transport (keep local export/import/verify APIs so it can come later).
- Undeclared backup restore (outside the model, spec D1).

## Anti-goals

- Any checkpoint, frame or hub-delivered byte causing a halt, discard, rebuild or stranding.
- A single peer influencing which branch the group follows.
- Fork notifications so frequent the app perceives them as noise.
- A terminal "not a member" condition raised without authenticated proof.

## 1. Checkpoints (from the 2026-10-14 note, with changes)

Keep: topic `deriveTopicID(recoverySecret, 0, 'kumiai/checkpoint/v1')` with `retain: 'log'`; canonical signed frame
(≤4,096 bytes, strict Ed25519); retained local roster facts captured atomically at installation; publish on every
installation plus a 30-minute heartbeat (±20% jitter); retention newest 256 installations or 7 days after
supersession; receive budgets (32 frames / 128 KiB / 64 signature checks per turn); export/import/standalone verify.
The hub `authorize` hook gates the checkpoint topic exactly like the commit topic.

Changes:
- **Detection only.** A conflict opens or updates a fork notice (section 2). No halt, no switch.
- **Eligibility (my call):** a signer counts if its DID + key hash is in our retained roster fact for the epoch
  before the first disagreeing epoch (the roster both branches share), falling back to our roster at the compared
  epoch when the earlier fact is gone. Signers are counted once per DID for reporting.
- **Lineage (my call):** the body gains `parentAuthHash` (our authHash at epoch-1, or null when not installed), so a
  conflict first seen at a later epoch can be traced back to where the branches split, within retention.
- **Signer privacy (my call):** the frame carries `keyHash` and `leafIndex`, not `signerDID`; verifiers resolve the
  signer in their own retained roster fact. Same-key unequal statements are attributed as equivocation.

## 2. Fork notice

Durable group-level record (sealed like checkpoints), one per detected split: split epoch (best known), per branch
the `authHash`, testifying signers, `firstSeenAt`, `lastCheckpointAt`; which branch this device is on; `detectedAt`,
`lastEvidenceAt` (local wall clock; hub timestamps never used); at-risk list (this device's own messages sent on its
branch since the split).

Event `fork-detected` (replays until acknowledged) carries that record. Re-emission (`fork-updated`) only on material
change: a new branch, a new testifying signer, the split epoch moving earlier, or the device's branch changing;
coalesced to at most once per `forkNoticeMinInterval` (default 30 s, my call). Unchanged heartbeats never notify.
The app uses `detectedAt`/`lastEvidenceAt` for its own policy (for example, escalate if unresolved after N minutes).

A notice closes when only one branch keeps receiving checkpoints for `forkNoticeQuietInterval` (default 24 h, my
call) or when the device switches branch (section 3). Closed notices are kept for their evidence lifetime.

## 3. Switching off an abandoned branch

Mechanism unchanged: 2.2d captured recovery and incarnation switch, triggered by the hub's log, not by checkpoints.

When a switch abandons epochs (the recovered state does not descend from the device's previous state), emit
`branch-abandoned` with: abandoned epoch range, link to the open fork notice if any, this device's own messages sent
only on the abandoned branch, counts of others' messages seen only there, and members added/removed only on the
abandoned branch (for an admin to redo). The app may resend the device's own messages (user decision); only own
messages, never others'. If sent plaintext is not retained, report message IDs and the app resends from its copy.

Epoch floor (my call): with an open fork notice whose evidence shows the split at E, a switch onto the hub's branch
may lower `recoveryEpochFloor` to E. The lower branch still has to come from authenticated responders; the hub cannot
forge it. This fixes the 2.2d deferred minor where a further-advanced losing branch blocked recovery forever.

## 4. "Not a member of the surviving branch" (user decision)

When the device's DID is absent from the surviving branch's head-verified roster (added only on the abandoned branch,
or removed on the surviving branch), stop retrying and raise a terminal `not-member` condition (event, typed error,
`status()`). Raised only on that authenticated proof; absence of replies or hub-relayed refusals never raise it
(those stay `pending` and retry). The app arranges a fresh invite or treats the device as removed.

## 5. Manual recovery and hub migration

`recover()` (spec r14 `ManualRecovery`, extended):
- `{mode:'resync', targetID}`: a target registered at setup (unchanged).
- `{mode:'resync', target: {hub, commitTopicID}}` (user decision): a target supplied at call time, for example a new
  hub because the old one is down. kumiai never chooses destinations.
  - Device current on its state: re-point transport to the new target and keep MLS state. No rejoin. The first device
    to publish on an empty topic starts its log; others CAS after it.
  - Device behind: rejoin via 2.2d captured recovery from responders already on the new target, each checked
    against retained recovery trust. Untrusted branches are refused; the previous state/halt is kept.
  - Rendezvous/checkpoint topics move with the commit topic (derived as today from the recovery secret).
- `{mode:'successor', successor}`: the app first creates/joins the successor through normal admission; kumiai then
  retires the source and tombstones it so an old Welcome cannot readmit it. Nothing is copied. The app may clear the
  tombstone explicitly.
- The chosen action and target are persisted before execution; restart resumes only that attempt; failure leaves the
  prior state and any halt intact.
- The 2.2a ruling "explicit recover() stays blocked under strong holds until 2.2e" is lifted for these modes. This is
  also the escape from the 2.2d accepted residual (signed floor inflation stranding a group).

## 6. Clearing app-reported halts (user decision)

`clearHold(group)` lifts only a halt the app reported through `GroupSafety`. It does not touch spent-set corruption,
`not-member`, unsupported-version holds or kumiai's own safety latches. Durable; reported evidence kept as history.
After clearing, the group resumes through the ordinary commit walk; if stranded, 2.2d recovery takes over. No forced
resync.

## 7. Spent-set corruption (user decision)

Only cause in scope: a surviving store whose spent set is missing or unreadable. Total loss with Welcome keys also
lost is handled by a plain re-invite into the same group. Detect, refuse admission as today, and surface a distinct
`spent-set-corrupt` condition (event, typed error, `status()`). No helpers.

## 8. Carry-forward obligations folded in

- 2.2c: hub-mux gated `retain` drops its refcount while gated; with clearable holds it must defer instead.
- 2.2c: soften the README "manual recovery remains unavailable until 2.2e" wording.
- 2.2d: switch-proof resolution stays unbounded with visible `pending` (my call).
- 2.2d deferred minors touching these paths are re-weighed during planning.

## Left to the builder

- Record codecs, event and type names, following existing naming.
- Whether sent plaintext is retained for resend or only message IDs are reported (use what the outbox stores; do not
  add plaintext retention for this).
- How "current on its state" is decided for hub migration (e.g. local head equals last applied epoch with no pending
  operations), provided a device never publishes onto a new topic from a state it knows is behind.
- Test matrix shape, including: real-MLS split view detected on both sides with no halt; lone buggy peer only notifies;
  notice coalescing and quiet close under fake timers; hub heal moves the losing device with `branch-abandoned` and
  correct at-risk list; floor lowered only with fork evidence; `not-member` only on authenticated roster absence;
  hub migration for current and lagging devices including restart mid-move; successor + tombstone; clearHold scope;
  spent-set corruption; real store and memory double parity (double may be stricter, never more permissive).

## My calls (please check)

1. Eligibility roster: shared pre-split roster, counted once per DID.
2. Checkpoint body gains `parentAuthHash`; frame carries `keyHash`, not `signerDID`.
3. Notice defaults: `forkNoticeMinInterval` 30 s, `forkNoticeQuietInterval` 24 h.
4. With fork evidence, a switch may lower the recovery epoch floor to the split epoch.
5. Rendezvous/checkpoint topics follow the commit topic on hub migration.
6. `clearHold` limited to app-reported halts; successor tombstones app-clearable.
7. Switch-proof resolution stays unbounded with visible `pending`.
