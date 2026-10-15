import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'

import type { CommitHeader } from './crypto.js'

/**
 * What the lane does with one frame from the commit log, in evaluation order. The
 * order is load-bearing, and this table is the `if` chain of {@link classifyCommit} plus the
 * port's answer to its last row:
 *
 * | Frame | Cursor |
 * |---|---|
 * | A wire version this build cannot read at all | advance; diagnostic poison requiring an upgrade |
 * | Not a commit at all (no header) | advance (poison — never retry, never heal); settled first, before any epoch question |
 * | Framed at an epoch AHEAD of this peer's | advance; heal — the group moved on without it |
 * | Below this peer's epoch, with no record — or a record naming THIS SAME commit | advance, no fork check, no unwrap attempt |
 * | Below this peer's epoch, with a record naming a DIFFERENT commit | advance; claimed diagnostic poison |
 * | At this peer's current epoch, with no authenticated committer | advance (poison — never retry, never heal) |
 * | At this peer's current epoch, committed by THIS peer | settle a matching retained slot or advance with a claimed diagnostic |
 * | At this peer's current epoch, committed by another — handed to the port | applied: advance and record this epoch -> the applied commit (digest and position) for history and divergence diagnostics; refused by policy or entries unresolvable: advance (poison — never retry, never heal) |
 *
 * Classification reads bytes and decrypts nothing. Only a frame at this peer's epoch authored
 * by someone else reaches the MLS port. Unreadable versions settle before headerless poison,
 * then epoch classification.
 *
 * **The header carries two facts with different trust.** The epoch is cleartext and only the
 * publisher's word. The committer is MLS-authenticated but recoverable only for a commit framed
 * at this peer's OWN epoch — reading it needs that epoch's key material. So `ahead`, `history`
 * and `past-epoch-divergence` are reached on the epoch alone (this peer holds no key
 * for them). Different bytes supply diagnostic evidence only,
 * while every row at this peer's own epoch requires the AUTHENTICATED committer and refuses to
 * fire without it. A classifier that demanded a committer before reading an epoch could never
 * classify the one frame that says a peer fell behind.
 *
 * **Classify by epoch first, unwrap only what you can apply.** A frame's blob is sealed under
 * the epoch it's framed at, so a peer walking history (late joiner, rejoiner, re-seeded) reaches
 * frames it can never open — including the commit that added it. Unwrapping before classifying
 * would misfile ordinary history as a decryption failure.
 */
export type CommitDisposition =
  /**
   * Framed at this peer's epoch, committed by somebody else: applicable. Hand to the MLS port
   * — and only now may its blob be opened, since it is sealed under the epoch this peer holds.
   */
  | { row: 'apply' }
  /**
   * A frame framed at an epoch AHEAD of this peer's: the group advanced where this peer did
   * not, proof it has fallen out of the group's line. Advance, and heal. The only row that
   * heals, since a fault only THIS peer has surfaces exactly here, later, once the group
   * commits past it — a frame nobody can resolve instead blocks the whole group directly.
   *
   * Decided on the epoch alone (see the type doc), which here is UNAUTHENTICATED by necessity:
   * a peer that fell behind holds no sender-data secret for the epoch it fell behind from, so
   * requiring a committer would make this row unreachable — and an unreachable `ahead` means the
   * peer files the group's entire future as poison and reports itself reconciled while
   * permanently, silently stuck. Worse than the forgery this accepts.
   *
   * **Accepted despite being forgeable.** Anything that can publish on the commit topic (a
   * removed member who keeps it forever, or the untrusted hub) can claim a high epoch and force
   * every honest peer to heal at once — the same costly recovery storm `own-unmerged` refuses to
   * fund. Accepted because: no authentication can close it (a peer past the gap has no key to
   * check the far side with); a liar can only TRIGGER a heal, never suppress one (honest
   * ahead-frames are classified independently); and it is bounded to one heal per frame, since
   * the frame is stepped over before the heal fires and is never re-read.
   */
  | { row: 'ahead' }
  /** Diagnostic poison: advance and report an upgrade requirement without a hold. */
  | { row: 'unsupported-version' }
  /**
   * A frame from an epoch BELOW this peer's with no applied-commit record: pre-join,
   * pre-rejoin, or re-seeded history. Advance, no fork check, no unwrap. Neither fork nor
   * poison — every healthy peer reads some.
   *
   * On the epoch alone, same as `ahead` and with far less at stake: no committer is recoverable
   * for an epoch this peer has ratcheted past either, and the frame is stepped over untouched —
   * a lie about the epoch only changes how a liar's frame gets ignored.
   *
   * Also the commit this peer ALREADY ENACTED at that epoch, re-served at another position. The
   * same commit is not a fork however the log came to carry it twice, and recognising it by its
   * bytes rather than by where it sits is what makes that true in any order the hub serves.
   */
  | { row: 'history' }
  /** Past bytes can be a refused CAS loser or a forged copy. Skip without safety action. */
  | { row: 'past-epoch-divergence' }
  /** Legacy fork disposition, retained for compatibility. The classifier never emits it. */
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
   * The committer read is the MLS-authenticated one from the commit itself — NEVER the frame's
   * transport sender (the untrusted hub's word), and never a fallback when authentication comes
   * back empty (that header is `poison`, per the type doc's trust split). Softening either would
   * let a forged frame heal this peer, or the whole group, on demand.
   */
  | { row: 'own-unmerged' }
  /**
   * A frame there is nothing further to do with. Advance — poison is stepped over, never
   * retried. It is the LAST resort, never the fallback for "I could not apply this": a crash
   * victim's own commit misfiled as malformed would walk the peer to the log's end stuck at its
   * epoch forever.
   *
   * THREE classifications land here — one row, because the cursor treatment is identical:
   * - **Not a commit at all**: no header. Undecodable bytes, or a message of another kind.
   * - **A commit at this peer's own epoch whose committer will not authenticate**: nothing
   *   honest looks like this. Must NOT fall through to `apply` (the port can't process it, and a
   *   throw there wedges the lane forever) or to `own-unmerged` (see that row).
   * - **Policy-refused, or ledger entries that will not resolve** — filed here on the MLS port's
   *   answer, not this classification.
   * None of the three heals — anything else hands any member a group-wide recovery storm per
   * publish (same cost as forging `ahead`, but closable here, so there's no reason to pay it).
   *
   * Dropping an unresolvable-entries commit leaves this peer at an epoch it did not pass, able
   * to commit onto a branch the group ignores. Accepted: bodies are sealed under the commit's
   * epoch, which every member at that epoch holds, so a frame resolves for all or none — a peer
   * that alone can't resolve one was already on another branch, and the group's next commit is
   * `ahead`, which heals it. Refusing to commit from such an epoch looks safer and is WORSE: every
   * honest member skipped that epoch too and would also refuse, so nobody can publish the commit
   * that unsticks the group — one unresolvable frame would kill it permanently instead.
   */
  | { row: 'poison' }

/** Unknown wire semantics: skip without interpreting the header, and diagnose the version. */
export const UNKNOWN_FRAME_VERSION = 'unknown-frame-version'

/**
 * What the lane could get out of one frame before classifying it: the commit's own header,
 * `null` for bytes that are not a commit, or {@link UNKNOWN_FRAME_VERSION} for a frame this
 * build cannot read at all.
 */
export type CommitFrameEvidence = CommitHeader | null | typeof UNKNOWN_FRAME_VERSION

/**
 * What this peer enacted at one epoch: the commit itself, by digest, and where the log carried it.
 *
 * The digest distinguishes history from diagnostic divergence. A position alone cannot identify bytes.
 * One record rather than two maps, deliberately: a position recorded without its digest re-opens the replay this closes,
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
 * like different commit bytes.
 *
 * Not a security boundary. This is a peer recognising bytes it already applied, and the only way to
 * abuse a collision is a different Commit that MLS accepts at the same epoch — a far stronger break
 * than the hash.
 */
export function digestAppliedCommit(commit: Uint8Array): string {
  return toB64U(sha256(commit))
}

/** What the classifier reads about this peer. Nothing here needs the network or a key. */
export type CommitClassifierState = {
  /** This peer's own identity — the DID that authenticates a commit this peer authored. */
  localDID: string
  /** The epoch this peer's group handle is at right now. */
  epoch: number
  /**
   * The commit this peer enacted at each epoch it has passed — by digest, with the sequenceID the
   * log carried it at. Different digests provide a claimed diagnostic, without choosing a branch.
   *
   * Rebuilt from the ControlStore's retained window on restart. An absent row is history.
   */
  appliedByEpoch: ReadonlyMap<number, AppliedCommit>
}

/**
 * One frame of the commit log, as much as can be known about it before anything is decrypted,
 * plus the peer state to judge it against.
 *
 * A single object rather than positional arguments: three of the four are strings-or-null read off
 * one frame, and at a call site `classifyCommit(header, position, null, state)` says nothing about
 * which `null` that is or why. Naming them makes the digest-less calls self-explaining.
 */
export type ClassifyCommitParams = {
  /**
   * What the commit says about itself, read out of its own bytes by the MLS port: `null` for bytes
   * that are not a commit at all, and otherwise the commit's epoch — always, it is cleartext —
   * with `committerDID` present only where the port could MLS-authenticate one. It is
   * {@link UNKNOWN_FRAME_VERSION} where the frame's wire version put the header itself out of reach.
   */
  header: CommitFrameEvidence
  /** Unused compatibility field. Hub positions do not decide past divergence. */
  sequenceID: string
  /**
   * {@link digestAppliedCommit} over this frame's commit bytes, or `null` where they were never
   * extracted — which today is only the {@link UNKNOWN_FRAME_VERSION} calls, settled at `unsupported-version`
   * before it is read.
   */
  commitDigest: string | null
  /** What this peer knows about itself. */
  state: CommitClassifierState
}

/**
 * Classify one frame of the commit log against this peer's state, before anything is
 * applied and before anything is decrypted.
 */
export function classifyCommit({
  header,
  commitDigest,
  state,
}: ClassifyCommitParams): CommitDisposition {
  // The distinct poison row lets the walker report an upgrade requirement.
  if (header === UNKNOWN_FRAME_VERSION) return { row: 'unsupported-version' }

  // Bytes that are not a commit can't be asked the epoch questions below, so settle next.
  if (header == null) return { row: 'poison' }

  // Settled before `history`, which is otherwise indistinguishable (no applied-commit record
  // either way) — but this is a peer fallen out of the group, cannot happen to a healthy one
  // (the log runs in non-decreasing epoch order, so a peer walking it is never ahead of it), and
  // is decided on the epoch alone. See the row's doc for what that costs and why it's accepted.
  if (header.epoch > state.epoch) return { row: 'ahead' }

  // Below this peer's epoch: also on the epoch alone, for the same reason.
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
    // Missing bytes cannot distinguish a replay from a competitor.
    if (commitDigest == null) return { row: 'history' }
    return { row: 'past-epoch-divergence' }
  }

  // At this peer's epoch — the only place the committer is both required and available (see
  // the type doc's trust split). No committer here is `poison`; must not fall through.
  if (header.committerDID == null) return { row: 'poison' }

  // Discriminate by authorship, NOT applicability — see `own-unmerged`'s doc.
  if (header.external !== true && header.committerDID === state.localDID)
    return { row: 'own-unmerged' }

  return { row: 'apply' }
}
