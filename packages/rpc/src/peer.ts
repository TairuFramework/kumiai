import type { ProtocolDefinition } from '@enkaku/protocol'
import { normalizeDID } from '@kokuin/token'
import { defaultJitter, encodeEventFrame } from '@kumiai/broadcast'
import type { StoredMessage } from '@kumiai/hub-protocol'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'
import { createRuntime } from '@sozai/runtime'

import type { Anchor, AnchorSlot } from './anchor.js'
import { type AppDeliveryResumed, type AppDeliveryStalled, createAppLane } from './app-lane.js'
import { createAppOutboxAcceptance } from './app-outbox.js'
import { classifyCommit, digestAppliedCommit } from './classify.js'
import { RecoveryRequiredError } from './commit.js'
import {
  type CommitFrame,
  decodeCommitFrame,
  encodeCommitFrame,
  isUnsupportedCommitFrameVersion,
} from './commit-frame.js'
import { appliedRows, forkEvidence } from './control/forks.js'
import { searchOccurrence } from './control/occurrence.js'
import {
  enqueueOperation,
  type OperationDeps,
  revokeHeld,
  stepOperation,
} from './control/operations.js'
import { type RejoinDeps, rejoinBarrier, type SourceScan, stepRejoin } from './control/rejoin.js'
import {
  type CertifiedControlRange,
  CONTROL_SEARCH_BUDGET,
  type ControlEvidenceSnapshot,
  type ControlHold,
  type ControlSearchWork,
  createControlSearch,
  isCertifiedControlLoser,
} from './control/search.js'
import { settleControlSlot } from './control/slot.js'
import { applyResolved as applyControlResolved, pruneWindow } from './control/store.js'
import type {
  AdoptionWriteFactory,
  AppliedCommit,
  CommitCursor,
  ControlSnapshot,
  ControlStore,
  ExternalResponse,
  ForkEvidence,
  OperationRequest,
  Outcome,
  RejoinRecord,
} from './control/types.js'
import { deliverObligations } from './control/welcome.js'
import {
  type AppliedRecovery,
  type GroupCrypto,
  type GroupMLS,
  isMissingLedgerEntries,
  type PendingAppFrame,
  type PendingRecovery,
  type ProcessCommitResult,
  type RecoveryVerdict,
} from './crypto.js'
import { asLogPosition, assertForwardPage, type LogPosition } from './cursor.js'
import { OperationOutcomeError, PeerDisposedError, PeerRemovedError } from './errors.js'
import { assertFrameFits } from './frame-size.js'
import { adaptBusHandlers, type BusHandlerMaps } from './handlers.js'
import {
  decodeHandshakeFrame,
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
  HANDSHAKE_VERSION,
} from './handshake.js'
import { createHostBoundary, wrapPeerHost, wrapPendingRecovery } from './host-boundary.js'
import { notifyHost } from './host-notice.js'
import { createHubMux, type HubMux } from './hub-mux.js'
import { createLedgerEntryResolver, encodeLedgerEntries } from './ledger-entries.js'
import { checkedFetchResult, createLogDelivery, type EpochFloor } from './log-delivery.js'
import { createEpochRuntime } from './peer-epoch.js'
import {
  DEFAULT_APP_LOG_RETENTION_SECONDS,
  DEFAULT_COMMIT_DEADLINE_MS,
  DEFAULT_COMMIT_LOG_RETENTION_SECONDS,
  DEFAULT_RECOVERY_DEADLINE_MS,
  DEFAULT_RECOVERY_JITTER_MS,
  DEFAULT_RECOVERY_TIMEOUT_MS,
  type GroupPeer,
  type GroupPeerParams,
  type ProtocolSurface,
  type RecoveryEvent,
  type RecoveryFailureDetails,
  type RecoveryFailureReason,
  type RecoveryTrigger,
  type StrandConfidence,
  type StrandObservation,
} from './peer-types.js'
import { retentionOf } from './protocol.js'
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
  type RecoveryConfirmRequest,
} from './recovery.js'
import {
  type ConfirmationWaiter,
  confirmationTag,
  createRecoveryCache,
  type RecoveryCommitOutcome,
  responseOutcome,
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

export {
  DEFAULT_APP_LOG_RETENTION_SECONDS,
  DEFAULT_COMMIT_LOG_RETENTION_SECONDS,
  type GroupPeer,
  type GroupPeerMLSParams,
  type GroupPeerParams,
  type InternalSurface,
  type ProtocolSurface,
  type RecoveryEvent,
  type RecoveryFailureDetails,
  type RecoveryFailureReason,
  type RecoveryTrigger,
  type StrandConfidence,
  type StrandKind,
  type StrandObservation,
} from './peer-types.js'

/** How many commit frames a single pull asks for. Pull loops until the log is drained. */
const COMMIT_FETCH_LIMIT = 100

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

type RendezvousOutcome =
  | { kind: 'reply'; sealed: Uint8Array }
  | { kind: 'timeout'; atDeadline: boolean }
  | { kind: 'disposed' }
  | { kind: 'publish-failed'; error: unknown }

type PendingAnchorRotation = NonNullable<AnchorSlot['pending']>

type ResolveAnchorRotationParams = {
  port: GroupMLS
  /** A completed refusal can clear its unlanded rotation while the peer stays live. */
  knownUnlanded?: boolean
  initial?: boolean
}

/** Identifies one handle advance, so a retry of the same advance reuses its rotation record. */
type AdvanceIdentity = {
  epochAfter: number
  forced: boolean
  /** Digest of the commit that advances the handle. */
  advance: string
  /** A confirmed recovery adoption, the one advance allowed past an unresolved anchor. */
  recovery?: boolean
}

type AdvanceHandleParams<TResult> = {
  port: GroupMLS
  /** Ratchets the handle and does nothing else. */
  ratchet: () => Promise<TResult>
  identity: AdvanceIdentity
  /** Commit-log position of the advance, persisted as the commit cursor once it lands. */
  floorPosition?: LogPosition
}

type RecoveryVerdictBinding = Pick<
  RecoveryVerdict,
  'groupID' | 'requestID' | 'position' | 'commitDigest'
>

function verdictForOutcome(
  binding: RecoveryVerdictBinding,
  outcome: RecoveryCommitOutcome,
): RecoveryVerdict {
  switch (outcome.kind) {
    case 'applied':
      return {
        ...binding,
        verdict: 'confirmed',
        epoch: outcome.epoch,
        tag: confirmationTag(outcome.key, binding.requestID),
      }
    case 'superseded':
      return { ...binding, verdict: 'superseded' }
    case 'refused':
      return { ...binding, verdict: 'refused', reason: outcome.reason }
  }
}

export function createGroupPeer<Protocols extends Record<string, ProtocolDefinition>>(
  input: GroupPeerParams<Protocols>,
): GroupPeer<Protocols> {
  return createGroupPeerWithControlWalk<Protocols>(input).peer
}

type ControlWalkRequest = {
  through: LogPosition | null
  range: CertifiedControlRange | null
  work: ControlSearchWork
}

/** Internal construction seam for bounded control reconciliation. */
export function createGroupPeerWithControlWalk<
  Protocols extends Record<string, ProtocolDefinition>,
>(
  input: GroupPeerParams<Protocols>,
): {
  peer: GroupPeer<Protocols>
  controlWalk: {
    walkCommits(search: ControlWalkRequest): Promise<boolean>
    head(): LogPosition | null
  }
} {
  const boundary = createHostBoundary()
  const controlAbort = new AbortController()
  const applyResolved: typeof applyControlResolved = (store, changes, mutationID) =>
    applyControlResolved(store, changes, mutationID, undefined, controlAbort.signal)
  const params = wrapPeerHost(boundary, input)
  const {
    hub,
    crypto,
    mls,
    control: hostControl,
    prepareBuild,
    validation,
    adopt,
    deliverWelcome,
    anchorStore,
    appCursorStore,
    protocols,
    handlers,
    suppress,
  } = params
  let revokeHold = false
  let rejoinHeld = false
  let rejoinPosition: LogPosition | null = null
  let hasOperations = false
  let controlHold: ControlHold | null = null
  const hardControlHeld = () => controlHold !== null && controlHold.reason !== 'acceptance-unknown'
  const control: ControlStore | undefined =
    hostControl === undefined
      ? undefined
      : {
          get key() {
            return hostControl.key
          },
          load: () => hostControl.load(),
          lastMutation: () => hostControl.lastMutation(),
          apply: (changes, mutationID) => {
            if (changes.controlHold != null && !hardControlHeld()) {
              controlHold = changes.controlHold
              if (hardControlHeld()) {
                stranded = true
                healRequested = false
              }
            }
            return hostControl.apply(changes, mutationID)
          },
        }
  let unresolvedControlSlot = false
  let operationDeadline: number | null = null
  const logSubmissions = new Set<Promise<unknown>>()
  const logSendsHeld = (): boolean => revokeHold
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
  const operationTimeoutMs = params.operationTimeoutMs ?? DEFAULT_COMMIT_DEADLINE_MS
  const mux: HubMux = createHubMux({
    hub,
    localDID,
    ...(params.onSubscribeFailed != null ? { onSubscribeFailed: params.onSubscribeFailed } : {}),
    ...(params.onReceiveEnded != null ? { onReceiveEnded: params.onReceiveEnded } : {}),
  })

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
  let anchorPending: PendingAnchorRotation | undefined
  let anchorRecoveryPending = false
  let sealError: Error | undefined
  const finishSealBarrier = (): void => {
    sealBarrier = undefined
    releaseSealBarrier?.()
    releaseSealBarrier = undefined
  }

  let anchorCapture: { advance: string | undefined; anchor: Anchor } | undefined
  let epochNeedsBuild = false
  let anchorSaveFailed = false
  const saveResolvedAnchor = async (slot: AnchorSlot): Promise<void> => {
    try {
      await anchorStore?.save(slot)
      anchorSaveFailed = false
    } catch (error) {
      anchorSaveFailed = true
      throw error
    }
  }
  const captureAnchor = async (advance?: string): Promise<void> => {
    const captured =
      anchorCapture != null && anchorCapture.advance === advance
        ? anchorCapture.anchor
        : await crypto.exportSecret(APP_TOPIC_LABEL)
    const { secret, epoch } = captured
    if (disposed) return
    anchorCapture = { advance, anchor: { secret, epoch } }
    // Retain before the save can wait, so frames at the new anchor are buffered meanwhile.
    for (const name of Object.keys(protocols)) {
      mux.retainTopic(protocolTopic(secret, epoch, name), { retention: appLogRetentionSeconds })
    }
    mux.retainTopic(inboxTopic(secret, epoch, localDID), { retention: appLogRetentionSeconds })
    await saveResolvedAnchor({ anchor: anchorCapture.anchor })
    if (disposed) return
    anchor = { secret, epoch }
    anchorCapture = undefined
    anchorPending = undefined
    sealError = undefined
    finishSealBarrier()
    appLane.reset()
  }

  /** The rotation resolved without moving the anchor: drop the record and keep the anchor. */
  const keepAnchor = async (): Promise<void> => {
    await saveResolvedAnchor({ anchor })
    if (disposed) return
    anchorPending = undefined
    sealError = undefined
    finishSealBarrier()
  }
  const requireAnchorRecovery = (): void => {
    anchorRecoveryPending = true
    healRequested = true
    sealError = new Error('app anchor requires confirmed recovery')
  }

  const resolveAnchorRotation = async (params: ResolveAnchorRotationParams): Promise<void> => {
    const { port, knownUnlanded = false, initial = false } = params
    const record = anchorPending
    if (record == null) return
    const stored = await anchorStore?.load()
    if (stored?.pending?.advance === record.advance) record.landed = stored.pending.landed
    const epoch = await port.readEpoch()
    assertLive()
    if (!record.landed) {
      if (!knownUnlanded && !initial) return
      await keepAnchor()
      return
    }
    if (epoch !== record.epochAfter) {
      requireAnchorRecovery()
      return
    }
    const roster = (await port.rosterEntries()).map((entry) => normalizeDID(entry.did))
    if (record.forced || detectRosterChange(record.rosterBefore, roster)) {
      await captureAnchor(record.advance)
    } else {
      await keepAnchor()
    }
  }

  // Live log pushes carry no authoritative bytes or position. One queued control-first pull
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
            await settleOperations()
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
  // An incomplete ledger skips the commit pull without failing it. In a quiet group no later
  // delivery would retry, so the skip arms its own backoff. Each retry is a commit wakeup without
  // the heal: heals keep their own triggers and backoff.
  let ledgerRetryTimer: ReturnType<typeof setTimeout> | undefined
  let ledgerRetryBackoff = 1000
  const armLedgerRetry = (): void => {
    if (disposed || ledgerRetryTimer != null) return
    ledgerRetryTimer = setTimeout(() => {
      ledgerRetryTimer = undefined
      if (disposed) return
      let ledgerReady = false
      void ready
        .then(() => {
          if (disposed) return
          return runSerial(async () => {
            if (disposed) return
            const replayed = await settleOperations()
            if (mls != null && (await ensureLedger(Date.now() + recoveryTimeoutMs))) {
              ledgerReady = true
              await finalizeBootstrap(mls)
            }
            if (disposed) return
            const pulled = await pullCommits()
            if (!disposed && (replayed || pulled)) await rebuildEpoch()
          })
        })
        .catch(() => {
          // a failed retry leaves the cursor put; pullCommits re-arms while the ledger is incomplete
        })
        // A strand the completed pull found heals outside the lane. An incomplete ledger does not
        // heal here: the gather that failed is the repair, and the backoff re-runs it.
        .then(() => (ledgerReady ? healIfRequested() : undefined))
    }, ledgerRetryBackoff)
    ledgerRetryBackoff = Math.min(ledgerRetryBackoff * 2, 60_000)
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

  const epochRuntime = createEpochRuntime<Protocols>({
    boundary,
    mux,
    crypto,
    localDID,
    protocols,
    handlers,
    suppress,
    runtime: params.runtime,
    appLogRetentionSeconds,
    anchor: () => anchor,
    sealBarrier: () => sealBarrier,
    sealError: () => sealError,
    isDisposed: () => disposed,
    note: (name, topicID, message, failure) => appLane.note(name, topicID, message, failure),
    requestAppPull,
  })
  const {
    buildEpoch,
    teardownEpoch,
    rebuildEpoch: rebuildEpochRuntime,
    epochSettled,
    surfaceFor,
    sealForSegment,
  } = epochRuntime
  const rebuildEpoch = async (): Promise<void> => {
    await rebuildEpochRuntime()
    epochNeedsBuild = anchorPending != null
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
            if (revokeHold) {
              await runSerial(async () => {
                if (await settleOperations()) await rebuildEpoch()
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
            rejoinHeld ||
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
              await settleOperations()
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
          deliveredWindowMs: appLogRetentionSeconds * 1000,
          deliveredLimit: params.appOutboxLimit,
        })

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
  let durableStrand: ControlSnapshot['strand'] = null
  /**
   * Persist the strand before anything steps past its evidence. The durable position stays where
   * it was, so a restart re-reads an ahead frame; a losing fork was applied before its winner was
   * seen, so only the flag carries it across a restart.
   */
  const persistStrand = async (
    fork?: ForkEvidence,
    reason: NonNullable<ControlSnapshot['strand']>['reason'] = 'lost-state',
  ): Promise<void> => {
    if (mls == null || control == null) return
    const epoch = await mls.readEpoch()
    if (
      durableCursor?.stranded === true &&
      durableCursor.epoch === epoch &&
      fork == null &&
      durableStrand?.reason === reason
    )
      return
    // A later reveal must not discard rows already known to be affected by this strand.
    const previous = durableCursor?.fork
    const evidence =
      previous != null && (fork == null || previous.conflictEpoch <= fork.conflictEpoch)
        ? previous
        : fork
    const cursor: CommitCursor = {
      position: durableCursor?.epoch === epoch ? durableCursor.position : null,
      epoch,
      stranded: true,
      ...(evidence == null ? {} : { fork: evidence }),
    }
    await applyResolved(control, { cursor, strand: { reason } }, newPublishID())
    durableCursor = cursor
    durableStrand = { reason }
  }
  const saveCommitCursor = async (
    position: LogPosition,
    response?: ExternalResponse,
  ): Promise<void> => {
    if (mls == null) return
    if (control != null) {
      const epoch = await mls.readEpoch()
      const cursor: CommitCursor = stranded
        ? {
            position: durableCursor?.epoch === epoch ? durableCursor.position : null,
            epoch,
            stranded: true,
            ...(durableCursor?.fork == null ? {} : { fork: durableCursor.fork }),
          }
        : {
            position:
              durableCursor?.position != null && durableCursor.position > position
                ? durableCursor.position
                : position,
            epoch,
          }
      const snapshot = await control.load()
      await applyResolved(
        control,
        {
          ...pruneWindow(
            snapshot,
            Math.max(
              response?.epoch ?? 0,
              ...snapshot.applied.map((row) => row.epoch),
              ...snapshot.responses.map((row) => row.epoch),
            ),
          ),
          cursor,
          ...(!cursor.stranded ? { strand: null } : {}),
          ...(response == null ? {} : { putResponses: [response] }),
        },
        newPublishID(),
      )
      await refreshControl()
    }
    if (reconciledHead == null || reconciledHead < position) reconciledHead = position
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
   * An epoch with no retained row is history, including epochs outside the durable window.
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
  let recoveryRetryTimer: ReturnType<typeof setTimeout> | undefined
  let recoveryBackoff = 1000
  const clearRecoveryRetry = (): void => {
    if (recoveryRetryTimer != null) clearTimeout(recoveryRetryTimer)
    recoveryRetryTimer = undefined
  }
  const retryRecovery = (): void => {
    if (disposed || hardControlHeld() || recoveryRetryTimer != null || renewalHeld() || refusalHeld)
      return
    recoveryRetryTimer = setTimeout(() => {
      recoveryRetryTimer = undefined
      if (disposed || hardControlHeld() || renewalHeld() || refusalHeld || activeRecovery != null)
        return
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
   * The ledger entries this peer held when it rejoined — snapshotted BEFORE the rejoined handle
   * replaces them, since a handle that rejoined by external commit holds an EMPTY ledger.
   *
   * A lost anchor secret also defers operation bodies into this set. Other entries come from the
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
      controlReplayed = false
      appNoticeInSerial = true
      try {
        if (epochNeedsBuild && mls != null && !locallyRemoved) {
          await resolveAnchorRotation({ port: mls })
          if (anchorPending == null && epochRuntime.hasInboxLane()) {
            await rebuildEpoch()
            epochNeedsBuild = false
          }
        }
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
   * Whether saved operations have been settled in the lane operation now running. Cleared when an
   * operation takes the mutex, set by `settleOperations`, required by `pullCommits`.
   *
   * The ordering it enforces saves a group of one: a peer that pulls before it replays meets its
   * OWN un-merged commit in the log, which classifies as a heal — from a group that, at creation,
   * has nobody to answer. The following replay would adopt the commit anyway, so unguarded this
   * peer would spend a rendezvous and a recovery deadline asking the void for help, every restart.
   */
  let controlReplayed = false

  // Recovery rendezvous state, keyed by requestID.
  const recoveryWaiters = new Map<string, (outcome: RendezvousOutcome) => void>()
  const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingReplies = new Map<string, ReturnType<typeof setTimeout>>()
  const inFlightBootstraps = new Set<Promise<void>>()
  const suppressedRequests = new Set<string>()
  const confirmationWaiters = new Map<string, ConfirmationWaiter>()
  const commitOutcomes = new Map<string, ExternalResponse>()
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

  const handleRecoveryConfirmRequest = (request: RecoveryConfirmRequest): void => {
    if (mls == null || rendezvousTopicID == null || disposed || stranded || locallyRemoved) return
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
      const blocked = () =>
        stranded ||
        locallyRemoved ||
        (rejoinPosition != null && request.position >= rejoinPosition) ||
        (pendingRecovery != null && request.position >= pendingRecovery.position)
      if (blocked()) return
      let record = commitOutcomes.get(request.position)
      if (record == null) {
        await ready
        if (disposed) return
        await runSerial(async () => {
          if (disposed) return
          await settleOperations()
          await reconcileCommits()
        })
        if (disposed || blocked()) return
        record = commitOutcomes.get(request.position)
      }
      if (record == null || record.digest !== request.commitDigest) return
      const cacheKey = JSON.stringify([
        verified.requesterDID,
        request.requestID,
        Array.from(request.request),
        request.position,
        request.commitDigest,
      ])
      let cached = verdictCache.get(cacheKey)
      if (cached == null) {
        const outcome = await responseOutcome(port, record)
        if (outcome == null) return
        const verdict = verdictForOutcome(
          {
            groupID: verified.groupID,
            requestID: request.requestID,
            position: request.position,
            commitDigest: request.commitDigest,
          },
          outcome,
        )
        if (outcome.kind === 'applied') outcome.key.fill(0)
        const sealed = port
          .sealRecoveryVerdict(request.request, verdict)
          .catch((error: unknown) => {
            if (verdictCache.get(cacheKey)?.value === sealed) verdictCache.delete(cacheKey)
            throw error
          })
        const expiresAt = Date.now() + recoveryDeadlineMs
        verdictCache.set(cacheKey, sealed, expiresAt)
        cached = { value: sealed, expiresAt }
      }
      const sealed = await cached.value
      const expiresAt = cached.expiresAt
      if (disposed || blocked() || expiresAt <= Date.now()) return
      const response = record
      const confirmable = async () =>
        response.kind !== 'applied' || (await port.readEpoch()) === response.epochAfter
      if (!(await confirmable())) return
      const timer = setTimeout(
        () => {
          verdictTimers.delete(timer)
          void (async () => {
            if (disposed || blocked() || expiresAt <= Date.now() || !(await confirmable())) return
            await mux.publish({
              topicID,
              payload: encodeHandshakeFrame(
                HANDSHAKE_KIND.recoveryVerdict,
                encodeRecoveryVerdict(request.requestID, sealed),
              ),
            })
          })().catch(() => {})
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
  const advanceHandle = async <TResult>(params: AdvanceHandleParams<TResult>): Promise<TResult> => {
    const { port, ratchet, identity, floorPosition } = params
    await resolveAnchorRotation({ port })
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
    const record: PendingAnchorRotation =
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
      await refreshControl()
      await removalEffect()
      const epoch = await port.readEpoch()
      if (epoch !== epochBefore) epochNeedsBuild = true
      if (epoch === identity.epochAfter && epoch !== record.epochBefore && floorPosition != null)
        floor = { epoch, position: floorPosition, covered: true }
    }
    try {
      const advanced = await ratchet()
      await observe()
      await resolveAnchorRotation({ port, knownUnlanded: true })
      if (confirmedRecovery && anchorPending == null) anchorRecoveryPending = false
      return advanced
    } catch (error) {
      try {
        await observe()
        await resolveAnchorRotation({ port })
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
  const walkCommits = async (
    port: GroupMLS,
    topicID: string,
    search?: ControlWalkRequest,
  ): Promise<boolean> => {
    if (
      anchorRecoveryPending ||
      locallyRemoved ||
      (controlHold !== null && controlHold.reason !== 'acceptance-unknown')
    )
      return false
    let advancedEpoch = false
    const started = logDelivery?.beginWalk() ?? 0
    const unprocessable = async (
      position: LogPosition,
      commitDigest: string,
      localEpoch: number,
      claimedEpoch: number | null,
    ): Promise<boolean> => {
      stranded = true
      healRequested = true
      await persistStrand(undefined, 'unprocessable-gap')
      observeStrand({
        position,
        commitDigest,
        localEpoch,
        claimedEpoch,
        kind: 'unprocessable-gap',
        confidence: 'claimed',
      })
      return advancedEpoch
    }
    let covered = true
    // The tip from the SAME reply whose frames were processed, so it can never run ahead of them.
    const takeHead = (head: string | null): void => {
      commitLogHead = head == null ? null : asLogPosition(head)
      if (
        search !== undefined &&
        search.through !== null &&
        commitLogHead !== null &&
        commitLogHead > search.through
      )
        commitLogHead = search.through
      if (covered && !stranded && floor.covered) {
        if (!advancedEpoch) floor = { ...floor, position: reconciledHead }
        logDelivery?.certify(floor.epoch, started)
      }
    }
    while (true) {
      if (disposed) return false
      const pageAfter = reconciledHead
      if (search !== undefined) {
        if (
          search.through === null ||
          (pageAfter !== null && pageAfter >= search.through) ||
          !search.work.takeFetch()
        )
          return advancedEpoch
      }
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
      // With no cursor the hub flags ANY log removal as a gap, so an unflagged read from the
      // oldest frame holds the whole log: a fresh member's floor stays covered, and its first
      // publication must not request a heal.
      if (pageAfter == null && result.gap) {
        covered = false
        floor = { ...floor, covered: false }
      } else if (pageAfter != null && gap) {
        floor = { ...floor, covered: false }
        stranded = true
        healRequested = true
        await persistStrand(undefined, 'retention-gap')
        observeStrand({
          position: pageAfter,
          commitDigest: null,
          localEpoch: await port.readEpoch(),
          claimedEpoch: null,
          kind: 'retention-gap',
          confidence: 'claimed',
        })
      }
      // A short page may carry a one-shot fork reveal below the cursor. Only a full page loops.
      if (result.messages.length === COMMIT_FETCH_LIMIT) {
        assertForwardPage(pageAfter, result.messages)
      }
      if (result.messages.length === 0) {
        // An empty gap ends at head; retained frames still require classification.
        if (gap && result.head != null) reconciledHead = asLogPosition(result.head)
        // Drained. The tip an EMPTY page reports is not redundant: a topic keeps its head when
        // its frames age out, so anchoring on the cursor here would compare-and-set against
        // `null` on a topic whose head is real, and lose forever.
        takeHead(result.head)
        return advancedEpoch
      }
      for (const message of result.messages) {
        // A commit this peer landed moved its cursor to that frame's position on acceptance (the
        // operation carries that across a restart); meeting its own commit here means its saved operation
        // was lost or never written.
        const position = asLogPosition(message.sequenceID)
        if (search !== undefined) {
          if (search.through === null) return advancedEpoch
          if (position > search.through) {
            takeHead(search.through)
            return advancedEpoch
          }
          if (!search.work.takeFrame()) return advancedEpoch
        }
        if (rejoinPosition != null && position >= rejoinPosition) return advancedEpoch
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
          const localEpoch = await port.readEpoch()
          await holdControl({ reason: 'unsupported-version', position })
          observeStrand({
            position,
            commitDigest: null,
            localEpoch,
            claimedEpoch: null,
            kind: 'unknown-version',
            confidence: 'claimed',
          })
          return advancedEpoch
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
            await holdControl({ reason: 'unsupported-version', position })
            observeStrand({
              position,
              commitDigest: null,
              localEpoch,
              claimedEpoch: null,
              kind: 'unknown-version',
              confidence: 'claimed',
            })
            return advancedEpoch
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
          let readHeader: Awaited<ReturnType<GroupMLS['readCommitHeader']>>
          try {
            readHeader = await port.readCommitHeader(commitFrame.commit)
          } catch (error) {
            if (error instanceof Error && error.name === 'CommitValidationUnavailableError')
              return unprocessable(position, commitDigest, localEpoch, localEpoch)
            throw error
          }
          if (disposed) return false
          // Normalized before `classifyCommit` compares it against `state.localDID` (also
          // normalized, at construction) — an own-unmerged commit authenticated under a different
          // form of this member's own DID must still be recognized as its own.
          const header =
            readHeader?.committerDID != null
              ? { ...readHeader, committerDID: normalizeDID(readHeader.committerDID) }
              : readHeader
          const certificate = search?.range
          if (certificate != null && header != null) {
            const key = (await port.readRecoverySource()).key
            const winner = appliedByEpoch.get(certificate.source.epoch)
            if (
              winner?.sequenceID === certificate.winner.position &&
              winner.payloadDigest === certificate.winner.payloadDigest &&
              isCertifiedControlLoser(
                certificate,
                key,
                header.epoch,
                position,
                toB64U(sha256(message.payload)),
              )
            ) {
              await saveCommitCursor(position)
              break
            }
          }
          const disposition = classifyCommit({
            header,
            sequenceID: position,
            commitDigest,
            state: { localDID, epoch: localEpoch, appliedByEpoch },
          })

          if (disposition.row === 'own-unmerged') {
            const slot = (await control?.load())?.commitOnce
            if (
              slot !== null &&
              slot !== undefined &&
              slot.payloadDigest === toB64U(sha256(message.payload))
            ) {
              const settled = await settleRetainedControlSlot({
                position,
                payload: message.payload,
                senderDID: message.senderDID,
              })
              if (settled === 'landed' || settled === 'superseded') {
                advancedEpoch = true
                await saveCommitCursor(position)
                break
              }
              return advancedEpoch
            }
            await holdControl({
              reason: 'fork-evidence',
              position,
              evidence: {
                kind: 'unexplained-own-commit',
                epoch: localEpoch,
                position,
                digest: commitDigest,
              },
            })
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
            await persistStrand(undefined, 'ahead')
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
            // Two commits at one epoch. The lower-sequenceID branch wins; the loser rejoins onto it
            // (a heal). The winner just steps over the frame.
            if (disposition.branch === 'losing') {
              stranded = true
              if (control != null && header != null) {
                await persistStrand(forkEvidence(await control.load(), header.epoch, commitDigest))
              }
            }
            await saveCommitCursor(
              position,
              header?.external && disposition.branch !== 'losing' && !stranded
                ? { position, digest: commitDigest, kind: 'superseded', epoch: header.epoch }
                : undefined,
            )
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
          const anchorEpochBefore = anchor.epoch
          const snapshot = await control?.load()
          const adoption =
            snapshot == null
              ? undefined
              : adoptionWrite({
                  snapshot,
                  epoch: framedEpoch,
                  digest: commitDigest,
                  payloadDigest: toB64U(sha256(message.payload)),
                  position,
                  external: header?.external === true,
                })
          let applied: ProcessCommitResult
          let resolverFailed = false
          try {
            // Through the seam, like every other site that ratchets the handle: it reads this
            // epoch's app frames ahead of the apply and takes the anchor if the roster moved.
            applied = await advanceHandle({
              port,
              ratchet: async () => {
                if (disposed) {
                  return {
                    applied: false,
                    advanced: false,
                    epochBefore: framedEpoch,
                    epochAfter: framedEpoch,
                  }
                }
                const result = await port.processCommit(commitFrame.commit, {
                  senderDID: message.senderDID,
                  ...(adoption == null ? {} : { adoption }),
                  // The resolver, not the bodies: the blob opens only if the port asks for entries
                  // this commit names, and only for a commit it applies — framed at this peer's
                  // epoch, the epoch the blob is sealed under, making body delivery atomic with the
                  // commit. Called from INSIDE the apply, so the open must not touch the handle's
                  // ratchet: `openEntries` reads only the epoch's exporter secret and is pure.
                  resolveLedgerEntries: async (ids) => {
                    try {
                      return await createLedgerEntryResolver(
                        commitFrame.sealedEntries,
                        crypto.openEntries,
                      )(ids)
                    } catch (error) {
                      resolverFailed = true
                      throw error
                    }
                  },
                })
                return result
              },
              // A REJOIN rotates the anchor too, from a member the roster diff cannot see: an
              // external commit by a member the roster still holds leaves every DID where it was.
              // Only an APPLIED commit says anything about the group.
              identity: {
                epochAfter: (header?.epoch ?? framedEpoch) + 1,
                forced: header?.external === true,
                advance: commitDigest,
              },
              floorPosition: position,
            })
          } catch (error) {
            if (disposed) return false
            if (
              resolverFailed ||
              (error instanceof Error && error.name === 'CommitValidationUnavailableError')
            ) {
              await resolveAnchorRotation({ port, knownUnlanded: true })
              return unprocessable(position, commitDigest, framedEpoch, header?.epoch ?? null)
            }
            if (!isMissingLedgerEntries(error)) {
              // The port broke its contract. The cursor stays and the frame is re-read — the pull is
              // a retry, and this is not an outcome it can name.
              throw error
            }
            if ((await port.readEpoch()) !== framedEpoch) {
              await resolveAnchorRotation({ port })
              throw error
            }
            await resolveAnchorRotation({ port, knownUnlanded: true })
            // The commit names ledger entries whose bodies will not resolve. POISON: drop, advance,
            // do NOT heal. The bodies ride the commit sealed under its framed epoch, so a blob this
            // peer cannot open is one no member at this epoch can — nobody applies it, and the next
            // honest commit is framed at the same epoch and compare-and-sets behind it.
            //
            // Healing here would hand any member a group-wide recovery storm for one publish.
            // Retrying only delays that. The one case where this peer really is the broken one
            // announces itself later: the next commit is then framed AHEAD of this peer's, which
            // heals it.
            await saveCommitCursor(
              position,
              header?.external
                ? {
                    position,
                    digest: commitDigest,
                    epoch: framedEpoch,
                    kind: 'refused',
                    reason: 'invalid',
                  }
                : undefined,
            )
            break
          }
          if (disposed) return false
          if (applied.validation === 'unavailable') {
            await resolveAnchorRotation({ port, knownUnlanded: true })
            return unprocessable(position, commitDigest, framedEpoch, header?.epoch ?? null)
          }
          if (applied.applied && snapshot != null && control != null) {
            const settled = await control.load()
            for (const op of snapshot.operations) {
              if (
                op.stage !== 'accepted' ||
                op.built.payloadDigest !== toB64U(sha256(message.payload))
              )
                continue
              const outcome = settled.outcomes.find(
                (row) => row.opID === op.id && row.kind === 'landed',
              )
              if (outcome != null) emitOutcome(outcome)
            }
          }
          if (!applied.advanced && applied.epochBefore !== framedEpoch) {
            advancedEpoch = true
            localEpoch = applied.epochBefore
            continue
          }
          if (applied.advanced) {
            advancedEpoch = true
            if (header?.external) logDelivery?.rejoined(anchorEpochBefore)
          }
          // `{ advanced: false }` here is the port REFUSING a well-formed commit at this peer's own
          // epoch from another member: poison on the same terms as an unresolvable one.
          if (!applied.applied) {
            await saveCommitCursor(
              position,
              header?.external
                ? {
                    position,
                    digest: commitDigest,
                    kind: 'refused',
                    epoch: framedEpoch,
                    reason: applied.refusal ?? 'invalid',
                  }
                : undefined,
            )
          }
          if (applied.applied && (reconciledHead == null || reconciledHead < position))
            reconciledHead = position
          if (locallyRemoved) return advancedEpoch
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
    if (disposed || locallyRemoved) return false
    if (!controlReplayed) {
      throw new Error(
        'pullCommits: saved operations must settle first in every lane operation, or a peer that crashed on its own commit heals from it instead of adopting it',
      )
    }
    if (mls == null || commitTopicID == null) return false
    if (!(await mls.isLedgerComplete())) {
      armLedgerRetry()
      return false
    }
    ledgerRetryBackoff = 1000
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
      if (epochRuntime.hasInboxLane()) {
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
    scheduleControlSlotRetry(0)
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
          const replayed = await settleOperations()
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
      .then(() => {
        scheduleControlSlotRetry()
        return healIfRequested()
      })
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
    seal: GroupCrypto['sealEntries'] = crypto.sealEntries,
  ): Promise<{ payload: Uint8Array; epoch: number }> => {
    const { sealed: sealedEntries, epoch } = await seal(encodeLedgerEntries(bodies))
    if (framedAt != null && epoch !== framedAt) {
      throw new Error(
        'commit: the local group has already advanced past the epoch this commit was framed at. Build must leave the current handle unchanged until host adoption.',
      )
    }
    const payload = encodeHandshakeFrame(
      HANDSHAKE_KIND.commit,
      encodeCommitFrame(commit, sealedEntries),
    )
    assertFrameFits(payload)
    return { payload, epoch }
  }

  const outcomeWaiters = new Map<
    string,
    Set<{ resolve: (outcome: Outcome) => void; reject: (error: unknown) => void }>
  >()
  const emittedOutcomes = new Map<string, string>()
  const resolveOutcomeWaiters = (outcome: Outcome): void => {
    for (const waiter of outcomeWaiters.get(outcome.opID ?? outcome.id) ?? [])
      waiter.resolve(outcome)
    outcomeWaiters.delete(outcome.opID ?? outcome.id)
  }
  const emitOutcome = (outcome: Outcome): void => {
    const fingerprint = JSON.stringify(outcome, Object.keys(outcome).sort())
    if (emittedOutcomes.get(outcome.id) === fingerprint) return
    emittedOutcomes.set(outcome.id, fingerprint)
    hostOutbox.push(() => {
      resolveOutcomeWaiters(outcome)
      notifyHost((value) => params.onOutcome?.(value), outcome)
    })
  }
  let slotEvidenceStamp: string | null = null
  const refreshControl = async (freshEvidence?: ControlEvidenceSnapshot): Promise<void> => {
    if (control == null) return
    const snapshot = await control.load()
    // Adoption can commit before anchor repair throws and skips the runner's notification.
    for (const outcome of snapshot.outcomes) emitOutcome(outcome)
    for (const id of emittedOutcomes.keys()) {
      if (!snapshot.outcomes.some((outcome) => outcome.id === id)) emittedOutcomes.delete(id)
    }
    if (!hardControlHeld()) controlHold = snapshot.controlHold
    if (controlHold !== null && controlHold.reason !== 'acceptance-unknown') {
      stranded = true
      healRequested = false
    }
    const currentEpoch = await mls?.readEpoch()
    if (snapshot.commitOnce === null || hardControlHeld()) {
      unresolvedControlSlot = false
      slotEvidenceStamp = null
      cancelControlSlotRetry()
    } else if (params.readEvidence !== undefined) {
      const slot = snapshot.commitOnce
      const row = snapshot.applied.find((row) => row.epoch === slot.epoch)
      const stamp = JSON.stringify([
        slot.incarnation,
        slot.epoch,
        slot.publishID,
        slot.payloadDigest,
        currentEpoch,
        snapshot.cursor?.epoch,
        row?.payloadDigest,
        row?.removed,
      ])
      if (freshEvidence !== undefined || stamp !== slotEvidenceStamp) {
        unresolvedControlSlot = true
        try {
          const evidence = freshEvidence ?? (await params.readEvidence())
          unresolvedControlSlot = hasUnresolvedControlSlot(snapshot, evidence)
          slotEvidenceStamp = stamp
          if (!unresolvedControlSlot) cancelControlSlotRetry()
        } catch {
          // A transient read cannot undo a committed ack or prove slot settlement.
        }
      }
    }
    operationDeadline = snapshot.operations[0]?.deadline ?? null
    hasOperations = snapshot.operations.length > 0
    revokeHold = revokeHeld(snapshot)
    rejoinHeld = snapshot.rejoin != null
    rejoinPosition = rejoinBarrier(snapshot.rejoin)
    refusalHeld = snapshot.rejoin?.stage === 'refused'
    if (snapshot.rejoin?.stage === 'adopted' && awaitingBootstrap == null) {
      awaitingBootstrap = {
        attemptID: snapshot.rejoin.id,
        trigger: 'automatic',
        entries: snapshot.rejoin.ledgerBefore,
      }
      rejoinRuntimeNeedsBuild = true
    }
    appliedByEpoch.clear()
    for (const [epoch, row] of appliedRows(snapshot)) appliedByEpoch.set(epoch, row)
    commitOutcomes.clear()
    for (const response of snapshot.responses) commitOutcomes.set(response.position, response)
    const cursor = snapshot.cursor
    durableCursor = cursor
    durableStrand = snapshot.strand
    if (cursor != null && cursor.epoch === currentEpoch) {
      if (cursor.position != null && (reconciledHead == null || reconciledHead < cursor.position))
        reconciledHead = cursor.position
      floor = { epoch: cursor.epoch, position: cursor.position, covered: true }
      if (cursor.stranded) {
        if (!stranded && !hardControlHeld()) healRequested = true
        stranded = true
      }
    }
  }

  const unknownChanges = (snapshot: ControlSnapshot) => {
    const outcomes: Array<Outcome> = snapshot.operations.map((op) => ({
      id: op.id,
      opID: op.id,
      at: Date.now(),
      kind: 'unknown',
    }))
    if (snapshot.rejoin != null)
      outcomes.push({
        id: snapshot.rejoin.id,
        opID: null,
        at: Date.now(),
        kind: 'unknown',
      })
    return {
      deleteOperations: snapshot.operations.map((op) => op.id),
      ...(snapshot.rejoin == null ? {} : { deleteRejoin: true as const }),
      putOutcomes: outcomes,
    }
  }

  const removalEffect = async (): Promise<void> => {
    if (control == null) return
    const snapshot = await control.load()
    if (!(await params.readEvidence?.())?.terminal) return
    if (snapshot.operations.length > 0 || snapshot.rejoin != null) {
      const changes = unknownChanges(snapshot)
      await applyResolved(control, changes, newPublishID())
      for (const outcome of changes.putOutcomes) emitOutcome(outcome)
      await refreshControl()
    }
    if (!locallyRemoved) {
      locallyRemoved = true
      logDelivery?.removed()
    }
  }

  const adoptionWrite = (input: {
    snapshot: ControlSnapshot
    epoch: number
    digest: string
    payloadDigest: string
    position: LogPosition
    external: boolean
  }): AdoptionWriteFactory => {
    const { snapshot, epoch, digest, payloadDigest, position, external } = input
    const owningSlot = snapshot.commitOnce
    const clearsSlot = owningSlot !== null && owningSlot.epoch === epoch
    const matches = snapshot.operations.filter(
      (op) =>
        op.stage === 'accepted' &&
        op.built.payloadDigest === payloadDigest &&
        owningSlot?.opID === op.id &&
        owningSlot.payloadDigest === payloadDigest,
    )
    const mutationID = newPublishID()
    return (staged) => ({
      mutationID,
      ...(!staged.removed ? { anchorLanded: digest } : {}),
      changes: {
        ...pruneWindow(snapshot, epoch),
        ...(clearsSlot && staged.epochAfter > epoch ? { commitOnce: null } : {}),
        // Removal must retain a proven loser before terminal settlement marks other work unknown.
        ...(staged.removed &&
        clearsSlot &&
        owningSlot.payloadDigest !== payloadDigest &&
        snapshot.operations.some((op) => op.id === owningSlot.opID)
          ? {
              deleteOperations: [owningSlot.opID],
              putOutcomes: [
                {
                  id: owningSlot.opID,
                  opID: owningSlot.opID,
                  at: Date.now(),
                  kind: 'lost' as const,
                },
              ],
            }
          : {}),
        ...(controlHold?.reason === 'acceptance-unknown' && staged.epochAfter > epoch
          ? { controlHold: null }
          : {}),
        ...(clearsSlot &&
        owningSlot.payloadDigest !== payloadDigest &&
        snapshot.welcomes.some((row) => row.opID === owningSlot.opID && !row.committed)
          ? { deleteWelcomes: [owningSlot.opID] }
          : {}),
        putApplied: [
          {
            epoch,
            digest,
            payloadDigest,
            sequenceID: position,
            opID: matches[0]?.id ?? null,
            removed: staged.removed,
          },
        ],
        ...(!stranded ? { strand: null } : {}),
        cursor: {
          position: stranded
            ? (snapshot.cursor?.position ?? null)
            : snapshot.cursor?.position != null && snapshot.cursor.position > position
              ? snapshot.cursor.position
              : position,
          epoch: staged.epochAfter,
          ...(stranded
            ? {
                stranded: true,
                ...(snapshot.cursor?.fork == null ? {} : { fork: snapshot.cursor.fork }),
              }
            : {}),
        },
        ...(matches.length === 0
          ? {}
          : {
              deleteOperations: matches.map((op) => op.id),
              putOutcomes: matches.map(
                (op): Outcome => ({
                  id: op.id,
                  opID: op.id,
                  at: Date.now(),
                  kind: 'landed',
                  position,
                }),
              ),
            }),
        ...(external
          ? {
              putResponses: [
                {
                  position,
                  digest,
                  epoch,
                  kind: 'applied' as const,
                  epochAfter: staged.epochAfter,
                },
              ],
            }
          : {}),
      },
    })
  }
  let welcomeTimer: ReturnType<typeof setTimeout> | undefined
  let welcomeBackoff = 1000
  let checkedWelcome: {
    publishID: string
    proof: NonNullable<ControlSnapshot['commitOnceAcceptance']>
  } | null = null
  const deliverPendingWelcomes = async (): Promise<void> => {
    if (disposed || control == null || deliverWelcome == null) return
    if (welcomeTimer != null) clearTimeout(welcomeTimer)
    welcomeTimer = undefined
    try {
      const checked = checkedWelcome
      checkedWelcome = null
      const snapshot = await control.load()
      if (snapshot.welcomes.length === 0) return
      let accepted: Promise<boolean> | undefined
      await deliverObligations(
        {
          control,
          signal: controlAbort.signal,
          canDeliver: async (obligation) => {
            if (obligation.committed) return true
            const slot = snapshot.commitOnce
            if (
              hardControlHeld() ||
              (snapshot.controlHold !== null &&
                snapshot.controlHold.reason !== 'acceptance-unknown') ||
              slot?.opID !== obligation.opID ||
              snapshot.commitOnceAcceptance === null ||
              controlSearch === null
            )
              return false
            const acceptance = snapshot.commitOnceAcceptance
            const matches = (proof: NonNullable<ControlSnapshot['commitOnceAcceptance']>) =>
              proof.payloadDigest === slot.payloadDigest &&
              proof.from === acceptance.from &&
              proof.position === acceptance.position
            if (checked?.publishID === slot.publishID && matches(checked.proof)) return true
            accepted ??= controlSearch
              .searchLog(slot)
              .then((result) => result.kind === 'first-valid' && matches(result.proof))
            return accepted
          },
          deliverWelcome: async (obligation) => {
            assertLive()
            await deliverWelcome(obligation)
            // Disposal after transport acceptance leaves the obligation for the next owner.
            assertLive()
          },
        },
        snapshot,
      )
      welcomeBackoff = 1000
    } catch {
      if (disposed) return
      welcomeTimer = setTimeout(() => {
        welcomeTimer = undefined
        void runSerial(deliverPendingWelcomes).catch(() => {})
      }, welcomeBackoff)
      welcomeBackoff = Math.min(welcomeBackoff * 2, 15_000)
    }
  }

  const holdControl = async (value: ControlHold): Promise<void> => {
    if (control == null) return
    // First hard hold wins, including in memory when persistence fails.
    if (hardControlHeld()) return
    controlHold = value
    const hard = value.reason !== 'acceptance-unknown'
    if (hard) {
      stranded = true
      healRequested = false
    }
    const snapshot = await control.load()
    await applyResolved(
      control,
      {
        controlHold: value,
        ...(hard
          ? {
              strand: {
                reason:
                  value.reason === 'unsupported-version' ? 'unsupported-version' : 'lost-state',
              },
              cursor: {
                position: snapshot.cursor?.position ?? null,
                epoch: (await mls?.readEpoch()) ?? crypto.epoch(),
                stranded: true,
                ...(snapshot.cursor?.fork == null ? {} : { fork: snapshot.cursor.fork }),
              },
            }
          : {}),
      },
      newPublishID(),
    )
  }
  const controlSearch =
    control == null || mls == null || validation == null
      ? null
      : createControlSearch({
          budget: CONTROL_SEARCH_BUDGET,
          validation,
          readEvidence: params.readEvidence,
          fetch: async (after) => {
            assertLive()
            if (commitTopicID == null) throw new Error('Missing commit topic')
            return checkedFetchResult(
              await mux.fetchTopic({
                topicID: commitTopicID,
                ...(after === null ? {} : { after }),
                limit: COMMIT_FETCH_LIMIT,
              }),
            )
          },
          hold: holdControl,
          followWinner: async (frame, range, work) => {
            if (commitTopicID == null) return { kind: 'unavailable' }
            await walkCommits(mls, commitTopicID, { through: frame.position, range, work })
            const row = (await params.readEvidence()).applied.find(
              (row) => row.epoch === range.source.epoch,
            )
            return row?.sequenceID === frame.position &&
              row.payloadDigest === range.winner.payloadDigest
              ? { kind: 'applied', position: frame.position }
              : { kind: 'unavailable' }
          },
          reconcileAbsent: async (through, range, work) => {
            if (commitTopicID == null) return false
            if (through === null) {
              commitLogHead = null
              return true
            }
            await walkCommits(mls, commitTopicID, { through, range, work })
            const reconciled =
              reconciledHead !== null &&
              reconciledHead >= through &&
              controlHold?.reason !== 'fork-evidence'
            // An already covered suffix makes the bounded walk return without fetching its head.
            if (reconciled) commitLogHead = through
            return reconciled
          },
        })

  const searchControlLog: OperationDeps['searchLog'] = async (built, position) => {
    checkedWelcome = null
    if (controlSearch === null) return { kind: 'unknown' }
    const result = await controlSearch.searchLog(built, position)
    if (result.kind === 'first-valid')
      checkedWelcome = { publishID: built.publishID, proof: result.proof }
    return result
  }

  const operationDeps = (): OperationDeps => {
    if (
      control == null ||
      prepareBuild == null ||
      adopt == null ||
      mls == null ||
      controlSearch == null
    )
      throw new Error('commit: this peer has no MLS ports')
    const port = mls
    const topicID = commitTopicID
    return {
      control,
      signal: controlAbort.signal,
      prepareBuild,
      readEvidence: params.readEvidence,
      readHead: async () => commitLogHead,
      adopt: async (journal, expected, write) => {
        assertLive()
        const slot = (await control.load()).commitOnce
        if (slot === null) return adopt(journal, expected, write)
        const adoptionResult: { value: 'installed' | 'noop' | 'moved' } = { value: 'moved' }
        const skipped = Symbol('adoption did not install')
        try {
          await advanceHandle({
            port,
            identity: { epochAfter: slot.epoch + 1, forced: false, advance: slot.digest },
            floorPosition: expected.acceptance.position,
            ratchet: async () => {
              assertLive()
              adoptionResult.value = await adopt(journal, expected, {
                ...write,
                anchorLanded: slot.digest,
              })
              if (adoptionResult.value !== 'installed') throw skipped
            },
          })
        } catch (error) {
          if (error !== skipped) throw error
        }
        if (adoptionResult.value === 'installed') {
          reconciledHead = expected.acceptance.position
          commitLogHead = expected.acceptance.position
        }
        return adoptionResult.value
      },
      frame: async (built, seal) => {
        assertLive()
        const { payload } = await frameCommit(built.commit, built.bodies, built.epoch, seal)
        return { payload, publishID: newPublishID(), expectedHead: commitLogHead }
      },
      publish: async (payload, publishID, expectedHead) => {
        assertLive()
        if (revokeHold) await settleLogSubmissions()
        assertLive()
        const snapshot = await control.load()
        const operation = snapshot.operations[0]
        if (operation == null || Date.now() >= operation.deadline || snapshot.controlHold !== null)
          throw new RecoveryRequiredError('Control publication is held or expired')
        const slot = snapshot.commitOnce
        const evidence = await params.readEvidence()
        const identity = evidence.source.identity
        if (
          slot === null ||
          slot.opID !== operation.id ||
          slot.publishID !== publishID ||
          evidence.terminal ||
          identity === null ||
          evidence.source.key.groupID !== control.key.groupID ||
          evidence.source.key.incarnation !== slot.incarnation ||
          identity.epoch !== slot.epoch ||
          identity.authenticator.length !== slot.authenticatorBefore.length ||
          identity.authenticator.some((byte, index) => byte !== slot.authenticatorBefore[index]) ||
          Date.now() >= operation.deadline ||
          topicID == null
        )
          throw new RecoveryRequiredError('Control source moved before publication')
        return mux.publish({ topicID, payload, publishID, expectedHead, retain: 'log' })
      },
      publishFailed: (opID, error) => {
        hostOutbox.push(() =>
          notifyHost((notice) => params.onControlPublishError?.(notice), { opID, error }),
        )
      },
      searchLog: searchControlLog,
      pullToHead: async () => {
        controlReplayed = true
        await settleRetainedControlSlot()
        if (controlHold !== null) return
        if (!(await ensureLedger(Date.now() + recoveryTimeoutMs)))
          throw new RecoveryRequiredError('commit: the ledger is incomplete')
        await finalizeBootstrap(port)
        await reconcileCommits()
        assertLive()
        if (stranded || anchorRecoveryPending || rejoinHeld || activeRecovery != null)
          throw new RecoveryRequiredError('commit: group control requires recovery')
      },
      now: Date.now,
      operationTimeoutMs,
      newID: newPublishID,
      emit: emitOutcome,
    }
  }
  const settleRetainedControlSlot = async (
    occurrence?: Parameters<typeof settleControlSlot>[1],
  ) => {
    if (control === undefined || controlSearch === null || params.readEvidence === undefined)
      return 'empty' as const
    if (controlHold !== null && controlHold.reason !== 'acceptance-unknown')
      return 'unknown' as const
    const deps = operationDeps()
    let freshEvidence: ControlEvidenceSnapshot | undefined
    const result = await settleControlSlot(
      {
        control,
        signal: controlAbort.signal,
        search: { searchLog: searchControlLog },
        adoption: { adopt: deps.adopt },
        readEvidence: async () => {
          freshEvidence = await params.readEvidence()
          return freshEvidence
        },
        now: Date.now,
        newID: newPublishID,
        emit: emitOutcome,
      },
      occurrence,
    )
    // Reuse the driver read so same-epoch retirement cancels retries without another host read.
    await refreshControl(freshEvidence)
    return result
  }

  function hasUnresolvedControlSlot(
    snapshot: ControlSnapshot,
    evidence: ControlEvidenceSnapshot,
  ): boolean {
    const slot = snapshot.commitOnce
    if (
      hardControlHeld() ||
      (snapshot.controlHold !== null && snapshot.controlHold.reason !== 'acceptance-unknown')
    )
      return false
    if (slot === null || evidence.terminal || evidence.source.identity === null) return false
    const identity = evidence.source.identity
    if (
      evidence.applied.some(
        (row) =>
          row.epoch === slot.epoch &&
          row.payloadDigest === slot.payloadDigest &&
          row.digest === slot.digest,
      )
    )
      return false
    return (
      evidence.source.key.groupID === control?.key.groupID &&
      evidence.source.key.incarnation === slot.incarnation &&
      identity.incarnation === slot.incarnation &&
      identity.epoch <= slot.epoch
    )
  }
  let controlSlotTimer: ReturnType<typeof setTimeout> | undefined
  let controlSlotRunning = false
  let controlSlotWake = false
  let controlSlotBackoff = 1_000
  function cancelControlSlotRetry(): void {
    if (controlSlotTimer !== undefined) clearTimeout(controlSlotTimer)
    controlSlotTimer = undefined
    controlSlotWake = false
    controlSlotBackoff = 1_000
  }
  function scheduleControlSlotRetry(delay = controlSlotBackoff): void {
    if (disposed || hardControlHeld() || !unresolvedControlSlot) return
    if (delay === 0) {
      controlSlotBackoff = 1_000
      if (controlSlotTimer !== undefined) clearTimeout(controlSlotTimer)
      controlSlotTimer = undefined
      if (controlSlotRunning) {
        controlSlotWake = true
        return
      }
    }
    if (controlSlotTimer !== undefined || controlSlotRunning) return
    controlSlotTimer = setTimeout(() => {
      controlSlotTimer = undefined
      controlSlotRunning = true
      void (async () => {
        try {
          await ready
          if (disposed) return
          await runSerial(async () => {
            await settleRetainedControlSlot()
            if (epochNeedsBuild) await rebuildEpoch()
            await deliverPendingWelcomes()
          })
        } catch {
          // A failed evidence read cannot prove the retained slot settled.
        } finally {
          controlSlotRunning = false
          if (!disposed && unresolvedControlSlot) {
            if (controlSlotWake) {
              controlSlotWake = false
              scheduleControlSlotRetry(0)
            } else {
              if (delay !== 0) controlSlotBackoff = Math.min(controlSlotBackoff * 2, 15_000)
              scheduleControlSlotRetry()
            }
          }
        }
      })().catch(() => {})
    }, delay)
  }

  /** Saved payloads settle before any pull can encounter our own unmerged commit. */
  const settleOperations = async (forRecovery = false): Promise<boolean> => {
    controlReplayed = true
    if (
      control == null ||
      mls == null ||
      commitTopicID == null ||
      (anchorRecoveryPending && !forRecovery) ||
      locallyRemoved ||
      rejoinHeld
    )
      return false
    const before = await mls.readEpoch()
    await refreshControl()
    await settleRetainedControlSlot()
    let op = (await control.load()).operations[0]
    while (!disposed && op != null && op.stage !== 'intent') {
      const next = await stepOperation(operationDeps(), op)
      await deliverPendingWelcomes()
      await refreshControl()
      if (next === op) {
        break
      }
      op = next ?? undefined
    }
    return (await mls.readEpoch()) !== before
  }

  const settleRejoinPublication = async (): Promise<void> => {
    if (control == null || mls == null || commitTopicID == null || controlHold !== null) return
    const record = (await control.load()).rejoin
    if (record?.stage !== 'built') return
    await stepRejoin(rejoinDeps(Date.now() + recoveryDeadlineMs), record)
    await refreshControl()
  }

  let operationTimer: ReturnType<typeof setTimeout> | undefined
  let operationRunning = false
  let operationBackoff = 1000
  const scheduleOperations = (delay = 0): void => {
    if (
      disposed ||
      locallyRemoved ||
      control == null ||
      !hasOperations ||
      rejoinHeld ||
      operationTimer != null ||
      operationRunning
    )
      return
    const start = (): void => {
      operationTimer = undefined
      operationRunning = true
      void (async () => {
        let retry = false
        try {
          await ready
          assertLive()
          if (activeRecovery != null) await activeRecovery
          await runSerial(async () => {
            if (rejoinHeld) return
            let op = (await control.load()).operations[0]
            if (op == null) return
            const before = await mls?.readEpoch()
            controlReplayed = true
            for (let attempt = 0; op != null && attempt < COMMIT_ATTEMPT_CEILING; attempt++) {
              assertLive()
              const next = await stepOperation(operationDeps(), op)
              await deliverPendingWelcomes()
              await refreshControl()
              if (next === op) {
                retry = true
                break
              }
              op = next ?? undefined
            }
            if (op != null) retry = true
            if (!disposed && (await mls?.readEpoch()) !== before) await rebuildEpoch()
          })
          if (!retry) operationBackoff = 1000
        } catch {
          retry = true
        } finally {
          operationRunning = false
          if (!disposed) {
            try {
              await runSerial(refreshControl)
            } catch {
              retry = true
            }
            if (hasOperations) {
              scheduleOperations(retry ? operationBackoff : 0)
              if (retry) operationBackoff = Math.min(operationBackoff * 2, 15_000)
            }
          }
          scheduleControlSlotRetry()
          void healIfRequested()
        }
      })().catch(() => {})
    }
    if (delay === 0) start()
    else
      operationTimer = setTimeout(
        start,
        Math.min(delay, Math.max(0, (operationDeadline ?? Number.POSITIVE_INFINITY) - Date.now())),
      )
  }

  const repairRejoin = async (): Promise<void> => {
    if (disposed || awaitingBootstrap == null) return
    // Restore the subscription before gathering the ledger: responders may already have
    // rotated to the new app anchor. A failed repair remains pending for the next lane call.
    if (mls != null) await resolveAnchorRotation({ port: mls })
    if (disposed) return
    if (rejoinRuntimeNeedsBuild) {
      await rebuildEpoch()
      if (disposed) return
      rejoinRuntimeNeedsBuild = false
    }
  }

  const finalizeBootstrap = async (port: GroupMLS, announce = true): Promise<void> => {
    assertLive()
    if (awaitingBootstrap == null) return
    const { attemptID, trigger, entries } = awaitingBootstrap
    await repairRejoin()
    assertLive()
    const held = new Set(await port.getLedger())
    assertLive()
    const owed = entries.filter((token) => !held.has(token))
    const record = (await control?.load())?.rejoin
    if (record?.stage === 'adopted') {
      const deps = rejoinDeps(Date.now() + recoveryTimeoutMs)
      await stepRejoin({ ...deps, bootstrapLedger: async () => true }, record)
      await refreshControl()
      stranded = false
      healRequested = false
    }
    if (owed.length > 0) pendingReenact = [...pendingReenact, ...owed]
    awaitingBootstrap = null
    inFlightEntries = null
    if (bootstrapHealRequested) {
      healRequested = false
      bootstrapHealRequested = false
    }
    recoveryGeneration += 1
    closeEpisode()
    // As on a rejoin that bootstraps at once: frames sent before the subscription woke nothing.
    requestAppPull()
    if (announce && commitTopicID != null) {
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
    const { request, requestKey } = await port.createRecoveryRequest(
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
            const tokens = await port.openSealedLedger(sealed, requestID, requestKey)
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

  const enqueue = async (request: OperationRequest): Promise<void> => {
    await ready
    assertLive()
    try {
      await runSerial(async () => {
        assertLive()
        if (locallyRemoved) throw new PeerRemovedError('Peer was removed')
        // A host write may persist the intent before its promise settles.
        if (request.revokes) revokeHold = true
        try {
          if (control == null || prepareBuild == null || adopt == null || mls == null)
            throw new Error('commit: this peer has no MLS ports')
          await enqueueOperation(
            {
              control,
              signal: controlAbort.signal,
              now: Date.now,
              operationTimeoutMs: params.operationTimeoutMs,
              newID: newPublishID,
            },
            request,
          )
        } finally {
          try {
            await refreshControl()
          } catch {
            // A failed read cannot unschedule an intent that may already be durable.
            hasOperations = true
          }
        }
      })
    } finally {
      scheduleOperations()
    }
  }
  const outcomes = async (): Promise<Array<Outcome>> => {
    await ready
    assertLive()
    return control == null ? [] : (await control.load()).outcomes
  }
  const ack = async (id: string): Promise<void> => {
    await ready
    assertLive()
    await runSerial(async () => {
      if (control != null) await applyResolved(control, { deleteOutcomes: [id] }, newPublishID())
      emittedOutcomes.delete(id)
      await refreshControl()
    })
    scheduleControlSlotRetry(0)
  }
  const abandon = async (): Promise<void> => {
    await ready
    assertLive()
    await runSerial(async () => {
      if (control == null) return
      const snapshot = await control.load()
      const changes = {
        ...unknownChanges(snapshot),
      }
      await applyResolved(control, changes, newPublishID())
      await refreshControl()
      pendingRecovery = null
      awaitingBootstrap = null
      inFlightEntries = null
      healRequested = false
      clearRecoveryRetry()
      recoveryGeneration += 1
      for (const outcome of changes.putOutcomes) emitOutcome(outcome)
    })
    scheduleControlSlotRetry(0)
  }
  const commit = async (request: OperationRequest): Promise<{ position: LogPosition }> => {
    let resolve!: (outcome: Outcome) => void
    let reject!: (error: unknown) => void
    const waiting = new Promise<Outcome>((yes, no) => {
      resolve = yes
      reject = no
    })
    // Disposal can reject this while enqueue is still in a host call.
    void waiting.catch(() => {})
    const waiter = { resolve, reject }
    const listeners = outcomeWaiters.get(request.id) ?? new Set()
    listeners.add(waiter)
    outcomeWaiters.set(request.id, listeners)
    try {
      await enqueue(request)
      const outcome = await waiting
      if (outcome.kind !== 'landed') throw new OperationOutcomeError({ outcome })
      return { position: outcome.position }
    } finally {
      listeners.delete(waiter)
      if (listeners.size === 0) outcomeWaiters.delete(request.id)
    }
  }
  const replay = async (): Promise<{ reenact?: Array<string> }> => {
    await ready
    assertLive()
    if (locallyRemoved) return {}
    await runSerial(async () => {
      await refreshControl()
      if (hardControlHeld()) return
      const record = (await control?.load())?.rejoin
      if (record?.stage === 'confirmed' && activeRecovery == null) {
        await stepRejoin(rejoinDeps(Date.now() + recoveryDeadlineMs), record)
        await refreshControl()
      }
    })
    const result = await runSerial(async () => {
      if (await settleOperations()) await rebuildEpoch()
      if (mls != null && (await ensureLedger(Date.now() + recoveryTimeoutMs)))
        await finalizeBootstrap(mls)
      assertLive()
      const reenact = pendingReenact
      pendingReenact = []
      return reenact.length === 0 ? {} : { reenact }
    })
    if (operationTimer != null) clearTimeout(operationTimer)
    operationTimer = undefined
    scheduleOperations()
    return result
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
  const scanRejoinSource = async (record: RejoinRecord): Promise<SourceScan> => {
    if (mls == null || control == null || commitTopicID == null)
      throw new Error('Missing recovery ports')
    const current = await mls.readRecoverySource()
    const responses = (await control.load()).responses
    const frames: SourceScan['frames'] = []
    let after = record.source.head
    let gap = false
    for (;;) {
      assertLive()
      const page = checkedFetchResult(
        await mux.fetchTopic({
          topicID: commitTopicID,
          ...(after == null ? {} : { after }),
          limit: COMMIT_FETCH_LIMIT,
        }),
      )
      gap ||= page.gap
      for (const row of page.messages) {
        const position = asLogPosition(row.sequenceID)
        if (record.position != null && position >= record.position) return { current, gap, frames }
        if (after != null && position <= after) continue
        let commit: Uint8Array | null = null
        try {
          const handshake = decodeHandshakeFrame(row.payload)
          if (handshake.kind === HANDSHAKE_KIND.commit) {
            const frame = decodeCommitFrame(handshake.payload)
            commit = frame.commit
          }
        } catch {
          /* Unparseable frames cannot move the source. */
        }
        const header = commit == null ? null : await mls.readCommitHeader(commit)
        const digest = commit == null ? null : digestAppliedCommit(commit)
        frames.push({
          position,
          header,
          digest,
          responded: responses.some(
            (response) => response.position === position && response.digest === digest,
          ),
        })
      }
      if (page.messages.length < COMMIT_FETCH_LIMIT) return { current, gap, frames }
      assertForwardPage(after, page.messages)
      const last = page.messages.at(-1)
      if (last == null) return { current, gap, frames }
      after = asLogPosition(last.sequenceID)
    }
  }

  const recoveryCandidate = async (record: RejoinRecord): Promise<PendingRecovery> => {
    if (pendingRecovery?.commitDigest === record.digest) return pendingRecovery.pending
    if (mls == null) throw new Error('Missing recovery port')
    return wrapPendingRecovery(
      boundary,
      await mls.restoreRecovery(record.candidate, record.requestKey),
    )
  }

  let currentRecoveryAttemptID: string | null = null
  let currentRecoveryTrigger: RecoveryTrigger = 'automatic'
  let rejoinDiscarded: Parameters<RejoinDeps['discarded']>[0] | null = null
  let rejoinFailureDetails: RecoveryFailureDetails = {}
  const rejoinDeps = (deadline: number): RejoinDeps => {
    if (control == null || mls == null || commitTopicID == null || rendezvousTopicID == null)
      throw new Error('Missing recovery ports')
    const port = mls
    const commits = commitTopicID
    const rendezvous = rendezvousTopicID
    return {
      control,
      signal: controlAbort.signal,
      runSerial,
      now: Date.now,
      newID: newPublishID,
      emit: emitOutcome,
      discarded: (reason, record, blockingPosition) => {
        inFlightEntries = record.ledgerBefore
        rejoinDiscarded = reason
        pendingRecovery = null
        if (reason === 'absent' || reason === 'gap') healRequested = true
        if (reason === 'invalidated') {
          rejoinFailureDetails = {
            advisory: [],
            blockingPosition: blockingPosition ?? null,
            anchorRecovery: anchorRecoveryPending,
          }
          healRequested = stranded || anchorRecoveryPending || !floor.covered
        }
      },
      publish: async (payload, publishID, expectedHead) => {
        assertLive()
        await refreshControl()
        assertLive()
        if (hardControlHeld()) throw new RecoveryRequiredError('Recovery publication is held')
        const result = await mux.publish({
          topicID: commits,
          payload,
          publishID,
          expectedHead,
          retain: 'log',
        })
        assertLive()
        return result
      },
      searchLog: (from, digest) =>
        searchOccurrence(
          async (after) => {
            assertLive()
            return checkedFetchResult(
              await mux.fetchTopic({
                topicID: commits,
                ...(after === null ? {} : { after }),
                limit: COMMIT_FETCH_LIMIT,
              }),
            )
          },
          from,
          digest,
        ),
      confirm: async (record) => {
        const position = record.position
        if (position == null) throw new Error('Published rejoin has no position')
        const pending = await recoveryCandidate(record)
        pendingRecovery = { position, commitDigest: record.digest, pending }
        const key = await pending.confirmationKey(position, record.digest)
        const verified = await port.verifyRecoveryRequest(record.request)
        if (verified == null) throw new Error('The recovery request did not verify')
        const verdict = await waitForRecoveryConfirmation({
          port,
          pending,
          groupID: verified.groupID,
          requestID: record.requestID,
          requestKey: record.requestKey,
          position,
          commitDigest: record.digest,
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
                  requestID: record.requestID,
                  request: record.request,
                  position,
                  commitDigest: record.digest,
                }),
              ),
            }),
        })
        assertLive()
        if (verdict.kind === 'refused' && ['binding', 'lapse', 'floor'].includes(verdict.refusal))
          pending.markBindingUnusable()
        rejoinFailureDetails =
          verdict.kind === 'refused'
            ? { refusal: verdict.refusal, responder: verdict.responder }
            : verdict.kind === 'unconfirmed'
              ? { advisory: verdict.advisory }
              : {}
        return verdict
      },
      scan: scanRejoinSource,
      canAdopt: async () => {
        await refreshControl()
        return !hardControlHeld()
      },
      adopt: async (record, write) => {
        await refreshControl()
        if (hardControlHeld()) throw new RecoveryRequiredError('Recovery adoption is held')
        const pending = await recoveryCandidate(record)
        try {
          await advanceHandle({
            port,
            ratchet: async () => {
              await refreshControl()
              if (hardControlHeld()) throw new RecoveryRequiredError('Recovery adoption is held')
              await pending.onAccepted(write)
            },
            identity: {
              epochAfter: record.epochAfter,
              forced: true,
              advance: record.digest,
              recovery: true,
            },
            floorPosition: record.position,
          })
        } finally {
          const saved = (await control.load()).rejoin
          if (saved?.stage === 'adopted') {
            awaitingBootstrap = {
              attemptID: currentRecoveryAttemptID ?? record.id,
              trigger: currentRecoveryTrigger,
              entries: record.ledgerBefore,
            }
            rejoinRuntimeNeedsBuild = true
          }
        }
        assertLive()
        await refreshControl()
        reconciledHead = record.position ?? reconciledHead
        commitLogHead = record.position ?? commitLogHead
        healRequested = false
        pendingRecovery = null
        await rebuildEpoch()
        rejoinRuntimeNeedsBuild = false
      },
      bootstrapLedger: () => ensureLedger(deadline),
      getLedger: () => port.getLedger(),
    }
  }

  const attemptBody = async (
    trigger: RecoveryTrigger,
    generation: number,
    port: GroupMLS,
    commits: string,
    rendezvous: string,
  ): Promise<{ advanced: boolean }> => {
    assertLive()
    currentRecoveryTrigger = trigger
    const controlStore = control
    if (controlStore == null) throw new Error('Missing control store')
    const attemptID =
      awaitingBootstrap?.attemptID ?? (await controlStore.load()).rejoin?.id ?? newPublishID()
    currentRecoveryAttemptID = attemptID
    const base = { groupID: commits, attemptID, trigger }
    const failed = (
      reason: RecoveryFailureReason,
      details: RecoveryFailureDetails = {},
      retry = true,
    ): { advanced: false } => {
      if (reason === 'renewal-required') renewalRequiredEpoch = crypto.epoch()
      if (reason === 'renewal-required' || reason === 'refused') clearRecoveryRetry()
      if (
        retry &&
        (reason === 'unconfirmed' ||
          reason === 'invalidated' ||
          reason === 'no-responder' ||
          reason === 'deadline' ||
          reason === 'error' ||
          reason === 'bootstrap-failed')
      )
        retryRecovery()
      emitRecovery({ ...base, phase: 'failed', reason, ...details })
      return { advanced: false }
    }
    try {
      const started = await runSerial(async () => {
        if (recoveryGeneration !== generation && !stranded && !healRequested && !rejoinHeld)
          return false
        queueMicrotask(() =>
          notifyHost<RecoveryEvent>((value) => params.onRecovery?.(value), {
            ...base,
            phase: 'started',
          }),
        )
        if (await settleOperations(true)) await rebuildEpoch()
        if ((await controlStore.load()).rejoin == null) {
          if (await ensureLedger(Date.now() + recoveryTimeoutMs)) await finalizeBootstrap(port)
          assertLive()
        }
        return true
      })
      if (!started) return { advanced: true }
      const deadline = Date.now() + recoveryDeadlineMs
      let prepared = false
      while (Date.now() < deadline) {
        if (recoveryGeneration !== generation) return { advanced: false }
        let record = (await controlStore.load()).rejoin
        if (record?.stage === 'refused') return failed('refused', { refusal: record.refusal })
        if (record == null) {
          const built = await runSerial(async () => {
            if (await settleOperations(true)) await rebuildEpoch()
            if (!anchorRecoveryPending) {
              healRequested = false
              await reconcileCommits()
            }
            assertLive()
            const expectedHead = await readCommitHead(commits)
            if (!prepared) {
              prepared = true
              if ((await port.prepareRecovery()) === 'renewal-required')
                return failed('renewal-required')
            }
            const requestID = newPublishID()
            const { request, requestKey } = await port.createRecoveryRequest(
              requestID,
              Math.max(0, deadline - Date.now()),
            )
            const outcome = await requestGroupInfo(request, requestID, rendezvous, deadline)
            assertLive()
            if (outcome.kind === 'disposed') throw new PeerDisposedError('Peer is disposed')
            if (outcome.kind === 'publish-failed') throw outcome.error
            if (outcome.kind === 'timeout')
              return failed(outcome.atDeadline ? 'deadline' : 'no-responder')
            await reconcileCommits()
            let pending: AppliedRecovery
            try {
              pending = await port.applyRecovery(outcome.sealed, requestID, requestKey)
            } catch {
              pending = null
            }
            assertLive()
            if (pending == null) return null
            if ('renewalRequired' in pending) return failed('renewal-required')
            pending = wrapPendingRecovery(boundary, pending)
            const source = await port.readRecoverySource()
            const ledgerBefore = [
              ...new Set([
                ...(inFlightEntries ?? awaitingBootstrap?.entries ?? []),
                ...(await port.getLedger()),
                ...(anchorRecoveryPending
                  ? ((await controlStore.load()).commitOnce?.bodies ?? [])
                  : []),
              ]),
            ]
            const { payload } = await frameCommit(pending.commit, [], null)
            const record: RejoinRecord = {
              id: newPublishID(),
              stage: 'built',
              publishID: newPublishID(),
              expectedHead,
              payload,
              payloadDigest: toB64U(sha256(payload)),
              requestID,
              request,
              requestKey,
              candidate: pending.serialize(),
              source: { ...source, head: reconciledHead },
              digest: digestAppliedCommit(pending.commit),
              epochAfter: pending.epoch,
              ledgerBefore,
              conflictEpoch: (await controlStore.load()).cursor?.fork?.conflictEpoch ?? null,
            }
            await applyResolved(controlStore, { putRejoin: record }, newPublishID())
            inFlightEntries = ledgerBefore
            assertLive()
            pendingRecovery = { position: '', commitDigest: record.digest, pending }
            await refreshControl()
            return record
          })
          if (built == null) continue
          if ('advanced' in built) return built
          record = built
        }
        if (record.stage === 'adopted') {
          const complete = await runSerial(async () => {
            awaitingBootstrap = { attemptID, trigger, entries: record.ledgerBefore }
            const complete = await ensureLedger(deadline)
            assertLive()
            if (!complete) return false
            await finalizeBootstrap(port, false)
            return true
          })
          if (!complete) return failed('bootstrap-failed')
          clearRecoveryRetry()
          recoveryBackoff = 1000
          emitRecovery({ ...base, phase: 'succeeded' })
          return { advanced: true }
        }
        rejoinDiscarded = null
        rejoinFailureDetails = {}
        const advanceRecord = async (): Promise<RejoinRecord | null> => {
          const current = (await controlStore.load()).rejoin
          return current?.id === record.id
            ? await stepRejoin(rejoinDeps(deadline), current)
            : current
        }
        const next =
          record.stage === 'published'
            ? await stepRejoin(rejoinDeps(deadline), record)
            : await runSerial(advanceRecord)
        assertLive()
        await runSerial(refreshControl)
        if (recoveryGeneration !== generation) return { advanced: false }
        if (next?.stage === 'adopted')
          awaitingBootstrap = { attemptID, trigger, entries: record.ledgerBefore }
        if (next?.stage === 'refused')
          return failed('refused', { refusal: next.refusal, ...rejoinFailureDetails })
        if (next == null) {
          if (rejoinDiscarded === 'renewal') {
            prepared = false
            continue
          }
          if (rejoinDiscarded === 'invalidated') {
            if (!healRequested) inFlightEntries = null
            return failed('invalidated', rejoinFailureDetails, healRequested)
          }
          if (rejoinDiscarded === 'unconfirmed') return failed('unconfirmed', rejoinFailureDetails)
        }
      }
      return failed('deadline')
    } catch (error) {
      if (disposed || error instanceof PeerDisposedError) {
        emitRecovery({ ...base, phase: 'failed', reason: 'disposed' })
        throw error instanceof PeerDisposedError ? error : new PeerDisposedError('Peer is disposed')
      }
      retryRecovery()
      emitRecovery({ ...base, phase: 'failed', reason: 'error', error })
      throw error
    }
  }

  const runRecovery = (trigger: RecoveryTrigger): Promise<{ advanced: boolean }> => {
    if (hardControlHeld() || (trigger === 'automatic' && (renewalHeld() || refusalHeld)))
      return Promise.resolve({ advanced: false })
    if (activeRecovery != null) return activeRecovery
    const generation = recoveryGeneration
    let attempt: Promise<{ advanced: boolean }> | undefined
    attempt = (async (): Promise<{ advanced: boolean }> => {
      await ready
      assertLive()
      if (locallyRemoved) throw new PeerRemovedError('Peer was removed')
      if (mls == null || commitTopicID == null || rendezvousTopicID == null) {
        return { advanced: false }
      }
      const port = mls
      const commits = commitTopicID
      const rendezvous = rendezvousTopicID
      try {
        return await attemptBody(trigger, generation, port, commits, rendezvous)
      } finally {
        pendingRecovery = null
        if (activeRecovery === attempt) activeRecovery = null
        scheduleOperations()
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
    await ready
    if (control != null && (await control.load()).rejoin?.stage === 'refused') {
      await runSerial(async () => {
        if ((await control.load()).rejoin?.stage === 'refused') {
          await applyResolved(control, { deleteRejoin: true }, newPublishID())
          await refreshControl()
        }
      })
    }
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
    if (
      disposed ||
      locallyRemoved ||
      hardControlHeld() ||
      !healRequested ||
      activeRecovery != null ||
      renewalHeld() ||
      refusalHeld
    )
      return
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
    await refreshControl()
    const stored = await anchorStore?.load()
    if (disposed) return
    if (stored != null) {
      anchor = stored.anchor
      anchorPending = stored.pending
    }
    await removalEffect()
    if (disposed || locallyRemoved) return
    if (hardControlHeld()) return
    let anchorBackoff = 100
    while (!disposed) {
      try {
        if (stored != null) {
          if (mls != null) await resolveAnchorRotation({ port: mls, initial: true })
        } else {
          await captureAnchor()
        }
        break
      } catch (error) {
        if (disposed) return
        if (!anchorSaveFailed) throw error
        // Keep the captured secret and send barrier until the idempotent save is known.
        await Promise.race([
          new Promise<void>((resolve) => {
            pendingRestoreTimer = setTimeout(resolve, anchorBackoff)
          }),
          pendingRestoreAborted,
        ])
        pendingRestoreTimer = undefined
        anchorBackoff = Math.min(anchorBackoff * 2, 15_000)
      }
    }
    if (disposed) return
    await restorePending()
    if (disposed) return
    await initControlLanes()
    if (disposed) return
    await refreshControl()
    const startupCursor = (await control?.load())?.cursor
    if (
      control != null &&
      startupCursor != null &&
      startupCursor.epoch !== (await mls?.readEpoch())
    ) {
      await applyResolved(control, { cursor: null, strand: null }, newPublishID())
      durableCursor = null
    }
    // Saved acceptances settle before the walker can meet our own unmerged commit.
    await runSerial(async () => {
      if (disposed) return
      await settleRetainedControlSlot()
      if (controlHold !== null && controlHold.reason !== 'acceptance-unknown') return
      await settleRejoinPublication()
      await settleOperations()
      if (disposed || locallyRemoved || anchorRecoveryPending) return
      const ledgerReady = await ensureLedger(Date.now() + recoveryTimeoutMs)
      if (disposed) return
      if (ledgerReady && mls != null) await finalizeBootstrap(mls)
      if (disposed) return
      await pullCommits()
    }).catch(() => {})
    if (disposed || locallyRemoved) return
    await buildEpoch()
    epochNeedsBuild = anchorPending != null
    if (disposed) return
    if (anchorRecoveryPending) return
    // The seed pull precedes the app listeners. Read once more after registration to close
    // the publication gap; a failed read is retried on the same independent schedule.
    if (crypto.pending != null) {
      try {
        await runSerial(async () => {
          if (disposed) return
          await settleOperations()
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
  // The seed pull runs inside init, where the crash victim whose operation was lost meets its own
  // un-merged commit. Its heal waits for init to finish, since every lane operation (`recover()`
  // included) waits on `ready`.
  void ready
    .then(
      async () => {
        await runSerial(deliverPendingWelcomes)
        if (disposed || locallyRemoved) return
        logDelivery?.trigger()
        if ((await control?.load())?.rejoin != null && !refusalHeld) healRequested = true
        scheduleOperations()
        scheduleControlSlotRetry()
        void healIfRequested()
      },
      () => {},
    )
    .catch(() => {})
  const withReady = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    await ready
    assertLive()
    return fn()
  }
  // Ready, and past any epoch rebuild in flight: the protocol surfaces are torn down mid-rebuild.
  const withEpoch = <T>(fn: () => T | Promise<T>): Promise<T> =>
    withReady(async () => {
      await epochSettled()
      assertLive()
      if (locallyRemoved) throw new PeerRemovedError('Peer was removed')
      if (controlHold !== null && controlHold.reason !== 'acceptance-unknown')
        throw new RecoveryRequiredError('Control is held')
      return fn()
    })
  /** {@link withEpoch}'s wait, abandoned when `signal` aborts. */
  const epochOrAbort = async (signal: AbortSignal | undefined): Promise<'ready' | 'aborted'> => {
    if (signal == null) {
      await ready
      await epochSettled()
      return 'ready'
    }
    if (signal.aborted) return 'aborted'
    const live = ready.then(() => epochSettled())
    let onAbort: (() => void) | undefined
    const aborted = new Promise<'aborted'>((resolve) => {
      onAbort = () => resolve('aborted')
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([live.then(() => 'ready' as const), aborted])
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
        return withEpoch(() => surfaceFor(key).dispatch(prc, config))
      },
      request: (prc, config) => withEpoch(() => surfaceFor(key).request(prc, config)),
      gather: async (prc, config) => {
        const outcome = await epochOrAbort(config?.signal)
        assertLive()
        if (outcome === 'aborted') return []
        return surfaceFor(key).gather(prc, config)
      },
      to: (memberDID) => withEpoch(() => surfaceFor(key).to(memberDID)),
    } as ProtocolSurface<Protocols[typeof name]>
  }

  const peer: GroupPeer<Protocols> = {
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
        await settleOperations()
        await ensureLedger(Date.now() + recoveryTimeoutMs)
        await reconcileCommits()
      })
      await healIfRequested()
      assertLive()
    },
    enqueue,
    outcomes,
    ack,
    abandon,
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
      if (locallyRemoved) throw new PeerRemovedError('Peer was removed')
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
      scheduleControlSlotRetry(0)
    },
    drained: () => {
      if (disposePromise == null)
        return Promise.reject(new Error('Call dispose() before drained()'))
      return boundary.drained(disposePromise)
    },
    dispose: () => {
      if (disposePromise != null) return disposePromise
      disposed = true
      controlAbort.abort(new PeerDisposedError('Peer is disposed'))
      if (operationTimer != null) clearTimeout(operationTimer)
      cancelControlSlotRetry()
      if (welcomeTimer != null) clearTimeout(welcomeTimer)
      for (const listeners of outcomeWaiters.values()) {
        for (const waiter of listeners) waiter.reject(new PeerDisposedError('Peer is disposed'))
      }
      outcomeWaiters.clear()
      appOutboxAcceptance?.close()
      logDelivery?.close()
      clearRecoveryRetry()
      boundary.close()
      abortPendingRestore?.()
      if (pendingRestoreTimer != null) clearTimeout(pendingRestoreTimer)
      appLane.dispose()
      if (appPullTimer != null) clearTimeout(appPullTimer)
      if (ledgerRetryTimer != null) clearTimeout(ledgerRetryTimer)
      ledgerRetryTimer = undefined
      appPullTimer = undefined
      // Synchronous and FIRST, before anything is awaited: a lane op that already passed its own
      // `assertLive` can be running inside `runSerial`, past the point this `dispose()` can reach
      // it — awaiting the commit mutex here is unsafe (`build()`/`adopt()` are host-supplied
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
        epochRuntime.releaseInboxLane()
        if (disposeErrors.length === 1) throw disposeErrors[0]
        if (disposeErrors.length > 1) throw new AggregateError(disposeErrors, 'Peer dispose failed')
      })()
      return disposePromise
    },
  }
  return {
    peer,
    controlWalk: {
      // External callers acquire the lane here. In-lane follow/reconcile call walkCommits directly.
      walkCommits: async (search) => {
        await ready
        assertLive()
        return runSerial(async () => {
          if (mls == null || commitTopicID == null) return false
          await refreshControl()
          return walkCommits(mls, commitTopicID, search)
        })
      },
      head: () => commitLogHead,
    },
  }
}
