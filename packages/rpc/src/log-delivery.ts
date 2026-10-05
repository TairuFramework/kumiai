import type { HubFetchTopicResult } from '@kumiai/hub-tunnel'

import type { AppOutboxEntry, createAppOutboxAcceptance } from './app-outbox.js'
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
type DeliveryParams = {
  queue: ReturnType<typeof createAppOutboxAcceptance>
  ready: () => Promise<void>
  floor: () => EpochFloor
  held: () => boolean
  probe: () => Promise<CoveredFetchResult>
  pull: () => Promise<void>
  heal: () => Promise<void>
  seal: (
    entry: AppOutboxEntry,
  ) => Promise<{ topicID: string; payload: Uint8Array; floor: EpochFloor }>
  put: (entry: AppOutboxEntry) => Promise<void>
  publish: (frame: { topicID: string; payload: Uint8Array }) => Promise<unknown> | null
  remove: (seq: number) => Promise<void>
  clear: () => Promise<void>
  cleared: (notice: AppOutboxCleared) => void
}

/** Publication evidence stays in memory. A prepared durable attempt proves nothing. */
export function createLogDelivery(params: DeliveryParams) {
  const publications = new Map<number, Publication>()
  const proven = new Set<number>()
  let acknowledgements = 0
  let removed = false
  let closed = false
  let active = false
  let needed = false
  let immediate = false
  let retrying = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let backoff = 1000

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
      if (!closed && seqs.length > 0) params.cleared({ reason: 'removed', seqs })
      return
    }
    // A failed durable removal retries alone, even after another epoch arrives.
    for (const seq of proven) {
      await params.remove(seq)
      params.queue.remove(seq)
      publications.delete(seq)
      proven.delete(seq)
      if (closed) return
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
      const floorBefore = params.floor()
      if (
        before.head != null &&
        (floorBefore.position == null || before.head > floorBefore.position)
      ) {
        await params.pull()
      }
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
    const at = params.floor()
    if (result.head != null && (at.position == null || result.head > at.position)) {
      await params.pull()
      if (!params.floor().covered && !params.held() && publications.size > 0) await params.heal()
    }
    if (
      [...publications.values()].some((publication) => publication.epoch !== params.floor().epoch)
    )
      immediate = true
    for (const seq of proven) {
      await params.remove(seq)
      params.queue.remove(seq)
      publications.delete(seq)
      proven.delete(seq)
      if (closed) return
    }
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
            if (failed || params.queue.entries().length > 0 || (removed && needed)) {
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
    removed: (): void => {
      removed = true
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
