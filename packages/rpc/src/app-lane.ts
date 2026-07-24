import type { ProtocolDefinition } from '@enkaku/protocol'
import type { StoredMessage } from '@kumiai/hub-protocol'
import { toUTF } from '@sozai/codec'

import type { Anchor } from './anchor.js'
import type { AppCursorStore, AppWindowPruned } from './app-cursor.js'
import type { GroupCrypto, GroupUnwrapResult } from './crypto.js'
import { asLogPosition, type LogPosition } from './cursor.js'
import type { BusHandlerMaps } from './handlers.js'
import type { HubMux } from './hub-mux.js'
import { retentionOf } from './protocol.js'
import { protocolTopic } from './topic.js'

const APP_FETCH_LIMIT = 100

/**
 * One buffered app frame. `sealed` goes `null` once the frame is done — delivered or dead — but
 * the position outlives it: the cursor advances over a RUN of done frames, so a done frame's
 * place in that run is the whole of what it still has to say.
 */
export type AppFrame = { position: LogPosition; sealed: Uint8Array | null }

/**
 * The app lane's TWO read positions for one protocol's CURRENT segment — not the same position,
 * and must not be conflated:
 *
 * - `position` is the DURABLE CURSOR: the last frame this drain is done with, and the last thing
 *   {@link AppCursorStore} was told. Held here so a drain that moved nothing writes nothing.
 * - `fetched` is the LAST-FETCHED POSITION: how far the buffer has been filled from. Runs AHEAD
 *   of the cursor whenever a buffered frame is not done, and is where the next pull resumes — so
 *   a re-pull costs one short page, not the whole tail.
 *
 * Both are per SEGMENT and reset with it, alongside `topicID`.
 */
type AppCursor = { topicID: string; position: LogPosition | null; fetched: LogPosition | null }

export type AppLaneParams = {
  mux: HubMux
  crypto: GroupCrypto
  localDID: string
  protocols: Record<string, ProtocolDefinition>
  /**
   * The host's app event handlers, per protocol, as the drain calls them — the same adaptation
   * the live bus server is built from, so a drained frame and a pushed one reach the host by the
   * same door.
   */
  eventHandlers: Map<string, BusHandlerMaps['events']>
  /** App-log retention the hub is asked to hold on every topic this lane pulls, in seconds. */
  retentionSeconds: number
  appCursorStore?: AppCursorStore | undefined
  onAppWindowPruned?: ((event: AppWindowPruned) => void | Promise<void>) | undefined
  /**
   * The live anchor, read rather than held: it moves under the peer, and the topic every buffer
   * and cursor here belongs to is derived from it. Read once per lazy buffer creation, so a
   * rotation between two reads is a new segment rather than a torn one — the peer calls
   * {@link AppLane.reset} on every capture.
   */
  anchor: () => Anchor
  /** The group's commit topic, or `undefined` before the control lanes are up. */
  groupID: () => string | undefined
  /**
   * The highest epoch the group's own commit log can justify a frame having been sealed at.
   *
   * A PORT rather than this lane's own work: it pages the COMMIT log with the commit lane's
   * codecs and limits, and only the bound it answers belongs here. See the implementation in
   * `peer.ts` for why an untrusted field is acceptable for this one question.
   */
  justifiedEpochCeiling: () => Promise<number>
}

export type AppLane = {
  /**
   * Deliver every buffered app frame the handle can open AT THE EPOCH IT IS AT RIGHT NOW, and
   * leave the rest buffered. Called before each apply and once more when the walk ends.
   */
  deliver: () => Promise<void>
  /** Record a log-class frame the live lane was pushed, at the moment it arrives. */
  note: (name: string, topicID: string, message: StoredMessage) => void
  /**
   * End the segment the buffer belongs to. Called by the peer AFTER it moves the anchor, since
   * every buffer and cursor rebuilt from here reads the anchor back through {@link
   * AppLaneParams.anchor}.
   *
   * Dropping UNDELIVERED frames is not a loss: the walk already read everything openable on the
   * way here, so what remains is unopenable forever. Cursors go with the buffer; nothing is
   * cleared at the STORE, since a cursor is keyed by topic and stays true of the topic being left.
   */
  reset: () => void
}

/**
 * Take one frame into the buffer at its place in the log, or reconcile it with the copy already
 * there. The ONE way a frame enters the buffer, from either deliverer.
 *
 * A POSITION IS TAKEN ONCE: the live lane is pushed a frame and the pull reads it back out of the
 * log, so a second entry for a position already held is a second delivery of one message — the
 * duplicate the cursor exists to make impossible. A repeat is a reconcile, never an append, and
 * only ever marks a frame DONE, never undoes it: `sealed: null` says the live lane had this frame
 * at its seal epoch, and a pull reading it back afterwards must not redeliver it.
 *
 * Kept in log order by insertion, not append, since the two deliverers do not arrive in one order:
 * a pull runs from behind the live stream and returns frames the pushes already brought.
 */
function takeAppFrame(frames: Array<AppFrame>, incoming: AppFrame): void {
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
    anchor,
    groupID,
    justifiedEpochCeiling,
  } = params

  /**
   * The current SEGMENT's retained app frames, per protocol, in log order. A segment is the run of
   * epochs between two roster changes — exactly the run one app topic spans — so it is pulled once
   * (below) and dispensed epoch by epoch as the commit walk passes through it.
   */
  let segment = new Map<string, Array<AppFrame>>()

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

  /** App topics whose retention this segment has already been asked for. See {@link loadSegment}. */
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
    const op = tail.then(fn)
    tail = op.then(
      () => {},
      () => {},
    )
    return op
  }

  /**
   * Tell the host that a topic's retention floor has passed this peer's read position: the frames
   * between the two aged out unread, and a returning member is holding a partial history it has no
   * other way to know is partial. A gap below retention is REPORTED, never silent.
   *
   * `oldest > cursor` is the whole test and the only one available: nothing anywhere records which
   * frames used to sit between them, so this over-reports (a cursor frame aging out with nothing
   * behind it reads the same) rather than ever under-reporting. With no cursor there is no gap to
   * speak of.
   */
  const reportPrunedWindow = async (
    name: string,
    cursor: LogPosition | null,
    oldest: string | null,
  ): Promise<void> => {
    const group = groupID()
    if (onAppWindowPruned == null || group == null) return
    if (cursor == null || oldest == null || oldest <= cursor) return
    try {
      await onAppWindowPruned({ groupID: group, protocol: name, cursor, oldest })
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
  const laneFor = async (name: string): Promise<{ frames: Array<AppFrame>; cursor: AppCursor }> => {
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
      cursor = { topicID, position: stored != null ? asLogPosition(stored) : null, fetched: null }
      cursors.set(name, cursor)
    }
    return { frames, cursor }
  }

  /**
   * Merge the live lane's staged pushes into the buffer, then pull this segment's log forward from
   * the LAST-FETCHED position and buffer whatever is new.
   *
   * PULLED EVERY DRAIN, not once per segment: the log grows while this peer walks, and a frame
   * published mid-walk is one a single pull can never see. The push carries its own log position
   * (`StoredMessage.logPosition`), so {@link takeAppFrame} recognises a frame the buffer already
   * holds and a re-pull returns only what was genuinely never delivered.
   *
   * From `fetched`, not the cursor: the cursor is pinned behind any frame the walk has not
   * reached, and resuming there would re-read the whole tail every drain. MERGED BEFORE PULLED,
   * both inside one {@link runAppLane} task: a staged frame merged after the pull would be a
   * position above the pull's end, which the cursor may not walk past unproven.
   *
   * Subscribed before pulled: the hub gates a topic fetch on the caller's own subscription, and a
   * segment reached by ROTATING onto it mid-walk has never been subscribed.
   *
   * A FAILED FETCH RAISES. The caller's walk stops on the failure rather than stepping over an
   * epoch whose frames were never read, and `fetched` is moved only by pages that arrived.
   */
  const loadSegment = async (): Promise<void> => {
    // One protocol per lane, sharing nothing (a topic is derived per protocol NAME). Paged
    // concurrently — otherwise each protocol waits out the previous one's whole pull.
    const loadOne = async (name: string): Promise<void> => {
      const { frames, cursor } = await laneFor(name)
      const topicID = cursor.topicID
      // Carrying the window on the listener-less subscribe too: a member that is AWAY reaches a
      // segment by rotating onto it mid-walk, pulled here and never listened on.
      if (!retained.has(topicID)) {
        retained.add(topicID)
        mux.retainTopic(topicID, { retention: retentionSeconds })
      }

      // A push landed on a topic this peer has since rotated off names a position in a log this
      // segment's cursor knows nothing about. Dropped, not merged.
      for (const push of staged.get(name) ?? []) {
        if (push.topicID === topicID) takeAppFrame(frames, push.frame)
      }
      staged.delete(name)

      // The gap question is asked on the segment's FIRST pull only: it compares where this peer
      // had read to against where the hub's retention now begins, and every later pull starts
      // from a position this peer reached itself.
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
    // NOT `allSettled`: a failed pull must reach the caller, whose walk stops on it rather than
    // stepping over an epoch whose frames were never read.
    await Promise.all(Object.keys(protocols).map(loadOne))
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
    const cursor = cursors.get(name)
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
   * Take the staged pushes into the buffer and move the durable cursor over them, off the back of
   * live traffic alone — a peer that is online and walks no commit still has to keep its position,
   * or a group quiet on the commit lane and busy on the app lane re-delivers its whole backlog on
   * the next restart.
   *
   * Does NOT deliver: delivery unwraps against the live handle, and this runs outside the commit
   * mutex where the handle can be mid-ratchet — a frame classified at one epoch and unwrapped at
   * the next would be wrongly called dead. So the buffer fills and the cursor advances, and
   * anything still holding bytes waits for {@link deliver}, which runs where the handle is held
   * still.
   *
   * COALESCED: a burst of pushes collapses into one pass; the flag clears on entry so a frame
   * arriving mid-pass schedules the next one instead of being left staged.
   */
  let syncScheduled = false
  const scheduleSync = (): void => {
    if (syncScheduled) return
    syncScheduled = true
    void runAppLane(async () => {
      syncScheduled = false
      await loadSegment()
      for (const [name, frames] of segment) await advanceCursor(name, frames)
    }).catch(() => {
      // A hub that would not answer leaves the cursor where it is and the frames staged or
      // buffered; the next push, or the next drain, asks again.
    })
  }

  /**
   * Record a log-class frame the LIVE lane was pushed, at the moment it arrives.
   *
   * THE OTHER DELIVERER TAKING THE SAME READ POSITION: before the push carried its own log
   * position there was nothing for the live path to write down, so the cursor sat behind every
   * frame an online peer had already been given and every re-pull read them all back.
   *
   * WHAT IS RECORDED IS DONE-NESS, NOT DELIVERY — the same thing here, since the transport that
   * carries this frame to the host unwraps with the same handle:
   *
   * - AT the handle's epoch: this is the live lane's one chance, now — whatever the outcome, the
   *   frame is DONE (the drain's own paths deliver or drop exactly as the transport does).
   * - ABOVE it: ahead of the walk. The transport cannot open it, so its bytes are kept for the
   *   drain to deliver once the walk reaches that epoch — whether the claim is justified is the
   *   drain's question, asked with a network read this path must not make.
   * - BELOW it, or unreadable: dead. MLS ratchets forward, so no epoch this peer will ever hold
   *   again opens those bytes.
   *
   * Read HERE, not at the merge: the handle moves under this mutex-free push loop, so the answer
   * is only true of the moment the frame arrived.
   *
   * A MAILBOX frame is skipped outright — nothing to advance over. The class travels with the push
   * because ephemeral and logged app traffic share one topic, and guessing from the topic would
   * move the cursor over frames the log does not contain.
   */
  const note = (name: string, topicID: string, message: StoredMessage): void => {
    const position = message.logPosition
    if (position == null) return
    const sealedAt = crypto.frameEpoch(message.payload)
    const ahead = sealedAt != null && sealedAt > crypto.epoch()
    let pushes = staged.get(name)
    if (pushes == null) {
      pushes = []
      staged.set(name, pushes)
    }
    pushes.push({
      topicID,
      frame: { position: asLogPosition(position), sealed: ahead ? message.payload : null },
    })
    scheduleSync()
  }

  const drain = async (): Promise<void> => {
    await loadSegment()
    // Read once per drain and only if a frame actually claims to be ahead: the log is a network
    // read, the honest buffer holds no such claim, and this handle's epoch does not move under a
    // single drain.
    let ceiling: number | null = null
    const justifies = async (claim: number): Promise<boolean> => {
      ceiling ??= await justifiedEpochCeiling()
      return claim <= ceiling
    }
    for (const [name, frames] of segment) {
      const events = appEventHandlers.get(name)
      if (events == null || frames.length === 0) continue
      for (const frame of frames) {
        const sealed = frame.sealed
        if (sealed == null) continue // done on an earlier pass, and only holding its place
        const sealedAt = crypto.frameEpoch(sealed)
        if (sealedAt !== crypto.epoch()) {
          // Not sealed at the handle's current epoch. Ahead of the walk AND justified by the
          // commit log: keep its bytes and place. Otherwise — below the walk, an epoch no member
          // could have sealed at, or unreadable — it is dead, and dead is done.
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
        try {
          // Same door as the live push: emit the retained frame's plaintext into the
          // per-protocol emitter the live bus is also built from. No listener → no-op.
          await events.emit(prc, { data: message.payload.data ?? {}, senderDID: opened.senderDID })
        } catch {
          // A host listener that threw has been delivered to. Re-delivering on the next pull
          // would retry the host's own bug at it, so the frame is consumed.
        }
      }
      await advanceCursor(name, frames)
    }
  }

  return {
    /**
     * MUST run BEFORE the apply, never after: once the commit applies the handle holds different
     * key material, and those bytes are ciphertext forever. Per-FRAME-EPOCH, not per-rotation:
     * every epoch inside a segment is dispensed as the walk passes through it.
     *
     * Which frames are this epoch's is read from their own cleartext (`crypto.frameEpoch`), not
     * found by trying every frame and catching, since `unwrap` throwing cannot distinguish "not my
     * epoch yet" from "never again". A FUTURE-epoch claim is bounded by
     * {@link AppLaneParams.justifiedEpochCeiling} for the same reason — unbounded, it would pin
     * the cursor behind it forever.
     *
     * The buffer is walked whole, not stopped at the first frame that is not this epoch's, since
     * the front can still hold a frame from an epoch the handle already passed (a journal replay
     * advances it before this pull runs).
     *
     * THE CURSOR ADVANCES over a run of frames this drain is DONE with, stopping dead at the first
     * it is not — see {@link advanceCursor} for the rule.
     *
     * A FAILED PULL STALLS THE WALK: {@link loadSegment} raising propagates and no epoch is passed
     * unread, since the pull is a retry and the delivery is not.
     *
     * NOT delivered: this member's own frames, matching the live fan-out never echoing a publisher
     * its own broadcast.
     *
     * TAKEN UNDER THE APP LANE'S MUTEX, excluding the live lane's own cursor work
     * ({@link scheduleSync}), which runs off the mux's push loop under no lock at all. Two
     * deliverers writing one DURABLE read position corrupts it on any interleave: a push splicing
     * the ordered buffer mid-walk re-reads or steps over a frame, and a sync landing between
     * {@link advanceCursor}'s read of a done run and its splice silently drops frames.
     *
     * NO DEADLOCK against the peer's commit mutex: every call here is from inside `runSerial`,
     * taking the app lane second, and nothing inside it takes `runSerial` back — the one path that
     * could, a host handler re-entering from the delivery below, already deadlocks on `runSerial`
     * itself.
     */
    deliver: (): Promise<void> => runAppLane(drain),
    note,
    reset: (): void => {
      segment = new Map()
      cursors = new Map()
      // Staged pushes go with the buffer for the same reason: a rotation mid-push carries its own
      // topic and is dropped by the merge if it disagrees with the live anchor.
      staged = new Map()
      retained = new Set()
    },
  }
}
