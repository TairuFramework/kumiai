import type { AppOutbox, AppOutboxEntry } from '../../src/app-outbox.js'

export function createMemoryAppOutbox(): AppOutbox & { failNextPut(): void } {
  let refusePut = false
  const rows = new Map<number, AppOutboxEntry>()
  const copy = (entry: AppOutboxEntry): AppOutboxEntry => ({
    ...entry,
    data: entry.data.slice(),
    lastAttempt: entry.lastAttempt == null ? null : { ...entry.lastAttempt },
  })
  return {
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
