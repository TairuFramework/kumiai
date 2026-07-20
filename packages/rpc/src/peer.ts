import type { Client } from '@enkaku/client'
import type { ProtocolDefinition } from '@enkaku/protocol'
import type { ProcedureHandlers } from '@enkaku/server'
import {
  BroadcastClient,
  createBroadcastTransport,
  defaultJitter,
  defaultRandomID,
  encodeEventFrame,
  type GatheredReply,
  type GatherOptions,
  type RequestOptions,
  type SuppressConfig,
  type UnwrapResult,
} from '@kumiai/broadcast'
import type { StoredMessage } from '@kumiai/hub-protocol'
import type { LogHub } from '@kumiai/hub-tunnel'
import { toUTF } from '@sozai/codec'

import type { Anchor, AnchorStore } from './anchor.js'
import type { AppCursorStore, AppWindowPruned } from './app-cursor.js'
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
import { type CommitFrame, decodeCommitFrame, encodeCommitFrame } from './commit-frame.js'
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
 * deadline, like `commit()`'s, not an attempt count: losing the compare-and-set is the LIKELY
 * case, since a heal runs under commit pressure and two peers healing at once race each other.
 */
const DEFAULT_RECOVERY_DEADLINE_MS = 30_000

/**
 * How long the hub is asked to keep the commit log: **28 days**. Bounds how long a member may be
 * offline and still converge by pulling alone, without another member awake to heal it.
 *
 * Four weeks, not thirty days, and the two days are the point. A hub refuses a retention above its
 * ceiling rather than clamping it, and the reference ceiling (`createMemoryStore`'s
 * `DEFAULT_MAX_RETENTION`) is thirty days. A default sitting exactly ON the ceiling leaves a host
 * no room at all: any upward override is refused outright, and the peer is then not a subscriber
 * of its own commit topic. Below the ceiling, the ordinary override has somewhere to go.
 *
 * The relationship is asserted, not just documented — see `peer-control-lanes.test.ts`. Nothing
 * stops an operator setting a tighter cap than the reference one, and against such a hub this
 * default IS refused; that is why the refusal has to reach the host (see `hub-mux`), and why it
 * must not be the DEFAULT configuration that trips it.
 */
export const DEFAULT_COMMIT_LOG_RETENTION_SECONDS = 28 * 24 * 60 * 60

/**
 * How long the hub is asked to keep an app topic's log. Aligned to the commit window so the two
 * bounds a returning member converges under coincide: there is no span where it can rebuild its
 * membership by pulling commits but not its messages. A separate dial rather than the commit
 * one reused, because the alignment is a CHOICE — a host with reason to move one bound moves it.
 */
export const DEFAULT_APP_LOG_RETENTION_SECONDS = DEFAULT_COMMIT_LOG_RETENTION_SECONDS

/** How many commit frames a single pull asks for. Pull loops until the log is drained. */
const COMMIT_FETCH_LIMIT = 100

/** Page size for the app-lane segment pull. Paged for the same reason the commit log is. */
const APP_FETCH_LIMIT = 100

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
 * across a crash, the host hook that adopts one after a restart, and the durable stores that carry
 * the app-lane anchor and the app-lane read position across the same restart. They arrive together
 * or not at all — a peer with a port and no journal would silently lose every commit whose process
 * died in the acceptance window; a peer with a port and no anchor store would silently partition
 * from its own group on the next restart, re-seeding the anchor at its live epoch while every
 * member that stayed up holds the real one; and a peer with a port and no cursor store would
 * silently re-read its app history from the hub's oldest retained frame every restart, re-deliver
 * what it already delivered, and have no place to notice the retention floor passing it. Every one
 * of those failures is silent, and the type is what stops a host wiring any of them.
 */
export type GroupPeerMLSParams = {
  /** MLS lifecycle port. When provided, the peer runs the commit lane. */
  mls: GroupMLS
  /** Durable single-slot journal. Written before every publish, cleared on both outcomes. */
  journal: CommitJournal
  /**
   * Durable store for the app-lane anchor. Written on every rotation, read once at construction.
   * The anchor is persisted state, not derived state: it sits at the last roster change, the live
   * handle runs ahead of it, and a rebooted handle can never re-export an earlier epoch's secret.
   */
  anchorStore: AnchorStore
  /**
   * Durable read position for the app lane, per topic. Written as each drain finishes, read as
   * each segment is pulled. It is what makes a returning peer read from where it got to instead of
   * from wherever the hub's retention now begins — and the only thing a below-retention gap can be
   * detected against, since the gap IS the distance between the two.
   *
   * The drain may only advance it past a frame it is done with: delivered, or sealed at an epoch
   * this peer can never hold again. See {@link "app-cursor".AppCursorStore}.
   */
  appCursorStore: AppCursorStore
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
   * Commit-log retention the hub is asked to hold, in seconds. Default 28 days — deliberately two
   * days BELOW the reference hub ceiling, so an upward override has somewhere to go rather than
   * being refused outright (see {@link DEFAULT_COMMIT_LOG_RETENTION_SECONDS}). A liveness dial:
   * within it a returning member converges by pulling the log; beyond it, another live member
   * must heal it.
   */
  commitLogRetentionSeconds?: number
  /**
   * App-log retention the hub is asked to hold, in seconds. Default 28 days — the commit window,
   * so a member asks the hub to hold its app log as long as its commit log and the two bounds
   * coincide: no span where it can rebuild its membership but not its messages. Overridable up to
   * the hub operator's own cap, which is what governs real storage.
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
   * OPTIONAL, unlike the stores beside it, and the line is exactly the one they fail: a host that
   * ignores this loses no message — the frames that survived are delivered either way — where a
   * host that skips a store loses messages and is never told. This only turns an absence a host
   * cannot see into one it can, so it is a notice to opt into, not an obligation.
   *
   * Fire-and-forget: a throw is swallowed and the drain carries on. Delivering the history a
   * returning member does still have is not the host's error handling to lose.
   */
  onAppWindowPruned?: (event: AppWindowPruned) => void | Promise<void>
  /**
   * Called when the hub definitively refuses to subscribe this peer to a topic — most plausibly a
   * `commitLogRetentionSeconds` / `appLogRetentionSeconds` above the operator's own cap, which a
   * hub refuses rather than clamps.
   *
   * Optional, but NOT optional in the way `onAppWindowPruned` is. That one reports an absence a
   * host loses nothing by ignoring; this reports a topic the peer is not a subscriber of, on which
   * it will receive nothing, ever. It is optional only because it is not the enforcement: every
   * publish and fetch on a refused topic throws (see {@link "hub-mux".createHubMux}), so a host
   * that wires nothing still cannot mistake such a peer for a healthy one. This is how a host
   * learns PROMPTLY, and the only way a peer that merely reads a topic tells anyone at all.
   *
   * Fire-and-forget: a throw is swallowed.
   */
  onSubscribeFailed?: (failure: SubscribeFailure) => void
  /**
   * The push lane has ended and nothing will restart it. See {@link "hub-mux".ReceiveLaneEnded}.
   *
   * The connection belongs to the HOST — the peer is handed a hub, it does not dial one — so the
   * host is the only thing that can reconnect. Without this the ending is invisible: listeners
   * just stop being called, and a peer with a dead lane is indistinguishable from a group with
   * nothing to say. A host that reconnects should build a new peer over the new connection.
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
  /**
   * The epoch the app-lane anchor sits at: the last commit this peer applied that CHANGED the
   * roster — an Add, a Remove, or both in one commit. Seeded at genesis; an update, a no-op or a
   * ledger-only commit leaves it put however far the live epoch runs ahead. It is the anchor the
   * app-lane topic derivation is bound to, exposed so a caller can observe a roster change being
   * detected without reaching into the port.
   */
  anchorEpoch: () => number
  dispose: () => Promise<void>
}

/**
 * A protocol's live lane at the epoch it was built for. It holds no topic ID: the topic these
 * transports bind to is anchor-bound and stable within a roster-change-bounded segment, but a
 * runtime is rebuilt only once a whole commit walk returns, so what it remembers of the topic can
 * be a segment out of date. A publisher asks the live anchor instead (see `sealForSegment`).
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
  const getRandomID = params.getRandomID
  const newPublishID = getRandomID ?? defaultRandomID
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
   * lane's epoch — that is anchor-bound — but the commit lane's: `frameCommit` refuses to seal
   * bodies when the live handle has moved past this. Zero is not neutral, because the first lane
   * operation (the seed: replay then pull) runs BEFORE this is re-read from the handle — so a peer
   * that restarted holding a journalled commit would have its own replay refused at startup by a
   * guard about a host adopting early, and recover only if the host called a lane operation later.
   */
  let epoch = crypto.epoch()

  /**
   * The app-lane anchor: the per-epoch secret and epoch the app-lane topic derivation is bound
   * to. Seeded at genesis (a group with no roster change yet anchors at its initial epoch) and
   * rotated when an applied Commit changes the roster OR rejoins a member — captured from the
   * port's own post-commit epoch secret, never the recovery secret.
   *
   * It sits at the last roster change because two constraints meet there and nowhere else. A
   * Remove must move it: the evicted member keeps every topic ID it derived, so the group must
   * leave them. An Add must move it too: MLS ratchets forward, so a member added at epoch E
   * cannot export the secret of any earlier epoch, and an anchor left behind is one the newest
   * member cannot derive. `max(last add, last remove)` is the only epoch both after every removal
   * and held by every current member — and every member reaches it by applying the same commit,
   * so they agree natively, the joiner seeding at its own add epoch included.
   *
   * A REJOIN moves it for the second reason, from a member the first one cannot see. The
   * invariant is that the anchor is >= every current member's EFFECTIVE join, and a rejoiner's
   * effective join is its rejoin epoch — its rejoined handle exports no secret from before it,
   * exactly as a newly added member's cannot. But a rejoin by a member the roster still holds
   * changes no DID, so nothing the roster diff reads moves: it rotates on the applied commit's
   * own external flag instead, and the rejoiner sets this from its rejoined handle in
   * `recover()`, the one place it can — a member never applies its own commit.
   *
   * PERSISTED, never re-derived: it is captured at an epoch the live handle then runs past, and
   * MLS ratchets forward, so a rebooted handle can never re-export the secret of the epoch the
   * anchor sits at. Every capture below writes it to {@link GroupPeerMLSParams.anchorStore} and
   * construction restores it from there — a peer that re-seeded from its live handle instead
   * would derive topics no member that stayed up is on.
   *
   * The topic derivation and subscription rotation that consume the secret are built on top of
   * this; here it is only recorded, and only the epoch is observable (see
   * {@link GroupPeer.anchorEpoch}).
   */
  let anchor: Anchor = {
    secret: new Uint8Array(),
    epoch: crypto.epoch(),
  }

  /**
   * One buffered app frame: where it sits in the topic's log, and its bytes until the drain is
   * DONE with it.
   *
   * `sealed` is ciphertext, not plaintext: which frames are readable is a question only the handle
   * can answer, and only at the epoch it is at right now. It goes `null` the moment the frame is
   * done — delivered, or dead — which frees the bytes at the same point the old buffer dropped the
   * frame outright. The POSITION outlives them, because the cursor moves over a run of done frames
   * and a done frame's place in that run is the whole of what it still has to say.
   */
  type AppFrame = { position: LogPosition; sealed: Uint8Array | null }

  /**
   * The current SEGMENT's retained app frames, per protocol, in log order. A segment is the run of
   * epochs between two roster changes, which is exactly the run of epochs one app topic spans, so
   * it is pulled once (below) and then dispensed epoch by epoch as the commit walk passes through
   * it.
   */
  let appSegment = new Map<string, Array<AppFrame>>()

  /**
   * The app lane's TWO read positions per protocol for the CURRENT segment, which are not the same
   * position and must not be conflated:
   *
   * - `position` is the DURABLE CURSOR: the last frame this drain is done with, and the last thing
   *   {@link appCursorStore} was told. It is held here so a drain that moved nothing writes nothing,
   *   and so the value is compared against the store's own last word rather than re-read.
   * - `fetched` is the LAST-FETCHED POSITION: how far down the log the buffer has been filled from.
   *   It runs AHEAD of the cursor exactly when a buffered frame is not done — an ahead-of-the-walk
   *   frame pins the cursor behind it while the pull has long since read past it — and it is where
   *   the next pull resumes, so a re-pull costs one short page rather than the whole tail.
   *
   * Both are per SEGMENT and reset with it, alongside `topicID`, which is the topic they are
   * positions in.
   */
  let appCursors = new Map<
    string,
    { topicID: string; position: LogPosition | null; fetched: LogPosition | null }
  >()

  /**
   * Log-class app frames the LIVE lane was pushed and the buffer has not taken in yet, per protocol,
   * with the topic each was pushed on.
   *
   * Staged rather than written straight into {@link appSegment} because the push arrives on the
   * mux's own drain loop, which runs outside every lane operation: writing there would splice the
   * array {@link deliverAppFrames} is midway through iterating and awaiting inside. Everything that
   * touches the buffer goes through {@link runAppLane} instead, and this is the hand-off.
   *
   * The topic travels with the frame because a rotation can land between the push and the merge,
   * and a position in the segment the group just left means nothing in the one it moved to.
   */
  let appStaged = new Map<string, Array<{ topicID: string; frame: AppFrame }>>()

  /** App topics whose retention this segment has already been asked for. See {@link loadAppSegment}. */
  let appRetained = new Set<string>()

  /**
   * The app lane's own mutex: everything that reads or writes {@link appSegment} and
   * {@link appCursors} runs through here, one task at a time.
   *
   * It is NOT the commit mutex, and cannot be. That one is entered by every lane operation and
   * resets the journal-replay flag on entry, so a cursor write taking it would tell the next pull
   * the journal had not been replayed. And it is not reentrant, while the app lane is reached from
   * inside a commit walk and from the mux's push loop at once — which is the collision this exists
   * for: the buffer is an ordered array that {@link deliverAppFrames} iterates and awaits inside,
   * and a push splicing it mid-iteration would step over frames.
   */
  let appLaneTail: Promise<void> = Promise.resolve()
  const runAppLane = <T>(fn: () => Promise<T>): Promise<T> => {
    const op = appLaneTail.then(fn)
    appLaneTail = op.then(
      () => {},
      () => {},
    )
    return op
  }

  /**
   * Capture the anchor from the port's post-commit handle and persist it. The one place the
   * anchor is written from the live epoch, and the one place it is saved.
   *
   * KNOWN BOUND: `processCommit` is durable before this runs, so a crash between the two leaves a
   * persisted anchor one rotation stale, and the restarted peer stays off the group's topic until
   * the next roster change rotates it again. Closing it needs the anchor inside the same durable
   * write as the handle, which this layer cannot reach: the anchor exists only once the port has
   * already committed and returned.
   */
  const captureAnchor = async (): Promise<void> => {
    anchor = { secret: await crypto.exportSecret(APP_TOPIC_LABEL), epoch: crypto.epoch() }
    await anchorStore?.save(anchor)
    // The anchor moving IS the segment boundary — there is no other definition of one — so every
    // capture ends the segment the buffer belongs to. Reset here rather than at the call sites so
    // a future capture cannot forget to.
    //
    // Dropping UNDELIVERED frames is correct and not a loss: the walk that reached this rotation
    // already read everything openable at every epoch it passed on its way here, so what remains
    // is what no epoch this peer will ever hold again can open. The next drain pulls the new
    // segment's topic, which is where the group's messages now are.
    //
    // The cursors go with the buffer, and nothing is cleared at the STORE: a cursor is keyed by
    // topic, the next segment is a different topic, and what this peer read to on the topic it is
    // leaving stays true of that topic forever.
    appSegment = new Map()
    appCursors = new Map()
    // Staged pushes go with the buffer, and for the same reason: a position in the segment being
    // left is not a position in the one being entered. Frames pushed DURING the rotation carry
    // their own topic and are dropped by the merge if it does not match the live anchor's, so this
    // clear and that check are two halves of one rule.
    appStaged = new Map()
    appRetained = new Set()
  }

  /**
   * The opened form of a live frame, keyed by the plaintext the open produced. Written by the
   * inbound path below and read by every transport built on it, so that one open serves all of
   * them.
   */
  const openedFrames = new WeakMap<Uint8Array, UnwrapResult>()

  /**
   * The app lane's inbound path: one open per topic, fanned out as plaintext, with each frame's
   * log position noted before the open — so it is noted at the epoch the frame is about to be
   * opened against. Every consumer's own `unwrap` is then a pure lookup of the opened result
   * ({@link openedFrames}), and nothing downstream touches the handle.
   *
   * See {@link createOpenOncePath} for why a lane may only open a frame once.
   */
  const createInboundPath = (name: string, topicID: string) =>
    createOpenOncePath<Uint8Array>({
      mux,
      topicID,
      unwrap: crypto.unwrap,
      project: (_message, opened) => {
        openedFrames.set(opened.payload, opened)
        return opened.payload
      },
      note: (message) => noteLiveAppFrame(name, topicID, message),
    })

  /**
   * One protocol's live-lane transport: it LISTENS on the topic the runtime is built for, and
   * PUBLISHES to the segment that contains each frame's own seal epoch.
   *
   * The two halves have to be separated because the rotation is not a moment. The anchor and the
   * handle move together inside the commit walk and the runtimes are rebuilt only once the whole
   * walk returns, so a dispatch — which takes no mutex — can run in between and seal under the
   * epoch the group has just moved to. Published to the topic this runtime still holds, that frame
   * is sealed under an epoch no member on that topic has reached. Mailbox class, so what it costs
   * is the frame dropped rather than a segment left holding bytes nobody can ever open, and a
   * dropped frame is still a frame that had somewhere correct to go.
   *
   * The topic is decided by the SEAL and carried to the publish, because they are two calls with
   * an anchor that can move between them: `wrap` seals against a re-read anchor (see
   * {@link sealForSegment} — that re-read is what makes the pair one segment's) and records the
   * topic under the ciphertext it produced, and the bus view routes by that record. Keyed by the
   * bytes' own identity rather than a slot: two transports share this lane and each one's writes
   * interleave with the other's, so a slot would let one publish take the other's topic.
   *
   * The subscribe keeps the runtime's topic. A rotation rebuilds the listeners, and a topic is
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
    // ONE inbox lane for the whole peer, not one per protocol. The topic does not name a
    // protocol, so every protocol's acceptor and every directed client read the same frames, and
    // each one opening them itself is the defect this shape exists to prevent.
    const selfInbox = inboxTopic(anchor.secret, anchor.epoch, localDID)
    inboxLane = {
      topicID: selfInbox,
      path: createInboxPath({ mux, topicID: selfInbox, unwrap: crypto.unwrap }),
    }
    for (const [name, protocol] of Object.entries(protocols)) {
      // The app topic is bound to the ANCHOR, not the live epoch: it holds constant while epochs
      // advance without touching the roster, and rotates onto a new topic when a roster change is
      // applied (the anchor moves then, and buildEpoch re-runs). Content stays sealed under the
      // live epoch crypto below — only the topic ID is anchor-bound.
      const topicID = protocolTopic(anchor.secret, anchor.epoch, name)
      // Subscribed for the member's whole life, like the commit and rendezvous topics: a
      // rotation tears down the LISTENERS on an epoch it left, never the subscriptions (the mux
      // guarantees it — nothing there unsubscribes). Unsubscribing tells the hub to drop this
      // member's pending deliveries and free any frame it was the last reader of, so a peer that
      // gave up the subscription as it rotated would delete its own unread messages, and
      // everyone else's copy of them.
      //
      // Subscribed HERE and not left to the transports below, because the subscription is also
      // what asks the hub how long to hold the log, and a bus is a fan-out abstraction that
      // carries no such request. The mux subscribes a topic once, so this is the subscribe the
      // hub sees for the live lane and it is the one that must carry the window.
      mux.retainTopic(topicID, { retention: appLogRetentionSeconds })
      // One path, two consumers: the frame is opened once here and both are given the plaintext.
      const inbound = createInboundPath(name, topicID)
      const client = new BroadcastClient({
        transport: segmentBoundTransport(name, topicID, inbound),
        ...(getRandomID != null ? { getRandomID } : {}),
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
   * it matters. A rotation moves the anchor and the handle together, inside the commit walk; the
   * runtimes are rebuilt only once the whole walk returns. A dispatch takes no mutex, so in that
   * window it seals under the NEW epoch — and a frame published to the topic the runtime still
   * holds would land on the segment the group just left, readable by nobody, ever: the members on
   * the new topic are not listening on the old one, the members still on the old topic cannot open
   * the new seal, and this peer's own drain never pulls the old segment again.
   *
   * The anchor is re-read AFTER the seal and the pair is thrown away if it moved, which is what
   * makes the two halves one segment's: an anchor that did not move across the seal is one whose
   * segment runs from its own epoch to a rotation that has not happened, and the seal epoch is
   * inside that span. Identity, not epoch equality — every capture mints a fresh anchor, and the
   * frame is re-sealed under the one that is now live rather than published against the one it
   * missed.
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
        // Route by the procedure's declared retention. A `log` event is published to the app
        // topic's log lane — retained and pullable — while an ephemeral event (the default) and
        // all RPC stay on the live mailbox lane. The log payload is byte-identical to the frame
        // the broadcast transport would have produced, so the live receive path stays symmetric:
        // a logged event still reaches online subscribers through the same drain.
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
          // The epoch's own inbox topic and its one open path, taken together: reading replies
          // through a path built for a topic this client does not receive on would open frames
          // for a lane nobody is listening to, and spend their keys doing it.
          receiveTopicID: lane.topicID,
          inbound: lane.path,
          wrap: crypto.wrap,
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
   * Tell the host that a topic's retention floor has passed this peer's read position: the frames
   * between the two aged out unread, and a returning member is holding a partial history it has no
   * other way to know is partial. A gap below retention is REPORTED, never silent.
   *
   * `oldest > cursor` is the whole test, and it is the only one available: the peer knows where it
   * read to and where the hub's log now begins, and nothing anywhere can say which frames used to
   * sit between them. So this reports the floor having passed the cursor, which over-reports (the
   * cursor's own frame aging out with nothing behind it reads the same) and never under-reports.
   * With no cursor there is no gap to speak of — a peer that has never read this topic is missing
   * nothing it ever had.
   */
  const reportPrunedWindow = async (
    name: string,
    cursor: LogPosition | null,
    oldest: string | null,
  ): Promise<void> => {
    if (onAppWindowPruned == null || commitTopicID == null) return
    if (cursor == null || oldest == null || oldest <= cursor) return
    try {
      await onAppWindowPruned({ groupID: commitTopicID, protocol: name, cursor, oldest })
    } catch {
      // The host's notice is the host's problem. The frames that survived are still to be
      // delivered below, and a throwing subscriber must not cost a returning member those too.
    }
  }

  /**
   * The buffer for one protocol, and the two positions that go with it, created on first use.
   *
   * Lazy because the LIVE lane can reach the buffer before any drain does — a peer that is online
   * and has walked no commit still has to keep a read position over what it was pushed — so the
   * durable cursor cannot be something only a pull establishes.
   */
  const appLaneFor = async (
    name: string,
  ): Promise<{
    frames: Array<AppFrame>
    cursor: { topicID: string; position: LogPosition | null; fetched: LogPosition | null }
  }> => {
    let frames = appSegment.get(name)
    if (frames == null) {
      frames = []
      appSegment.set(name, frames)
    }
    let cursor = appCursors.get(name)
    if (cursor == null) {
      const topicID = protocolTopic(anchor.secret, anchor.epoch, name)
      const stored = (await appCursorStore?.load(topicID)) ?? null
      cursor = { topicID, position: stored != null ? asLogPosition(stored) : null, fetched: null }
      appCursors.set(name, cursor)
    }
    return { frames, cursor }
  }

  /**
   * Take one frame into the buffer at its place in the log, or reconcile it with the copy already
   * there. The ONE way a frame enters {@link appSegment}, from either deliverer.
   *
   * A POSITION IS TAKEN ONCE. The two deliverers see the same frame — the live lane is pushed it and
   * the pull reads it back out of the log — and a second entry for a position already held is a
   * second delivery of one message, which is the duplicate the cursor exists to make impossible.
   * So a repeat is a reconcile, never an append.
   *
   * The reconcile only ever marks a frame DONE, never undoes it: `sealed: null` is the live lane
   * saying it had this frame at the epoch it was sealed at, and a pull that reads the same frame
   * back afterwards must not hand its bytes to the drain to deliver a second time.
   *
   * Kept in log order by insertion rather than by append, because the two deliverers do not arrive
   * in one order: a pull runs from a position behind the live stream and returns frames the pushes
   * already brought.
   */
  const takeAppFrame = (frames: Array<AppFrame>, incoming: AppFrame): void => {
    let index = frames.length
    while (index > 0 && (frames[index - 1] as AppFrame).position > incoming.position) index -= 1
    const existing = index > 0 ? (frames[index - 1] as AppFrame) : undefined
    if (existing?.position === incoming.position) {
      if (incoming.sealed == null) existing.sealed = null
      return
    }
    frames.splice(index, 0, incoming)
  }

  /**
   * Merge the live lane's staged pushes into the buffer, then pull this segment's log forward from
   * the LAST-FETCHED position and buffer whatever is new.
   *
   * PULLED EVERY DRAIN, not once per segment. The log is not the same log at every epoch inside the
   * segment — it grows, and a frame published while this peer walks is one a single pull can never
   * see. What used to make a re-pull unaffordable was that the live lane kept no read position, so a
   * second pull read back everything the pushes had already delivered; now the push carries its own
   * log position (`StoredMessage.logPosition`), {@link takeAppFrame} recognises a frame the buffer
   * already holds, and a re-pull returns only what was genuinely never delivered.
   *
   * From `fetched` and not from the cursor: the cursor is pinned behind any frame the walk has not
   * reached, and resuming there would re-read the whole tail on every drain to re-discover frames
   * already buffered. The union of the two ranges is still every position above the cursor, which is
   * what the advance rule needs — `fetched` is only ever moved by a pull that read the range below
   * it.
   *
   * MERGED BEFORE PULLED, and both inside one {@link runAppLane} task: a staged frame merged after
   * the pull would be a position above the pull's end, and the cursor may only walk a range some
   * pull has proved complete.
   *
   * Subscribed before pulled: the hub gates a topic fetch on the caller's own subscription, and a
   * segment reached by ROTATING onto it mid-walk has never been subscribed — the app lane is
   * rebuilt only once the walk is over. Asked once per segment, since a retain is refcounted.
   *
   * A FAILED FETCH RAISES. The caller's walk stops on the failure rather than stepping over an epoch
   * whose frames were never read, and `fetched` is moved only by pages that arrived.
   */
  const loadAppSegment = async (): Promise<void> => {
    for (const name of Object.keys(protocols)) {
      const { frames, cursor } = await appLaneFor(name)
      const topicID = cursor.topicID
      // Carrying the window on the listener-less subscribe too: this is the one a member that is
      // AWAY makes — a segment reached by rotating onto it mid-walk is pulled here and has never
      // been listened on — and it is the subscribe that asks the hub to still have the log.
      if (!appRetained.has(topicID)) {
        appRetained.add(topicID)
        mux.retainTopic(topicID, { retention: appLogRetentionSeconds })
      }

      // A push that landed on a topic this peer has since rotated off names a position in a log
      // this segment's cursor knows nothing about. Dropped, not merged: the frames of the segment
      // being left were read on the way out of it.
      for (const staged of appStaged.get(name) ?? []) {
        if (staged.topicID === topicID) takeAppFrame(frames, staged.frame)
      }
      appStaged.delete(name)

      // The gap question is asked on the segment's FIRST pull and no other. It compares where this
      // peer had read to against where the hub's retention now begins, and both are answers about
      // the peer arriving — every later pull starts from a position this peer reached itself, so
      // the floor having passed it again would be the same gap reported twice.
      let reported = cursor.fetched != null
      let after: LogPosition | null = cursor.fetched ?? cursor.position
      while (true) {
        const result = await mux.fetchTopic({
          topicID,
          ...(after != null ? { after } : {}),
          limit: APP_FETCH_LIMIT,
        })
        if (!reported) {
          // `result.oldest` is where the hub's retention begins, and only the FIRST page's reply is
          // asked: every later page reports the same floor, and a gap is one gap.
          reported = true
          await reportPrunedWindow(name, cursor.position, result.oldest)
        }
        for (const message of result.messages) {
          const position = asLogPosition(message.sequenceID)
          takeAppFrame(frames, { position, sealed: message.payload })
          after = position
        }
        cursor.fetched = after
        if (result.messages.length < APP_FETCH_LIMIT) break
      }
    }
  }

  /**
   * The highest epoch the group's OWN COMMIT LOG can justify a frame having been sealed at.
   *
   * A member seals at epoch E only after applying the commit that produced E, so a legitimate
   * frame at E always has that commit already published: a log whose furthest commit is framed at
   * H bounds every member at H + 1, and a claim above that is one no member could have made.
   *
   * READ FRESH, at the moment a claim is judged, and never from this peer's own view of the log: a
   * returning member is behind by however long it was away, so its view bounds the group at the
   * epoch IT reached — which would kill exactly the frames it came back for. Reading the live log
   * closes the honest race instead of trading one loss for another.
   *
   * THIS IS THE HUB'S WORD, and it is load-bearing that it can only ever be wrong in ONE direction.
   * A commit's framed epoch is cleartext — unauthenticated until the commit is applied — so a hub
   * free to inject frames onto the commit topic can RAISE this ceiling at will. It can never LOWER
   * it: the honest commits are in the log too, and the ceiling is the maximum over all of them, so
   * no injected frame can hide one. Raising it costs the attacker nothing and buys nothing — the
   * worst it reaches is the unbounded wait that exists today, which is the defect this bounds.
   * Lowering it is what would destroy an honest member's frames, and that is unreachable.
   *
   * That asymmetry is the whole argument, and it is why an untrusted field is acceptable HERE and
   * would not be for opening a frame: this decides how long to WAIT, never what to believe. What
   * is finally read out of a frame is still `unwrap`'s answer alone.
   *
   * Epochs are read pre-apply from the commit's own cleartext, and every frame is asked rather than
   * only the last: the log's furthest frame may be poison or a fork loser, and neither justifies
   * anything. Nothing readable in the log means nothing says the group ever left this handle's
   * epoch, and the bound is that epoch.
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
          // yields none. It is NOT the heal signal the drain makes of it — that signal is the
          // drain's to raise, and raising it twice would not raise it harder.
          if (frame.version !== HANDSHAKE_VERSION) continue
          if (frame.kind !== HANDSHAKE_KIND.commit) continue
          commit = decodeCommitFrame(frame.payload).commit
        } catch {
          continue // not a commit frame: it says nothing about where the group got to
        }
        // The commit's CLEARTEXT epoch, and deliberately not `readCommitHeader`: that resolves the
        // committer against this handle's own epoch secret, so it answers `null` for every commit
        // framed ahead of this peer — which is every commit a returning member has yet to walk. A
        // ceiling built on it would collapse to this peer's own epoch for exactly the member the
        // lane exists for, and kill the frames it came back to read.
        const framedAt = crypto.frameEpoch(commit)
        if (framedAt != null && framedAt + 1 > ceiling) ceiling = framedAt + 1
      }
      if (result.messages.length < COMMIT_FETCH_LIMIT) return ceiling
    }
  }

  /**
   * Move this topic's read position over the frames the drain has finished with, and persist it.
   *
   * The advance stops at the FIRST frame that is not done, and that stop is the safety property: a
   * cursor may only pass a frame that is delivered or dead. A done frame further along the buffer
   * is left where it is — its turn comes once the frame in front of it is done too — because a
   * position is a place in the LOG, and passing it passes everything before it as well.
   *
   * The passed frames are dropped from the buffer here and only here: the cursor is what remembers
   * them from now on.
   */
  const advanceAppCursor = async (name: string, frames: Array<AppFrame>): Promise<void> => {
    const cursor = appCursors.get(name)
    if (cursor == null) return
    let passed = 0
    let position: LogPosition | null = null
    while (passed < frames.length && (frames[passed] as AppFrame).sealed == null) {
      position = (frames[passed] as AppFrame).position
      passed += 1
    }
    if (passed > 0) frames.splice(0, passed)
    if (position == null || position === cursor.position) return
    cursor.position = position
    await appCursorStore?.save(cursor.topicID, position)
  }

  /**
   * Record a log-class frame the LIVE lane was pushed, at the moment it arrives.
   *
   * THIS IS THE OTHER DELIVERER TAKING THE SAME READ POSITION. The live path hands a retained frame
   * to the host straight off the bus; before the push carried its log position there was nothing for
   * it to write down, so the cursor sat behind every frame an online peer had already been given and
   * every re-pull read them all back. One position, two deliverers, and only one of them kept it.
   *
   * WHAT IS RECORDED IS DONE-NESS, NOT DELIVERY, and the two are the same thing here. The transport
   * that carries this frame to the host is the same object, unwrapping with the same handle, so the
   * only question is whether the handle is at the frame's own seal epoch RIGHT NOW:
   *
   * - At it: this is the live lane's frame and its one chance is now. Whether the bytes open, or
   *   parse, or name a procedure anyone handles, the outcome is the drain's own — every path there
   *   either delivers or drops exactly as the transport does — so the frame is DONE either way.
   * - Above it: the frame is ahead of the walk. The transport cannot open it and drops it, so its
   *   bytes are kept and the drain delivers it when the walk reaches that epoch. Whether the claim
   *   is one the group's log can justify is the drain's question, asked with a network read this
   *   path must not make.
   * - Below it, or not a readable frame at all: dead. MLS ratchets forward, so no epoch this peer
   *   will ever hold again opens those bytes — a later pull would classify it dead too, which is
   *   why marking it done here loses nothing that was still recoverable.
   *
   * The epoch is read HERE and not at the merge, because the handle moves under the app lane's own
   * mutex-free push loop and the answer is only true of the moment the frame arrived.
   *
   * A MAILBOX frame has no place in any log and is skipped outright: nothing to advance over. That
   * is the whole reason the class has to travel with the push — ephemeral and logged app traffic
   * share one topic, so a peer that guessed from the topic would move its cursor over frames the log
   * does not contain.
   */
  const noteLiveAppFrame = (name: string, topicID: string, message: StoredMessage): void => {
    const position = message.logPosition
    if (position == null) return
    const sealedAt = crypto.frameEpoch(message.payload)
    const ahead = sealedAt != null && sealedAt > crypto.epoch()
    let staged = appStaged.get(name)
    if (staged == null) {
      staged = []
      appStaged.set(name, staged)
    }
    staged.push({
      topicID,
      frame: { position: asLogPosition(position), sealed: ahead ? message.payload : null },
    })
    scheduleAppLaneSync()
  }

  /**
   * Take the staged pushes into the buffer and move the durable cursor over them, off the back of
   * live traffic alone.
   *
   * A peer that is online and walks no commit still has to keep its position: without this the
   * cursor moves only when a commit does, and a group that is quiet on the commit lane and busy on
   * the app lane re-delivers its whole backlog on the next restart — which is the loss the cursor
   * exists to stop.
   *
   * It does NOT deliver. Delivery unwraps against the live handle, and this runs outside the commit
   * mutex where the handle can be mid-ratchet; a frame classified at one epoch and unwrapped at the
   * next would be called dead and dropped. So the buffer is filled and the cursor is advanced, and
   * anything still holding bytes waits for {@link deliverAppFrames}, which runs where the handle is
   * held still.
   *
   * COALESCED: a burst of pushes collapses into one pass, and the flag is cleared on entry so a
   * frame arriving during the pass schedules the next one rather than being left staged.
   */
  let appLaneSyncScheduled = false
  const scheduleAppLaneSync = (): void => {
    if (appLaneSyncScheduled) return
    appLaneSyncScheduled = true
    void runAppLane(async () => {
      appLaneSyncScheduled = false
      await loadAppSegment()
      for (const [name, frames] of appSegment) await advanceAppCursor(name, frames)
    }).catch(() => {
      // A hub that would not answer leaves the cursor where it is and the frames staged or
      // buffered; the next push, or the next drain, asks again.
    })
  }

  /**
   * Deliver every buffered app frame the handle can open AT THE EPOCH IT IS AT RIGHT NOW, and
   * leave the rest buffered. Called before each apply and once more when the walk ends.
   *
   * The invariant it exists for: a frame is opened at the epoch it was sealed at, so it must be
   * read BEFORE the handle ratchets past that epoch. Once the commit is applied the handle holds
   * a different epoch's key material and those bytes are ciphertext forever — so this runs ahead
   * of the apply, not after it, and the binding is per-FRAME-EPOCH, not per-rotation: every epoch
   * inside a segment has to be dispensed as the walk passes through it, not once at the anchor.
   *
   * Which frames are this epoch's is read from their own cleartext (`crypto.frameEpoch`) rather
   * than found by trying every buffered frame and catching. That is not an optimisation: the epoch
   * a frame was sealed at is what separates one it cannot open YET from one it can never open
   * again, `unwrap` throwing says only "not my epoch" and cannot tell them apart, and the cursor
   * below is safe only because that distinction exists. `unwrap` stays authoritative for anything
   * that claims this epoch — a frame's cleartext is the publisher's word relayed by an untrusted
   * hub, and a claim that will not open is treated exactly as any frame that will not open.
   *
   * A CLAIM OF A FUTURE EPOCH IS BOUNDED BY THE COMMIT LOG, for the same reason. Waiting on a
   * claim nothing can check turns an untrusted party's word into durable local state: one frame
   * claiming an epoch the group will never reach pins the cursor behind it for the segment's whole
   * life — the buffer grows without bound, the whole segment is re-delivered on every boot, and the
   * pruned-window notice fires forever — and against a roster-stable group nothing ever rotates the
   * segment out from under it. So the claim is checked against what the group's own commit log can
   * justify (see {@link justifiedEpochCeiling}), and a claim above that is DEAD, not ahead.
   *
   * Publish order IS non-decreasing in seal-epoch in an honest group, but the front of the buffer
   * can still hold a frame from an epoch the handle has ALREADY passed (a journal replay advances
   * it before this pull ever runs), so the buffer is walked whole rather than stopping at the first
   * frame that is not this epoch's. Delivery is in publish order and drops nothing.
   *
   * THE CURSOR ADVANCES over a run of frames this drain is DONE with, and stops dead at the first
   * frame it is not: a cursor may only pass a frame that is DELIVERED or DEAD. A frame sealed
   * BELOW this handle's epoch is dead (MLS ratchets forward — those bytes are ciphertext forever),
   * and so is one that claims this epoch and will not open, and so are bytes that are not a sealed
   * frame at all: no epoch this peer will ever hold again opens any of them. A frame sealed AHEAD
   * of the walk is neither delivered nor dead — it opens once the walk gets there — so the cursor
   * stops behind it and the frame stays buffered. Passing it would drop it on the next restart,
   * which is the whole loss this cursor exists to stop. A claim the commit log cannot justify is
   * not ahead of anything, and joins the dead.
   *
   * A FAILED PULL STALLS THE WALK. `loadAppSegment` raising propagates, `advanceHandle` never
   * reaches its advance, and no epoch is passed unread — the pull is a retry and the delivery is
   * not, so one dropped fetch mid-walk would otherwise destroy the backlog at every epoch the walk
   * then ratcheted through. A hub outage stalling commit processing is the accepted cost; the live
   * lane is dead in that window anyway.
   *
   * A LAGGARD publisher is the one case no ordering saves: a member still at epoch E writing to
   * this topic after the rest of the group rotated past E seals bytes nobody can open again.
   * Inherent, and not this drain's to repair.
   *
   * NOT delivered: this member's own frames. The live fan-out never echoes a publisher its own
   * broadcast, and a drain that did would make a returning member the only one to see its own
   * messages arrive.
   */
  /**
   * TAKEN UNDER THE APP LANE'S MUTEX, and the thing it excludes is the live lane's own cursor work
   * ({@link scheduleAppLaneSync}), which runs off the mux's push loop and therefore under no lock at
   * all. Two deliverers now write one read position, and every way they can interleave corrupts it:
   *
   * - The buffer is an ORDERED ARRAY this function walks while awaiting `unwrap` and a host handler
   *   inside the loop. A push splicing a frame in below the walk's index shifts every later element
   *   back one, so the walk re-reads one frame — a second delivery of a message already given to the
   *   host — and steps over another entirely.
   * - {@link advanceAppCursor} passes a run of done frames and then splices them off. A sync running
   *   between the read of the run and the splice passes the same frames again and cuts a second time,
   *   dropping frames the cursor never covered — silent loss of exactly the messages this position
   *   exists to protect.
   * - The cursor is DURABLE. Both paths end in `appCursorStore.save`, so an interleave does not just
   *   confuse the process, it writes the wrong position to disk, and a restart reads it back.
   *
   * NO DEADLOCK against the commit mutex, which is the one caller that holds a lock here: the two
   * are ordered, never nested the other way. Every call to this is from inside `runSerial` and takes
   * the app lane second; nothing that runs inside the app lane takes `runSerial`. The one path that
   * could is a HOST handler re-entering the peer from the delivery below — and that already
   * deadlocks on `runSerial` itself today, which is not reentrant, so this adds no reachable case.
   * The live sync never calls a handler, and so cannot re-enter at all.
   */
  const deliverAppFrames = (): Promise<void> => runAppLane(drainAppFrames)

  const drainAppFrames = async (): Promise<void> => {
    await loadAppSegment()
    // Read once per drain and only if a frame actually claims to be ahead: the log is a network
    // read, the honest buffer holds no such claim, and this handle's epoch does not move under a
    // single drain.
    let ceiling: number | null = null
    const justifies = async (claim: number): Promise<boolean> => {
      ceiling ??= await justifiedEpochCeiling()
      return claim <= ceiling
    }
    for (const [name, frames] of appSegment) {
      const eventHandlers = appEventHandlers.get(name)
      if (eventHandlers == null || frames.length === 0) continue
      for (const frame of frames) {
        const sealed = frame.sealed
        if (sealed == null) continue // done on an earlier pass, and only holding its place
        const sealedAt = crypto.frameEpoch(sealed)
        if (sealedAt !== crypto.epoch()) {
          // Not sealed at the epoch the handle is at right now, by the frame's own word. Ahead of
          // the walk AND justified by the group's commit log: it keeps its bytes and its place, and
          // the cursor may not pass it. Otherwise (below the walk, claiming an epoch no member
          // could have sealed at, or not a readable sealed frame at all) it is dead — no epoch this
          // peer can still reach opens it — and dead is done.
          if (sealedAt != null && sealedAt > crypto.epoch() && (await justifies(sealedAt))) continue
          frame.sealed = null
          continue
        }
        let opened: GroupUnwrapResult
        try {
          // `crypto.unwrap` always returns the full result — `senderDID` is REQUIRED — so there is
          // no bare-`Uint8Array` shortcut left to normalize away here.
          opened = await crypto.unwrap(sealed)
        } catch {
          // It claimed this epoch and the handle refused it. Only `unwrap` is authoritative, and
          // the handle never comes back to this epoch, so nothing will ever open these bytes: dead.
          frame.sealed = null
          continue
        }
        // Opened, so it is done whatever the payload turns out to be — every path below either
        // delivers it or drops it exactly as the live transport would.
        frame.sealed = null
        if (opened.senderDID === localDID) continue // its own echo, as the live path would not
        let message: { payload?: { typ?: string; prc?: unknown; data?: unknown } }
        try {
          message = JSON.parse(toUTF(opened.payload))
        } catch {
          continue // malformed: dropped, exactly as the live transport drops it
        }
        const prc = message.payload?.prc
        if (message.payload?.typ !== 'event' || typeof prc !== 'string') continue
        // A retained frame naming an EPHEMERAL procedure was published `retain: 'log'` by a member
        // whose dispatch would never do that. Retention is the protocol's word, not the frame's.
        if (retentionOf(protocols[name], prc) !== 'log') continue
        const handler = eventHandlers[prc]
        if (handler == null) continue
        try {
          await handler(message.payload.data ?? {}, opened.senderDID)
        } catch {
          // A host handler that threw has been delivered to. Re-delivering it on the next pull
          // would be the drain retrying the host's own bug at it, so the frame is consumed.
        }
      }
      await advanceAppCursor(name, frames)
    }
  }

  /**
   * THE ONE PATH THE HANDLE RATCHETS ON, and the invariant it holds: a handle does not ratchet
   * past an epoch until that epoch's frames are read and its anchor is taken. Both are one-way
   * doors — after the advance those frames are ciphertext forever, and that epoch's secret can
   * never be exported again — so neither can be done afterwards, by this or by anything else.
   *
   * A seam and not a rule, because a rule is only as good as the next site that advances the
   * handle: the peer ratchets in four places (a commit applied from the log, one this peer
   * AUTHORS, one adopted out of the journal on restart, and a rejoin), they are far apart, and
   * each was free to uphold half of this or none of it. Route them all through here and the fifth
   * cannot get it wrong — there is nowhere left to write the mistake.
   *
   * `advance` does the ratcheting and nothing else; everything around it is this function's.
   *
   * The ROSTER DIFF is what decides the rotation: the DIDs the handle held before the advance
   * against the DIDs it holds after — an Add, a Remove, or both in one commit, where the leaf
   * count does not move. It answers for membership, which is the question, and it answers the
   * same for a commit this peer applied and one it wrote. The before-read is unconditional and
   * has to be: whether the diff will be needed is not knowable until the advance has already
   * destroyed the answer.
   *
   * `rotatesAnyway` is the one thing no diff can see. An external-commit rejoin by a member the
   * roster still holds replaces that member's leaf and moves no DID — nothing observable changes —
   * and it must rotate all the same, because the anchor is >= every current member's EFFECTIVE
   * join and a rejoiner's effective join is its rejoin epoch: its rejoined handle exports no
   * secret from before it. So that one rotation rides the commit's own word about itself.
   *
   * The anchor is captured from the port's POST-advance handle: the epoch the group moved to, and
   * the same epoch every other member lands on by making this same advance — which is what makes
   * the anchor agreed rather than local.
   */
  const advanceHandle = async <T>(
    port: GroupMLS,
    advance: () => Promise<T>,
    rotatesAnyway: (advanced: T) => boolean = () => false,
  ): Promise<T> => {
    // Read this epoch's app frames BEFORE the advance that leaves it. A frame is opened at the
    // epoch it was sealed at, so this is the last moment it can be read: the advance ratchets the
    // handle on, and the key material for this epoch goes with it. Every epoch the walk passes
    // gets this — the constraint is per frame-epoch, not per rotation, so a segment spanning five
    // epochs is dispensed five times off the one pull.
    await deliverAppFrames()
    const rosterBefore = await port.rosterDIDs()
    const epochBefore = crypto.epoch()
    const advanced = await advance()
    // GATED ON THE HANDLE ACTUALLY RATCHETING, because a roster diff alone is not evidence that
    // it did. A commit that REMOVES this member does not advance its handle — there is no epoch
    // it can move to, since the commit's path excludes the leaf it drops — and yet real MLS still
    // applies its proposals to the tree, so the roster comes back WITHOUT this member at an epoch
    // that did not move. (Measured against ts-mls: `processMessage` returns without throwing, the
    // epoch stays, `listMembers()` has lost the leaf.) That is the one combination nothing else
    // produces, and undiscriminated it reads as a rotation.
    //
    // What an ungated capture costs: an anchor re-derived at the epoch it already names — the same
    // value, written again — and, with it, the segment buffer cleared. {@link captureAnchor} drops
    // undelivered frames because a rotation makes them unopenable forever, which is true of a
    // rotation and false here: this handle is still at the epoch those frames were sealed at. A
    // frame the live lane staged while the walk was running is openable and gets thrown away.
    //
    // The gate costs nothing in the other direction: a roster change IS a commit, and a commit
    // this handle applied moved its epoch.
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
  const walkCommits = async (port: GroupMLS, topicID: string): Promise<boolean> => {
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
        // A wire version this build does not know, settled BEFORE the kind byte: under an
        // unknown version nothing behind the magic means what this build thinks it means, the
        // kind included. On the commit topic — and only here — that is evidence in itself, so it
        // goes to the classifier rather than being dropped, and comes back `ahead`: the group
        // moved on to a format this build cannot read. Step over, heal, strand.
        if (frame.version !== HANDSHAKE_VERSION) {
          const unreadable = classifyCommit(UNKNOWN_FRAME_VERSION, position, {
            localDID,
            epoch: crypto.epoch(),
            appliedByEpoch,
          })
          reconciledHead = position
          // Do what the classifier said rather than what this branch assumes. It answers `ahead`
          // for this evidence today; anything else it ever answers is a row that steps over the
          // frame and spends nothing, which is what the bare cursor advance above already did.
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
        const header = await port.readCommitHeader(commitFrame.commit)
        const disposition = classifyCommit(header, position, {
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
          // Through the seam, like every other site that ratchets the handle: it reads this
          // epoch's app frames ahead of the apply and takes the anchor if the roster moved.
          applied = await advanceHandle(
            port,
            () =>
              port.processCommit(commitFrame.commit, {
                senderDID: message.senderDID,
                // The resolver, not the bodies: the blob is opened only if the port asks for the
                // entries this commit names, and it asks only for a commit it is applying — framed
                // at this peer's epoch, which is the epoch the blob is sealed under. That makes
                // body delivery atomic with the commit.
                //
                // The port calls this from INSIDE the apply, on the handle it is applying to, so
                // the open must not touch that handle's ratchet: `openEntries` reads only the
                // epoch's exporter secret and is pure.
                resolveLedgerEntries: createLedgerEntryResolver(
                  commitFrame.sealedEntries,
                  crypto.openEntries,
                ),
              }),
            // A REJOIN rotates the anchor too, from a member the roster diff cannot see: an
            // external commit by a member the roster still holds replaces that member's leaf and
            // leaves every DID where it was. Only a commit the port APPLIED says anything about
            // the group — a refused one is a flag on a frame nobody enacted.
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
    await deliverAppFrames()
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
      // log's tip as of that frame — a stale tip is safe (a commit racing it just loses the
      // compare-and-set and rebases), where a WRONG one would win a race it had no right to.
      const accepted = asLogPosition(entry.acceptedAs)
      reconciledHead = accepted
      commitLogHead = accepted
      appliedByEpoch.set(entry.epoch, accepted)
      // Through the seam: the adopt ratchets the handle, so this epoch's app frames are read
      // first and the anchor is taken if the journalled commit moved the roster. A peer coming
      // back to a roster change it made and never adopted advances exactly as far as any other
      // site does, and no further.
      await advanceHandle(mls, () => adoptJournalled(entry.journal))
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
        // The host adopts here, and adopting ratchets the handle — so it goes through the seam,
        // exactly as an applied commit does. A member never processes its own commit, so the
        // apply site never runs for the one commit that changes the roster this peer just
        // changed: without this, the author of a Remove keeps publishing to the topic the removed
        // member still holds, and the author of an Add sits on a topic the new member's handle
        // cannot derive — silently, in both directions, and no restart heals it.
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
        const rejoinedAtEpoch = (await port.readCommitHeader(pending.commit))?.epoch
        // Through the seam, like every other site that ratchets the handle — and it rotates
        // ANYWAY: this is the rejoin, and no roster diff can see it. The peer's own half of the
        // rotation every member applying this same external commit performs; it can never take
        // the other half, since a member does not process its own commit.
        //
        // The anchor is the POST-commit epoch, not the epoch the commit is framed at, and the
        // seam is what makes that so: the handle advances inside it and only then is the anchor
        // captured — exactly where an applying member lands, since applying this commit is what
        // carries them off the epoch it is framed at.
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
    // Settle the app-lane anchor BEFORE the seed pull: a roster change the seed pull applies must
    // be able to rotate it off whatever lands here rather than have a later seed overwrite the
    // rotation. Both branches run before `initControlLanes` below, so every lane is built on the
    // settled anchor.
    //
    // A stored anchor is RESTORED, never recomputed. This construction is not necessarily
    // genesis: it is just as likely a restart over a handle the group has carried past the last
    // roster change. The anchor sits at that roster change and the handle ratchets forward, so
    // there is nothing to recompute from — the live handle exports the live epoch's secret and
    // no earlier one. Seeding from it here would put this peer on a topic of its own, invisible
    // to every member that did not restart and blind to them.
    //
    // An empty store is first boot, and only first boot: seed at the initial epoch, as a group
    // with no roster change yet must, and persist it. A member booting over a handle it was just
    // added to seeds at its own add epoch — the same epoch every existing member rotates to on
    // applying that add, which is what makes the two agree with no exchange between them.
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
