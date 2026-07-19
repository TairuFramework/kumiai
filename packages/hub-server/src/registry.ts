import type { StoredMessage } from '@kumiai/hub-protocol'

export type ClientEntry = {
  did: string
  sendMessage: ((message: StoredMessage) => void) | null
  /** Ends the currently bound receive channel. Set with the writer and cleared with it. */
  endReceive: (() => void) | null
  /** Identifies the binding, so a channel can only ever release its OWN. */
  token: symbol | null
}

/**
 * Tracks online clients and their live receive-channel writers. Subscription
 * state is durable in the store, not here — the registry only routes live
 * fan-out to currently-connected subscribers.
 */
export class HubClientRegistry {
  #clients = new Map<string, ClientEntry>()

  register(did: string): ClientEntry {
    const existing = this.#clients.get(did)
    if (existing != null) {
      return existing
    }
    const entry: ClientEntry = { did, sendMessage: null, endReceive: null, token: null }
    this.#clients.set(did, entry)
    return entry
  }

  unregister(did: string): void {
    this.#clients.delete(did)
  }

  /** Removes the entry only when no receive writer is bound. */
  unregisterIfIdle(did: string): void {
    const entry = this.#clients.get(did)
    if (entry != null && entry.sendMessage == null) {
      this.#clients.delete(did)
    }
  }

  /**
   * Bind this DID's receive writer, EVICTING whatever was bound before it.
   *
   * One writer per DID, and the newest one wins. The alternative — refuse the second — reads as
   * the safer rule and is not: a client whose socket died has a writer the server still believes
   * in, because nothing has told it otherwise yet, and that belief outlives the socket by however
   * long the transport takes to notice. Refusing on it means the reconnect that the client makes
   * precisely BECAUSE its connection dropped is the one that gets turned away, and the member has
   * no push lane until a timeout it cannot see or influence expires. Last-writer-wins costs a
   * live connection only when the same authenticated DID opens a second channel, which is the
   * same client and its own business.
   *
   * The eviction is handed back rather than run here: ending a channel is the handler's to do,
   * and a registry that closed streams would be doing two jobs.
   *
   * The TOKEN is what keeps the eviction from unbinding its successor. The evicted handler runs
   * its own cleanup afterwards — it does not know why it ended — and a `clear(did)` there would
   * null the writer the new channel has just bound, leaving the DID online with nothing behind
   * it. So a release names the binding it is releasing, and one that is no longer current is a
   * no-op.
   */
  bindReceiveWriter(
    did: string,
    writer: (message: StoredMessage) => void,
    endReceive: () => void,
  ): { token: symbol; evicted: (() => void) | null } {
    const entry = this.#clients.get(did)
    if (entry == null) return { token: Symbol('unbound'), evicted: null }
    const evicted = entry.endReceive
    const token = Symbol('receive')
    entry.sendMessage = writer
    entry.endReceive = endReceive
    entry.token = token
    return { token, evicted }
  }

  /** Clear the binding this token names. A token that is no longer current is a no-op. */
  releaseReceiveWriter(did: string, token: symbol): void {
    const entry = this.#clients.get(did)
    if (entry == null || entry.token !== token) return
    entry.sendMessage = null
    entry.endReceive = null
    entry.token = null
  }

  getClient(did: string): ClientEntry | undefined {
    return this.#clients.get(did)
  }

  isOnline(did: string): boolean {
    return this.#clients.get(did)?.sendMessage != null
  }

  isWriterBound(did: string): boolean {
    return this.#clients.get(did)?.sendMessage != null
  }
}
