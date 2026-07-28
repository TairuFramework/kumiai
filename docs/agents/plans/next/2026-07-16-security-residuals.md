# Security residuals: what stayed open after the topic-derivation and commit-lane fixes

**Priority:** medium — neither section is closable in full from inside this repo, which is exactly
why they are recorded rather than dropped.
**Merged 2026-07-28** from `2026-07-16-exporter-secret-surface.md` and
`2026-07-18-external-commit-amplification.md`. Both have the same shape: the fix that prompted them
shipped, and what remains needs a bound that lives somewhere else — in a host's own port
implementation, or in whoever gates publish authorization.

The actionable work in this doc is small and specific: **section 1's item 2** (make conformance a
documented obligation) and **section 2's item 2** (determine whether a replayed rejoin can steer
anything). Everything else is a record.

---

## 1. A host that hand-rolls `GroupCrypto.exportSecret` can still get the one thing wrong

### What this was, and what closed

The app-lane topic derives from the peer anchor, which is sealed from `GroupCrypto.exportSecret()` —
"an epoch-bound topic-derivation secret" (`packages/rpc/src/crypto.ts:4`). That per-epoch property is
the **only** thing that cuts a removed member off: a removed member keeps the lifelong recovery
secret and every topic ID it ever derived, and epoch numbers are a counter it can enumerate. An
anchor sealed from anything a removed member keeps rotates onto a topic it walks straight back onto.

This was filed when `@kumiai/mls` exposed no exporter surface and every host implemented that method
itself. Both are now false:

- `GroupHandle.exportSecret` (`packages/mls/src/group-handle.ts:600`, added in `e33319d`) is the MLS
  exporter (RFC 9420 §8.5), documented with the removed-member reasoning above.
- `@kumiai/mls-rpc` wires the port to it (`packages/mls-rpc/src/crypto.ts:130`), so the ordinary path
  is right by construction rather than by care.
- The seam is watched: `rpc-conformance`'s clause *"is PER-EPOCH: the group rotates onto a different
  secret and the removed member keeps the old one"*
  (`packages/rpc-conformance/src/group-crypto.ts:156`) runs over the real `createGroupCrypto` from
  `packages/mls-rpc/test/ports-conformance.test.ts`.

Since filing, `GroupCrypto.exportSecret` gained a caller-supplied `label` and optional `length`
(`packages/rpc/src/crypto.ts:65`, commit `d24fd24`), which **widens** what a host's own
implementation must get right rather than narrowing it: the label flows through from the caller, so a
hand-rolled implementation that ignores it derives one secret for every purpose. The
`@kumiai/mls-rpc` implementation additionally refuses the ledger-entry seal label outright
(`packages/mls-rpc/src/crypto.ts:130-135`), since a caller passing that label would otherwise be
handed the ledger-entry key. A host writing its own `exportSecret` gets neither the pass-through nor
the refusal for free.

### The residue

A host that does **not** take `@kumiai/mls-rpc` still implements `GroupCrypto` itself, and
`exportSecret` remains the one method in it whose only failure mode is silent. Nothing fails: the
group works, members talk, removals remove, the roster and epoch are right, the health monitor is
quiet. The single symptom is that an evicted member can still name and read the topic.

The seam is now watched only from inside this repo. A host's own implementation is watched only if
that host runs the conformance suite against it — and the host that would wire the bug is the host
that skips it.

### What to do about it

1. **Check Kubun's `exportSecret()`** — the concrete instance, and the reason this stays filed rather
   than being deleted. Kubun is not on this machine, so it was not checked here. If it already
   delegates to `@kumiai/mls-rpc`, this is prevention; if it hand-rolls one, it is live.
2. **Make running `rpc-conformance` the documented obligation of implementing the ports**, so a host
   that writes its own `GroupCrypto` is told, where it is writing it, that the suite is not optional.
   *This is the actionable item.*
3. Beyond that there is little left to build — the surface exists and the clause exists. What remains
   is getting hosts onto both.

### Context

Found during the app-lane delivery work (`../completed/2026-07-21-app-lane-delivery.complete.md`),
whose design states the constraint this section exists to protect: **the anchor must feed the
per-epoch `exportSecret()`, never the lifelong recovery secret.**

---

## 2. Commit-lane forgery: what remains after authenticating an external commit's committer

The external commit's committer is now signature-checked before it is reported
(`GroupHandle.readCommitHeader`, `packages/mls/src/group-handle.ts`), and the `memory-group-mls`
double matches. This section records what that did NOT close, and why each item is not closable where
the fix lives.

### Fixed, for the record

A forged external commit — a genuine one with the UpdatePath leaf's credential identity rewritten to
the victim's DID, framed at the victim's own epoch — used to report that victim as the commit's
author. `classifyCommit` read that as `own-unmerged`, which heals **and holds the cursor**, so the
frame was re-read and re-healed on every pull: a targeted, permanent heal loop for a single publish,
against any peer the attacker chose. The committer is now returned only where the commit's own
signature verifies, so that frame authenticates nobody, lands on the authorless-at-own-epoch poison
row, and the cursor advances past it.

### STILL OPEN — the `ahead` storm. Not closable by authenticating anything.

One publish claiming a high epoch makes every honest peer classify the frame `ahead` and heal: a
rendezvous, a sealed GroupInfo from every responder, an external commit, and a compare-and-set, per
peer. M peers heal, M group-wide epoch advances, for one frame.

**A bare `PrivateMessage` is sufficient.** No key, no signature, no external commit, and no forged
credential: take any genuine member commit, rewrite only its cleartext epoch, re-encode. Measured
against unmodified code, `readCommitHeader` returns `{ epoch: 9999n }`. `classifyCommit` settles
`ahead` on `header.epoch > state.epoch` before the committer is consulted at all, so the frame never
reaches any authentication.

**As of `feat/app-lane-delivery`, the row has a second and cheaper trigger.** An unreadable
commit-frame *version* now settles `ahead` as well (`packages/rpc/src/classify.ts:235`, commit
`0777b86`), above every other row including the headerless one. So an attacker no longer needs a
genuine commit to rewrite the epoch of — a single garbage byte in the frame's version field asks
every peer to heal, with no commit bytes behind it at all.

That is the same trade this section already describes, taken knowingly and for a stronger reason, and
the alternative is worse in exactly the way the paragraph below says: after a real version bump EVERY
frame is unreadable, so a peer that filed them as poison has no next frame to heal from — it drains
to the end of the log and reports itself reconciled at a dead epoch, permanently and silently. The
asymmetry that justifies the `ahead` row holds here too: anything that can publish to the commit
topic can forge one of these and trigger a heal, and nothing can forge one that *suppresses* a heal.

**Why no signature check helps.** `ahead` asks for no committer, and none could be given: verifying
an external commit needs the group context of the epoch it was framed at, and an ahead-framed commit
is by definition at an epoch this peer holds no context for. A peer that has fallen behind holds
nothing to check the group's future with. That is not an implementation gap — it is what falling
behind means.

**Why the row cannot simply refuse.** `ahead` is the only signal that says "you fell out of the
group". A peer that filed unverifiable ahead-frames as poison would step over the group's entire
future and report itself fully reconciled at a dead epoch — silent, and worse than the storm.

**Where it belongs:** whoever gates publish authorization on the commit topic. A hub that accepted
commit frames only from current members, or a per-epoch publish credential, bounds it. Nothing in
`classify.ts` or `readCommitHeader` can. Anyone who can write to the commit topic — including a
removed member, who keeps the topic forever, and the untrusted hub, which sees every topic ID in the
clear — can emit it today.

#### Adjacent, on the other lane: one app-topic frame forces a commit-log walk

Not the same finding, but the same shape. The app-lane drain bounds a frame's future-epoch claim
against what the commit log can justify (`justifiedEpochCeiling`), and that ceiling pages the whole
commit topic. It is read lazily — once per drain, and only if some frame actually claims to be ahead
— so the honest path pays nothing. But anyone who can publish to the app topic can include one
ahead-claiming frame and force one commit-log walk per drain.

Bounded per drain rather than per frame, and far cheaper than the unbounded buffer growth it replaced
(a single frame claiming a wild epoch used to pin the cursor for the segment's whole life). Recorded
as a known cost of that fix, not as a regression.

### STILL OPEN — replay of a genuine external commit

A signature check proves possession of a key, never authorization to use it. It is a property of the
bytes, not of their delivery, so a **genuine** external commit captured and re-published by the hub
verifies exactly as it did the first time — same bytes, same key, same context. Nothing in the fix
distinguishes a first delivery from a replay.

**Open question, deliberately left open:** we did NOT establish whether a replayed rejoin can still
steer anything once the group has moved on. The plausible bound is that the replay is only accepted
while the group is still at the epoch the commit was framed at, after which it classifies as history
and is stepped over — but that was not tested, and "plausible" is not a security property. *Determine
this before deciding whether it needs a bound at all.* If it does, the bound is freshness or a
publish-side refusal of duplicates, not a signature check.

### Note on what a verified committer does and does not assert

A verified external-commit signature says "whoever produced these bytes held the key of the leaf
whose credential names that DID". It does **not** say the group authorized that member to rejoin, and
it is not a membership check. Whether a rejoin should additionally be gated on the roster is a
separate question, and was not in scope.
