import type { Client } from '@enkaku/client'
import type { ProtocolDefinition } from '@enkaku/protocol'
import type { ProcedureHandlers } from '@enkaku/server'
import {
  BroadcastClient,
  createBroadcastTransport,
  defaultJitter,
  encodeEventFrame,
  type GatheredReply,
  type GatherOptions,
  type RequestOptions,
  type SuppressConfig,
} from '@kumiai/broadcast'
import type { StoredMessage } from '@kumiai/hub-protocol'
import type { LogHub } from '@kumiai/hub-tunnel'
import { createRuntime, type Runtime } from '@sozai/runtime'

import type { Anchor, AnchorStore } from './anchor.js'
import type { AppCursorStore, AppWindowPruned } from './app-cursor.js'
import { createAppLane } from './app-lane.js'
import { createGroupBusServer } from './bus-server.js'
import { classifyCommit, UNKNOWN_FRAME_VERSION } from './classify.js'
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
import {
  type CommitFrame,
  decodeCommitFrame,
  encodeCommitFrame,
  isUnsupportedCommitFrameVersion,
} from './commit-frame.js'
import {
  type GroupCrypto,
  type GroupMLS,
  type GroupUnwrapResult,
  isMissingLedgerEntries,
} from './crypto.js'
import { asLogPosition, type LogPosition } from './cursor.js'
import {
  createDirectedClient,
  createInboxAcceptor,
  createInboxPath,
  type InboundPath,
} from './directed.js'
import { adaptBusHandlers, type BusHandlerMaps } from './handlers.js'
import {
  decodeHandshakeFrame,
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
  HANDSHAKE_VERSION,
} from './handshake.js'
import {
  createHubMux,
  type HubMux,
  type ReceiveLaneEnded,
  type SubscribeFailure,
} from './hub-mux.js'
import { createLedgerEntryResolver, encodeLedgerEntries } from './ledger-entries.js'
import { createOpenOncePath } from './open-once.js'
import { retentionOf } from './protocol.js'
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
import { detectRosterChange } from './roster.js'
import {
  APP_TOPIC_LABEL,
  commitTopic,
  inboxTopic,
  protocolTopic,
  rendezvousTopic,
} from './topic.js'

const DEFAULT_RECOVERY_TIMEOUT_MS = 5000
const DEFAULT_RECOVERY_JITTER_MS = 250

/**
 * How long `recover()` keeps rejoining before giving up and leaving the peer degraded. A
 * deadline, not an attempt count: losing the compare-and-set is expected — a heal runs under
 * commit pressure and two peers healing at once race each other.
 */
const DEFAULT_RECOVERY_DEADLINE_MS = 30_000

/**
 * How long the hub is asked to keep the commit log: **28 days**. Bounds how long a member may be
 * offline and still converge by pulling alone, without another member awake to heal it.
 *
 * Deliberately below the reference hub ceiling (`createMemoryStore`'s `DEFAULT_MAX_RETENTION`, 30
 * days): a hub refuses a retention above its ceiling rather than clamping it, so a default sitting
 * exactly on the ceiling would leave no room for an upward override — refused outright, and the
 * peer not a subscriber of its own commit topic. Asserted in `peer-control-lanes.test.ts`, since a
 * tighter operator cap still refuses this default (reported via `hub-mux`).
 */
export const DEFAULT_COMMIT_LOG_RETENTION_SECONDS = 28 * 24 * 60 * 60

/**
 * How long the hub is asked to keep an app topic's log. Aligned to the commit window so a
 * returning member never rebuilds its membership without also recovering its messages. A separate
 * dial, not the commit one reused — the alignment is a choice a host may override.
 */
export const DEFAULT_APP_LOG_RETENTION_SECONDS = DEFAULT_COMMIT_LOG_RETENTION_SECONDS

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
 * a hostile relay could replay replies under endless distinct ids and grow it forever.
 *
 * Eviction is safe at any size: a dropped entry only costs a redundant reply (a re-seal to a
 * requester the port still authorizes), never a leak. The cap sits well above the in-flight
 * request count, so eviction only reaches ids whose deadline long passed.
 */
const SUPPRESSED_REQUESTS_MAX = 1024

/**
 * The MLS half of a peer: the lifecycle port, the durable journal, the restart-adopt hook, and the
 * durable anchor/cursor stores. They arrive together or not at all — each missing piece fails
 * SILENTLY: no journal loses a commit whose process died mid-acceptance; no anchor store re-seeds
 * at the live epoch and silently partitions from the group; no cursor store re-reads app history
 * from the hub's retention floor every restart. The type is what stops a host wiring only some.
 */
export type GroupPeerMLSParams = {
  /** MLS lifecycle port. When provided, the peer runs the commit lane. */
  mls: GroupMLS
  /** Durable single-slot journal. Written before every publish, cleared on both outcomes. */
  journal: CommitJournal
  /**
   * Durable store for the app-lane anchor. Written on every rotation, read once at construction.
   * Persisted, not derived — see {@link anchor} for why it cannot be re-derived from the handle.
   */
  anchorStore: AnchorStore
  /**
   * Durable read position for the app lane, per topic. Written as each drain finishes, read as
   * each segment is pulled — what lets a returning peer resume from where it got to, and the only
   * thing a below-retention gap can be detected against (the gap IS the distance between the two).
   *
   * The drain may only advance it past a frame it is done with: delivered, or sealed at an epoch
   * this peer can never hold again. See {@link "app-cursor".AppCursorStore}.
   */
  appCursorStore: AppCursorStore
  /**
   * Adopt a journalled commit now confirmed accepted — the restart half of
   * {@link PendingCommit.onAccepted}: deserialize the post-commit handle, adopt it, deliver any
   * Welcome it carried.
   *
   * MUST be idempotent, like `onAccepted`: the peer cannot tell an entry whose `onAccepted`
   * already ran from one whose process died before it. The Welcome resend is at-least-once by
   * design — see {@link PendingCommit.onAccepted}.
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
  /** Runtime providing platform primitives. Defaults to `createRuntime()`. */
  runtime?: Runtime
  /**
   * Recovery rendezvous tuning. `timeoutMs`: how long one request waits for a reply. `getDelayMs`:
   * responder reply jitter. `deadlineMs`: how long `recover()` keeps re-requesting and rebuilding
   * before giving up and leaving the peer degraded.
   */
  recovery?: { timeoutMs?: number; getDelayMs?: () => number; deadlineMs?: number }
  /**
   * Commit-log retention the hub is asked to hold, in seconds. Default 28 days — see
   * {@link DEFAULT_COMMIT_LOG_RETENTION_SECONDS}. A liveness dial: within it a returning member
   * converges by pulling the log; beyond it, another live member must heal it.
   */
  commitLogRetentionSeconds?: number
  /**
   * App-log retention the hub is asked to hold, in seconds. Default 28 days — see
   * {@link DEFAULT_APP_LOG_RETENTION_SECONDS}. Overridable up to the hub operator's own cap.
   */
  appLogRetentionSeconds?: number
  /**
   * How long `commit` rebases before giving up, in ms. Default 30s. Losing a compare-and-set is
   * the expected path, not an error path.
   */
  commitDeadlineMs?: number
  /**
   * Called when the app lane finds a gap below the hub's retention floor: frames published to a
   * topic this peer had a read position on, and aged out before it came back for them.
   *
   * OPTIONAL: unlike the stores above, a host that ignores this loses no message — the frames
   * that survived are still delivered — it only turns an absence the host could not see into one
   * it can.
   *
   * Fire-and-forget: a throw is swallowed and the drain carries on.
   */
  onAppWindowPruned?: (event: AppWindowPruned) => void | Promise<void>
  /**
   * Called when the hub definitively refuses to subscribe this peer to a topic — most plausibly a
   * retention setting above the operator's own cap, which a hub refuses rather than clamps.
   *
   * Optional only because it is not the enforcement: every publish and fetch on a refused topic
   * throws (see {@link "hub-mux".createHubMux}), so a host that wires nothing still cannot mistake
   * such a peer for a healthy one. This is how a host learns PROMPTLY, and the only way a
   * read-only peer on that topic learns at all.
   *
   * Fire-and-forget: a throw is swallowed.
   */
  onSubscribeFailed?: (failure: SubscribeFailure) => void
  /**
   * The push lane has ended and nothing will restart it. See {@link "hub-mux".ReceiveLaneEnded}.
   *
   * The connection belongs to the HOST, not the peer, so only the host can reconnect — without
   * this the ending is invisible, and a dead lane looks like a group with nothing to say. A host
   * that reconnects should build a new peer over the new connection.
   *
   * Not called on `dispose`. Fire-and-forget: a throw is swallowed.
   */
  onReceiveEnded?: (ended: ReceiveLaneEnded) => void
} & (
  | GroupPeerMLSParams
  | {
      mls?: undefined
      journal?: undefined
      adoptJournalled?: undefined
      anchorStore?: undefined
      appCursorStore?: undefined
    }
)

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
   * Replays the journal, pulls the log to the end, calls `build()`, journals the result, and
   * publishes conditionally on the head it pulled to. Lose (someone committed first): drop the
   * pending commit untouched and call `build()` again against the now-current handle — expected,
   * not an error. `build()` must read the host's live handle each attempt and have no side effects
   * until `onAccepted` runs, since a losing attempt is discarded whole.
   *
   * Holds the commit mutex for its whole run, so two `build()` calls never race one handle.
   *
   * A RESULT means it landed and `onAccepted` ran; a THROW means it did not — stranded, ledger
   * incomplete ({@link "commit".RecoveryRequiredError}), or deadline lost
   * ({@link "commit".CommitDeadlineError}). Call {@link replay} after a throw to collect any
   * undrained `lost` / `reenact` work.
   */
  commit: (build: () => Promise<PendingCommit>) => Promise<LaneResult>
  /**
   * Replay the journal on its own, for startup: republish any pending commit under its original
   * idempotency key and hand back what did not survive. The host's collector to call before
   * anything else, and after a `commit()` that threw.
   *
   * Builds and publishes nothing, so an incomplete ledger is no hazard here — it retries the
   * bootstrap and returns WITHOUT throwing, leaving the peer degraded until a responder answers.
   * A `{}` result means "no orphaned work to re-issue", never "the peer is whole" — the
   * completeness gate lives on `commit()`.
   */
  replay: () => Promise<LaneResult>
  /**
   * Heal a peer the group has left behind: rejoin by external commit, refold the ledger, hand
   * back the entries the group's ledger does not already hold.
   *
   * A TOP-LEVEL lane operation, never called from inside another — takes the commit mutex itself.
   * The external commit races at the head like any commit; losing (the likely outcome) discards
   * the GroupInfo too, since it describes a tree the winner already changed and a commit rebuilt
   * from it is one no member can apply.
   *
   * A heal is TWO commits: the rejoin carries no entries, so the entries this peer still owes ride
   * an ordinary `commit()` the CALLER makes after this releases the lane — `reenact`, filtered by
   * MEMBERSHIP: re-enact an entry iff the group's ledger does not already hold it (the ledger does
   * not dedup, so re-enacting a held entry would revert a later admin's write).
   *
   * `{ advanced: false }` when no member answers, or the rejoin landed but the ledger could not be
   * bootstrapped (an incomplete ledger is a reset roster; reporting it healed would hand the host a
   * group with every role gone). A peer merely BEHIND never needs this — it pulls and catches up.
   */
  recover: () => Promise<{ advanced: boolean; reenact: Array<string> }>
  resync: () => Promise<void>
  /**
   * The epoch the app-lane anchor sits at — see {@link anchor} for the rotation rule. Exposed so a
   * caller can observe a roster change being detected without reaching into the port.
   */
  anchorEpoch: () => number
  dispose: () => Promise<void>
}

/**
 * A protocol's live lane at the epoch it was built for. Holds no topic ID: the topic is
 * anchor-bound and stable within a segment, but a runtime rebuilds only once a whole commit walk
 * returns, so what it remembers can be a segment out of date. A publisher asks the live anchor
 * instead (see `sealForSegment`).
 */
type ProtocolRuntime = {
  client: BroadcastClient
  busServer: { dispose: () => Promise<void> }
  acceptor: { dispose: () => Promise<void> }
  directed: Map<string, { client: Client<ProtocolDefinition>; dispose: () => Promise<void> }>
}

export function createGroupPeer<Protocols extends Record<string, ProtocolDefinition>>(
  params: GroupPeerParams<Protocols>,
): GroupPeer<Protocols> {
  const {
    hub,
    crypto,
    mls,
    journal,
    adoptJournalled,
    anchorStore,
    appCursorStore,
    localDID,
    protocols,
    handlers,
    suppress,
  } = params
  const onAppWindowPruned = params.onAppWindowPruned
  // Destructured rather than held as `runtime`: that name is taken in this scope by
  // {@link ProtocolRuntime}, which is a different thing entirely.
  const { getRandomID } = params.runtime ?? createRuntime()
  const newPublishID = getRandomID
  const recoveryTimeoutMs = params.recovery?.timeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS
  const recoveryDeadlineMs = params.recovery?.deadlineMs ?? DEFAULT_RECOVERY_DEADLINE_MS
  const getReplyDelayMs =
    params.recovery?.getDelayMs ?? (() => defaultJitter(DEFAULT_RECOVERY_JITTER_MS))
  const commitLogRetentionSeconds =
    params.commitLogRetentionSeconds ?? DEFAULT_COMMIT_LOG_RETENTION_SECONDS
  const appLogRetentionSeconds = params.appLogRetentionSeconds ?? DEFAULT_APP_LOG_RETENTION_SECONDS
  const commitDeadlineMs = params.commitDeadlineMs ?? DEFAULT_COMMIT_DEADLINE_MS
  const mux: HubMux = createHubMux({
    hub,
    localDID,
    ...(params.onSubscribeFailed != null ? { onSubscribeFailed: params.onSubscribeFailed } : {}),
    ...(params.onReceiveEnded != null ? { onReceiveEnded: params.onReceiveEnded } : {}),
  })

  let runtimes = new Map<string, ProtocolRuntime>()

  /**
   * The epoch's self-inbox topic and the one path that opens its frames. Held per peer rather
   * than per protocol because the topic is not per protocol, and rebuilt with the epoch — the
   * topic is anchor-bound, so a roster change moves it.
   */
  let inboxLane: { topicID: string; path: InboundPath } | undefined

  /**
   * The host's app event handlers, per protocol, as the drain calls them — the same adaptation
   * the live bus server is built from, so a drained frame and a pushed one reach the host by the
   * same door. Built once: the handlers a host passed at construction do not change, and the
   * drain outlives any one epoch's runtime (it runs mid-walk, when the app lane has been torn
   * down and not yet rebuilt).
   */
  const appEventHandlers = new Map<string, BusHandlerMaps['eventHandlers']>()
  for (const [name, protocol] of Object.entries(protocols)) {
    appEventHandlers.set(
      name,
      adaptBusHandlers(protocol, handlers[name] as Record<string, unknown>, suppress).eventHandlers,
    )
  }

  /**
   * The live epoch this peer frames commits at, seeded from the handle, not zero. Not the app
   * lane's epoch (anchor-bound) but the commit lane's: `frameCommit` refuses to seal bodies once
   * the live handle has moved past this. Zero is not neutral — the first lane operation (replay
   * then pull) runs BEFORE this is re-read, so a peer restarted holding a journalled commit would
   * have its own replay wrongly refused at startup.
   */
  let epoch = crypto.epoch()

  /**
   * The app-lane anchor: the per-epoch secret and epoch the app-lane topic derivation is bound
   * to. Seeded at genesis and rotated when an applied Commit changes the roster OR rejoins a
   * member — captured from the port's own post-commit epoch secret, never the recovery secret.
   *
   * It sits at the last roster change because two constraints meet there and nowhere else. A
   * Remove must move it: the evicted member keeps every topic ID it derived. An Add must move it
   * too: MLS ratchets forward, so a member added at epoch E cannot export an earlier secret.
   * `max(last add, last remove)` is the only epoch both after every removal and held by every
   * current member, and every member reaches it by applying the same commit, so they agree
   * natively — the joiner seeding at its own add epoch included.
   *
   * A REJOIN moves it too, from a member the Add/Remove diff cannot see: it changes no DID, so it
   * rotates on the applied commit's own external flag instead, set from the rejoiner's own
   * rejoined handle in `recover()` (a member never applies its own commit). The invariant is that
   * the anchor is >= every current member's EFFECTIVE join, and a rejoiner's effective join is
   * its rejoin epoch: its rejoined handle exports no secret from before it.
   *
   * PERSISTED, never re-derived: it is captured at an epoch the live handle then runs past, and a
   * rebooted handle can never re-export that epoch's secret. Every capture writes it to
   * {@link GroupPeerMLSParams.anchorStore} and construction restores it from there.
   *
   * Only the epoch is observable outside this scope (see {@link GroupPeer.anchorEpoch}).
   */
  let anchor: Anchor = {
    secret: new Uint8Array(),
    epoch: crypto.epoch(),
  }

  /**
   * The peer's app lane: the retained-frame buffer, its durable read position, and the drain. It
   * reads the anchor back through the accessor below rather than being handed one, since the
   * anchor moves under it and every topic it derives belongs to the segment the anchor names.
   */
  const appLane = createAppLane({
    mux,
    crypto,
    localDID,
    protocols,
    eventHandlers: appEventHandlers,
    retentionSeconds: appLogRetentionSeconds,
    anchor: () => anchor,
    groupID: () => commitTopicID,
    justifiedEpochCeiling: () => justifiedEpochCeiling(),
    ...(appCursorStore != null ? { appCursorStore } : {}),
    ...(onAppWindowPruned != null ? { onAppWindowPruned } : {}),
  })

  /**
   * Capture the anchor from the port's post-commit handle and persist it. The one place the
   * anchor is written from the live epoch, and the one place it is saved.
   *
   * KNOWN BOUND: `processCommit` is durable before this runs, so a crash between the two leaves a
   * persisted anchor one rotation stale, and the restarted peer stays off the group's topic until
   * the next roster change rotates it again. Closing it needs the anchor inside the same durable
   * write as the handle, which this layer cannot reach.
   */
  const captureAnchor = async (): Promise<void> => {
    anchor = { secret: await crypto.exportSecret(APP_TOPIC_LABEL), epoch: crypto.epoch() }
    await anchorStore?.save(anchor)
    // The anchor moving IS the segment boundary, so every capture ends the segment the buffer
    // belongs to. AFTER the assignment above: the lane rebuilds its cursors off the live anchor.
    appLane.reset()
  }

  /**
   * The opened form of a live frame, keyed by the plaintext the open produced. Written by the
   * inbound path below and read by every transport built on it, so one open serves all of them.
   *
   * {@link GroupUnwrapResult}, not `@kumiai/broadcast`'s `UnwrapResult`: what is stored here
   * reaches `BroadcastClient.gather` as the sender it keys its quorum on, and broadcast's type
   * says `senderDID?`. `crypto.unwrap` REQUIRES the field, so the narrowing below checks a promise
   * already made — a frame that breaks it is refused rather than fanned out.
   */
  const openedFrames = new WeakMap<Uint8Array, GroupUnwrapResult>()

  /**
   * The app lane's inbound path: one open per topic, fanned out as plaintext, with each frame's
   * log position noted before the open. Every consumer's own `unwrap` is then a pure lookup of the
   * opened result ({@link openedFrames}), and nothing downstream touches the handle.
   *
   * See {@link createOpenOncePath} for why a lane may only open a frame once.
   */
  const createInboundPath = (name: string, topicID: string) => {
    return createOpenOncePath<Uint8Array>({
      mux,
      topicID,
      unwrap: crypto.unwrap,
      project: (_message, opened) => {
        const { payload, senderDID } = opened
        if (typeof senderDID !== 'string' || senderDID === '') {
          // `project` returning `undefined` drops the frame deliberately (see
          // `OpenOncePathParams.project`): the app lane is always MLS-sealed, so an open that
          // recovers no sender is not a frame to deliver unattributed. Fails CLOSED against the
          // shared open-once signature's wider `UnwrapResult`.
          return undefined
        }
        openedFrames.set(payload, { payload, senderDID })
        return payload
      },
      note: (message) => appLane.note(name, topicID, message),
    })
  }

  /**
   * One protocol's live-lane transport: LISTENS on the topic the runtime is built for, and
   * PUBLISHES to the segment that contains each frame's own seal epoch — see
   * {@link sealForSegment} for why those can differ mid-rotation.
   *
   * The topic is decided by the SEAL and carried to the publish, since the two are separate calls
   * with an anchor that can move between them: `wrap` records the topic under the ciphertext it
   * produced, keyed by the bytes' own identity rather than a slot, since two transports share this
   * lane and interleave their writes.
   *
   * The subscribe keeps the runtime's topic — a rotation rebuilds the listeners, but a topic stays
   * subscribed at the mux for the member's whole life either way.
   */
  const segmentBoundTransport = (
    name: string,
    topicID: string,
    inbound: (onOpened: (payload: Uint8Array) => void) => () => void,
  ) => {
    const sealedOn = new WeakMap<Uint8Array, string>()
    return createBroadcastTransport({
      topicID,
      bus: {
        // `builtFor` is the topic this transport was constructed with, and it is the fallback
        // rather than the answer: anything published through here was sealed by the `wrap` below,
        // so the recorded topic is the one that agrees with the seal.
        publish: async (builtFor, payload) => {
          await mux.bus.publish(sealedOn.get(payload) ?? builtFor, payload)
        },
        // Already-opened plaintext, from the topic's one inbound path. The `unwrap` below only
        // recovers the sender the open already authenticated.
        subscribe: (_listenOn, onMessage) => inbound(onMessage),
      },
      wrap: async (bytes) => {
        const sealed = await sealForSegment(name, bytes)
        sealedOn.set(sealed.payload, sealed.topicID)
        return sealed.payload
      },
      unwrap: (payload) => openedFrames.get(payload) ?? payload,
    })
  }

  const buildEpoch = async (): Promise<void> => {
    epoch = crypto.epoch()
    const next = new Map<string, ProtocolRuntime>()
    // ONE inbox lane for the whole peer, not one per protocol: the topic does not name a
    // protocol, so every acceptor and directed client opening its own frames is the defect this
    // shape prevents.
    const selfInbox = inboxTopic(anchor.secret, anchor.epoch, localDID)
    inboxLane = {
      topicID: selfInbox,
      path: createInboxPath({ mux, topicID: selfInbox, unwrap: crypto.unwrap }),
    }
    for (const [name, protocol] of Object.entries(protocols)) {
      // The app topic is bound to the ANCHOR, not the live epoch — see {@link sealForSegment}.
      // Content stays sealed under the live epoch crypto below; only the topic ID is anchor-bound.
      const topicID = protocolTopic(anchor.secret, anchor.epoch, name)
      // Subscribed for the member's whole life, like the commit and rendezvous topics: the mux
      // never unsubscribes on rotation, only tears down the LISTENERS on the epoch left.
      // Unsubscribing would tell the hub to drop this member's pending deliveries and free any
      // frame it was the last reader of — deleting unread messages for everyone.
      //
      // Subscribed HERE, not left to the transports below, because the subscription is also what
      // asks the hub how long to hold the log; a bus is a fan-out abstraction with no such request.
      mux.retainTopic(topicID, { retention: appLogRetentionSeconds })
      // One path, two consumers: the frame is opened once here and both are given the plaintext.
      const inbound = createInboundPath(name, topicID)
      const client = new BroadcastClient({
        transport: segmentBoundTransport(name, topicID, inbound),
        ...(params.runtime != null ? { runtime: params.runtime } : {}),
      })
      const { eventHandlers, requestHandlers } = adaptBusHandlers(
        protocol,
        handlers[name] as Record<string, unknown>,
        suppress,
      )
      const busServer = createGroupBusServer({
        transport: segmentBoundTransport(name, topicID, inbound),
        from: localDID,
        eventHandlers,
        requestHandlers,
      })
      const acceptor = createInboxAcceptor<ProtocolDefinition>({
        mux,
        localDID,
        selfInboxTopic: selfInbox,
        inbound: inboxLane.path,
        resolveSendTopic: (senderDID) => inboxTopic(anchor.secret, anchor.epoch, senderDID),
        protocol: protocol as ProtocolDefinition,
        handlers: handlers[name] as unknown as ProcedureHandlers<ProtocolDefinition>,
        wrap: crypto.wrap,
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

  /**
   * Seal an app frame and name the segment it belongs on, as ONE answer: a frame must land on the
   * segment that CONTAINS its seal epoch, and only the live anchor knows which segment that is.
   *
   * Read from the live anchor and never from a `runtime`, because the two come apart exactly when
   * it matters: a rotation moves the anchor and the handle together inside the commit walk, but
   * runtimes rebuild only once the whole walk returns. A dispatch takes no mutex, so in that
   * window it can seal under the NEW epoch — publishing to the topic the runtime still holds would
   * land the frame on the segment the group just left, readable by nobody, ever.
   *
   * The anchor is re-read AFTER the seal and the pair thrown away if it moved — identity, not
   * epoch equality, since every capture mints a fresh anchor — which is what makes the two halves
   * one segment's: an anchor that did not move across the seal is one whose segment covers the
   * seal epoch. A moved anchor re-seals under the one now live instead of publishing against the
   * one it missed.
   */
  const sealForSegment = async (
    name: string,
    bytes: Uint8Array,
  ): Promise<{ topicID: string; payload: Uint8Array }> => {
    while (true) {
      const at = anchor
      const payload = await crypto.wrap(bytes)
      if (anchor === at) return { topicID: protocolTopic(at.secret, at.epoch, name), payload }
    }
  }

  const surfaceFor = (name: string): ProtocolSurface<ProtocolDefinition> => {
    const runtime = runtimes.get(name)
    if (runtime == null) throw new Error(`Unknown protocol: ${name}`)
    return {
      dispatch: async (prc, data) => {
        // Route by the procedure's declared retention. A `log` event goes to the app topic's log
        // lane (retained, pullable); ephemeral events and RPC stay on the live mailbox lane. The
        // log payload is byte-identical to what the broadcast transport would produce, so online
        // subscribers still receive it through the same drain.
        if (retentionOf(protocols[name], prc) === 'log') {
          const { topicID, payload } = await sealForSegment(name, encodeEventFrame(prc, data ?? {}))
          await mux.publish({ topicID, payload, retain: 'log' })
          return
        }
        await runtime.client.dispatch(prc, data)
      },
      request: (prc, prm, options) => runtime.client.request(prc, prm, options),
      gather: (prc, prm, options) => runtime.client.gather(prc, prm, options),
      to: (memberDID) => {
        const cached = runtime.directed.get(memberDID)
        if (cached != null) return cached.client
        const lane = inboxLane
        if (lane == null) throw new Error('Peer is not started')
        const created = createDirectedClient<ProtocolDefinition>({
          mux,
          localDID,
          memberDID,
          sendTopicID: inboxTopic(anchor.secret, anchor.epoch, memberDID),
          // The epoch's own inbox topic and its one open path: reading replies through a path
          // built for a topic this client does not receive on would spend keys opening frames for
          // a lane nobody listens to.
          receiveTopicID: lane.topicID,
          inbound: lane.path,
          wrap: crypto.wrap,
          ...(params.runtime != null ? { runtime: params.runtime } : {}),
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
   * is what the log's last accepted frame IS — read from the store's own reply, never inferred
   * from the cursor. `null` means the topic never had an accepted log publish.
   */
  let commitLogHead: LogPosition | null = null

  /**
   * The sequenceID this peer ENACTED at each epoch it passed — applied from the log, or committed
   * and adopted. The whole of the fork check: a second, different commit at an epoch this peer
   * holds a record for is two commits at one epoch, which the hub can only produce by showing
   * different logs to different members.
   *
   * An epoch with NO record is history, not a fork — a late joiner, rejoiner or re-seeded peer all
   * walk commits from epochs they never held. In memory, deliberately: a restart drops the record,
   * so a peer with no record reads history as history — it can MISS a fork, never invent one.
   */
  const appliedByEpoch = new Map<number, string>()

  /**
   * The heal trigger, RECORDED and never awaited where found: `recover()` takes the commit mutex,
   * so a pull that awaited it would wait on a tail including the pull. The trigger only writes
   * this flag; the pull unwinds, releases the lane, and the heal runs afterward as its own
   * operation. `healing` stops a second wakeup starting a concurrent one.
   */
  let healRequested = false
  let healing = false

  /**
   * Positive evidence this peer is off the group's line, and the sole guard on `commit()`. Set
   * when a pull sees proof the peer cannot reconcile: a frame framed AHEAD of its epoch, its OWN
   * un-merged commit at its current epoch, or the LOSING side of a fork.
   *
   * Deliberately NOT `healRequested`: that flag only SCHEDULES the next heal and clears as
   * ordinary control flow, so a heal that finds no responder leaves it false. Gating `commit()` on
   * it would let a peer that just failed to heal win the compare-and-set at a stale epoch and land
   * a commit on a branch of one. This flag survives a failed heal: cleared ONLY when a rejoin
   * actually lands (`recover`) — no pull can carry a stranded peer back, since the frames that
   * would are gone.
   *
   * Set on positive evidence, NEVER on poison: a frame this peer stepped over (malformed, refused,
   * or naming unresolvable bodies) is not evidence the group moved on, since nobody applied it
   * either. Gating on poison would rebuild the group-death hazard the classifier's `poison` row
   * refuses.
   */
  let stranded = false

  /**
   * A commit this peer journalled that never landed and cannot re-issue itself: held until a lane
   * operation with a return value can hand it to the host. Dropping it is the one thing that must
   * not happen — for an invite it loses an invitation, for a remove it leaves an admin believing a
   * member was evicted when they were not.
   */
  let lostCommit: LostCommit | undefined

  /**
   * The ledger entries this peer held when it rejoined — snapshotted BEFORE the rejoined handle
   * replaces them, since a handle that rejoined by external commit holds an EMPTY ledger.
   *
   * The peer's own LEDGER, not its journal (always settled by the time a heal runs). What a
   * healing peer holds that the group may not is its ledger: entries enacted on a discarded
   * branch, or kept while the group moved on. Filtering that against the group's authenticated
   * ledger is the membership rule as a set-difference: re-enact iff the group's ledger does not
   * already contain it.
   *
   * `null` means no rejoin in progress. Survives a failed bootstrap, so a retry filters the same
   * entries rather than snapshotting an empty ledger.
   */
  let inFlightEntries: Array<string> | null = null

  /**
   * Entries a heal decided must be re-enacted, waiting for a lane operation with a return value —
   * same problem as `lostCommit`. A heal triggered by a pull has nowhere to put them; the host
   * re-enacts with an ordinary `commit()`.
   */
  let pendingReenact: Array<string> = []

  /**
   * The group's commit mutex: every commit-lane operation serialized through one tail. The
   * compare-and-set resolves races between devices, not two callers here — two `build()` calls
   * against a single handle would both frame at that handle's epoch and diverge.
   *
   * NOT reentrant: a task that calls `runSerial` again waits on a tail including itself — which is
   * why a loss is RETURNED to the host, never handed to it under the lock.
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
   * The ordering it enforces saves a group of one: a peer that pulls before it replays meets its
   * OWN un-merged commit in the log, which classifies as a heal — from a group that, at creation,
   * has nobody to answer. The following replay would adopt the commit anyway, so unguarded this
   * peer would spend a rendezvous and a recovery deadline asking the void for help, every restart.
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
   * responder's own ratchet tree still holds a leaf for. Both checks are the port's; the ledger is
   * the group's whole authority state on a public secretless topic, so skipping either hands it to
   * the hub or to any stranger who posts a request.
   *
   * Gated on completeness: a peer that itself rejoined and has not bootstrapped holds an EMPTY
   * ledger, and answering with it just wastes a scarce responder (the requester's head check
   * rejects it).
   *
   * Every responder that CAN answer does — no storm-collapse here: a lying responder's answer
   * fails the head check, and the requester needs a second answer to fall through to.
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
   * The highest epoch the group's OWN COMMIT LOG can justify a frame having been sealed at.
   *
   * A member seals at epoch E only after applying the commit that produced E, so a log whose
   * furthest commit is framed at H bounds every member at H + 1. READ FRESH, never from this
   * peer's own view of the log: a returning member's own view would bound the group at the epoch
   * IT reached — killing exactly the frames it came back for.
   *
   * THIS IS THE HUB'S WORD, and it can only ever be wrong in ONE direction. A commit's framed
   * epoch is cleartext — unauthenticated until applied — so a hub free to inject frames can RAISE
   * this ceiling at will but never LOWER it: the honest commits are in the log too, and the
   * ceiling is the max over all of them, so no injected frame can hide one. Raising it costs the
   * attacker nothing; lowering it — which would destroy an honest member's frames — is
   * unreachable.
   *
   * That asymmetry is why an untrusted field is acceptable HERE and would not be for opening a
   * frame: this decides how long to WAIT, never what to believe — `unwrap` alone still decides
   * what is finally read.
   *
   * Epochs are read pre-apply from the commit's own cleartext, and every frame is asked rather
   * than only the last: the log's furthest frame may be poison or a fork loser.
   */
  const justifiedEpochCeiling = async (): Promise<number> => {
    let ceiling = crypto.epoch()
    if (commitTopicID == null) return ceiling
    let after: LogPosition | null = null
    while (true) {
      const result = await mux.fetchTopic({
        topicID: commitTopicID,
        ...(after != null ? { after } : {}),
        limit: COMMIT_FETCH_LIMIT,
      })
      for (const message of result.messages) {
        after = asLogPosition(message.sequenceID)
        let commit: Uint8Array
        try {
          const frame = decodeHandshakeFrame(message.payload)
          // An unknown wire version is unreadable here and stays unreadable: this ceiling is
          // built from epochs read out of commit bytes, and a frame this build cannot parse
          // yields none. Not the heal signal — raising that twice would not raise it harder.
          if (frame.version !== HANDSHAKE_VERSION) continue
          if (frame.kind !== HANDSHAKE_KIND.commit) continue
          commit = decodeCommitFrame(frame.payload).commit
        } catch {
          continue // not a commit frame: it says nothing about where the group got to
        }
        // The commit's CLEARTEXT epoch, not `readCommitHeader`: that resolves the committer
        // against this handle's own epoch secret and answers `null` for every commit framed ahead
        // of this peer — exactly the commits a returning member has yet to walk.
        const framedAt = crypto.frameEpoch(commit)
        if (framedAt != null && framedAt + 1 > ceiling) ceiling = framedAt + 1
      }
      if (result.messages.length < COMMIT_FETCH_LIMIT) return ceiling
    }
  }

  /**
   * THE ONE PATH THE HANDLE RATCHETS ON, and the invariant it holds: a handle does not ratchet
   * past an epoch until that epoch's frames are read and its anchor is taken. Both are one-way
   * doors — after the advance those frames are ciphertext forever, and that epoch's secret can
   * never be exported again.
   *
   * A seam, not a rule: the peer ratchets in four far-apart places (applied from the log, authored
   * by this peer, adopted from the journal on restart, and a rejoin), each free to uphold half of
   * this or none of it. Routing them all through here means the fifth site cannot get it wrong.
   * `advance` does the ratcheting and nothing else; everything around it is this function's.
   *
   * The ROSTER DIFF decides the rotation — see {@link anchor} for why. The before-read is
   * unconditional, since whether the diff will be needed is not knowable until the advance has
   * already destroyed the answer. `rotatesAnyway` is the one thing no diff can see: an
   * external-commit rejoin by a member the roster still holds replaces that member's leaf and
   * moves no DID, yet must rotate all the same (see {@link anchor}).
   *
   * The anchor is captured from the port's POST-advance handle — the epoch every member lands on
   * by making this same advance — which is what makes it agreed rather than local.
   */
  const advanceHandle = async <T>(
    port: GroupMLS,
    advance: () => Promise<T>,
    rotatesAnyway: (advanced: T) => boolean = () => false,
  ): Promise<T> => {
    // Read this epoch's app frames BEFORE the advance that leaves it — the last moment they can
    // be read, since the advance ratchets the handle on and takes this epoch's key material with
    // it. Per frame-epoch, not per rotation: a segment spanning five epochs is dispensed five
    // times off the one pull.
    await appLane.deliver()
    const rosterBefore = await port.rosterDIDs()
    const epochBefore = crypto.epoch()
    const advanced = await advance()
    // GATED ON THE HANDLE ACTUALLY RATCHETING: a roster diff alone is not evidence that it did. A
    // commit that REMOVES this member does not advance its handle (there is no epoch to move to,
    // since the commit's path excludes the dropped leaf), yet real MLS still applies proposals to
    // the tree — so the roster comes back WITHOUT this member at an epoch that did not move.
    // (Measured against ts-mls: `processMessage` returns without throwing, epoch stays,
    // `listMembers()` has lost the leaf.) Undiscriminated, that reads as a rotation.
    //
    // An ungated capture would re-derive the anchor at the epoch it already names and clear the
    // segment buffer for nothing: {@link captureAnchor} drops undelivered frames on the premise a
    // rotation makes them unopenable, which is false here — the handle is still at the epoch those
    // frames were sealed at, and a frame the live lane staged mid-walk would be thrown away
    // openable.
    const ratcheted = crypto.epoch() !== epochBefore
    if (
      ratcheted &&
      (detectRosterChange(rosterBefore, await port.rosterDIDs()) || rotatesAnyway(advanced))
    ) {
      await captureAnchor()
    }
    return advanced
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
   * stepped over as poison. It does NOT advance over its own un-merged commit, which stops the
   * drain. A throw (port broke its contract) leaves the cursor put and the next pull re-reads it.
   *
   * Also the only place the log's tip is learned, from the store's OWN reply, never inferred from
   * the cursor — recorded ONLY on a complete drain, since a tip ahead of the frames it covers
   * would let the next `commit()` win a compare-and-set at an epoch it had not caught up to. Only
   * `own-unmerged` stops early and takes no tip; `ahead` steps over its frame and drains to the
   * end, so it DOES record one — the `stranded` flag, not a withheld tip, then stops `commit()`.
   */
  const walkCommits = async (port: GroupMLS, topicID: string): Promise<boolean> => {
    let advancedEpoch = false
    // The tip from the SAME reply whose frames were processed, so it can never run ahead of them.
    const takeHead = (head: string | null): void => {
      commitLogHead = head == null ? null : asLogPosition(head)
    }
    while (true) {
      const result = await mux.fetchTopic({
        topicID,
        // From the cursor. With no cursor (fresh member, trimmed backlog, just rejoined) read
        // from the OLDEST retained frame — seeding from the topic's `head` would be a guess.
        ...(reconciledHead != null ? { after: reconciledHead } : {}),
        limit: COMMIT_FETCH_LIMIT,
      })
      if (result.messages.length === 0) {
        // Drained. The tip an EMPTY page reports is not redundant: a topic keeps its head when
        // its frames age out, so anchoring on the cursor here would compare-and-set against
        // `null` on a topic whose head is real, and lose forever.
        takeHead(result.head)
        return advancedEpoch
      }
      for (const message of result.messages) {
        // A commit this peer landed moved its cursor to that frame's position on acceptance (the
        // journal carries that across a restart); meeting its own commit here means the journal
        // was lost or never written.
        const position = asLogPosition(message.sequenceID)
        let frame: ReturnType<typeof decodeHandshakeFrame>
        try {
          frame = decodeHandshakeFrame(message.payload)
        } catch {
          reconciledHead = position // malformed: dropped, and the cursor still steps over it
          continue
        }
        // A wire version this build does not know, settled BEFORE the kind byte: nothing behind
        // the magic means what this build thinks under an unknown version. On the commit topic —
        // and only here — that is evidence in itself, so it goes to the classifier, not dropped.
        if (frame.version !== HANDSHAKE_VERSION) {
          const unreadable = classifyCommit(UNKNOWN_FRAME_VERSION, position, {
            localDID,
            epoch: crypto.epoch(),
            appliedByEpoch,
          })
          reconciledHead = position
          // Do what the classifier said, not what this branch assumes: it answers `ahead` today,
          // and any other answer just steps over the frame, matching the bare advance above.
          if (unreadable.row === 'ahead') {
            healRequested = true
            stranded = true
          }
          continue
        }
        if (frame.kind !== HANDSHAKE_KIND.commit) {
          reconciledHead = position // the commit lane carries commits, and nothing else
          continue
        }
        // Split the frame into the commit and the sealed blob of bodies it enacts. Reads bytes,
        // decrypts NOTHING: a late joiner reaches frames sealed under epochs it does not hold, and
        // an unopenable blob there is history, not poison.
        let commitFrame: CommitFrame
        try {
          commitFrame = decodeCommitFrame(frame.payload)
        } catch (error) {
          // Same split as the handshake version above, one layer down: an unknown COMMIT-FRAME
          // version fails BEFORE the commit bytes are extracted, so there is no next frame to
          // heal from — dropping it would step over the group's whole future. To the classifier.
          if (isUnsupportedCommitFrameVersion(error)) {
            const unreadable = classifyCommit(UNKNOWN_FRAME_VERSION, position, {
              localDID,
              epoch: crypto.epoch(),
              appliedByEpoch,
            })
            reconciledHead = position
            // The classifier's answer, not this branch's assumption — as above.
            if (unreadable.row === 'ahead') {
              healRequested = true
              stranded = true
            }
            continue
          }
          // Too short, or a commit length running past the end: genuinely not a frame, and
          // nothing a future build would have written. Dropped, and the cursor steps over it.
          reconciledHead = position
          continue
        }

        // The commit's OWN epoch and committer, from the commit's own bytes. Never
        // `message.senderDID` — the hub's word about who handed it over, and the hub is not
        // trusted: it could stamp every recipient's own DID onto one poison frame and make the
        // whole group heal at once.
        const header = await port.readCommitHeader(commitFrame.commit)
        const disposition = classifyCommit(header, position, {
          localDID,
          epoch: crypto.epoch(),
          appliedByEpoch,
        })

        if (disposition.row === 'own-unmerged') {
          // This peer's own commit, at the epoch it is still at: the hub took it, the group moved
          // on, and the pending state died with its process. Cannot be applied (MLS merges a
          // pending commit, never processes one), so the drain stops here and the peer heals.
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
          // A frame from an epoch below this peer's with no record for it. Not a fork, not
          // poison, not the port's business — its blob is never touched.
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
          // Through the seam, like every other site that ratchets the handle: it reads this
          // epoch's app frames ahead of the apply and takes the anchor if the roster moved.
          applied = await advanceHandle(
            port,
            () => {
              return port.processCommit(commitFrame.commit, {
                senderDID: message.senderDID,
                // The resolver, not the bodies: the blob opens only if the port asks for entries
                // this commit names, and only for a commit it applies — framed at this peer's
                // epoch, the epoch the blob is sealed under, making body delivery atomic with the
                // commit. Called from INSIDE the apply, so the open must not touch the handle's
                // ratchet: `openEntries` reads only the epoch's exporter secret and is pure.
                resolveLedgerEntries: createLedgerEntryResolver(
                  commitFrame.sealedEntries,
                  crypto.openEntries,
                ),
              })
            },
            // A REJOIN rotates the anchor too, from a member the roster diff cannot see: an
            // external commit by a member the roster still holds leaves every DID where it was.
            // Only an APPLIED commit says anything about the group.
            (result) => result.advanced && header?.external === true,
          )
        } catch (error) {
          if (!isMissingLedgerEntries(error)) {
            // The port broke its contract. The cursor stays and the frame is re-read — the pull is
            // a retry, and this is not an outcome it can name.
            throw error
          }
          // The commit names ledger entries whose bodies will not resolve. POISON: drop, advance,
          // do NOT heal. The bodies ride the commit sealed under its framed epoch, so a blob this
          // peer cannot open is one no member at this epoch can — nobody applies it, and the next
          // honest commit is framed at the same epoch and compare-and-sets behind it.
          //
          // Healing here would hand any member a group-wide recovery storm for one publish.
          // Retrying only delays that. The one case where this peer really is the broken one
          // announces itself later: the next commit is then framed AHEAD of this peer's, which
          // heals it.
          reconciledHead = position
          continue
        }
        if (applied.advanced) {
          advancedEpoch = true
          // The fork check's record; the only place it is written from the log.
          appliedByEpoch.set(framedEpoch, position)
        }
        // `{ advanced: false }` here is the port REFUSING a well-formed commit at this peer's own
        // epoch from another member: poison on the same terms as an unresolvable one.
        reconciledHead = position
      }
      // A short page ends the log: every frame this reply named is processed, so its tip is
      // reconciled. A full page is not — loop and take the head from the reply that finally drains.
      if (result.messages.length < COMMIT_FETCH_LIMIT) {
        takeHead(result.head)
        return advancedEpoch
      }
    }
  }

  /**
   * The commit walk, with this segment's retained app frames delivered around it.
   *
   * The walk reads each epoch's frames ahead of the apply that leaves it; this adds the one epoch
   * that has no apply after it — the head the walk stops at. Its frames are readable now and
   * nothing further is coming to prompt them, so a peer whose backlog is entirely at its current
   * epoch (or whose log held no commits at all) would otherwise never read a thing.
   */
  const pullCommits = async (): Promise<boolean> => {
    if (!journalReplayed) {
      throw new Error(
        'pullCommits: the journal must be replayed first in every lane operation, or a peer that crashed on its own commit heals from it instead of adopting it',
      )
    }
    if (mls == null || commitTopicID == null) return false
    const advanced = await walkCommits(mls, commitTopicID)
    await appLane.deliver()
    return advanced
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
    // Dropped, exactly as before, and deliberately NOT the commit lane's heal: the rendezvous
    // carries request/reply traffic, so a frame here in a format this build cannot read says
    // nothing about where the group's line got to. Only the commit topic carries that evidence.
    if (frame.version !== HANDSHAKE_VERSION) return
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
    // Both topics subscribed once for the peer's whole life — NOT rebuilt on resync, so a
    // stranded peer still shares both rendezvous with the live group. Subscribe BEFORE the first
    // pull: the hub gates a topic fetch on the caller's own subscription.
    commitUnsubscribe = mux.onInbound(commitTopicID, onCommitDelivery, {
      retention: commitLogRetentionSeconds,
    })
    rendezvousUnsubscribe = mux.onInbound(rendezvousTopicID, onRendezvousMessage)
    // Then seed the cursor by READING the log — commits published before this peer subscribed are
    // exactly the ones no push will bring it. A lane operation, so the journal replays AHEAD of
    // it. Neither step rebuilds the epoch — buildEpoch runs next.
    await runSerial(async () => {
      await replayJournal()
      // A peer restored with an incomplete ledger was killed between rejoining and bootstrapping.
      // The invariant finds it here and at every later lane operation, with no memory of how it
      // got there.
      await ensureLedger(Date.now() + recoveryTimeoutMs)
      await pullCommits()
    }).catch(() => {
      // a failed seed leaves the cursor put; the next wakeup replays and pulls again
    })
  }

  /**
   * Frame a commit for the log: `[commit][sealEntries(bodies)]`, bodies sealed under a key derived
   * from the epoch the commit is FRAMED at — the epoch every member that can apply it is at, and
   * the one this group stays at until the commit is adopted. A host that adopted first has rotated
   * past it and can seal for nobody, so it is told rather than publishing a blob no member can
   * open.
   */
  const frameCommit = async (commit: Uint8Array, bodies: Array<string>): Promise<Uint8Array> => {
    if (crypto.epoch() !== epoch) {
      throw new Error(
        'commit: the local group has already advanced past the epoch this commit was framed at. A commit is adopted in onAccepted, never before.',
      )
    }
    const sealedEntries = await crypto.sealEntries(encodeLedgerEntries(bodies))
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
      // log's tip as of that frame — a stale tip is safe (loses a race and rebases), a WRONG one
      // would win a race it had no right to.
      const accepted = asLogPosition(entry.acceptedAs)
      reconciledHead = accepted
      commitLogHead = accepted
      appliedByEpoch.set(entry.epoch, accepted)
      // Through the seam: the adopt ratchets the handle, so this epoch's app frames are read
      // first and the anchor is taken if the journalled commit moved the roster.
      await advanceHandle(mls, () => adoptJournalled(entry.journal))
      await journal.clear(entry.publishID)
      return true
    }

    // Republishing means RE-SEALING the bodies, sealable only under the host's current epoch —
    // which equals the framed epoch only while `onAccepted` is the sole place the host adopts.
    // Sealing anyway publishes a blob no member can open and wedges the lane for the whole group.
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
    // from a host that adopted out of band. Written first, replay is idempotent.
    await journal.markAccepted(entry.publishID, sequenceID)
    // This peer's own accepted frame is BOTH the last thing it processed and the log's tip —
    // otherwise a `commit()` right after a `replay()` would anchor on a stale tip.
    const accepted = asLogPosition(sequenceID)
    reconciledHead = accepted
    commitLogHead = accepted
    appliedByEpoch.set(entry.epoch, accepted)
    await advanceHandle(mls, () => adoptJournalled(entry.journal))
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
   * its own group state carries), which is what makes the state it detects self-healing.
   *
   * A handle that rejoined by external commit holds an EMPTY ledger against a live head, not a
   * neutral start: the roster folds from the entries, so with none the creator is the only admin,
   * every admin promoted since is invisible, and the peer REJECTS the next commit any of them
   * authors — re-stranding itself. A crash between rejoin and bootstrap leaves exactly that on
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
    // authenticated head is a chain digest, not a list. Every responder with a complete ledger
    // answers, each checked against the head this handle carries: a lying responder can withhold,
    // never rewrite, and one that fails is dropped for the next reply.
    //
    // The request is the port's signed blob, naming this peer inside a signature (what a
    // responder authorizes against) and carrying an ephemeral public key (the only key a
    // responder seals to) — without the first any stranger gets the group's whole authority state
    // for one publish; without the second, so does the hub.
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
      //      is invisible. `ensureLedger` repairs it in place when a responder answers; when none
      //      does, the peer must publish and advance NOTHING.
      //
      //      THROWS rather than returning, since `commit()` returns only when the commit LANDED —
      //      `recover()` answers `advanced: false` instead because its contract carries that flag;
      //      `commit()`'s does not. NO heal is scheduled: this peer holds its leaf, so a rejoin
      //      would rotate the tree for nothing — the gather that just failed IS the repair,
      //      re-running at the head of the next lane operation.
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

        // The pull found positive evidence this peer is off the group's line, which stands
        // whether or not a following heal lands. Unwind rather than race: on the `ahead` path the
        // pull already took the live tip, so a commit here would win at an epoch it never caught
        // up to. Gating on `stranded`, not `healRequested`, is what survives a heal that found no
        // responder.
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
        //    Anchor on the log's TIP, not the cursor: the cursor names the last frame PROCESSED,
        //    which need not be one the head can ever name.
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
          // 6. Lost the compare-and-set: someone committed first — expected, not an error. Drop
          //    the pending commit untouched, clear the slot, and go back to step 1.
          await slot.clear(publishID)
          if (Date.now() >= deadline) {
            throw new CommitDeadlineError(
              `commit: still rebasing after ${commitDeadlineMs}ms and ${attempt + 1} attempts`,
            )
          }
          continue
        }

        // 5. Accepted. Record it in the slot BEFORE the host adopts, while the group is still at
        //    the framed epoch — an entry carrying its acceptance can be adopted on restart; one
        //    carrying none at a later epoch is a host that adopted outside `onAccepted`. Recorded
        //    after the adopt, the two would be indistinguishable.
        await slot.markAccepted(publishID, sequenceID)

        // The commit is the group's now — this frame is both the last position processed and the
        // log's new tip.
        const accepted = asLogPosition(sequenceID)
        reconciledHead = accepted
        commitLogHead = accepted
        // A commit this peer made and adopted was enacted at that epoch, like an applied one —
        // without it a second commit at an epoch this peer OWNS would read as history.
        appliedByEpoch.set(framedEpoch, accepted)
        // The host adopts here, and adopting ratchets the handle — through the seam, exactly as
        // an applied commit does. A member never processes its own commit, so the apply site
        // never runs for the roster change this peer just made: without this, the author of a
        // Remove keeps publishing to a topic the removed member still holds, and the author of an
        // Add sits on a topic the new member's handle cannot derive — silently, and no restart
        // heals it.
        await advanceHandle(mls, () => pending.onAccepted())
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
        // 1. Pull to the end. It may resolve the strand outright, and a heal it no longer needs
        //    must NOT run: the external commit would rotate the tree for the whole group. Rebuild
        //    if it moved the epoch, before anything is framed: the peer that lost a heal race
        //    applies the winner's commit HERE.
        healRequested = false
        await reconcileCommits()

        // 2. The head to race at, from the store's own reply.
        const expectedHead = await readCommitHead(commits)

        // 3. Mint a request and rendezvous for a sealed GroupInfo. Fresh request per attempt: the
        //    ephemeral key is minted with it, and a reply to an already-used request is unopenable.
        const requestID = newPublishID()
        const request = await port.createRecoveryRequest(requestID)
        const sealed = await requestGroupInfo(request, requestID, rendezvous, deadline)
        if (sealed == null) {
          // Nobody answered. Heal REQUIRES another online member that can seal a GroupInfo;
          // without one it cannot work. The peer stays degraded and asks again later.
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
        //    the last moment they can be read. Kept across a failed attempt, so a retry filters
        //    the same entries rather than snapshotting the empty ledger a failed bootstrap left.
        if (inFlightEntries == null) inFlightEntries = await port.getLedger()
        const inFlight = inFlightEntries

        // 6. Publish the external commit, compare-and-set at the head: it changes the ratchet
        //    tree, so it races like any commit.
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
          // Lost the race — the likely outcome. DISCARD THE GROUPINFO, not merely the commit: it
          // describes a tree the winning commit already changed, so a commit rebuilt from it is
          // one no member at the new epoch can apply. Re-request and rebuild from a fresh one.
          continue
        }

        // 7. Accepted: the group has this peer's new leaf. Adopt the rejoined handle — the only
        //    place it may be adopted. Deliberately UNJOURNALLED: a crash here leaves an orphaned
        //    external commit that repairs itself — framed at the group's epoch, not this peer's,
        //    so the own-commit trigger stays quiet, the heal condition still holds, and `resync`
        //    later collects the leaf the orphan added.
        const rejoinedAtEpoch = (await port.readCommitHeader(pending.commit))?.epoch
        // Through the seam, like every other site that ratchets the handle — and it rotates
        // ANYWAY: this is the rejoin, which no roster diff can see (see {@link anchor}). The
        // anchor is the POST-commit epoch: the handle advances inside the seam and only then is
        // the anchor captured, exactly where an applying member lands.
        await advanceHandle(
          port,
          () => pending.onAccepted(),
          () => true,
        )
        const accepted = asLogPosition(sequenceID)
        reconciledHead = accepted
        commitLogHead = accepted
        // Enacted at that epoch, like an applied commit: without the record a second commit at
        // that epoch reads as history rather than the fork it is.
        if (rejoinedAtEpoch != null) appliedByEpoch.set(rejoinedAtEpoch, sequenceID)
        healRequested = false
        // The one place the commit gate is released: the rejoin landed, so this peer's leaf is
        // back in the tree and the stale-epoch fork it guards is closed. A bootstrap that still
        // fails below is `commit()`'s own ledger-completeness check to handle.
        stranded = false
        await rebuildEpoch()

        // 8. Bootstrap: REQUIRED, not a formality. Until it runs, the ledger is empty against a
        //    live head — every admin promoted since genesis is invisible and the next commit is
        //    rejected. Failure here is a persistent degraded state, NOT a heal.
        if (!(await ensureLedger(deadline))) {
          healRequested = true
          return { advanced: false, reenact: [] }
        }

        // 9. Re-enact by MEMBERSHIP, never by the failure that brought this peer here: keep only
        //    entries the group's ledger does NOT hold. An entry it DOES hold was enacted for
        //    everyone, and appending it again puts it at the END of the log where the fold is
        //    last-write-wins — it would win, silently reverting whatever a later admin wrote over
        //    the same subject.
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
    // Settle the app-lane anchor BEFORE the seed pull: a roster change the seed pull applies must
    // be able to rotate it off whatever lands here rather than have a later seed overwrite it.
    //
    // A stored anchor is RESTORED, never recomputed — see {@link anchor} for why (a rebooted
    // handle can never re-export an earlier epoch's secret).
    //
    // An empty store is first boot, and only first boot: seed at the initial epoch, as a group
    // with no roster change yet must. A member booting over a handle it was just added to seeds
    // at its own add epoch — the same epoch every existing member rotates to on applying that
    // add, so the two agree with no exchange between them.
    const stored = await anchorStore?.load()
    if (stored != null) {
      anchor = stored
    } else {
      await captureAnchor()
    }
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
    anchorEpoch: () => anchor.epoch,
    dispose: async () => {
      // Tear down even a peer whose init failed — it still holds a hub drain.
      await settled
      commitUnsubscribe?.()
      rendezvousUnsubscribe?.()
      // Resolve any in-flight recovery rendezvous FIRST, before clearing its timers: a
      // `recover()` blocked in `requestGroupInfo` is settled by exactly two things — a reply or
      // its timeout — and dispose is about to clear that timeout. Skipping this drain would hang
      // the heal, `commitTail`, and every lane operation queued behind it. Resolve, then clear, so
      // a fired timer cannot race a half-drained map. (The ledger gather needs no such drain: its
      // timeout is a local held in none of these maps.)
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
