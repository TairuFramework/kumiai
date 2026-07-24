/**
 * Abstraction over a 1→N publish/subscribe bus addressed by opaque topic IDs.
 * The hub implements this; `createMemoryBus` is the in-process fake.
 */
export type BroadcastBus = {
  publish(topicID: string, payload: Uint8Array): void | Promise<void>
  /**
   * `ack` marks the payload durably handled so a durable hub stops redelivering it. Absent on an
   * in-process bus that never redelivers; ignorable by a subscriber that needs no durability gate.
   * A one-parameter callback stays assignable, so adding it broke nothing.
   */
  subscribe(topicID: string, onMessage: (payload: Uint8Array, ack?: () => void) => void): () => void
}

/**
 * In-memory fan-out bus for tests and in-process use.
 *
 * **Known divergence from the hub, NOT checked by `@kumiai/hub-conformance`.** This bus echoes to
 * every subscriber including the publisher's own; the hub delivers to "subscribers MINUS the sender"
 * (`hub-server/src/memoryStore.ts`), and the production bus (`rpc/src/hub-mux.ts`) is a per-peer view
 * of that. So anything relying on receiving its OWN publish (a gather counting its own reply) passes
 * here and delivers nothing in production. The conformance suite can't catch it here: this shape
 * carries no sender/subscriber identity to ask "was this echoed to its sender?". Closing it means
 * putting identity on `BroadcastBus` itself.
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
