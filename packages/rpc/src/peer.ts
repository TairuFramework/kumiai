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
  decodeRecoveryReply,
  decodeRecoveryRequest,
  encodeRecoveryReply,
  encodeRecoveryRequest,
} from './recovery.js'
import { commitTopic, inboxTopic, protocolTopic, rendezvousTopic } from './topic.js'

const DEFAULT_RECOVERY_TIMEOUT_MS = 5000
const DEFAULT_RECOVERY_JITTER_MS = 250

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
   * entry whose `onAccepted` already ran from one whose process died before it.
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
  /** Recovery rendezvous tuning. `getDelayMs` is the responder reply jitter. */
  recovery?: { timeoutMs?: number; getDelayMs?: () => number }
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
   * Deep recovery for a peer stranded past the commit log's trim window: request
   * current state on the rendezvous topic, apply the first reply, and resync.
   * Returns whether the epoch advanced. No-op (`advanced:false`) without an MLS
   * port or if no reply arrives before the timeout. A peer that is merely *behind*
   * does not need this — it pulls the commit log and catches up.
   */
  recover: () => Promise<{ advanced: boolean }>
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
  const getReplyDelayMs =
    params.recovery?.getDelayMs ?? (() => defaultJitter(DEFAULT_RECOVERY_JITTER_MS))
  const commitLogRetentionSeconds =
    params.commitLogRetentionSeconds ?? DEFAULT_COMMIT_LOG_RETENTION_SECONDS
  const commitDeadlineMs = params.commitDeadlineMs ?? DEFAULT_COMMIT_DEADLINE_MS
  const mux: HubMux = createHubMux({ hub, localDID })

  let runtimes = new Map<string, ProtocolRuntime>()
  let secret: Uint8Array<ArrayBufferLike> = new Uint8Array()
  let epoch = 0

  const buildEpoch = async (): Promise<void> => {
    secret = await crypto.exportSecret()
    epoch = crypto.epoch()
    const next = new Map<string, ProtocolRuntime>()
    for (const [name, protocol] of Object.entries(protocols)) {
      const topicID = protocolTopic(secret, epoch, name)
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
        selfInboxTopic: inboxTopic(secret, epoch, localDID),
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
    const op = commitTail.then(fn)
    commitTail = op.then(
      () => {},
      () => {},
    )
    return op
  }

  // Recovery rendezvous state, keyed by requestID.
  const recoveryWaiters = new Map<string, (groupInfo: Uint8Array | null) => void>()
  const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingReplies = new Map<string, ReturnType<typeof setTimeout>>()
  const suppressedRequests = new Set<string>()

  // Responder: after a jitter delay, answer a recovery request with current
  // GroupInfo — unless another responder's reply has already been observed
  // (storm-collapse), in which case the scheduled reply is cancelled.
  const handleRecoveryRequest = (request: { requestID: string; requesterDID: string }): void => {
    const { requestID, requesterDID } = request
    if (mls == null || rendezvousTopicID == null) return
    if (suppressedRequests.has(requestID) || pendingReplies.has(requestID)) return
    const port = mls
    const topicID = rendezvousTopicID
    const timer = setTimeout(() => {
      pendingReplies.delete(requestID)
      void (async () => {
        try {
          const groupInfo = await port.exportGroupInfo(requesterDID)
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
          // a failed reply just means another responder (or a retry) covers it
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
      // A wakeup is a lane operation like any other: step 0, then the pull. It has no
      // return value, so a loss found here is stashed for the next call that has one.
      const replayed = await replayJournal()
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
    if (frame.kind === HANDSHAKE_KIND.recoveryRequest) {
      handleRecoveryRequest(decodeRecoveryRequest(frame.payload))
    } else if (frame.kind === HANDSHAKE_KIND.recoveryReply) {
      handleRecoveryReply(decodeRecoveryReply(frame.payload))
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

  /** Hand the host any loss found by a step 0 — this operation's, or an earlier wakeup's. */
  const takeLost = (): LaneResult => {
    const lost = lostCommit
    lostCommit = undefined
    return lost != null ? { lost } : {}
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
      return takeLost()
    })
  }

  const recover = async (): Promise<{ advanced: boolean }> => {
    await ready
    if (mls == null || rendezvousTopicID == null) return { advanced: false }
    const port = mls
    const topicID = rendezvousTopicID
    const requestID = (getRandomID ?? defaultRandomID)()
    const groupInfo = await new Promise<Uint8Array | null>((resolve) => {
      recoveryWaiters.set(requestID, resolve)
      recoveryTimers.set(
        requestID,
        setTimeout(() => {
          recoveryTimers.delete(requestID)
          if (recoveryWaiters.delete(requestID)) resolve(null)
        }, recoveryTimeoutMs),
      )
      void Promise.resolve(
        mux.publish({
          topicID,
          payload: encodeHandshakeFrame(
            HANDSHAKE_KIND.recoveryRequest,
            encodeRecoveryRequest(requestID, localDID),
          ),
        }),
      ).catch(() => {})
    })
    if (groupInfo == null) return { advanced: false }
    let result = { advanced: false }
    const op = runSerial(async () => {
      let r: { advanced: boolean }
      try {
        r = await port.applyRecovery(groupInfo)
      } catch {
        // A hub-injected or wrong-leaf reply fails to open; treat as no recovery
        // rather than rejecting the public recover() call.
        return
      }
      result = r
      if (!r.advanced) return
      // The jump moved the epoch; it did not move the cursor. The commits this peer skipped
      // are still in the log ahead of that cursor, and at the epoch it has landed on they
      // are history — the table walks them without handing one of them to the port, which is
      // the difference between a recovered peer and one that re-applies its own past.
      await pullCommits().catch(() => {
        // a failed walk leaves the cursor where it was; the next wakeup reads those frames again
      })
      await rebuildEpoch()
    })
    await op
    return result
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
      await recover()
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
      recoveryTimers.clear()
      pendingReplies.clear()
      suppressedRequests.clear()
      await teardownEpoch()
      await mux.dispose()
    },
  }
}
