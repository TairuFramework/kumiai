import { HeadMismatchError } from '@kumiai/hub-protocol'

/**
 * What a commit was, so a restart can route on it without ever parsing the framed
 * commit. `ledger` is fully re-issuable from its bodies after a crash — the tokens are
 * signed and epoch-independent. The proposal-carrying kinds are not: the intent lives in
 * the MLS Add/Remove proposal and the KeyPackage, and neither survives the process that
 * built them.
 */
export type CommitKind = 'ledger' | 'invite' | 'remove'

/**
 * A commit the host has BUILT but not adopted. MLS commits are non-mutating: they return
 * a derived handle and never advance the source, so the host's live handle is still the
 * pre-commit one — which is what lets the peer seal the bodies under the epoch every
 * receiver of this commit is at.
 */
export type PendingCommit = {
  /** Framed MLSMessage(Commit) bytes. */
  commit: Uint8Array
  /** The signed ledger-entry tokens this commit enacts. Empty for a commit that enacts none. */
  bodies: Array<string>
  kind: CommitKind
  /**
   * Opaque host blob holding everything needed to adopt this commit after a restart: the
   * serialized post-commit handle and any Welcome to deliver. Written to the journal
   * BEFORE the peer publishes, and handed straight back to the host's `adoptJournalled`
   * on replay. The peer never inspects it.
   */
  journal: Uint8Array
  /**
   * Runs only if the hub accepts. The host adopts the post-commit handle here and sends
   * any Welcome. It is the ONLY place the host may adopt: a host that adopts earlier has
   * rotated past the epoch the bodies must be sealed under, and a host that adopts later
   * leaves its handle behind the group.
   *
   * That is ENFORCED, not merely asked for. The peer records the hub's acceptance in the
   * journal BEFORE this runs, so on a restart it can tell a commit that landed from one
   * whose fate is unknown. An entry with no recorded acceptance, found at an epoch past
   * the one it was framed at, is a host that adopted somewhere else — the peer REFUSES it
   * with a {@link JournalEpochError} rather than re-sealing its bodies under an epoch no
   * receiver of that commit holds. The commit is not replayed, and the slot is kept.
   *
   * MUST be idempotent — it can and will run more than once. *publish → record the
   * acceptance → `onAccepted()` → clear the journal slot* is four steps and a crash can
   * land between any two of them, so an entry whose `onAccepted` already ran, wholly or
   * partly, is still in the slot on restart and is replayed. Re-adopting the journalled
   * handle is harmless — it is a fixed serialized value. **Re-delivering a Welcome is
   * not:** the invitee has already joined, and a second `processWelcome` over the same
   * bytes errors or builds a duplicate group state. Both halves must tolerate a repeat.
   */
  onAccepted: () => Promise<void>
}

/** A pending commit as it sits in the journal: what the peer needs to republish it. */
export type JournalEntry = {
  /** The idempotency key the commit was published with, and is replayed with. */
  publishID: string
  /** The head the publish was conditional on. `null`: the topic had no log publish yet. */
  expectedHead: string | null
  /**
   * The epoch the commit was FRAMED at — the group's epoch when the entry was written,
   * which is the pre-commit one, because the host adopts in `onAccepted` and nowhere else.
   * Replay re-seals the bodies, and a re-seal is only correct under this epoch's secret.
   */
  epoch: number
  /**
   * The sequenceID the hub accepted this commit as. Present: it LANDED, and this peer
   * knows that locally — replay adopts it and never touches the network. Absent: the
   * outcome is UNKNOWN, and replay has to ask the store by republishing.
   */
  acceptedAs?: string
  commit: Uint8Array
  bodies: Array<string>
  kind: CommitKind
  journal: Uint8Array
}

/**
 * Durable single-slot journal, host-provided: the host already persists handle state and
 * has a database; the peer has neither.
 *
 * It holds at most one pending commit, which is not a limitation but the peer's commit
 * mutex written down — one commit is in flight at a time, per group, per device.
 *
 * The slot is written TWICE for a commit that lands: `put` before the publish, and
 * `markAccepted` once the hub has answered. **`markAccepted` runs BEFORE `onAccepted`,
 * while the group is still at the epoch the commit was framed at, and moving it later
 * breaks the design.** After `onAccepted` the handle has advanced, so a crash before the
 * slot is cleared leaves a journalled commit sitting at an epoch behind its own group —
 * which is byte-for-byte what a host that adopted out of band and never landed its publish
 * leaves behind. Recorded first, the two are told apart: the legal crash carries the
 * acceptance, and the misbehaving host carries none.
 *
 * `markAccepted` and `clear` both take the `publishID` so they can only ever touch the
 * entry they were given: a call for an entry the slot no longer holds is a no-op, never a
 * write over somebody else's pending commit.
 */
export type CommitJournal = {
  put(entry: JournalEntry): Promise<void>
  /**
   * Record that the hub accepted this commit as `sequenceID`. Must be durable before it
   * resolves, and must land before the host adopts.
   */
  markAccepted(publishID: string, sequenceID: string): Promise<void>
  get(): Promise<JournalEntry | null>
  clear(publishID: string): Promise<void>
}

/**
 * A commit that was journalled, never landed, and cannot be re-issued by the peer — the
 * process that held its `build()` closure is gone.
 *
 * `ledger` carries the surviving signed tokens: the host re-issues them with an ordinary
 * `commit()`, and nothing is lost. `invite` / `remove` carries none: that commit did not
 * happen and cannot be reconstructed, so the host must re-issue the operation or tell the
 * user. For a remove that notice is security-relevant — an admin who believes a member
 * was evicted when they were not has no signal at all otherwise.
 */
export type LostCommit = { kind: 'ledger'; tokens: Array<string> } | { kind: 'invite' | 'remove' }

/**
 * Every lane operation replays the journal first, so every one of them can surface a loss.
 * It is a RETURN VALUE and never a callback: replay runs inside the peer's commit mutex,
 * and the host's response to a loss is to call `commit()`, which takes that same mutex.
 */
export type LaneResult = { lost?: LostCommit }

/**
 * `commit()` ran out of time rebasing: it kept losing the compare-and-set until its
 * deadline. Losing one is not an error — this is losing them for longer than the caller
 * was willing to wait.
 */
export class CommitDeadlineError extends Error {
  override name = 'CommitDeadlineError'
}

/**
 * A journalled commit whose outcome was never recorded is being replayed at an epoch other
 * than the one it was framed at — so the group advanced without the peer ever learning that
 * this commit landed, which can only mean the host adopted somewhere other than
 * {@link PendingCommit.onAccepted}.
 *
 * Replay re-seals the bodies before republishing, and it can only seal them under the epoch
 * the host is at. Sealing them under the wrong one publishes a blob no member can open: the
 * commit applies, every receiver fails to resolve the entries it names, and the commit lane
 * wedges for the whole group on a frame nobody can get past. So the peer refuses, loudly and
 * locally, and keeps the slot: a local error the host can fix beats a group-wide wedge it
 * cannot.
 */
export class JournalEpochError extends Error {
  override name = 'JournalEpochError'
}

/**
 * The compare-and-set was lost: someone else's commit is at the head. The error crosses a
 * transport and is rebuilt from a wire code on the far side, so a peer talking to a real
 * hub holds a reconstructed instance — match on the name too, or a remote loss reads as an
 * unknown publish failure and the peer keeps a journal slot it should have cleared.
 */
export function isHeadMismatch(error: unknown): boolean {
  return (
    error instanceof HeadMismatchError ||
    (error instanceof Error && error.name === 'HeadMismatchError')
  )
}
