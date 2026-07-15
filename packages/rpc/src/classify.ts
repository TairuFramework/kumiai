import type { CommitHeader } from './crypto.js'

/**
 * What the lane does with one frame from the commit log. Six rows, in EVALUATION order — the
 * order is load-bearing, and this table is the `if` chain of {@link classifyCommit} plus the
 * port's answer to its last row:
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
 * Five rows are decided here, reading bytes and decrypting nothing; only the last — a frame at
 * this peer's epoch authored by someone else — is handed to the MLS port, whose answer is the
 * sixth row. Malformed-poison settles at the top because headerless bytes cannot be asked the
 * epoch questions the other rows turn on.
 *
 * **Classify by epoch first, unwrap only what you can apply.** A frame's blob is sealed under
 * the epoch the commit is framed at, so a peer walking history (late joiner, rejoiner,
 * re-seeded) reaches frames it can never open — including the commit that added it. Unwrapping
 * is a consequence of "I can apply this frame", never a precondition of reading it; unwrapping
 * before classifying files ordinary history as a decryption failure.
 */
export type CommitDisposition =
  /**
   * Framed at this peer's epoch, committed by somebody else: applicable. Hand to the MLS port
   * — and only now may its blob be opened, since it is sealed under the epoch this peer holds.
   */
  | { row: 'apply' }
  /**
   * A frame framed at an epoch AHEAD of this peer's: the group advanced where this peer did
   * not, proof it has fallen out of the group's line. Advance, and heal.
   *
   * This is the only signal that a peer's own state is broken, so no other row needs to heal
   * a dropped frame: a frame nobody can resolve blocks the whole group (nobody applies it),
   * whereas a frame only THIS peer cannot resolve is a fault of its own — observable only
   * later, when the group commits past it and lands here.
   */
  | { row: 'ahead' }
  /**
   * A frame from an epoch BELOW this peer's with no applied-commit record: pre-join,
   * pre-rejoin, or re-seeded history. Advance, no fork check, no unwrap. Neither fork nor
   * poison — every healthy peer reads some.
   */
  | { row: 'history' }
  /**
   * Two different commits at one epoch: this peer applied `appliedSequenceID`, the log now
   * carries another. The hub accepted both — only possible by serving different logs to
   * different members. Advance, and heal if on the losing branch: the branch whose commit
   * carries the HIGHER sequenceID, a tiebreak both sides evaluate alone once they see both.
   */
  | { row: 'fork'; appliedSequenceID: string; branch: 'winning' | 'losing' }
  /**
   * This peer's OWN commit, framed at the epoch it is STILL at. MLS MERGES a pending commit,
   * it does not process one, so a peer can never apply the frame that is its own commit; the
   * pending state died with the process that built it. Do not advance; heal.
   *
   * **Discriminate by authorship, not applicability.** "A frame at my epoch I cannot apply"
   * matches every unapplied frame, so it would swallow the two rows below (policy-refused, and
   * unresolvable entries) — a member-triggerable group-wide DoS: any member (including a
   * removed one, who keeps the commit topic forever) publishes one well-formed policy-refused
   * commit and every honest peer heals at once. Authorship stops the overlap.
   *
   * Read the committer from the commit itself, where MLS authenticates it — NEVER from the
   * frame's transport sender, the untrusted hub's word. A hub that stamped each recipient's
   * own DID onto one poison frame would otherwise heal the whole group at will.
   */
  | { row: 'own-unmerged' }
  /**
   * Not a commit at all. Advance — poison is stepped over, never retried. It is the LAST
   * resort, never the fallback for "I could not apply this": a crash victim's own commit
   * misfiled as malformed would walk the peer to the log's end stuck at its epoch forever.
   *
   * Two more cases are filed here on the port's answer, not this classification: a
   * policy-refused commit, and a commit whose ledger entries will not resolve. Both advance,
   * NEITHER heals — anything else hands any member a group-wide recovery storm per publish.
   *
   * Dropping an unresolvable-entries commit leaves this peer at an epoch it did not pass, and
   * it may still commit from there onto a branch the group ignores. Known, accepted, bounded,
   * and not attacker-reachable: bodies are sealed under the commit's epoch, which every member
   * at that epoch holds, so a frame resolves for all or none — a peer that alone cannot resolve
   * one was already on another branch. And the group's next commit is `ahead`, which heals it.
   *
   * Refusing to commit from such an epoch is the obvious guard and WORSE THAN THE BUG: when
   * nobody can resolve the frame, every honest member skipped that epoch and would refuse,
   * while the publisher sits an epoch ahead alone — no one can publish the commit that unsticks
   * the group, and one unresolvable frame kills it permanently.
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
   * In memory, DELIBERATELY. A restarted peer holds none and reads history as history: it can
   * MISS a fork but can never invent one — the safe direction, since inventing forks would
   * turn every late joiner/rejoiner/re-seeded peer into a recovery storm on first pull, while a
   * missed fork is re-detected by the trim and `ahead` triggers on the next published frame.
   * Durability needs a second host-provided store with nothing yet to spend it on: fork
   * RESOLUTION (losing branch rejoining and re-enacting) is not built. Revisit when it is.
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
  // Headerless bytes cannot be asked the questions below, so settle first. Overlaps no other
  // row: an unreadable frame is not somebody's commit, least of all this peer's own.
  if (header == null) return { row: 'poison' }

  // AHEAD, settled before `history`: the two are otherwise indistinguishable, since a peer
  // holds no applied-commit record for an epoch it never reached any more than for one it was
  // never part of — but the first is a peer fallen out of the group, the second is history.
  //
  // Cannot fire for a healthy peer: commits advance epochs and each compare-and-sets at the
  // head, so the log runs in non-decreasing epoch order and a peer walking it advances in
  // lockstep — the next frame is never ahead. A Welcome joiner at epoch N reads all frames
  // below N as history, applies N, and rises with the log. So a frame ahead of this peer means
  // exactly one thing: the group advanced at an epoch this peer did not (trimmed frames, or a
  // frame it alone could not apply). Advance, and heal.
  if (header.epoch > state.epoch) return { row: 'ahead' }

  if (header.epoch < state.epoch) {
    const applied = state.appliedByEpoch.get(header.epoch)
    // No record for that epoch -> history, not fork. "A commit at an epoch the peer already
    // passed" is NOT the fork test: a late joiner, rejoiner, or re-seeded peer walks epochs it
    // never passed, and would falsely diagnose a fork on first pull.
    if (applied == null || applied === sequenceID) return { row: 'history' }
    return {
      row: 'fork',
      appliedSequenceID: applied,
      branch: sequenceID < applied ? 'losing' : 'winning',
    }
  }

  // At this peer's epoch. Discriminate by authorship, NOT applicability: a peer can never
  // apply its own commit, and a frame it merely fails to apply is not a reason to heal.
  if (header.committerDID === state.localDID) return { row: 'own-unmerged' }

  return { row: 'apply' }
}
