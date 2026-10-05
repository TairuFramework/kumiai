import type {
  ConformanceAppOutbox,
  ConformanceAppOutboxEntry,
  ConformanceCommitCursor,
} from './app-outbox.js'

export type MemoryAppOutbox = ConformanceAppOutbox & { failNextPut(): void }

export function createMemoryAppOutbox(): MemoryAppOutbox {
  let cursor: ConformanceCommitCursor | null = null
  let refusePut = false
  const rows = new Map<number, ConformanceAppOutboxEntry>()
  const copy = (entry: ConformanceAppOutboxEntry): ConformanceAppOutboxEntry => ({
    ...entry,
    data: entry.data.slice(),
    lastAttempt: entry.lastAttempt == null ? null : { ...entry.lastAttempt },
  })
  return {
    getCommitCursor: async () => (cursor == null ? null : { ...cursor }),
    putCommitCursor: async (value) => {
      cursor = value == null ? null : { ...value }
    },
    put: async (entry) => {
      if (refusePut) {
        refusePut = false
        throw new Error('Outbox write refused')
      }
      rows.set(entry.seq, copy(entry))
    },
    list: async () => [...rows.values()].sort((a, b) => a.seq - b.seq).map(copy),
    remove: async (seq) => {
      rows.delete(seq)
    },
    clear: async () => {
      rows.clear()
    },
    failNextPut: () => {
      refusePut = true
    },
  }
}
