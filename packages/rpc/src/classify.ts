import type { CommitHeader } from './crypto.js'

/**
 * What the lane does with one frame from the commit log. Seven rows, in EVALUATION order — the
 * order is load-bearing, and this table is the `if` chain of {@link classifyCommit} plus the
 * port's answer to its last row:
 *
 * | Frame | Cursor |
 * |---|---|
 * | A wire version this build cannot read at all | advance; heal — the group moved on to a format this build does not have |
 * | Not a commit at all (no header) | advance (poison — never retry, never heal); settled first, before any epoch question |
 * | Framed at an epoch AHEAD of this peer's | advance; heal — the group moved on without it |
 * | Below this peer's epoch, with no recorded applied-commit | advance, no fork check, no unwrap attempt |
 * | Below this peer's epoch, with a record naming a different sequenceID | advance; the fork trigger |
 * | At this peer's current epoch, with no authenticated committer | advance (poison — never retry, never heal) |
 * | At this peer's current epoch, committed by THIS peer | do not advance; heal |
 * | At this peer's current epoch, committed by another — handed to the port | applied: advance and record this epoch -> sequenceID for the fork check; refused by policy or entries unresolvable: advance (poison — never retry, never heal) |
 *
 * Seven rows are decided here, reading bytes and decrypting nothing; only the last — a frame at
 * this peer's epoch authored by someone else — is handed to the MLS port, whose answer is the
 * eighth row. Headerless-poison settles at the top because bytes that are not a commit cannot
 * be asked the epoch questions the other rows turn on — and the unreadable-version row settles
 * above even that, because such a frame cannot be asked whether it is a commit either.
 *
 * **The header carries two facts with different trust, and each row must say which it uses.**
 * The epoch is cleartext, keyless, readable at any epoch, and only the publisher's word. The
 * committer is MLS-authenticated but recoverable only for a commit framed at this peer's own
 * epoch — a member commit's needs the epoch's sender-data secret to decrypt, and an external
 * commit's needs that epoch's group context to check the signature binding the leaf credential to
 * its key. Different mechanisms, same reach, and no exemption for either. So the rows split
 * cleanly: `ahead`, `history` and `fork` dispatch on the EPOCH
 * ALONE — they must, since they are about frames this peer holds no key for — while every row at
 * this peer's own epoch requires the AUTHENTICATED committer and refuses to fire without it.
 * Conflating the two is not a style question: a classifier that demands a committer before
 * reading an epoch cannot read any frame the peer has fallen behind, which is the one frame that
 * says it fell behind.
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
   *
   * **Decided on the epoch alone, which is UNAUTHENTICATED — deliberately, and unavoidably.**
   * The epoch rides the commit's cleartext; the committer would need the epoch's sender-data
   * secret, and a peer that has fallen behind holds no such secret for the epoch it fell behind
   * from. Requiring one here does not make the row safer, it makes the row unreachable — and an
   * unreachable `ahead` is the worst outcome available, since the peer then files the group's
   * entire future as poison, steps over all of it, and reports itself fully reconciled while
   * permanently stuck. Silent, and worse than message loss because nothing reports it.
   *
   * WHAT IT COSTS: anything that can put a frame on the commit topic — a removed member who
   * keeps the topic forever, or the untrusted hub — can claim a high epoch here and make every
   * honest peer heal at once, for one publish. A heal is not free: a rendezvous, a sealed
   * GroupInfo from every responder, an external commit, and a compare-and-set. That is the same
   * group-wide recovery storm {@link CommitDisposition} refuses to fund on `own-unmerged`.
   *
   * WHY IT IS ACCEPTED ANYWAY:
   * - **It is not new, and no authentication closes it.** The cheapest forgery needs no key and
   *   no signature at all: a PrivateMessage commit frame with a rewritten cleartext epoch reaches
   *   this row, because the epoch is the only thing this row reads. Authenticating committers
   *   cannot help — this row asks for none, and none could be given.
   * - **It is unclosable by construction.** Any signal that says "you fell out of the group" is
   *   a signal a hostile publisher can also emit, because a peer that fell out is by definition
   *   one that cannot authenticate what the group is doing now. There is no key on this side of
   *   the gap to check it with.
   * - **A liar can only TRIGGER a heal, never suppress one.** Honest ahead-frames are in the log
   *   too and are classified independently, so no forgery hides them.
   * - **It is bounded to one heal per frame, and cannot loop.** The frame is stepped over before
   *   the heal is asked for, so it is never re-read; a peer that heals lands at the group's real
   *   epoch and is not returned here by the same frame. The attacker pays one published frame
   *   per heal, which is a write capability any member has anyway.
   */
  | { row: 'ahead' }
  /**
   * A frame from an epoch BELOW this peer's with no applied-commit record: pre-join,
   * pre-rejoin, or re-seeded history. Advance, no fork check, no unwrap. Neither fork nor
   * poison — every healthy peer reads some.
   *
   * On the epoch alone, for the same reason as `ahead` and with far less at stake: this peer
   * holds no sender-data secret for an epoch it has ratcheted past, so no committer is
   * recoverable here either. Nothing is spent on the answer — the frame is stepped over, never
   * handed to the port, its blob never touched — so a lie about the epoch buys a liar the right
   * to have their frame ignored slightly differently.
   */
  | { row: 'history' }
  /**
   * Two different commits at one epoch: this peer applied `appliedSequenceID`, the log now
   * carries another. Reached on the epoch alone and settled on sequenceIDs, which are the
   * hub's own chaining and not the commit's word; the committer is neither read nor available.
   * The hub accepted both — only possible by serving different logs to
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
   *
   * **AUTHENTICATED OR NOT AT ALL.** This row is the one place a peer heals off a claim of
   * authorship, so an unauthenticated committer must never reach it — not from the transport
   * sender, and not as a fallback when the authenticated read comes back empty. It is only ever
   * reachable at this peer's CURRENT epoch, which is exactly the epoch whose sender-data secret
   * the peer holds, so a genuine member commit here always authenticates and the row loses
   * nothing by refusing the rest. A header at this epoch with no committer is `poison`, and the
   * temptation to soften that into "well, it might be mine" is the whole attack: a forged frame
   * naming this peer would heal it on demand, and one naming everybody would storm the group.
   */
  | { row: 'own-unmerged' }
  /**
   * A frame there is nothing further to do with. Advance — poison is stepped over, never
   * retried. It is the LAST resort, never the fallback for "I could not apply this": a crash
   * victim's own commit misfiled as malformed would walk the peer to the log's end stuck at its
   * epoch forever.
   *
   * TWO classifications land here, and they are deliberately one row because the cursor
   * treatment is identical — advance, never retry, never heal:
   * - **Not a commit at all**: no header. Undecodable bytes, or a message of another kind.
   * - **A commit at this peer's own epoch whose committer will not authenticate**: it is a
   *   commit, and the epoch says this peer should be able to read its author, and it cannot.
   *   Nothing honest looks like this. It must NOT fall through to `apply`: the port would be
   *   handed a frame it cannot process, and a port that throws on it leaves the cursor put and
   *   the lane wedged on that frame forever. It must not fall through to `own-unmerged`
   *   either — see that row.
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

/**
 * A frame on the commit topic whose handshake version this build does not know: unreadable, in
 * the one place where being unreadable is itself evidence.
 *
 * Passed to {@link classifyCommit} in the header's place, because there IS no header — the bytes
 * behind the version byte are a format this build has never seen, and reading them would be
 * guessing. It is not a `null` header: `null` means "readable bytes that are not a commit", which
 * is poison. This means "the group is speaking a language I do not have", which is `ahead`.
 */
export const UNKNOWN_FRAME_VERSION = 'unknown-frame-version'

/**
 * What the lane could get out of one frame before classifying it: the commit's own header,
 * `null` for bytes that are not a commit, or {@link UNKNOWN_FRAME_VERSION} for a frame this
 * build cannot read at all.
 */
export type CommitFrameEvidence = CommitHeader | null | typeof UNKNOWN_FRAME_VERSION

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
 * `header` is what the commit says about itself, read out of its own bytes by the MLS port:
 * `null` for bytes that are not a commit at all, and otherwise the commit's epoch — always, it
 * is cleartext — with `committerDID` present only where the port could MLS-authenticate one. It
 * is {@link UNKNOWN_FRAME_VERSION} where the frame's wire version put the header itself out of
 * reach.
 */
export function classifyCommit(
  header: CommitFrameEvidence,
  sequenceID: string,
  state: CommitClassifierState,
): CommitDisposition {
  // A frame this build cannot read AT ALL, settled above every other row — including the
  // headerless one, since bytes in an unknown format cannot be asked whether they are a commit.
  //
  // `ahead`, and for the same reason that row exists: on the commit topic a frame nobody could
  // have written except a build past this one is proof the group moved where this peer did not.
  // POISON IS THE DANGEROUS ANSWER HERE, uniquely so. Every other poison frame is one frame among
  // readable ones, so the peer heals off the next; after a version bump EVERY frame is
  // unreadable, so there is no next — the peer steps over the group's whole future, drains to the
  // end of the log, and reports itself fully reconciled at a dead epoch, permanently and
  // silently.
  //
  // Costs exactly what the `ahead` row costs and no more, on the same asymmetry: anything that
  // can publish here can forge one of these and trigger a heal, and nothing can forge one that
  // SUPPRESSES a heal. See that row for why that trade is accepted.
  if (header === UNKNOWN_FRAME_VERSION) return { row: 'ahead' }

  // Bytes that are not a commit cannot be asked the questions below, so settle first. Overlaps
  // no other row: a frame that is not a commit is not somebody's commit, least of all this
  // peer's own. NOTE what this does NOT cover: a commit the port could read the epoch of but not
  // the author of is a header, not a null, and it is classified on its epoch below.
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
  //
  // On the epoch ALONE. No committer is asked for and none could be given: the epoch's
  // sender-data secret is exactly what a peer that fell behind does not hold. See the row's doc
  // for what that costs and why it is accepted.
  if (header.epoch > state.epoch) return { row: 'ahead' }

  // Below this peer's epoch: also on the epoch alone, and also because there is no choice — a
  // ratcheted-past epoch's secret is gone. Nothing below spends anything on the answer.
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

  // At this peer's epoch — and ONLY here is the committer both required and available. This is
  // the epoch whose sender-data secret this peer holds, so an honest member commit authenticates
  // its author; one that does not is poison, and must not reach either row below. Falling
  // through to `apply` would hand the port a frame it cannot process (a throw there leaves the
  // cursor put and wedges the lane on it forever), and falling through to `own-unmerged` would
  // let a forged frame heal this peer on demand.
  if (header.committerDID == null) return { row: 'poison' }

  // Discriminate by authorship, NOT applicability: a peer can never apply its own commit, and a
  // frame it merely fails to apply is not a reason to heal. The committer read here is the
  // MLS-authenticated one or nothing — never the transport sender, never an unauthenticated
  // fallback.
  if (header.committerDID === state.localDID) return { row: 'own-unmerged' }

  return { row: 'apply' }
}
