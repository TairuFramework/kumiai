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
import { type CommitFrame, decodeCommitFrame, encodeCommitFrame } from './commit-frame.js'
import type { GroupCrypto, GroupMLS } from './crypto.js'
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

export type GroupPeerParams<Protocols extends Record<string, ProtocolDefinition>> = {
  hub: LogHub
  crypto: GroupCrypto
  /** MLS lifecycle port. When provided, the peer runs the handshake lane. */
  mls?: GroupMLS
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
}

export type ProtocolSurface<Protocol extends ProtocolDefinition> = {
  dispatch: (prc: string, data?: Record<string, unknown>) => Promise<void>
  request: (prc: string, prm?: unknown, options?: RequestOptions) => Promise<unknown>
  gather: (prc: string, prm?: unknown, options?: GatherOptions) => Promise<Array<GatheredReply>>
  to: (memberDID: string) => Client<Protocol>
}

export type LocalCommitOptions = {
  /**
   * The signed control-ledger tokens this Commit enacts. They ride the commit's own
   * frame, sealed under the epoch secret the Commit is framed at, so every member that
   * can apply the Commit already has its bodies. Nothing is published ahead of the
   * commit, and no member has to ask for a body it has never seen.
   */
  ledgerEntries?: Array<string>
  /**
   * Adopt the post-commit MLS state. Run once the hub has the frame, before the peer
   * rebuilds its app lane at the new epoch. It is the consumer's own handle swap — the
   * peer owns no MLS state and only needs to know WHEN it happened.
   */
  adopt?: () => void | Promise<void>
}

export type GroupPeer<Protocols extends Record<string, ProtocolDefinition>> = {
  protocol: <K extends keyof Protocols>(name: K) => ProtocolSurface<Protocols[K]>
  /**
   * Announce a Commit the consumer has produced but NOT yet adopted: seal the ledger
   * entries it enacts under the current — pre-commit — epoch secret, append the frame to
   * the commit log, adopt, and rebuild this peer's app topics at the epoch it moved to.
   * No-op when the peer has no MLS port.
   *
   * The order is the contract: the bodies must be sealed under the epoch every receiver
   * of this Commit is at, which is the epoch the group is at until this Commit is
   * adopted. A consumer that adopts first can no longer seal them for anybody, and is
   * told so rather than publishing a blob no member can open.
   */
  localCommitted: (commit: Uint8Array, options?: LocalCommitOptions) => Promise<void>
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
  const { hub, crypto, mls, localDID, protocols, handlers, suppress } = params
  const getRandomID = params.getRandomID
  const recoveryTimeoutMs = params.recovery?.timeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS
  const getReplyDelayMs =
    params.recovery?.getDelayMs ?? (() => defaultJitter(DEFAULT_RECOVERY_JITTER_MS))
  const commitLogRetentionSeconds =
    params.commitLogRetentionSeconds ?? DEFAULT_COMMIT_LOG_RETENTION_SECONDS
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
   * Commit frames this peer published itself and had already applied before announcing.
   * The log hands a peer its own frames back — push never did, because the hub excludes
   * a sender from its own delivery — so without this the committer would apply its own
   * commit a second time when it pulls. Entries are dropped as the cursor passes them.
   */
  const selfCommitted = new Set<string>()

  // Commit processing is serialized: MLS applies Commits in order, and both
  // processCommit and the epoch rebuild are async.
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
   * Read the commit log forward from the cursor and process every frame it can,
   * advancing the cursor over each one. Returns whether any of them advanced the epoch.
   *
   * This is the only place commit frames are ever read. The cursor advances over a
   * frame the peer PROCESSED — applied, dropped as foreign, or dropped as malformed —
   * and does NOT advance over a frame whose processing threw: the throw leaves the
   * cursor where it was, and the next pull reads that frame again. The cursor, not the
   * ack, is what makes the lane retry.
   */
  const pullCommits = async (): Promise<boolean> => {
    if (mls == null || commitTopicID == null) return false
    const port = mls
    const topicID = commitTopicID
    let advancedEpoch = false
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
      if (result.messages.length === 0) return advancedEpoch
      for (const message of result.messages) {
        const position = asLogPosition(message.sequenceID)
        if (selfCommitted.delete(position)) {
          reconciledHead = position // this peer's own commit, applied before it announced it
          continue
        }
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
        const { advanced } = await port.processCommit(commitFrame.commit, {
          senderDID: message.senderDID,
          // The resolver, not the bodies: the blob is opened only if the port asks for
          // the entries this commit names, and it asks only for a commit it is applying —
          // one framed at the epoch this peer is at, which is the epoch the blob is sealed
          // under. That is what makes body delivery atomic with the commit.
          resolveLedgerEntries: createLedgerEntryResolver(commitFrame.sealedEntries, crypto.unwrap),
        })
        if (advanced) advancedEpoch = true
        reconciledHead = position
      }
      if (result.messages.length < COMMIT_FETCH_LIMIT) return advancedEpoch
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
      await reconcileCommits()
    }).catch(() => {
      // the pull failed (e.g. processCommit threw); the cursor did not advance, so the
      // next wakeup reads those frames again
    })
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
    await runSerial(pullCommits).catch(() => {
      // a failed seed leaves the cursor where it was; the next wakeup pulls again
    })
  }

  // Append a locally-produced Commit to the log and rebuild this peer's app topics.
  // Rides the same serial tail as the pull so it never interleaves with one.
  const localCommitted = async (
    commit: Uint8Array,
    options?: LocalCommitOptions,
  ): Promise<void> => {
    await ready
    if (mls == null || commitTopicID == null) return
    const topicID = commitTopicID
    await runSerial(async () => {
      // The bodies are sealed under the epoch secret the Commit is FRAMED at — the epoch
      // every member that can apply it is at, and the one the local group is still at
      // until this Commit is adopted. A consumer that adopted first has already rotated
      // past it and can seal them for nobody, so say so instead of publishing a blob no
      // member can open.
      if (crypto.epoch() !== epoch) {
        throw new Error(
          'localCommitted: the local group has already advanced past the epoch this commit was framed at. Announce a commit before adopting it.',
        )
      }
      const sealedEntries = await crypto.wrap(encodeLedgerEntries(options?.ledgerEntries ?? []))
      const payload = encodeHandshakeFrame(
        HANDSHAKE_KIND.commit,
        encodeCommitFrame(commit, sealedEntries),
      )
      // Log class: this frame must still be there for a member invited tomorrow, long
      // after every current subscriber has acked it.
      const { sequenceID } = await mux.publish({ topicID, payload, retain: 'log' })
      // A pull reads back the peer's own frames. Remember this one so the cursor steps
      // over it instead of handing this peer back a commit it produced.
      selfCommitted.add(asLogPosition(sequenceID))
      // The hub has the frame: the Commit is the group's now. The consumer adopts it,
      // and only then does the app lane move to the epoch it reached.
      await options?.adopt?.()
      await rebuildEpoch()
      // Pull immediately: no push comes back for a frame this peer published, so this is
      // what carries the cursor over it — and it picks up anything that landed alongside.
      await reconcileCommits()
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
      if (r.advanced) await rebuildEpoch()
      result = r
    })
    await op
    return result
  }

  const ready = (async () => {
    await initControlLanes()
    await buildEpoch()
  })()
  // A failed init rejects every public call, but must not raise an unhandled rejection
  // before the first of them is made.
  const settled = ready.catch(() => {})
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
    localCommitted,
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
