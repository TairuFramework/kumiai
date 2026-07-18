# SEC-1 report — DONE (amended approach)

The original brief was blocked on a false premise; the coordinator confirmed the refusal and
approved an amendment. This report covers the amendment as built.

## The premise that was wrong

The brief said an external commit's signature is "checkable with nothing but the frame itself, no
group secret and no tree". RFC 9420 §6.1 binds the full `GroupContext` into `FramedContentTBS`
whenever the sender type is `member` **or `new_member_commit`**, and ts-mls implements exactly that
(`framedContent.js`, `senderInfoEncoder` → `groupContextEncoder`; `messageProtectionPublic.js`
verifies against `state.groupContext`). Verification therefore needs the group context of the epoch
the commit was framed at, which a peer holds only for the epoch it stands at — never for one ahead
of it. `docs/superpowers/probes/sec-1-brief.md` has been corrected in place.

## What was built

`GroupHandle.readCommitHeader` now returns an external commit's `committerDID` **only** when the
commit's own self-signed signature verifies. Unverified, or unverifiable because the frame is framed
at an epoch this handle is not at, it returns `{ epoch, external: true }` with no committer — not
`null`. That puts the external path on the same terms as the member path: the epoch always, the
committer only where it authenticates.

Verification is delegated to ts-mls via `processMessage` with a callback that refuses the commit,
which runs the real verification and returns before anything is applied. Deliberately not a
reimplementation — `verifyFramedContentSignature` and `framedContentTBSEncoder` are not public
exports, and a hand-rolled TBS reconstruction could drift from what the apply path accepts. The
refusal path returns the same state object, so the read stays non-mutating.

`memory-group-mls`'s external exemption is gone. The double models the forgery the way the wire
does: `committerDID` is who the commit claims authored it, `signerDID` is whose key signed it, they
are equal in anything `encodeMemoryCommit` produces honestly, and a forger who rewrites the first
cannot change the second.

## The four cases, each asserted

1. **Forged external commit carrying the victim's DID at the victim's epoch** — signature fails, no
   committer, cannot reach `own-unmerged`, lands on poison, cursor advances, loop dead.
   (`peer-external-forgery.test.ts`, `commit-header.test.ts`)
2. **Genuine external rejoin at the reader's epoch** — verifies, committer present, applies, anchor
   still rotates. (`peer-external-forgery.test.ts`, and the pre-existing `commit-header.test.ts`
   rejoiner test, unchanged and still green)
3. **External commit framed ahead** — unverifiable, no committer, still classifies `ahead`, still
   heals. (`peer-external-forgery.test.ts`)
4. **`own-unmerged` never fires on an unauthenticated committer**, including one flagged `external`.
   (`commit-classify.test.ts`)

## Mutation check

Dropping the signature check in the port (`const authentic = external.did != null`):

     ✓ ... > returns the rejoiner as committer for an external commit 57ms
     × ... > reports NO committer for an external commit whose leaf credential was rewritten 59ms
       → expected 'did:key:z6Mkvb1aWJnKuC8ZMx8yM5xBmDdJU…' to be undefined
     × ... > reports NO committer for an external commit framed at an epoch this handle is not at 77ms
       → expected 'did:key:z6Mkfmw59nizhxfUHxCmbz8f5aSDn…' to be undefined
          Tests  2 failed | 7 passed (9)

Dropping the matching check in the double:

     × ... > a forged rejoin claiming the reader heals it at most once, and the cursor moves past it 277ms
       → expected 1 to be +0 // Object.is equality
     × ... > a forged rejoin claiming a THIRD party is not applied either 264ms
       → expected 2 to be 1 // Object.is equality
     ✓ ... > a GENUINE rejoin at the reader epoch still applies and still rotates the anchor 268ms
     ✓ ... > a genuine rejoin framed AHEAD still heals the peer it left behind 365ms
          Tests  2 failed | 2 passed (4)

The genuine-path tests stay green under both mutations, so the new tests are detecting the forgery
and not merely the presence of a check. Both mutations were inverted by hand.

## Verification

    $ pnpm run build
     Tasks:    8 successful, 8 total

    $ rtk proxy pnpm run lint
    $ biome check --write ./packages ./tests
    Checked 227 files in 264ms. No fixes applied.

    $ pnpm test
    @kumiai/mls:test:unit:       Tests  311 passed (311)
    @kumiai/rpc:test:unit:       Tests  244 passed | 1 skipped (245)
     Tasks:    30 successful, 30 total

One existing assertion changed, in `group-mls.test.ts`: a rejoiner at epoch 0 reading its own
external commit framed at epoch 2 no longer sees itself as the committer, because it holds no group
context for epoch 2. The test now also asserts that a member who IS at epoch 2 reads the committer
off the same bytes — the committer is withheld from those who cannot check it, not from the group.
Net stronger, not weaker. The `peer-recover-lane` orphaned-rejoin test that turns on this shape was
already relying on the epoch rather than the committer, and passes untouched.

## What an attacker can STILL do

Filed in full at `docs/agents/plans/next/2026-07-18-external-commit-amplification.md`.

1. **Storm the group.** One publish claiming a high epoch → every honest peer classifies `ahead` and
   heals. A bare `PrivateMessage` with a rewritten cleartext epoch is sufficient: no key, no
   signature, no external commit. `ahead` is settled on the epoch before any committer is consulted,
   and no authentication can close it — a peer that has fallen behind holds nothing to check the
   group's future with. Belongs to whoever gates publish authorization on the commit topic.
2. **Replay a genuine external commit.** A signature proves possession of a key, not authorization,
   and is a property of the bytes rather than their delivery: captured genuine bytes re-published by
   the hub verify exactly as they did the first time. Whether a replayed rejoin can still steer
   anything after the group has moved on was **not established** — stated as open rather than
   guessed at.
3. Neither is in scope here, and neither is closable in `classify.ts` or `readCommitHeader`.
