import type { SendAdmission } from './crypto.js'
import {
  AppEntryTooLargeError,
  AppOutboxFullError,
  PeerDisposedError,
  SendNotAdmissibleError,
} from './errors.js'

export const MAX_APP_ENTRY_BYTES = 524_288

/** Encoded app plaintext and the latest prepared publication attempt. */
export type AppOutboxEntry = {
  seq: number
  protocol: string
  prc: string
  data: Uint8Array
  lastAttempt: { epoch: number; floor: string | null; attempts: number } | null
}

/** Owned by one live peer per group. Writes are durable before resolution. */
export type AppOutbox = {
  /** Atomic insert or replace by seq. A rejection leaves storage unchanged. */
  put(entry: AppOutboxEntry): Promise<void>
  /** Ascending sequence order. */
  list(): Promise<Array<AppOutboxEntry>>
  remove(seq: number): Promise<void>
  clear(): Promise<void>
}

export type AppOutboxAcceptanceParams = {
  outbox: AppOutbox
  limit: number
  admission: () => SendAdmission
}

/** Accepted entries below the unresolved fence are available to the delivery worker. */
export function createAppOutboxAcceptance(params: AppOutboxAcceptanceParams) {
  const accepted = new Map<number, AppOutboxEntry>()
  const reservations = new Set<number>()
  let nextSeq = 0
  let listed = false
  let waiting = 0
  let closed = false
  let stopped = false
  let retry: ReturnType<typeof setTimeout> | undefined
  let resolveReady: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  const load = async (): Promise<void> => {
    try {
      const entries = await params.outbox.list()
      if (closed) return
      for (const entry of entries) {
        accepted.set(entry.seq, entry)
        nextSeq = Math.max(nextSeq, entry.seq + 1)
      }
      listed = true
      resolveReady()
    } catch {
      // No allocation happens until the durable inventory is known.
      if (!closed)
        retry = setTimeout(() => {
          void load()
        }, 1000)
    }
  }
  void load()

  const accept = async (
    input: Pick<AppOutboxEntry, 'protocol' | 'prc' | 'data'>,
  ): Promise<void> => {
    // Later calls must join the handoff until earlier waiters have resumed.
    if (!listed || waiting > 0) {
      waiting++
      try {
        await ready
      } finally {
        waiting--
      }
    }
    if (closed || stopped) throw new PeerDisposedError('App outbox acceptance is closed')
    const admission = params.admission()
    if (!admission.admissible) throw new SendNotAdmissibleError(admission.reason)
    if (input.data.byteLength > MAX_APP_ENTRY_BYTES) {
      throw new AppEntryTooLargeError('App entry exceeds the plaintext bound')
    }
    if (accepted.size + reservations.size >= params.limit) {
      throw new AppOutboxFullError('App outbox is full')
    }
    const seq = nextSeq++
    const entry: AppOutboxEntry = { ...input, data: input.data.slice(), seq, lastAttempt: null }
    reservations.add(seq)
    try {
      await params.outbox.put(entry)
      accepted.set(seq, entry)
    } finally {
      reservations.delete(seq)
    }
  }

  return {
    ready: () => ready,
    accept,
    entries: (): Array<AppOutboxEntry> => [...accepted.values()].sort((a, b) => a.seq - b.seq),
    lowestUnresolvedSeq: (): number | null => {
      const first = reservations.values().next()
      return first.done ? null : first.value
    },
    replace: (entry: AppOutboxEntry): void => {
      accepted.set(entry.seq, entry)
    },
    remove: (seq: number): void => {
      accepted.delete(seq)
    },
    clear: (): void => {
      accepted.clear()
    },
    stop: (): void => {
      stopped = true
    },
    close: (): void => {
      closed = true
      clearTimeout(retry)
      resolveReady()
    },
  }
}
