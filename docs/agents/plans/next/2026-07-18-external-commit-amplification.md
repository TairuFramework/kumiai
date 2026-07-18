# Commit-lane forgery: what remains open after authenticating an external commit's committer

The external commit's committer is now signature-checked before it is reported
(`GroupHandle.readCommitHeader`, `packages/mls/src/group-handle.ts`), and the `memory-group-mls`
double matches. This file records what that did NOT close, and why each item is not closable where
the fix lives.

## Fixed, for the record

A forged external commit — a genuine one with the UpdatePath leaf's credential identity rewritten to
the victim's DID, framed at the victim's own epoch — used to report that victim as the commit's
author. `classifyCommit` read that as `own-unmerged`, which heals **and holds the cursor**, so the
frame was re-read and re-healed on every pull: a targeted, permanent heal loop for a single publish,
against any peer the attacker chose. The committer is now returned only where the commit's own
signature verifies, so that frame authenticates nobody, lands on the authorless-at-own-epoch poison
row, and the cursor advances past it.

## 1. STILL OPEN — the `ahead` storm. Not closable by authenticating anything.

One publish claiming a high epoch makes every honest peer classify the frame `ahead` and heal: a
rendezvous, a sealed GroupInfo from every responder, an external commit, and a compare-and-set,
per peer. M peers heal, M group-wide epoch advances, for one frame.

**A bare `PrivateMessage` is sufficient.** No key, no signature, no external commit, and no forged
credential: take any genuine member commit, rewrite only its cleartext epoch, re-encode. Measured
against unmodified code, `readCommitHeader` returns `{ epoch: 9999n }`. `classifyCommit` settles
`ahead` on `header.epoch > state.epoch` before the committer is consulted at all, so the frame never
reaches any authentication.

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

## 2. STILL OPEN — replay of a genuine external commit

A signature check proves possession of a key, never authorization to use it. It is a property of the
bytes, not of their delivery, so a **genuine** external commit captured and re-published by the hub
verifies exactly as it did the first time — same bytes, same key, same context. Nothing in the fix
distinguishes a first delivery from a replay.

**Open question, deliberately left open:** we did NOT establish whether a replayed rejoin can still
steer anything once the group has moved on. The plausible bound is that the replay is only accepted
while the group is still at the epoch the commit was framed at, after which it classifies as history
and is stepped over — but that was not tested, and "plausible" is not a security property. Someone
should determine it before deciding whether this needs a bound at all. If it does, the bound is
freshness or a publish-side refusal of duplicates, not a signature check.

## 3. Note on what a verified committer does and does not assert

Worth stating where the next reader will look for it: a verified external-commit signature says
"whoever produced these bytes held the key of the leaf whose credential names that DID". It does
**not** say the group authorized that member to rejoin, and it is not a membership check. Whether a
rejoin should additionally be gated on the roster is a separate question from this one, and was not
in scope.
