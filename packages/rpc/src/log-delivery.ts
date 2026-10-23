import type { HubFetchTopicResult } from '@kumiai/hub-tunnel'

import type {
  AppOutbox,
  AppOutboxAcceptance,
  AppOutboxEntry,
  AppSettlementObligation,
} from './app-outbox.js'
import type {
  AppPublicationPort,
  AppPublicationSnapshot,
  PreparedAppPublication,
} from './app-publication.js'
import type { SafetyHold } from './control/safety.js'
import { asLogPosition, type LogPosition } from './cursor.js'
import { AppOutboxFullError } from './errors.js'

export type EpochFloor = { epoch: number; position: LogPosition | null; covered: boolean }
export type AppOutboxCleared = { reason: 'removed'; seqs: Array<number> }
export type CoveredFetchResult = HubFetchTopicResult

export function checkedFetchResult(result: HubFetchTopicResult): CoveredFetchResult {
  if (typeof result.gap !== 'boolean') {
    throw new Error('Commit fetch requires a boolean gap')
  }
  return result
}

type Publication = {
  epoch: number
  floor: LogPosition | null
  acknowledged: number
  sequenceID: string
  frame: PreparedAppPublication
}
/** A delivered entry kept for a member that rejoins later and could not read its epoch. */
type Delivered = Pick<AppOutboxEntry, 'protocol' | 'prc' | 'data'> & {
  epoch: number
  incarnation: number
  at: number
  seq?: number
}
type LogFrame = { topicID: string; payload: Uint8Array; publishID: string }

function copySnapshot(value: AppPublicationSnapshot): AppPublicationSnapshot {
  return {
    ...value,
    identity: { ...value.identity, authenticator: Uint8Array.from(value.identity.authenticator) },
  }
}

function copyPrepared(value: PreparedAppPublication): PreparedAppPublication {
  return {
    entry: {
      ...value.entry,
      data: Uint8Array.from(value.entry.data),
      lastAttempt: value.entry.lastAttempt === null ? null : { ...value.entry.lastAttempt },
    },
    payload: Uint8Array.from(value.payload),
    snapshot: copySnapshot(value.snapshot),
  }
}

export type LogDeliveryParams = {
  failureSignal?: AbortSignal
  queue: AppOutboxAcceptance
  ready: () => Promise<void>
  floor: () => EpochFloor
  held: () => boolean
  handoffHeld?: () => boolean
  safetyHold?: () => SafetyHold
  probe: () => Promise<CoveredFetchResult>
  pull: () => Promise<void>
  heal: () => Promise<void>
  prepare: AppPublicationPort['prepare']
  snapshot: AppPublicationPort['snapshot']
  loadSettlement: (seq: number) => Promise<AppSettlementObligation | null>
  publish: (frame: LogFrame) => Promise<{ sequenceID: string }> | null
  recordSettlement: AppOutbox['recordSettlement']
  remove: AppOutbox['remove']
  clear: () => Promise<void>
  cleared: (notice: AppOutboxCleared) => void
  /** How long a delivered entry stays eligible to be sent again to a rejoined member. */
  deliveredWindowMs: number
  /** How many delivered entries are kept, oldest dropped first. */
  deliveredLimit: number
}

/** Prepared bytes and acknowledgements prove nothing until settlement commits. */
export function createLogDelivery(params: LogDeliveryParams) {
  const handoffHeld = params.handoffHeld ?? params.held
  const safetyHeld = () => params.safetyHold?.() != null
  const prepared = new Map<number, PreparedAppPublication>()
  const publications = new Map<number, Publication>()
  const proven = new Set<number>()
  let walk:
    | { started: number; snapshots: Map<string, Promise<AppPublicationSnapshot | null>> }
    | undefined
  const delivered: Array<Delivered> = []
  let resend: Array<Delivered> = []
  let acknowledgements = 0
  let removed = false
  let closed = false
  let active = false
  let needed = false
  let immediate = false
  let retrying = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let backoff = 1000
  const submitted = new Set<Promise<unknown>>()
  let settlementSubmitted = false
  let completion: Promise<void> | undefined
  function track<T>(promise: Promise<T>): Promise<T> {
    submitted.add(promise)
    void promise.then(
      () => submitted.delete(promise),
      () => submitted.delete(promise),
    )
    return promise
  }
  function assertRunning(): void {
    if (params.failureSignal?.aborted) throw params.failureSignal.reason
  }
  function waitForRetry(delay: number): Promise<void> {
    assertRunning()
    return new Promise((resolve, reject) => {
      const signal = params.failureSignal
      const finish = () => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      const timer = setTimeout(finish, delay)
      const abort = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
  async function finishSubmitted(): Promise<void> {
    if (settlementSubmitted) assertRunning()
    while (submitted.size > 0) await Promise.allSettled([...submitted])
    if (settlementSubmitted) assertRunning()
    let delay = 100
    for (;;) {
      try {
        await removeProven()
        return
      } catch {
        assertRunning()
        await waitForRetry(delay)
        delay = Math.min(delay * 2, 15000)
      }
    }
  }

  const headPastFloor = (head: string | null, floor: EpochFloor): boolean =>
    head != null && (floor.position == null || head > floor.position)

  const pruneDelivered = (): void => {
    const oldest = Date.now() - params.deliveredWindowMs
    while (
      delivered.length > 0 &&
      ((delivered[0]?.at ?? 0) < oldest || delivered.length > params.deliveredLimit)
    )
      delivered.shift()
  }

  const keepDelivered = (seq: number): void => {
    const entry = params.queue.entries().find((queued) => queued.seq === seq)
    const epoch = publications.get(seq)?.epoch
    if (entry == null || epoch == null) return
    const { protocol, prc, data } = entry
    if (entry.lastAttempt === null) return
    delivered.push({
      protocol,
      prc,
      data,
      epoch,
      incarnation: entry.lastAttempt.incarnation,
      at: Date.now(),
    })
    pruneDelivered()
  }

  const removeProven = async (): Promise<boolean> => {
    for (const seq of proven) {
      const publication = publications.get(seq)
      const attempt = publication?.frame.entry.lastAttempt
      if (publication === undefined || attempt == null) continue
      settlementSubmitted = true
      await params.remove(seq, {
        incarnation: attempt.incarnation,
        segment: attempt.segment,
        topicID: attempt.topicID,
        position: publication.sequenceID,
      })
      keepDelivered(seq)
      params.queue.remove(seq)
      publications.delete(seq)
      prepared.delete(seq)
      proven.delete(seq)
    }
    return !closed
  }

  const sameSource = (a: AppPublicationSnapshot, b: AppPublicationSnapshot): boolean =>
    a.identity.groupID === b.identity.groupID &&
    a.identity.incarnation === b.identity.incarnation &&
    a.identity.epoch === b.identity.epoch &&
    a.segment === b.segment &&
    a.topicID === b.topicID &&
    a.identity.authenticator.length === b.identity.authenticator.length &&
    a.identity.authenticator.every((byte, index) => byte === b.identity.authenticator[index])

  const snapshot = async (protocol: string): Promise<AppPublicationSnapshot | null> => {
    const value = await params.snapshot(protocol)
    return value === null ? null : copySnapshot(value)
  }
  const capture = () => {
    const snapshots = new Map<string, Promise<AppPublicationSnapshot | null>>()
    for (const { protocol } of params.queue.entries()) {
      if (snapshots.has(protocol)) continue
      const pending = snapshot(protocol)
      void pending.catch(() => undefined)
      snapshots.set(protocol, pending)
    }
    return snapshots
  }
  const sameWindow = (a: AppPublicationSnapshot, b: AppPublicationSnapshot): boolean =>
    sameSource(a, b) && a.stateVersion === b.stateVersion && a.sealVersion === b.sealVersion

  const persistProof = async (
    seq: number,
    publication: Publication,
    before: AppPublicationSnapshot | null,
  ): Promise<void> => {
    if (proven.has(seq) || safetyHeld()) return
    const frame = publication.frame
    const after = await snapshot(frame.entry.protocol)
    if (safetyHeld() || closed) return
    if (before === null || after === null || !sameWindow(before, after)) return
    if (!sameSource(frame.snapshot, after)) {
      publications.delete(seq)
      prepared.delete(seq)
      return
    }
    const attempt = frame.entry.lastAttempt
    const current = params.queue.entries().find((entry) => entry.seq === seq)?.lastAttempt
    if (
      attempt === null ||
      current == null ||
      current.publishID !== attempt.publishID ||
      current.topicID !== attempt.topicID ||
      current.segment !== attempt.segment ||
      current.incarnation !== attempt.incarnation ||
      current.epoch !== attempt.epoch
    ) {
      publications.delete(seq)
      prepared.delete(seq)
      return
    }
    const expected = {
      identity: copySnapshot(after).identity,
      stateVersion: after.stateVersion,
      attemptID: attempt.publishID,
    }
    settlementSubmitted = true
    const result = await params.recordSettlement(
      seq,
      {
        sequenceID: publication.sequenceID,
        attemptID: attempt.publishID,
        topicID: attempt.topicID,
        outcome: 'published',
      },
      expected,
    )
    if (result.recorded) proven.add(seq)
    else walk = undefined
  }
  const beginWalk = (): number => {
    const started = acknowledgements
    walk = { started, snapshots: capture() }
    return started
  }
  const certify = async (epoch: number, started: number): Promise<void> => {
    const window = walk
    if (
      window === undefined ||
      window.started !== started ||
      safetyHeld() ||
      !params.floor().covered
    )
      return
    for (const [seq, publication] of publications) {
      if (publication.epoch !== epoch || publication.acknowledged > started) continue
      const before = await window.snapshots.get(publication.frame.entry.protocol)
      await persistProof(seq, publication, before ?? null)
      if (walk !== window) return
    }
  }

  const frameFor = async (entry: AppOutboxEntry): Promise<PreparedAppPublication | null> => {
    if ((await params.loadSettlement(entry.seq)) !== null) return null
    const current = await snapshot(entry.protocol)
    if (current === null) return null
    let frame = prepared.get(entry.seq)
    if (
      frame !== undefined &&
      (!sameSource(frame.snapshot, current) ||
        frame.entry.lastAttempt?.publishID !== entry.lastAttempt?.publishID)
    ) {
      prepared.delete(entry.seq)
      frame = undefined
    }
    if (frame === undefined) {
      if (params.held()) return null
      frame = copyPrepared(await params.prepare(entry, params.floor().position))
      params.queue.replace(frame.entry)
      prepared.set(entry.seq, frame)
      const after = await snapshot(entry.protocol)
      if (after === null) return null
      if (!sameWindow(frame.snapshot, after)) {
        if (!sameSource(frame.snapshot, after)) prepared.delete(entry.seq)
        return null
      }
    }
    return frame
  }
  const handoff = async (frame: PreparedAppPublication): Promise<boolean> => {
    const attempt = frame.entry.lastAttempt
    if (attempt === null || closed || handoffHeld()) return false
    const current = await snapshot(frame.entry.protocol)
    if (current === null) return false
    if (!sameSource(frame.snapshot, current)) {
      prepared.delete(frame.entry.seq)
      return false
    }
    if (closed || handoffHeld()) return false
    const submission = params.publish({
      topicID: attempt.topicID,
      payload: frame.payload,
      publishID: attempt.publishID,
    })
    if (submission === null) return false
    const { sequenceID } = await submission
    if (closed) return false
    const after = await snapshot(frame.entry.protocol)
    if (after === null) return false
    if (!sameWindow(current, after)) {
      immediate = true
      return false
    }
    const stored = params.queue.entries().find((entry) => entry.seq === frame.entry.seq)
    if (
      stored?.lastAttempt?.publishID !== attempt.publishID ||
      stored.lastAttempt.topicID !== attempt.topicID
    )
      return false
    publications.set(frame.entry.seq, {
      epoch: attempt.epoch,
      floor: attempt.floor === null ? null : asLogPosition(attempt.floor),
      acknowledged: ++acknowledgements,
      sequenceID,
      frame: copyPrepared(frame),
    })
    return true
  }

  const pass = async (): Promise<void> => {
    assertRunning()
    await params.ready()
    await params.queue.ready()
    if (closed) return
    // Certified occurrences precede terminal clearing and every safety exit.
    if (!(await removeProven())) return
    if (removed) {
      if (params.queue.lowestUnresolvedSeq() != null) return
      const seqs = params.queue.entries().map((entry) => entry.seq)
      if (seqs.length === 0) return
      await params.clear()
      params.queue.clear()
      publications.clear()
      prepared.clear()
      proven.clear()
      if (!closed) params.cleared({ reason: 'removed', seqs })
      return
    }
    if (safetyHeld()) return
    // Prefer resends in original order; a full queue must drain before admitting them.
    while (resend.length > 0) {
      const next = resend[0]
      if (next == null || closed || handoffHeld()) return
      const current = await params.snapshot(next.protocol)
      if (current === null) return
      if (current.identity.incarnation !== next.incarnation) {
        resend.shift()
        continue
      }
      if (next.seq === undefined) {
        try {
          next.seq = await params.queue.enqueue(next)
        } catch (error) {
          if (error instanceof AppOutboxFullError) break
          throw error
        }
      }
      const entry = params.queue.entries().find((entry) => entry.seq === next.seq)
      if (entry === undefined) {
        resend.shift()
        continue
      }
      const frame = await frameFor(entry)
      if (frame === null || !(await handoff(frame))) return
      resend.shift()
    }
    if (params.queue.entries().length === 0) return
    let count = 0
    for (const entry of params.queue.entries()) {
      if (closed || safetyHeld()) return
      const fence = params.queue.lowestUnresolvedSeq()
      if (fence != null && entry.seq >= fence) return
      if (count++ === 64) {
        immediate = true
        break
      }
      if (proven.has(entry.seq)) continue
      const before = await params.probe()
      if (safetyHeld()) {
        await removeProven()
        return
      }
      if (headPastFloor(before.head, params.floor())) await params.pull()
      if (closed || removed) {
        immediate = removed && params.queue.lowestUnresolvedSeq() == null
        return
      }
      if (handoffHeld()) return
      const floor = params.floor()
      if (publications.get(entry.seq)?.epoch === floor.epoch) continue
      const frame = await frameFor(entry)
      if (frame === null) return
      if (frame.snapshot.identity.epoch !== floor.epoch) {
        prepared.delete(entry.seq)
        immediate = true
        break
      }
      if (closed || handoffHeld()) return
      const needsEarlierPublication = (): boolean =>
        params.queue
          .entries()
          .some(
            (earlier) =>
              earlier.seq < entry.seq &&
              !proven.has(earlier.seq) &&
              publications.get(earlier.seq)?.epoch !== frame.snapshot.identity.epoch,
          )
      if (needsEarlierPublication()) {
        immediate = true
        break
      }
      if (!(await handoff(frame))) return
      // A later entry must not reach the new epoch before this one is re-sealed there.
      if (params.floor().epoch !== frame.snapshot.identity.epoch) {
        immediate = true
        break
      }
    }
    if (safetyHeld()) return
    // Serial handoffs finish before this fast-path cutoff; acknowledgements cannot cross it.
    const started = acknowledgements
    const snapshots = capture()
    await Promise.all(snapshots.values())
    const result = await params.probe()
    if (closed) return
    if (safetyHeld()) {
      await removeProven()
      return
    }
    for (const [seq, publication] of publications) {
      if (result.head == null || (publication.floor != null && result.head <= publication.floor)) {
        if (publication.acknowledged <= started) {
          await persistProof(
            seq,
            publication,
            (await snapshots.get(publication.frame.entry.protocol)) ?? null,
          )
        }
      }
    }
    if (headPastFloor(result.head, params.floor())) {
      await params.pull()
      if (!params.floor().covered && !params.held() && publications.size > 0) await params.heal()
    }
    if (
      [...publications.values()].some((publication) => publication.epoch !== params.floor().epoch)
    )
      immediate = true
    await removeProven()
  }

  const schedule = (delay: number): void => {
    if (closed || params.failureSignal?.aborted || active || timer != null) return
    timer = setTimeout(() => {
      timer = undefined
      active = true
      needed = false
      immediate = false
      void track(
        (async () => {
          let failed = false
          try {
            await pass()
            backoff = 1000
          } catch {
            failed = true
          } finally {
            active = false
            if (!closed) {
              retrying = failed
              if (
                failed ||
                params.queue.entries().length > 0 ||
                resend.length > 0 ||
                (removed && needed)
              ) {
                schedule(!failed && immediate ? 0 : backoff)
                if (failed) backoff = Math.min(backoff * 2, 60_000)
              } else if (needed) schedule(0)
            }
          }
        })(),
      )
    }, delay)
  }

  return {
    trigger: (): void => {
      needed = true
      if (!active && !retrying && timer != null) {
        clearTimeout(timer)
        timer = undefined
      }
      schedule(0)
    },
    beginWalk,
    readyWalk: async (started: number): Promise<void> => {
      if (walk?.started === started) await Promise.all(walk.snapshots.values())
    },
    certify: (epoch: number, started: number): Promise<void> => track(certify(epoch, started)),
    /**
     * Another member rejoined by external commit. A member stranded behind a retention gap cannot
     * read the epochs it missed, so entries delivered there never reach it. Send the delivered
     * entries again at the current epoch, but only those from epochs at or after `anchorEpoch`,
     * the anchor before the rejoin: the roster has not changed since, so every member that can
     * read the copy was a member when the entry was first sent. Receivers deduplicate by content.
     */
    rejoined: (anchorEpoch: number): void => {
      if (closed || removed) return
      pruneDelivered()
      const queued = new Set(resend)
      for (const entry of delivered) {
        if (entry.epoch >= anchorEpoch && !queued.has(entry)) resend.push(entry)
      }
      if (resend.length === 0) return
      needed = true
      schedule(0)
    },
    removed: (): void => {
      removed = true
      prepared.clear()
      delivered.length = 0
      resend = []
      params.queue.stop()
      needed = true
      schedule(0)
    },
    drained: (): Promise<void> =>
      completion ?? Promise.reject(new Error('Close delivery before draining')),
    close: (): void => {
      if (closed) return
      closed = true
      prepared.clear()
      clearTimeout(timer)
      completion = finishSubmitted()
      void completion.catch(() => {})
    },
  }
}
