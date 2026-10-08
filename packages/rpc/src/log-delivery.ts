import type { HubFetchTopicResult } from '@kumiai/hub-tunnel'

import type { AppOutboxAcceptance, AppOutboxEntry } from './app-outbox.js'
import type { LogPosition } from './cursor.js'

export type EpochFloor = { epoch: number; position: LogPosition | null; covered: boolean }
export type AppOutboxCleared = { reason: 'removed'; seqs: Array<number> }
export type CoveredFetchResult = HubFetchTopicResult

export function checkedFetchResult(result: HubFetchTopicResult): CoveredFetchResult {
  if (typeof result.gap !== 'boolean') {
    throw new Error('Commit fetch requires a boolean gap')
  }
  return result
}

type Publication = { epoch: number; floor: LogPosition | null; acknowledged: number }
/** A delivered entry kept for a member that rejoins later and could not read its epoch. */
type Delivered = Pick<AppOutboxEntry, 'protocol' | 'prc' | 'data'> & { epoch: number; at: number }
type LogFrame = { topicID: string; payload: Uint8Array }
/** A sealed frame with the floor snapshot its admission was checked against. */
type SealedLogFrame = LogFrame & { floor: EpochFloor }
export type LogDeliveryParams = {
  queue: AppOutboxAcceptance
  ready: () => Promise<void>
  floor: () => EpochFloor
  held: () => boolean
  probe: () => Promise<CoveredFetchResult>
  pull: () => Promise<void>
  heal: () => Promise<void>
  seal: (entry: AppOutboxEntry) => Promise<SealedLogFrame>
  put: (entry: AppOutboxEntry) => Promise<void>
  publish: (frame: LogFrame) => Promise<unknown> | null
  remove: (seq: number) => Promise<void>
  clear: () => Promise<void>
  cleared: (notice: AppOutboxCleared) => void
  /** How long a delivered entry stays eligible to be sent again to a rejoined member. */
  deliveredWindowMs: number
  /** How many delivered entries are kept, oldest dropped first. */
  deliveredLimit: number
}

/** Publication evidence stays in memory. A prepared durable attempt proves nothing. */
export function createLogDelivery(params: LogDeliveryParams) {
  const publications = new Map<number, Publication>()
  const proven = new Set<number>()
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
    delivered.push({ protocol, prc, data, epoch, at: Date.now() })
    pruneDelivered()
  }

  const removeProven = async (): Promise<boolean> => {
    for (const seq of proven) {
      await params.remove(seq)
      keepDelivered(seq)
      params.queue.remove(seq)
      publications.delete(seq)
      proven.delete(seq)
      if (closed) return false
    }
    return true
  }

  const certify = (epoch: number, started: number): void => {
    for (const [seq, publication] of publications) {
      if (publication.epoch === epoch && publication.acknowledged <= started) proven.add(seq)
    }
  }

  const pass = async (): Promise<void> => {
    await params.ready()
    await params.queue.ready()
    if (closed) return
    if (removed) {
      if (params.queue.lowestUnresolvedSeq() != null) return
      const seqs = params.queue.entries().map((entry) => entry.seq)
      if (seqs.length === 0) return
      await params.clear()
      params.queue.clear()
      publications.clear()
      proven.clear()
      if (!closed) params.cleared({ reason: 'removed', seqs })
      return
    }
    // A failed durable removal retries alone, even after another epoch arrives.
    if (!(await removeProven())) return
    // Sent again ahead of the queue, so a rejoined member reads them in their original order.
    while (resend.length > 0) {
      const next = resend[0]
      if (next == null || closed || params.held()) return
      const { protocol, prc, data } = next
      const frame = await params.seal({ protocol, prc, data, seq: -1, lastAttempt: null })
      if (closed || params.held()) return
      const submission = params.publish(frame)
      if (submission == null) return
      await submission
      resend.shift()
    }
    if (params.queue.entries().length === 0) return
    let count = 0
    for (const entry of params.queue.entries()) {
      if (closed) return
      const fence = params.queue.lowestUnresolvedSeq()
      if (fence != null && entry.seq >= fence) return
      if (count++ === 64) {
        immediate = true
        break
      }
      if (proven.has(entry.seq)) continue
      const before = await params.probe()
      if (headPastFloor(before.head, params.floor())) await params.pull()
      if (closed || removed) {
        immediate = removed && params.queue.lowestUnresolvedSeq() == null
        return
      }
      if (params.held()) return
      const floor = params.floor()
      if (publications.get(entry.seq)?.epoch === floor.epoch) continue
      const frame = await params.seal(entry)
      if (closed || params.held()) return
      const needsEarlierPublication = (): boolean =>
        params.queue
          .entries()
          .some(
            (earlier) =>
              earlier.seq < entry.seq &&
              !proven.has(earlier.seq) &&
              publications.get(earlier.seq)?.epoch !== frame.floor.epoch,
          )
      if (needsEarlierPublication()) {
        immediate = true
        break
      }
      const updated: AppOutboxEntry = {
        ...entry,
        lastAttempt: {
          epoch: frame.floor.epoch,
          floor: frame.floor.position,
          attempts: (entry.lastAttempt?.attempts ?? 0) + 1,
        },
      }
      await params.put(updated)
      params.queue.replace(updated)
      if (closed || params.held()) return
      if (needsEarlierPublication()) {
        immediate = true
        break
      }
      const submission = params.publish(frame)
      if (submission == null) return
      await submission
      if (closed) return
      publications.set(entry.seq, {
        epoch: frame.floor.epoch,
        floor: frame.floor.position,
        acknowledged: ++acknowledgements,
      })
      // A later entry must not reach the new epoch before this one is re-sealed there.
      if (params.floor().epoch !== frame.floor.epoch) {
        immediate = true
        break
      }
    }
    const result = await params.probe()
    if (closed) return
    for (const [seq, publication] of publications) {
      if (result.head == null || (publication.floor != null && result.head <= publication.floor)) {
        proven.add(seq)
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
    if (closed || active || timer != null) return
    timer = setTimeout(() => {
      timer = undefined
      active = true
      needed = false
      immediate = false
      void (async () => {
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
      })()
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
    beginWalk: (): number => acknowledgements,
    certify,
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
      delivered.length = 0
      resend = []
      params.queue.stop()
      needed = true
      schedule(0)
    },
    close: (): void => {
      closed = true
      clearTimeout(timer)
    },
  }
}
