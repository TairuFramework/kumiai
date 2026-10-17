import type { ProtocolDefinition } from '@enkaku/protocol'
import { normalizeDID } from '@kokuin/token'
import type { StoredMessage } from '@kumiai/hub-protocol'
import type { HubFetchTopicResult } from '@kumiai/hub-tunnel'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromUTF, toB64U, toUTF } from '@sozai/codec'

import type { Anchor } from './anchor.js'
import { decodeAppAAD, encodeAppAAD } from './app-aad.js'
import type { AppCursorStore, AppWindowPruned } from './app-cursor.js'
import { createMonotoneClock } from './clock.js'
import type { SafetyHold } from './control/safety.js'
import {
  type GroupCrypto,
  type GroupUnwrapResult,
  isAppFrameStorageError,
  isFrameAhead,
  type PendingAppFrame,
} from './crypto.js'
import {
  asLogPosition,
  compareLogPositions,
  InvalidLogPositionError,
  type LogPosition,
} from './cursor.js'
import { GroupSafetyHeldError, PeerDisposedError } from './errors.js'
import type { BusHandlerMaps } from './handlers.js'
import { notifyHost } from './host-notice.js'
import { APP_OUTSTANDING_FETCHES_MAX, AppFetchBusyError, type HubMux } from './hub-mux.js'
import { retentionOf } from './protocol.js'
import { protocolTopic } from './topic.js'

export { APP_OUTSTANDING_FETCHES_MAX } from './hub-mux.js'

const APP_FETCH_LIMIT = 100
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

export type AppDeliveryResumed = Omit<AppDeliveryStalled, 'error'>

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

export type AppLaneParams = {
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
  /**
   * The live anchor, read rather than held: it moves under the peer, and the topic every buffer
   * and cursor here belongs to is derived from it. Read once per lazy buffer creation, so a
   * rotation between two reads is a new segment rather than a torn one — the peer calls
   * {@link AppLane.reset} on every capture.
   */
  anchor: () => Anchor
  /** The group's commit topic, or `undefined` before the control lanes are up. */
  groupID: () => string | undefined
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
  /**
   * End the segment the buffer belongs to. Called by the peer AFTER it moves the anchor, since
   * every buffer and cursor rebuilt from here reads the anchor back through {@link
   * AppLaneParams.anchor}.
   *
   * Cursors stay in the store, keyed by topic. Pending records survive in the delivery queue.
   */
  reset: () => void
  /** Opened records awaiting the delivery worker. */
  pendingRecords: () => Array<PendingAppFrame>
  /** Restore durable records before the first retained pull. */
  restore: (records: Array<PendingAppFrame>) => Promise<void>
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
export function createAppLane(params: AppLaneParams): AppLane {
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
    groupID,
  } = params

  /**
   * The current SEGMENT's retained app frames, per protocol, in log order. A segment is the run of
   * epochs between two roster changes — exactly the run one app topic spans — so it is pulled once
   * (below) and dispensed epoch by epoch as the commit walk passes through it.
   */
  let segment = new Map<string, Array<AppFrame>>()
  let segmentGeneration = 0
  const pendingRecords: Array<PendingAppFrame> = []
  const pulls = new Map<AbortController, number>()
  const reportedPruned = new Map<string, Set<string>>()
  const blockingFrames = new Map<string, AppDeliveryResumed>()
  let disposed = false
  let futureTimer: ReturnType<typeof setTimeout> | undefined
  let futureDeadline: number | undefined
  let retryScheduled = false
  let retryRequested = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryBackoff = 1000
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
  const blockingKey = (topicID: string, position: string): string => `${topicID}\u0000${position}`
  const resumeBlocked = (topicID: string, position: string): void => {
    const key = blockingKey(topicID, position)
    const event = blockingFrames.get(key)
    if (event == null || disposed) return
    blockingFrames.delete(key)
    notifyAppHost(onAppDeliveryResumed, event)
  }
  const resumeUnknown = (record: PendingAppFrame): void => {
    const event = reportedUnknown.get(record.frame.id)
    if (event == null || disposed) return
    reportedUnknown.delete(record.frame.id)
    notifyAppHost(onAppDeliveryResumed, event)
  }
  const reportBlocked = (
    protocol: string,
    topicID: string,
    position: string,
    error: Error,
    reason?: AppDeliveryStalled['reason'],
  ): void => {
    const key = blockingKey(topicID, position)
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

  /** The current segment's read positions, per protocol. See {@link AppCursor}. */
  let cursors = new Map<string, AppCursor>()

  /**
   * Log-class app frames the LIVE lane was pushed and the buffer has not taken in yet, per
   * protocol, with the topic each was pushed on.
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
   * The buffer for one protocol, and the two positions that go with it, created on first use.
   *
   * Lazy because the LIVE lane can reach the buffer before any drain does — a peer that is online
   * and has walked no commit still has to keep a read position over what it was pushed — so the
   * durable cursor cannot be something only a pull establishes.
   */
  const laneFor = async (
    name: string,
  ): Promise<{ frames: Array<AppFrame>; cursor: AppCursor } | undefined> => {
    const generation = segmentGeneration
    let frames = segment.get(name)
    if (frames == null) {
      frames = []
      segment.set(name, frames)
    }
    let cursor = cursors.get(name)
    if (cursor == null) {
      const at = anchor()
      const topicID = protocolTopic(at.secret, at.epoch, name)
      const stored = (await appCursorStore?.load(topicID)) ?? null
      // Reset runs outside this mutex; an old cursor must not enter the new segment.
      if (generation !== segmentGeneration) return
      cursor = {
        topicID,
        position: stored != null ? asLogPosition(stored) : null,
        fetched: null,
        accepted: stored != null ? asLogPosition(stored) : null,
      }
      cursors.set(name, cursor)
    }
    return { frames, cursor }
  }

  /** Snapshot and merge under the app mutex. Hub I/O holds no lane reservation. */
  const pull = async (onlyTopics?: Set<string>): Promise<void> => {
    if (disposed || safetyHold() !== null) return
    const controller = new AbortController()
    const { signal } = controller
    pulls.set(controller, anchor().epoch)
    let deadline: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const stopped = (): boolean => {
      if (deadline != null && Date.now() >= deadline) controller.abort()
      return disposed || signal.aborted || safetyHold() !== null
    }
    let bytes = 0
    try {
      const topics = await runAppLane(async () => {
        const current: Array<PullTopic> = []
        for (const name of Object.keys(protocols)) {
          if (stopped()) break
          const generation = segmentGeneration
          const lane = await laneFor(name)
          if (lane == null || generation !== segmentGeneration || stopped()) break
          const { frames, cursor } = lane
          const { topicID } = cursor
          if (!retained.has(topicID)) {
            retained.add(topicID)
            mux.retainTopic(topicID, { retention: retentionSeconds })
          }
          for (const push of staged.get(name) ?? []) {
            if (
              push.topicID === topicID &&
              frames.length < APP_BUFFER_MAX_FRAMES &&
              (cursor.position == null ||
                compareLogPositions(push.frame.position, cursor.position) > 0)
            ) {
              takeAppFrame(frames, push.frame, crypto.pending != null)
            }
          }
          staged.delete(name)
          current.push({
            name,
            topicID,
            fetched: cursor.fetched ?? cursor.position,
            position: cursor.position,
            generation,
            limit: Math.min(APP_FETCH_LIMIT, APP_BUFFER_MAX_FRAMES - frames.length),
          })
        }
        const departing: Array<PullTopic> = []
        return [...current, ...departing]
      })
      const queue = topics
        .filter((topic) => onlyTopics == null || onlyTopics.has(topic.topicID))
        .map((topic) => ({ topic, pages: 0 }))
      const fetchNext = async (): Promise<void> => {
        while (queue.length > 0) {
          const item = queue.shift()
          if (item == null) return
          const { topic, pages } = item
          if (stopped() || bytes >= APP_PULL_MAX_BYTES) return
          if (topic.limit === 0) continue
          if (deadline == null) {
            deadline = Date.now() + APP_PULL_DEADLINE_MS
            timer = setTimeout(() => controller.abort(), APP_PULL_DEADLINE_MS)
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
            const cursor = cursors.get(topic.name)
            const frames = segment.get(topic.name)
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
            for (const message of result.messages) {
              if (stopped() || frames.length >= APP_BUFFER_MAX_FRAMES) break
              // A frame larger than an entire fresh budget cannot be legitimate.
              const oversized = bytes === 0 && message.payload.byteLength > APP_PULL_MAX_BYTES
              if (!oversized && bytes + message.payload.byteLength > APP_PULL_MAX_BYTES) return
              if (!oversized) bytes += message.payload.byteLength
              const position = asLogPosition(message.sequenceID)
              const fetched = cursor.fetched ?? cursor.position
              if (fetched == null || compareLogPositions(position, fetched) > 0) {
                cursor.fetched = position
              }
              if (cursor.accepted != null && compareLogPositions(position, cursor.accepted) <= 0)
                continue
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
          if (
            next != null &&
            result.messages.length >= topic.limit &&
            pages + 1 < APP_PULL_MAX_PAGES
          ) {
            // Requeue one page at a time so busy topics cannot overtake unvisited topics.
            queue.push({ topic: next, pages: pages + 1 })
          }
        }
      }
      const results = await Promise.allSettled(
        Array.from({ length: Math.min(APP_OUTSTANDING_FETCHES_MAX, topics.length) }, fetchNext),
      )
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    } finally {
      clearTimeout(timer)
      pulls.delete(controller)
    }
  }

  /**
   * Move this topic's read position over the frames the drain has finished with, and persist it.
   *
   * The advance stops at the FIRST frame that is not done — the safety property: a cursor may only
   * pass a frame that is DELIVERED or DEAD. A done frame further along is left in place, since a
   * position is a place in the LOG and passing it passes everything before it too.
   *
   * The passed frames are dropped from the buffer here and only here: the cursor is what
   * remembers them from now on.
   */
  const advanceCursor = async (name: string, frames: Array<AppFrame>): Promise<void> => {
    if (segment.get(name) !== frames) return
    const cursor = cursors.get(name)
    if (cursor == null) return
    let passed = 0
    let position: LogPosition | null = null
    while (passed < frames.length && (frames[passed] as AppFrame).sealed.state === 'done') {
      position = (frames[passed] as AppFrame).position
      passed += 1
    }
    if (position == null || position === cursor.position) return
    await appCursorStore?.save(cursor.topicID, position)
    cursor.position = position
    if (cursor.accepted == null || compareLogPositions(position, cursor.accepted) > 0) {
      cursor.accepted = position
    }
    frames.splice(0, passed)
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
    const cursor = cursors.get(record.frame.protocol)
    if (cursor?.topicID !== record.frame.topicID) return false
    return (segment.get(record.frame.protocol) ?? []).some(
      (frame) =>
        compareLogPositions(frame.position, record.frame.position) < 0 &&
        frame.sealed.state === 'sealed',
    )
  }

  const finishRecord = async (record: PendingAppFrame): Promise<void> => {
    if (disposed) return
    await crypto.pending?.complete(record.frame.id)
    if (disposed) return
    await runAppLane(async () => {
      const index = pendingRecords.findIndex((item) => item.frame.id === record.frame.id)
      if (index !== -1) pendingRecords.splice(index, 1)
      resumeBlocked(record.frame.topicID, record.frame.position)
      resumeUnknown(record)
      const cursor = cursors.get(record.frame.protocol)
      if (cursor?.topicID !== record.frame.topicID) return
      const frames = segment.get(record.frame.protocol)
      if (frames == null) return
      const buffered = frames.find((frame) => frame.position === record.frame.position)
      if (buffered?.sealed.state === 'pending' && buffered.sealed.id === record.frame.id) {
        buffered.sealed = { state: 'done' }
      }
      await advanceCursor(record.frame.protocol, frames)
    })
  }

  const deliverRecord = async (record: PendingAppFrame): Promise<void> => {
    if (disposed) return
    if (protocols[record.frame.protocol] == null) return
    let message: { payload?: { typ?: string; prc?: unknown; data?: unknown } } | undefined
    try {
      message = JSON.parse(toUTF(record.payload))
    } catch {
      // A malformed durable frame is acknowledged without reaching the host.
    }
    const prc = message?.payload?.prc
    const protocol = protocols[record.frame.protocol]
    const events = appEventHandlers.get(record.frame.protocol)
    if (
      normalizeDID(record.senderDID) !== localDID &&
      message?.payload?.typ === 'event' &&
      typeof prc === 'string' &&
      protocol != null &&
      retentionOf(protocol, prc) === 'log' &&
      events != null
    ) {
      const event = {
        data: message.payload.data ?? {},
        senderDID: normalizeDID(record.senderDID),
        frame: record.frame,
      }
      await events.emit(prc, event)
    }
    if (!disposed) await finishRecord(record)
  }

  const scheduleWorker = (name: string, delay = 0): void => {
    if (disposed || crypto.pending == null) return
    let worker = workers.get(name)
    if (worker == null) {
      worker = { running: false, requested: false, retryNow: false, backoff: 1000, delayed: false }
      workers.set(name, worker)
    }
    worker.requested = true
    if (worker.running || worker.timer != null) return
    worker.delayed = delay > 0
    worker.timer = setTimeout(() => {
      if (disposed) return
      worker.timer = undefined
      worker.running = true
      worker.requested = false
      void (async () => {
        let failed = false
        try {
          while (!disposed) {
            const record = orderedRecords(name)[0]
            if (
              record == null ||
              protocols[record.frame.protocol] == null ||
              (await runAppLane(async () => blockedByEarlierSealed(record)))
            )
              break
            if (disposed) break
            try {
              await deliverRecord(record)
              worker.backoff = 1000
            } catch {
              failed = true
              break
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
        cursors.get(name)?.topicID !== topicID &&
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
    void pull()
      .then(() =>
        runAppLane(async () => {
          if (safetyHold() !== null || disposed) return
          for (const [name, frames] of segment) await advanceCursor(name, frames)
        }),
      )
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
  const note = (name: string, topicID: string, message: StoredMessage, failure: unknown): void => {
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
    let pushes = staged.get(name)
    if (pushes == null) {
      pushes = []
      staged.set(name, pushes)
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

  const drain = async (): Promise<void> => {
    if (disposed) return
    const generation = segmentGeneration
    applyCaughtUpTimes()
    for (const [name, frames] of segment) {
      const events = appEventHandlers.get(name)
      const cursor = cursors.get(name)
      if (cursor == null || frames.length === 0 || (events == null && crypto.pending == null)) {
        continue
      }
      for (const frame of frames) {
        if (frame.sealed.state !== 'sealed') continue
        if (disposed || generation !== segmentGeneration || safetyHold() !== null) break
        const sealed = frame.sealed.bytes
        // Unreadable bytes are dead. Past and future are the open's locked answer, below.
        if (crypto.frameEpoch(sealed) == null) {
          frame.sealed = { state: 'done' }
          resumeBlocked(cursor.topicID, frame.position)
          continue
        }
        const aad = crypto.frameAAD(sealed)
        const decoded = aad == null ? null : decodeAppAAD(aad)
        if ((aad != null && decoded == null) || crypto.pending != null) {
          if (decoded?.topicID !== cursor.topicID || decoded.intent !== 'log') {
            frame.sealed = { state: 'done' }
            resumeBlocked(cursor.topicID, frame.position)
            continue
          }
        }
        const ref =
          crypto.pending == null
            ? undefined
            : {
                id: frameID(cursor.topicID, sealed),
                topicID: cursor.topicID,
                protocol: name,
                segment: anchor().epoch,
                position: frame.position,
              }
        const caughtUpBefore = commitLaneCaughtUp()
        const workVersion = commitWorkVersion()
        let opened: GroupUnwrapResult
        try {
          // `crypto.unwrap` always returns the full result — `senderDID` is REQUIRED — so there is
          // no bare-`Uint8Array` shortcut left to normalize away here. `expectedAAD` is bound to
          // the cursor's own topic, the authoritative answer to "what lane is this drain reading".
          opened = await crypto.unwrap(sealed, {
            expectedAAD: encodeAppAAD({ topicID: cursor.topicID, intent: 'log' }),
            ...(ref == null ? {} : { frame: ref }),
          })
        } catch (error) {
          if (error instanceof GroupSafetyHeldError) {
            onSafetyHeld(error.reason)
            break
          }
          if (isFrameAhead(error)) {
            if (disposed || safetyHold() !== null) break
            if (caughtUpBefore && commitLaneCaughtUp() && workVersion === commitWorkVersion()) {
              frame.caughtUpAt ??= now()
              const remaining = APP_FUTURE_HOLD_MS - (now() - frame.caughtUpAt)
              if (
                error.frameEpoch > error.handleEpoch + APP_FUTURE_EPOCH_WINDOW ||
                remaining <= 0
              ) {
                frame.sealed = { state: 'done' }
                resumeBlocked(cursor.topicID, frame.position)
                continue
              }
              const deadline = frame.caughtUpAt + APP_FUTURE_HOLD_MS
              if (futureDeadline == null || deadline < futureDeadline) {
                if (futureTimer != null) clearTimeout(futureTimer)
                futureDeadline = deadline
                futureTimer = setTimeout(() => {
                  futureTimer = undefined
                  futureDeadline = undefined
                  if (!disposed && safetyHold() === null && commitLaneCaughtUp()) retryDelivery()
                }, remaining)
              }
            }
            if (crypto.pending != null) {
              reportBlocked(
                name,
                cursor.topicID,
                frame.position,
                new Error(`frame claims future epoch ${error.frameEpoch}`),
                'future-epoch',
              )
            }
            continue
          }
          if (crypto.pending != null && isAppFrameStorageError(error)) {
            reportBlocked(name, cursor.topicID, frame.position, error)
            throw error
          }
          // A past epoch is not retained. Other refusals also finish without delivery.
          frame.sealed = { state: 'done' }
          resumeBlocked(cursor.topicID, frame.position)
          continue
        }
        if (ref != null) {
          const record = {
            frame: ref,
            payload: opened.payload,
            senderDID: opened.senderDID,
          }
          frame.sealed = { state: 'pending', id: record.frame.id }
          pendingRecords.push(record)
          continue
        }
        // Opened, so it is done whatever the payload turns out to be — every path below either
        // delivers it or drops it exactly as the live transport would.
        frame.sealed = { state: 'done' }
        resumeBlocked(cursor.topicID, frame.position)
        if (events == null) continue
        // This `unwrap` is its own ingress — not fed by `peer.ts`'s normalized inbound path — so
        // the recovered sender is normalized HERE, once, before either use below: `localDID` (the
        // param above) is already normalized at peer construction, and the two must compare on
        // the same canonical form for the self-echo check to hold across DID forms.
        const senderDID = normalizeDID(opened.senderDID)
        if (senderDID === localDID) continue // its own echo, as the live path would not
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
        const protocol = protocols[name]
        if (protocol === undefined) continue
        if (retentionOf(protocol, prc) !== 'log') continue
        try {
          // Same door as the live push: emit the retained frame's plaintext into the
          // per-protocol emitter the live bus is also built from. No listener → no-op.
          await events.emit(prc, { data: message.payload.data ?? {}, senderDID })
        } catch {
          // A host listener that threw has been delivered to. Re-delivering on the next pull
          // would retry the host's own bug at it, so the frame is consumed.
        }
      }
      await advanceCursor(name, frames)
    }
  }

  let drainingEpoch: number | undefined
  const deliver = async (
    generation = segmentGeneration,
    onlyTopics?: Set<string>,
  ): Promise<void> => {
    try {
      await pull(onlyTopics)
      await runAppLane(async () => {
        if (generation !== segmentGeneration || disposed) return
        drainingEpoch = anchor().epoch
        try {
          await drain()
        } finally {
          drainingEpoch = undefined
        }
      })
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
  const kick = (onlyBusyTopics = false): void => {
    if (disposed || safetyHold() !== null) return
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

  return {
    dropFrame: (topicID, position) =>
      runAppLane(async () => {
        if (disposed) throw new PeerDisposedError('Peer is disposed')
        if (crypto.pending == null) throw new Error('durable app delivery is disabled')
        const unknown = pendingRecords.find(
          (record) =>
            protocols[record.frame.protocol] == null &&
            record.frame.topicID === topicID &&
            record.frame.position === position,
        )
        if (unknown != null) {
          await crypto.pending.complete(unknown.frame.id)
          pendingRecords.splice(pendingRecords.indexOf(unknown), 1)
          resumeUnknown(unknown)
          return
        }
        const entry = [...cursors.entries()].find(([, cursor]) => cursor.topicID === topicID)
        if (entry == null) throw new Error('app frame is not buffered')
        const [name] = entry
        const frames = segment.get(name)
        const frame = frames?.find((item) => item.position === position)
        if (frames == null || frame == null) throw new Error('app frame is not buffered')
        if (frame.sealed.state === 'pending') throw new Error('app frame is pending')
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
        await advanceCursor(name, frames)
      }),
    retryDelivery,
    kick,
    /** Fetches run outside the mutex; opening and non-durable handlers reserve the app lane. */
    deliver,
    note,
    pendingRecords: () => [...pendingRecords],
    restore: async (records): Promise<void> => {
      await runAppLane(async () => {
        for (const record of records) {
          reportUnknown(record)
          if (!pendingRecords.some((item) => item.frame.id === record.frame.id)) {
            pendingRecords.push(record)
          }
        }
        pendingRecords.sort(
          (a, b) =>
            a.frame.segment - b.frame.segment ||
            compareLogPositions(a.frame.position, b.frame.position),
        )
      })
    },
    dispose: (): void => {
      disposed = true
      cancelBusyRetry?.()
      cancelBusyRetry = undefined
      busyTopics.clear()
      for (const controller of pulls.keys()) controller.abort()
      if (futureTimer != null) clearTimeout(futureTimer)
      if (retryTimer != null) clearTimeout(retryTimer)
      caughtUpTimes.clear()
      for (const worker of workers.values()) {
        if (worker.timer != null) clearTimeout(worker.timer)
      }
    },
    reset: (): void => {
      const interrupted =
        (drainingEpoch != null && drainingEpoch !== anchor().epoch) ||
        [...pulls.values()].some((epoch) => epoch !== anchor().epoch)
      segmentGeneration += 1
      cancelBusyRetry?.()
      cancelBusyRetry = undefined
      busyTopics.clear()
      for (const controller of pulls.keys()) controller.abort()
      reportedPruned.clear()
      if (futureTimer != null) clearTimeout(futureTimer)
      if (retryTimer != null) clearTimeout(retryTimer)
      retryTimer = undefined
      retryBackoff = 1000
      // Old queued work still occupies its slot. New hints request one replacement.
      retryRequested = false
      caughtUpTimes.clear()
      futureTimer = undefined
      futureDeadline = undefined
      const cleared = [...blockingFrames.values()]
      blockingFrames.clear()
      if (!disposed) for (const event of cleared) notifyAppHost(onAppDeliveryResumed, event)
      segment = new Map()
      cursors = new Map()
      // Staged pushes go with the buffer for the same reason: a rotation mid-push carries its own
      // topic and is dropped by the merge if it disagrees with the live anchor.
      staged = new Map()
      retained = new Set()
      if (interrupted) kick()
    },
  }
}
