/**
 * Abstraction over a 1→N publish/subscribe bus addressed by opaque topic IDs.
 * The hub implements this; `createMemoryBus` is the in-process fake.
 */
export type BroadcastBus = {
  publish(topicID: string, payload: Uint8Array): void | Promise<void>
  subscribe(topicID: string, onMessage: (payload: Uint8Array) => void): () => void
}

/**
 * In-memory fan-out bus for tests and in-process use.
 *
 * **Known divergence from the hub, NOT checked by `@kumiai/hub-conformance`.** This bus calls every
 * subscriber of a topic, including the publisher's own. The hub does not: it builds recipients as
 * "current subscribers MINUS the sender" (`hub-server/src/memoryStore.ts`), and the production
 * `BroadcastBus` (`rpc/src/hub-mux.ts`) is a per-peer view over exactly that fan-out. So a
 * component whose correctness turns on receiving its OWN publish — a gather counting its own reply
 * toward a quorum, a client confirming a publish by observing it arrive — passes here and delivers
 * nothing in production.
 *
 * The `LogHub` conformance suite locks that property down for every hub double, but it cannot be
 * applied here: `publish(topicID, payload)` carries no sender and `subscribe(topicID, onMessage)`
 * carries no subscriber identity, so "was this echoed to its sender?" is not a question this shape
 * can be asked. Closing it means putting identity on `BroadcastBus` itself, which changes the
 * production implementation in `rpc/src/hub-mux.ts`.
 */
export function createMemoryBus(): BroadcastBus {
  const topics = new Map<string, Set<(payload: Uint8Array) => void>>()
  return {
    publish(topicID, payload) {
      const subscribers = topics.get(topicID)
      if (subscribers == null) {
        return
      }
      for (const onMessage of [...subscribers]) {
        onMessage(payload)
      }
    },
    subscribe(topicID, onMessage) {
      let subscribers = topics.get(topicID)
      if (subscribers == null) {
        subscribers = new Set()
        topics.set(topicID, subscribers)
      }
      subscribers.add(onMessage)
      return () => {
        subscribers?.delete(onMessage)
        if (subscribers?.size === 0) {
          topics.delete(topicID)
        }
      }
    },
  }
}
