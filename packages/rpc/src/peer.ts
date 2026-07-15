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
 * How long `recover()` keeps rejoining before giving up and leaving the peer degraded. A
 * deadline, like `commit()`'s, not an attempt count: losing the compare-and-set is the LIKELY
 * case, since a heal runs under commit pressure and two peers healing at once race each other.
 */
const DEFAULT_RECOVERY_DEADLINE_MS = 30_000

/**
 * How long the hub is asked to keep the commit log. Bounds how long a member may be offline and
 * still converge by pulling alone, without another member awake to heal it.
 */
const DEFAULT_COMMIT_LOG_RETENTION_SECONDS = 30 * 24 * 60 * 60

/** How many commit frames a single pull asks for. Pull loops until the log is drained. */
const COMMIT_FETCH_LIMIT = 100

/**
 * How long `commit` keeps rebasing before giving up. A deadline, not an attempt count: several
 * consecutive lost compare-and-sets on a busy group is ordinary contention.
 */
const DEFAULT_COMMIT_DEADLINE_MS = 30_000

/**
 * Runaway guard only. The deadline is the real bound; this stops a hub that accepts nothing and
 * never advances its head from spinning the loop forever inside a clock tick.
 */
const COMMIT_ATTEMPT_CEILING = 1000

/**
 * Cap on the storm-collapse suppression set. The requestID comes off the wire, so without a bound
 * a hostile relay could replay replies under endless distinct ids and grow the set forever.
 *
 * Eviction is safe at any size: a dropped entry only COSTS a redundant reply, never leaks. A
 * suppression only stops THIS peer scheduling its own reply to a re-delivered request; a reply
 * scheduled after eviction just re-seals current GroupInfo to a requester the port still
 * authorizes against the live roster — a wasted publish a removed requester gets nothing from.
 * The cap sits well above the in-flight request count, so eviction only reaches ids whose
 * requester deadline long passed and which no honest peer asks about again (every attempt mints a
 * fresh id).
 */
const SUPPRESSED_REQUESTS_MAX = 1024

/**
 * The MLS half of a peer: the lifecycle port, the durable journal that carries a pending commit
 * across a crash, and the host hook that adopts one after a restart. They arrive together or not
 * at all — a peer with a port and no journal would silently lose every commit whose process died
 * in the acceptance window, and the type is what stops a host wiring that.
 */
export type GroupPeerMLSParams = {
  /** MLS lifecycle port. When provided, the peer runs the commit lane. */
  mls: GroupMLS
  /** Durable single-slot journal. Written before every publish, cleared on both outcomes. */
  journal: CommitJournal
  /**
   * Adopt a journalled commit now confirmed accepted — the restart half of
   * {@link PendingCommit.onAccepted}, over the same opaque blob: deserialize the post-commit
   * handle, adopt it, deliver any Welcome it carried.
   *
   * MUST be idempotent, as `onAccepted` must: the peer cannot tell an entry whose `onAccepted`
   * already ran from one whose process died before it. The Welcome goes out again, at-least-once
   * and by design — see {@link PendingCommit.onAccepted} for why the sender must not suppress the
   * repeat, and what absorbs it.
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
   * Recovery rendezvous tuning. `timeoutMs`: how long one request waits for a reply. `getDelayMs`:
   * responder reply jitter. `deadlineMs`: how long `recover()` keeps re-requesting and rebuilding
   * before giving up and leaving the peer degraded.
   */
  recovery?: { timeoutMs?: number; getDelayMs?: () => number; deadlineMs?: number }
  /**
   * Commit-log retention the hub is asked to hold, in seconds. Default 30 days. A liveness dial:
   * within it a returning member converges by pulling the log; beyond it, another live member
   * must heal it.
   */
  commitLogRetentionSeconds?: number
  /**
   * How long `commit` rebases before giving up, in ms. Default 30s. Losing a compare-and-set is
   * the expected path, not an error path.
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
   * Commit to the group, rebasing until it lands.
   *
   * The peer replays its journal, pulls the log to the end, calls `build()`, journals the result,
   * and publishes conditionally on the head it pulled to. Win: `onAccepted` runs, slot clears.
   * Lose (someone committed first): drop the pending commit untouched and call `build()` again
   * against the now-current handle — the expected path, not an error path.
   *
   * `build()` produces a commit against the host's CURRENT handle and does not adopt it. Called
   * once per attempt; it MUST read the host's live handle each time and have no side effects until
   * `onAccepted` runs — a losing attempt is discarded whole.
   *
   * Holds the commit mutex for its whole run. The compare-and-set resolves races between devices,
   * not two callers on one: two `build()` calls against a single handle would both frame at that
   * handle's epoch and diverge.
   *
   * A RESULT means it landed and `onAccepted` ran; a THROW means it did not — stranded or ledger
   * incomplete ({@link "commit".RecoveryRequiredError}), or lost the compare-and-set past its
   * deadline ({@link "commit".CommitDeadlineError}). A throw publishes and advances nothing but
   * may leave earlier `lost` / `reenact` work undrained (only the success path returns it) — call
   * {@link replay} after a throw to collect it.
   */
  commit: (build: () => Promise<PendingCommit>) => Promise<LaneResult>
  /**
   * Replay the journal on its own, for startup: republish any pending commit under its original
   * idempotency key and hand back what did not survive. Every lane operation replays first, so
   * this is not the only way a loss surfaces — but it is the one a host can call before anything
   * else, and the collector to call after a `commit()` that threw.
   *
   * Builds and publishes nothing, so unlike `commit()` an incomplete ledger is no hazard: it
   * re-attempts the bootstrap like any lane operation and returns what it holds WITHOUT throwing,
   * leaving the peer degraded until a responder answers. A `{}` result means "no orphaned work to
   * re-issue", never "the peer is whole" — the completeness gate that a reset roster must not
   * commit lives on `commit()`, and `replay()` is the retry that eventually clears it.
   */
  replay: () => Promise<LaneResult>
  /**
   * Heal a peer the group has left behind: rejoin by external commit, refold the ledger, hand
   * back the entries the group's ledger does not already hold.
   *
   * A TOP-LEVEL lane operation with a compare-and-set loop of its own — takes the commit mutex
   * itself, never called from inside another lane operation. The external commit changes the
   * ratchet tree, so it races at the head like any commit; losing (the likely outcome) DISCARDS
   * THE GROUPINFO as well as the commit built from it — the GroupInfo describes a tree the winner
   * already changed, so rebuilding from it would publish a commit no member can apply.
   *
   * A heal is TWO commits: the rejoin carries no entries (a GroupInfo has nowhere to put them), so
   * the entries this peer still owes ride an ordinary `commit()` the CALLER makes after this
   * releases the lane. That is `reenact`, filtered by MEMBERSHIP and never by which failure
   * brought the peer here: re-enact an entry iff the group's authenticated ledger does not already
   * contain it. The ledger does not dedup — a re-appended entry WINS the fold — so re-enacting one
   * the group already holds silently reverts whatever a later admin wrote over it.
   *
   * `{ advanced: false }` when no member answers the rendezvous, and when the rejoin landed but
   * the ledger could not be bootstrapped: an incomplete ledger is a reset roster, and reporting it
   * healed would hand the host a group with every role gone. It stays degraded and retries.
   *
   * A peer merely BEHIND never needs this — it pulls the log and catches up.
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
   * The epoch the app lane is built at, seeded from the handle, not zero. Zero is not neutral:
   * `frameCommit` refuses to seal bodies when the live handle has moved past this, and the first
   * lane operation (the seed: replay then pull) runs BEFORE the app lane is built — so a peer that
   * restarted holding a journalled commit would have its own replay refused at startup by a guard
   * about a host adopting early, and recover only if the host called a lane operation later.
   */
  let epoch = crypto.epoch()

  const buildEpoch = async (): Promise<void> => {
    secret = await crypto.exportSecret()
    epoch = crypto.epoch()
    const next = new Map<string, ProtocolRuntime>()
    for (const [name, protocol] of Object.entries(protocols)) {
      const topicID = protocolTopic(secret, epoch, name)
      // Subscribed for the member's whole life, like the commit and rendezvous topics: a
      // rotation tears down the LISTENERS on an epoch it left, never the subscriptions (the mux
      // guarantees it — nothing there unsubscribes). Unsubscribing tells the hub to drop this
      // member's pending deliveries and free any frame it was the last reader of, so a peer that
      // gave up the subscription as it rotated would delete its own unread messages, and
      // everyone else's copy of them.
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
    // Disposal order is independent, so tear everything down concurrently and surface every
    // failure rather than dying on the first.
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
   * The last commit-log position this peer PROCESSED — applied, or dropped as stale, foreign or
   * malformed. Not a delivery position: read only out of a `fetchTopic` result or a log publish
   * (see `cursor.ts`). `null` means nothing processed — read the log from its oldest retained frame.
   */
  let reconciledHead: LogPosition | null = null

  /**
   * The commit log's TIP as the last complete drain reported it — the anchor every commit
   * compare-and-sets against.
   *
   * NOT the cursor; conflating them is a defect. The cursor is what this peer PROCESSED; the head
   * is what the log's last accepted frame IS. They coincide only while every frame is log-class, a
   * property of the store not this peer — so read the head from the store's own reply, never infer
   * it from a cursor that happens to agree. `null` means the topic never had an accepted log
   * publish, which is what the first commit of a group's life compares against.
   */
  let commitLogHead: LogPosition | null = null

  /**
   * The sequenceID this peer ENACTED at each epoch it passed — applied from the log, or committed
   * and adopted. The whole of the fork check: a second, different commit at an epoch this peer
   * holds a record for is two commits at one epoch, which the hub can only produce by showing
   * different logs to different members.
   *
   * An epoch with NO record is history, not a fork — a late joiner, rejoiner and re-seeded peer
   * all walk commits from epochs they never held, and a trigger on "an epoch I passed" would send
   * every one into recovery on its first pull.
   *
   * In memory, deliberately: a restart drops the record, and a peer with no record reads history
   * as history. It can MISS a fork, never invent one, and a miss costs nothing the trim and heal
   * triggers do not already cover.
   */
  const appliedByEpoch = new Map<number, string>()

  /**
   * The heal trigger, RECORDED and never awaited where found. `recover()` is a lane operation and
   * takes the commit mutex, so a pull that awaited it would wait on a tail including the pull. The
   * trigger only writes this flag; the pull unwinds, releases the lane, and the heal runs
   * afterward as its own operation. `healing` stops a second wakeup starting a concurrent one.
   */
  let healRequested = false
  let healing = false

  /**
   * Positive evidence this peer is off the group's line, and the sole guard on `commit()`. Set
   * when a pull sees proof the peer cannot reconcile: a frame framed AHEAD of its epoch, its OWN
   * un-merged commit at its current epoch, or the LOSING side of a fork.
   *
   * Deliberately NOT `healRequested`: that flag only SCHEDULES the next heal and clears as
   * ordinary control flow (`recover()` clears it at the top of every attempt), so a heal that
   * finds no responder or spends its deadline leaves it false. Gating `commit()` on it would let a
   * peer that just failed to heal win the compare-and-set at a stale epoch and land a commit — a
   * Welcome among them — on a branch of one. This flag survives a failed heal: cleared ONLY when a
   * rejoin actually lands (`recover`), the one thing that rebuilds this peer's place in the tree.
   * No pull can carry a stranded peer back — the frames that would are gone, and the head sits at
   * an epoch it can no longer reach by applying the log.
   *
   * Set on positive evidence, NEVER on poison: a frame this peer stepped over (malformed, refused
   * by policy, or naming unresolvable bodies) is not evidence the group moved on, because nobody
   * applied it either. Gating on poison would rebuild the group-death hazard the classifier's
   * `poison` row refuses: every honest member would refuse to commit at an epoch a body-less frame
   * poisoned, and no one could publish the commit that unsticks the group.
   */
  let stranded = false

  /**
   * A commit this peer journalled, that never landed and it cannot re-issue itself: held until a
   * lane operation with a return value can hand it to the host. A delivery wakeup is a lane
   * operation too but has nowhere to put a loss, and dropping it is the one thing that must not
   * happen — for an invite it loses an invitation, for a remove it leaves an admin believing a
   * member was evicted when they were not.
   */
  let lostCommit: LostCommit | undefined

  /**
   * The ledger entries this peer held when it rejoined — snapshotted BEFORE the rejoined handle
   * replaces them, because a handle that rejoined by external commit holds an EMPTY ledger with
   * nothing left to read.
   *
   * The peer's own LEDGER, deliberately not its journal. The journal is always settled by the
   * time a heal runs (step 0 of every lane operation settles it before anything can trigger one),
   * so filtering it would filter nothing. What a healing peer holds that the group may not is its
   * ledger: entries it enacted on a branch the group discarded, or enacted and kept while the
   * group moved on. Filtering THAT against the group's authenticated ledger is the membership rule
   * as one set-difference: re-enact iff the group's ledger does not already contain it.
   *
   * `null` means no rejoin in progress. Survives a rejoin whose bootstrap failed, so the retry
   * filters the same entries rather than snapshotting an empty ledger and dropping every one.
   */
  let inFlightEntries: Array<string> | null = null

  /**
   * Entries a heal decided must be re-enacted, waiting for a lane operation with a return value —
   * same problem and answer as `lostCommit`. A heal triggered by a pull is not a host call and has
   * nowhere to put them; the host re-enacts with an ordinary `commit()` (a lane operation), so
   * they can never be handed over from inside one.
   */
  let pendingReenact: Array<string> = []

  /**
   * The group's commit mutex: every commit-lane operation serialized through one tail. The
   * compare-and-set resolves races between devices, not two callers here — two `build()` calls
   * against a single handle would both frame at that handle's epoch and diverge.
   *
   * NOT reentrant: a task that calls `runSerial` again waits on a tail including itself. That is
   * why a loss is RETURNED to the host, never handed to it under the lock — the host's answer to a
   * loss is to commit, and a commit takes this mutex.
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
   * Whether the journal has been replayed in the lane operation now running. Cleared when an
   * operation takes the mutex, set by `replayJournal`, required by `pullCommits`.
   *
   * The ordering it enforces saves a group of one. A peer that pulls before it replays meets its
   * OWN un-merged commit in the log, whose classification is to heal — from a group that, at
   * creation, has nobody to answer. Nothing else catches it: the heal resolves without advancing
   * or throwing, the following replay adopts the commit anyway, and the peer converges — having
   * spent a rendezvous and a recovery deadline asking the void for help, silently, every restart.
   */
  let journalReplayed = false

  // Recovery rendezvous state, keyed by requestID.
  const recoveryWaiters = new Map<string, (groupInfo: Uint8Array | null) => void>()
  const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingReplies = new Map<string, ReturnType<typeof setTimeout>>()
  const suppressedRequests = new Set<string>()
  /**
   * Ledger-gather waiters, keyed by requestID. Called for EVERY reply, not just the first: a
   * responder whose ledger fails the head check withheld an entry, so the requester falls through
   * to the next reply rather than giving up.
   */
  const ledgerWaiters = new Map<string, (sealed: Uint8Array) => void>()
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
          // The port verifies the request and checks the requester's leaf against its own current
          // tree. A refused request raises, and this peer stays silent.
          const groupInfo = await port.sealGroupInfo(request.request)
          // Mailbox class, deliberately: a rendezvous frame must never move the commit topic's
          // head, and its reader — the requester — subscribed before it asked.
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
    // Bound the wire-fed set: evict oldest-first over the cap. A Set iterates in insertion order,
    // so the front is the least-recently-added id — the one furthest past its deadline.
    while (suppressedRequests.size > SUPPRESSED_REQUESTS_MAX) {
      const oldest = suppressedRequests.values().next().value
      if (oldest === undefined) break
      suppressedRequests.delete(oldest)
    }
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
   * Responder: serve this member's WHOLE ordered ledger to a rejoined peer that holds none —
   * SEALED to the ephemeral key inside the request's signed blob, and only to a requester the
   * responder's own ratchet tree still holds a leaf for.
   *
   * Both halves are the port's and neither is this lane's to skip: the ledger is the group's whole
   * authority state on a public secretless topic, so a plaintext reply hands every role to the
   * hub and an unauthorized one hands them to any stranger who posts a request. The port refuses a
   * DID with no leaf, and this peer stays silent — a refusal is not an answer.
   *
   * Gated on completeness: a peer that itself rejoined and has not bootstrapped holds an EMPTY
   * ledger, and answering with it wastes a scarce responder (the requester's head check rejects
   * it — a wasted round trip, not a soundness hole).
   *
   * Every responder that CAN answer does — no storm-collapse here, on purpose: a lying responder's
   * answer fails the head check, and the requester needs a second answer to fall through to.
   */
  const handleLedgerRequest = (request: { requestID: string; request: Uint8Array }): void => {
    if (mls == null || rendezvousTopicID == null) return
    const port = mls
    const topicID = rendezvousTopicID
    const timer = setTimeout(() => {
      pendingLedgerReplies.delete(timer)
      void (async () => {
        try {
          if (!(await port.isLedgerComplete())) return
          // The port verifies the request and checks the requester's leaf against its own current
          // tree. A refused request raises, and this peer stays silent.
          const sealed = await port.sealLedger(request.request)
          await mux.publish({
            topicID,
            payload: encodeHandshakeFrame(
              HANDSHAKE_KIND.ledgerReply,
              encodeLedgerReply(request.requestID, sealed),
            ),
          })
        } catch {
          // a refused or failed reply just means another responder (or a retry) covers it
        }
      })()
    }, getReplyDelayMs())
    pendingLedgerReplies.add(timer)
  }

  const handleLedgerReply = (reply: { requestID: string; sealed: Uint8Array }): void => {
    ledgerWaiters.get(reply.requestID)?.(reply.sealed)
  }

  /**
   * Read the commit log forward from the cursor, classify every frame, advance the cursor over
   * each one it is done with. Returns whether any advanced the epoch.
   *
   * The ONLY place commit frames are read and the cursor table applied. Each frame is classified
   * against this peer's state BEFORE anything is applied or decrypted (see
   * {@link "classify".classifyCommit}): the classification says whether the cursor advances, the
   * port is asked, and the peer must heal.
   *
   * The cursor advances over a frame the peer is DONE with — applied, walked as history, or
   * stepped over as poison (a commit whose ledger entries will not resolve is poison: advance,
   * never retry). It does NOT advance over its own un-merged commit, which stops the drain. A
   * throw (port broke its contract on a frame it should have applied) leaves the cursor put and
   * the next pull re-reads that frame.
   *
   * Also the only place the log's tip is learned, taken from the store's OWN reply, never inferred
   * from the cursor. Recorded ONLY on a complete drain: a tip ahead of the frames it covers would
   * name a commit this peer has not reconciled to, and the next `commit()` would win a
   * compare-and-set at an epoch it had not caught up to. Only `own-unmerged` stops the pull early
   * and takes no tip; the `ahead` path steps OVER its frame and drains to the end, so it DOES
   * record the tip (the head is genuinely beyond this peer) — and the `stranded` flag, not a
   * withheld tip, then stops the next `commit()` racing at it.
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
    // The tip from the SAME reply whose frames were processed, so it can never run ahead of them.
    const takeHead = (head: string | null): void => {
      commitLogHead = head == null ? null : asLogPosition(head)
    }
    while (true) {
      const result = await mux.fetchTopic({
        topicID,
        // From the cursor. With no cursor (fresh member from a Welcome, trimmed backlog, just
        // rejoined) read from the OLDEST retained frame. Seeding from the topic's `head` would
        // be a guess: it names commits this peer never applied, wrong in exactly the case this
        // lane exists for.
        ...(reconciledHead != null ? { after: reconciledHead } : {}),
        limit: COMMIT_FETCH_LIMIT,
      })
      if (result.messages.length === 0) {
        // Drained. The tip an EMPTY page reports is not redundant: a topic keeps its head when
        // its frames age out, so a fully swept log still has a tip — and a peer that anchored on
        // its own cursor here would compare-and-set against `null` on a topic whose head is a real
        // sequenceID, and lose forever.
        takeHead(result.head)
        return advancedEpoch
      }
      for (const message of result.messages) {
        // A commit this peer landed moved its cursor to that frame's position on acceptance, so an
        // ordinary pull starts after it (the journal carries that across a restart). A peer that
        // meets its own commit here is one whose journal was lost or never written.
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
        // Split the frame into the commit and the sealed blob of bodies it enacts. Reads bytes,
        // decrypts NOTHING: a peer walking the log reaches frames sealed under epochs it does not
        // hold (a late joiner reaches the commit that added it), and a blob it cannot open is
        // history, not poison. Opening it follows from "I can apply this commit", never precedes
        // reading it.
        let commitFrame: CommitFrame
        try {
          commitFrame = decodeCommitFrame(frame.payload)
        } catch {
          reconciledHead = position // malformed: dropped, and the cursor still steps over it
          continue
        }

        // The commit's OWN epoch and committer, from the commit's own bytes. Never
        // `message.senderDID` — the hub-authenticated publisher, the hub's word about who handed
        // it over, and the hub is not trusted: a hub that could name the committer could stamp
        // every recipient's own DID onto one poison frame and make the whole group heal at once.
        const disposition = classifyCommit(port.readCommitHeader(commitFrame.commit), position, {
          localDID,
          epoch: crypto.epoch(),
          appliedByEpoch,
        })

        if (disposition.row === 'own-unmerged') {
          // This peer's own commit, at the epoch it is still at: the hub took it, the group moved
          // on it, and the pending state died with its process. It can never be applied — MLS
          // merges a pending commit, does not process one — so the cursor stays put, the drain
          // stops, no tip is taken, and the peer heals. The trigger only RECORDS; `recover()`
          // takes the commit mutex this pull already holds.
          healRequested = true
          stranded = true
          return advancedEpoch
        }
        if (disposition.row === 'ahead') {
          // The group advanced at an epoch this peer did not. Step over the frame — the heal
          // repairs this, not a re-read — and ask for one.
          reconciledHead = position
          healRequested = true
          stranded = true
          continue
        }
        if (disposition.row === 'history') {
          // A frame from an epoch below this peer's that it holds no record for. Not a fork, not
          // poison, not the port's business: never handed over, its blob never touched.
          reconciledHead = position
          continue
        }
        if (disposition.row === 'fork') {
          // Two commits at one epoch. The lower-sequenceID branch wins; the loser rejoins onto it
          // (a heal). The winner just steps over the frame.
          reconciledHead = position
          if (disposition.branch === 'losing') {
            healRequested = true
            stranded = true
          }
          continue
        }
        if (disposition.row === 'poison') {
          reconciledHead = position // not a commit at all: stepped over, and never retried
          continue
        }

        // Framed at this peer's epoch, by somebody else: a frame it can apply. Everything below is
        // the port's answer to it.
        const framedEpoch = crypto.epoch()
        let applied: { advanced: boolean }
        try {
          applied = await port.processCommit(commitFrame.commit, {
            senderDID: message.senderDID,
            // The resolver, not the bodies: the blob is opened only if the port asks for the
            // entries this commit names, and it asks only for a commit it is applying — framed at
            // this peer's epoch, which is the epoch the blob is sealed under. That makes body
            // delivery atomic with the commit.
            resolveLedgerEntries: createLedgerEntryResolver(
              commitFrame.sealedEntries,
              crypto.unwrap,
            ),
          })
        } catch (error) {
          if (!isMissingLedgerEntries(error)) {
            // The port broke its contract. The cursor stays and the frame is re-read — the pull is
            // a retry, and this is not an outcome it can name.
            throw error
          }
          // The commit names ledger entries whose bodies will not resolve. POISON: drop, advance,
          // do NOT heal. The bodies ride the commit sealed under its framed epoch, so a blob this
          // peer cannot open is one no member at this epoch can — nobody applies it, the group
          // never moves past that epoch, and the next honest commit is framed at the same epoch
          // and compare-and-sets behind it. Whole cost: a wasted lane slot any writer can burn
          // anyway.
          //
          // Healing here would hand any member a group-wide recovery storm for one publish (a
          // commit naming entries whose bodies it leaves out of the frame). Retrying, bounded or
          // not, only delays that. The one case where this peer really is the broken one
          // (everyone else resolved it and moved on) announces itself later from a different
          // frame: the next commit is then framed AHEAD of this peer's, and that heals it.
          reconciledHead = position
          continue
        }
        if (applied.advanced) {
          advancedEpoch = true
          // The fork check's record; the only place it is written from the log.
          appliedByEpoch.set(framedEpoch, position)
        }
        // `{ advanced: false }` here is the port REFUSING a well-formed commit at this peer's own
        // epoch from another member: poison on the same terms as an unresolvable one — advances,
        // never retried, does not heal.
        reconciledHead = position
      }
      // A short page ends the log: every frame this reply named is processed, so its tip is one
      // this peer has reconciled to. A full page is not — the tip may be beyond it — so loop and
      // take the head from the reply that finally drains.
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
   * A commit-topic delivery is a WAKEUP, nothing more. Frames come from the pull, never the push:
   * an accepted log publish is pushed AND retained, so processing the pushed copy too would apply
   * every commit twice. The payload is not read; its sequenceID is a delivery position and can
   * never become the cursor.
   */
  const onCommitDelivery = (_message: StoredMessage, ack: () => void): void => {
    ack()
    void runSerial(async () => {
      await ready
      // A wakeup is a lane operation: step 0, the ledger invariant, then the pull. No return
      // value, so anything found is stashed for the next call that has one.
      const replayed = await replayJournal()
      await ensureLedger(Date.now() + recoveryTimeoutMs)
      const pulled = await pullCommits()
      if (replayed || pulled) await rebuildEpoch()
    })
      .catch(() => {
        // pull failed (e.g. processCommit threw); the cursor did not advance, so the next wakeup
        // re-reads those frames
      })
      // Outside the mutex, once the pull released it: a heal is its own lane operation and takes
      // that mutex itself.
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
    // Both topics subscribed once for the peer's whole life — NOT rebuilt on resync, so a peer
    // stranded on a stale epoch still shares both rendezvous with the live group. Released only on
    // dispose. Subscribe BEFORE the first pull: the hub gates a topic fetch on the caller's own
    // subscription, and the subscription is also what asks it to hold the log.
    commitUnsubscribe = mux.onInbound(commitTopicID, onCommitDelivery, {
      retention: commitLogRetentionSeconds,
    })
    rendezvousUnsubscribe = mux.onInbound(rendezvousTopicID, onRendezvousMessage)
    // Then seed the cursor by READING the log — commits published before this peer subscribed are
    // exactly the ones no push will bring it. The seed is a lane operation, so the journal replays
    // AHEAD of it: a peer coming up after a crash settles its own pending commit before it reads a
    // log that may contain it. Neither step rebuilds the epoch — buildEpoch runs next.
    await runSerial(async () => {
      await replayJournal()
      // A peer restored with an incomplete ledger was killed between rejoining and bootstrapping:
      // empty ledger against a live head, nothing remembering it was mid-heal. The invariant finds
      // it, here and at every later lane operation, with no memory of how it got there.
      await ensureLedger(Date.now() + recoveryTimeoutMs)
      await pullCommits()
    }).catch(() => {
      // a failed seed leaves the cursor put; the next wakeup replays and pulls again
    })
  }

  /**
   * Frame a commit for the log: `[commit][wrap(bodies)]`, bodies sealed under the epoch secret the
   * commit is FRAMED at — the epoch every member that can apply it is at, and the one this group
   * stays at until the commit is adopted. A host that adopted first has rotated past it and can
   * seal for nobody, so it is told rather than publishing a blob no member can open.
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
   * Step 0 of every lane operation, strictly ahead of the pull. Settle any journalled commit:
   * adopt it if the slot records it landed, else republish under its ORIGINAL publishID and
   * expectedHead and let the store's idempotency decide — no responder, no network, no rendezvous.
   *
   * Ahead of the pull, load-bearing: a peer that pulls first meets its own un-merged commit in the
   * log and must reason about a frame it produced and never adopted — the expensive path the
   * journal exists to avoid.
   *
   * Returns whether it moved the epoch. Any loss is stashed, not thrown or called back: the host's
   * to act on, and its action is to commit.
   */
  const replayJournal = async (): Promise<boolean> => {
    journalReplayed = true
    if (mls == null || journal == null || commitTopicID == null) return false
    const entry = await journal.get()
    if (entry == null) return false

    if (entry.acceptedAs != null) {
      // It landed and this peer recorded that before adopting. Nothing to ask: no republish, no
      // re-seal, no network. The recorded sequenceID is both the last position processed and the
      // log's tip as of that frame — a stale tip is safe (a commit racing it just loses the
      // compare-and-set and rebases), where a WRONG one would win a race it had no right to.
      const accepted = asLogPosition(entry.acceptedAs)
      reconciledHead = accepted
      commitLogHead = accepted
      appliedByEpoch.set(entry.epoch, accepted)
      await adoptJournalled(entry.journal)
      await journal.clear(entry.publishID)
      return true
    }

    // Republishing means RE-SEALING the bodies, sealable only under the host's current epoch. That
    // equals the framed epoch only while onAccepted is the sole place the host adopts — and an
    // entry with no recorded acceptance at any other epoch proves it is not. Sealing anyway
    // publishes a blob no member can open and wedges the lane for the whole group, so the peer
    // refuses and keeps the slot.
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
        // Outcome UNKNOWN — the hub may have accepted and failed to say so. Leave the slot
        // exactly as it is: the next lane operation asks again.
        throw error
      }
      // It never landed and someone else's commit is at the head. There is no `build()` to call
      // again — the process that held it is gone — so hand back what survived and clear the slot:
      // the notice must not be lost, never the slot.
      await journal.clear(entry.publishID)
      lostCommit =
        entry.kind === 'ledger' ? { kind: 'ledger', tokens: entry.bodies } : { kind: entry.kind }
      return false
    }
    // Accepted — just now, or by the process that published it and died; the store's dedup makes
    // those indistinguishable, which is the point.
    //
    // Record acceptance BEFORE adopting, as `commit()` does: adopting moves the handle past the
    // framed epoch, and a crash between the two would leave a journalled commit indistinguishable
    // from a host that adopted out of band. Written first, replay is idempotent — the next one
    // adopts from the slot and never republishes.
    await journal.markAccepted(entry.publishID, sequenceID)
    // This peer's own accepted frame is BOTH the last thing it processed and the log's tip — one
    // position, two names, genuinely coinciding for this one frame; otherwise a `commit()` right
    // after a `replay()` would anchor on a tip from before its own commit landed.
    const accepted = asLogPosition(sequenceID)
    reconciledHead = accepted
    commitLogHead = accepted
    appliedByEpoch.set(entry.epoch, accepted)
    await adoptJournalled(entry.journal)
    await journal.clear(entry.publishID)
    return true
  }

  /**
   * Hand the host what a lane operation found and cannot act on itself — this operation's or an
   * earlier wakeup's: work that survived a commit that did not, which only the host can re-issue.
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
   * The ledger completeness invariant, checked before every lane operation and repaired on the
   * spot. Purely local (the head folded from the handle's entries against the authenticated head
   * its own group state carries) and needs no memory of how the peer got here, which is what makes
   * the state it detects self-healing.
   *
   * A handle that rejoined by external commit holds an EMPTY ledger against a live head, not a
   * neutral start: the roster folds from the entries, so with none the creator is the only admin.
   * Every admin promoted since is invisible and the peer REJECTS the next commit any of them
   * authors — it re-strands itself. A crash between rejoin and bootstrap leaves exactly that on
   * disk, and this finds it on the next lane operation.
   *
   * Returns whether the ledger is complete. Never throws: an incomplete ledger is a persistent,
   * retryable, degraded state, not an error the host can act on.
   */
  const ensureLedger = async (deadline: number): Promise<boolean> => {
    if (mls == null || rendezvousTopicID == null) return true
    const port = mls
    const topicID = rendezvousTopicID
    if (await port.isLedgerComplete()) return true

    // Gather the WHOLE ordered ledger — not "the missing ids", which nothing enumerates: the
    // authenticated head is a chain digest, not a list, and the rejoined handle has no entries to
    // diff. Every responder with a complete ledger answers, each answer checked against the head
    // this handle carries: a lying responder can withhold, never rewrite, and one that fails is
    // dropped for the next reply.
    //
    // The request is the port's signed blob (same one a rejoin carries, same call). It names this
    // peer inside a signature (what a responder authorizes against) and carries an ephemeral
    // public key (the only key a responder seals to). Both matter: without the first any stranger
    // gets the group's whole authority state for one publish; without the second, so does the hub.
    const requestID = newPublishID()
    const request = await port.createRecoveryRequest(requestID)
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
      ledgerWaiters.set(requestID, (sealed) => {
        void (async () => {
          if (settled) return
          try {
            // Bytes this peer cannot open: another member's reply to another request, or a
            // hub-injected forgery. Dropped, gather waits — the per-request key is NOT consumed
            // here, since the next responder's reply is sealed to the same key.
            const tokens = await port.openSealedLedger(sealed, requestID)
            if (tokens == null) return
            await port.bootstrapLedger(tokens)
            finish(true)
          } catch {
            // Recomputed head does not match the authenticated one: this responder withheld,
            // reordered or truncated an entry. Nothing folded. Wait for the next reply.
          }
        })()
      })
      void mux
        .publish({
          topicID,
          payload: encodeHandshakeFrame(
            HANDSHAKE_KIND.ledgerRequest,
            encodeLedgerRequest(requestID, request),
          ),
        })
        .catch(() => {})
    })
  }

  /**
   * Commit to the group, rebasing until it lands or the deadline passes. Runs under the commit
   * mutex for its whole life, so `build()` never races another `build()` on this device.
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
      // 0.5. Refuse on an incomplete ledger. A rejoin whose bootstrap never finished leaves a
      //      reset roster: the fold sees only the genesis creator as admin, every promotion since
      //      is invisible, and a commit built now acts on authority it cannot verify.
      //      `ensureLedger` repairs it in place when a responder answers; when none does it stays
      //      incomplete, and the peer must publish and advance NOTHING.
      //
      //      Same refusal the `stranded` gate below makes. It THROWS rather than returning because
      //      `commit()` returns only when the commit LANDED (onAccepted ran, epoch moved) — a peer
      //      that cannot commit says so by throwing, as for a strand or spent deadline. `recover()`
      //      answers `advanced: false` instead because its contract carries that flag; `commit()`'s
      //      does not. NO heal is scheduled: this peer holds its leaf, so an external-commit rejoin
      //      would rotate the tree for nothing — the gather that just failed for want of a
      //      responder IS the repair, re-running at the head of the next lane operation.
      if (!(await ensureLedger(Date.now() + recoveryTimeoutMs))) {
        throw new RecoveryRequiredError(
          'commit: the ledger is incomplete, so this handle rejoined the group and its bootstrap has not completed — its roster has reset, and a commit built now would be judged against a group whose admins it cannot see. It must finish bootstrapping its ledger before it can commit again.',
        )
      }

      const deadline = Date.now() + commitDeadlineMs
      for (let attempt = 0; attempt < COMMIT_ATTEMPT_CEILING; attempt++) {
        // 1. Pull the log to the end: every frame processed, and the tip to race at learned from
        //    the store's own reply.
        await reconcileCommits()

        // The pull found positive evidence this peer is off the group's line (own un-merged
        // commit, a frame framed ahead, or the losing side of a fork), and that stands whether or
        // not the following heal lands. Unwind rather than race: on the `ahead` path the pull
        // drained to the end and took the live tip, so a commit here would win the compare-and-set
        // at an epoch it never caught up to. The lane releases, the heal runs as its own
        // operation, the host's commit is later. Gating on `stranded` not `healRequested` is what
        // makes this survive a heal that found no responder — a `commit()` right after must refuse.
        if (stranded) {
          throw new RecoveryRequiredError(
            'commit: the log holds a frame this peer cannot reconcile with — its own un-merged commit, or a commit from an epoch ahead of it. It must recover before it can commit again.',
          )
        }

        // 2. Build against the host's CURRENT handle, adopting nothing. `build` closes over that
        //    handle, so a rebased retry frames at the rebased epoch.
        const pending = await build()

        // 3. Journal BEFORE publishing, durably: from here to the hub's answer is the crash
        //    window, and the slot is the only thing that survives it.
        //
        //    Anchor on the log's TIP, not the cursor. The cursor names the last frame PROCESSED,
        //    which need not be one the head can ever name — anchoring there stakes every commit on
        //    the two never diverging, a property of the store not this peer.
        const publishID = newPublishID()
        const expectedHead = commitLogHead
        const framedEpoch = crypto.epoch()
        const payload = await frameCommit(pending.commit, pending.bodies)
        await slot.put({
          publishID,
          expectedHead,
          // The framed epoch, and the only one its bodies can be sealed under. A replay at any
          // other epoch with no recorded acceptance knows the host adopted where it must not have.
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
          // 6. Lost the compare-and-set: someone committed first — the expected path, not an
          //    error. Drop the pending commit untouched (costs nothing, pre-commit key material
          //    retained), clear the slot, and go back to step 1 against the winner.
          await slot.clear(publishID)
          if (Date.now() >= deadline) {
            throw new CommitDeadlineError(
              `commit: still rebasing after ${commitDeadlineMs}ms and ${attempt + 1} attempts`,
            )
          }
          continue
        }

        // 5. Accepted. Record it in the slot BEFORE the host adopts, while the group is still at
        //    the framed epoch. That ordering makes a crash legible: an entry carrying its
        //    acceptance landed and can be adopted on restart; an entry carrying none, at an epoch
        //    past the framed one, is a host that adopted outside `onAccepted`. Recorded after the
        //    adopt, the two would be indistinguishable and the peer would have to re-seal a commit
        //    it can seal for no one.
        await slot.markAccepted(publishID, sequenceID)

        // The commit is the group's now — this frame is both the last position processed and the
        // log's new tip.
        const accepted = asLogPosition(sequenceID)
        reconciledHead = accepted
        commitLogHead = accepted
        // A commit this peer made and adopted was enacted at that epoch, like an applied one, so
        // it joins the fork record on the same terms. Without it a second commit at an epoch this
        // peer OWNS would read as history.
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
    // A heal the pull asked for runs once this operation released the lane, never inside it: the
    // host is told its commit did not land, and the peer repairs itself.
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
   * `null` when nobody does — heal is a rendezvous and cannot work without a responder.
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
   * The commit log's TIP from the store's own reply — the head an external commit races at.
   *
   * Deliberately NOT the cursor, and the one place the two must come apart: a healing peer cannot
   * process the frames at the head, so its cursor is stuck behind them forever, and a rejoin
   * anchored there would lose the compare-and-set forever. The external commit rebuilds this
   * peer's place from a GroupInfo that already describes the head, so racing there is right.
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
   * Heal by external-commit rejoin: a top-level lane operation with a compare-and-set loop of its
   * own. NEVER calls `commit()` and `commit()` never calls it — both take the same non-reentrant
   * mutex, so either nesting deadlocks. The re-enactment a heal owes is a SUBSEQUENT `commit()` the
   * host makes once this releases the lane.
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
      // 0. Replay the journal ahead of everything, as every lane operation does: a peer holding a
      //    commit whose fate it never learned settles that first, and may find nothing left to heal.
      if (await replayJournal()) await rebuildEpoch()

      const deadline = Date.now() + recoveryDeadlineMs
      while (Date.now() < deadline) {
        // 1. Pull to the end. It may resolve the strand outright (the missing frames may just be
        //    there), and a heal it no longer needs must NOT run: the external commit would rotate
        //    the tree for the whole group. Rebuild if it moved the epoch, before anything is
        //    framed: the peer that lost a heal race applies the winner's commit HERE, and a frame
        //    sealed against an app lane that had not caught up would seal under an epoch the group
        //    left.
        healRequested = false
        await reconcileCommits()

        // 2. The head to race at, from the store's own reply.
        const expectedHead = await readCommitHead(commits)

        // 3. Mint a request and rendezvous for a sealed GroupInfo. Fresh request per attempt: the
        //    ephemeral key is minted with it, and a reply to an already-used request is one this
        //    peer can no longer open.
        const requestID = newPublishID()
        const request = await port.createRecoveryRequest(requestID)
        const sealed = await requestGroupInfo(request, requestID, rendezvous, deadline)
        if (sealed == null) {
          // Nobody answered. Heal REQUIRES another online member that holds the group and can seal
          // a GroupInfo; without one it cannot work and there is nothing to throw about. The peer
          // stays degraded and asks again later.
          break
        }

        // 4. Open it and BUILD the external commit, adopting nothing. Bytes this peer cannot open
        //    are a hub-injected or misaddressed reply: ask again.
        let pending: Awaited<ReturnType<typeof port.applyRecovery>>
        try {
          pending = await port.applyRecovery(sealed, requestID)
        } catch {
          pending = null
        }
        if (pending == null) continue

        // 5. The entries this peer holds, snapshotted BEFORE the rejoined handle replaces them —
        //    the last moment they can be read (a rejoin's handle holds an EMPTY ledger). Kept
        //    across a failed attempt, so a retry filters the same entries rather than snapshotting
        //    the empty ledger a failed bootstrap left.
        if (inFlightEntries == null) inFlightEntries = await port.getLedger()
        const inFlight = inFlightEntries

        // 6. Publish the external commit, compare-and-set at the head. It changes the ratchet tree,
        //    so it races like any commit — publishing unconditionally would re-open the very fork
        //    the log's compare-and-set closes, on the worst path.
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
          // Lost the race — the likely outcome. DISCARD THE GROUPINFO, not merely the commit built
          // from it: it describes a ratchet tree the winning commit already changed, so a commit
          // rebuilt from it is one no member at the new epoch can apply, and the peer would
          // publish, adopt, and believe it rejoined a group that never took its leaf. Re-request
          // and rebuild from a fresh one.
          continue
        }

        // 7. Accepted: the group has this peer's new leaf. Adopt the rejoined handle — the only
        //    place it may be adopted. Deliberately UNJOURNALLED: a crash here leaves an orphaned
        //    external commit in the log, which repairs itself. On restart the orphan is framed at
        //    the group's epoch, not this peer's, so the own-commit trigger (tests authorship AND
        //    current epoch) stays quiet; the original heal condition still holds, the peer rejoins
        //    again, and `resync` collects the leaf the orphan added. Leaves do not accumulate.
        const rejoinedAtEpoch = port.readCommitHeader(pending.commit)?.epoch
        await pending.onAccepted()
        const accepted = asLogPosition(sequenceID)
        reconciledHead = accepted
        commitLogHead = accepted
        // Enacted at that epoch, like an applied commit: without the record a second commit at
        // that epoch reads as history rather than the fork it is.
        if (rejoinedAtEpoch != null) appliedByEpoch.set(rejoinedAtEpoch, sequenceID)
        healRequested = false
        // The one place the commit gate is released: the rejoin landed, so this peer's leaf is
        // back in the tree at the group's epoch and the stale-epoch fork it guards is closed. A
        // bootstrap that still fails below is a roster-repair problem `commit()`'s own
        // ledger-completeness check handles — not a reason to keep refusing every commit.
        stranded = false
        await rebuildEpoch()

        // 8. Bootstrap: REQUIRED, not a formality. Until it runs, the ledger is empty against a
        //    live head — a roster reset where every admin promoted since genesis is invisible and
        //    the next commit is rejected. Failure here is a persistent degraded state, NOT a heal:
        //    keep the condition, keep the snapshotted entries, never report advanced with a ledger
        //    known incomplete.
        if (!(await ensureLedger(deadline))) {
          healRequested = true
          return { advanced: false, reenact: [] }
        }

        // 9. Re-enact by MEMBERSHIP, never by the failure that brought this peer here. Bootstrap
        //    just fetched the whole ordered, head-verified ledger, so the filter is local and
        //    free: keep only entries the group's ledger does NOT hold.
        //
        //    An entry it DOES hold was enacted for everyone (that is what the authenticated ledger
        //    means), and appending it again puts it at the END of the log where the fold is
        //    last-write-wins by position: it would win, reverting whatever a later admin wrote over
        //    the same subject, with no error or signal anywhere. A token's content id is its
        //    digest, so token equality IS id equality and this set-difference is the id one.
        const held = new Set(await port.getLedger())
        const reenact = inFlight.filter((token) => !held.has(token))
        inFlightEntries = null
        return { advanced: true, reenact }
      }
      return { advanced: false, reenact: [] }
    })
  }

  /**
   * Run a heal the lane asked for, never from inside the lane. `recover()` takes the commit mutex,
   * so the trigger records and the caller runs this once it releases the mutex. A heal already in
   * flight absorbs any trigger raised while it runs: the frame that raised it is still in the log,
   * and the next pull raises it again if the heal did not settle it.
   */
  const healIfRequested = async (): Promise<void> => {
    if (!healRequested || healing) return
    healing = true
    healRequested = false
    try {
      // Still two commits; the second is the host's. No return value to put the entries in, so
      // they wait for a lane operation that has one — same as a lost commit.
      const { reenact } = await recover()
      if (reenact.length > 0) pendingReenact = [...pendingReenact, ...reenact]
    } catch {
      // No responder, or a reply that would not open. The peer stays degraded, and the frame that
      // asked for the heal is still in the log: the next pull asks again.
    } finally {
      healing = false
    }
  }

  const ready = (async () => {
    await initControlLanes()
    await buildEpoch()
  })()
  // A failed init rejects every public call, but must not raise an unhandled rejection before the
  // first is made.
  const settled = ready.catch(() => {})
  // The seed pull runs inside init, where the crash victim whose journal was lost meets its own
  // un-merged commit. Its heal waits for init to finish, since every lane operation (`recover()`
  // included) waits on `ready`.
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
      // Resolve any in-flight recovery rendezvous FIRST, before clearing its timers. A `recover()`
      // blocked in `requestGroupInfo` is settled by exactly two things — a reply or its timeout —
      // and dispose is about to clear that timeout; drain the waiters here or the heal never
      // settles, `commitTail` never resolves, and every lane operation queued behind it hangs.
      // Resolve, then clear, so a fired timer cannot race a half-drained map. (The ledger gather
      // needs no such drain: its timeout is a local held in none of these maps, so it fires and
      // settles `ensureLedger` on its own.)
      for (const waiter of recoveryWaiters.values()) waiter(null)
      recoveryWaiters.clear()
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
