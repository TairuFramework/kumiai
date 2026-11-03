import type { ProtocolDefinition } from '@enkaku/protocol'
import { normalizeDID } from '@kokuin/token'
import type { StoredMessage } from '@kumiai/hub-protocol'
import type { HubFetchTopicResult } from '@kumiai/hub-tunnel'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromUTF, toB64U, toUTF } from '@sozai/codec'

import type { Anchor } from './anchor.js'
import { decodeAppAAD, encodeAppAAD } from './app-aad.js'
import type { AppBatchBinding } from './app-batch.js'
import { type AppCompletionCoverage, bindAppCompletionCoverage } from './app-completion-coverage.js'
import type { AppCursorStore, AppWindowPruned } from './app-cursor.js'
import { RETAINED_EPOCHS_MAX } from './app-frame.js'
import { createMonotoneClock } from './clock.js'
import type { SafetyHold } from './control/safety.js'
import type { GroupKey } from './control/types.js'
import {
  AppFrameStorageError,
  type GroupCrypto,
  type GroupUnwrapResult,
  isAppFrameStorageError,
  isFrameAhead,
  type OpenAppInput,
  type OpenAppResult,
  type PendingAppFrame,
  type PreOpenAppFrameRef,
} from './crypto.js'
import {
  asLogPosition,
  compareLogPositions,
  InvalidLogPositionError,
  type LogPosition,
} from './cursor.js'
import { GroupSafetyHeldError, PeerDisposedError } from './errors.js'
import type { GroupTransaction, HandlerCompletion } from './handler-completion.js'
import { type BusHandlerMaps, groupHandlerMetadata } from './handlers.js'
import { notifyHost } from './host-notice.js'
import { APP_OUTSTANDING_FETCHES_MAX, AppFetchBusyError, type HubMux } from './hub-mux.js'
import { normaliseOpenedAppHandler, type OpenedAppHandler } from './opened-delivery.js'
import { retentionOf } from './protocol.js'
import { protocolTopic } from './topic.js'

export { APP_OUTSTANDING_FETCHES_MAX } from './hub-mux.js'

const APP_FETCH_LIMIT = 100
const APP_CONTINUATION_BACKOFF_MS = 100
// Retry quiet backlogs within a second while bounding pulls that only consume refused frames.
const APP_CONTINUATION_BACKOFF_MAX_MS = 1_000
export const APP_PULL_MAX_PAGES = 4
export const APP_PULL_MAX_BYTES = 4 * 1024 * 1024
export const APP_PULL_DEADLINE_MS = 10_000
export const APP_BUFFER_MAX_FRAMES = 1_000
export const APP_STAGED_MAX_FRAMES = 1_000
export const APP_PRUNED_NOTICES_MAX = 64
export const APP_FUTURE_EPOCH_WINDOW = 2
export const APP_FUTURE_HOLD_MS = 30_000

/** The position outlives sealed bytes until the cursor can pass a run of done frames. */
export type AppFrame = {
  position: LogPosition
  caughtUpAt?: number
  ref?: PreOpenAppFrameRef
  sealed:
    | { state: 'sealed'; bytes: Uint8Array }
    | { state: 'pending'; id: string }
    | { state: 'done' }
}

export type AppDeliveryStalled = {
  groupID: string
  protocol: string
  topicID: string
  position: string
  error: Error
  reason?: 'unknown-protocol' | 'future-epoch'
}

export type AppDeliveryResumed = Omit<AppDeliveryStalled, 'error'> & {
  settlement?: 'resumed' | 'expired'
}

/** A durable pending frame's id: bound to its topic and exact ciphertext. */
export function frameID(topicID: string, bytes: Uint8Array): string {
  const topic = fromUTF(topicID)
  const input = new Uint8Array(4 + topic.length + bytes.length)
  new DataView(input.buffer).setUint32(0, topic.length, false)
  input.set(topic, 4)
  input.set(bytes, 4 + topic.length)
  return toB64U(sha256(input))
}

/** Durable progress, transport paging token, and highest accepted fetched position, per topic. */
type AppCursor = {
  topicID: string
  protocol: string
  anchorEpoch: number
  position: LogPosition | null
  fetched: LogPosition | null
  accepted: LogPosition | null
}

type PullTopic = {
  name: string
  topicID: string
  fetched: LogPosition | null
  position: LogPosition | null
  generation: number
  limit: number
}

type ReportPrunedWindowParams = {
  name: string
  topicID: string
  cursor: LogPosition
  oldest: string | null
}

export type AppLaneParams<TTx extends GroupTransaction = GroupTransaction> = {
  completion: HandlerCompletion<TTx>
  batch?: AppBatchBinding
  openedHandler?: OpenedAppHandler<TTx>
  mux: HubMux
  crypto: GroupCrypto
  localDID: string
  protocols: Record<string, ProtocolDefinition>
  /**
   * The host's app event handlers, per protocol, as the delivery worker calls them — the same adaptation
   * the live bus server is built from, so a drained frame and a pushed one reach the host by the
   * same door.
   */
  eventHandlers: Map<string, BusHandlerMaps['events']>
  claimOpened?: (record: PendingAppFrame, fn: () => Promise<void>) => Promise<boolean>
  openedFailureSignal?: AbortSignal
  /** App-log retention the hub is asked to hold on every topic this lane pulls, in seconds. */
  retentionSeconds: number
  appCursorStore?: AppCursorStore | undefined
  onAppWindowPruned?: ((event: AppWindowPruned) => void | Promise<void>) | undefined
  onAppDeliveryStalled?: ((event: AppDeliveryStalled) => void) | undefined
  onAppDeliveryResumed?: ((event: AppDeliveryResumed) => void) | undefined
  /** Queue worker starts outside the caller's synchronous frame; direct lanes start immediately. */
  scheduleDelivery?: ((start: () => void) => void) | undefined
  /** Run autonomous drains outside the caller's commit queue. */
  scheduleDrain?: (drain: () => Promise<void>) => Promise<void>
  /** No applicable unapplied commit through the observed head. Direct lanes default to true. */
  commitLaneCaughtUp?: () => boolean
  /** The last authenticated epoch applied by the commit lane. */
  appliedEpoch: () => number
  /** Changes when new commit work invalidates a caught-up observation. */
  commitWorkVersion?: () => number
  /** Local monotone milliseconds. Defaults to clamped wall time. */
  now?: () => number
  /** Current safety hold. Defaults to null. */
  safetyHold?: () => SafetyHold
  /** Latch a held refusal. Defaults to a no-op. */
  onSafetyHeld?: (reason: NonNullable<SafetyHold>) => void
  /** Topic derivation reads the anchor that belongs to each segment. */
  anchor: () => Anchor
  departing?: () => Array<{ anchor: Anchor; departedAt: number }>
  /** The group's commit topic, or `undefined` before the control lanes are up. */
  groupID: () => string | undefined
  groupKey: GroupKey
}

export type AppLane = {
  /**
   * Deliver buffered frames at current or retained epochs, leaving future frames buffered.
   */
  deliver: () => Promise<void>
  /** Request a drain without waiting; an active drain coalesces requests into one rerun. */
  kick: () => void
  dropFrame: (topicID: string, position: string) => Promise<void>
  /** Wake queued delivery for a topic, or every topic, without waiting for completion. */
  retryDelivery: (topicID?: string) => void
  /** Record a log-class frame the live lane was pushed, at the moment it arrives. */
  note: (name: string, topicID: string, message: StoredMessage, failure: unknown) => void
  /** Clear in-memory lanes for recovery resync; durable cursors and pending records survive. */
  reset: () => void
  /** Opened records awaiting the delivery worker. */
  pendingRecords: () => Array<PendingAppFrame>
  /** Restore durable records before the first retained pull. */
  restore: (records: Array<PendingAppFrame>) => Promise<void>
  /** Await all retained handlers and durable record completions. */
  idle: () => Promise<void>
  /** Await all restored plaintext handlers and their durable completions. */
  completeOpened: () => Promise<void>
  /** Permanently stop network pulls and new opens after terminal removal. */
  stopOpening: () => void
  handoffOpened: () => Promise<void>
  acknowledgeOpened: (id: string) => Promise<void>
  /** Stop admitting cursor work from cold completion notices. */
  releaseOpened: () => void
  /** Stop queued retries and prevent new handler calls. */
  dispose: () => void
}

/**
 * Take one frame into the buffer at its place in the log, or reconcile it with the copy already
 * there. The ONE way a frame enters the buffer, from either deliverer.
 *
 * A POSITION IS TAKEN ONCE. In durable mode, pending and completed occurrences survive duplicates.
 * Without durable delivery, a live done observation still wins as before.
 *
 * Kept in log order by insertion, not append, since the two deliverers do not arrive in one order:
 * a pull runs from behind the live stream and returns frames the pushes already brought.
 */
function takeAppFrame(frames: Array<AppFrame>, incoming: AppFrame, durable: boolean): void {
  let index = frames.length
  while (
    index > 0 &&
    compareLogPositions((frames[index - 1] as AppFrame).position, incoming.position) > 0
  )
    index -= 1
  const existing = index > 0 ? (frames[index - 1] as AppFrame) : undefined
  if (existing?.position === incoming.position) {
    if (!durable) {
      if (incoming.sealed.state === 'done') existing.sealed = incoming.sealed
      return
    }
    if (existing.sealed.state === 'pending' || existing.sealed.state === 'done') return
    if (incoming.sealed.state === 'pending') {
      existing.sealed = incoming.sealed
    }
    return
  }
  frames.splice(index, 0, incoming)
}

/**
 * The peer's app lane: the retained-frame buffer, the durable read position over it, and the two
 * deliverers that fill it — the live push and the segment pull.
 *
 * Held apart from the peer because everything here is reached through ONE mutex and nothing
 * outside it may touch the buffer. That rule was a comment when this state sat in the peer's own
 * closure; here it is the module boundary.
 */
export function createAppLane<TTx extends GroupTransaction = GroupTransaction>(
  params: AppLaneParams<TTx>,
): AppLane {
  for (const key of [params.groupKey, params.batch?.key]) {
    if (
      key !== undefined &&
      (key.groupID !== params.completion.key.groupID ||
        key.incarnation !== params.completion.key.incarnation)
    )
      throw new TypeError('App lane coordination key mismatch')
  }
  if (params.crypto.pending != null && params.openedHandler === undefined)
    throw new TypeError('Durable app lane requires opened handler')
  const openedHandler =
    params.openedHandler === undefined
      ? undefined
      : normaliseOpenedAppHandler({
          deliver: params.openedHandler,
          completion: params.completion,
          openedDeliveryContext: params.openedHandler.openedDeliveryContext,
        })
  const {
    mux,
    crypto,
    localDID,
    protocols,
    eventHandlers: appEventHandlers,
    retentionSeconds,
    appCursorStore,
    onAppWindowPruned,
    onAppDeliveryStalled,
    onAppDeliveryResumed,
    scheduleDelivery = (start) => start(),
    scheduleDrain = (drain) => drain(),
    safetyHold = () => null,
    commitLaneCaughtUp = () => true,
    commitWorkVersion = () => 0,
    now = createMonotoneClock(),
    onSafetyHeld = () => {},
    anchor,
    departing = () => [],
    groupID,
  } = params

  /**
   * Retained app frames per topic, in log order. A segment is the run of
   * epochs between two roster changes — exactly the run one app topic spans — so it is pulled once
   * (below) and dispensed epoch by epoch as the commit walk passes through it.
   */
  let segment = new Map<string, Array<AppFrame>>()
  let segmentGeneration = 0
  let openCancellation = new AbortController()
  const pendingRecords: Array<PendingAppFrame> = []
  // Buffer resets must not reopen consumed frames whose saved records still need reloading.
  const openedFrameIDs = new Set<string>()
  const finishingRecords = new Set<Promise<void>>()
  const deliveringRecords = new Set<Promise<void>>()
  let openedFailure: unknown
  let deliveryHandedOff = false
  let openedReleased = false
  const openedWaiters = new Set<{ resolve(): void; reject(error: unknown): void }>()
  const notifyOpened = (): void => {
    if (
      openedFailure === undefined &&
      (openedFrameIDs.size !== 0 ||
        pendingRecords.length !== 0 ||
        deliveringRecords.size !== 0 ||
        finishingRecords.size !== 0)
    )
      return
    for (const waiter of openedWaiters) {
      if (openedFailure !== undefined) waiter.reject(openedFailure)
      else waiter.resolve()
    }
    openedWaiters.clear()
  }
  const pulls = new Map<AbortController, number>()
  const reportedPruned = new Map<string, Set<string>>()
  const blockingFrames = new Map<string, AppDeliveryResumed>()
  let disposed = false
  let openedOnly = false
  let futureTimer: ReturnType<typeof setTimeout> | undefined
  let futureDeadline: number | undefined
  let retryScheduled = false
  let retryRequested = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryBackoff = 1000
  let continuationTimer: ReturnType<typeof setTimeout> | undefined
  let continuationBackoff = APP_CONTINUATION_BACKOFF_MS
  const scheduleContinuation = (progress = false): void => {
    if (disposed || safetyHold() !== null) return
    if (progress) {
      continuationBackoff = APP_CONTINUATION_BACKOFF_MS
      if (continuationTimer != null) clearTimeout(continuationTimer)
      continuationTimer = undefined
    }
    if (continuationTimer != null) return
    const delay = progress ? 0 : continuationBackoff
    if (!progress) {
      continuationBackoff = Math.min(continuationBackoff * 2, APP_CONTINUATION_BACKOFF_MAX_MS)
    }
    // Every autonomous continuation yields, even when hub promises settle synchronously.
    continuationTimer = setTimeout(() => {
      continuationTimer = undefined
      kick(false, false)
    }, delay)
  }
  const busyTopics = new Set<string>()
  let cancelBusyRetry: (() => void) | undefined
  const caughtUpTimes = new Map<AppFrame, number>()
  const applyCaughtUpTimes = (): void => {
    for (const [frame, time] of caughtUpTimes) {
      frame.caughtUpAt = Math.min(frame.caughtUpAt ?? time, time)
    }
    caughtUpTimes.clear()
  }
  const reportedUnknown = new Map<string, AppDeliveryResumed>()
  let pendingNotices: Array<() => void> | undefined
  const notifyAppHost = <T>(callback: ((event: T) => void) | undefined, event: T): void => {
    if (callback == null) return
    // A notice queued behind an in-flight save is dropped if the lane is disposed meanwhile.
    const notify = () => {
      if (!disposed) notifyHost(callback, event)
    }
    if (pendingNotices == null) notify()
    else pendingNotices.push(notify)
  }
  const blockingKey = (topicID: string, position: string, id: string): string =>
    `${topicID}\u0000${position}\u0000${id}`
  const resumeBlocked = (topicID: string, position: string, id?: string): void => {
    if (disposed) return
    const prefix = `${topicID}\u0000${position}\u0000`
    for (const [key, event] of blockingFrames) {
      if (id == null ? !key.startsWith(prefix) : key !== blockingKey(topicID, position, id))
        continue
      blockingFrames.delete(key)
      notifyAppHost(onAppDeliveryResumed, { ...event, settlement: 'resumed' })
    }
  }
  const resumeUnknown = (record: PendingAppFrame): void => {
    const event = reportedUnknown.get(record.frame.id)
    if (event == null || disposed) return
    reportedUnknown.delete(record.frame.id)
    notifyAppHost(onAppDeliveryResumed, { ...event, settlement: 'resumed' })
  }
  const reportBlocked = (
    protocol: string,
    topicID: string,
    position: string,
    id: string,
    error: Error,
    reason?: AppDeliveryStalled['reason'],
  ): void => {
    const key = blockingKey(topicID, position, id)
    if (disposed || onAppDeliveryStalled == null || blockingFrames.has(key)) return
    const group = groupID()
    if (group == null) return
    const event = {
      groupID: group,
      protocol,
      topicID,
      position,
      ...(reason == null ? {} : { reason }),
    }
    blockingFrames.set(key, event)
    notifyAppHost(onAppDeliveryStalled, { ...event, error })
  }
  const reportUnknown = (record: PendingAppFrame): void => {
    if (
      disposed ||
      onAppDeliveryStalled == null ||
      protocols[record.frame.protocol] != null ||
      reportedUnknown.has(record.frame.id)
    )
      return
    const group = groupID()
    if (group == null) return
    const event: AppDeliveryResumed = {
      groupID: group,
      protocol: record.frame.protocol,
      topicID: record.frame.topicID,
      position: record.frame.position,
      reason: 'unknown-protocol',
    }
    reportedUnknown.set(record.frame.id, event)
    notifyAppHost(onAppDeliveryStalled, {
      ...event,
      error: new Error(`unknown app protocol: ${record.frame.protocol}`),
    })
  }
  const workers = new Map<
    string,
    {
      running: boolean
      requested: boolean
      retryNow: boolean
      backoff: number
      delayed: boolean
      timer?: ReturnType<typeof setTimeout>
    }
  >()

  /** Read positions per topic. See {@link AppCursor}. */
  let cursors = new Map<string, AppCursor>()

  /**
   * Log-class app frames the LIVE lane was pushed and the buffer has not taken in yet, per
   * topic.
   *
   * Staged rather than written straight into {@link segment}: the push arrives on the mux's own
   * drain loop, outside every lane operation, and writing there would splice the array
   * {@link deliver} is midway through iterating and awaiting inside. Everything that touches the
   * buffer goes through {@link runAppLane} instead; this is the hand-off.
   *
   * The topic travels with the frame because a rotation can land between push and merge, and a
   * position in the segment just left means nothing in the one moved to.
   */
  let staged = new Map<string, Array<{ topicID: string; frame: AppFrame }>>()

  /** App topics whose retention this segment has already been asked for. See {@link pull}. */
  let retained = new Set<string>()

  let coverage = new Map<string, AppCompletionCoverage>()
  const completedIDs = new Set<string>()
  const provenThrough = new Map<string, string>()
  const refreshCoverage = (): void => {
    const next = new Map<string, AppCompletionCoverage>()
    for (const [topicID, cursor] of cursors) {
      const frames = segment.get(topicID) ?? []
      const proven = provenThrough.get(topicID)
      if (
        proven != null &&
        (cursor.position == null || compareLogPositions(cursor.position, proven) < 0)
      ) {
        cursor.position = asLogPosition(proven)
        while (frames[0] != null && compareLogPositions(frames[0].position, proven) <= 0) {
          const frame = frames.shift()
          if (frame?.ref != null) completedIDs.delete(frame.ref.id)
        }
        if (bufferBlockedTopics.delete(topicID)) scheduleContinuation()
      }
      const prefix: AppCompletionCoverage['prefix'] = []
      for (const frame of frames) {
        if (frame.sealed.state === 'sealed' || frame.ref === undefined) break
        if (frame.sealed.state === 'pending' && completedIDs.has(frame.sealed.id))
          frame.sealed = { state: 'done' }
        prefix.push({
          frame: { ...frame.ref },
          state: completedIDs.has(frame.ref.id)
            ? 'completed'
            : frame.sealed.state === 'pending'
              ? 'pending'
              : 'dead',
        })
      }
      if (prefix.length > 0)
        next.set(topicID, {
          key: { ...params.groupKey },
          topicID,
          generation: segmentGeneration,
          previous: cursor.position,
          through: prefix.at(-1)?.frame.position ?? null,
          prefix,
        })
    }
    coverage = next
  }
  const coverageBinding = bindAppCompletionCoverage(params.completion, {
    // Completion may own the group gate. Capture must never wait for the app mutex.
    capture: () =>
      [...coverage.values()].map((item) => ({
        ...item,
        key: { ...item.key },
        prefix: item.prefix.map((member) => ({
          frame: { ...member.frame },
          state: completedIDs.has(member.frame.id) ? 'completed' : member.state,
        })),
      })),
    current: (item) =>
      !openedReleased &&
      item.generation === segmentGeneration &&
      coverage.get(item.topicID)?.previous === item.previous,
    committed: (ids, consumed) => {
      const completed = new Set(ids)
      // A held occurrence can hide completed successors from cursor coverage.
      for (const frames of segment.values()) {
        for (const frame of frames) {
          if (frame.ref !== undefined && completed.has(frame.ref.id)) completedIDs.add(frame.ref.id)
        }
      }
      for (const item of consumed) {
        if (item.generation !== segmentGeneration || item.through === null) continue
        provenThrough.set(item.topicID, item.through)
        const live = coverage.get(item.topicID)
        if (live !== undefined)
          coverage.set(item.topicID, {
            ...live,
            previous: item.through,
            prefix: live.prefix.filter(
              (member) => compareLogPositions(member.frame.position, item.through as string) > 0,
            ),
          })
      }
      void runAppLane(async () => {
        for (const record of [...pendingRecords]) {
          if (!completed.has(record.frame.id) && !completedIDs.has(record.frame.id)) continue
          pendingRecords.splice(pendingRecords.indexOf(record), 1)
          resumeBlocked(record.frame.topicID, record.frame.position, record.frame.id)
          resumeUnknown(record)
        }
        notifyOpened()
      })
    },
  })

  /**
   * The app lane's own mutex: everything that reads or writes {@link segment} and {@link cursors}
   * runs through here, one task at a time.
   *
   * NOT the peer's commit mutex: that one resets the journal-replay flag on entry, so a cursor
   * write taking it would wrongly tell the next pull the journal had not been replayed. And it
   * must not be reentrant, since this lane is reached both from inside a commit walk and from the
   * mux's push loop — the buffer is an ordered array {@link deliver} iterates and awaits inside,
   * and a push splicing it mid-iteration would step over frames.
   */
  let tail: Promise<void> = Promise.resolve()
  const runAppLane = <T>(fn: () => Promise<T>): Promise<T> => {
    const op = tail.then(async () => {
      const notices: Array<() => void> = []
      pendingNotices = notices
      try {
        return await fn()
      } finally {
        refreshCoverage()
        // State and cursor writes settle before observers can re-enter this lane.
        // A reentrant reset can append more notices to this batch.
        for (let index = 0; index < notices.length; index++) notices[index]?.()
        pendingNotices = undefined
      }
    })
    tail = op.then(
      () => {},
      () => {},
    )
    return op
  }

  /** Tell the host once when a fetch with a cursor confirms unread frames were removed. */
  const reportPrunedWindow = (report: ReportPrunedWindowParams): void => {
    const { name, topicID, cursor, oldest } = report
    const group = groupID()
    if (onAppWindowPruned == null || group == null) return
    let positions = reportedPruned.get(topicID)
    if (positions == null) {
      positions = new Set()
      reportedPruned.set(topicID, positions)
    }
    if (positions.has(cursor)) return
    positions.add(cursor)
    if (positions.size > APP_PRUNED_NOTICES_MAX) {
      const oldest = positions.values().next().value
      if (oldest != null) positions.delete(oldest)
    }
    notifyAppHost(onAppWindowPruned, { groupID: group, protocol: name, cursor, oldest })
  }

  /**
   * The buffer for one topic and its positions, created on first use.
   *
   * Lazy because the LIVE lane can reach the buffer before any drain does — a peer that is online
   * and has walked no commit still has to keep a read position over what it was pushed — so the
   * durable cursor cannot be something only a pull establishes.
   */
  const laneFor = async (
    name: string,
    at: Anchor,
  ): Promise<{ frames: Array<AppFrame>; cursor: AppCursor } | undefined> => {
    const generation = segmentGeneration
    const topicID = protocolTopic(at.secret, at.epoch, name)
    let frames = segment.get(topicID)
    if (frames == null) {
      frames = []
      segment.set(topicID, frames)
    }
    let cursor = cursors.get(topicID)
    if (cursor == null) {
      const stored = (await appCursorStore?.load(topicID)) ?? null
      if (generation !== segmentGeneration) return
      cursor = {
        topicID,
        protocol: name,
        anchorEpoch: at.epoch,
        position: stored != null ? asLogPosition(stored) : null,
        fetched: null,
        accepted: stored != null ? asLogPosition(stored) : null,
      }
      cursors.set(topicID, cursor)
    }
    return { frames, cursor }
  }

  const expireTopic = (topicID: string): void => {
    for (const frame of segment.get(topicID) ?? []) caughtUpTimes.delete(frame)
    for (const push of staged.get(topicID) ?? []) caughtUpTimes.delete(push.frame)
    segment.delete(topicID)
    cursors.delete(topicID)
    coverage.delete(topicID)
    provenThrough.delete(topicID)
    staged.delete(topicID)
    reportedPruned.delete(topicID)
    retained.delete(topicID)
    busyTopics.delete(topicID)
    bufferBlockedTopics.delete(topicID)
    for (const [key, event] of blockingFrames) {
      if (!key.startsWith(`${topicID}\u0000`)) continue
      // Opened records survive topic expiry and settle when durable delivery completes.
      if (
        pendingRecords.some(
          (record) =>
            blockingKey(record.frame.topicID, record.frame.position, record.frame.id) === key,
        )
      )
        continue
      blockingFrames.delete(key)
      notifyAppHost(onAppDeliveryResumed, { ...event, settlement: 'expired' })
    }
  }

  const activeAnchors = (): Array<Anchor> => [
    ...departing()
      .filter(({ departedAt }) => params.appliedEpoch() - departedAt < RETAINED_EPOCHS_MAX)
      .map(({ anchor }) => anchor),
    anchor(),
  ]

  const expireTopics = (): void => {
    const active = new Set(
      activeAnchors().flatMap((at) =>
        Object.keys(protocols).map((name) => protocolTopic(at.secret, at.epoch, name)),
      ),
    )
    for (const topicID of new Set([
      ...segment.keys(),
      ...staged.keys(),
      ...reportedPruned.keys(),
    ])) {
      if (!active.has(topicID)) expireTopic(topicID)
    }
  }

  const bufferBlockedTopics = new Set<string>()
  const pageDrains = new Set<Promise<unknown>>()
  /** Snapshot and merge under the app mutex. Hub I/O holds no lane reservation. */
  const pull = async (
    onlyTopics?: Set<string>,
    onReady?: (opening: Promise<boolean>) => void,
  ): Promise<boolean> => {
    if (disposed || openedOnly || safetyHold() !== null) return false
    const controller = new AbortController()
    const { signal } = controller
    pulls.set(controller, anchor().epoch)
    let deadline: number | undefined
    let continuation = false
    let timedOut = false
    const timeout = () => {
      timedOut = true
      controller.abort()
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const stopped = (): boolean => {
      if (deadline != null && Date.now() >= deadline) timeout()
      return disposed || openedOnly || signal.aborted || safetyHold() !== null
    }
    let bytes = 0
    const readyDrains: Array<Promise<unknown>> = []
    try {
      const topics = await runAppLane(async () => {
        expireTopics()
        const topics: Array<PullTopic> = []
        for (const at of activeAnchors()) {
          for (const name of Object.keys(protocols)) {
            if (stopped()) break
            const generation = segmentGeneration
            const lane = await laneFor(name, at)
            if (lane == null || generation !== segmentGeneration || stopped()) break
            const { frames, cursor } = lane
            const { topicID } = cursor
            if (!retained.has(topicID)) {
              retained.add(topicID)
              mux.retainTopic(topicID, { retention: retentionSeconds })
            }
            for (const push of staged.get(topicID) ?? []) {
              if (
                push.topicID === topicID &&
                frames.length < APP_BUFFER_MAX_FRAMES &&
                (cursor.position == null ||
                  compareLogPositions(push.frame.position, cursor.position) > 0)
              ) {
                takeAppFrame(frames, push.frame, crypto.pending != null)
              }
            }
            staged.delete(topicID)
            topics.push({
              name,
              topicID,
              fetched: cursor.fetched ?? cursor.position,
              position: cursor.position,
              generation,
              limit: Math.min(APP_FETCH_LIMIT, APP_BUFFER_MAX_FRAMES - frames.length),
            })
          }
        }
        return topics
      })
      const queue = topics
        .filter((topic) => onlyTopics == null || onlyTopics.has(topic.topicID))
        .map((topic) => ({ topic, pages: 0 }))
      const fetchNext = async (): Promise<void> => {
        while (queue.length > 0) {
          const item = queue.shift()
          if (item == null) return
          const { topic, pages } = item
          if (stopped() || bytes >= APP_PULL_MAX_BYTES) {
            if (bytes >= APP_PULL_MAX_BYTES) continuation = true
            return
          }
          if (topic.limit === 0) {
            bufferBlockedTopics.add(topic.topicID)
            continue
          }
          if (deadline == null) {
            deadline = Date.now() + APP_PULL_DEADLINE_MS
            timer = setTimeout(timeout, APP_PULL_DEADLINE_MS)
          }
          let result: HubFetchTopicResult
          try {
            result = await mux.fetchTopic({
              topicID: topic.topicID,
              ...(topic.fetched != null ? { after: topic.fetched } : {}),
              limit: topic.limit,
              signal,
            })
          } catch (error) {
            if (signal.aborted) return
            if (error instanceof AppFetchBusyError) {
              if (topic.generation === segmentGeneration) retryBusyPull(topic.topicID)
              continue
            }
            if (error instanceof InvalidLogPositionError) continue
            throw error
          }
          const next = await runAppLane(async () => {
            if (stopped() || topic.generation !== segmentGeneration) return
            expireTopics()
            const cursor = cursors.get(topic.topicID)
            const frames = segment.get(topic.topicID)
            if (
              cursor?.topicID !== topic.topicID ||
              frames == null ||
              (cursor.fetched ?? cursor.position) !== topic.fetched ||
              cursor.position !== topic.position
            )
              return
            if (topic.fetched != null && result.gap) {
              reportPrunedWindow({
                name: topic.name,
                topicID: topic.topicID,
                cursor: topic.fetched,
                oldest: result.oldest,
              })
            }
            const messages = result.messages
              .slice()
              .sort((a, b) => compareLogPositions(a.sequenceID, b.sequenceID))
            for (const message of messages) {
              if (stopped() || frames.length >= APP_BUFFER_MAX_FRAMES) break
              const position = asLogPosition(message.sequenceID)
              if (cursor.accepted != null && compareLogPositions(position, cursor.accepted) <= 0) {
                const fetched = cursor.fetched ?? cursor.position
                if (fetched == null || compareLogPositions(position, fetched) > 0)
                  cursor.fetched = position
                continue
              }
              // A frame larger than an entire fresh budget cannot be legitimate.
              const oversized = bytes === 0 && message.payload.byteLength > APP_PULL_MAX_BYTES
              if (!oversized && bytes + message.payload.byteLength > APP_PULL_MAX_BYTES) {
                continuation = true
                return
              }
              if (!oversized) bytes += message.payload.byteLength
              const fetched = cursor.fetched ?? cursor.position
              if (fetched == null || compareLogPositions(position, fetched) > 0) {
                cursor.fetched = position
              }
              const restored = oversized
                ? undefined
                : pendingRecords.find(
                    (record) =>
                      record.frame.protocol === topic.name &&
                      record.frame.topicID === topic.topicID &&
                      record.frame.position === position &&
                      record.frame.id === frameID(topic.topicID, message.payload),
                  )
              takeAppFrame(
                frames,
                {
                  position,
                  ref: {
                    ...params.groupKey,
                    id: frameID(topic.topicID, message.payload),
                    topicID: topic.topicID,
                    protocol: topic.name,
                    segment: cursor.anchorEpoch,
                    position,
                  },
                  ...(commitLaneCaughtUp() ? { caughtUpAt: now() } : {}),
                  sealed: oversized
                    ? { state: 'done' }
                    : restored == null
                      ? { state: 'sealed', bytes: message.payload }
                      : { state: 'pending', id: restored.frame.id },
                },
                crypto.pending != null,
              )
              cursor.accepted = position
            }
            return {
              ...topic,
              fetched: cursor.fetched ?? cursor.position,
              position: cursor.position,
              limit: Math.min(APP_FETCH_LIMIT, APP_BUFFER_MAX_FRAMES - frames.length),
            }
          })
          if (params.batch !== undefined && next !== undefined && result.messages.length !== 0) {
            // A sibling fetch may remain unresolved after this source is locally ready.
            const opening = drain()
            onReady?.(opening)
            readyDrains.push(opening)
            pageDrains.add(opening)
            void opening.then(
              () => pageDrains.delete(opening),
              () => {
                pageDrains.delete(opening)
                if (!disposed && retryTimer == null)
                  retryTimer = setTimeout(() => {
                    retryTimer = undefined
                    retryDelivery()
                  }, retryBackoff)
              },
            )
          }
          if (
            next != null &&
            result.messages.length >= topic.limit &&
            next.fetched !== topic.fetched
          ) {
            if (next.limit === 0) bufferBlockedTopics.add(topic.topicID)
            if (pages + 1 >= APP_PULL_MAX_PAGES || next.limit === 0) continuation = true
            else {
              // Requeue one page at a time so busy topics cannot overtake unvisited topics.
              queue.push({ topic: next, pages: pages + 1 })
            }
          }
        }
      }
      const results = await Promise.allSettled(
        Array.from({ length: Math.min(APP_OUTSTANDING_FETCHES_MAX, topics.length) }, fetchNext),
      )
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      const opened = await Promise.allSettled(readyDrains)
      const openFailure = opened.find((result) => result.status === 'rejected')
      if (openFailure?.status === 'rejected') throw openFailure.reason
      return continuation || timedOut
    } finally {
      clearTimeout(timer)
      pulls.delete(controller)
    }
  }

  // Unregistered adapters own durable proof. This prefix is deliberately volatile.
  const advanceCursor = (topicID: string, frames: Array<AppFrame>): void => {
    if (coverageBinding !== undefined || segment.get(topicID) !== frames) return
    const cursor = cursors.get(topicID)
    if (cursor == null) return
    let passed = 0
    let position: LogPosition | null = null
    while (passed < frames.length && (frames[passed] as AppFrame).sealed.state === 'done') {
      position = (frames[passed] as AppFrame).position
      passed++
    }
    if (position == null || position === cursor.position) return
    cursor.position = position
    if (cursor.accepted == null || compareLogPositions(position, cursor.accepted) > 0)
      cursor.accepted = position
    for (const frame of frames.splice(0, passed)) {
      if (frame.ref !== undefined) completedIDs.delete(frame.ref.id)
    }
    if (bufferBlockedTopics.delete(topicID)) scheduleContinuation()
  }

  const orderedRecords = (name: string): Array<PendingAppFrame> =>
    pendingRecords
      .filter((record) => record.frame.protocol === name)
      .sort(
        (a, b) =>
          a.frame.segment - b.frame.segment ||
          compareLogPositions(a.frame.position, b.frame.position),
      )

  const blockedByEarlierSealed = (record: PendingAppFrame): boolean => {
    for (const [topicID, cursor] of cursors) {
      if (cursor.protocol !== record.frame.protocol) continue
      if (
        (segment.get(topicID) ?? []).some(
          (frame) =>
            frame.sealed.state === 'sealed' &&
            (cursor.anchorEpoch < record.frame.segment ||
              (topicID === record.frame.topicID &&
                compareLogPositions(frame.position, record.frame.position) < 0)),
        )
      )
        return true
    }
    return false
  }

  const finishRecord = async (record: PendingAppFrame, advance = true): Promise<void> => {
    // The supplied completion promise has already proved row removal.
    await runAppLane(async () => {
      const buffered = segment
        .get(record.frame.topicID)
        ?.find((frame) => frame.position === record.frame.position)
      if (buffered !== undefined) completedIDs.add(record.frame.id)
      const index = pendingRecords.findIndex((item) => item.frame.id === record.frame.id)
      if (index !== -1) pendingRecords.splice(index, 1)
      resumeBlocked(record.frame.topicID, record.frame.position, record.frame.id)
      resumeUnknown(record)
      if (buffered?.sealed.state === 'pending' && buffered.sealed.id === record.frame.id)
        buffered.sealed = { state: 'done' }
      const frames = segment.get(record.frame.topicID)
      if (frames !== undefined) await advanceCursor(record.frame.topicID, frames)
      notifyOpened()
    })
    if (advance) await coverageBinding?.advance()
  }

  const deliverRecord = async (record: PendingAppFrame): Promise<void> => {
    const invoke = async () => {
      if (openedHandler === undefined) throw new TypeError('Opened handler required')
      await openedHandler.deliver(record)
      let delay = 100
      for (;;) {
        if (params.openedFailureSignal?.aborted) throw params.openedFailureSignal.reason
        const finishing = finishRecord(record)
        finishingRecords.add(finishing)
        try {
          await finishing
          return
        } catch (error) {
          if (params.openedFailureSignal?.aborted) throw params.openedFailureSignal.reason
          if (!disposed && !deliveryHandedOff) throw error
          await new Promise<void>((resolve, reject) => {
            const signal = params.openedFailureSignal
            const abort = () => {
              clearTimeout(timer)
              signal?.removeEventListener('abort', abort)
              reject(signal?.reason)
            }
            const timer = setTimeout(() => {
              signal?.removeEventListener('abort', abort)
              resolve()
            }, delay)
            signal?.addEventListener('abort', abort, { once: true })
          })
          delay = Math.min(delay * 2, 15000)
        } finally {
          finishingRecords.delete(finishing)
        }
      }
    }
    if (params.claimOpened === undefined) await invoke()
    else if (!(await params.claimOpened(record, invoke))) await finishRecord(record)
  }

  const scheduleWorker = (name: string, delay = 0): void => {
    if (disposed || deliveryHandedOff || openedFailure !== undefined || crypto.pending == null)
      return
    let worker = workers.get(name)
    if (worker == null) {
      worker = { running: false, requested: false, retryNow: false, backoff: 1000, delayed: false }
      workers.set(name, worker)
    }
    worker.requested = true
    if (worker.running || worker.timer != null) return
    worker.delayed = delay > 0
    worker.timer = setTimeout(() => {
      if (disposed || deliveryHandedOff) return
      worker.timer = undefined
      worker.running = true
      worker.requested = false
      void (async () => {
        let failed = false
        try {
          while (!disposed && !deliveryHandedOff) {
            const record = orderedRecords(name)[0]
            if (
              record == null ||
              protocols[record.frame.protocol] == null ||
              (!openedOnly && (await runAppLane(async () => blockedByEarlierSealed(record))))
            )
              break
            if (disposed || deliveryHandedOff) break
            const delivery = deliverRecord(record)
            deliveringRecords.add(delivery)
            try {
              await delivery
              worker.backoff = 1000
            } catch (error) {
              if (params.openedFailureSignal?.aborted) openedFailure = error
              failed = true
              break
            } finally {
              deliveringRecords.delete(delivery)
              notifyOpened()
            }
          }
        } finally {
          worker.running = false
          if (worker.retryNow) {
            worker.retryNow = false
            scheduleWorker(name)
          } else if (failed) {
            const retry = worker.backoff
            worker.backoff = Math.min(worker.backoff * 2, 60_000)
            scheduleWorker(name, retry)
          } else if (worker.requested) {
            scheduleWorker(name)
          }
        }
      })()
    }, delay)
  }

  const retryDelivery = (topicID?: string): void => {
    if (disposed) return
    if (openedOnly) {
      for (const name of new Set(pendingRecords.map((record) => record.frame.protocol)))
        scheduleWorker(name)
      return
    }
    const frames = [...segment.values()].flat()
    for (const pushes of staged.values()) for (const push of pushes) frames.push(push.frame)
    const retryFrames = frames.filter((frame) => frame.sealed.state !== 'pending')
    // Preserve transitions even when a drain is already queued or awaiting a refetch.
    if (commitLaneCaughtUp()) {
      const time = now()
      for (const frame of retryFrames) {
        if (!caughtUpTimes.has(frame)) caughtUpTimes.set(frame, time)
      }
    }
    if (safetyHold() === null && retryFrames.length > 0) retryRequested = true
    if (!retryScheduled && retryRequested && safetyHold() === null) {
      retryScheduled = true
      retryRequested = false
      if (retryTimer != null) clearTimeout(retryTimer)
      retryTimer = undefined
      const generation = segmentGeneration
      void scheduleDrain(async () => {
        if (generation === segmentGeneration && !disposed) await deliver(generation)
      }).then(
        () => {
          retryScheduled = false
          retryBackoff = 1000
          if (retryRequested) retryDelivery()
        },
        () => {
          retryScheduled = false
          if (disposed || safetyHold() !== null) return
          if (generation !== segmentGeneration) {
            if (retryRequested) retryDelivery()
            return
          }
          retryTimer = setTimeout(() => {
            retryTimer = undefined
            retryDelivery()
          }, retryBackoff)
          retryBackoff = Math.min(retryBackoff * 2, 60_000)
        },
      )
    }
    const names = new Set([
      ...workers.keys(),
      ...pendingRecords.map((record) => record.frame.protocol),
    ])
    for (const name of names) {
      if (
        topicID != null &&
        cursors.get(topicID)?.protocol !== name &&
        !pendingRecords.some(
          (record) => record.frame.protocol === name && record.frame.topicID === topicID,
        )
      )
        continue
      const worker = workers.get(name)
      if (worker != null) {
        worker.backoff = 1000
        worker.retryNow = worker.running
        if (worker.timer != null && worker.delayed) {
          clearTimeout(worker.timer)
          worker.timer = undefined
        }
      }
      scheduleWorker(name)
    }
  }

  /**
   * Take the staged pushes into the buffer and move the durable cursor over them, off the back of
   * live traffic alone — a peer that is online and walks no commit still has to keep its position,
   * or a group quiet on the commit lane and busy on the app lane re-delivers its whole backlog on
   * the next restart.
   *
   * Opening and delivery run in a separate drain. Crypto serialises each MLS mutation.
   *
   * Coalesced through snapshot, fetch and merge, with one rerun for mid-pull pushes.
   */
  let syncScheduled = false
  let syncRequested = false
  const scheduleSync = (): void => {
    if (disposed || safetyHold() !== null) return
    syncRequested = true
    if (syncScheduled) return
    syncScheduled = true
    syncRequested = false
    void (crypto.pending == null ? legacyDrain.then(() => pull()) : pull())
      .then(() =>
        runAppLane(async () => {
          if (safetyHold() !== null || disposed) return
          for (const [name, frames] of segment) await advanceCursor(name, frames)
        }),
      )
      .then(() => coverageBinding?.advance())
      .finally(() => {
        syncScheduled = false
        if (syncRequested) scheduleSync()
      })
      .catch(() => {
        // A hub that would not answer leaves the cursor where it is and the frames staged or
        // buffered; the next push, or the next drain, asks again.
      })
  }

  /**
   * Record a log-class frame the LIVE lane was pushed, once the live open of it settles.
   *
   * THE OTHER DELIVERER TAKING THE SAME READ POSITION: before the push carried its own log
   * position there was nothing for the live path to write down, so the cursor sat behind every
   * frame an online peer had already been given and every re-pull read them all back.
   *
   * WHAT IS RECORDED IS DONE-NESS, NOT DELIVERY — the same thing here, since the transport that
   * carries this frame to the host unwraps with the same handle. The open's own outcome decides,
   * never the epoch hint:
   *
   * - OPENED, or refused at the handle's epoch: the live lane's one chance, taken — DONE.
   * - Refused as AHEAD ({@link FrameEpochError}): its bytes are kept for the drain to deliver
   *   once the walk reaches that epoch.
   * - Refused as past, or unreadable: dead. MLS ratchets forward.
   *
   * A MAILBOX frame is skipped outright — nothing to advance over. The class travels with the push
   * because ephemeral and logged app traffic share one topic, and guessing from the topic would
   * move the cursor over frames the log does not contain.
   */
  const note = (_name: string, topicID: string, message: StoredMessage, failure: unknown): void => {
    if (openedOnly) return
    if (failure instanceof GroupSafetyHeldError) {
      onSafetyHeld(failure.reason)
      return
    }
    if (safetyHold() !== null) return
    const position = message.logPosition
    if (position == null) return
    if (crypto.pending != null) {
      // Pushed positions are unauthenticated metadata. Only fetches may populate this buffer.
      scheduleSync()
      return
    }
    const ahead = isFrameAhead(failure)
    let pushes = staged.get(topicID)
    if (pushes == null) {
      pushes = []
      staged.set(topicID, pushes)
    }
    if (pushes.length >= APP_STAGED_MAX_FRAMES) return
    pushes.push({
      topicID,
      frame: {
        position: asLogPosition(position),
        ...(commitLaneCaughtUp() ? { caughtUpAt: now() } : {}),
        sealed: ahead ? { state: 'sealed', bytes: message.payload } : { state: 'done' },
      },
    })
    scheduleSync()
    if (ahead) retryDelivery()
  }

  const openingTurns = new Set<Promise<unknown>>()
  const reserved = new Set<AppFrame>()
  const reservedSources = new Set<AppCursor>()
  const drain = async (): Promise<boolean> => {
    let progress = false
    const generation = segmentGeneration
    const signal = openCancellation.signal
    const attempted = new Set<AppFrame>()
    let halted = false
    for (;;) {
      const sources = await runAppLane(async () => {
        if (disposed || openedOnly || generation !== segmentGeneration || safetyHold() !== null)
          return []
        applyCaughtUpTimes()
        expireTopics()
        const sources = []
        for (const cursor of [...cursors.values()].sort((a, b) => a.anchorEpoch - b.anchorEpoch)) {
          if (!appEventHandlers.has(cursor.protocol) && crypto.pending == null) continue
          // New arrivals must stay behind a turn's unconsumed suffix until it merges.
          if (reservedSources.has(cursor)) continue
          const frames = (segment.get(cursor.topicID) ?? []).filter(
            (frame) =>
              frame.sealed.state === 'sealed' && !reserved.has(frame) && !attempted.has(frame),
          )
          if (frames.length === 0) continue
          const inputs: Array<OpenAppInput> = []
          for (const frame of frames) {
            if (frame.sealed.state !== 'sealed') continue
            frame.ref = {
              ...params.groupKey,
              id: frameID(cursor.topicID, frame.sealed.bytes),
              topicID: cursor.topicID,
              protocol: cursor.protocol,
              segment: cursor.anchorEpoch,
              position: frame.position,
            }
            inputs.push({
              frame: { ...frame.ref },
              ciphertext: frame.sealed.bytes,
              expectedAAD: encodeAppAAD({ topicID: cursor.topicID, intent: 'log' }),
            })
            reserved.add(frame)
          }
          reservedSources.add(cursor)
          sources.push({ cursor, frames, inputs })
        }
        return sources
      })
      if (sources.length === 0) break
      // Advertise every ready source before awaiting any owned preparation.
      const turns = sources.map(async ({ cursor, frames, inputs }) => {
        const caughtUpBefore = commitLaneCaughtUp()
        const workVersion = commitWorkVersion()
        let opened: GroupUnwrapResult | undefined
        try {
          let results: Array<OpenAppResult>
          let consumed: number
          const batch = params.batch
          if (crypto.pending != null && batch !== undefined) {
            const result = await batch.scheduler.schedule({
              source: JSON.stringify(['kumiai/app-open/v1', cursor.topicID]),
              kind: 'open',
              signal,
              run: (budget) => batch.openReady(inputs, budget),
            })
            if (
              result.consumed < 1 ||
              result.consumed > inputs.length ||
              result.results.length !== result.consumed
            )
              throw new AppFrameStorageError('Invalid streaming open prefix')
            consumed = result.consumed
            results = result.results
          } else {
            // Portable adapters release the source after each singleton open.
            const input = inputs[0] as OpenAppInput
            consumed = 1
            try {
              const aad = crypto.frameAAD(input.ciphertext)
              const decoded = aad == null ? null : decodeAppAAD(aad)
              if (
                crypto.frameEpoch(input.ciphertext) == null ||
                ((crypto.pending != null || aad != null) &&
                  (decoded?.topicID !== cursor.topicID || decoded.intent !== 'log'))
              ) {
                throw new Error('Retained frame refuses metadata')
              }
              if (crypto.pending == null) {
                opened = await crypto.unwrap(input.ciphertext, { expectedAAD: input.expectedAAD })
                results = []
              } else {
                if (!openedFrameIDs.has(input.frame.id)) {
                  await crypto.unwrap(input.ciphertext, {
                    expectedAAD: input.expectedAAD,
                    frame: input.frame,
                  })
                  openedFrameIDs.add(input.frame.id)
                }
                let record: PendingAppFrame | undefined
                try {
                  record = (await crypto.pending.list()).find(
                    (saved) => saved.frame.id === input.frame.id,
                  )
                } catch (cause) {
                  throw new AppFrameStorageError('Failed to reload saved app frame', { cause })
                }
                if (record == null)
                  throw new AppFrameStorageError('Durable open has no saved app frame')
                openedFrameIDs.delete(input.frame.id)
                results = [{ kind: 'opened', record, handleEpoch: crypto.epoch() }]
              }
            } catch (error) {
              if (error instanceof GroupSafetyHeldError || isAppFrameStorageError(error))
                throw error
              results = [
                isFrameAhead(error)
                  ? {
                      kind: 'held',
                      frame: input.frame,
                      reason: 'future-epoch',
                      frameEpoch: error.frameEpoch,
                      handleEpoch: error.handleEpoch,
                    }
                  : {
                      kind: 'refused',
                      frame: input.frame,
                      reason: 'invalid-ciphertext',
                      keyConsumed: false,
                    },
              ]
            }
          }
          await runAppLane(async () => {
            // Proven plaintext survives a reset, while old suffixes never enter its new generation.
            for (const result of results) {
              if (
                result.kind === 'opened' &&
                !pendingRecords.some((record) => record.frame.id === result.record.frame.id)
              )
                pendingRecords.push(result.record)
            }
            if (generation !== segmentGeneration) return
            for (let i = 0; i < consumed; i++) {
              const frame = frames[i] as AppFrame
              const input = inputs[i] as OpenAppInput
              attempted.add(frame)
              const result = results[i]
              if (result?.kind === 'held' && result.reason === 'future-epoch') {
                if (caughtUpBefore && commitLaneCaughtUp() && workVersion === commitWorkVersion()) {
                  frame.caughtUpAt ??= now()
                  const remaining = APP_FUTURE_HOLD_MS - (now() - frame.caughtUpAt)
                  if (
                    result.frameEpoch > result.handleEpoch + APP_FUTURE_EPOCH_WINDOW ||
                    remaining <= 0
                  ) {
                    frame.sealed = { state: 'done' }
                    resumeBlocked(cursor.topicID, frame.position, input.frame.id)
                    continue
                  }
                  const deadline = frame.caughtUpAt + APP_FUTURE_HOLD_MS
                  if (futureDeadline == null || deadline < futureDeadline) {
                    if (futureTimer != null) clearTimeout(futureTimer)
                    futureDeadline = deadline
                    futureTimer = setTimeout(() => {
                      futureTimer = undefined
                      futureDeadline = undefined
                      if (!disposed && safetyHold() === null && commitLaneCaughtUp())
                        retryDelivery()
                    }, remaining)
                  }
                }
                if (crypto.pending != null)
                  reportBlocked(
                    cursor.protocol,
                    cursor.topicID,
                    frame.position,
                    input.frame.id,
                    new Error(`frame claims future epoch ${result.frameEpoch}`),
                    'future-epoch',
                  )
                continue
              }
              if (opened !== undefined) continue
              frame.sealed =
                result?.kind === 'opened'
                  ? { state: 'pending', id: result.record.frame.id }
                  : { state: 'done' }
              if (result?.kind === 'opened') progress = true
              else resumeBlocked(cursor.topicID, frame.position, input.frame.id)
            }
          })
          if (opened !== undefined && generation === segmentGeneration) {
            const senderDID = normalizeDID(opened.senderDID)
            if (senderDID !== localDID) {
              let message: { payload?: { typ?: string; prc?: unknown; data?: unknown } } | undefined
              try {
                message = JSON.parse(toUTF(opened.payload))
              } catch {}
              const prc = message?.payload?.prc
              const protocol = protocols[cursor.protocol]
              if (
                message?.payload?.typ === 'event' &&
                typeof prc === 'string' &&
                protocol !== undefined &&
                retentionOf(protocol, prc) === 'log'
              ) {
                progress = true
                try {
                  await appEventHandlers.get(cursor.protocol)?.emit(prc, {
                    data: message.payload.data ?? {},
                    senderDID,
                    ...groupHandlerMetadata({ epoch: opened.frameEpoch }, params.groupKey),
                  })
                } catch {}
              }
            }
          }
          if (opened !== undefined) {
            await runAppLane(async () => {
              if (generation === segmentGeneration && frames[0] !== undefined) {
                frames[0].sealed = { state: 'done' }
                resumeBlocked(cursor.topicID, frames[0].position, inputs[0]?.frame.id)
              }
            })
          }
        } catch (error) {
          if (error instanceof GroupSafetyHeldError) {
            halted = true
            onSafetyHeld(error.reason)
          } else {
            const input = inputs[0]
            if (input !== undefined && isAppFrameStorageError(error))
              reportBlocked(
                cursor.protocol,
                cursor.topicID,
                input.frame.position,
                input.frame.id,
                error,
              )
            throw error
          }
        } finally {
          await runAppLane(async () => {
            for (const frame of frames) reserved.delete(frame)
            reservedSources.delete(cursor)
          })
        }
      })
      for (const turn of turns) openingTurns.add(turn)
      const results = await Promise.allSettled(turns)
      for (const turn of turns) openingTurns.delete(turn)
      const failure = results.find((result) => result.status === 'rejected')
      if (
        failure?.status === 'rejected' &&
        generation === segmentGeneration &&
        !openedOnly &&
        !disposed
      )
        throw failure.reason
      if (halted || generation !== segmentGeneration || safetyHold() !== null) break
    }
    await runAppLane(async () => {
      for (const [topicID, frames] of segment) await advanceCursor(topicID, frames)
    })
    await coverageBinding?.advance()
    return progress
  }

  let legacyDrain: Promise<unknown> = Promise.resolve()
  let drainingEpoch: number | undefined
  const deliver = async (
    generation = segmentGeneration,
    onlyTopics?: Set<string>,
  ): Promise<void> => {
    try {
      const earlyDrains: Array<Promise<boolean>> = []
      const continuation = await pull(onlyTopics, (opening) => earlyDrains.push(opening))
      if (generation !== segmentGeneration || disposed || openedOnly) return
      drainingEpoch = anchor().epoch
      let progress: boolean
      try {
        if (earlyDrains.length !== 0) progress = (await Promise.all(earlyDrains)).some(Boolean)
        else if (crypto.pending != null) progress = await drain()
        else {
          const work = legacyDrain.then(drain)
          legacyDrain = work.catch(() => {})
          progress = await work
        }
      } finally {
        drainingEpoch = undefined
      }
      if (generation === segmentGeneration) {
        if (progress) continuationBackoff = APP_CONTINUATION_BACKOFF_MS
        if (continuation || (progress && continuationTimer != null)) {
          scheduleContinuation(progress)
        }
      }
    } finally {
      if (generation === segmentGeneration && crypto.pending != null && !disposed) {
        for (const record of pendingRecords) reportUnknown(record)
        for (const name of new Set(pendingRecords.map((record) => record.frame.protocol))) {
          scheduleDelivery(() => scheduleWorker(name))
        }
      }
    }
  }

  let kickScheduled = false
  let kickRequested = false
  let kickAllTopics = false
  const kick = (onlyBusyTopics = false, externalWakeup = true): void => {
    if (disposed || safetyHold() !== null) return
    if (externalWakeup) {
      continuationBackoff = APP_CONTINUATION_BACKOFF_MS
      if (continuationTimer != null) clearTimeout(continuationTimer)
      continuationTimer = undefined
    }
    kickRequested = true
    if (!onlyBusyTopics) kickAllTopics = true
    if (kickScheduled) return
    kickScheduled = true
    kickRequested = false
    if (retryTimer != null) clearTimeout(retryTimer)
    retryTimer = undefined
    const generation = segmentGeneration
    // A capacity retry must not refetch successful topics while another slot stays occupied.
    const topics = kickAllTopics ? undefined : new Set(busyTopics)
    busyTopics.clear()
    kickAllTopics = false
    void Promise.resolve()
      .then(() => scheduleDrain(() => deliver(generation, topics)))
      .then(
        () => {
          kickScheduled = false
          retryBackoff = 1000
          if (kickRequested) kick(true)
        },
        () => {
          kickScheduled = false
          if (disposed || safetyHold() !== null) return
          if (kickRequested) {
            kick(true)
            return
          }
          retryTimer = setTimeout(() => {
            retryTimer = undefined
            kick()
          }, retryBackoff)
          retryBackoff = Math.min(retryBackoff * 2, 60_000)
        },
      )
  }

  const retryBusyPull = (topicID: string): void => {
    if (disposed || safetyHold() !== null) return
    busyTopics.add(topicID)
    if (cancelBusyRetry != null) return
    cancelBusyRetry = mux.onAppFetchAvailable(() => {
      cancelBusyRetry?.()
      cancelBusyRetry = undefined
      kick(true)
    })
  }

  const restoreRecords = (records: Array<PendingAppFrame>): void => {
    for (const record of records) {
      openedFrameIDs.delete(record.frame.id)
      reportUnknown(record)
      if (!pendingRecords.some((item) => item.frame.id === record.frame.id)) {
        pendingRecords.push(record)
      }
      const buffered = segment
        .get(record.frame.topicID)
        ?.find((frame) => frame.position === record.frame.position)
      if (
        buffered?.sealed.state === 'sealed' &&
        frameID(record.frame.topicID, buffered.sealed.bytes) === record.frame.id
      ) {
        buffered.ref = { ...record.frame }
        buffered.sealed = { state: 'pending', id: record.frame.id }
      }
    }
    pendingRecords.sort(
      (a, b) =>
        a.frame.segment - b.frame.segment ||
        compareLogPositions(a.frame.position, b.frame.position),
    )
  }

  const stopOpening = (): void => {
    openedOnly = true
    openCancellation.abort(new Error('App lane opening stopped'))
    for (const controller of pulls.keys()) controller.abort()
    if (futureTimer != null) clearTimeout(futureTimer)
    if (retryTimer != null) clearTimeout(retryTimer)
    if (continuationTimer != null) clearTimeout(continuationTimer)
    retryDelivery()
  }

  return {
    dropFrame: async (topicID, position) => {
      const unknown = await runAppLane(async () => {
        if (disposed) throw new PeerDisposedError('Peer is disposed')
        if (crypto.pending == null) throw new Error('durable app delivery is disabled')
        const unknown = pendingRecords.find(
          (record) =>
            protocols[record.frame.protocol] == null &&
            record.frame.topicID === topicID &&
            record.frame.position === position,
        )
        if (unknown != null) {
          return unknown
        }
        const frames = segment.get(topicID)
        const frame = frames?.find((item) => item.position === position)
        if (frames == null || frame == null) throw new Error('app frame is not buffered')
        if (
          reserved.has(frame) ||
          frame.sealed.state === 'pending' ||
          (frame.sealed.state === 'sealed' &&
            openedFrameIDs.has(frameID(topicID, frame.sealed.bytes)))
        )
          throw new Error('app frame is pending')
        if (frame.sealed.state !== 'sealed') throw new Error('app frame is already done')
        if (
          frames.some(
            (item) =>
              compareLogPositions(item.position, position) < 0 && item.sealed.state !== 'done',
          )
        ) {
          throw new Error('an earlier pending or sealed frame blocks the durable cursor')
        }
        frame.sealed = { state: 'done' }
        resumeBlocked(topicID, position)
        await advanceCursor(topicID, frames)
        return undefined
      })
      if (unknown !== undefined) {
        await params.completion.complete([unknown.frame.id])
        await finishRecord(unknown)
      } else await coverageBinding?.advance()
    },
    retryDelivery,
    kick,
    /** Fetches run outside the mutex; opening and non-durable handlers reserve the app lane. */
    deliver,
    note,
    pendingRecords: () => [...pendingRecords],
    stopOpening,
    releaseOpened: () => {
      openedReleased = true
      coverageBinding?.unbind()
    },
    acknowledgeOpened: async (id) => {
      const record = pendingRecords.find((record) => record.frame.id === id)
      if (record === undefined && openedFrameIDs.delete(id)) {
        // A cold owner can prove completion while the live copy still cannot reload it.
        notifyOpened()
      }
      if (record !== undefined) {
        if (openedReleased) {
          pendingRecords.splice(pendingRecords.indexOf(record), 1)
          notifyOpened()
          return
        }
        const finishing = finishRecord(record, false)
        finishingRecords.add(finishing)
        try {
          await finishing
        } finally {
          finishingRecords.delete(finishing)
          notifyOpened()
        }
      }
    },
    handoffOpened: async () => {
      deliveryHandedOff = true
      stopOpening()
      await Promise.allSettled([...pageDrains])
      while (openingTurns.size > 0) await Promise.allSettled([...openingTurns])
      await runAppLane(async () => {})
      // Live claims already hold their protocol serialisation through completion.
      if (openedFailure !== undefined) throw openedFailure
    },
    completeOpened: async () => {
      stopOpening()
      await Promise.allSettled([...pageDrains])
      // An open can have committed plaintext before returning its record to the lane.
      while (openingTurns.size > 0) await Promise.allSettled([...openingTurns])
      await runAppLane(async () => {})
      let delay = 100
      while (openedFrameIDs.size !== 0) {
        try {
          await runAppLane(async () => {
            const records = (await crypto.pending?.list()) ?? []
            const saved = records.filter((record) => openedFrameIDs.has(record.frame.id))
            if (saved.length !== openedFrameIDs.size)
              throw new AppFrameStorageError('Durable open has no saved app frame')
            restoreRecords(saved)
          })
        } catch (error) {
          if (params.openedFailureSignal?.aborted) {
            openedFailure = error
            notifyOpened()
            throw error
          }
          // Saved plaintext must survive reload faults and disposal without another open or pull.
          await new Promise((resolve) => setTimeout(resolve, delay))
          delay = Math.min(delay * 2, 15_000)
        }
      }
      retryDelivery()
      if (openedFailure !== undefined) throw openedFailure
      if (
        openedFrameIDs.size === 0 &&
        pendingRecords.length === 0 &&
        deliveringRecords.size === 0 &&
        finishingRecords.size === 0
      )
        return
      await new Promise<void>((resolve, reject) => openedWaiters.add({ resolve, reject }))
    },
    idle: async () => {
      await Promise.allSettled([...pageDrains])
      if (openedFailure !== undefined) throw openedFailure
      while (deliveringRecords.size !== 0 || finishingRecords.size !== 0)
        await Promise.allSettled([...deliveringRecords, ...finishingRecords])
      if (openedFailure !== undefined) throw openedFailure
    },
    restore: async (records): Promise<void> => {
      await runAppLane(async () => {
        restoreRecords(records)
      })
    },
    dispose: (): void => {
      disposed = true
      cancelBusyRetry?.()
      cancelBusyRetry = undefined
      busyTopics.clear()
      bufferBlockedTopics.clear()
      for (const controller of pulls.keys()) controller.abort()
      if (futureTimer != null) clearTimeout(futureTimer)
      if (retryTimer != null) clearTimeout(retryTimer)
      if (continuationTimer != null) clearTimeout(continuationTimer)
      caughtUpTimes.clear()
      for (const worker of workers.values()) {
        if (worker.timer != null) clearTimeout(worker.timer)
      }
    },
    reset: (): void => {
      const interrupted =
        (drainingEpoch != null && drainingEpoch !== anchor().epoch) ||
        [...pulls.values()].some((epoch) => epoch !== anchor().epoch)
      openCancellation.abort(new Error('App lane generation changed'))
      openCancellation = new AbortController()
      segmentGeneration += 1
      coverage = new Map()
      provenThrough.clear()
      cancelBusyRetry?.()
      cancelBusyRetry = undefined
      busyTopics.clear()
      bufferBlockedTopics.clear()
      for (const controller of pulls.keys()) controller.abort()
      reportedPruned.clear()
      if (futureTimer != null) clearTimeout(futureTimer)
      if (retryTimer != null) clearTimeout(retryTimer)
      if (continuationTimer != null) clearTimeout(continuationTimer)
      continuationTimer = undefined
      continuationBackoff = APP_CONTINUATION_BACKOFF_MS
      retryTimer = undefined
      retryBackoff = 1000
      // Old queued work still occupies its slot. New hints request one replacement.
      retryRequested = false
      caughtUpTimes.clear()
      futureTimer = undefined
      futureDeadline = undefined
      const cleared = [...blockingFrames.values()]
      blockingFrames.clear()
      if (!disposed)
        for (const event of cleared)
          notifyAppHost(onAppDeliveryResumed, { ...event, settlement: 'resumed' })
      segment = new Map()
      cursors = new Map()
      staged = new Map()
      retained = new Set()
      if (interrupted) kick()
    },
  }
}
