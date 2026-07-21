import { HeadMismatchError } from '@kumiai/hub-protocol'

/**
 * What a commit was, so a restart can route on it without parsing the framed commit. `ledger` is
 * fully re-issuable from its bodies after a crash (signed, epoch-independent tokens). The
 * proposal-carrying kinds are not: the intent lives in the MLS Add/Remove proposal and the
 * KeyPackage, neither of which survives the process that built them.
 */
export type CommitKind = 'ledger' | 'invite' | 'remove'

/**
 * A commit the host has BUILT but not adopted. MLS commits are non-mutating — they return a
 * derived handle and never advance the source — so the host's live handle is still the
 * pre-commit one, which is what lets the peer seal the bodies under the epoch every receiver of
 * this commit is at.
 */
export type PendingCommit = {
  /** Framed MLSMessage(Commit) bytes. */
  commit: Uint8Array
  /** The signed ledger-entry tokens this commit enacts. Empty for a commit that enacts none. */
  bodies: Array<string>
  kind: CommitKind
  /**
   * Opaque host blob holding everything needed to adopt this commit after a restart: the
   * serialized post-commit handle and any Welcome to deliver. Written to the journal BEFORE the
   * peer publishes, handed straight back to `adoptJournalled` on replay. The peer never inspects it.
   */
  journal: Uint8Array
  /**
   * Runs only if the hub accepts. Adopt the post-commit handle here and send any Welcome. The
   * ONLY place the host may adopt: adopting earlier rotates past the epoch the bodies must be
   * sealed under, adopting later leaves the handle behind the group.
   *
   * ENFORCED: the peer records acceptance in the journal BEFORE this runs, so a restart can tell
   * a commit that landed from one whose fate is unknown. An entry with no recorded acceptance,
   * found at an epoch past the one it was framed at, is a host that adopted elsewhere — the peer
   * REFUSES it with a {@link JournalEpochError} rather than re-sealing bodies under an epoch no
   * receiver holds. Not replayed, slot kept.
   *
   * MUST be idempotent — it can run more than once. *publish → record acceptance → `onAccepted()`
   * → clear slot* is four steps; a crash between any two leaves an entry whose `onAccepted` partly
   * ran still in the slot, and it is replayed. Re-adopting the journalled handle is harmless (a
   * fixed serialized value).
   *
   * So a Welcome is delivered AT LEAST ONCE, deliberately: suppressing the replayed repeat would
   * strand an invitee added to a group and never told, which is why the Welcome is journalled. The
   * sender does not deduplicate and must not try.
   *
   * The repeat is safe only because the invitee absorbs it: it joins with `processWelcomeOnce`
   * from `@kumiai/mls`, which returns `null` for a Welcome whose group it already holds. Plain
   * `processWelcome` does NOT — a pure function with no registry, so a repeat builds a second
   * group state at the joining epoch, and adopting it rolls the member back (every member added
   * since gone from its roster, group unreadable) with no error anywhere.
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
   * The epoch the commit was FRAMED at — the pre-commit epoch, since the host adopts in
   * `onAccepted` and nowhere else. Replay re-seals the bodies, correct only under this epoch's
   * secret.
   */
  epoch: number
  /**
   * The sequenceID the hub accepted this commit as. Present: it LANDED and this peer knows it
   * locally — replay adopts, no network. Absent: outcome UNKNOWN, replay must ask the store by
   * republishing.
   */
  acceptedAs?: string
  commit: Uint8Array
  bodies: Array<string>
  kind: CommitKind
  journal: Uint8Array
}

/**
 * Durable single-slot journal, host-provided (the host already persists handle state; the peer
 * has no storage). Holds at most one pending commit — the peer's commit mutex written down: one
 * commit in flight at a time, per group, per device.
 *
 * Written TWICE for a commit that lands: `put` before the publish, `markAccepted` once the hub
 * answers. `markAccepted` MUST run BEFORE `onAccepted`, while the group is still at the framed
 * epoch — moving it later breaks the design. After `onAccepted` the handle has advanced, so a
 * crash before the slot clears leaves a journalled commit at an epoch behind its group, which is
 * byte-for-byte what a host that adopted out of band and never landed its publish leaves.
 * Recorded first, the two are told apart: the legal crash carries the acceptance, the misbehaving
 * host carries none.
 *
 * `markAccepted` and `clear` both take the `publishID` so they only touch the entry they were
 * given: a call for an entry the slot no longer holds is a no-op, never a write over someone
 * else's pending commit.
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
 * A commit that was journalled, never landed, and cannot be re-issued by the peer — the process
 * that held its `build()` closure is gone.
 *
 * `ledger` carries the surviving signed tokens: the host re-issues them with an ordinary
 * `commit()`, nothing lost. `invite` / `remove` carries none — that commit cannot be
 * reconstructed, so the host must re-issue or tell the user. For a remove the notice is
 * security-relevant: an admin who believes a member was evicted when they were not has no other
 * signal.
 *
 * Both carry `journal`, the host's own blob from the lost entry, because both obligations are
 * about a specific operation the host started: re-issuing the right tokens, or telling the user
 * which action did not happen. The peer holds nothing else that names it — the `build()` closure
 * died with its process, and the tokens are the work, not the request. Handing back the kind
 * alone would say only that SOMETHING was lost.
 *
 * It is the same blob `adoptJournalled` receives when a commit lands, and deliberately so: a host
 * reads its own bookkeeping the same way on both outcomes, and the two paths stay symmetric.
 */
export type LostCommit =
  | { kind: 'ledger'; tokens: Array<string>; journal: Uint8Array }
  | { kind: 'invite' | 'remove'; journal: Uint8Array }

/**
 * What a lane operation found that the host must act on. Always a RETURN VALUE, never a callback:
 * found inside the peer's commit mutex, and the host's response to both is `commit()`, which takes
 * that same mutex.
 *
 * `lost`: a commit journalled and never landed, whose closure died with its process. `reenact`:
 * after a heal rejoined this peer, the signed entry tokens it held that the group's authenticated
 * ledger does NOT contain — the work survived, the commit that carried it did not. Both are the
 * host's to re-issue; the peer never re-issues either itself.
 *
 * An entry the group's ledger already holds is absent from `reenact`, whatever failure brought
 * the peer here. Re-enacting it would append a second copy, and the fold is last-write-wins by
 * position: it would win and silently revert whatever a later admin wrote over it.
 */
export type LaneResult = { lost?: LostCommit; reenact?: Array<string> }

/**
 * `commit()` ran out of time rebasing: it kept losing the compare-and-set past its deadline.
 * Losing one is not an error — this is losing them longer than the caller would wait.
 */
export class CommitDeadlineError extends Error {
  override name = 'CommitDeadlineError'
}

/**
 * A journalled commit whose outcome was never recorded is being replayed at an epoch other than
 * its framed one — so the group advanced without the peer learning this commit landed, which can
 * only mean the host adopted somewhere other than {@link PendingCommit.onAccepted}.
 *
 * Replay re-seals the bodies and can only seal under the host's current epoch. Sealing under the
 * wrong one publishes a blob no member can open: the commit applies, every receiver fails to
 * resolve its entries, and the lane wedges for the whole group on a frame nobody can pass. So the
 * peer refuses locally and keeps the slot — a local error the host can fix beats a group-wide
 * wedge it cannot.
 */
export class JournalEpochError extends Error {
  override name = 'JournalEpochError'
}

/**
 * `commit()` refuses rather than build on a state it cannot trust. Two causes, both meaning the
 * same to the host: nothing was published, the epoch did not advance, re-issue once the peer is
 * whole.
 *
 * 1. A strand the pull found — a frame proving this peer is not reconciled (its own un-merged
 *    commit, or a commit framed ahead of it); it cannot race a head it has not caught up to. The
 *    repair is a heal, already scheduled: it runs as its own lane operation the moment `commit()`
 *    releases the lane. Thrown rather than waited on because the heal needs the mutex `commit()`
 *    holds — waiting for it would wait on a queue including itself.
 * 2. An incomplete ledger — rejoined by external commit, bootstrap not finished, so the handle
 *    holds an empty ledger against a live head (a roster reset: every admin promoted since
 *    genesis invisible, a commit built now judged against admins it cannot see). NO heal is
 *    scheduled: the peer holds its leaf, and the ledger gather that just failed for want of a
 *    responder IS the repair — it re-runs at the head of the next lane operation.
 *
 * The host must NOT retry in a tight loop: for the strand that retakes the mutex before the heal
 * runs, for the incomplete ledger it re-gathers before a responder returns. A throw leaves any
 * earlier `lost` / `reenact` work undrained — call {@link "peer".GroupPeer.replay} to collect it.
 */
export class RecoveryRequiredError extends Error {
  override name = 'RecoveryRequiredError'
}

/**
 * The compare-and-set was lost: someone else's commit is at the head. The error crosses a
 * transport and is rebuilt from a wire code, so a peer talking to a real hub holds a
 * reconstructed instance — match on the NAME too, or a remote loss reads as an unknown publish
 * failure and the peer keeps a journal slot it should have cleared.
 */
export function isHeadMismatch(error: unknown): boolean {
  return (
    error instanceof HeadMismatchError ||
    (error instanceof Error && error.name === 'HeadMismatchError')
  )
}
