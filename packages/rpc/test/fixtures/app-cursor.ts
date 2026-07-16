import type { AppCursorStore } from '../../src/app-cursor.js'

export type MemoryAppCursorStore = AppCursorStore & {
  /** The position held for a topic right now, or null. A restart keeps it: that is the point. */
  stored: (topicID: string) => string | null
  /** Every position ever written, per topic, in order. A cursor must only ever move forward. */
  history: (topicID: string) => Array<string>
}

/**
 * A host's durable app-lane cursor store, in memory. Surviving a "restart" is handing the same
 * instance to the new peer — which is the whole subject: a read position that dies with the process
 * is a peer that re-reads its history from wherever the hub's retention happens to begin, and
 * cannot tell that from the place it actually got to.
 */
export function createMemoryAppCursorStore(): MemoryAppCursorStore {
  const positions = new Map<string, string>()
  const writes = new Map<string, Array<string>>()

  return {
    async load(topicID: string) {
      return positions.get(topicID) ?? null
    },
    async save(topicID: string, position: string) {
      positions.set(topicID, position)
      const log = writes.get(topicID)
      if (log == null) writes.set(topicID, [position])
      else log.push(position)
    },
    stored: (topicID) => positions.get(topicID) ?? null,
    history: (topicID) => [...(writes.get(topicID) ?? [])],
  }
}
