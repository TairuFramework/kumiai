import type { Client } from '@enkaku/client'
import type {
  DataOf,
  EventProcedureDefinition,
  ProtocolDefinition,
  RequestProcedureDefinition,
  ReturnOf,
} from '@enkaku/protocol'
import type { ProcedureHandlers } from '@enkaku/server'
import { normalizeDID } from '@kokuin/token'
import {
  BroadcastClient,
  createBroadcastResponder,
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

import type { Anchor, AnchorSlot, AnchorStore } from './anchor.js'
import { decodeAppAAD, encodeAppAAD } from './app-aad.js'
import type { AppCursorStore, AppWindowPruned } from './app-cursor.js'
import { type AppDeliveryResumed, type AppDeliveryStalled, createAppLane } from './app-lane.js'
import { type AppOutbox, type CommitCursor, createAppOutboxAcceptance } from './app-outbox.js'
import {
  type AppliedCommit,
  classifyCommit,
  digestAppliedCommit,
  UNKNOWN_FRAME_VERSION,
} from './classify.js'
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
  isFrameAhead,
  isMissingLedgerEntries,
  type OpenedRecoveryVerdict,
  type PendingAppFrame,
  type PendingRecovery,
  type ProcessCommitResult,
  type RecoveryRefusalReason,
} from './crypto.js'
import { asLogPosition, assertForwardPage, type LogPosition } from './cursor.js'
import {
  createDirectedClient,
  createInboxAcceptor,
  createInboxPath,
  createUnroutedTagResponder,
  type InboundPath,
} from './directed.js'
import { PeerDisposedError } from './errors.js'
import { assertFrameFits } from './frame-size.js'
import { adaptBusHandlers, type BusHandlerMaps, type GroupProcedureHandlers } from './handlers.js'
import {
  decodeHandshakeFrame,
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
  HANDSHAKE_VERSION,
} from './handshake.js'
import {
  createHostBoundary,
  wrapCommitBuild,
  wrapGatherOptions,
  wrapPeerHost,
  wrapPendingCommit,
  wrapPendingRecovery,
} from './host-boundary.js'
import { notifyHost } from './host-notice.js'
import {
  createHubMux,
  type HubMux,
  type ReceiveLaneEnded,
  type SubscribeFailure,
} from './hub-mux.js'
import { createLedgerEntryResolver, encodeLedgerEntries } from './ledger-entries.js'
import {
  type AppOutboxCleared,
  checkedFetchResult,
  createLogDelivery,
  type EpochFloor,
} from './log-delivery.js'
import { createOpenOncePath } from './open-once.js'
import { type GroupProtocolDefinition, retentionOf } from './protocol.js'
import {
  decodeLedgerReply,
  decodeLedgerRequest,
  decodeRecoveryConfirmRequest,
  decodeRecoveryReply,
  decodeRecoveryRequest,
  decodeRecoveryVerdict,
  encodeLedgerReply,
  encodeLedgerRequest,
  encodeRecoveryConfirmRequest,
  encodeRecoveryReply,
  encodeRecoveryRequest,
  encodeRecoveryVerdict,
} from './recovery.js'
import {
  confirmationTag,
  createRecoveryCache,
  type RecoveryCommitOutcome,
  waitForRecoveryConfirmation,
} from './recovery-confirmation.js'
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

const CONFIDENCE_RANK: Record<StrandConfidence, number> = {
  claimed: 0,
  observed: 1,
  authenticated: 2,
}

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
  /** Durable log plaintext. The host owns encryption at rest and erasure. */
  appOutbox: AppOutbox
  /** Accepted entries plus unresolved inserts. At the cap, new log events are refused. */
  appOutboxLimit: number
  /** Accepted events discarded after an applied local removal. Notices are not replayed. */
  onAppOutboxCleared?: (event: AppOutboxCleared) => void | Promise<void>
  /** Durable single-slot journal. Written before every publish, cleared on both outcomes. */
  journal: CommitJournal
  /**
   * Durable anchor slot. Records each advance before it runs and clears the record after resolution.
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

export type StrandKind =
  | 'own-unmerged'
  | 'fork-losing'
  | 'ahead'
  | 'unknown-version'
  | 'retention-gap'
/**
 * For `own-unmerged`, `authenticated` means this device sealed a commit at this epoch that the
 * hub now places in the log. `readCommitHeader` identifies its leaf from PrivateMessage sender
 * data, AEAD-opened with this epoch's `sender_data_secret` and a ciphertext sample. Commit content
 * is unverified; a hub can tamper past the sample and serve a captured, rejected frame.
 */
export type StrandConfidence = 'authenticated' | 'observed' | 'claimed'
/** A stranded-frame notice. `own-unmerged` does not prove commit content or hub acceptance; heal. */
export type StrandObservation = {
  groupID: string
  position: string
  commitDigest: string | null
  localEpoch: number
  claimedEpoch: number | null
  kind: StrandKind
  confidence: StrandConfidence
}

export type RecoveryTrigger = 'automatic' | 'consumer'
export type RecoveryFailureReason =
  | 'no-responder'
  | 'renewal-required'
  | 'refused'
  | 'unconfirmed'
  | 'bootstrap-failed'
  | 'deadline'
  | 'disposed'
  | 'error'

type RecoveryEventBase = { groupID: string; attemptID: string; trigger: RecoveryTrigger }

export type RecoveryEvent =
  | (RecoveryEventBase & { phase: 'started' })
  | (RecoveryEventBase & { phase: 'succeeded' })
  | (RecoveryEventBase & {
      phase: 'failed'
      reason: RecoveryFailureReason
      error?: unknown
      refusal?: RecoveryRefusalReason
      responder?: string
      advisory?: Array<OpenedRecoveryVerdict>
    })
  | (RecoveryEventBase & { phase: 'bootstrapped' })

type RendezvousOutcome =
  | { kind: 'reply'; sealed: Uint8Array }
  | { kind: 'timeout'; atDeadline: boolean }
  | { kind: 'disposed' }
  | { kind: 'publish-failed'; error: unknown }

export type GroupPeerParams<Protocols extends Record<string, GroupProtocolDefinition>> = {
  hub: LogHub
  crypto: GroupCrypto
  localDID: string
  protocols: Protocols
  handlers: { [K in keyof Protocols]: GroupProcedureHandlers<Protocols[K]> }
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
  onStrand?: (observation: StrandObservation) => void | Promise<void>
  onRecovery?: (event: RecoveryEvent) => void | Promise<void>
  onAppDeliveryStalled?: (event: AppDeliveryStalled) => void | Promise<void>
  onAppDeliveryResumed?: (event: AppDeliveryResumed) => void | Promise<void>
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
      appOutbox?: undefined
      appOutboxLimit?: undefined
      journal?: undefined
      adoptJournalled?: undefined
      anchorStore?: undefined
      appCursorStore?: undefined
    }
)

type FilterNever<T> = { [K in keyof T as T[K] extends never ? never : K]: T[K] }

type GroupEventDefs<Protocol extends GroupProtocolDefinition> = FilterNever<{
  [P in keyof Protocol & string]: Protocol[P] extends EventProcedureDefinition
    ? { Data: DataOf<Protocol[P]['data']> }
    : never
}>
type GroupRequestDefs<Protocol extends GroupProtocolDefinition> = FilterNever<{
  [P in keyof Protocol & string]: Protocol[P] extends RequestProcedureDefinition
    ? { Param: DataOf<Protocol[P]['param']>; Result: ReturnOf<Protocol[P]['result']> }
    : never
}>

// One public type argument only. The `Events`/`Requests` helper params — present solely to avoid
// recomputing the defs maps in each member — live on the non-exported `ProtocolSurfaceOf` this
// delegates to, so a caller cannot write `ProtocolSurface<X, ForgedEvents, ForgedRequests>` to
// inject names/payloads/results the protocol never declared.
export type ProtocolSurface<Protocol extends GroupProtocolDefinition> = ProtocolSurfaceOf<Protocol>

type ProtocolSurfaceOf<
  Protocol extends GroupProtocolDefinition,
  Events extends GroupEventDefs<Protocol> = GroupEventDefs<Protocol>,
  Requests extends GroupRequestDefs<Protocol> = GroupRequestDefs<Protocol>,
> = {
  /** Log dispatch resolves at durable acceptance, with ordered at-least-once delivery and completion-safe retries. */
  dispatch: <P extends keyof Events & string, T extends Events[P] = Events[P]>(
    prc: P,
    ...args: T['Data'] extends never ? [config?: { data?: never }] : [config: { data: T['Data'] }]
  ) => Promise<void>
  request: <P extends keyof Requests & string, T extends Requests[P] = Requests[P]>(
    prc: P,
    ...args: T['Param'] extends never
      ? [config?: { param?: never } & RequestOptions]
      : [config: { param: T['Param'] } & RequestOptions]
  ) => Promise<T['Result']>
  gather: <P extends keyof Requests & string, T extends Requests[P] = Requests[P]>(
    prc: P,
    ...args: T['Param'] extends never
      ? [config?: { param?: never } & GatherOptions<T['Result']>]
      : [config: { param: T['Param'] } & GatherOptions<T['Result']>]
  ) => Promise<Array<GatheredReply<T['Result']>>>
  to: (memberDID: string) => Promise<Client<Protocol>>
}

// The untyped internal shape surfaceFor builds against, bridged to the positional BroadcastClient.
// Exported so the conformance test binds to this real type rather than a hand-copied literal.
export type InternalSurface = {
  dispatch: (prc: string, config?: { data?: Record<string, unknown> }) => Promise<void>
  request: (prc: string, config?: { param?: unknown } & RequestOptions) => Promise<unknown>
  gather: (
    prc: string,
    config?: { param?: unknown } & GatherOptions,
  ) => Promise<Array<GatheredReply>>
  to: (memberDID: string) => Promise<Client<ProtocolDefinition>>
}

export type GroupPeer<Protocols extends Record<string, GroupProtocolDefinition>> = {
  protocol: <K extends keyof Protocols>(name: K) => ProtocolSurface<Protocols[K]>
  /** Accept loss of one buffered sealed app frame, then resume the journal-first walk. */
  dropAppFrame: (topicID: string, position: string) => Promise<void>
  /** Schedule an immediate app pull and wake matching delivery workers. No-op after disposal. */
  retryAppDelivery: (topicID?: string) => Promise<void>
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
   * `holdLogSends` blocks submissions immediately, including prepared frames, until landing or known loss.
   * Existing log submissions settle before the held commit is journalled or published.
   *
   * A RESULT means it landed and `onAccepted` ran; a THROW means it did not — stranded, ledger
   * incomplete ({@link "commit".RecoveryRequiredError}), or deadline lost
   * ({@link "commit".CommitDeadlineError}). Call {@link replay} after a throw to collect any
   * undrained `lost` / `reenact` work.
   */
  commit: (
    build: () => Promise<PendingCommit>,
    options?: { holdLogSends?: true },
  ) => Promise<LaneResult>
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
  /**
   * Re-drive any hub subscription this peer latched as refused, on the host's word that the refusal
   * may now be answered differently. The one case that needs it: a peer whose group topics were
   * subscribed the instant it joined — before the app-level authorization that gates them had landed
   * — is refused `AuthorizationDeniedError`, and that refusal is latched permanent (a busy retry
   * against an answer would be worse). Once the host knows the peer is authorized (its membership
   * row has replicated), it calls this to ask again. Single-shot per call: a topic the hub still
   * refuses simply re-latches, so call it on each authorization change rather than to poll.
   */
  reauthorize: () => void
  dispose: () => Promise<void>
  /**
   * After dispose(), wait for teardown and every invoked host effect, including abandoned promises.
   * Never await from this peer's counted callbacks or port calls. Drain before replacing its owner.
   */
  drained: () => Promise<void>
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
  input: GroupPeerParams<Protocols>,
): GroupPeer<Protocols> {
  const boundary = createHostBoundary()
  const params = wrapPeerHost(boundary, input)
  const {
    hub,
    crypto,
    mls,
    journal: hostJournal,
    adoptJournalled,
    anchorStore,
    appCursorStore,
    protocols,
    handlers,
    suppress,
  } = params
  let revokeHolds = 0
  let heldJournalID: string | undefined
  const logSubmissions = new Set<Promise<unknown>>()
  const journal: CommitJournal | undefined =
    hostJournal == null
      ? undefined
      : {
          get: async () => {
            const entry = await hostJournal.get()
            heldJournalID = entry?.holdsLogSends === true ? entry.publishID : undefined
            return entry
          },
          put: async (entry) => {
            await hostJournal.put(entry)
            heldJournalID = entry.holdsLogSends === true ? entry.publishID : undefined
          },
          markAccepted: (publishID, sequenceID) => hostJournal.markAccepted(publishID, sequenceID),
          clear: async (publishID) => {
            await hostJournal.clear(publishID)
            if (heldJournalID === publishID) heldJournalID = undefined
            logDelivery?.trigger()
          },
        }
  const logSendsHeld = (): boolean => revokeHolds > 0 || heldJournalID != null
  const settleLogSubmissions = async (): Promise<void> => {
    await Promise.allSettled([...logSubmissions])
  }
  if (crypto.pending != null && mls == null) {
    throw new Error('GroupCrypto.pending requires mls and the durable commit lane')
  }
  // Normalized ONCE, here, at the one ingress every downstream `localDID` use reads from —
  // equivalent DID forms must compare and derive topics identically (`@kokuin/token`
  // canonicalizes, it does not validate).
  const localDID = normalizeDID(params.localDID)
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
   * The one peer-level consumer of the shared inbox path that NACKs a frame tagged for a protocol
   * no acceptor here serves — every acceptor filters on its own tag, so such a frame would
   * otherwise be dropped silently. Rebuilt with the epoch, since it replies on the anchor-bound
   * inbox topics the rotation moves.
   */
  let unroutedTagResponder: { dispose: () => void } | undefined

  /**
   * The host's app event handlers, per protocol, as the drain calls them — the same adaptation
   * the live bus server is built from, so a drained frame and a pushed one reach the host by the
   * same door. Built once: the handlers a host passed at construction do not change, and the
   * drain outlives any one epoch's runtime (it runs mid-walk, when the app lane has been torn
   * down and not yet rebuilt).
   */
  const appEventHandlers = new Map<string, BusHandlerMaps['events']>()
  for (const [name, protocol] of Object.entries(protocols)) {
    appEventHandlers.set(
      name,
      adaptBusHandlers(protocol, handlers[name] as Record<string, unknown>, suppress).events,
    )
  }

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
  // Placeholder until `ready` restores or captures the anchor; nothing derives a topic before.
  let anchor: Anchor = {
    secret: new Uint8Array(),
    epoch: crypto.epoch(),
  }
  let appNoticeInSerial = false

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
    ...(appCursorStore != null ? { appCursorStore } : {}),
    ...(onAppWindowPruned != null ? { onAppWindowPruned } : {}),
    ...(params.onAppDeliveryStalled != null
      ? {
          onAppDeliveryStalled: (event: AppDeliveryStalled) => {
            hostOutbox.push(() => {
              if (!disposed) notifyHost((value) => params.onAppDeliveryStalled?.(value), event)
            })
          },
        }
      : {}),
    ...(params.onAppDeliveryResumed != null
      ? {
          onAppDeliveryResumed: (event: AppDeliveryResumed) => {
            const notify = () => {
              if (!disposed) notifyHost((value) => params.onAppDeliveryResumed?.(value), event)
            }
            if (appNoticeInSerial) hostOutbox.push(notify)
            else queueMicrotask(notify)
          },
        }
      : {}),
    scheduleDelivery: (start) => {
      hostOutbox.push(start)
    },
  })

  let sealBarrier: Promise<void> | undefined
  let releaseSealBarrier: (() => void) | undefined
  let anchorPending: AnchorSlot['pending']
  let anchorRecoveryPending = false
  let sealError: Error | undefined
  const finishSealBarrier = (): void => {
    sealBarrier = undefined
    releaseSealBarrier?.()
    releaseSealBarrier = undefined
  }

  const captureAnchor = async (): Promise<void> => {
    const { secret, epoch } = await crypto.exportSecret(APP_TOPIC_LABEL)
    if (disposed) return
    for (const name of Object.keys(protocols)) {
      mux.retainTopic(protocolTopic(secret, epoch, name), { retention: appLogRetentionSeconds })
    }
    mux.retainTopic(inboxTopic(secret, epoch, localDID), { retention: appLogRetentionSeconds })
    anchor = { secret, epoch }
    anchorPending = undefined
    sealError = undefined
    finishSealBarrier()
    await anchorStore?.save({ anchor })
    appLane.reset()
  }

  /** The advance whose anchor rotation was last captured, so a retry never captures it twice. */
  let capturedAdvance: string | undefined
  const resolveAnchorRotation = async (
    port: GroupMLS,
    knownUnlanded = false,
    initial = false,
    landed = false,
  ): Promise<void> => {
    const record = anchorPending
    if (record == null) return
    const epoch = await port.readEpoch()
    assertLive()
    // A rejoin from a losing branch can land on its old epoch number, so the number alone cannot
    // say whether it landed. Only the advance that resolved knows — unless that advance already
    // captured its anchor, and this record is a retry opened at the epoch it landed on.
    const sameNumber = record.epochAfter === record.epochBefore
    const landedHere = sameNumber && landed && record.advance !== capturedAdvance
    if (epoch === record.epochBefore && !landedHere) {
      if (!knownUnlanded && !initial) return
      if (sameNumber && !knownUnlanded) {
        // Found at startup with nothing to tell the two states apart: recover rather than keep an
        // anchor that may belong to the losing branch.
        anchorRecoveryPending = true
        healRequested = true
        sealError = new Error('app anchor requires confirmed recovery')
        return
      }
      anchorPending = undefined
      sealError = undefined
      finishSealBarrier()
      await anchorStore?.save({ anchor })
    } else if (epoch === record.epochAfter) {
      const roster = (await port.rosterEntries()).map((entry) => normalizeDID(entry.did))
      if (record.forced || detectRosterChange(record.rosterBefore, roster)) {
        await captureAnchor()
        capturedAdvance = record.advance
      } else {
        anchorPending = undefined
        sealError = undefined
        finishSealBarrier()
        await anchorStore?.save({ anchor })
      }
    } else {
      anchorRecoveryPending = true
      healRequested = true
      sealError = new Error('app anchor requires confirmed recovery')
    }
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
   * Whether a frame `unwrap` just refused might still open once this handle catches up — read from
   * the refusal's locked answer ({@link "crypto".FrameEpochError}), never the epoch hint.
   * On the open-once failure path ({@link "open-once".OpenOncePathParams.retainOnFailure}) answering
   * `true` withholds the ack so the frame survives a reconnect. Mailbox-class frames have no staging
   * of their own (unlike `app-lane.ts`'s `note`/`ahead`), which is what made acking a transient
   * refusal here a permanent loss.
   */
  const retainOnFailure = (_message: StoredMessage, error: unknown): boolean => isFrameAhead(error)

  // Live log pushes carry no authoritative bytes or position. One queued journal-first pull
  // covers a burst; a failed pull retries without waiting for another hub delivery.
  let appPullNeeded = false
  let appPullActive = false
  let appPullTimer: ReturnType<typeof setTimeout> | undefined
  let appPullBackoff = 1000
  let appPullRetryNow = false
  const armAppPull = (delay: number): void => {
    if (disposed || appPullActive || appPullTimer != null) return
    appPullTimer = setTimeout(() => {
      appPullTimer = undefined
      if (disposed) return
      appPullActive = true
      appPullNeeded = false
      let retryDelay = 0
      void (async () => {
        try {
          await ready
          if (disposed) return
          await runSerial(async () => {
            await replayJournal()
            await ensureLedger(Date.now() + recoveryTimeoutMs)
            await reconcileCommits()
          })
          await healIfRequested()
          appPullBackoff = 1000
        } catch {
          appPullNeeded = true
          retryDelay = appPullBackoff
          appPullBackoff = Math.min(appPullBackoff * 2, 60_000)
        } finally {
          appPullActive = false
          if (appPullNeeded && !disposed) {
            armAppPull(appPullRetryNow ? 0 : retryDelay)
            appPullRetryNow = false
          }
        }
      })()
    }, delay)
  }
  const requestAppPull = (): void => {
    appPullNeeded = true
    armAppPull(0)
  }
  const retryAppPull = (): void => {
    if (disposed) return
    appPullBackoff = 1000
    appPullNeeded = true
    if (appPullTimer != null) {
      clearTimeout(appPullTimer)
      appPullTimer = undefined
    }
    appPullRetryNow = appPullActive
    armAppPull(0)
  }

  /**
   * The app lane's inbound path: one open per topic, fanned out as plaintext, with each frame's
   * log position noted once its open settles. Every consumer's own `unwrap` is then a pure lookup of the
   * opened result ({@link openedFrames}), and nothing downstream touches the handle.
   *
   * See {@link createOpenOncePath} for why a lane may only open a frame once.
   */
  const createInboundPath = (name: string, topicID: string) => {
    return createOpenOncePath<Uint8Array>({
      mux,
      topicID,
      unwrap: (b) => {
        const hinted = crypto.frameAAD(b)
        const decoded = hinted == null ? null : decodeAppAAD(hinted)
        const intent = decoded?.topicID === topicID ? decoded.intent : 'ephemeral'
        return crypto.unwrap(b, { expectedAAD: encodeAppAAD({ topicID, intent }) })
      },
      retainOnFailure,
      project: (_message, opened) => {
        const { payload, senderDID } = opened
        if (typeof senderDID !== 'string' || senderDID === '') {
          // `project` returning `undefined` drops the frame deliberately (see
          // `OpenOncePathParams.project`): the app lane is always MLS-sealed, so an open that
          // recovers no sender is not a frame to deliver unattributed. Fails CLOSED against the
          // shared open-once signature's wider `UnwrapResult`.
          return undefined
        }
        // Normalized at the open, before it is keyed: every consumer of `openedFrames` (the
        // acceptor, `gather`'s quorum) must see one canonical sender regardless of which DID form
        // MLS recovered this frame under.
        openedFrames.set(payload, { ...opened, senderDID: normalizeDID(senderDID) })
        return payload
      },
      note: (message, failure) => appLane.note(name, topicID, message, failure),
      wakeup: (message) => {
        if (crypto.pending == null) return false
        const aad = crypto.frameAAD(message.payload)
        if (aad == null || decodeAppAAD(aad)?.intent !== 'log') return false
        requestAppPull()
        return true
      },
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
    const next = new Map<string, ProtocolRuntime>()
    // ONE inbox lane for the whole peer, not one per protocol: the topic does not name a
    // protocol, so every acceptor and directed client opening its own frames is the defect this
    // shape prevents.
    const selfInbox = inboxTopic(anchor.secret, anchor.epoch, localDID)
    inboxLane = {
      topicID: selfInbox,
      path: createInboxPath({
        mux,
        topicID: selfInbox,
        unwrap: (b) =>
          crypto.unwrap(b, {
            expectedAAD: encodeAppAAD({ topicID: selfInbox, intent: 'ephemeral' }),
          }),
        retainOnFailure,
      }),
    }
    // ONE responder for the whole peer, on the shared path: it NACKs any frame whose tag names a
    // protocol not in `protocols`, restoring the legible reply an acceptor's own filter drops.
    unroutedTagResponder = createUnroutedTagResponder({
      mux,
      localDID,
      inbound: inboxLane.path,
      isRegistered: (name) => Object.hasOwn(protocols, name),
      sealReply: sealDirectedReply,
    })
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
      const { events, requestHandlers } = adaptBusHandlers(
        protocol,
        handlers[name] as Record<string, unknown>,
        suppress,
      )
      const busServer = createBroadcastResponder({
        transport: segmentBoundTransport(name, topicID, inbound),
        from: localDID,
        requestHandlers,
        events,
      })
      const acceptor = createInboxAcceptor<ProtocolDefinition>({
        mux,
        localDID,
        selfInboxTopic: selfInbox,
        inbound: inboxLane.path,
        resolveSendTopic: (senderDID) => inboxTopic(anchor.secret, anchor.epoch, senderDID),
        protocol: protocol as ProtocolDefinition,
        protocolName: name,
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
    // A bare unsubscribe of the shared path — synchronous, cannot reject — dropped alongside the
    // acceptor consumers of that same path.
    unroutedTagResponder?.dispose()
    unroutedTagResponder = undefined
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
    // Defensive: no child rejects today — all are enkaku `Disposer`-based (a failing dispose is
    // swallowed to `console.warn`, the promise still resolves) or a refcount decrement that cannot
    // throw — so this guards a future non-`Disposer` child. Kept live because rotation shares this
    // path, and a `BroadcastClient.prototype.dispose` spy forces it in test.
    if (reasons.length > 0) {
      throw new AggregateError(reasons, 'Group epoch teardown failed')
    }
  }

  /** Wait while an advance can move the handle before its new anchor is captured. */
  const sealForSegment = async (
    name: string,
    bytes: Uint8Array,
    intent: 'ephemeral' | 'log' = 'ephemeral',
  ): Promise<{ topicID: string; payload: Uint8Array }> => {
    while (true) {
      if (sealError != null) throw sealError
      if (sealBarrier != null) {
        await sealBarrier
        continue
      }
      const at = anchor
      const topicID = protocolTopic(at.secret, at.epoch, name)
      const payload = await crypto.wrap(bytes, { aad: encodeAppAAD({ topicID, intent }) })
      if (sealError != null) throw sealError
      if (anchor === at && sealBarrier == null) {
        assertFrameFits(payload)
        return { topicID, payload }
      }
    }
  }

  /**
   * Seal a directed reply (the unrouted-tag NACK) to a recipient's inbox under ONE anchor snapshot.
   * The reply topic and the seal must agree on the epoch: were the topic read from the live anchor
   * and the seal taken as a separate step, a rotation landing between them would address an
   * old-epoch inbox with new-epoch ciphertext, published onto a topic the recipient no longer reads
   * and silently lost. Re-read the anchor after the seal and re-seal if it moved — same identity
   * (not epoch-equality) guard as {@link sealForSegment}.
   */
  const sealDirectedReply = async (
    recipientDID: string,
    tagged: Uint8Array,
  ): Promise<{ topicID: string; payload: Uint8Array }> => {
    while (true) {
      const at = anchor
      const topicID = inboxTopic(at.secret, at.epoch, recipientDID)
      const payload = await crypto.wrap(tagged, {
        aad: encodeAppAAD({ topicID, intent: 'ephemeral' }),
      })
      if (anchor === at) return { topicID, payload }
    }
  }

  const appOutboxAcceptance =
    mls == null
      ? undefined
      : createAppOutboxAcceptance({
          outbox: params.appOutbox,
          limit: params.appOutboxLimit,
          admission: () => mls.sendAdmission(),
        })

  let floor: EpochFloor = { epoch: crypto.epoch(), position: null, covered: true }
  let locallyRemoved = false
  const logDelivery =
    appOutboxAcceptance == null || mls == null
      ? undefined
      : createLogDelivery({
          queue: appOutboxAcceptance,
          ready: async () => {
            await ready
            if (heldJournalID != null) {
              await runSerial(async () => {
                if (await replayJournal()) await rebuildEpoch()
              })
            }
          },
          floor: () => floor,
          held: () =>
            logSendsHeld() ||
            locallyRemoved ||
            stranded ||
            anchorRecoveryPending ||
            sealBarrier != null ||
            sealError != null ||
            activeRecovery != null ||
            !mls.sendAdmission().admissible,
          probe: async () => {
            if (commitTopicID == null) throw new Error('Commit topic is unavailable')
            const result = checkedFetchResult(
              await mux.fetchTopic({
                topicID: commitTopicID,
                ...(floor.position != null ? { after: floor.position } : {}),
                limit: 1,
              }),
            )
            commitLogHead = result.head == null ? null : asLogPosition(result.head)
            return result
          },
          pull: async () => {
            await runSerial(async () => {
              await replayJournal()
              await ensureLedger(Date.now() + recoveryTimeoutMs)
              await reconcileCommits()
            })
            await healIfRequested()
          },
          heal: async () => {
            healRequested = true
            await healIfRequested()
          },
          seal: async (entry) => {
            while (true) {
              const at = anchor
              const frame = await sealForSegment(entry.protocol, entry.data, 'log')
              const epoch = crypto.frameEpoch(frame.payload)
              const snapshot = floor
              const admission = mls.sendAdmission()
              if (anchor !== at || sealBarrier != null || snapshot.epoch !== epoch) continue
              if (sealError != null) throw sealError
              if (!admission.admissible || admission.epoch !== epoch) {
                throw new Error('Application admission snapshot moved')
              }
              return { ...frame, floor: snapshot }
            }
          },
          put: (entry) => params.appOutbox.put(entry),
          publish: (frame) => {
            // No await between the hold check, registration and transport handoff.
            if (logSendsHeld()) return null
            let settle = (): void => {}
            const completion = new Promise<void>((resolve) => {
              settle = resolve
            })
            logSubmissions.add(completion)
            const finish = (): void => {
              logSubmissions.delete(completion)
              settle()
            }
            try {
              const submission = mux.publish({ ...frame, retain: 'log' })
              void submission.then(finish, finish)
              return submission
            } catch (error) {
              finish()
              throw error
            }
          },
          remove: (seq) => params.appOutbox.remove(seq),
          clear: () => params.appOutbox.clear(),
          cleared: (notice) => notifyHost(params.onAppOutboxCleared, notice),
        })

  const surfaceFor = (name: string): InternalSurface => {
    const runtime = runtimes.get(name)
    if (runtime == null) throw new Error(`Unknown protocol: ${name}`)
    return {
      dispatch: async (prc, config) => {
        const data = config?.data ?? {}
        // Route by the procedure's declared retention. A `log` event goes to the app topic's log
        // lane (retained, pullable); ephemeral events and RPC stay on the live mailbox lane. The
        // log payload is byte-identical to what the broadcast transport would produce, so online
        // subscribers still receive it through the same drain.
        const protocol = protocols[name]
        if (protocol === undefined) throw new Error(`Unknown protocol: ${name}`)
        if (retentionOf(protocol, prc) === 'log') {
          const { topicID, payload } = await sealForSegment(
            name,
            encodeEventFrame(prc, data),
            'log',
          )
          await mux.publish({ topicID, payload, retain: 'log' })
          return
        }
        await runtime.client.dispatch(prc, data)
      },
      request: (prc, config) =>
        runtime.client.request(prc, config?.param, {
          errorThreshold: config?.errorThreshold,
          timeoutMs: config?.timeoutMs,
        }),
      gather: (prc, config) =>
        runtime.client.gather(prc, config?.param, {
          quorum: config?.quorum,
          timeoutMs: config?.timeoutMs,
          onReply: config == null ? undefined : wrapGatherOptions(boundary, config).onReply,
          signal: config?.signal,
        }),
      to: async (memberDID) => {
        // Normalized ONCE, at the ingress: the cache key, the topic derivation and the
        // directed client's own filter (`senderDID !== memberDID`) must all see one canonical
        // form, or a long-form caller never converges onto the short form MLS actually replies
        // under.
        const member = normalizeDID(memberDID)
        const cached = runtime.directed.get(member)
        if (cached != null) return cached.client
        const lane = inboxLane
        if (lane == null) throw new Error('Peer is not started')
        const created = createDirectedClient<ProtocolDefinition>({
          mux,
          localDID,
          memberDID: member,
          sendTopicID: inboxTopic(anchor.secret, anchor.epoch, member),
          // The epoch's own inbox topic and its one open path: reading replies through a path
          // built for a topic this client does not receive on would spend keys opening frames for
          // a lane nobody listens to.
          receiveTopicID: lane.topicID,
          inbound: lane.path,
          wrap: crypto.wrap,
          protocol: name,
          ...(params.runtime != null ? { runtime: params.runtime } : {}),
        })
        runtime.directed.set(member, created)
        return created.client
      },
    }
  }

  const rebuildEpoch = async (): Promise<void> => {
    if (disposed) return
    await teardownEpoch()
    if (disposed) return
    await buildEpoch()
  }

  /**
   * Set as `dispose()`'s FIRST statement. The peer's post-dispose rule has two forms and this is
   * the host-facing one: everything a HOST asks of a disposed peer is refused, loudly. The inbound
   * side is refused silently, where a delivery has no caller to tell: the commit lane
   * (`onCommitDelivery`), and the two rendezvous responders, whose reply timers can fire before
   * dispose and would otherwise land their publish after it.
   *
   * The check belongs immediately after each entry point's `await ready`, because that await is
   * where the race lives. Disposal can tear down while a call queued during init resumes.
   * Unguarded, each entry point fails differently and none says why: `to()` handed back a live-looking
   * client over an already-aborted transport, `resync()` rebuilt a whole epoch onto a disposed
   * mux, and `commit()` published to the hub from a peer that is gone. In the mirror ordering,
   * where teardown got there first and emptied `runtimes`, a protocol call blamed
   * `Unknown protocol` for a peer that no longer exists.
   *
   * The `resync` leak is LOCAL and invisible from the hub — do not re-derive it as re-subscribing.
   * `resync`'s own comment carries the mechanism; read it there rather than restating it here.
   */
  let disposed = false
  let disposePromise: Promise<void> | undefined
  const assertLive = (): void => {
    if (disposed) throw new PeerDisposedError('Peer is disposed')
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
  let durableCursor: CommitCursor | null = null
  /**
   * Persist the strand before anything steps past its evidence. The durable position stays where
   * it was, so a restart re-reads an ahead frame; a losing fork was applied before its winner was
   * seen, so only the flag carries it across a restart.
   */
  const persistStrand = async (): Promise<void> => {
    if (mls == null || params.appOutbox == null) return
    const epoch = await mls.readEpoch()
    if (durableCursor?.stranded === true && durableCursor.epoch === epoch) return
    const cursor: CommitCursor = {
      position: durableCursor?.epoch === epoch ? durableCursor.position : null,
      epoch,
      stranded: true,
    }
    await params.appOutbox.putCommitCursor(cursor)
    durableCursor = cursor
  }
  const saveCommitCursor = async (position: LogPosition): Promise<void> => {
    if (mls == null) return
    if (stranded) await persistStrand()
    else if (params.appOutbox != null) {
      const cursor: CommitCursor = { position, epoch: await mls.readEpoch() }
      await params.appOutbox.putCommitCursor(cursor)
      durableCursor = cursor
    }
    reconciledHead = position
  }

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
   * The commit this peer ENACTED at each epoch it passed — applied from the log, or committed
   * and adopted — by digest, with the sequenceID the log carried it at. The whole of the fork
   * check: a second, DIFFERENT commit at an epoch this peer holds a record for is two commits at
   * one epoch, which the hub can only produce by showing different logs to different members. The
   * same commit re-served at a new position is not, however the log came to carry it twice.
   *
   * An epoch with NO record is history, not a fork — a late joiner, rejoiner or re-seeded peer all
   * walk commits from epochs they never held. In memory, deliberately: a restart drops the record,
   * so a peer with no record reads history as history — it can MISS a fork, never invent one.
   */
  const appliedByEpoch = new Map<number, AppliedCommit>()

  /**
   * The heal trigger, RECORDED and never awaited where found: `recover()` takes the commit mutex,
   * so a pull that awaited it would wait on a tail including the pull. The trigger only writes
   * this flag; the pull unwinds, releases the lane, and the heal runs afterward as its own
   * operation. An active recovery absorbs concurrent requests.
   */
  let healRequested = false
  let activeRecovery: Promise<{ advanced: boolean }> | null = null
  let refusalHeld = false
  let pendingRecovery: { position: string; commitDigest: string; pending: PendingRecovery } | null =
    null
  let retryRecoveryAdoption: (() => Promise<void>) | null = null
  let recoveryRetryTimer: ReturnType<typeof setTimeout> | undefined
  let recoveryBackoff = 1000
  const clearRecoveryRetry = (): void => {
    if (recoveryRetryTimer != null) clearTimeout(recoveryRetryTimer)
    recoveryRetryTimer = undefined
  }
  const retryRecovery = (): void => {
    if (disposed || recoveryRetryTimer != null || renewalHeld() || refusalHeld) return
    recoveryRetryTimer = setTimeout(() => {
      recoveryRetryTimer = undefined
      if (disposed || renewalHeld() || refusalHeld || activeRecovery != null) return
      healRequested = true
      void healIfRequested()
    }, recoveryBackoff)
    recoveryBackoff = Math.min(recoveryBackoff * 2, 60_000)
  }
  let recoveryGeneration = 0
  let bootstrapHealRequested = false
  let episode: { strongest: StrandConfidence } | null = null

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
  let renewalRequiredEpoch: number | null = null
  const renewalHeld = (): boolean => {
    if (renewalRequiredEpoch != null && crypto.epoch() !== renewalRequiredEpoch)
      renewalRequiredEpoch = null
    return renewalRequiredEpoch != null
  }

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
   * A lost anchor secret also defers journal bodies into this set. Other entries come from the
   * peer's ledger: entries enacted on a discarded
   * branch, or kept while the group moved on. Filtering that against the group's authenticated
   * ledger is the membership rule as a set-difference: re-enact iff the group's ledger does not
   * already contain it.
   *
   * `null` means no rejoin in progress. Survives a failed bootstrap, so a retry filters the same
   * entries rather than snapshotting an empty ledger.
   */
  let inFlightEntries: Array<string> | null = null
  let awaitingBootstrap: {
    attemptID: string
    trigger: RecoveryTrigger
    entries: Array<string>
  } | null = null
  let rejoinRuntimeNeedsBuild = false

  /**
   * Entries a heal decided must be re-enacted, waiting for a lane operation with a return value —
   * same problem as `lostCommit`. A heal triggered by a pull has nowhere to put them; the host
   * re-enacts with an ordinary `commit()`.
   */
  let pendingReenact: Array<string> = []

  let hostOutbox: Array<() => void> = []
  let recoveryNotices: Array<() => void> = []
  const emitStrand = (observation: StrandObservation): void => {
    hostOutbox.push(() => notifyHost((value) => params.onStrand?.(value), observation))
  }
  const emitRecovery = (event: RecoveryEvent): void => {
    recoveryNotices.push(() => notifyHost((value) => params.onRecovery?.(value), event))
  }
  const observeStrand = (observation: Omit<StrandObservation, 'groupID'>): void => {
    bootstrapHealRequested = false
    if (commitTopicID == null) return
    if (
      episode != null &&
      CONFIDENCE_RANK[observation.confidence] <= CONFIDENCE_RANK[episode.strongest]
    )
      return
    episode = { strongest: observation.confidence }
    emitStrand({ ...observation, groupID: commitTopicID })
  }
  const closeEpisode = (): void => {
    episode = null
  }
  const flushHostOutbox = (): void => {
    const batch = hostOutbox
    hostOutbox = []
    for (const notice of batch) notice()
    if (activeRecovery == null) {
      const recoveries = recoveryNotices
      recoveryNotices = []
      for (const notice of recoveries) notice()
    }
  }

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
    const op = commitTail.then(async () => {
      journalReplayed = false
      appNoticeInSerial = true
      try {
        if (retryRecoveryAdoption != null) await retryRecoveryAdoption()
        return await fn()
      } finally {
        appNoticeInSerial = false
      }
    })
    commitTail = op.then(
      () => {},
      () => {},
    )
    return op.then(
      (value) => {
        flushHostOutbox()
        logDelivery?.trigger()
        return value
      },
      (error: unknown) => {
        flushHostOutbox()
        logDelivery?.trigger()
        throw error
      },
    )
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
  const recoveryWaiters = new Map<string, (outcome: RendezvousOutcome) => void>()
  const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingReplies = new Map<string, ReturnType<typeof setTimeout>>()
  const inFlightBootstraps = new Set<Promise<void>>()
  const suppressedRequests = new Set<string>()
  const confirmationWaiters = new Map<
    string,
    { receive: (sealed: Uint8Array) => void; dispose: () => void }
  >()
  const commitOutcomes = createRecoveryCache<RecoveryCommitOutcome>((outcome) => {
    if (outcome.kind === 'applied') outcome.key.fill(0)
  })
  const recordCommitOutcome = (position: string, outcome: RecoveryCommitOutcome): void => {
    if (commitOutcomes.get(position) != null) {
      if (outcome.kind === 'applied') outcome.key.fill(0)
      return
    }
    commitOutcomes.set(position, outcome, Date.now() + recoveryDeadlineMs)
  }
  const verdictCache = createRecoveryCache<Promise<Uint8Array>>()
  const verdictTimers = new Set<ReturnType<typeof setTimeout>>()
  /**
   * Ledger-gather waiters, keyed by requestID. Called for EVERY reply, not just the first: a
   * responder whose ledger fails the head check withheld an entry, so the requester falls through
   * to the next reply rather than giving up.
   */
  const ledgerWaiters = new Map<string, (sealed: Uint8Array) => void>()
  const ledgerGatherFinishes = new Set<() => void>()
  const pendingLedgerReplies = new Set<ReturnType<typeof setTimeout>>()

  const handleRecoveryConfirmRequest = (
    request: ReturnType<typeof decodeRecoveryConfirmRequest>,
  ): void => {
    if (mls == null || rendezvousTopicID == null || disposed) return
    const port = mls
    const topicID = rendezvousTopicID
    void (async () => {
      const verified = await port.verifyRecoveryRequest(request.request)
      if (
        disposed ||
        verified == null ||
        verified.requestID !== request.requestID ||
        normalizeDID(verified.requesterDID) === localDID
      )
        return
      const blocked = () => pendingRecovery != null && request.position >= pendingRecovery.position
      if (blocked()) return
      let record = commitOutcomes.get(request.position)
      if (record == null) {
        await ready
        if (disposed) return
        await runSerial(async () => {
          if (disposed) return
          await replayJournal()
          await reconcileCommits()
        })
        if (disposed || blocked()) return
        record = commitOutcomes.get(request.position)
      }
      if (record == null || record.value.commitDigest !== request.commitDigest) return
      const cacheKey = JSON.stringify([
        verified.requesterDID,
        request.requestID,
        Array.from(request.request),
        request.position,
        request.commitDigest,
      ])
      const outcome = record.value
      let held = verdictCache.get(cacheKey)
      if (held == null) {
        const binding = {
          groupID: verified.groupID,
          requestID: request.requestID,
          position: request.position,
          commitDigest: request.commitDigest,
        }
        const verdict =
          outcome.kind === 'applied'
            ? {
                ...binding,
                verdict: 'confirmed' as const,
                epoch: outcome.epoch,
                tag: confirmationTag(outcome.key, request.requestID),
              }
            : outcome.kind === 'superseded'
              ? { ...binding, verdict: 'superseded' as const }
              : { ...binding, verdict: 'refused' as const, reason: outcome.reason }
        const sealed = port
          .sealRecoveryVerdict(request.request, verdict)
          .catch((error: unknown) => {
            if (verdictCache.get(cacheKey)?.value === sealed) verdictCache.delete(cacheKey)
            throw error
          })
        verdictCache.set(cacheKey, sealed, record.expiresAt)
        held = { value: sealed, expiresAt: record.expiresAt }
      }
      const sealed = await held.value
      if (disposed || blocked() || held.expiresAt <= Date.now()) return
      const expiresAt = held.expiresAt
      const timer = setTimeout(
        () => {
          verdictTimers.delete(timer)
          if (disposed || blocked() || expiresAt <= Date.now()) return
          void mux
            .publish({
              topicID,
              payload: encodeHandshakeFrame(
                HANDSHAKE_KIND.recoveryVerdict,
                encodeRecoveryVerdict(request.requestID, sealed),
              ),
            })
            .catch(() => {})
        },
        Math.max(0, Math.min(getReplyDelayMs(), recoveryTimeoutMs, expiresAt - Date.now())),
      )
      verdictTimers.add(timer)
    })().catch(() => {})
  }

  // Responder: after a jitter delay, answer a recovery request with GroupInfo sealed to the
  // ephemeral key inside the signed request — unless another responder's reply has already
  // been observed (storm-collapse), in which case the scheduled reply is cancelled.
  const handleRecoveryRequest = (request: { requestID: string; request: Uint8Array }): void => {
    const { requestID } = request
    if (mls == null || rendezvousTopicID == null || pendingRecovery != null) return
    if (suppressedRequests.has(requestID) || pendingReplies.has(requestID)) return
    const port = mls
    const topicID = rendezvousTopicID
    const timer = setTimeout(() => {
      pendingReplies.delete(requestID)
      void (async () => {
        try {
          // The port verifies the request and checks the requester's leaf against its own current
          // tree. A refused request raises, and this peer stays silent.
          if (pendingRecovery != null) return
          const groupInfo = await port.sealGroupInfo(request.request)
          // Same window as `handleLedgerRequest`'s guard: a timer that fired before dispose is
          // gone from `pendingReplies` by the time the clear sweep runs, and is then an await
          // away from here. Silent, for the same reason.
          if (disposed || pendingRecovery != null) return
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
      waiter({ kind: 'reply', sealed: reply.groupInfo })
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
          // This timer fired before dispose()'s clear sweep, so it had already deleted itself
          // from `pendingLedgerReplies` when the sweep walked it — too late by construction, not
          // by race. Silent, like `onCommitDelivery`: there is no caller to tell, and the catch
          // below would swallow a throw anyway.
          if (disposed) return
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

  /** Read the departing epoch's frames and persist its rotation record before ratcheting. */
  const advanceHandle = async <T>(
    port: GroupMLS,
    advance: () => Promise<T>,
    identity: { epochAfter: number; forced: boolean; advance: string; recovery?: boolean },
    floorPosition?: LogPosition,
  ): Promise<T> => {
    await resolveAnchorRotation(port)
    assertLive()
    const pending = anchorPending
    const retry = pending?.advance === identity.advance
    const confirmedRecovery = identity.recovery === true && anchorRecoveryPending
    if (
      (anchorRecoveryPending && !confirmedRecovery) ||
      (anchorPending != null && !retry && !confirmedRecovery)
    ) {
      throw new RecoveryRequiredError('an earlier anchor rotation is unresolved')
    }
    if (!confirmedRecovery) await appLane.deliver()
    assertLive()
    const rosterBefore =
      retry && pending != null
        ? pending.rosterBefore
        : (await port.rosterEntries()).map((entry) => normalizeDID(entry.did))
    const epochBefore = await port.readEpoch()
    assertLive()
    const record =
      retry && pending != null
        ? pending
        : {
            epochBefore,
            epochAfter: identity.epochAfter,
            rosterBefore,
            forced: identity.forced,
            advance: identity.advance,
          }
    await anchorStore?.save({ anchor, pending: record })
    assertLive()
    anchorPending = record
    if (sealBarrier == null)
      sealBarrier = new Promise<void>((resolve) => {
        releaseSealBarrier = resolve
      })
    const observe = async (): Promise<void> => {
      const epoch = await port.readEpoch()
      const roster = (await port.rosterEntries()).map((entry) => normalizeDID(entry.did))
      if (rosterBefore.includes(localDID) && !roster.includes(localDID)) {
        locallyRemoved = true
        logDelivery?.removed()
      }
      if (epoch === identity.epochAfter && epoch !== record.epochBefore && floorPosition != null)
        floor = { epoch, position: floorPosition, covered: true }
    }
    try {
      const advanced = await advance()
      if (floorPosition != null) await saveCommitCursor(floorPosition)
      await observe()
      await resolveAnchorRotation(port, true, false, true)
      if (confirmedRecovery && anchorPending == null) anchorRecoveryPending = false
      return advanced
    } catch (error) {
      try {
        await observe()
        await resolveAnchorRotation(port)
      } catch {
        // The record keeps the exact epoch available for the next repair.
      }
      if (anchorPending != null) {
        sealError = new Error('app anchor unavailable after failed epoch advance', { cause: error })
      }
      throw error
    } finally {
      if (anchorPending == null && !anchorRecoveryPending) finishSealBarrier()
    }
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
    if (anchorRecoveryPending) return false
    let advancedEpoch = false
    const started = logDelivery?.beginWalk() ?? 0
    let covered = true
    // The tip from the SAME reply whose frames were processed, so it can never run ahead of them.
    const takeHead = (head: string | null): void => {
      commitLogHead = head == null ? null : asLogPosition(head)
      if (covered && !stranded && floor.covered) {
        if (!advancedEpoch) floor = { ...floor, position: reconciledHead }
        logDelivery?.certify(floor.epoch, started)
      }
    }
    while (true) {
      if (disposed) return false
      const pageAfter = reconciledHead
      const result = checkedFetchResult(
        await mux.fetchTopic({
          topicID,
          // From the cursor. With no cursor (fresh member, trimmed backlog, just rejoined) read
          // from the OLDEST retained frame — seeding from the topic's `head` would be a guess.
          ...(reconciledHead != null ? { after: reconciledHead } : {}),
          limit: COMMIT_FETCH_LIMIT,
        }),
      )
      if (disposed) return false
      const gap =
        result.gap ||
        (result.messages.length === 0 &&
          result.head != null &&
          pageAfter != null &&
          result.head > pageAfter)
      if (pageAfter == null) {
        covered = false
        floor = { ...floor, covered: false }
      } else if (gap) {
        floor = { ...floor, covered: false }
        stranded = true
        healRequested = true
        await persistStrand()
        observeStrand({
          position: pageAfter,
          commitDigest: null,
          localEpoch: await port.readEpoch(),
          claimedEpoch: null,
          kind: 'retention-gap',
          confidence: 'claimed',
        })
        return advancedEpoch
      }
      // A short page may carry a one-shot fork reveal below the cursor. Only a full page loops.
      if (result.messages.length === COMMIT_FETCH_LIMIT) {
        assertForwardPage(pageAfter, result.messages)
      }
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
          await saveCommitCursor(position) // malformed: dropped, and the cursor still steps over it
          continue
        }
        // A wire version this build does not know, settled BEFORE the kind byte: nothing behind
        // the magic means what this build thinks under an unknown version. On the commit topic —
        // and only here — that is evidence in itself, so it goes to the classifier, not dropped.
        if (frame.version !== HANDSHAKE_VERSION) {
          // No digest: the frame's version put its commit bytes out of reach entirely. Settled at
          // `ahead` before the digest is read.
          const localEpoch = await port.readEpoch()
          if (disposed) return false
          const unreadable = classifyCommit({
            header: UNKNOWN_FRAME_VERSION,
            sequenceID: position,
            commitDigest: null,
            state: { localDID, epoch: localEpoch, appliedByEpoch },
          })
          if (unreadable.row === 'ahead') stranded = true
          await saveCommitCursor(position)
          // Do what the classifier said, not what this branch assumes: it answers `ahead` today,
          // and any other answer just steps over the frame, matching the bare advance above.
          if (unreadable.row === 'ahead') {
            healRequested = true
            observeStrand({
              position,
              commitDigest: null,
              localEpoch,
              claimedEpoch: null,
              kind: 'unknown-version',
              confidence: 'claimed',
            })
          }
          continue
        }
        if (frame.kind !== HANDSHAKE_KIND.commit) {
          await saveCommitCursor(position) // the commit lane carries commits, and nothing else
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
            const localEpoch = await port.readEpoch()
            if (disposed) return false
            const unreadable = classifyCommit({
              header: UNKNOWN_FRAME_VERSION,
              sequenceID: position,
              commitDigest: null,
              state: { localDID, epoch: localEpoch, appliedByEpoch },
            })
            if (unreadable.row === 'ahead') stranded = true
            await saveCommitCursor(position)
            // The classifier's answer, not this branch's assumption — as above.
            if (unreadable.row === 'ahead') {
              healRequested = true
              observeStrand({
                position,
                commitDigest: null,
                localEpoch,
                claimedEpoch: null,
                kind: 'unknown-version',
                confidence: 'claimed',
              })
            }
            continue
          }
          // Too short, or a commit length running past the end: genuinely not a frame, and
          // nothing a future build would have written. Dropped, and the cursor steps over it.
          await saveCommitCursor(position)
          continue
        }

        // Identify the commit by its own bytes, for the fork check — the COMMIT, not the frame:
        // the sealed blob is derived and re-sealing is legal, so a frame-wide digest would fork
        // the group on a legitimate re-seal.
        const commitDigest = digestAppliedCommit(commitFrame.commit)
        if (pendingRecovery?.position === position && pendingRecovery.commitDigest === commitDigest)
          return advancedEpoch
        // The commit's OWN epoch and committer, from the commit's own bytes. Never
        // `message.senderDID` — the hub's word about who handed it over, and the hub is not
        // trusted: it could stamp every recipient's own DID onto one poison frame and make the
        // whole group heal at once.
        let localEpoch = await port.readEpoch()
        if (disposed) return false
        while (true) {
          const readHeader = await port.readCommitHeader(commitFrame.commit)
          if (disposed) return false
          // Normalized before `classifyCommit` compares it against `state.localDID` (also
          // normalized, at construction) — an own-unmerged commit authenticated under a different
          // form of this member's own DID must still be recognized as its own.
          const header =
            readHeader?.committerDID != null
              ? { ...readHeader, committerDID: normalizeDID(readHeader.committerDID) }
              : readHeader
          const disposition = classifyCommit({
            header,
            sequenceID: position,
            commitDigest,
            state: { localDID, epoch: localEpoch, appliedByEpoch },
          })

          if (disposition.row === 'own-unmerged') {
            // Sender data names this peer at its current epoch, but neither commit content nor hub
            // acceptance is verified. The peer cannot process its own commit without pending state,
            // so the drain stops here and it heals.
            healRequested = true
            stranded = true
            await persistStrand()
            observeStrand({
              position,
              commitDigest,
              localEpoch,
              claimedEpoch: header?.epoch ?? null,
              kind: 'own-unmerged',
              confidence: 'authenticated',
            })
            return advancedEpoch
          }
          if (disposition.row === 'ahead') {
            // The group advanced at an epoch this peer did not. Step over the frame — the heal
            // repairs this, not a re-read — and ask for one.
            stranded = true
            await saveCommitCursor(position)
            healRequested = true
            observeStrand({
              position,
              commitDigest,
              localEpoch,
              claimedEpoch: header?.epoch ?? null,
              kind: 'ahead',
              confidence: 'claimed',
            })
            break
          }
          if (disposition.row === 'history') {
            // A frame from an epoch below this peer's, with no record for it or a record naming
            // this same commit. Not a fork, not poison, not the port's business — its blob is never
            // touched.
            await saveCommitCursor(position)
            break
          }
          if (disposition.row === 'fork') {
            if (header?.external && disposition.branch !== 'losing' && !stranded)
              recordCommitOutcome(position, { commitDigest, kind: 'superseded' })
            // Two commits at one epoch. The lower-sequenceID branch wins; the loser rejoins onto it
            // (a heal). The winner just steps over the frame.
            if (disposition.branch === 'losing') stranded = true
            await saveCommitCursor(position)
            if (disposition.branch === 'losing') {
              healRequested = true
              observeStrand({
                position,
                commitDigest,
                localEpoch,
                claimedEpoch: header?.epoch ?? null,
                kind: 'fork-losing',
                confidence: 'observed',
              })
            }
            break
          }
          if (disposition.row === 'poison') {
            await saveCommitCursor(position) // not a commit at all: stepped over, and never retried
            break
          }

          // Framed at this peer's epoch, by somebody else: a frame it can apply. Everything below is
          // the port's answer to it.
          if (disposed) return false
          const framedEpoch = localEpoch
          let applied: ProcessCommitResult
          try {
            // Through the seam, like every other site that ratchets the handle: it reads this
            // epoch's app frames ahead of the apply and takes the anchor if the roster moved.
            applied = await advanceHandle(
              port,
              async () => {
                if (disposed) {
                  return { advanced: false, epochBefore: framedEpoch, epochAfter: framedEpoch }
                }
                const result = await port.processCommit(commitFrame.commit, {
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
                if (header?.external && result.advanced && !stranded) {
                  const derived = await port.confirmationKey(position, commitDigest)
                  recordCommitOutcome(position, { kind: 'applied', commitDigest, ...derived })
                }
                return result
              },
              // A REJOIN rotates the anchor too, from a member the roster diff cannot see: an
              // external commit by a member the roster still holds leaves every DID where it was.
              // Only an APPLIED commit says anything about the group.
              {
                epochAfter: (header?.epoch ?? framedEpoch) + 1,
                forced: header?.external === true,
                advance: commitDigest,
              },
              position,
            )
          } catch (error) {
            if (disposed) return false
            if (!isMissingLedgerEntries(error)) {
              // The port broke its contract. The cursor stays and the frame is re-read — the pull is
              // a retry, and this is not an outcome it can name.
              throw error
            }
            if ((await port.readEpoch()) !== framedEpoch) {
              await resolveAnchorRotation(port)
              throw error
            }
            await resolveAnchorRotation(port, true)
            // The commit names ledger entries whose bodies will not resolve. POISON: drop, advance,
            // do NOT heal. The bodies ride the commit sealed under its framed epoch, so a blob this
            // peer cannot open is one no member at this epoch can — nobody applies it, and the next
            // honest commit is framed at the same epoch and compare-and-sets behind it.
            //
            // Healing here would hand any member a group-wide recovery storm for one publish.
            // Retrying only delays that. The one case where this peer really is the broken one
            // announces itself later: the next commit is then framed AHEAD of this peer's, which
            // heals it.
            await saveCommitCursor(position)
            break
          }
          if (disposed) return false
          if (!applied.advanced && applied.epochBefore !== framedEpoch) {
            advancedEpoch = true
            localEpoch = applied.epochBefore
            continue
          }
          if (applied.advanced) {
            advancedEpoch = true
            // The fork check's record; the only place it is written from the log.
            appliedByEpoch.set(framedEpoch, { sequenceID: position, digest: commitDigest })
          }
          if (header?.external && !applied.advanced && !stranded)
            recordCommitOutcome(position, {
              kind: 'refused',
              commitDigest,
              reason: applied.refusal ?? 'invalid',
            })
          // `{ advanced: false }` here is the port REFUSING a well-formed commit at this peer's own
          // epoch from another member: poison on the same terms as an unresolvable one.
          await saveCommitCursor(position)
          break
        }
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
    if (disposed) return false
    if (!journalReplayed) {
      throw new Error(
        'pullCommits: the journal must be replayed first in every lane operation, or a peer that crashed on its own commit heals from it instead of adopting it',
      )
    }
    if (mls == null || commitTopicID == null) return false
    if (!(await mls.isLedgerComplete())) return false
    const epochBefore = await mls.readEpoch()
    if (disposed) return false
    const anchorBefore = anchor
    try {
      const advanced = await walkCommits(mls, commitTopicID)
      if (disposed) return false
      await appLane.deliver()
      if (disposed) return false
      return advanced
    } catch (error) {
      if (disposed) return false
      // A failed final drain can follow applied commits. Refresh the runtime before a retry.
      if (inboxLane != null) {
        const epochAfter = await mls.readEpoch()
        if (disposed) return false
        if (epochAfter !== epochBefore || anchor !== anchorBefore) {
          try {
            await rebuildEpoch()
          } catch {
            // The walk's original failure remains the retryable cause.
          }
        }
      }
      if (disposed) return false
      if (crypto.pending != null && !appPullActive) {
        appPullNeeded = true
        armAppPull(appPullBackoff)
        appPullBackoff = Math.min(appPullBackoff * 2, 60_000)
      }
      throw error
    }
  }

  /** Pull the commit log, and rebuild the app lane if the pull moved the epoch. */
  const reconcileCommits = async (): Promise<void> => {
    const advanced = await pullCommits()
    if (!disposed && advanced) await rebuildEpoch()
  }

  /**
   * A commit-topic delivery is a WAKEUP, nothing more. Frames come from the pull, never the push:
   * an accepted log publish is pushed AND retained, so processing the pushed copy too would apply
   * every commit twice. The payload is not read; its sequenceID is a delivery position and can
   * never become the cursor.
   */
  const onCommitDelivery = (_message: StoredMessage, ack: () => void): void => {
    ack()
    void ready
      .then(() => {
        // `ready` uses this mutex for its seed and pending pull. Never hold it while waiting for
        // initialization, and refuse a delivery that resumed after disposal.
        if (disposed) return
        return runSerial(async () => {
          // A delivery queued before disposal is refused silently; it has no caller to notify.
          if (disposed) return
          // A wakeup is a lane operation: step 0, the ledger invariant, then the pull. No return
          // value, so anything found is stashed for the next call that has one.
          const replayed = await replayJournal()
          if (mls != null && (await ensureLedger(Date.now() + recoveryTimeoutMs))) {
            await finalizeBootstrap(mls)
          }
          if (disposed) return
          const pulled = await pullCommits()
          if (!disposed && (replayed || pulled)) await rebuildEpoch()
        })
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
    // Acked immediately, unlike the commit lane: rendezvous is retried request/reply (see the
    // "a refused or failed reply" note in `handleRecoveryRequest` above), so losing this specific
    // delivery just means the requester's retry or another responder covers it.
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
      } else if (frame.kind === HANDSHAKE_KIND.recoveryConfirmRequest) {
        handleRecoveryConfirmRequest(decodeRecoveryConfirmRequest(frame.payload))
      } else if (frame.kind === HANDSHAKE_KIND.recoveryVerdict) {
        const verdict = decodeRecoveryVerdict(frame.payload)
        confirmationWaiters.get(verdict.requestID)?.receive(verdict.sealed)
      }
    } catch {
      // malformed payloads are dropped
    }
  }

  const initControlLanes = async (): Promise<void> => {
    if (mls == null) return
    const recoverySecret = await mls.exportRecoverySecret()
    if (disposed) return
    commitTopicID = commitTopic(recoverySecret)
    rendezvousTopicID = rendezvousTopic(recoverySecret)
    // Both topics subscribed once for the peer's whole life — NOT rebuilt on resync, so a
    // stranded peer still shares both rendezvous with the live group. Subscribe BEFORE the first
    // pull: the hub gates a topic fetch on the caller's own subscription.
    commitUnsubscribe = mux.onInbound(commitTopicID, onCommitDelivery, {
      retention: commitLogRetentionSeconds,
    })
    rendezvousUnsubscribe = mux.onInbound(rendezvousTopicID, onRendezvousMessage)
    if (anchorRecoveryPending) return
    // Then seed the cursor by READING the log — commits published before this peer subscribed are
    // exactly the ones no push will bring it. A lane operation, so the journal replays AHEAD of
    // it. Neither step rebuilds the epoch — buildEpoch runs next.
    await runSerial(async () => {
      if (disposed) return
      if (params.appOutbox != null) {
        const cursor = await params.appOutbox.getCommitCursor()
        if (cursor != null && cursor.epoch === (await mls.readEpoch())) {
          durableCursor = cursor
          if (cursor.position != null) {
            reconciledHead = asLogPosition(cursor.position)
            floor = { epoch: cursor.epoch, position: reconciledHead, covered: true }
          }
          if (cursor.stranded === true) {
            stranded = true
            healRequested = true
          }
        } else if (cursor != null) {
          await params.appOutbox.putCommitCursor(null)
        }
      }
      await replayJournal()
      if (disposed) return
      // A peer restored with an incomplete ledger was killed between rejoining and bootstrapping.
      // The invariant finds it here and at every later lane operation, with no memory of how it
      // got there.
      const ledgerReady = await ensureLedger(Date.now() + recoveryTimeoutMs)
      if (disposed) return
      if (ledgerReady) {
        await finalizeBootstrap(mls)
        if (disposed) return
      }
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
   * open. `framedAt` is null for an external commit, framed at the group's epoch, not this handle's.
   */
  const frameCommit = async (
    commit: Uint8Array,
    bodies: Array<string>,
    framedAt: number | null,
  ): Promise<{ payload: Uint8Array; epoch: number }> => {
    const { sealed: sealedEntries, epoch } = await crypto.sealEntries(encodeLedgerEntries(bodies))
    if (framedAt != null && epoch !== framedAt) {
      throw new Error(
        'commit: the local group has already advanced past the epoch this commit was framed at. A commit is adopted in onAccepted, never before.',
      )
    }
    const payload = encodeHandshakeFrame(
      HANDSHAKE_KIND.commit,
      encodeCommitFrame(commit, sealedEntries),
    )
    assertFrameFits(payload)
    return { payload, epoch }
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
    if (anchorRecoveryPending) return false
    if (mls == null || journal == null || commitTopicID == null) return false
    const entry = await journal.get()
    if (disposed || entry == null) return false
    if (entry.holdsLogSends === true) await settleLogSubmissions()
    if (disposed) return false
    const adoptIfLive = async (): Promise<void> => {
      if (disposed) return
      await adoptJournalled(entry.journal)
    }

    if (entry.acceptedAs != null) {
      // It landed and this peer recorded that before adopting. Nothing to ask: no republish, no
      // re-seal, no network. The recorded sequenceID is both the last position processed and the
      // log's tip as of that frame — a stale tip is safe (loses a race and rebases), a WRONG one
      // would win a race it had no right to.
      const accepted = asLogPosition(entry.acceptedAs)
      reconciledHead = accepted
      commitLogHead = accepted
      appliedByEpoch.set(entry.epoch, {
        sequenceID: accepted,
        digest: digestAppliedCommit(entry.commit),
      })
      // Through the seam: the adopt ratchets the handle, so this epoch's app frames are read
      // first and the anchor is taken if the journalled commit moved the roster.
      await advanceHandle(
        mls,
        adoptIfLive,
        { epochAfter: entry.epoch + 1, forced: false, advance: digestAppliedCommit(entry.commit) },
        accepted,
      )
      if (disposed) return false
      await journal.clear(entry.publishID)
      return true
    }

    // Republishing means RE-SEALING the bodies, sealable only under the host's current epoch —
    // which equals the framed epoch only while `onAccepted` is the sole place the host adopts.
    // Sealing anyway publishes a blob no member can open and wedges the lane for the whole group.
    const handleEpoch = await mls.readEpoch()
    if (disposed) return false
    if (handleEpoch !== entry.epoch) {
      throw new JournalEpochError(
        `commit replay: the journalled commit was framed at epoch ${entry.epoch}, and this group is now at ${handleEpoch}. A commit is adopted in onAccepted, and nowhere else.`,
      )
    }

    const { payload } = await frameCommit(entry.commit, entry.bodies, entry.epoch)
    if (disposed) return false
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
      if (disposed) return false
    } catch (error) {
      if (disposed) return false
      if (!isHeadMismatch(error)) {
        // Outcome UNKNOWN — the hub may have accepted and failed to say so. Leave the slot
        // exactly as it is: the next lane operation asks again.
        throw error
      }
      // It never landed and someone else's commit is at the head. There is no `build()` to call
      // again — the process that held it is gone — so hand back what survived and clear the slot:
      // the notice must not be lost, never the slot.
      await journal.clear(entry.publishID)
      if (disposed) return false
      lostCommit =
        entry.kind === 'ledger'
          ? { kind: 'ledger', tokens: entry.bodies, journal: entry.journal }
          : { kind: entry.kind, journal: entry.journal }
      return false
    }
    // Accepted — just now, or by the process that published it and died; the store's dedup makes
    // those indistinguishable, which is the point.
    //
    // Record acceptance BEFORE adopting, as `commit()` does: adopting moves the handle past the
    // framed epoch, and a crash between the two would leave a journalled commit indistinguishable
    // from a host that adopted out of band. Written first, replay is idempotent.
    await journal.markAccepted(entry.publishID, sequenceID)
    if (disposed) return false
    // This peer's own accepted frame is BOTH the last thing it processed and the log's tip —
    // otherwise a `commit()` right after a `replay()` would anchor on a stale tip.
    const accepted = asLogPosition(sequenceID)
    reconciledHead = accepted
    commitLogHead = accepted
    appliedByEpoch.set(entry.epoch, {
      sequenceID: accepted,
      digest: digestAppliedCommit(entry.commit),
    })
    await advanceHandle(
      mls,
      adoptIfLive,
      { epochAfter: entry.epoch + 1, forced: false, advance: digestAppliedCommit(entry.commit) },
      accepted,
    )
    if (disposed) return false
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

  const repairRejoin = async (): Promise<void> => {
    if (disposed || awaitingBootstrap == null) return
    // Restore the subscription before gathering the ledger: responders may already have
    // rotated to the new app anchor. A failed repair remains pending for the next lane call.
    if (mls != null) await resolveAnchorRotation(mls)
    if (disposed) return
    if (rejoinRuntimeNeedsBuild) {
      await rebuildEpoch()
      if (disposed) return
      rejoinRuntimeNeedsBuild = false
    }
  }

  const finalizeBootstrap = async (port: GroupMLS): Promise<void> => {
    assertLive()
    if (awaitingBootstrap == null) return
    const { attemptID, trigger, entries } = awaitingBootstrap
    await repairRejoin()
    assertLive()
    const held = new Set(await port.getLedger())
    assertLive()
    const owed = entries.filter((token) => !held.has(token))
    if (owed.length > 0) pendingReenact = [...pendingReenact, ...owed]
    awaitingBootstrap = null
    inFlightEntries = null
    if (bootstrapHealRequested) {
      healRequested = false
      bootstrapHealRequested = false
    }
    recoveryGeneration += 1
    closeEpisode()
    if (commitTopicID != null) {
      emitRecovery({ phase: 'bootstrapped', groupID: commitTopicID, attemptID, trigger })
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
    await repairRejoin()
    if (disposed) return false
    const port = mls
    const topicID = rendezvousTopicID
    const complete = await port.isLedgerComplete()
    if (disposed) return false
    if (complete) return true

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
    const request = await port.createRecoveryRequest(
      requestID,
      Math.max(recoveryTimeoutMs, recoveryDeadlineMs),
    )
    if (disposed) return false
    return await new Promise<boolean>((resolve) => {
      let settled = false
      const bootstraps = new Set<Promise<void>>()
      const finish = (complete: boolean): void => {
        if (settled) return
        settled = true
        ledgerWaiters.delete(requestID)
        ledgerGatherFinishes.delete(finishOnDispose)
        clearTimeout(timer)
        // Keep the lane until every bootstrap already touching this handle has finished.
        if (bootstraps.size === 0) resolve(complete && !disposed)
        else
          void Promise.allSettled([...bootstraps]).then((results) => {
            resolve(
              !disposed && (complete || results.some((result) => result.status === 'fulfilled')),
            )
          })
      }
      const finishOnDispose = () => finish(false)
      const timer = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()))
      ledgerGatherFinishes.add(finishOnDispose)
      ledgerWaiters.set(requestID, (sealed) => {
        void (async () => {
          if (settled || disposed) return
          try {
            // Bytes this peer cannot open: another member's reply to another request, or a
            // hub-injected forgery. Dropped, gather waits — the per-request key is NOT consumed
            // here, since the next responder's reply is sealed to the same key.
            const tokens = await port.openSealedLedger(sealed, requestID)
            if (tokens == null) return
            // Timeout or disposal can settle the gather while opening the reply.
            if (settled || disposed) return
            const bootstrap = port.bootstrapLedger(tokens)
            bootstraps.add(bootstrap)
            inFlightBootstraps.add(bootstrap)
            try {
              await bootstrap
            } finally {
              bootstraps.delete(bootstrap)
              inFlightBootstraps.delete(bootstrap)
            }
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
  const commit = async (
    buildInput: () => Promise<PendingCommit>,
    options?: { holdLogSends?: true },
  ): Promise<LaneResult> => {
    if (options?.holdLogSends === true) revokeHolds++
    try {
      return await commitHeld(buildInput, options)
    } finally {
      if (options?.holdLogSends === true) revokeHolds--
      logDelivery?.trigger()
    }
  }

  const commitHeld = async (
    buildInput: () => Promise<PendingCommit>,
    options?: { holdLogSends?: true },
  ): Promise<LaneResult> => {
    const build = wrapCommitBuild(boundary, buildInput)
    await ready
    assertLive()
    if (anchorRecoveryPending)
      throw new RecoveryRequiredError('commit: app anchor requires confirmed recovery')
    if (activeRecovery != null) await activeRecovery
    if (mls == null || journal == null || commitTopicID == null) {
      throw new Error('commit: this peer has no MLS port, so it has no group to commit to')
    }
    const slot = journal
    const topicID = commitTopicID
    const op = runSerial(async () => {
      assertLive()
      // 0. Replay the journal, ahead of the pull.
      if (await replayJournal()) await rebuildEpoch()
      assertLive()
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
        assertLive()
        throw new RecoveryRequiredError(
          'commit: the ledger is incomplete, so this handle rejoined the group and its bootstrap has not completed — its roster has reset, and a commit built now would be judged against a group whose admins it cannot see. It must finish bootstrapping its ledger before it can commit again.',
        )
      }
      await finalizeBootstrap(mls)
      assertLive()

      const deadline = Date.now() + commitDeadlineMs
      for (let attempt = 0; attempt < COMMIT_ATTEMPT_CEILING; attempt++) {
        // 1. Pull the log to the end: every frame processed, and the tip to race at learned from
        //    the store's own reply.
        await reconcileCommits()
        assertLive()

        // The pull found positive evidence this peer is off the group's line, which stands
        // whether or not a following heal lands. Unwind rather than race: on the `ahead` path the
        // pull already took the live tip, so a commit here would win at an epoch it never caught
        // up to. Gating on `stranded`, not `healRequested`, is what survives a heal that found no
        // responder.
        if (stranded || anchorRecoveryPending) {
          throw new RecoveryRequiredError(
            'commit: the log holds a frame this peer cannot reconcile with — its own un-merged commit, or a commit from an epoch ahead of it. It must recover before it can commit again.',
          )
        }

        // 2. Build against the host's CURRENT handle, adopting nothing. `build` closes over that
        //    handle, so a rebased retry frames at the rebased epoch.
        const pending = wrapPendingCommit(boundary, await build())
        assertLive()

        // 3. Journal BEFORE publishing, durably: from here to the hub's answer is the crash
        //    window, and the slot is the only thing that survives it.
        //
        //    Anchor on the log's TIP, not the cursor: the cursor names the last frame PROCESSED,
        //    which need not be one the head can ever name.
        const publishID = newPublishID()
        const expectedHead = commitLogHead
        const { payload, epoch: framedEpoch } = await frameCommit(
          pending.commit,
          pending.bodies,
          crypto.frameEpoch(pending.commit),
        )
        assertLive()
        if (options?.holdLogSends === true) await settleLogSubmissions()
        assertLive()
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
          ...(options?.holdLogSends === true ? { holdsLogSends: true } : {}),
        })
        assertLive()

        // 4. Publish, conditional on the head the pull reached.
        let sequenceID: string
        try {
          sequenceID = (
            await mux.publish({ topicID, payload, retain: 'log', expectedHead, publishID })
          ).sequenceID
          assertLive()
        } catch (error) {
          if (disposed) throw new PeerDisposedError('Peer is disposed', { cause: error })
          if (!isHeadMismatch(error)) {
            // Unknown outcome: the frame may be in the log. The slot STAYS — the next lane
            // operation replays it and asks the store which it was.
            throw error
          }
          // 6. Lost the compare-and-set: someone committed first — expected, not an error. Drop
          //    the pending commit untouched, clear the slot, and go back to step 1.
          await slot.clear(publishID)
          assertLive()
          if (Date.now() >= deadline) {
            // The last lost compare-and-set, carried: it is the proximate reason this attempt
            // restarted, and the deadline only names how many such losses ran out the clock.
            throw new CommitDeadlineError(
              `commit: still rebasing after ${commitDeadlineMs}ms and ${attempt + 1} attempts`,
              { cause: error },
            )
          }
          continue
        }

        // 5. Accepted. Record it in the slot BEFORE the host adopts, while the group is still at
        //    the framed epoch — an entry carrying its acceptance can be adopted on restart; one
        //    carrying none at a later epoch is a host that adopted outside `onAccepted`. Recorded
        //    after the adopt, the two would be indistinguishable.
        await slot.markAccepted(publishID, sequenceID)
        assertLive()

        // The commit is the group's now — this frame is both the last position processed and the
        // log's new tip.
        const accepted = asLogPosition(sequenceID)
        reconciledHead = accepted
        commitLogHead = accepted
        // A commit this peer made and adopted was enacted at that epoch, like an applied one —
        // without it a second commit at an epoch this peer OWNS would read as history.
        appliedByEpoch.set(framedEpoch, {
          sequenceID: accepted,
          digest: digestAppliedCommit(pending.commit),
        })
        // The host adopts here, and adopting ratchets the handle — through the seam, exactly as
        // an applied commit does. A member never processes its own commit, so the apply site
        // never runs for the roster change this peer just made: without this, the author of a
        // Remove keeps publishing to a topic the removed member still holds, and the author of an
        // Add sits on a topic the new member's handle cannot derive — silently, and no restart
        // heals it.
        await advanceHandle(
          mls,
          () => pending.onAccepted(),
          {
            epochAfter: framedEpoch + 1,
            forced: false,
            advance: digestAppliedCommit(pending.commit),
          },
          accepted,
        )
        assertLive()
        await slot.clear(publishID)
        assertLive()
        await rebuildEpoch()
        assertLive()
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
    assertLive()
    return runSerial(async () => {
      if (await replayJournal()) await rebuildEpoch()
      if (mls != null && (await ensureLedger(Date.now() + recoveryTimeoutMs))) {
        await finalizeBootstrap(mls)
      }
      assertLive()
      return takeLost()
    })
  }

  /**
   * Ask the group for its state and wait for one member to answer, bounded by the deadline.
   * The outcome distinguishes a silent responder, disposal and a failed request publish.
   */
  const requestGroupInfo = async (
    request: Uint8Array,
    requestID: string,
    topicID: string,
    deadline: number,
  ): Promise<RendezvousOutcome> => {
    const remaining = deadline - Date.now()
    const wait = Math.max(0, Math.min(recoveryTimeoutMs, remaining))
    const atDeadline = remaining <= recoveryTimeoutMs
    return await new Promise<RendezvousOutcome>((resolve) => {
      recoveryWaiters.set(requestID, resolve)
      recoveryTimers.set(
        requestID,
        setTimeout(() => {
          recoveryTimers.delete(requestID)
          if (recoveryWaiters.delete(requestID)) resolve({ kind: 'timeout', atDeadline })
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
      ).catch((error: unknown) => {
        if (!recoveryWaiters.delete(requestID)) return
        const timer = recoveryTimers.get(requestID)
        if (timer != null) clearTimeout(timer)
        recoveryTimers.delete(requestID)
        resolve({ kind: 'publish-failed', error })
      })
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
    const result = checkedFetchResult(
      await mux.fetchTopic({
        topicID,
        ...(reconciledHead != null ? { after: reconciledHead } : {}),
        limit: 1,
      }),
    )
    return result.head == null ? null : asLogPosition(result.head)
  }

  /**
   * Heal by external-commit rejoin: a top-level lane operation with a compare-and-set loop of its
   * own. NEVER calls `commit()` and `commit()` never calls it — both take the same non-reentrant
   * mutex, so either nesting deadlocks. The re-enactment a heal owes is a SUBSEQUENT `commit()` the
   * host makes once this releases the lane.
   */
  const attemptBody = async (
    trigger: RecoveryTrigger,
    generation: number,
    port: GroupMLS,
    commits: string,
    rendezvous: string,
  ): Promise<{ advanced: boolean }> => {
    assertLive()
    const attemptID = newPublishID()
    const base = { groupID: commits, attemptID, trigger }
    const failed = (
      reason: RecoveryFailureReason,
      details: {
        refusal?: RecoveryRefusalReason
        responder?: string
        advisory?: Array<OpenedRecoveryVerdict>
      } = {},
    ): { advanced: false } => {
      if (reason === 'renewal-required') renewalRequiredEpoch = crypto.epoch()
      if (reason === 'refused') refusalHeld = true
      if (reason === 'renewal-required' || reason === 'refused') clearRecoveryRetry()
      if (reason === 'unconfirmed' || reason === 'no-responder' || reason === 'deadline')
        retryRecovery()
      emitRecovery({ ...base, phase: 'failed', reason, ...details })
      return { advanced: false }
    }
    try {
      // 0. Replay the journal ahead of everything, as every lane operation does: a peer holding a
      //    commit whose fate it never learned settles that first, and may find nothing left to heal.
      const started = await runSerial(async () => {
        if (recoveryGeneration !== generation && !stranded && !healRequested) return false
        queueMicrotask(() =>
          notifyHost<RecoveryEvent>((value) => params.onRecovery?.(value), {
            ...base,
            phase: 'started',
          }),
        )
        if (await replayJournal()) await rebuildEpoch()
        assertLive()
        if (await ensureLedger(Date.now() + recoveryTimeoutMs)) await finalizeBootstrap(port)
        assertLive()
        return true
      })
      if (!started) return { advanced: true }

      const deadline = Date.now() + recoveryDeadlineMs
      let prepared = false
      while (Date.now() < deadline) {
        const publication = await runSerial(async () => {
          if (await replayJournal()) await rebuildEpoch()
          // 1. Pull to the end. It may resolve the strand outright, and a heal it no longer needs
          //    must NOT run: the external commit would rotate the tree for the whole group. Rebuild
          //    if it moved the epoch, before anything is framed: the peer that lost a heal race
          //    applies the winner's commit HERE.
          if (!anchorRecoveryPending) {
            healRequested = false
            await reconcileCommits()
          }
          assertLive()

          // 2. The head to race at, from the store's own reply.
          const expectedHead = await readCommitHead(commits)
          assertLive()

          // 3. Mint a request and rendezvous for a sealed GroupInfo. Fresh request per attempt: the
          //    ephemeral key is minted with it, and a reply to an already-used request is unopenable.
          if (!prepared) {
            prepared = true
            if ((await port.prepareRecovery()) === 'renewal-required')
              return failed('renewal-required')
            assertLive()
          }
          const requestID = newPublishID()
          const request = await port.createRecoveryRequest(
            requestID,
            Math.max(0, deadline - Date.now()),
          )
          assertLive()
          const outcome = await requestGroupInfo(request, requestID, rendezvous, deadline)
          if (outcome.kind === 'disposed' || disposed)
            throw new PeerDisposedError('Peer is disposed')
          if (outcome.kind === 'publish-failed') throw outcome.error
          if (outcome.kind === 'timeout') {
            // Nobody answered. Heal REQUIRES another online member that can seal a GroupInfo;
            // without one it cannot work. The peer stays degraded and asks again later.
            return failed(outcome.atDeadline ? 'deadline' : 'no-responder')
          }

          // 4. Open it and BUILD the external commit, adopting nothing. Bytes this peer cannot open
          //    are a hub-injected or misaddressed reply: ask again.
          // The reply may include an advance that landed between the pull and the head read.
          await reconcileCommits()
          assertLive()
          let pending: Awaited<ReturnType<typeof port.applyRecovery>>
          try {
            pending = await port.applyRecovery(outcome.sealed, requestID)
            if (pending != null && !('renewalRequired' in pending)) {
              pending = wrapPendingRecovery(boundary, pending)
            }
          } catch {
            pending = null
          }
          assertLive()
          if (pending == null) return null
          if ('renewalRequired' in pending) return failed('renewal-required')

          // 5. The entries this peer holds, snapshotted BEFORE the rejoined handle replaces them —
          //    the last moment they can be read. Kept across a failed attempt, so a retry filters
          //    the same entries rather than snapshotting the empty ledger a failed bootstrap left.
          inFlightEntries = [
            ...new Set([
              ...(inFlightEntries ?? awaitingBootstrap?.entries ?? []),
              ...(await port.getLedger()),
              ...(anchorRecoveryPending ? ((await journal?.get())?.bodies ?? []) : []),
            ]),
          ]
          assertLive()
          const inFlight = inFlightEntries

          // 6. Publish the external commit, compare-and-set at the head: it changes the ratchet
          //    tree, so it races like any commit.
          const publishID = newPublishID()
          const epochBeforeRejoin = await port.readEpoch()
          const headBeforeRejoin = reconciledHead
          const { payload } = await frameCommit(pending.commit, [], null)
          assertLive()
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
            if (disposed) throw new PeerDisposedError('Peer is disposed', { cause: error })
            if (!isHeadMismatch(error)) throw error
            // Lost the race — the likely outcome. DISCARD THE GROUPINFO, not merely the commit: it
            // describes a tree the winning commit already changed, so a commit rebuilt from it is
            // one no member at the new epoch can apply. Re-request and rebuild from a fresh one.
            return null
          }
          assertLive()
          const commitDigest = digestAppliedCommit(pending.commit)
          pendingRecovery = { position: sequenceID, commitDigest, pending }
          const key = await pending.confirmationKey(sequenceID, commitDigest)
          const verified = await port.verifyRecoveryRequest(request)
          if (verified == null) throw new Error('The recovery request did not verify')
          return {
            pending,
            sequenceID,
            commitDigest,
            key,
            requestID,
            request,
            groupID: verified.groupID,
            epochBeforeRejoin,
            headBeforeRejoin,
            inFlight,
          }
        })
        if (publication == null) continue
        if ('advanced' in publication) return publication
        const {
          pending,
          sequenceID,
          commitDigest,
          key,
          requestID,
          request,
          groupID,
          epochBeforeRejoin,
          headBeforeRejoin,
          inFlight,
        } = publication
        const confirmation = await waitForRecoveryConfirmation({
          port,
          pending,
          groupID,
          requestID,
          position: sequenceID,
          commitDigest,
          key,
          deadline,
          timeoutMs: recoveryTimeoutMs,
          waiters: confirmationWaiters,
          send: () =>
            mux.publish({
              topicID: rendezvous,
              payload: encodeHandshakeFrame(
                HANDSHAKE_KIND.recoveryConfirmRequest,
                encodeRecoveryConfirmRequest({
                  requestID,
                  request,
                  position: sequenceID,
                  commitDigest,
                }),
              ),
            }),
        })
        assertLive()
        if (confirmation.kind !== 'confirmed') {
          if (
            confirmation.kind === 'refused' &&
            ['binding', 'lapse', 'floor'].includes(confirmation.refusal)
          ) {
            pending.markBindingUnusable()
            pendingRecovery = null
            return failed('renewal-required')
          }
          pendingRecovery = null
          if (confirmation.kind === 'superseded') continue
          if (confirmation.kind === 'refused') {
            return failed('refused', {
              refusal: confirmation.refusal,
              responder: confirmation.responder,
            })
          }
          if (confirmation.kind === 'error') throw confirmation.error
          if (confirmation.kind === 'disposed') throw new PeerDisposedError('Peer is disposed')
          return failed('unconfirmed', { advisory: confirmation.advisory })
        }
        return await runSerial(async () => {
          if (
            (await port.readEpoch()) !== epochBeforeRejoin ||
            reconciledHead !== headBeforeRejoin ||
            (!anchorRecoveryPending && journal != null && (await journal.get()) != null) ||
            (anchorPending != null && !anchorRecoveryPending)
          ) {
            pendingRecovery = null
            return failed('unconfirmed', { advisory: [] })
          }

          // Keep the confirmed adoption across ambiguous host failures for the next lane operation.
          const rejoinedAtEpoch = (await port.readCommitHeader(pending.commit))?.epoch
          assertLive()
          retryRecoveryAdoption = async () => {
            // Through the seam, like every other site that ratchets the handle — and it rotates
            // ANYWAY: this is the rejoin, which no roster diff can see (see {@link anchor}). The
            // anchor is the POST-commit epoch: the handle advances inside the seam and only then is
            // the anchor captured, exactly where an applying member lands.
            await advanceHandle(
              port,
              async () => {
                let accepted = false
                try {
                  await pending.onAccepted()
                  accepted = true
                } finally {
                  // A callback can throw after replacing the handle. Observe the ratchet so
                  // bootstrap survives it, while a pre-adoption failure keeps the pending retry.
                  // A rejoin from a losing branch can land on its old epoch number, so a resolved
                  // adoption counts even when the number did not move.
                  if (accepted || (await port.readEpoch()) !== epochBeforeRejoin) {
                    awaitingBootstrap = { attemptID, trigger, entries: inFlight }
                    // Adoption enacted these bytes even if persistence rejected afterward.
                    if (rejoinedAtEpoch != null) {
                      appliedByEpoch.set(rejoinedAtEpoch, {
                        sequenceID,
                        digest: digestAppliedCommit(pending.commit),
                      })
                    }
                    stranded = false
                    rejoinRuntimeNeedsBuild = true
                  }
                }
              },
              {
                epochAfter: pending.epoch,
                forced: true,
                advance: digestAppliedCommit(pending.commit),
                recovery: true,
              },
              asLogPosition(sequenceID),
            )
            assertLive()
            const accepted = asLogPosition(sequenceID)
            reconciledHead = accepted
            commitLogHead = accepted
            const deferred = await journal?.get()
            if (deferred != null) await journal?.clear(deferred.publishID)
            healRequested = false
            // The one place the commit gate is released: the rejoin landed, so this peer's leaf is
            // back in the tree and the stale-epoch fork it guards is closed. A bootstrap that still
            // fails below is `commit()`'s own ledger-completeness check to handle.
            await rebuildEpoch()
            rejoinRuntimeNeedsBuild = false
            assertLive()
            pendingRecovery = null
            retryRecoveryAdoption = null
          }
          await retryRecoveryAdoption()

          // 8. Bootstrap: REQUIRED, not a formality. Until it runs, the ledger is empty against a
          //    live head — every admin promoted since genesis is invisible and the next commit is
          //    rejected. Failure here is a persistent degraded state, NOT a heal.
          if (!(await ensureLedger(deadline))) {
            assertLive()
            awaitingBootstrap = { attemptID, trigger, entries: inFlight }
            healRequested = true
            bootstrapHealRequested = true
            return failed('bootstrap-failed')
          }
          assertLive()

          // 9. Re-enact by MEMBERSHIP, never by the failure that brought this peer here: keep only
          //    entries the group's ledger does NOT hold. An entry it DOES hold was enacted for
          //    everyone, and appending it again puts it at the END of the log where the fold is
          //    last-write-wins — it would win, silently reverting whatever a later admin wrote over
          //    the same subject.
          const held = new Set(await port.getLedger())
          assertLive()
          const reenact = inFlight.filter((token) => !held.has(token))
          inFlightEntries = null
          awaitingBootstrap = null
          bootstrapHealRequested = false
          if (reenact.length > 0) pendingReenact = [...pendingReenact, ...reenact]
          recoveryGeneration += 1
          clearRecoveryRetry()
          recoveryBackoff = 1000
          closeEpisode()
          emitRecovery({ ...base, phase: 'succeeded' })
          return { advanced: true }
        })
      }
      return failed('deadline')
    } catch (error) {
      if (disposed || error instanceof PeerDisposedError) {
        emitRecovery({ ...base, phase: 'failed', reason: 'disposed' })
        throw error instanceof PeerDisposedError ? error : new PeerDisposedError('Peer is disposed')
      }
      emitRecovery({ ...base, phase: 'failed', reason: 'error', error })
      throw error
    }
  }

  const runRecovery = (trigger: RecoveryTrigger): Promise<{ advanced: boolean }> => {
    if (trigger === 'automatic' && (renewalHeld() || refusalHeld))
      return Promise.resolve({ advanced: false })
    if (activeRecovery != null) return activeRecovery
    const generation = recoveryGeneration
    let attempt: Promise<{ advanced: boolean }> | undefined
    attempt = (async (): Promise<{ advanced: boolean }> => {
      await ready
      assertLive()
      if (mls == null || commitTopicID == null || rendezvousTopicID == null) {
        return { advanced: false }
      }
      const port = mls
      const commits = commitTopicID
      const rendezvous = rendezvousTopicID
      try {
        return await attemptBody(trigger, generation, port, commits, rendezvous)
      } finally {
        if (retryRecoveryAdoption == null) pendingRecovery = null
        if (activeRecovery === attempt) activeRecovery = null
        flushHostOutbox()
      }
    })()
    activeRecovery = attempt
    void attempt.then(
      () => {
        if (activeRecovery === attempt) activeRecovery = null
      },
      () => {
        if (activeRecovery === attempt) activeRecovery = null
      },
    )
    return attempt
  }

  const recover = async (): Promise<{ advanced: boolean; reenact: Array<string> }> => {
    renewalRequiredEpoch = null
    refusalHeld = false
    clearRecoveryRetry()
    const { advanced } = await runRecovery('consumer')
    const reenact = pendingReenact
    pendingReenact = []
    return { advanced, reenact }
  }

  /**
   * Run a heal the lane asked for, never from inside the lane. `recover()` takes the commit mutex,
   * so the trigger records and the caller runs this once it releases the mutex. A heal already in
   * flight absorbs any trigger raised while it runs: the frame that raised it is still in the log,
   * and the next pull raises it again if the heal did not settle it.
   */
  const healIfRequested = async (): Promise<void> => {
    if (disposed || !healRequested || activeRecovery != null || renewalHeld() || refusalHeld) return
    healRequested = false
    try {
      await runRecovery('automatic')
    } catch {
      // No responder, or a reply that would not open. The peer stays degraded, and the frame that
      // asked for the heal is still in the log: the next pull asks again.
    }
  }

  let pendingRestoreTimer: ReturnType<typeof setTimeout> | undefined
  let abortPendingRestore: (() => void) | undefined
  const pendingRestoreAborted = new Promise<void>((resolve) => {
    abortPendingRestore = resolve
  })
  const restorePending = async (): Promise<void> => {
    if (crypto.pending == null) return
    let backoff = 1000
    while (!disposed) {
      try {
        const records = await Promise.race<Array<PendingAppFrame> | null>([
          crypto.pending.list(),
          pendingRestoreAborted.then(() => null),
        ])
        if (records == null || disposed) return
        await appLane.restore(records)
        return
      } catch {
        if (disposed) return
        await Promise.race([
          new Promise<void>((resolve) => {
            pendingRestoreTimer = setTimeout(resolve, backoff)
          }),
          pendingRestoreAborted,
        ])
        pendingRestoreTimer = undefined
        backoff = Math.min(backoff * 2, 60_000)
      }
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
    await journal?.get()
    const stored = await anchorStore?.load()
    if (disposed) return
    if (stored != null) {
      anchor = stored.anchor
      anchorPending = stored.pending
      if (mls != null) await resolveAnchorRotation(mls, false, true)
    } else {
      await captureAnchor()
    }
    if (disposed) return
    await restorePending()
    if (disposed) return
    await initControlLanes()
    if (disposed) return
    await buildEpoch()
    if (disposed) return
    if (anchorRecoveryPending) return
    // The seed pull precedes the app listeners. Read once more after registration to close
    // the publication gap; a failed read is retried on the same independent schedule.
    if (crypto.pending != null) {
      try {
        await runSerial(async () => {
          if (disposed) return
          await replayJournal()
          if (disposed) return
          await ensureLedger(Date.now() + recoveryTimeoutMs)
          if (disposed) return
          await reconcileCommits()
        })
      } catch {
        if (disposed) return
        appPullNeeded = true
        armAppPull(appPullBackoff)
      }
    }
  })()
  // A failed init rejects every public call, but must not raise an unhandled rejection before the
  // first is made.
  const settled = ready.catch(() => {})
  // The seed pull runs inside init, where the crash victim whose journal was lost meets its own
  // un-merged commit. Its heal waits for init to finish, since every lane operation (`recover()`
  // included) waits on `ready`.
  void settled.then(() => {
    logDelivery?.trigger()
    void healIfRequested()
  })
  const withReady = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    await ready
    assertLive()
    return fn()
  }
  const readyOrAbort = async (signal: AbortSignal | undefined): Promise<'ready' | 'aborted'> => {
    if (signal == null) {
      await ready
      return 'ready'
    }
    if (signal.aborted) return 'aborted'
    let onAbort: (() => void) | undefined
    const aborted = new Promise<'aborted'>((resolve) => {
      onAbort = () => resolve('aborted')
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([ready.then(() => 'ready' as const), aborted])
    } finally {
      if (onAbort != null) signal.removeEventListener('abort', onAbort)
    }
  }

  // Hoisted and explicitly typed (rather than inlined in the return object below) so the
  // checker can match its type against `GroupPeer<Protocols>['protocol']` by identity: inlined,
  // the whole return-object structural check against `GroupPeer<Protocols>` recurses through
  // `ProtocolSurface`'s definitions-map machinery for a still-abstract `Protocols` and blows
  // TypeScript's instantiation-depth limit (TS2589).
  const protocolMethod: GroupPeer<Protocols>['protocol'] = (name) => {
    const key = String(name)
    return {
      dispatch: async (prc, config) => {
        assertLive()
        const protocol = protocols[key]
        if (protocol == null) throw new Error(`Unknown protocol: ${key}`)
        if (appOutboxAcceptance != null && retentionOf(protocol, prc) === 'log') {
          await appOutboxAcceptance.accept({
            protocol: key,
            prc,
            data: encodeEventFrame(prc, config?.data ?? {}),
          })
          logDelivery?.trigger()
          return
        }
        return withReady(() => surfaceFor(key).dispatch(prc, config))
      },
      request: (prc, config) => withReady(() => surfaceFor(key).request(prc, config)),
      gather: async (prc, config) => {
        const outcome = await readyOrAbort(config?.signal)
        assertLive()
        if (outcome === 'aborted') return []
        return surfaceFor(key).gather(prc, config)
      },
      to: (memberDID) => withReady(() => surfaceFor(key).to(memberDID)),
    } as ProtocolSurface<Protocols[typeof name]>
  }

  return {
    protocol: protocolMethod,
    retryAppDelivery: async (topicID) => {
      if (disposed) return
      appLane.retryDelivery(topicID)
      retryAppPull()
    },
    dropAppFrame: async (topicID, position) => {
      await ready
      assertLive()
      await runSerial(async () => {
        assertLive()
        await appLane.dropFrame(topicID, position)
        assertLive()
        await replayJournal()
        await ensureLedger(Date.now() + recoveryTimeoutMs)
        await reconcileCommits()
      })
      await healIfRequested()
      assertLive()
    },
    commit,
    replay,
    recover,
    resync: async () => {
      await ready
      // Refuse a disposed peer BEFORE `rebuildEpoch`: its `buildEpoch` half re-registers every
      // listener and retain on a mux whose `dispose()` has already cleared `listeners` and
      // `refcount` and stopped the drain. The rebuilt epoch lands in maps nothing walks again,
      // and no second teardown reaches it. Invisible from the hub — the mux deliberately leaves
      // `subscriptions` standing, so nothing re-subscribes; the whole cost is held locally.
      assertLive()
      // Every other `rebuildEpoch` caller runs under the commit mutex. Unlocked, a host-called
      // resync interleaves with an inbound-commit rebuild and runs two teardown/build cycles over
      // one set of runtimes. Safe to wrap only because `rebuildEpoch` takes no lock itself and
      // this is a top-level entry — `runSerial` is not reentrant.
      await runSerial(() => rebuildEpoch())
      assertLive()
    },
    anchorEpoch: () => anchor.epoch,
    reauthorize: () => {
      // No `assertLive`/`ready` wait: rearming a refused subscription is a synchronous, idempotent
      // hint the mux applies against its own state, safe on a peer that is still initializing and a
      // no-op on a disposed one (the mux guards `disposed`). It touches only topics the hub already
      // refused, so it cannot subscribe anything a normal retain would not have.
      mux.rearmRefusedTopics()
    },
    drained: () => {
      if (disposePromise == null)
        return Promise.reject(new Error('Call dispose() before drained()'))
      return boundary.drained(disposePromise)
    },
    dispose: () => {
      if (disposePromise != null) return disposePromise
      disposed = true
      appOutboxAcceptance?.close()
      logDelivery?.close()
      clearRecoveryRetry()
      boundary.close()
      abortPendingRestore?.()
      if (pendingRestoreTimer != null) clearTimeout(pendingRestoreTimer)
      appLane.dispose()
      if (appPullTimer != null) clearTimeout(appPullTimer)
      appPullTimer = undefined
      // Synchronous and FIRST, before anything is awaited: a lane op that already passed its own
      // `assertLive` can be running inside `runSerial`, past the point this `dispose()` can reach
      // it — awaiting the commit mutex here is unsafe (`build()`/`onAccepted()` are host-supplied
      // and unbounded, and a host calling `dispose()` from inside one would self-deadlock). This
      // closes the mux's three routes to the wire immediately, so whatever the op does next, it
      // cannot land a write. `mux.dispose()` — the full teardown — stays LAST, unchanged.
      mux.suspendPublishing()
      // Release a lane waiting for ledger replies now; its deadline may be far away.
      for (const finish of [...ledgerGatherFinishes]) finish()
      for (const waiter of confirmationWaiters.values()) waiter.dispose()
      commitOutcomes.clear()
      verdictCache.clear()
      for (const timer of verdictTimers) clearTimeout(timer)
      verdictTimers.clear()
      disposePromise = (async () => {
        // Tear down even a peer whose init failed — it still holds a hub drain.
        // Initialization may be waiting on a host port that never answers. Disposal closes the
        // mux now; late initialization checks `disposed` before registering more listeners.
        await Promise.race([settled, pendingRestoreAborted])
        // The host owns a bootstrap already touching its handle, including one started by init.
        // Drain it without waiting for ready, which can itself depend on the seed lane.
        await Promise.allSettled([...inFlightBootstraps])
        commitUnsubscribe?.()
        rendezvousUnsubscribe?.()
        // Resolve any in-flight recovery rendezvous FIRST, before clearing its timers: a
        // `recover()` blocked in `requestGroupInfo` is settled by exactly two things — a reply or
        // its timeout — and dispose is about to clear that timeout. Skipping this drain would hang
        // the heal, `commitTail`, and every lane operation queued behind it. Resolve, then clear,
        // so a fired timer cannot race a half-drained map.
        for (const waiter of recoveryWaiters.values()) waiter({ kind: 'disposed' })
        recoveryWaiters.clear()
        for (const timer of recoveryTimers.values()) clearTimeout(timer)
        for (const timer of pendingReplies.values()) clearTimeout(timer)
        for (const timer of pendingLedgerReplies) clearTimeout(timer)
        recoveryTimers.clear()
        pendingReplies.clear()
        pendingLedgerReplies.clear()
        ledgerWaiters.clear()
        suppressedRequests.clear()
        // Independent failures, both surfaced: a teardown that failed must not stop the mux from
        // closing its hub drain, and a mux that failed must not hide a teardown failure that
        // happened first. `inboxLane` is cleared unconditionally after both, whichever way they
        // settled — `to()` has no lane left to build a directed client against either way.
        // Only `mux.dispose()` rejects in practice, and only on a synchronous `return()` throw (its
        // async close is fire-and-forget); `teardownEpoch()`'s arm is defensive (see its comment).
        // So the two-failure `AggregateError` is reachable only via the mux path today.
        const disposeErrors: Array<unknown> = []
        try {
          await teardownEpoch()
        } catch (error) {
          disposeErrors.push(error)
        }
        try {
          await mux.dispose()
        } catch (error) {
          disposeErrors.push(error)
        }
        inboxLane = undefined
        if (disposeErrors.length === 1) throw disposeErrors[0]
        if (disposeErrors.length > 1) throw new AggregateError(disposeErrors, 'Peer dispose failed')
      })()
      return disposePromise
    },
  }
}
