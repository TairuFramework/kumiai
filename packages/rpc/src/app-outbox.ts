import { decodeAppEntry } from './app-entry.js'
import type { EpochIdentity, GroupKey } from './control/types.js'
import type { SendAdmission } from './crypto.js'
import {
  AppEntryTooLargeError,
  AppOutboxFullError,
  PeerDisposedError,
  PeerRemovedError,
  SendNotAdmissibleError,
} from './errors.js'

export const MAX_APP_ENTRY_BYTES = 524_288

export type AppAttempt = {
  incarnation: number
  epoch: number
  floor: string | null
  attempts: number
  publishID: string
  segment: number
  topicID: string
}

export type AppOutboxEntry = {
  seq: number
  protocol: string
  prc: string
  data: Uint8Array
  lastAttempt: AppAttempt | null
  status: 'accepted' | 'failed'
}

export type AppOutbox = {
  /** Provider fail-stop. Drainage rejects with this signal's reason instead of retrying. */
  failureSignal?: AbortSignal
  put(entry: AppOutboxEntry): Promise<void>
  list(): Promise<Array<AppOutboxEntry>>
  recordSettlement(
    seq: number,
    obligation: AppSettlementObligation,
    expected: AppSettlementExpected,
  ): Promise<AppSettlementResult>
  loadSettlement(seq: number): Promise<AppSettlementObligation | null>
  remove(seq: number, outcome?: AppPublicationOutcome): Promise<void>
  clear(): Promise<void>
  events(): Promise<Array<AppStatusEvent>>
  ackEvent(id: string): Promise<void>
}

export type AppPublicationOutcome = {
  incarnation: number
  segment: number
  topicID: string
  position: string
}

export type AppSettlementObligation = {
  sequenceID: string
  attemptID: string
  topicID: string
  outcome: 'published'
}

export type AppSettlementExpected = {
  identity: EpochIdentity
  stateVersion: number
  attemptID: string
}

export type AppSettlementResult =
  | { recorded: true }
  | {
      recorded: false
      reason: 'identity-changed' | 'state-version-changed' | 'attempt-changed' | 'entry-missing'
    }

export type AppStatusEvent = GroupKey & { id: string; entry: AppOutboxEntry } & (
    | { kind: 'accepted' }
    | { kind: 'published'; occurrence: AppPublicationOutcome }
    | {
        kind: 'failed'
        reason: 'incarnation-abandoned' | 'removed' | 'deleted' | 'database-restored'
        nextIncarnation?: number
      }
  )

export type AppOutboxAcceptanceParams = {
  outbox: AppOutbox
  limit: number
  admission: () => SendAdmission
  /** Initial safety reads only; full peer startup may depend on this queue. */
  admissionReady?: () => Promise<void>
}

export type AppOutboxAcceptance = {
  ready: () => Promise<void>
  accept: (input: Pick<AppOutboxEntry, 'protocol' | 'prc' | 'data'>) => Promise<void>
  enqueue: (input: Pick<AppOutboxEntry, 'protocol' | 'prc' | 'data'>) => Promise<number>
  entries: () => Array<AppOutboxEntry>
  lowestUnresolvedSeq: () => number | null
  replace: (entry: AppOutboxEntry) => void
  remove: (seq: number) => void
  clear: () => void
  stop: () => void
  close: () => void
}

/** Accepted entries below the unresolved fence are available to the delivery worker. */
export function createAppOutboxAcceptance(params: AppOutboxAcceptanceParams): AppOutboxAcceptance {
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
        if (entry.status === 'accepted') accepted.set(entry.seq, entry)
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

  const enqueue = async (
    input: Pick<AppOutboxEntry, 'protocol' | 'prc' | 'data'>,
  ): Promise<number> => {
    if (params.admissionReady !== undefined) await params.admissionReady()
    // Later calls must join the handoff until earlier waiters have resumed.
    if (!listed || waiting > 0) {
      waiting++
      try {
        await ready
      } finally {
        waiting--
      }
    }
    if (closed) throw new PeerDisposedError('App outbox acceptance is closed')
    if (stopped) throw new PeerRemovedError('App outbox sender was removed')
    const admission = params.admission()
    if (!admission.admissible) throw new SendNotAdmissibleError(admission.reason)
    if (input.data.byteLength > MAX_APP_ENTRY_BYTES) {
      throw new AppEntryTooLargeError('App entry exceeds the plaintext bound')
    }
    if (accepted.size + reservations.size >= params.limit) {
      throw new AppOutboxFullError('App outbox is full')
    }
    const seq = nextSeq++
    const entry: AppOutboxEntry = {
      protocol: input.protocol,
      prc: input.prc,
      data: input.data.slice(),
      seq,
      lastAttempt: null,
      status: 'accepted',
    }
    decodeAppEntry(entry)
    reservations.add(seq)
    try {
      await params.outbox.put(entry)
      accepted.set(seq, entry)
      return seq
    } finally {
      reservations.delete(seq)
    }
  }

  return {
    ready: () => ready,
    accept: async (input) => {
      await enqueue(input)
    },
    enqueue,
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
