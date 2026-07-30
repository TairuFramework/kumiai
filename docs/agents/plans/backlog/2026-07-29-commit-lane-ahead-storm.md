# Commit-lane `ahead` storm: bounding who may publish to the commit topic

**Priority:** medium — not closable inside `@kumiai/rpc`, which is why it is backlog rather than
next. **Carried forward 2026-07-29** from `next/2026-07-16-security-residuals.md`, whose other two
items closed (see `completed/2026-07-29-security-residuals.complete.md`). Nothing here is new; it is
preserved so the analysis is not buried in a completed file.

## The storm

One publish claiming a high epoch makes every honest peer classify the frame `ahead` and heal: a
rendezvous, a sealed GroupInfo from every responder, an external commit, and a compare-and-set, per
peer. M peers heal, M group-wide epoch advances, for one frame.

**A bare `PrivateMessage` is sufficient to trigger it.** No key, no signature, and no forged
credential are needed: take any genuine member commit, rewrite only its cleartext epoch, and
re-encode. `readCommitHeader` returns the rewritten epoch as-is, and `classifyCommit` settles
`ahead` on `header.epoch > state.epoch` before the committer is consulted at all — so the frame
never reaches any authentication step. Signature-checking the committer, which closed the earlier
forgery finding in this same doc, does nothing here because the epoch check runs first.

**A second, cheaper trigger exists as of `feat/app-lane-delivery`.** An unreadable commit-frame
*version* now also settles `ahead`, above every other row including the headerless one
(`packages/rpc/src/classify.ts:182`, commit `0777b86`). That means an attacker no longer needs a
genuine commit to rewrite the epoch of at all — a single garbage byte in the frame's version field
asks every peer to heal, with no commit bytes behind it.

**That trade was taken knowingly, for a stronger reason than convenience.** The alternative is
worse in exactly the way that matters: after a real version bump, EVERY frame from that point on is
unreadable, so a peer that instead filed unreadable-version frames as poison would have no next
frame to heal from. It would drain to the end of the log and report itself reconciled at a dead
epoch — permanently and silently, which is worse than the storm. The same asymmetry that justifies
treating the headerless row as `ahead` justifies this: anything that can publish to the commit topic
can already forge one of these frames and trigger a heal, and nothing can forge a frame that
*suppresses* a heal. Given that, routing unreadable-version frames to `ahead` rather than to poison
costs nothing additional and avoids the silent-dead-epoch failure mode.

**Why no signature check can close this.** `ahead` asks for no committer, and none could be
verified even if offered: verifying an external commit needs the group context of the epoch it was
framed at, and by definition an ahead-framed commit is at an epoch this peer holds no context for.
A peer that has fallen behind holds nothing to check the group's claimed future against — that is
not an implementation gap, it is what falling behind means.

**Why the row cannot simply refuse instead of healing.** `ahead` is the only signal that tells a
peer "you fell out of the group". A peer that filed unverifiable ahead-frames as poison, instead of
healing on them, would step over the group's entire future and report itself fully reconciled at a
dead epoch — silently, and worse than the storm it was meant to avoid.

**Where the bound belongs.** Nothing in `classify.ts` or `readCommitHeader` can close this from
inside `@kumiai/rpc`, because the classifier cannot distinguish a legitimate epoch claim from a
forged one without already trusting the publisher. The bound has to live in whoever gates publish
authorization on the commit topic: a hub that accepted commit frames only from current members, or a
per-epoch publish credential, would bound it. As things stand, anyone who can write to the commit
topic can emit an ahead-claiming frame today — including a removed member, who keeps the topic
forever, and the untrusted hub itself, which sees every topic ID in the clear.

## Adjacent: one app-topic frame forces a commit-log walk

Not the same finding, but the same shape, and on the other lane. The app-lane drain bounds a
frame's future-epoch claim against what the commit log can justify, via a per-drain
`justifiedEpochCeiling`, and computing that ceiling pages the whole commit topic. It is read
lazily — once per drain, and only if some frame in that drain actually claims to be ahead — so the
honest path pays nothing extra. But anyone who can publish to the app topic can include one
ahead-claiming frame and force one commit-log walk per drain.

This is bounded per drain rather than per frame, and is far cheaper than the unbounded buffer growth
it replaced (previously, a single frame claiming a wild epoch could pin the cursor for the whole life
of the segment). It is recorded here as a known cost of that earlier fix, not as a regression.
