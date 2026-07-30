# Applied-Commit Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** planning
**Mode:** tasks
**Branch:** `fix/applied-commit-digest`
**Spec:** `docs/superpowers/specs/2026-07-30-applied-commit-digest-design.md`

**Goal:** Make the commit lane's `fork` row check what its doc claims — two different *commits* at one
epoch — by recording a digest of the applied commit beside its log position, so a byte-for-byte
replay reads `history` in any order the hub serves the log.

**Architecture:** `appliedByEpoch` in `packages/rpc/src/peer.ts` currently maps epoch to a
sequenceID, and `classifyCommit` in `packages/rpc/src/classify.ts` settles the fork row by comparing
positions. The map's value becomes a record holding both the sequenceID and a sha256 digest of the
applied commit's bytes; `classifyCommit` takes the incoming frame's digest and returns `history` when
it matches, falling through to today's position-based winner/loser tiebreak only when the commits
genuinely differ. Five write sites in `peer.ts` supply the digest. Nothing in the MLS port changes.

**Tech Stack:** TypeScript, vitest, `@noble/hashes/sha2.js` (`sha256`), `@sozai/codec` (`toB64U`).
Both are already direct dependencies of `@kumiai/rpc`.

## Global Constraints

- pnpm only. Never edit `lib/` (generated).
- Run package tests directly, never through turbo — turbo reports cached results. Use
  `pnpm --filter @kumiai/rpc exec vitest run <path>`.
- vitest strips types, so a green vitest run proves nothing about types. Every vitest step is paired
  with `pnpm --filter @kumiai/rpc exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`.
- Lint via `rtk proxy pnpm run lint` — a shim intercepts both `pnpm run lint` and `pnpm exec biome`
  and reports a fake pass otherwise.
- The digest is over the **commit bytes alone**, never the surrounding frame. A legal re-seal of the
  entry blob must not change it.
- `appliedByEpoch` stays in memory. Do not add persistence.
- No change to `GroupMLS`, `CommitHeader`, or either conformance suite.
- Do not add an ordering check to `walkCommits`. Deliberately out of scope — see the spec's "What
  this does not change".

---

### Task 1: The classifier keys on the commit, not the position

Atomic by necessity: `CommitClassifierState.appliedByEpoch` changes shape, so `classify.ts`,
`peer.ts`, and every test that builds the map move together or the package does not typecheck.

**Files:**
- Modify: `packages/rpc/src/classify.ts`
- Modify: `packages/rpc/src/peer.ts`
- Modify: `packages/rpc/src/index.ts:9-15`
- Modify: `packages/rpc/test/fixtures/commits.ts`
- Test: `packages/rpc/test/peer-commit-log-replay.test.ts`
- Test: `packages/rpc/test/commit-classify.test.ts`
- Test: `packages/rpc/test/peer-recover-lane.test.ts:344-349`

**Interfaces:**
- Produces:
  - `export type AppliedCommit = { sequenceID: string; digest: string }` (`classify.ts`)
  - `export function digestAppliedCommit(commit: Uint8Array): string` (`classify.ts`)
  - `classifyCommit(header: CommitFrameEvidence, sequenceID: string, commitDigest: string | null, state: CommitClassifierState): CommitDisposition`
  - `CommitClassifierState.appliedByEpoch: ReadonlyMap<number, AppliedCommit>`
  - `export function publishedCommitDigest(hub: { published: Array<{ sequenceID: string; payload: Uint8Array }> }, sequenceID: string): string` (`test/fixtures/commits.ts`)

The red phase comes first and touches only the test file: the new test asserts observable behaviour
only, so it compiles and runs against the current signature. The direct verdict assertion and the
fixture helper it needs arrive later, once the new API exists.

- [ ] **Step 1: Write the failing behavioural test**

Add to `packages/rpc/test/peer-commit-log-replay.test.ts`, inside the existing
`describe('a genuine external commit re-published by the hub steers nothing', ...)` block, after the
last test. Deliberately **no** direct `classifyCommit` assertion yet — that arrives in Step 12, once
the new signature exists. The observable assertions are what must go red now.

```ts
  test('a replay served BEFORE the original is not a fork the original loses', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x83)

    // Both copies land before Alice exists, so the order she is SERVED them is the hub's choice
    // alone — which is the whole point. The hub-conformance floor bounds where a replay's
    // sequenceID lands; it says nothing about the order a reader is handed the log.
    const { sequenceID: original } = await publishCommit({
      hub,
      senderDID: 'bob',
      recoverySecret: rs,
      epoch: 1,
      committerDID: 'bob',
      external: true,
    })
    const replayed = await replayCommitFrame(hub, rs, original)
    expect(replayed > original).toBe(true)

    // The hub withholds the original and shows Alice the replay first.
    hub.hideFrom('alice', original)
    const alice = makeMLSPeer(hub, 'alice', rs, {
      epoch: 1,
      members: ['alice', 'bob'],
      recovery,
    })
    await flush(200)

    // She applied the replay — it is a genuine commit at her epoch, and nothing about it says
    // otherwise. Her record for epoch 1 now names the replay's position, not the original's.
    expect(alice.mls.epoch()).toBe(2)
    expect(alice.mls.commits()).toBe(1)
    const anchorAfterApply = alice.peer.anchorEpoch()
    const seenAfterApply = alice.mls.seen()
    expect(recoveryRequests(hub, rs)).toHaveLength(0)

    // Now the original arrives, below her cursor and below the position she recorded.
    hub.revealTo('alice', original)
    await wakeLane(hub, rs)
    await flush(300)

    // The same commit she already enacted, so: history. Comparing POSITIONS instead reads
    // `fork`/`losing` (the original carries the lower sequenceID), which heals the peer, rejoins
    // it with an external commit, and rotates the app-lane anchor for every member — one
    // group-wide storm per replay, for bytes the group already delivered once.
    expect(recoveryRequests(hub, rs)).toHaveLength(0)
    expect(alice.peer.anchorEpoch()).toBe(anchorAfterApply)
    expect(alice.mls.epoch()).toBe(2)
    expect(alice.mls.commits()).toBe(1)
    expect(alice.mls.seen()).toBe(seenAfterApply)

    await alice.peer.dispose()
  })
```

- [ ] **Step 2: Run it and confirm it fails for the stated reason**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/peer-commit-log-replay.test.ts -t 'served BEFORE'`

Expected: FAIL. The `expect(recoveryRequests(hub, rs)).toHaveLength(0)` after `revealTo` receives a
non-empty array, and/or `anchorEpoch()` has moved.

**STOP RULE.** If it PASSES, the premise is wrong and the finding must be re-derived — do not adjust
the test to make it red. Report and halt. Two things to check before concluding either way: that
`replayed > original` held, and that Alice really applied the replay (`commits()` is 1 before
`revealTo`). If Alice never applied anything, the fixture is broken, not the premise.

- [ ] **Step 3: Add the record type and the digest helper**

In `packages/rpc/src/classify.ts`, above the existing `import type { CommitHeader } from './crypto.js'`:

```ts
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'

import type { CommitHeader } from './crypto.js'
```

Then add, immediately above `export type CommitClassifierState`:

```ts
/**
 * What this peer enacted at one epoch: the commit itself, by digest, and where the log carried it.
 *
 * The digest is what the `fork` row actually asks about — "two different commits at one epoch" —
 * and the position is only the tiebreak between two that genuinely differ. One record rather than
 * two maps, deliberately: a position recorded without its digest re-opens the replay this closes,
 * and a type that cannot express one without the other cannot drift.
 */
export type AppliedCommit = {
  /** The sequenceID the log carried this commit at when this peer enacted it. */
  sequenceID: string
  /** {@link digestAppliedCommit} over the commit's own bytes. */
  digest: string
}

/**
 * Identify a commit by its own bytes, for {@link AppliedCommit.digest}.
 *
 * Over the COMMIT alone, never the frame around it: the sealed entry blob riding a commit frame is
 * derived, and re-sealing it is legal, so a frame-wide digest would make a legitimate re-seal look
 * like a different commit and fork the group on it.
 *
 * Not a security boundary. This is a peer recognising bytes it already applied, and the only way to
 * abuse a collision is a different Commit that MLS accepts at the same epoch — a far stronger break
 * than the hash.
 */
export function digestAppliedCommit(commit: Uint8Array): string {
  return toB64U(sha256(commit))
}
```

- [ ] **Step 4: Change the state shape, the signature, and the branch**

In `packages/rpc/src/classify.ts`, replace the `appliedByEpoch` field of `CommitClassifierState`
(currently `appliedByEpoch: ReadonlyMap<number, string>` with the doc comment above it) with:

```ts
  /**
   * The commit this peer enacted at each epoch it has passed — by digest, with the sequenceID the
   * log carried it at. The digest is the fork test; the sequenceID is only the tiebreak between two
   * commits that genuinely differ.
   *
   * In memory, DELIBERATELY. A restarted peer holds none and reads history as history: it can
   * MISS a fork but can never invent one — the safe direction, since a missed fork is
   * re-detected by the trim (`ahead` triggers on the next published frame), while inventing
   * forks would turn every late joiner/rejoiner/re-seeded peer into a recovery storm on first
   * pull. Durability needs a store; not built, since fork RESOLUTION isn't built either.
   */
  appliedByEpoch: ReadonlyMap<number, AppliedCommit>
```

Change the signature to:

```ts
export function classifyCommit(
  header: CommitFrameEvidence,
  sequenceID: string,
  commitDigest: string | null,
  state: CommitClassifierState,
): CommitDisposition {
```

and extend its doc comment with:

```
 * `commitDigest` is {@link digestAppliedCommit} over this frame's commit bytes, or `null` where
 * they were never extracted — which today is only the {@link UNKNOWN_FRAME_VERSION} calls, settled
 * at `ahead` before it is read.
```

Replace the `header.epoch < state.epoch` branch body with:

```ts
  if (header.epoch < state.epoch) {
    const applied = state.appliedByEpoch.get(header.epoch)
    // No record for that epoch -> history, not fork: a late joiner/rejoiner/re-seeded peer
    // walks epochs it never passed, and would falsely diagnose a fork on first pull otherwise.
    if (applied == null) return { row: 'history' }
    // The commit this peer already enacted here, served AGAIN. History, wherever the log now
    // carries it. Comparing positions instead made "a different commit" mean "a different
    // sequenceID", which a verbatim replay satisfies: nothing enforces that a reader is served
    // the log in sequenceID order, so a hub that shows the replay first and the original after
    // makes a peer read its OWN applied commit as the losing branch and heal the whole group
    // off it — one rejoin and one anchor rotation per replay.
    if (commitDigest != null && commitDigest === applied.digest) return { row: 'history' }
    // No digest to compare against. Unreachable today (the only null-digest calls pass
    // UNKNOWN_FRAME_VERSION, settled at `ahead` above); the position comparison is kept so the
    // function stays total rather than falling through to `fork` on a frame it cannot judge.
    if (commitDigest == null && sequenceID === applied.sequenceID) return { row: 'history' }
    return {
      row: 'fork',
      appliedSequenceID: applied.sequenceID,
      branch: sequenceID < applied.sequenceID ? 'losing' : 'winning',
    }
  }
```

Update three docs in the same file so they stop describing the old behaviour:

1. The `CommitDisposition` row table (around lines 13-17). Replace these three rows:

```
 * | Below this peer's epoch, with no recorded applied-commit | advance, no fork check, no unwrap attempt |
 * | Below this peer's epoch, with a record naming a different sequenceID | advance; the fork trigger |
```
```
 * | At this peer's current epoch, committed by another — handed to the port | applied: advance and record this epoch -> sequenceID for the fork check; refused by policy or entries unresolvable: advance (poison — never retry, never heal) |
```

with:

```
 * | Below this peer's epoch, with no record — or a record naming THIS SAME commit | advance, no fork check, no unwrap attempt |
 * | Below this peer's epoch, with a record naming a DIFFERENT commit | advance; the fork trigger |
```
```
 * | At this peer's current epoch, committed by another — handed to the port | applied: advance and record this epoch -> the applied commit (digest and position) for the fork check; refused by policy or entries unresolvable: advance (poison — never retry, never heal) |
```

The table still has eight rows: the same-commit case folds into `history` rather than adding one,
because the cursor treatment is identical — the precedent the `poison` row's doc states outright.

2. The `history` row's doc. Append a second paragraph:

```
 * Also the commit this peer ALREADY ENACTED at that epoch, re-served at another position. The
 * same commit is not a fork however the log came to carry it twice, and recognising it by its
 * bytes rather than by where it sits is what makes that true in any order the hub serves.
```

3. The `fork` row's doc. Replace `Reached on the epoch alone and settled on sequenceIDs, which are
the hub's own chaining, not the commit's word — the committer is neither read nor available.` with:

```
 * Reached on the epoch alone and settled on the COMMITS: two records of the same bytes are the
 * same commit, at any position. Only once they genuinely differ do sequenceIDs decide which side
 * stands — the hub's own chaining, not the commit's word, and the committer is neither read nor
 * available here.
```

- [ ] **Step 5: Update the classifier's unit tests, including the new cases**

In `packages/rpc/test/commit-classify.test.ts`, extend the import and replace the `bob` fixture:

```ts
import {
  type CommitClassifierState,
  classifyCommit,
  digestAppliedCommit,
  UNKNOWN_FRAME_VERSION,
} from '../src/classify.js'

/** The two commits Bob enacted, and one he never saw — distinct bytes, so distinct digests. */
const s3Commit = new Uint8Array([3, 3, 3])
const s4Commit = new Uint8Array([4, 4, 4])
const otherCommit = new Uint8Array([7, 7, 7])

/** A peer at epoch 5, which enacted commit `s3` at epoch 3 and `s4` at epoch 4. */
function bob(overrides: Partial<CommitClassifierState> = {}): CommitClassifierState {
  return {
    localDID: 'bob',
    epoch: 5,
    appliedByEpoch: new Map([
      [3, { sequenceID: 's3', digest: digestAppliedCommit(s3Commit) }],
      [4, { sequenceID: 's4', digest: digestAppliedCommit(s4Commit) }],
    ]),
    ...overrides,
  }
}
```

Then add the third argument to all 31 `classifyCommit(...)` calls in the file. It is mechanical
except in the four places that reach the below-epoch branch:

- `'a second, different commit at an epoch this peer enacted is a fork'` — pass
  `digestAppliedCommit(otherCommit)` in both calls. Verdicts unchanged.
- `'the SAME commit at an epoch this peer enacted is not a fork'` — pass
  `digestAppliedCommit(s3Commit)`. Verdict unchanged (`history`), and the test's name is accurate
  for the first time.
- `'the fork check runs on the epoch and the sequenceID, and never on the committer'` — pass
  `digestAppliedCommit(otherCommit)` in both calls. Rename to `'the fork check runs on the epoch and
  the commit, and never on the committer'` and change "It settles on this peer's own applied-commit
  record and the hub's chaining" to "It settles on this peer's own applied-commit record — the
  commit's bytes, with the hub's chaining as the tiebreak".
- `"a peer's own commit at an epoch it enacted a DIFFERENT commit at"` (around line 184) — pass
  `digestAppliedCommit(otherCommit)`. Verdict unchanged.

Everywhere else pass `null`: those calls settle at `ahead`, `poison`, `apply`, `own-unmerged`, or
`history` with no record, none of which reads the digest.

Then add the new cases, after the `'the SAME commit ... is not a fork'` test:

```ts
  test('the same commit re-served at ANOTHER position is history, above or below the original', () => {
    // A capture-and-replay: the hub re-publishes a frame verbatim under a fresh publishID, so the
    // same bytes land at a new sequenceID. Nothing enforces the order a reader is served, so both
    // directions have to be history — the LOWER one is the case that used to heal the group.
    const replay = digestAppliedCommit(s3Commit)
    expect(classifyCommit({ epoch: 3, committerDID: 'alice' }, 's7', replay, bob())).toEqual({
      row: 'history',
    })
    expect(classifyCommit({ epoch: 3, committerDID: 'alice' }, 's1', replay, bob())).toEqual({
      row: 'history',
    })
  })

  test('a genuinely different commit still forks, at a position either side of the record', () => {
    // The row the digest check must not delete. Different bytes at one epoch is the thing the hub
    // can only produce by serving different logs to different members, and it still heals.
    const other = digestAppliedCommit(otherCommit)
    expect(classifyCommit({ epoch: 3, committerDID: 'alice' }, 's7', other, bob())).toEqual({
      row: 'fork',
      appliedSequenceID: 's3',
      branch: 'winning',
    })
    expect(classifyCommit({ epoch: 3, committerDID: 'alice' }, 's1', other, bob())).toEqual({
      row: 'fork',
      appliedSequenceID: 's3',
      branch: 'losing',
    })
  })

  test('with no digest to compare, the position decides — the classifier stays total', () => {
    // Unreachable through the lane: the only null-digest calls pass UNKNOWN_FRAME_VERSION, which
    // settles at `ahead` before the epoch comparison. Pinned so the fallback cannot rot into
    // "every undigested frame is a fork".
    expect(classifyCommit({ epoch: 3, committerDID: 'alice' }, 's3', null, bob())).toEqual({
      row: 'history',
    })
    expect(classifyCommit({ epoch: 3, committerDID: 'alice' }, 's7', null, bob())).toEqual({
      row: 'fork',
      appliedSequenceID: 's3',
      branch: 'winning',
    })
  })
```

- [ ] **Step 6: Run the classifier unit tests**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/commit-classify.test.ts`
Expected: PASS, 23 tests (20 before, plus the three added above).

- [ ] **Step 7: Update the export surface**

In `packages/rpc/src/index.ts`, replace the `./classify.js` export block with:

```ts
export {
  type AppliedCommit,
  type CommitClassifierState,
  type CommitDisposition,
  type CommitFrameEvidence,
  classifyCommit,
  digestAppliedCommit,
  UNKNOWN_FRAME_VERSION,
} from './classify.js'
```

`AppliedCommit` must be exported because `CommitClassifierState` now references it.

- [ ] **Step 8: Update the declaration and the three classifier calls in `peer.ts`**

Extend the existing import at `packages/rpc/src/peer.ts:22`:

```ts
import { type AppliedCommit, classifyCommit, digestAppliedCommit, UNKNOWN_FRAME_VERSION } from './classify.js'
```

At `peer.ts:740`, change the declaration and the last paragraph of its doc:

```ts
  /**
   * The commit this peer ENACTED at each epoch it passed — applied from the log, or committed
   * and adopted — by digest, with the sequenceID the log carried it at. The whole of the fork
   * check: a second, DIFFERENT commit at an epoch this peer holds a record for is two commits at
   * one epoch, which the hub can only produce by showing different logs to different members. The
   * same commit re-served at a new position is not, however the log came to carry it twice.
   *
   * An epoch with NO record is history, not a fork — a late joiner, rejoiner or re-seeded peer all
   * walk commits from epochs they never held. In memory, deliberately: a restart drops the record,
   * so a peer with no record reads history as history — it can MISS a fork, never invent one.
   */
  const appliedByEpoch = new Map<number, AppliedCommit>()
```

In `walkCommits`, the two `classifyCommit(UNKNOWN_FRAME_VERSION, position, {` calls (around
`peer.ts:1120` and `peer.ts:1149`) become `classifyCommit(UNKNOWN_FRAME_VERSION, position, null, {`.
Add a short comment at the first one only:

```ts
          // No digest: the frame's version put its commit bytes out of reach entirely. Settled at
          // `ahead` before the digest is read.
```

The third call (around `peer.ts:1174`) is preceded by the `readCommitHeader` call. Change that block
to:

```ts
        // Identify the commit by its own bytes, for the fork check — the COMMIT, not the frame:
        // the sealed blob is derived and re-sealing is legal, so a frame-wide digest would fork
        // the group on a legitimate re-seal.
        const commitDigest = digestAppliedCommit(commitFrame.commit)
        // The commit's OWN epoch and committer, from the commit's own bytes. Never
        // `message.senderDID` — the hub's word about who handed it over, and the hub is not
        // trusted: it could stamp every recipient's own DID onto one poison frame and make the
        // whole group heal at once.
        const header = await port.readCommitHeader(commitFrame.commit)
        const disposition = classifyCommit(header, position, commitDigest, {
          localDID,
          epoch: crypto.epoch(),
          appliedByEpoch,
        })
```

- [ ] **Step 9: Update the five write sites**

`packages/rpc/src/peer.ts:1263` (the apply site, inside `if (applied.advanced)`):

```ts
          // The fork check's record; the only place it is written from the log.
          appliedByEpoch.set(framedEpoch, { sequenceID: position, digest: commitDigest })
```

`peer.ts:1431` (`replayJournal`, `entry.acceptedAs` present):

```ts
      appliedByEpoch.set(entry.epoch, {
        sequenceID: accepted,
        digest: digestAppliedCommit(entry.commit),
      })
```

`peer.ts:1488` (`replayJournal`, accepted on republish) — identical body, same `entry`:

```ts
    appliedByEpoch.set(entry.epoch, {
      sequenceID: accepted,
      digest: digestAppliedCommit(entry.commit),
    })
```

`peer.ts:1690` (`commit()` accepted):

```ts
        // A commit this peer made and adopted was enacted at that epoch, like an applied one —
        // without it a second commit at an epoch this peer OWNS would read as history.
        appliedByEpoch.set(framedEpoch, {
          sequenceID: accepted,
          digest: digestAppliedCommit(pending.commit),
        })
```

`peer.ts:1871` (rejoin landed) — note this one uses the raw `sequenceID`, not `accepted`:

```ts
        // Enacted at that epoch, like an applied commit: without the record a second commit at
        // that epoch reads as history rather than the fork it is.
        if (rejoinedAtEpoch != null) {
          appliedByEpoch.set(rejoinedAtEpoch, {
            sequenceID,
            digest: digestAppliedCommit(pending.commit),
          })
        }
```

Verify no site was missed:
`grep -n appliedByEpoch packages/rpc/src/peer.ts` must show exactly nine hits — the declaration
(740), three reads passed into `classifyCommit` (1121, 1150, 1174 before edits shift them), and these
five writes.

- [ ] **Step 10: Add the fixture helper that reads a published frame's commit digest**

In `packages/rpc/test/fixtures/commits.ts`, extend the existing imports — `encodeCommitFrame` already
comes from `../../src/commit-frame.js` and `encodeHandshakeFrame`/`HANDSHAKE_KIND` from
`../../src/handshake.js`, so add to those statements rather than duplicating them, and add the
classify import:

```ts
import { digestAppliedCommit } from '../../src/classify.js'
import { decodeCommitFrame, encodeCommitFrame } from '../../src/commit-frame.js'
import { decodeHandshakeFrame, encodeHandshakeFrame, HANDSHAKE_KIND } from '../../src/handshake.js'
```

Then append:

```ts
/**
 * The digest a peer's applied-commit record holds a published commit by, read back off the wire.
 *
 * Unwraps both layers the lane unwraps — handshake frame, then commit frame — because the record is
 * keyed on the COMMIT's bytes, not the frame's: the sealed entry blob riding a frame is derived and
 * re-sealing it is legal.
 */
export function publishedCommitDigest(
  hub: { published: Array<{ sequenceID: string; payload: Uint8Array }> },
  sequenceID: string,
): string {
  const message = hub.published.find((m) => m.sequenceID === sequenceID)
  if (message == null) throw new Error(`no published frame at ${sequenceID}`)
  const commitFrame = decodeCommitFrame(decodeHandshakeFrame(message.payload).payload)
  return digestAppliedCommit(commitFrame.commit)
}
```

- [ ] **Step 11: Update the two remaining test call sites that build the map**

`packages/rpc/test/peer-recover-lane.test.ts`, around line 344. Add `publishedCommitDigest` to the
existing `./fixtures/commits.js` import, then:

```ts
    expect(
      classifyCommit(
        { epoch: 1, committerDID: 'yolanda' },
        loserSeq,
        publishedCommitDigest(hub, loserSeq),
        {
          localDID: 'carol',
          epoch: 2,
          appliedByEpoch: new Map([
            [1, { sequenceID: winnerSeq, digest: publishedCommitDigest(hub, winnerSeq) }],
          ]),
        },
      ),
    ).toEqual({ row: 'fork', appliedSequenceID: winnerSeq, branch: 'winning' })
```

The verdict is unchanged: the winner and loser are genuinely different commits, so the digests
differ and the sequenceID tiebreak still decides.

`packages/rpc/test/peer-commit-log-replay.test.ts`, the existing in-order test around line 120. This
one's **verdict changes**, which is the point of the work. Add `publishedCommitDigest` to the
`./fixtures/commits.js` import and replace the assertion and its comment with:

```ts
    // THE VERDICT, directly — `history` is observationally identical from outside the lane to the
    // `fork`/`winning` this used to read (both step over the frame, move the head, heal nothing),
    // so every assertion above holds either way. This pins that Alice recognised the replay as the
    // commit she already enacted, rather than as a fork she happened to be on the winning side of.
    expect(
      classifyCommit(
        { epoch: 1, committerDID: 'bob' },
        replayed,
        publishedCommitDigest(hub, replayed),
        {
          localDID: 'alice',
          epoch: alice.mls.epoch(),
          appliedByEpoch: new Map([
            [1, { sequenceID: original, digest: publishedCommitDigest(hub, original) }],
          ]),
        },
      ),
    ).toEqual({ row: 'history' })
```

- [ ] **Step 12: Add the direct verdict assertion to the new test**

In the Step 1 test, immediately before `await alice.peer.dispose()`:

```ts
    // THE VERDICT, directly. Every assertion above is an absence, and a peer that simply never
    // reached the frame would satisfy all of them; this asks the classifier about the scenario's
    // own two frames at the positions the hub gave them.
    expect(
      classifyCommit(
        { epoch: 1, committerDID: 'bob' },
        original,
        publishedCommitDigest(hub, original),
        {
          localDID: 'alice',
          epoch: alice.mls.epoch(),
          appliedByEpoch: new Map([
            [1, { sequenceID: replayed, digest: publishedCommitDigest(hub, replayed) }],
          ]),
        },
      ),
    ).toEqual({ row: 'history' })
```

`classifyCommit` and `publishedCommitDigest` are already imported in this file by Step 11.

- [ ] **Step 13: Run the whole rpc suite and the typecheck**

Run: `pnpm --filter @kumiai/rpc exec vitest run`
Expected: PASS, all files. The Step 1 test now passes.

Run: `pnpm --filter @kumiai/rpc exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: no output.

If any *other* test fails, do not adjust its assertions before understanding why — a behaviour
change outside `peer-commit-log-replay.test.ts` is a finding, not a fixture to update.

- [ ] **Step 14: Lint and commit**

Run: `rtk proxy pnpm run lint`
Expected: no diagnostics. (A plain `pnpm run lint` or `pnpm exec biome` is intercepted by a shim and
reports a fake pass — the `rtk proxy` prefix is required.)

```bash
git add packages/rpc/src/classify.ts packages/rpc/src/peer.ts packages/rpc/src/index.ts \
  packages/rpc/test/fixtures/commits.ts packages/rpc/test/commit-classify.test.ts \
  packages/rpc/test/peer-commit-log-replay.test.ts packages/rpc/test/peer-recover-lane.test.ts
git commit -m "fix(rpc): key the fork check on the applied commit, not only its position"
```

---

### Task 2: Prove the fork row survived, and that both guards bite

Task 1 could be satisfied by deleting the fork row entirely. This task pins that it still fires on
the case it exists for, and confirms each new guard actually holds its test up.

**Files:**
- Test: `packages/rpc/test/peer-commit-log-replay.test.ts`

**Interfaces:**
- Consumes: `publishedCommitDigest` from `test/fixtures/commits.js`, `digestAppliedCommit` from
  `src/classify.js`, both established in Task 1.

- [ ] **Step 1: Write the genuine-fork companion test**

Add to `packages/rpc/test/peer-commit-log-replay.test.ts`, after the Task 1 test. Same hidden-then-
revealed service order, two genuinely different commits.

Note the polling wait rather than a fixed flush: this test EXPECTS a heal, and a fixed sleep makes
it flaky on a slow machine. The no-heal tests keep their bounded `flush`, which is the correct shape
for asserting an absence.

```ts
  test('two DIFFERENT commits at one epoch still fork, served in the same order', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x84)

    // Bob's and Yolanda's commits, both framed at epoch 1: the hub accepted two, which it can only
    // do by breaking its own compare-and-set. Bob's lands first, so it carries the lower
    // sequenceID and is the branch that stands.
    const { sequenceID: loserSeq } = await publishCommit({
      hub,
      senderDID: 'bob',
      recoverySecret: rs,
      epoch: 1,
      committerDID: 'bob',
      external: true,
    })
    const { sequenceID: winnerSeq } = await publishCommit({
      hub,
      senderDID: 'yolanda',
      recoverySecret: rs,
      epoch: 1,
      committerDID: 'yolanda',
      external: true,
    })
    expect(winnerSeq > loserSeq).toBe(true)
    // Different commits, so different digests — the premise the fork check now rests on.
    expect(publishedCommitDigest(hub, winnerSeq)).not.toBe(publishedCommitDigest(hub, loserSeq))

    // Alice is shown Yolanda's first and applies it, exactly as in the replay test.
    hub.hideFrom('alice', loserSeq)
    const alice = makeMLSPeer(hub, 'alice', rs, {
      epoch: 1,
      members: ['alice', 'bob'],
      recovery,
    })
    await flush(200)
    expect(alice.mls.epoch()).toBe(2)
    expect(recoveryRequests(hub, rs)).toHaveLength(0)

    // Bob's arrives below her cursor. Different bytes at an epoch she holds a record for: a fork,
    // and she is on the losing side, so she heals. Polled, not slept on — a fixed wait for
    // something that must HAPPEN is the flaky shape.
    hub.revealTo('alice', loserSeq)
    await wakeLane(hub, rs)
    for (let i = 0; i < 40 && recoveryRequests(hub, rs).length === 0; i++) await flush(25)
    expect(recoveryRequests(hub, rs).length).toBeGreaterThan(0)

    // And the verdict, directly.
    expect(
      classifyCommit(
        { epoch: 1, committerDID: 'bob' },
        loserSeq,
        publishedCommitDigest(hub, loserSeq),
        {
          localDID: 'alice',
          epoch: 2,
          appliedByEpoch: new Map([
            [1, { sequenceID: winnerSeq, digest: publishedCommitDigest(hub, winnerSeq) }],
          ]),
        },
      ),
    ).toEqual({ row: 'fork', appliedSequenceID: winnerSeq, branch: 'losing' })

    await alice.peer.dispose()
  })
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/peer-commit-log-replay.test.ts`
Expected: PASS, all tests in the file.

If the fork test fails because `winnerSeq > loserSeq` is false, the `FakeHub` does not mint
ascending sequenceIDs in publish order — swap the two names rather than the publish order, and say
so in the report.

- [ ] **Step 3: Mutation check — break the digest guard, confirm the replay test fails**

In `packages/rpc/src/classify.ts`, temporarily change the digest comparison so it never matches:

```ts
    if (false && commitDigest != null && commitDigest === applied.digest) return { row: 'history' }
```

Run: `pnpm --filter @kumiai/rpc exec vitest run test/peer-commit-log-replay.test.ts`
Expected: the two replay tests FAIL (`a replay served BEFORE the original...` on the recovery-request
assertion, and `a replay after the group moved on...` on the direct verdict). The fork test still
passes.

If they pass, the tests do not hold the guard up and must be strengthened before this task closes.

Restore the line.

- [ ] **Step 4: Mutation check — make the digest always match, confirm the fork test fails**

Temporarily insert a line that makes every record match, immediately after the `applied == null`
guard:

```ts
    if (applied != null) return { row: 'history' }
```

Run: `pnpm --filter @kumiai/rpc exec vitest run test/peer-commit-log-replay.test.ts test/commit-classify.test.ts`
Expected: FAIL — `two DIFFERENT commits at one epoch still fork` (no recovery request, wrong verdict)
and the classifier's `a genuinely different commit still forks` case.

Restore the line.

- [ ] **Step 5: Confirm the source is back to its committed state**

Run: `git diff packages/rpc/src/classify.ts`
Expected: empty. Both mutations reverted.

- [ ] **Step 6: Run the full suite, typecheck, lint, and commit**

Run: `pnpm --filter @kumiai/rpc exec vitest run`
Run: `pnpm --filter @kumiai/rpc exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Run: `rtk proxy pnpm run lint`
Expected: all clean.

```bash
git add packages/rpc/test/peer-commit-log-replay.test.ts
git commit -m "test(rpc): a genuine fork survives the digest check, in any service order"
```

---

### Task 3: Changeset

**Files:**
- Create: `.changeset/applied-commit-digest.md`

- [ ] **Step 1: Write the changeset**

`classifyCommit` gains a parameter and `CommitClassifierState.appliedByEpoch` changes shape; both are
exported from `packages/rpc/src/index.ts`. `minor`, matching the repo's pre-1.0 convention for a
breaking change to an exported type (see `.changeset/add-proposal-roster-binding.md`).

```markdown
---
'@kumiai/rpc': minor
---

The commit lane's `fork` row now checks what its doc claims — two different *commits* at one epoch,
not two different sequenceIDs. `appliedByEpoch` records a digest of the applied commit's bytes
beside its log position, and `classifyCommit` takes the incoming frame's digest and answers
`history` when it matches.

Previously "a different commit" was proxied by "a different sequenceID", and the proxy only held
while a reader was served the log in sequenceID order — which nothing enforces. A hub that
re-published a genuine commit frame verbatim and served the copy first (or withheld the original
until the cursor had passed) made the peer apply the replay, record it as the commit for that epoch,
then read the original as the LOSING side of a fork: a heal, a rejoin, an external commit in the
log, and an app-lane anchor rotation for every member — once per replay, for bytes the group had
already delivered once.

Genuinely different commits at one epoch still fork and still heal, and the winner is still the
lower sequenceID. `appliedByEpoch` remains in memory, so a restarted peer holding no record still
reads history as history: it can miss a fork, never invent one.

This is not a defence against a hub that reorders or withholds in general — it removes the replay
route and fixes a classification that did not do what it said.

Breaking, for anyone calling the classifier directly: `classifyCommit` takes the frame's commit
digest as a third argument (`digestAppliedCommit(commit)`, or `null` where the bytes were never
extracted), and `CommitClassifierState.appliedByEpoch` is now
`ReadonlyMap<number, AppliedCommit>`. Both `AppliedCommit` and `digestAppliedCommit` are exported.
```

- [ ] **Step 2: Commit**

```bash
git add .changeset/applied-commit-digest.md
git commit -m "chore: changeset for the applied-commit digest"
```

---

## Done when

- `pnpm --filter @kumiai/rpc exec vitest run` is green with no cached results.
- `pnpm --filter @kumiai/rpc exec tsc --noEmit --skipLibCheck -p tsconfig.test.json` is clean.
- `rtk proxy pnpm run lint` is clean.
- Both mutation checks in Task 2 were observed to fail and the source restored.
- Neither conformance suite was touched.
