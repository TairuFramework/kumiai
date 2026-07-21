import { describe, expect, test } from 'vitest'

import {
  type CommitClassifierState,
  classifyCommit,
  UNKNOWN_FRAME_VERSION,
} from '../src/classify.js'

/** A peer at epoch 5, which enacted commit `s3` at epoch 3 and `s4` at epoch 4. */
function bob(overrides: Partial<CommitClassifierState> = {}): CommitClassifierState {
  return {
    localDID: 'bob',
    epoch: 5,
    appliedByEpoch: new Map([
      [3, 's3'],
      [4, 's4'],
    ]),
    ...overrides,
  }
}

describe('the cursor table', () => {
  test('a frame at this peer’s epoch, from another member, is handed to the port', () => {
    expect(classifyCommit({ epoch: 5, committerDID: 'alice' }, 's9', bob())).toEqual({
      row: 'apply',
    })
  })

  test('a frame from an epoch BELOW this peer’s, that it holds no record for, is history', () => {
    // Pre-join, pre-rejoin, re-seeded: every healthy peer reads some. It is neither a fork
    // nor poison, and it is never handed to the port, so its blob is never touched.
    expect(classifyCommit({ epoch: 1, committerDID: 'alice' }, 's1', bob())).toEqual({
      row: 'history',
    })
  })

  test('a frame from an epoch AHEAD of this peer’s is proof the group moved on without it', () => {
    // An accepted commit is the only thing that advances an epoch, and a peer walking the log
    // applies each frame at its own epoch and rises with it. So a frame ahead of this peer
    // means the group advanced at an epoch where this peer did not: it was trimmed out, or it
    // failed to apply a frame everybody else applied. Both are the same condition, and both
    // have the same repair.
    expect(classifyCommit({ epoch: 6, committerDID: 'alice' }, 's9', bob())).toEqual({
      row: 'ahead',
    })
  })

  test('a second, different commit at an epoch this peer enacted is a fork', () => {
    // The hub accepted two commits at one epoch, which it can only do by serving different
    // logs to different members.
    expect(classifyCommit({ epoch: 3, committerDID: 'alice' }, 's7', bob())).toEqual({
      row: 'fork',
      appliedSequenceID: 's3',
      // This peer's own branch carries the LOWER sequenceID, so it is the one that stands.
      branch: 'winning',
    })
    // And the peer whose branch carries the higher one rejoins onto the other. Both sides
    // reach the same verdict from the same two frames, with nobody to arbitrate.
    expect(classifyCommit({ epoch: 3, committerDID: 'alice' }, 's1', bob())).toEqual({
      row: 'fork',
      appliedSequenceID: 's3',
      branch: 'losing',
    })
  })

  test('the SAME commit at an epoch this peer enacted is not a fork', () => {
    expect(classifyCommit({ epoch: 3, committerDID: 'alice' }, 's3', bob())).toEqual({
      row: 'history',
    })
  })

  test("this peer's own commit, at the epoch it is still at, heals", () => {
    // The crash-window victim: the hub took its commit, the group advanced on it, and the
    // pending state died with the process. MLS merges a pending commit rather than
    // processing one, so this frame can never be applied by the member that wrote it.
    expect(classifyCommit({ epoch: 5, committerDID: 'bob' }, 's9', bob())).toEqual({
      row: 'own-unmerged',
    })
  })

  test('bytes that are not a commit are poison', () => {
    expect(classifyCommit(null, 's9', bob())).toEqual({ row: 'poison' })
  })

  test('a frame in a wire version this build cannot read is AHEAD, and not poison', () => {
    // The distinction the two assertions make together: `null` is "readable bytes that are not a
    // commit" and is poison; this is "the group is speaking a language I do not have" and is
    // proof it moved without this peer. Filing it as poison is the silent killer — after a
    // version bump every frame lands here, so there is no readable next frame to heal from.
    expect(classifyCommit(UNKNOWN_FRAME_VERSION, 's9', bob())).toEqual({ row: 'ahead' })
    expect(classifyCommit(UNKNOWN_FRAME_VERSION, 's9', bob())).not.toEqual({ row: 'poison' })
  })

  test('it is ahead whatever this peer’s epoch is: no epoch was readable to compare', () => {
    // Every other row turns on an epoch read out of the frame. There is none here, so the row
    // cannot be conditioned on one — and must not be, or a peer at a high epoch would file the
    // frame as poison exactly when it is furthest from the group.
    for (const epoch of [0, 1, 5, 99]) {
      expect(classifyCommit(UNKNOWN_FRAME_VERSION, 's9', bob({ epoch }))).toEqual({ row: 'ahead' })
    }
  })

  describe('the epoch is cleartext and the committer needs a key, so the rows split on which they use', () => {
    // A port can only MLS-authenticate a committer for a commit framed at the epoch whose
    // sender-data secret it holds — its own. Every other frame arrives with an epoch and no
    // committer, and that is the NORMAL shape of the frames these three rows exist for: a peer
    // that fell behind, a joiner reading history, a peer shown the branch it lost. A classifier
    // that needed a committer first would be unable to read any of them.

    test('a frame AHEAD is ahead on its epoch alone', () => {
      expect(classifyCommit({ epoch: 6 }, 's9', bob())).toEqual({ row: 'ahead' })
    })

    test('a frame BELOW is history on its epoch alone', () => {
      expect(classifyCommit({ epoch: 1 }, 's1', bob())).toEqual({ row: 'history' })
    })

    test('the fork check runs on the epoch and the sequenceID, and never on the committer', () => {
      // The fork detector is reached through the below-epoch branch, so it only ever sees frames
      // whose committer is unavailable — it MUST NOT need one. It settles on this peer's own
      // applied-commit record and the hub's chaining, and a fork that required an authenticated
      // author would be a fork detector that never fires against a real port.
      expect(classifyCommit({ epoch: 3 }, 's7', bob())).toEqual({
        row: 'fork',
        appliedSequenceID: 's3',
        branch: 'winning',
      })
      expect(classifyCommit({ epoch: 3 }, 's1', bob())).toEqual({
        row: 'fork',
        appliedSequenceID: 's3',
        branch: 'losing',
      })
    })

    test('at this peer’s OWN epoch a missing committer is poison — never own-unmerged, never apply', () => {
      // This is the one epoch where the committer IS available, so a commit here without one is
      // nothing honest. It must not soften into `own-unmerged`: that row heals, and a frame that
      // could talk its way into it would let anything that can publish heal a peer on demand —
      // or, published once, storm the whole group. Nor may it fall through to `apply`: the port
      // would be handed a frame it cannot process, and a port that throws on it leaves the
      // cursor where it is and wedges the lane on that frame forever.
      expect(classifyCommit({ epoch: 5 }, 's9', bob())).toEqual({ row: 'poison' })
    })

    test('an EXTERNAL header buys no exemption: no committer at this epoch is still poison', () => {
      // `external` is structural — wireformat and sender type, both cleartext — so it is present
      // on a frame anyone can shape, and it must not be a way into a row the committer guards.
      // An external commit whose signature did not verify arrives here as exactly this: the epoch,
      // the flag, and no author. It is poison, on the same terms as any other authorless frame at
      // this epoch, and specifically NOT `own-unmerged`, which heals and holds the cursor.
      expect(classifyCommit({ epoch: 5, external: true }, 's9', bob())).toEqual({ row: 'poison' })
      // The flag does not reach the heal row by any route, including one naming this peer — the
      // committer is what that row reads, and an unauthenticated one never gets written there.
      expect(classifyCommit({ epoch: 5, external: true }, 's9', bob())).not.toEqual({
        row: 'own-unmerged',
      })
      // A VERIFIED external commit at this epoch is unaffected: authored elsewhere, so applicable.
      expect(
        classifyCommit({ epoch: 5, committerDID: 'zoe', external: true }, 's9', bob()),
      ).toEqual({ row: 'apply' })
    })

    test('own-unmerged still requires the committer, and still only its own', () => {
      // The authenticated read, unchanged: present and equal heals, present and foreign applies.
      expect(classifyCommit({ epoch: 5, committerDID: 'bob' }, 's9', bob())).toEqual({
        row: 'own-unmerged',
      })
      expect(classifyCommit({ epoch: 5, committerDID: 'mallory' }, 's9', bob())).toEqual({
        row: 'apply',
      })
    })
  })

  describe('the rows are evaluated in the order written', () => {
    test('epoch is settled before authorship: this peer’s own commit at an epoch it has PASSED is history', () => {
      // A peer that healed and rejoined meets its own orphaned commit again, now framed at
      // an epoch behind it. Authorship matches and the epoch does not, so the heal trigger
      // stays quiet — otherwise a peer that healed once would heal forever.
      expect(classifyCommit({ epoch: 2, committerDID: 'bob' }, 's2', bob())).toEqual({
        row: 'history',
      })
      // And its own commit at an epoch it enacted a DIFFERENT commit at is a fork, not a heal.
      expect(classifyCommit({ epoch: 3, committerDID: 'bob' }, 's7', bob())).toEqual({
        row: 'fork',
        appliedSequenceID: 's3',
        branch: 'winning',
      })
    })

    test('“ahead” is settled before “history”, and a Welcome joiner still reads history as history', () => {
      // The two rows are otherwise indistinguishable — a peer holds no applied-commit record
      // for an epoch it has never REACHED any more than for one it was never PART of — and
      // "history" swallowing the ahead frame is what lets a peer walk to the end of the log
      // and report itself healthy while stuck at a dead epoch.
      const joiner: CommitClassifierState = {
        localDID: 'dave',
        epoch: 4,
        appliedByEpoch: new Map(),
      }
      // Dave was welcomed at epoch 4 and reads the log from its oldest retained frame. Every
      // frame below his epoch is history: he was not there, and it is not his to judge.
      expect(classifyCommit({ epoch: 0, committerDID: 'alice' }, 's1', joiner)).toEqual({
        row: 'history',
      })
      expect(classifyCommit({ epoch: 3, committerDID: 'alice' }, 's4', joiner)).toEqual({
        row: 'history',
      })
      // The frame at his own epoch he applies — and applying it puts him at 5, so the frame
      // at 5 is at his epoch by the time he reaches it. The log runs in non-decreasing epoch
      // order and he rises with it, which is why nothing in his arrival is ever "ahead" of
      // him. Get this wrong and every new member heals on arrival.
      expect(classifyCommit({ epoch: 4, committerDID: 'alice' }, 's5', joiner)).toEqual({
        row: 'apply',
      })
      const risen: CommitClassifierState = { ...joiner, epoch: 5 }
      expect(classifyCommit({ epoch: 5, committerDID: 'alice' }, 's6', risen)).toEqual({
        row: 'apply',
      })
    })

    test('history is settled before the fork check: no record for that epoch is not a fork', () => {
      // "A commit at an epoch I have already passed" is NOT the fork test, and using it
      // would send every late joiner, rejoiner and re-seeded peer into recovery on its
      // first pull — the frames they walk are from epochs they never held.
      const joiner = bob({ appliedByEpoch: new Map() })
      expect(classifyCommit({ epoch: 3, committerDID: 'alice' }, 's3', joiner)).toEqual({
        row: 'history',
      })
    })

    test('authorship is settled before applicability: a frame this peer will refuse is still handed to the port', () => {
      // The discriminator for a heal is who WROTE the commit, not whether this peer can
      // apply it. "A frame at my current epoch that I cannot apply" describes every frame a
      // peer fails to apply — the frame you are about to apply is always at your current
      // epoch — and it would route a removed member's refused commit into a heal. This
      // classification is reached without the port being asked anything at all, so it cannot
      // depend on the answer.
      expect(classifyCommit({ epoch: 5, committerDID: 'mallory' }, 's9', bob())).toEqual({
        row: 'apply',
      })
    })

    test('the committer is the only identity the table reads, and it comes from the commit', () => {
      // There is no transport sender in this function's inputs, and that is the design: the
      // frame's `senderDID` is the hub's word about who handed the frame over, and the hub is
      // not trusted. A hub that could name the committer could stamp each recipient's own DID
      // onto one poison frame and heal the entire group at once.
      const own = classifyCommit({ epoch: 5, committerDID: 'bob' }, 's9', bob())
      const foreign = classifyCommit({ epoch: 5, committerDID: 'mallory' }, 's9', bob())
      expect(own).toEqual({ row: 'own-unmerged' })
      expect(foreign).toEqual({ row: 'apply' })
    })
  })
})
