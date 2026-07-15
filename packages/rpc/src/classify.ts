import type { CommitHeader } from './crypto.js'

/**
 * What the lane does with one frame from the commit log. Six rows, listed in the order they
 * are EVALUATED — the order is not decoration, it is the whole design, and this table is the
 * `if` chain of {@link classifyCommit} (plus the port's answer to its last row) read top to
 * bottom:
 *
 * | Frame | Cursor |
 * |---|---|
 * | Not a commit at all (unreadable header) | advance (poison — never retry, never heal); settled first, before any epoch question |
 * | Framed at an epoch AHEAD of this peer's | advance; heal — the group moved on without it |
 * | Below this peer's epoch, with no recorded applied-commit | advance, no fork check, no unwrap attempt |
 * | Below this peer's epoch, with a record naming a different sequenceID | advance; the fork trigger |
 * | At this peer's current epoch, committed by THIS peer | do not advance; heal |
 * | At this peer's current epoch, committed by another — handed to the port | applied: advance and record this epoch -> sequenceID for the fork check; refused by policy or entries unresolvable: advance (poison — never retry, never heal) |
 *
 * FIVE of those rows are decided BEFORE the frame is handed to the MLS port; only the last —
 * a frame framed at this peer's epoch and authored by someone else — is handed over, and the
 * port's answer to it is the sixth row (applied, or poison). This function is that first half:
 * it classifies the frame against this peer's state, reading bytes and decrypting nothing. The
 * malformed-poison row is settled at the very top, because bytes with no header cannot be asked
 * any of the epoch questions the other rows turn on.
 *
 * **Classify by epoch first, and unwrap only what you can apply.** The blob a commit frame
 * carries is sealed under the epoch the commit is framed at, so a peer walking history — the
 * late joiner, the rejoiner, the re-seeded peer — reaches frames whose blob it can never
 * open, including the very commit that added it. Unwrapping is a CONSEQUENCE of "I can apply
 * this frame", never a precondition of reading it, and an implementation that unwraps before
 * it classifies files ordinary history as a decryption failure.
 */
export type CommitDisposition =
  /**
   * Framed at the epoch this peer is at, and committed by somebody else: this is a frame the
   * peer is in a position to apply. Hand it to the MLS port — and only now may its blob be
   * opened, because the epoch it is sealed under is the epoch this peer holds.
   */
  | { row: 'apply' }
  /**
   * A frame framed at an epoch AHEAD of this peer's: the group advanced at an epoch where
   * this peer did not, which is proof it has fallen out of the group's line. Advance, and
   * heal.
   *
   * It is the only thing that tells a peer its own state is broken, and it is the reason no
   * other row needs to. A frame this peer cannot resolve is dropped in silence, because the
   * bodies ride the commit sealed under the epoch it is framed at — so if this peer cannot
   * open them, no member at that epoch can, nobody applies the commit, and the group never
   * moves past it. A dead frame in the log costs one wasted compare-and-set slot and nothing
   * else. The group moving on anyway is the one observation that says the fault was this
   * peer's alone, and it arrives HERE, on a later frame — never on the frame that failed.
   */
  | { row: 'ahead' }
  /**
   * A frame from an epoch BELOW this peer's, which it holds no applied-commit record for:
   * pre-join, pre-rejoin, or re-seeded history. Advance, with no fork check and no unwrap
   * attempt. It is neither a fork nor poison — it is history, and every healthy peer reads
   * some.
   */
  | { row: 'history' }
  /**
   * Two different commits at one epoch: this peer applied `appliedSequenceID` there, and the
   * log now carries another. The hub accepted both, which it can only do by serving different
   * logs to different members. Advance, and heal if this peer is on the losing branch — the
   * branch whose commit carries the HIGHER sequenceID, a tiebreak both sides can evaluate
   * alone once they have seen both frames.
   */
  | { row: 'fork'; appliedSequenceID: string; branch: 'winning' | 'losing' }
  /**
   * This peer's OWN commit, framed at the epoch it is STILL at. The hub accepted it, the
   * group advanced on it, and the pending state died with the process that built it: MLS
   * MERGES a pending commit, it does not process one, so this peer can never apply the frame
   * that is its own commit. Do not advance; heal.
   *
   * **The discriminator is authorship, not applicability.** "A frame at my current epoch that
   * I cannot apply" describes every frame a peer fails to apply — the frame you are about to
   * apply is always at your current epoch — so it swallows the two rows beneath it: a commit
   * refused by policy (well-formed, deliberately not applied) and a frame whose ledger
   * entries will not resolve. Written that way it is a member-triggerable, group-wide denial
   * of service: the hub cannot judge a commit, so any member — including a removed one, who
   * keeps the commit topic and its subscription forever — publishes one well-formed,
   * policy-refused commit at the head and EVERY honest peer heals at once, repeatable at
   * will. Authorship is what stops the row overlapping its neighbours.
   *
   * And the committer must be read out of the commit itself, where MLS authenticates it —
   * never from the frame's transport sender, which is the untrusted hub's word. A hub that
   * stamped each recipient's own DID onto one poison frame would otherwise make the whole
   * group heal at once, through the one party this design never trusted.
   */
  | { row: 'own-unmerged' }
  /**
   * Not a commit at all. Advance — poison is stepped over and never retried. It is the LAST
   * resort and never the fallback for "I could not apply this": a crash victim's own commit
   * filed as malformed would leave the peer walking cheerfully to the end of the log with a
   * clean bill of health, stuck at its epoch forever.
   *
   * The lane files two more things here, on the port's answer rather than on this
   * classification: a commit the group's policy refuses, and a commit whose ledger entries
   * will not resolve. Both are dropped, both advance, and NEITHER heals — anything else hands
   * any member a group-wide recovery storm for the price of one publish.
   *
   * Dropping a commit whose entries will not resolve leaves this peer at an epoch it did not
   * advance past, and it may still commit from there. If the rest of the group applied that
   * frame, this peer's commit lands on a branch of its own and is quietly ignored.
   *
   * That is a known and accepted hazard, and it is bounded on both sides. It is not reachable
   * by an attacker: the bodies are sealed under the epoch the commit is framed at, and every
   * member AT that epoch holds that secret, so a frame resolves for all of them or for none of
   * them. A peer that alone cannot resolve one is a peer whose epoch secret already differs
   * from the group's — it was on another branch before the frame arrived. And the damage
   * expires: the group's next commit is framed ahead of this peer, which is the `ahead` row,
   * which heals it.
   *
   * Refusing to commit from such an epoch is the obvious guard and it is WORSE THAN THE BUG. In
   * the case that actually happens — nobody can resolve the frame — every honest member skipped
   * that epoch, so every honest member would refuse, while the peer that published the frame
   * adopted its own commit and sits an epoch ahead, alone. No one can publish the commit that
   * would unstick the group. One unresolvable frame would kill the group permanently.
   */
  | { row: 'poison' }

/** What the classifier reads about this peer. Nothing here needs the network or a key. */
export type CommitClassifierState = {
  /** This peer's own identity — the DID that authenticates a commit this peer authored. */
  localDID: string
  /** The epoch this peer's group handle is at right now. */
  epoch: number
  /**
   * The sequenceID of the commit this peer enacted at each epoch it has passed.
   *
   * Held in memory, and DELIBERATELY so. A peer that restarts holds none, so it reads history
   * as history: it can MISS a fork, and it can never invent one. That is the safe direction —
   * inventing forks would turn every late joiner, rejoiner and re-seeded peer into a recovery
   * storm on its first pull, which is the failure this table exists to prevent, while missing
   * one costs a peer a detection that the trim and ahead triggers reach anyway on the next
   * frame the group publishes. Making it durable means a second host-provided store, and there
   * is nothing yet to spend it on: fork RESOLUTION — the losing branch rejoining and
   * re-enacting its entries — is not built, so the trigger has nowhere to go. Revisit when it
   * is, and not before.
   */
  appliedByEpoch: ReadonlyMap<number, string>
}

/**
 * Classify one frame of the commit log against this peer's state, before anything is
 * applied and before anything is decrypted.
 *
 * `header` is the commit's own epoch and committer, read out of the commit bytes by the MLS
 * port — `null` for bytes that are not a commit at all.
 */
export function classifyCommit(
  header: CommitHeader | null,
  sequenceID: string,
  state: CommitClassifierState,
): CommitDisposition {
  // Bytes with no epoch and no committer cannot be asked any of the questions below, so this
  // is the one classification that must be settled first. It overlaps no other row: an
  // unreadable frame is not somebody's commit, least of all this peer's own.
  if (header == null) return { row: 'poison' }

  // AHEAD, and it must be settled before `history` — the two are otherwise indistinguishable,
  // because a peer holds no applied-commit record for an epoch it has never reached any more
  // than for one it was never part of, and the second of those is history while the first is
  // a peer that has fallen out of the group.
  //
  // It cannot fire for a healthy peer, and the reason is the log: an accepted commit is the
  // only thing that advances an epoch, and every one of them compare-and-sets at the head, so
  // the log's frames run in non-decreasing epoch order. A peer walking it applies each frame
  // at its own epoch and advances in lockstep, so the next frame is never ahead of it. A
  // Welcome joiner at epoch N reads frames at every epoch below N as history, applies the one
  // at N, and rises with the log — it never meets a frame ahead of itself, and this row never
  // fires on its first pull. That is what makes the row safe to put this high.
  //
  // So a frame framed ahead of this peer is proof of exactly one thing: the group advanced at
  // an epoch where this peer did not. Either the frames that would have carried it were
  // trimmed away, or it met one at its own epoch and could not apply it while everybody else
  // could. Both are the same condition — this peer is out of the group's line — and both have
  // the same repair. Advance, and heal.
  if (header.epoch > state.epoch) return { row: 'ahead' }

  if (header.epoch < state.epoch) {
    const applied = state.appliedByEpoch.get(header.epoch)
    // No record for that epoch -> not a fork, just history. "A commit at an epoch the peer
    // has already passed" is NOT the fork test, and using it would be a bug: a late joiner
    // pulling from the oldest retained frame walks commits from before it was invited, a
    // rejoined peer walks a log that predates its new leaf, and a re-seeded peer walks
    // frames it never held. None of them ever passed those epochs, and every one of them
    // would diagnose a fork on its first pull.
    if (applied == null || applied === sequenceID) return { row: 'history' }
    return {
      row: 'fork',
      appliedSequenceID: applied,
      branch: sequenceID < applied ? 'losing' : 'winning',
    }
  }

  // At this peer's epoch. Authorship, and NOT applicability: this peer can never apply the
  // frame that is its own commit, and a frame it merely fails to apply is somebody else's
  // problem to have caused, not a reason to heal.
  if (header.committerDID === state.localDID) return { row: 'own-unmerged' }

  return { row: 'apply' }
}
