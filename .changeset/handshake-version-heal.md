---
'@kumiai/rpc': minor
---

An unknown frame version on the commit lane now HEALS instead of being filed as poison, and the
commit frame and the sealed ledger-entry blob each gained a leading version byte.

This is forward-compatibility machinery, not a feature, and the reason to take the break now is
that it only works if it ships *before* the thing that needs it. The peers that must tolerate a
v2 frame are the ones running today's code.

**The bug it fixes is silent.** `decodeHandshakeFrame` threw on an unknown version, and the
commit lane caught that *before* `classifyCommit` saw the frame — so the frame was stepped over
without ever being classified, and it is the classification that makes a peer notice the group
moved past it (`ahead`) and heal. That reasoning survives only while some frames stay readable.
After a version bump none are: the peer steps over the group's entire future, drains to the end
of the log, records the live tip, and reports itself fully reconciled at an epoch nobody else is
at. No error, no heal, and no restart that fixes it.

- `decodeHandshakeFrame` returns `version` and no longer throws on one it does not know. It
  still throws on a short frame, a bad magic and an unknown kind. **Every caller must now
  compare `version` against `HANDSHAKE_VERSION` before trusting `payload`.**
- `classifyCommit` accepts `UNKNOWN_FRAME_VERSION` in the header's place and files it `ahead`.
  Its parameter type widened to `CommitFrameEvidence`.
- Scoped to the commit topic. An unreadable frame on the rendezvous lane is evidence of nothing
  and is still dropped.
- Healing is the safe direction: a forged unknown-version frame can only *trigger* a heal, never
  suppress one — the asymmetry the `ahead` row already accepts on a cleartext epoch.

**Both payload formats gained a version byte.** `encodeCommitFrame` is now `[ VERSION(1) |
commitLength(4, LE) | commit | sealed blob ]`, closing the worst failure mode in the package: a
later frame with a third section decoded v1 *successfully*, its new section silently swallowed into
`sealedEntries`. `encodeLedgerEntries` is now `[ VERSION(1) | count(2, LE) | ... ]`; unversioned it
degraded tolerably only by accident, via the resolver's `catch`.

**The two bytes fail differently, and the difference is the whole point.** The commit frame's
version is read *before* the commit bytes are extracted, so a bump there has the same no-next-frame
problem as the handshake header — it therefore takes the same route, to `classifyCommit` as
`UNKNOWN_FRAME_VERSION`, and the peer heals and strands. `decodeCommitFrame` throws
`UnsupportedCommitFrameVersionError` for exactly that case, and `isUnsupportedCommitFrameVersion`
is the boundary predicate the lane branches on; bytes that are merely not a frame (too short,
truncated) keep throwing a plain error and are still dropped silently. The ledger-entries blob's
version is the one that does *not* heal: its failure lands after the commit has been read, so the
commit files as poison and the peer reads on.

Both are wire-breaking: a v1 peer cannot read either new format, so the group must move
together.
