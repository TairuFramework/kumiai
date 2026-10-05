import type { Client } from '@enkaku/client'
import type {
  DataOf,
  EventProcedureDefinition,
  ProtocolDefinition,
  RequestProcedureDefinition,
  ReturnOf,
} from '@enkaku/protocol'
import type {
  GatheredReply,
  GatherOptions,
  RequestOptions,
  SuppressConfig,
} from '@kumiai/broadcast'
import type { LogHub } from '@kumiai/hub-tunnel'
import type { Runtime } from '@sozai/runtime'

import type { AnchorStore } from './anchor.js'
import type { AppCursorStore, AppWindowPruned } from './app-cursor.js'
import type { AppDeliveryResumed, AppDeliveryStalled } from './app-lane.js'
import type { AppOutbox } from './app-outbox.js'
import type { CommitJournal, LaneResult, PendingCommit } from './commit.js'
import type {
  GroupCrypto,
  GroupMLS,
  OpenedRecoveryVerdict,
  RecoveryRefusalReason,
} from './crypto.js'
import type { GroupProcedureHandlers } from './handlers.js'
import type { ReceiveLaneEnded, SubscribeFailure } from './hub-mux.js'
import type { AppOutboxCleared } from './log-delivery.js'
import type { GroupProtocolDefinition } from './protocol.js'

export const DEFAULT_RECOVERY_TIMEOUT_MS = 5000
export const DEFAULT_RECOVERY_JITTER_MS = 250

/**
 * How long `recover()` keeps rejoining before giving up and leaving the peer degraded. A
 * deadline, not an attempt count: losing the compare-and-set is expected — a heal runs under
 * commit pressure and two peers healing at once race each other.
 */
export const DEFAULT_RECOVERY_DEADLINE_MS = 30_000

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

/**
 * How long `commit` keeps rebasing before giving up. A deadline, not an attempt count: several
 * consecutive lost compare-and-sets on a busy group is ordinary contention.
 */
export const DEFAULT_COMMIT_DEADLINE_MS = 30_000

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
  | (RecoveryEventBase &
      RecoveryFailureDetails & {
        phase: 'failed'
        reason: RecoveryFailureReason
        error?: unknown
      })
  | (RecoveryEventBase & { phase: 'bootstrapped' })

/** What a failed recovery learned from its responders, when it learned anything. */
export type RecoveryFailureDetails = {
  refusal?: RecoveryRefusalReason
  responder?: string
  advisory?: Array<OpenedRecoveryVerdict>
}

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
