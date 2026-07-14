import type { Client } from '@enkaku/client'
import type { ProtocolDefinition } from '@enkaku/protocol'
import type { ProcedureHandlers } from '@enkaku/server'
import {
  BroadcastClient,
  createBroadcastTransport,
  defaultJitter,
  defaultRandomID,
  type GatheredReply,
  type GatherOptions,
  type RequestOptions,
  type SuppressConfig,
} from '@kumiai/broadcast'
import type { StoredMessage } from '@kumiai/hub-protocol'
import type { LogHub } from '@kumiai/hub-tunnel'

import { createGroupBusServer } from './bus-server.js'
import { classifyCommit } from './classify.js'
import {
  CommitDeadlineError,
  type CommitJournal,
  isHeadMismatch,
  JournalEpochError,
  type LaneResult,
  type LostCommit,
  type PendingCommit,
  RecoveryRequiredError,
} from './commit.js'
import { type CommitFrame, decodeCommitFrame, encodeCommitFrame } from './commit-frame.js'
import { type GroupCrypto, type GroupMLS, isMissingLedgerEntries } from './crypto.js'
import { asLogPosition, type LogPosition } from './cursor.js'
import { createDirectedClient, createInboxAcceptor } from './directed.js'
import { adaptBusHandlers } from './handlers.js'
import { decodeHandshakeFrame, encodeHandshakeFrame, HANDSHAKE_KIND } from './handshake.js'
import { createHubMux, type HubMux } from './hub-mux.js'
import { createLedgerEntryResolver, encodeLedgerEntries } from './ledger-entries.js'
import {
  decodeLedgerReply,
  decodeLedgerRequest,
  decodeRecoveryReply,
  decodeRecoveryRequest,
  encodeLedgerReply,
  encodeLedgerRequest,
  encodeRecoveryReply,
  encodeRecoveryRequest,
} from './recovery.js'
import { commitTopic, inboxTopic, protocolTopic, rendezvousTopic } from './topic.js'

const DEFAULT_RECOVERY_TIMEOUT_MS = 5000
const DEFAULT_RECOVERY_JITTER_MS = 250

/**
 * How long `recover()` keeps rejoining before it gives up and leaves the peer degraded.
 *
 * Losing the compare-and-set is the LIKELY case here, not the edge case: a heal runs
 * precisely when the group is under commit pressure, and two peers healing at once race each
 * other. So this is a deadline, like `commit()`'s, and not an attempt count.
 */
const DEFAULT_RECOVERY_DEADLINE_MS = 30_000

/**
 * How long the hub is asked to keep the commit log. It bounds one thing: how long a
 * member may be offline and still converge against the hub alone, by pulling, without
 * needing another member awake to heal it.
 */
const DEFAULT_COMMIT_LOG_RETENTION_SECONDS = 30 * 24 * 60 * 60

/** How many commit frames a single pull asks for. Pull loops until the log is drained. */
const COMMIT_FETCH_LIMIT = 100

/**
 * How long `commit` keeps rebasing before it gives up. A deadline, not an attempt count:
 * with several active admins, five consecutive lost compare-and-sets on a busy group is
 * ordinary contention, and an attempt count turns it into a thrown error.
 */
const DEFAULT_COMMIT_DEADLINE_MS = 30_000

/**
 * Runaway guard only. The deadline is the bound that matters; this exists so a hub that
 * accepts nothing and never advances its head cannot spin the loop forever inside a clock
 * tick.
 */
const COMMIT_ATTEMPT_CEILING = 1000

/**
 * The MLS half of a peer: the lifecycle port, the durable journal that carries a pending
 * commit across a crash, and the host hook that adopts one after a restart. They arrive
 * together or not at all — a peer with an MLS port and no journal would lose every commit
 * whose process died in the acceptance window, silently, and the type is what stops a host
 * wiring that.
 */
export type GroupPeerMLSParams = {
  /** MLS lifecycle port. When provided, the peer runs the commit lane. */
  mls: GroupMLS
  /** Durable single-slot journal. Written before every publish, cleared on both outcomes. */
  journal: CommitJournal
  /**
   * Adopt a commit that was journalled and has now been confirmed accepted — the restart
   * half of {@link PendingCommit.onAccepted}, over the same opaque blob. The host
   * deserializes its post-commit handle, adopts it, and delivers any Welcome it carried.
   *
   * MUST be idempotent, for the same reason `onAccepted` must: the peer cannot tell an
   * entry whose `onAccepted` already ran from one whose process died before it. So the
   * Welcome goes out again, at-least-once and by design — see
   * {@link PendingCommit.onAccepted} for why the sender must not suppress the repeat, and
   * what absorbs it on the invitee's side.
   */
  adoptJournalled: (journal: Uint8Array) => Promise<void>
}

export type GroupPeerParams<Protocols extends Record<string, ProtocolDefinition>> = {
  hub: LogHub
  crypto: GroupCrypto
  localDID: string
  protocols: Protocols
  handlers: { [K in keyof Protocols]: ProcedureHandlers<Protocols[K]> }
  suppress?: SuppressConfig
  getRandomID?: () => string
  /**
   * Recovery rendezvous tuning. `timeoutMs` is how long one request waits for a reply,
   * `getDelayMs` the responder reply jitter, and `deadlineMs` how long `recover()` keeps
   * re-requesting and rebuilding before it gives up and leaves the peer degraded.
   */
  recovery?: { timeoutMs?: number; getDelayMs?: () => number; deadlineMs?: number }
  /**
   * Retention the hub is asked to hold the commit log for, in seconds. Defaults to 30
   * days. It is a liveness dial: below it, a returning member converges by pulling the
   * log; beyond it, it must be healed by another live member.
   */
  commitLogRetentionSeconds?: number
  /**
   * How long `commit` rebases against the group before giving up, in milliseconds.
   * Defaults to 30s. Losing a compare-and-set is the expected path, not an error path.
   */
  commitDeadlineMs?: number
} & (GroupPeerMLSParams | { mls?: undefined; journal?: undefined; adoptJournalled?: undefined })

export type ProtocolSurface<Protocol extends ProtocolDefinition> = {
  dispatch: (prc: string, data?: Record<string, unknown>) => Promise<void>
  request: (prc: string, prm?: unknown, options?: RequestOptions) => Promise<unknown>
  gather: (prc: string, prm?: unknown, options?: GatherOptions) => Promise<Array<GatheredReply>>
  to: (memberDID: string) => Client<Protocol>
}

export type GroupPeer<Protocols extends Record<string, ProtocolDefinition>> = {
  protocol: <K extends keyof Protocols>(name: K) => ProtocolSurface<Protocols[K]>
  /**
   * Commit to the group, and keep rebasing until it lands.
   *
   * `build()` produces a commit against the host's CURRENT handle and does not adopt it.
   * The peer replays its journal, pulls the commit log to the end, calls `build()`,
   * journals the result, and publishes it conditionally on the head it pulled to. If it
   * wins, the host's `onAccepted` runs and the slot clears. If it loses — someone else
   * committed first — the pending commit is dropped untouched and `build()` is called
   * again against the now-current handle. That is the expected path, not an error path.
   *
   * `build()` is called once per attempt and MUST read the host's live handle each time.
   * It must have no side effects until `onAccepted` runs: an attempt that loses is
   * discarded whole.
   *
   * Holds the group's commit mutex for its whole run. The compare-and-set resolves races
   * between devices; it says nothing about two callers on the same one, and two `build()`
   * calls against a single handle would both frame at that handle's epoch and diverge.
   */
  commit: (build: () => Promise<PendingCommit>) => Promise<LaneResult>
  /**
   * Replay the journal on its own, for startup: republish any pending commit under its
   * original idempotency key and hand back what did not survive.
   *
   * Every lane operation replays first, so this is not the only way a loss surfaces — but
   * it is the one a host can call before it does anything else, and a peer that comes up
   * holding a commit it never learned the fate of should be asked.
   */
  replay: () => Promise<LaneResult>
  /**
   * Heal a peer the group has left behind: rejoin by external commit, refold the ledger,
   * and hand back the entries the group's ledger does not already hold.
   *
   * A TOP-LEVEL lane operation with a compare-and-set loop of its own — it takes the commit
   * mutex itself, and it is never called from inside another lane operation. The external
   * commit changes the ratchet tree, so it races at the head like any other commit; losing
   * that race is the likely outcome, not the edge case, and a loss DISCARDS THE GROUPINFO as
   * well as the commit built from it — the GroupInfo describes a tree the winner has already
   * changed, so rebuilding from it would publish a commit no member can apply.
   *
   * **A heal is two commits, not one.** The rejoin carries no entries — a GroupInfo has
   * nowhere to put them — so the entries this peer still owes the group ride an ordinary
   * `commit()` the CALLER makes, after this has released the lane. That is what `reenact`
   * is for, and it is filtered by MEMBERSHIP, never by which failure brought the peer here:
   * an entry is re-enacted if and only if the group's authenticated ledger does not already
   * contain it. The ledger does not dedup — a re-appended entry WINS the fold — so
   * re-enacting an entry the group already holds silently reverts whatever a later admin
   * wrote over it.
   *
   * `{ advanced: false }` when no member answers the rendezvous, and when the rejoin landed
   * but the ledger could not be bootstrapped: a peer holding an incomplete ledger is a peer
   * whose roster has reset, and reporting it healed would hand the host a group with every
   * role gone. It stays degraded, and retries.
   *
   * A peer that is merely BEHIND never needs this — it pulls the commit log and catches up.
   */
  recover: () => Promise<{ advanced: boolean; reenact: Array<string> }>
  resync: () => Promise<void>
  dispose: () => Promise<void>
}

type ProtocolRuntime = {
  client: BroadcastClient
  busServer: { dispose: () => Promise<void> }
  acceptor: { dispose: () => Promise<void> }
  directed: Map<string, { client: Client<ProtocolDefinition>; dispose: () => Promise<void> }>
}

export function createGroupPeer<Protocols extends Record<string, ProtocolDefinition>>(
  params: GroupPeerParams<Protocols>,
): GroupPeer<Protocols> {
  const { hub, crypto, mls, journal, adoptJournalled, localDID, protocols, handlers, suppress } =
    params
  const getRandomID = params.getRandomID
  const newPublishID = getRandomID ?? defaultRandomID
  const recoveryTimeoutMs = params.recovery?.timeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS
  const recoveryDeadlineMs = params.recovery?.deadlineMs ?? DEFAULT_RECOVERY_DEADLINE_MS
  const getReplyDelayMs =
    params.recovery?.getDelayMs ?? (() => defaultJitter(DEFAULT_RECOVERY_JITTER_MS))
  const commitLogRetentionSeconds =
    params.commitLogRetentionSeconds ?? DEFAULT_COMMIT_LOG_RETENTION_SECONDS
  const commitDeadlineMs = params.commitDeadlineMs ?? DEFAULT_COMMIT_DEADLINE_MS
  const mux: HubMux = createHubMux({ hub, localDID })

  let runtimes = new Map<string, ProtocolRuntime>()
  let secret: Uint8Array<ArrayBufferLike> = new Uint8Array()
  /**
   * The epoch this peer's app lane is built at, seeded from the handle rather than from zero.
   *
   * Zero is not a neutral placeholder here: `frameCommit` refuses to seal a commit's bodies
   * when the live handle has moved past this, and the FIRST lane operation a peer runs is the
   * seed — replay, then the pull — which happens BEFORE the app lane is built. A peer that
   * restarted holding a journalled commit would therefore have its own replay refused at
   * startup, by a guard about a host adopting early, on a handle that had done nothing of the
   * sort. It would recover only if the host happened to call a lane operation later.
   */
  let epoch = crypto.epoch()

  const buildEpoch = async (): Promise<void> => {
    secret = await crypto.exportSecret()
    epoch = crypto.epoch()
    const next = new Map<string, ProtocolRuntime>()
    for (const [name, protocol] of Object.entries(protocols)) {
      const topicID = protocolTopic(secret, epoch, name)
      // Both of these are subscribed for the member's whole life, on the same terms as the
      // commit and rendezvous topics: a rotation tears down the LISTENERS on an epoch it has
      // left, and never the subscriptions. The mux is what guarantees it — nothing there
      // unsubscribes — because unsubscribing tells the hub to drop this member's pending
      // deliveries for the topic and to free any frame it was the last reader of. A peer that
      // gave up the subscription as it rotated would delete its own unread messages, and
      // everyone else's copy of them, on the way past.
      const selfInbox = inboxTopic(secret, epoch, localDID)
      const client = new BroadcastClient({
        transport: createBroadcastTransport({
          topicID,
          bus: mux.bus,
          wrap: crypto.wrap,
          unwrap: crypto.unwrap,
        }),
        ...(getRandomID != null ? { getRandomID } : {}),
      })
      const { eventHandlers, requestHandlers } = adaptBusHandlers(
        protocol,
        handlers[name] as Record<string, unknown>,
        suppress,
      )
      const busServer = createGroupBusServer({
        transport: createBroadcastTransport({
          topicID,
          bus: mux.bus,
          wrap: crypto.wrap,
          unwrap: crypto.unwrap,
        }),
        from: localDID,
        eventHandlers,
        requestHandlers,
      })
      const acceptor = createInboxAcceptor<ProtocolDefinition>({
        mux,
        localDID,
        selfInboxTopic: selfInbox,
        resolveSendTopic: (senderDID) => inboxTopic(secret, epoch, senderDID),
        protocol: protocol as ProtocolDefinition,
        handlers: handlers[name] as unknown as ProcedureHandlers<ProtocolDefinition>,
        wrap: crypto.wrap,
        unwrap: crypto.unwrap,
      })
      next.set(name, { client, busServer, acceptor, directed: new Map() })
    }
    runtimes = next
  }

  const teardownEpoch = async (): Promise<void> => {
    // Disposal order is independent across runtimes and within a runtime, so tear
    // everything down concurrently and surface every failure rather than dying
    // on the first.
    const disposals: Array<Promise<unknown>> = []
    for (const runtime of runtimes.values()) {
      for (const directed of runtime.directed.values()) disposals.push(directed.dispose())
      runtime.directed.clear()
      disposals.push(runtime.busServer.dispose())
      disposals.push(runtime.acceptor.dispose())
      disposals.push(runtime.client.dispose())
    }
    runtimes = new Map()
    const results = await Promise.allSettled(disposals)
    const reasons = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))
    if (reasons.length > 0) {
      throw new AggregateError(reasons, 'Group epoch teardown failed')
    }
  }

  const surfaceFor = (name: string): ProtocolSurface<ProtocolDefinition> => {
    const runtime = runtimes.get(name)
    if (runtime == null) throw new Error(`Unknown protocol: ${name}`)
    return {
      dispatch: (prc, data) => runtime.client.dispatch(prc, data),
      request: (prc, prm, options) => runtime.client.request(prc, prm, options),
      gather: (prc, prm, options) => runtime.client.gather(prc, prm, options),
      to: (memberDID) => {
        const cached = runtime.directed.get(memberDID)
        if (cached != null) return cached.client
        const created = createDirectedClient<ProtocolDefinition>({
          mux,
          localDID,
          memberDID,
          secret,
          epoch,
          wrap: crypto.wrap,
          unwrap: crypto.unwrap,
          ...(getRandomID != null ? { getRandomID } : {}),
        })
        runtime.directed.set(memberDID, created)
        return created.client
      },
    }
  }

  const rebuildEpoch = async (): Promise<void> => {
    await teardownEpoch()
    await buildEpoch()
  }

  let commitUnsubscribe: (() => void) | undefined
  let rendezvousUnsubscribe: (() => void) | undefined
  let commitTopicID: string | undefined
  let rendezvousTopicID: string | undefined

  /**
   * The last position in the commit log this peer has PROCESSED — applied, or dropped
   * as stale, foreign or malformed. Not a delivery position: it is only ever read out
   * of a `fetchTopic` result or a log publish (see `cursor.ts`). `null` means the peer
   * has processed nothing, and must read the log from its oldest retained frame.
   */
  let reconciledHead: LogPosition | null = null

  /**
   * The commit log's TIP, as the last complete drain reported it — and the anchor every
   * commit compare-and-sets against.
   *
   * It is NOT the cursor, and conflating them is a defect waiting to happen. The cursor is
   * what this peer has PROCESSED; the head is what the log's last accepted frame IS. They
   * coincide only while every frame on the topic is log-class, which is a property of the
   * store, not of this peer — so the peer names the head for what it is and reads it from
   * the store's own reply, rather than inferring it from a cursor that happens to agree.
   * `null` means the topic has never had an accepted log publish, which is exactly what the
   * first commit of a group's life must compare against.
   */
  let commitLogHead: LogPosition | null = null

  /**
   * The sequenceID of the commit this peer ENACTED at each epoch it has passed — applied
   * from the log, or committed itself and adopted. It is the whole of the fork check: a
   * second, different commit at an epoch this peer holds a record for is two commits at one
   * epoch, which the hub can only have produced by showing different logs to different
   * members.
   *
   * An epoch with NO record is not a fork, it is history — a late joiner, a rejoiner and a
   * re-seeded peer all walk commits from epochs they never held, and a trigger that fired on
   * "an epoch I have passed" would send every one of them into recovery on its first pull.
   *
   * In memory, deliberately. A restart drops the record, and a peer with no record reads
   * history as history: it can MISS a fork, never invent one, and missing one costs a peer
   * that would have healed nothing that the trim and heal triggers do not already cover.
   */
  const appliedByEpoch = new Map<number, string>()

  /**
   * The heal trigger, RECORDED and never awaited where it is found.
   *
   * `recover()` is a lane operation and takes the commit mutex itself, so a pull that awaited
   * it would wait on a tail that includes the pull. The trigger therefore only writes this
   * flag; the pull unwinds, the lane is released, and the heal runs afterwards as its own
   * operation. `healing` is what stops a second wakeup starting a concurrent one.
   */
  let healRequested = false
  let healing = false

  /**
   * A commit this peer journalled, that never landed, and that it cannot re-issue itself:
   * held until a lane operation with a return value can hand it to the host.
   *
   * A delivery wakeup is a lane operation too, and it replays like any other — but it has
   * nowhere to put a loss. Dropping it there would be the one thing that must not happen:
   * for an invite it loses an invitation, and for a remove it leaves an admin believing a
   * member was evicted when they were not.
   */
  let lostCommit: LostCommit | undefined

  /**
   * The ledger entries this peer held when it rejoined — snapshotted BEFORE the rejoined
   * handle replaces them, because a handle that rejoined by external commit holds an EMPTY
   * ledger and there is nothing left to read afterwards.
   *
   * **It is the peer's own LEDGER, and deliberately not its journal.** The obvious reading of
   * "the entries this peer had in flight" is the pending commit it never got an answer for —
   * and that set is always empty by the time a heal runs, because the journal is settled at
   * step 0 of every lane operation, before anything can trigger one: the commit is republished
   * under its original id, the store's dedup says what became of it, and the peer either adopts
   * it or is handed it back as a loss. A heal therefore never coexists with an unsettled
   * journal, and filtering that set would be filtering nothing.
   *
   * What a healing peer actually holds that the group may not is its ledger: the entries it
   * enacted on a branch the group discarded, or enacted and kept while the group moved on
   * without it. Filtering THAT against the group's authenticated ledger is the membership rule
   * exactly as it reads — re-enact an entry if and only if the group's ledger does not already
   * contain it — as one set-difference.
   *
   * `null` means there is no rejoin in progress. It survives a rejoin whose bootstrap failed,
   * so the retry filters the same entries rather than snapshotting an empty ledger and
   * silently dropping every one of them.
   */
  let inFlightEntries: Array<string> | null = null

  /**
   * The entries a heal decided must be re-enacted, waiting for a lane operation with a return
   * value to hand them to the host — the same problem `lostCommit` has, and the same answer.
   *
   * A heal triggered by a pull has nowhere to put them: it is not a call the host made. The
   * host re-enacts them with an ordinary `commit()`, which is a lane operation, so they can
   * never be handed over from inside one.
   */
  let pendingReenact: Array<string> = []

  /**
   * The group's commit mutex, and the serialization of every commit-lane operation
   * through one tail. The compare-and-set resolves races between devices; it says nothing
   * about two callers on this one, and two `build()` calls against a single handle would
   * both frame at that handle's epoch and diverge.
   *
   * It is NOT reentrant: a task that calls `runSerial` again waits on a tail that includes
   * itself. That is why a loss is returned to the host and never handed to it under the
   * lock — the host's answer to a loss is to commit, and a commit takes this mutex.
   */
  let commitTail: Promise<void> = Promise.resolve()
  const runSerial = <T>(fn: () => Promise<T>): Promise<T> => {
    const op = commitTail.then(() => {
      journalReplayed = false
      return fn()
    })
    commitTail = op.then(
      () => {},
      () => {},
    )
    return op
  }

  /**
   * Whether the journal has been replayed in the lane operation now running. Cleared when
   * an operation takes the mutex, set by `replayJournal`, and required by `pullCommits`.
   *
   * The ordering it enforces is the whole of what saves a group of one. A peer that pulls
   * before it replays meets its OWN un-merged commit in the log, and the cursor table's
   * answer to that frame is to heal — from a group that, at creation, has nobody in it to
   * answer. Nothing else catches it: the heal resolves without advancing and without
   * throwing, the replay that follows adopts the commit anyway, and the peer converges. It
   * merely spends a rendezvous and a recovery deadline asking the void for help, silently,
   * on every restart.
   */
  let journalReplayed = false

  // Recovery rendezvous state, keyed by requestID.
  const recoveryWaiters = new Map<string, (groupInfo: Uint8Array | null) => void>()
  const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingReplies = new Map<string, ReturnType<typeof setTimeout>>()
  const suppressedRequests = new Set<string>()
  /**
   * Ledger-gather waiters, keyed by requestID. Unlike a recovery waiter this is called for
   * EVERY reply that arrives, and not just the first: a responder whose ledger fails the
   * head check is a responder that withheld an entry, and the requester falls through to the
   * next reply rather than giving up on the gather.
   */
  const ledgerWaiters = new Map<string, (tokens: Array<string>) => void>()
  const pendingLedgerReplies = new Set<ReturnType<typeof setTimeout>>()

  // Responder: after a jitter delay, answer a recovery request with GroupInfo sealed to the
  // ephemeral key inside the signed request — unless another responder's reply has already
  // been observed (storm-collapse), in which case the scheduled reply is cancelled.
  const handleRecoveryRequest = (request: { requestID: string; request: Uint8Array }): void => {
    const { requestID } = request
    if (mls == null || rendezvousTopicID == null) return
    if (suppressedRequests.has(requestID) || pendingReplies.has(requestID)) return
    const port = mls
    const topicID = rendezvousTopicID
    const timer = setTimeout(() => {
      pendingReplies.delete(requestID)
      void (async () => {
        try {
          // The port verifies the request and checks the requester's leaf against its own
          // current tree. A request it refuses raises, and this peer simply stays silent.
          const groupInfo = await port.sealGroupInfo(request.request)
          // Mailbox class, deliberately: a rendezvous frame must never move the commit
          // topic's head, and its reader — the requester — subscribed before it asked.
          await mux.publish({
            topicID,
            payload: encodeHandshakeFrame(
              HANDSHAKE_KIND.recoveryReply,
              encodeRecoveryReply(requestID, groupInfo),
            ),
          })
        } catch {
          // a refused or failed reply just means another responder (or a retry) covers it
        }
      })()
    }, getReplyDelayMs())
    pendingReplies.set(requestID, timer)
  }

  // Requester + storm-collapse: a reply resolves the local waiter (if any) and
  // suppresses this peer's own pending reply for the same request.
  const handleRecoveryReply = (reply: { requestID: string; groupInfo: Uint8Array }): void => {
    suppressedRequests.add(reply.requestID)
    const replyTimer = pendingReplies.get(reply.requestID)
    if (replyTimer != null) {
      clearTimeout(replyTimer)
      pendingReplies.delete(reply.requestID)
    }
    const waiter = recoveryWaiters.get(reply.requestID)
    if (waiter != null) {
      recoveryWaiters.delete(reply.requestID)
      const timer = recoveryTimers.get(reply.requestID)
      if (timer != null) {
        clearTimeout(timer)
        recoveryTimers.delete(reply.requestID)
      }
      waiter(reply.groupInfo)
    }
  }

  /**
   * Responder: serve this member's WHOLE ordered ledger to a peer that has rejoined and
   * holds none.
   *
   * **Gated on the completeness invariant.** A peer that has itself rejoined and not yet
   * bootstrapped holds an EMPTY ledger, and answering with it would burn a responder in
   * exactly the situation where responders are scarce — the requester's head check rejects
   * it, so it is a wasted round trip rather than a soundness hole, but it is a wasted one.
   *
   * Every responder that CAN answer does — there is no storm-collapse here, on purpose. A
   * lying responder's answer fails the requester's head check, and the requester needs a
   * second answer to fall through to.
   */
  const handleLedgerRequest = (request: { requestID: string }): void => {
    if (mls == null || rendezvousTopicID == null) return
    const port = mls
    const topicID = rendezvousTopicID
    const timer = setTimeout(() => {
      pendingLedgerReplies.delete(timer)
      void (async () => {
        try {
          if (!(await port.isLedgerComplete())) return
          await mux.publish({
            topicID,
            payload: encodeHandshakeFrame(
              HANDSHAKE_KIND.ledgerReply,
              encodeLedgerReply(request.requestID, await port.getLedger()),
            ),
          })
        } catch {
          // a failed reply just means another responder (or a retry) covers it
        }
      })()
    }, getReplyDelayMs())
    pendingLedgerReplies.add(timer)
  }

  const handleLedgerReply = (reply: { requestID: string; tokens: Array<string> }): void => {
    ledgerWaiters.get(reply.requestID)?.(reply.tokens)
  }

  /**
   * Read the commit log forward from the cursor and classify every frame it holds, advancing
   * the cursor over each one it is done with. Returns whether any of them advanced the epoch.
   *
   * This is the only place commit frames are ever read, and the only place the cursor table
   * is applied. Each frame is classified against this peer's state BEFORE anything is
   * applied and before anything is decrypted (see {@link "classify".classifyCommit}); the
   * classification says whether the cursor advances, whether the port is asked, and whether
   * the peer must heal.
   *
   * The cursor advances over a frame the peer is DONE with — applied, walked as history,
   * stepped over as poison — and does NOT advance over one it must read again: an unresolved
   * commit inside its retry budget, or its own un-merged commit. A throw leaves the cursor
   * where it was, and the next pull reads that frame again.
   *
   * It is also the only place the log's tip is learned, and the tip is taken from the
   * store's OWN reply — never inferred from the cursor. It is recorded ONLY on a complete
   * drain, at the points this returns having read the whole log: a tip recorded ahead of the
   * frames it covers would name a commit this peer has not reconciled to, and the next
   * `commit()` would win a compare-and-set at an epoch it had not caught up to. A pull that
   * stops early — on the frame it must heal for — takes no tip at all.
   */
  const pullCommits = async (): Promise<boolean> => {
    if (!journalReplayed) {
      throw new Error(
        'pullCommits: the journal must be replayed first in every lane operation, or a peer that crashed on its own commit heals from it instead of adopting it',
      )
    }
    if (mls == null || commitTopicID == null) return false
    const port = mls
    const topicID = commitTopicID
    let advancedEpoch = false
    // The tip as the reply that drained the log named it. Read from the SAME reply whose
    // frames were processed, so it can never run ahead of them.
    const takeHead = (head: string | null): void => {
      commitLogHead = head == null ? null : asLogPosition(head)
    }
    while (true) {
      const result = await mux.fetchTopic({
        topicID,
        // From the cursor. With no cursor — a fresh member from a Welcome, a peer whose
        // backlog was trimmed, a peer that just rejoined — read from the OLDEST retained
        // frame and process what is there. Seeding from the topic's `head` instead would
        // be a guess: it names commits this peer has never applied, and it is wrong in
        // exactly the case this lane exists for.
        ...(reconciledHead != null ? { after: reconciledHead } : {}),
        limit: COMMIT_FETCH_LIMIT,
      })
      if (result.messages.length === 0) {
        // Drained. The tip an EMPTY page reports is not redundant: a topic keeps its head
        // when its frames age out, so a log that has been swept away entirely still has a
        // tip — and a peer that anchored on its own cursor there would compare-and-set
        // against `null` on a topic whose head is a real sequenceID, and lose forever.
        takeHead(result.head)
        return advancedEpoch
      }
      for (const message of result.messages) {
        // A commit this peer landed moved its cursor to that frame's own position as it was
        // accepted, so an ordinary pull starts after it. The journal is what carries that
        // across a restart. A peer that meets its own commit here is the one whose journal
        // was lost or never written — the last row of the table below.
        const position = asLogPosition(message.sequenceID)
        let frame: ReturnType<typeof decodeHandshakeFrame>
        try {
          frame = decodeHandshakeFrame(message.payload)
        } catch {
          reconciledHead = position // malformed: dropped, and the cursor still steps over it
          continue
        }
        if (frame.kind !== HANDSHAKE_KIND.commit) {
          reconciledHead = position // the commit lane carries commits, and nothing else
          continue
        }
        // Split the frame into the commit and the sealed blob of the bodies it enacts.
        // This reads bytes and decrypts NOTHING: a peer walking the log reaches frames
        // sealed under epochs it does not hold — a late joiner reaches the very commit
        // that added it — and a blob it cannot open is history, not poison. Opening it is
        // a consequence of "I can apply this commit", never a precondition of reading it.
        let commitFrame: CommitFrame
        try {
          commitFrame = decodeCommitFrame(frame.payload)
        } catch {
          reconciledHead = position // malformed: dropped, and the cursor still steps over it
          continue
        }

        // The commit's OWN epoch and its OWN committer, out of the commit's own bytes. Never
        // `message.senderDID`: that is the hub-authenticated publisher of the frame, which is
        // to say the hub's word about who handed it over, and the hub is not trusted here. A
        // hub that could name the committer could stamp every recipient's own DID onto one
        // poison frame and make the entire group heal at once.
        const disposition = classifyCommit(port.readCommitHeader(commitFrame.commit), position, {
          localDID,
          epoch: crypto.epoch(),
          appliedByEpoch,
        })

        if (disposition.row === 'own-unmerged') {
          // This peer's own commit, at the epoch it is still at: the hub took it, the group
          // moved on it, and the pending state died with the process that built it. It can
          // never be applied — MLS merges a pending commit, it does not process one — so the
          // cursor stays put, the drain stops here, no tip is taken, and the peer heals.
          //
          // The trigger only RECORDS. `recover()` takes the commit mutex, and this pull is
          // already holding it.
          healRequested = true
          return advancedEpoch
        }
        if (disposition.row === 'ahead') {
          // The group advanced at an epoch where this peer did not. Step over the frame — the
          // heal is what repairs this, not a re-read — and ask for one.
          reconciledHead = position
          healRequested = true
          continue
        }
        if (disposition.row === 'history') {
          // A frame from an epoch below this peer's that it holds no record for. Not a fork,
          // not poison, and not the port's business: it is never handed over, and its blob is
          // never touched.
          reconciledHead = position
          continue
        }
        if (disposition.row === 'fork') {
          // Two commits at one epoch. The branch whose commit carries the lower sequenceID
          // wins, and the loser rejoins onto it — which is a heal. The winner has nothing to
          // do but step over the frame.
          reconciledHead = position
          if (disposition.branch === 'losing') healRequested = true
          continue
        }
        if (disposition.row === 'poison') {
          reconciledHead = position // not a commit at all: stepped over, and never retried
          continue
        }

        // Framed at this peer's epoch, and somebody else's: a frame it is in a position to
        // apply. Everything below is the port's answer to it.
        const framedEpoch = crypto.epoch()
        let applied: { advanced: boolean }
        try {
          applied = await port.processCommit(commitFrame.commit, {
            senderDID: message.senderDID,
            // The resolver, not the bodies: the blob is opened only if the port asks for
            // the entries this commit names, and it asks only for a commit it is applying —
            // one framed at the epoch this peer is at, which is the epoch the blob is sealed
            // under. That is what makes body delivery atomic with the commit.
            resolveLedgerEntries: createLedgerEntryResolver(
              commitFrame.sealedEntries,
              crypto.unwrap,
            ),
          })
        } catch (error) {
          if (!isMissingLedgerEntries(error)) {
            // The port broke its contract. The cursor stays where it is and the frame is
            // read again — the pull is a retry, and this is not an outcome it can name.
            throw error
          }
          // The commit names ledger entries whose bodies will not resolve. POISON: drop it,
          // advance, and do NOT heal.
          //
          // The bodies ride the commit, sealed under the epoch it is framed at — so a blob
          // this peer cannot open is a blob no member at this epoch can open. If nobody can
          // resolve it, nobody applies it, and the group never moves past that epoch: the
          // frame is dead in the log, the next honest commit is framed at the same epoch and
          // compare-and-sets at the head behind it, and everyone applies that one. The whole
          // cost is a wasted slot in the serialization lane, which any member with write
          // access can burn anyway.
          //
          // Healing here instead would hand any member a group-wide recovery storm for the
          // price of one publish — a commit naming entries whose bodies it simply leaves out
          // of the frame, and every honest peer heals at once. Retrying here, bounded or not,
          // only delays that by the size of the budget. The one case where this peer really
          // is the broken one — everybody else resolved the frame and moved on — announces
          // itself later, and from a different frame: the next commit is then framed at an
          // epoch AHEAD of this peer's, and that is what heals it.
          reconciledHead = position
          continue
        }
        if (applied.advanced) {
          advancedEpoch = true
          // The fork check's record, and the only place it is written from the log.
          appliedByEpoch.set(framedEpoch, position)
        }
        // `{ advanced: false }` here is the port reading a commit at this peer's own epoch,
        // from another member, and REFUSING it: well-formed and deliberately not applied.
        // Poison, on the same terms and for the same reason as an unresolvable one — it
        // advances, it is never retried, and it does not heal.
        reconciledHead = position
      }
      // A short page is the end of the log: every frame this reply named has been
      // processed, so the tip it named is a tip this peer has reconciled to. A full page
      // is not — the tip may be beyond it — so the loop goes round and takes the head from
      // the reply that finally drains.
      if (result.messages.length < COMMIT_FETCH_LIMIT) {
        takeHead(result.head)
        return advancedEpoch
      }
    }
  }

  /** Pull the commit log, and rebuild the app lane if the pull moved the epoch. */
  const reconcileCommits = async (): Promise<void> => {
    const advanced = await pullCommits()
    if (advanced) await rebuildEpoch()
  }

  /**
   * A delivery on the commit topic is a WAKEUP and nothing more. The frames come from
   * the pull, never from the push: an accepted log publish is pushed AND retained, so a
   * peer that also processed the pushed copy would apply every commit twice — once from
   * the push, once from the pull. Its payload is not read here, and its sequenceID is a
   * delivery position, which can never become the cursor.
   */
  const onCommitDelivery = (_message: StoredMessage, ack: () => void): void => {
    ack()
    void runSerial(async () => {
      await ready
      // A wakeup is a lane operation like any other: step 0, the ledger invariant, then the
      // pull. It has no return value, so anything found here is stashed for the next call
      // that has one.
      const replayed = await replayJournal()
      await ensureLedger(Date.now() + recoveryTimeoutMs)
      const pulled = await pullCommits()
      if (replayed || pulled) await rebuildEpoch()
    })
      .catch(() => {
        // the pull failed (e.g. processCommit threw); the cursor did not advance, so the
        // next wakeup reads those frames again
      })
      // Outside the mutex, and only once the pull has released it: a heal is its own lane
      // operation and takes that mutex itself.
      .then(() => healIfRequested())
  }

  const onRendezvousMessage = (message: StoredMessage, ack: () => void): void => {
    ack()
    if (mls == null) return
    let frame: ReturnType<typeof decodeHandshakeFrame>
    try {
      frame = decodeHandshakeFrame(message.payload)
    } catch {
      return // malformed frames are dropped
    }
    try {
      if (frame.kind === HANDSHAKE_KIND.recoveryRequest) {
        handleRecoveryRequest(decodeRecoveryRequest(frame.payload))
      } else if (frame.kind === HANDSHAKE_KIND.recoveryReply) {
        handleRecoveryReply(decodeRecoveryReply(frame.payload))
      } else if (frame.kind === HANDSHAKE_KIND.ledgerRequest) {
        handleLedgerRequest(decodeLedgerRequest(frame.payload))
      } else if (frame.kind === HANDSHAKE_KIND.ledgerReply) {
        handleLedgerReply(decodeLedgerReply(frame.payload))
      }
    } catch {
      // malformed payloads are dropped
    }
  }

  const initControlLanes = async (): Promise<void> => {
    if (mls == null) return
    const recoverySecret = await mls.exportRecoverySecret()
    commitTopicID = commitTopic(recoverySecret)
    rendezvousTopicID = rendezvousTopic(recoverySecret)
    // Both topics are subscribed once for the peer's whole life — deliberately NOT
    // rebuilt on resync, so a peer stranded on a stale epoch still shares both
    // rendezvous with the live group. Released only on dispose.
    //
    // Subscribe BEFORE the first pull: the hub gates a topic fetch on the caller's own
    // subscription, and the subscription is also what asks it to hold the log.
    commitUnsubscribe = mux.onInbound(commitTopicID, onCommitDelivery, {
      retention: commitLogRetentionSeconds,
    })
    rendezvousUnsubscribe = mux.onInbound(rendezvousTopicID, onRendezvousMessage)
    // Then seed the cursor by READING the log — the commits published before this peer
    // subscribed are exactly the ones no push will ever bring it.
    //
    // The seed is a lane operation, so the journal is replayed AHEAD of it: a peer coming
    // up after a crash has to settle its own pending commit before it reads a log that
    // may contain it. Neither step rebuilds the epoch — buildEpoch runs next and reads
    // whatever epoch they left the group at.
    await runSerial(async () => {
      await replayJournal()
      // A peer restored with an incomplete ledger is a peer that was killed between rejoining
      // and bootstrapping: its handle came back with an empty ledger against a live head, and
      // nothing remembers that it was ever mid-heal. The invariant is what finds it, here and
      // at every later lane operation, with no memory of how it got there.
      await ensureLedger(Date.now() + recoveryTimeoutMs)
      await pullCommits()
    }).catch(() => {
      // a failed seed leaves the cursor where it was; the next wakeup replays and pulls again
    })
  }

  /**
   * Frame a commit for the log: `[commit][wrap(bodies)]`, the bodies sealed under the
   * epoch secret the commit is FRAMED at — the epoch every member that can apply it is at,
   * and the one this group is still at until the commit is adopted. A host that adopted
   * first has rotated past it and can seal them for nobody, so it is told, rather than
   * publishing a blob no member can open.
   */
  const frameCommit = async (commit: Uint8Array, bodies: Array<string>): Promise<Uint8Array> => {
    if (crypto.epoch() !== epoch) {
      throw new Error(
        'commit: the local group has already advanced past the epoch this commit was framed at. A commit is adopted in onAccepted, never before.',
      )
    }
    const sealedEntries = await crypto.wrap(encodeLedgerEntries(bodies))
    return encodeHandshakeFrame(HANDSHAKE_KIND.commit, encodeCommitFrame(commit, sealedEntries))
  }

  /**
   * Step 0 of every lane operation, strictly ahead of the pull. Settle any journalled
   * commit: adopt it if the slot records that it landed, and otherwise republish it under
   * its ORIGINAL publishID and expectedHead and let the store's idempotency decide what
   * happened to it — no responder, no network peer, no rendezvous.
   *
   * Ahead of the pull because the ordering is load-bearing: a peer that pulls first meets
   * its own un-merged commit in the log and has to reason about a frame it produced and
   * never adopted, which is the expensive path the journal exists to avoid.
   *
   * Returns whether it moved the epoch. Any loss is stashed, not thrown and not called
   * back: it is the host's to act on, and its action is to commit.
   */
  const replayJournal = async (): Promise<boolean> => {
    journalReplayed = true
    if (mls == null || journal == null || commitTopicID == null) return false
    const entry = await journal.get()
    if (entry == null) return false

    if (entry.acceptedAs != null) {
      // It landed, and this peer wrote that down before it adopted. There is nothing to ask
      // anyone: no republish, no re-seal, no network. The recorded sequenceID is both the
      // last position this peer processed and the log's tip as of that frame — a stale tip
      // is safe, because a commit that races it simply loses the compare-and-set and
      // rebases, where a WRONG one would win a race it had no right to.
      const accepted = asLogPosition(entry.acceptedAs)
      reconciledHead = accepted
      commitLogHead = accepted
      appliedByEpoch.set(entry.epoch, accepted)
      await adoptJournalled(entry.journal)
      await journal.clear(entry.publishID)
      return true
    }

    // Republishing means RE-SEALING the bodies, and they can only be sealed under the epoch
    // the host's handle is at now. That is the epoch the commit was framed at only while
    // onAccepted is the sole place the host adopts — and an entry whose acceptance was never
    // recorded, at any other epoch, is proof that it is not. Sealing anyway would publish a
    // blob no member can open and wedge the lane for the whole group, so the peer refuses
    // and keeps the slot.
    if (crypto.epoch() !== entry.epoch) {
      throw new JournalEpochError(
        `commit replay: the journalled commit was framed at epoch ${entry.epoch}, and this group is now at ${crypto.epoch()}. A commit is adopted in onAccepted, and nowhere else.`,
      )
    }

    const payload = await frameCommit(entry.commit, entry.bodies)
    let sequenceID: string
    try {
      sequenceID = (
        await mux.publish({
          topicID: commitTopicID,
          payload,
          retain: 'log',
          expectedHead: entry.expectedHead,
          publishID: entry.publishID,
        })
      ).sequenceID
    } catch (error) {
      if (!isHeadMismatch(error)) {
        // The outcome is UNKNOWN — the hub may have accepted this and failed to say so.
        // Leave the slot exactly as it is: the next lane operation asks again.
        throw error
      }
      // It never landed, and someone else's commit is at the head now. There is no
      // `build()` to call again: the process that held it is gone. So hand back what
      // survived, and clear the slot — the notice is what must not be lost, never the
      // slot that must be kept.
      await journal.clear(entry.publishID)
      lostCommit =
        entry.kind === 'ledger' ? { kind: 'ledger', tokens: entry.bodies } : { kind: entry.kind }
      return false
    }
    // Accepted — either just now, or by the process that published it and then died. The
    // store's dedup record makes those two indistinguishable, and that is the point.
    //
    // Record the acceptance BEFORE adopting, for the same reason `commit()` does: adopting
    // moves the handle past the epoch this commit was framed at, and a crash between the
    // two would leave a journalled commit that looks exactly like a host that adopted out
    // of band. Written first, this replay is idempotent — the next one adopts from the slot
    // and never republishes.
    await journal.markAccepted(entry.publishID, sequenceID)
    // This peer's own accepted frame is BOTH: the last thing it processed, and the log's
    // tip. Two names for one position here, because for this one frame they genuinely
    // coincide — and a `commit()` straight after a `replay()` would otherwise anchor on a
    // tip from before its own commit landed.
    const accepted = asLogPosition(sequenceID)
    reconciledHead = accepted
    commitLogHead = accepted
    appliedByEpoch.set(entry.epoch, accepted)
    await adoptJournalled(entry.journal)
    await journal.clear(entry.publishID)
    return true
  }

  /**
   * Hand the host what a lane operation found and cannot act on itself — this operation's, or
   * an earlier wakeup's. Both halves are the same situation: work that survived a commit that
   * did not, which only the host can re-issue.
   */
  const takeLost = (): LaneResult => {
    const lost = lostCommit
    lostCommit = undefined
    const reenact = pendingReenact
    pendingReenact = []
    return {
      ...(lost != null ? { lost } : {}),
      ...(reenact.length > 0 ? { reenact } : {}),
    }
  }

  /**
   * The ledger completeness invariant, checked before every lane operation and repaired on
   * the spot. It is purely local — the head folded from the entries the handle holds against
   * the authenticated head the handle's own group state carries — and it needs no memory of
   * how the peer got here, which is what makes the state it detects self-healing.
   *
   * A handle that rejoined by external commit holds an EMPTY ledger against a live head, and
   * that is not a neutral starting point: the roster folds from the entries, so with none of
   * them the creator is admin and nobody else is. Every admin promoted since is invisible, and
   * the peer will REJECT the next commit any of them authors — it does not merely lack
   * history, it re-strands itself. A crash between the rejoin and the bootstrap leaves exactly
   * that state on disk, and this is what finds it again on the next lane operation, at
   * startup or later, with nothing having remembered anything.
   *
   * Returns whether the ledger is complete when it is done. It never throws: an incomplete
   * ledger is a persistent, retryable, degraded state, not an error the host can do anything
   * about.
   */
  const ensureLedger = async (deadline: number): Promise<boolean> => {
    if (mls == null || rendezvousTopicID == null) return true
    const port = mls
    const topicID = rendezvousTopicID
    if (await port.isLedgerComplete()) return true

    // Gather the WHOLE ordered ledger — not "the missing ids", which nothing enumerates: the
    // authenticated head is a chain digest, not a list, and the rejoined handle has no entries
    // to diff against. Every responder that holds a complete ledger answers, and each answer
    // is checked against the head this handle already carries: a lying responder can withhold,
    // never rewrite, and one that fails the check is dropped for the next reply.
    const requestID = newPublishID()
    return await new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (complete: boolean): void => {
        if (settled) return
        settled = true
        ledgerWaiters.delete(requestID)
        clearTimeout(timer)
        resolve(complete)
      }
      const timer = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()))
      ledgerWaiters.set(requestID, (tokens) => {
        void (async () => {
          if (settled) return
          try {
            await port.bootstrapLedger(tokens)
            finish(true)
          } catch {
            // The recomputed head does not match the authenticated one: this responder
            // withheld, reordered or truncated an entry. Nothing was folded. Wait for the
            // next reply — an honest responder's answer is still coming.
          }
        })()
      })
      void mux
        .publish({
          topicID,
          payload: encodeHandshakeFrame(
            HANDSHAKE_KIND.ledgerRequest,
            encodeLedgerRequest(requestID),
          ),
        })
        .catch(() => {})
    })
  }

  /**
   * Commit to the group, rebasing until it lands or the deadline passes. Runs under the
   * commit mutex for its whole life, so `build()` never races another `build()` on this
   * device against the same handle.
   */
  const commit = async (build: () => Promise<PendingCommit>): Promise<LaneResult> => {
    await ready
    if (mls == null || journal == null || commitTopicID == null) {
      throw new Error('commit: this peer has no MLS port, so it has no group to commit to')
    }
    const slot = journal
    const topicID = commitTopicID
    const op = runSerial(async () => {
      // 0. Replay the journal, ahead of the pull.
      if (await replayJournal()) await rebuildEpoch()
      // 0.5. And repair the ledger if it is incomplete — a rejoin whose bootstrap never
      //      finished leaves a handle whose roster has reset, and a commit built on one would
      //      be built against a group this peer cannot see the admins of.
      await ensureLedger(Date.now() + recoveryTimeoutMs)

      const deadline = Date.now() + commitDeadlineMs
      for (let attempt = 0; attempt < COMMIT_ATTEMPT_CEILING; attempt++) {
        // 1. Pull the log to the end. The peer has now processed every frame in it, and
        //    learned the tip it must race at from the store's own reply.
        await reconcileCommits()

        // A pull that ended in a heal trigger did NOT reach the end of the log, and the tip
        // it holds is stale. Unwind, rather than race a head this peer has not reconciled
        // to: the lane is released here, the heal runs as its own operation, and the host's
        // commit is a later one. Retrying inside this loop would hold the mutex that the
        // heal needs and spin until the deadline.
        if (healRequested) {
          throw new RecoveryRequiredError(
            'commit: the log holds a frame this peer cannot reconcile with — its own un-merged commit, or a commit from an epoch ahead of it. It must recover before it can commit again.',
          )
        }

        // 2. Build against the host's CURRENT handle, adopting nothing. `build` is a
        //    closure over that handle, so a rebased retry frames at the rebased epoch.
        const pending = await build()

        // 3. Journal BEFORE publishing, and durably: from here to the hub's answer is the
        //    window a crash can land in, and the slot is the only thing that survives it.
        //
        //    The anchor is the log's TIP, not this peer's cursor. The cursor names the last
        //    frame the peer PROCESSED, and a frame it processed need not be one the head can
        //    ever name — so anchoring there stakes every commit on the two never diverging,
        //    which is a property of the store and not of this peer.
        const publishID = newPublishID()
        const expectedHead = commitLogHead
        const framedEpoch = crypto.epoch()
        const payload = await frameCommit(pending.commit, pending.bodies)
        await slot.put({
          publishID,
          expectedHead,
          // The epoch this commit is framed at, and the only one its bodies can be sealed
          // under. A replay that finds itself at any other epoch, with no recorded
          // acceptance, knows the host adopted somewhere it must not have.
          epoch: framedEpoch,
          commit: pending.commit,
          bodies: pending.bodies,
          kind: pending.kind,
          journal: pending.journal,
        })

        // 4. Publish, conditional on the head the pull reached.
        let sequenceID: string
        try {
          sequenceID = (
            await mux.publish({ topicID, payload, retain: 'log', expectedHead, publishID })
          ).sequenceID
        } catch (error) {
          if (!isHeadMismatch(error)) {
            // Unknown outcome: the frame may be in the log. The slot STAYS — the next lane
            // operation replays it and asks the store which it was.
            throw error
          }
          // 6. Lost the compare-and-set: someone else committed first. This is the
          //    expected path, not an error path. Drop the pending commit untouched —
          //    discarding costs nothing, and the pre-commit key material is retained —
          //    clear the slot, and go back to step 1 against the winner.
          await slot.clear(publishID)
          if (Date.now() >= deadline) {
            throw new CommitDeadlineError(
              `commit: still rebasing after ${commitDeadlineMs}ms and ${attempt + 1} attempts`,
            )
          }
          continue
        }

        // 5. Accepted. Record it in the slot BEFORE the host adopts, while the group is
        //    still at the epoch this commit was framed at. That ordering is what makes a
        //    crash legible: an entry carrying its acceptance is a commit that landed and
        //    can simply be adopted on restart, and an entry carrying none, at an epoch past
        //    the one it was framed at, is a host that adopted somewhere other than
        //    `onAccepted`. Recorded after the adopt, the two would be indistinguishable and
        //    the peer would have to re-seal a commit it cannot seal for anyone.
        await slot.markAccepted(publishID, sequenceID)

        // The commit is the group's now — and this frame is both the last position this
        // peer processed and the log's new tip.
        const accepted = asLogPosition(sequenceID)
        reconciledHead = accepted
        commitLogHead = accepted
        // A commit this peer made and adopted is a commit it enacted at that epoch, exactly
        // as an applied one is, so it joins the fork record on the same terms. Without it a
        // second commit at an epoch this peer OWNS would read as history.
        appliedByEpoch.set(framedEpoch, accepted)
        await pending.onAccepted()
        await slot.clear(publishID)
        await rebuildEpoch()
        return takeLost()
      }
      throw new CommitDeadlineError(
        `commit: gave up after ${COMMIT_ATTEMPT_CEILING} attempts inside its deadline`,
      )
    })
    // A heal the pull asked for runs once this operation has released the lane, and never
    // inside it: the host is told its commit did not land, and the peer repairs itself.
    void op.catch(() => {}).then(() => healIfRequested())
    return op
  }

  const replay = async (): Promise<LaneResult> => {
    await ready
    return runSerial(async () => {
      if (await replayJournal()) await rebuildEpoch()
      await ensureLedger(Date.now() + recoveryTimeoutMs)
      return takeLost()
    })
  }

  /**
   * Ask the group for its state and wait for one member to answer, bounded by the deadline.
   * `null` when nobody does — heal is a rendezvous, and without a responder it cannot work.
   */
  const requestGroupInfo = async (
    request: Uint8Array,
    requestID: string,
    topicID: string,
    deadline: number,
  ): Promise<Uint8Array | null> => {
    const wait = Math.max(0, Math.min(recoveryTimeoutMs, deadline - Date.now()))
    return await new Promise<Uint8Array | null>((resolve) => {
      recoveryWaiters.set(requestID, resolve)
      recoveryTimers.set(
        requestID,
        setTimeout(() => {
          recoveryTimers.delete(requestID)
          if (recoveryWaiters.delete(requestID)) resolve(null)
        }, wait),
      )
      void Promise.resolve(
        mux.publish({
          topicID,
          payload: encodeHandshakeFrame(
            HANDSHAKE_KIND.recoveryRequest,
            encodeRecoveryRequest(requestID, request),
          ),
        }),
      ).catch(() => {})
    })
  }

  /**
   * The commit log's TIP, from the store's own reply — the head an external commit races at.
   *
   * It is deliberately NOT the cursor, and this is the one place the two must come apart: a
   * peer that heals is by definition one that cannot process the frames at the head. Its
   * cursor is stuck behind them and always will be, and a rejoin anchored there would lose
   * the compare-and-set forever. The external commit rebuilds this peer's place in the tree
   * from a GroupInfo that already describes the head, so racing there is exactly right.
   */
  const readCommitHead = async (topicID: string): Promise<LogPosition | null> => {
    const result = await mux.fetchTopic({
      topicID,
      ...(reconciledHead != null ? { after: reconciledHead } : {}),
      limit: 1,
    })
    return result.head == null ? null : asLogPosition(result.head)
  }

  /**
   * Heal by external-commit rejoin: a top-level lane operation, with a compare-and-set loop
   * of its own. It NEVER calls `commit()`, and `commit()` never calls it — both take the same
   * non-reentrant mutex, so either nesting deadlocks, and the re-enactment a heal owes the
   * group is a SUBSEQUENT `commit()` the host makes once this has released the lane.
   */
  const recover = async (): Promise<{ advanced: boolean; reenact: Array<string> }> => {
    await ready
    if (mls == null || commitTopicID == null || rendezvousTopicID == null) {
      return { advanced: false, reenact: [] }
    }
    const port = mls
    const commits = commitTopicID
    const rendezvous = rendezvousTopicID
    return runSerial(async () => {
      // 0. Replay the journal, ahead of everything, exactly as every other lane operation
      //    does: a peer holding a commit whose fate it never learned settles that first, and
      //    may well find it has nothing left to heal.
      if (await replayJournal()) await rebuildEpoch()

      const deadline = Date.now() + recoveryDeadlineMs
      while (Date.now() < deadline) {
        // 1. Pull to the end. It may resolve the strand outright — the frames this peer was
        //    missing may simply be there — and a heal it no longer needs is a heal it must
        //    not do: the external commit would rotate the tree for the whole group.
        //
        //    Rebuild if it moved the epoch, before anything is framed: the peer that lost a
        //    heal race applies the winner's commit HERE, and a frame sealed against an app
        //    lane that had not caught up would be sealed under an epoch the group has left.
        healRequested = false
        await reconcileCommits()

        // 2. The head to race at, read from the store's own reply.
        const expectedHead = await readCommitHead(commits)

        // 3. Mint a request and rendezvous for a sealed GroupInfo. A fresh request per
        //    attempt: the ephemeral key is minted with it, and a reply to a request this peer
        //    has already used is a reply it can no longer open.
        const requestID = newPublishID()
        const request = await port.createRecoveryRequest(requestID)
        const sealed = await requestGroupInfo(request, requestID, rendezvous, deadline)
        if (sealed == null) {
          // Nobody answered. Heal REQUIRES another member that is online, holds the group and
          // can seal a GroupInfo; without one it cannot work, and there is nothing to throw
          // about. The peer stays degraded and asks again later.
          break
        }

        // 4. Open it and BUILD the external commit — adopting nothing. Bytes this peer cannot
        //    open are a hub-injected or misaddressed reply: ask again.
        let pending: Awaited<ReturnType<typeof port.applyRecovery>>
        try {
          pending = await port.applyRecovery(sealed, requestID)
        } catch {
          pending = null
        }
        if (pending == null) continue

        // 5. The entries this peer holds, snapshotted BEFORE the rejoined handle replaces
        //    them. It is the last moment they can be read: the handle a rejoin derives holds
        //    an EMPTY ledger. Kept across a failed attempt, so a retry filters the same
        //    entries rather than snapshotting the empty ledger a failed bootstrap left.
        if (inFlightEntries == null) inFlightEntries = await port.getLedger()
        const inFlight = inFlightEntries

        // 6. Publish the external commit, compare-and-set at the head. It changes the ratchet
        //    tree, so it is a commit like any other and races like one — publishing it
        //    unconditionally would re-open the very fork the log's compare-and-set closes, on
        //    the worst possible path.
        const publishID = newPublishID()
        const payload = await frameCommit(pending.commit, [])
        let sequenceID: string
        try {
          sequenceID = (
            await mux.publish({
              topicID: commits,
              payload,
              retain: 'log',
              expectedHead,
              publishID,
            })
          ).sequenceID
        } catch (error) {
          if (!isHeadMismatch(error)) throw error
          // Lost the race — the likely outcome, not the edge case. DISCARD THE GROUPINFO, and
          // not merely the commit built from it: it describes a ratchet tree the winning
          // commit has already changed, so a commit rebuilt from it is one no member at the
          // new epoch can apply. The peer would publish, adopt, and believe it had rejoined a
          // group that never took its leaf. Re-request, and rebuild from a fresh one.
          continue
        }

        // 7. Accepted: the group has this peer's new leaf. Adopt the rejoined handle — the
        //    only place it may be adopted. Deliberately UNJOURNALLED: a crash here leaves an
        //    orphaned external commit in the log, and that repairs itself. On restart the
        //    orphan is framed at the group's epoch and not at this peer's, so the own-commit
        //    trigger — which tests authorship AND current epoch — stays quiet; the original
        //    heal condition still holds, the peer rejoins again, and `resync` collects the
        //    leaf the orphan added. Leaves do not accumulate.
        const rejoinedAtEpoch = port.readCommitHeader(pending.commit)?.epoch
        await pending.onAccepted()
        const accepted = asLogPosition(sequenceID)
        reconciledHead = accepted
        commitLogHead = accepted
        // A commit this peer enacted at that epoch, on the same terms as an applied one:
        // without the record, a second commit at that epoch reads as history rather than the
        // fork it is.
        if (rejoinedAtEpoch != null) appliedByEpoch.set(rejoinedAtEpoch, sequenceID)
        healRequested = false
        await rebuildEpoch()

        // 8. Bootstrap: REQUIRED, and not a formality. Until it runs, this handle's ledger is
        //    empty against a live head, which is a roster reset — every admin promoted since
        //    genesis is invisible to it and its next commit would be rejected. Failure here is
        //    a persistent degraded state and NOT a heal: the peer keeps the condition, keeps
        //    the entries it snapshotted, and never reports itself advanced with a ledger it
        //    knows is incomplete.
        if (!(await ensureLedger(deadline))) {
          healRequested = true
          return { advanced: false, reenact: [] }
        }

        // 9. Re-enact by MEMBERSHIP, and never by the failure that brought this peer here.
        //    Bootstrap has just fetched the whole ordered, head-verified ledger, so the filter
        //    is local and free: keep only the entries the group's ledger does NOT hold.
        //
        //    An entry it DOES hold was enacted for everyone — that is what being in the
        //    authenticated ledger means — and appending it again would put it at the END of
        //    the log, where the fold is last-write-wins by position. It would win, reverting
        //    whatever a later admin wrote over the same subject, with no error, no conflict,
        //    and no signal anywhere. A token's content id is its digest, so token equality IS
        //    id equality, and this set-difference is the id set-difference.
        const held = new Set(await port.getLedger())
        const reenact = inFlight.filter((token) => !held.has(token))
        inFlightEntries = null
        return { advanced: true, reenact }
      }
      return { advanced: false, reenact: [] }
    })
  }

  /**
   * Run a heal the lane asked for — and never from inside the lane. `recover()` is a lane
   * operation and takes the commit mutex, so the trigger records and the caller runs this
   * once it has released it. A heal already in flight absorbs any trigger raised while it
   * runs: the frame that raised it is still in the log, and the next pull raises it again if
   * the heal did not settle it.
   */
  const healIfRequested = async (): Promise<void> => {
    if (!healRequested || healing) return
    healing = true
    healRequested = false
    try {
      // A heal the peer decided on by itself is still two commits, and the second one is the
      // host's. It has no return value to put the entries in, so they wait for a lane
      // operation that has one — the same treatment a lost commit gets, for the same reason.
      const { reenact } = await recover()
      if (reenact.length > 0) pendingReenact = [...pendingReenact, ...reenact]
    } catch {
      // No responder, or a reply that would not open. The peer stays degraded, and the frame
      // that asked for the heal is still in the log: the next pull asks again.
    } finally {
      healing = false
    }
  }

  const ready = (async () => {
    await initControlLanes()
    await buildEpoch()
  })()
  // A failed init rejects every public call, but must not raise an unhandled rejection
  // before the first of them is made.
  const settled = ready.catch(() => {})
  // The seed pull runs inside init, and it is where the crash victim whose journal was lost
  // meets its own un-merged commit. Its heal waits for init to finish, because every lane
  // operation — `recover()` included — waits on `ready`.
  void settled.then(() => healIfRequested())
  const withReady = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    await ready
    return fn()
  }

  return {
    protocol: <K extends keyof Protocols>(name: K) => {
      const key = String(name)
      return {
        dispatch: (prc, data) => withReady(() => surfaceFor(key).dispatch(prc, data)),
        request: (prc, prm, options) => withReady(() => surfaceFor(key).request(prc, prm, options)),
        gather: (prc, prm, options) => withReady(() => surfaceFor(key).gather(prc, prm, options)),
        to: (memberDID) => surfaceFor(key).to(memberDID),
      } as ProtocolSurface<Protocols[K]>
    },
    commit,
    replay,
    recover,
    resync: async () => {
      await ready
      await rebuildEpoch()
    },
    dispose: async () => {
      // Tear down even a peer whose init failed — it still holds a hub drain.
      await settled
      commitUnsubscribe?.()
      rendezvousUnsubscribe?.()
      for (const timer of recoveryTimers.values()) clearTimeout(timer)
      for (const timer of pendingReplies.values()) clearTimeout(timer)
      for (const timer of pendingLedgerReplies) clearTimeout(timer)
      recoveryTimers.clear()
      pendingReplies.clear()
      pendingLedgerReplies.clear()
      ledgerWaiters.clear()
      suppressedRequests.clear()
      await teardownEpoch()
      await mux.dispose()
    },
  }
}
