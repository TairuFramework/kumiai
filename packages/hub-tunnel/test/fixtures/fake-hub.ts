import { RetentionExceededError, type StoredMessage } from '@kumiai/hub-protocol'
import { EventEmitter } from '@sozai/event'

import type { HubPublishParams, HubSubscribeOptions, MailboxHubEvent } from '../../src/transport.js'

/** 30 days in seconds — `createMemoryStore`'s own default ceiling. */
export const DEFAULT_MAX_RETENTION = 2_592_000

export type FakeHubOptions = {
  /** Retention ceiling in seconds. Default {@link DEFAULT_MAX_RETENTION}. */
  maxRetention?: number
}

export type FakeHubPublishParams = HubPublishParams
export type FakeHubMessage = StoredMessage

type Subscriber = {
  push: (message: FakeHubMessage) => void
  close: () => void
}

type DeliveryAction =
  | { kind: 'normal' }
  | { kind: 'drop' }
  | { kind: 'duplicate' }
  | { kind: 'delay'; ms: number }
  | { kind: 'swap-hold' }
  | { kind: 'swap-flush' }

export class FakeHub {
  #sequence = 0
  // subscriberDID → set of live receive streams
  #subscribers = new Map<string, Set<Subscriber>>()
  // topicID → set of subscriberDIDs
  #topics = new Map<string, Set<string>>()
  #pendingDrops = 0
  #pendingDuplicates = 0
  #pendingDelays: Array<number> = []
  #pendingSwap = 0
  #heldForSwap: Array<{ recipient: string; message: FakeHubMessage }> = []
  #events = new EventEmitter<{ status: MailboxHubEvent }>()
  /** Retention ceiling in seconds. See {@link FakeHub.subscribe}. */
  #maxRetention: number

  constructor(options: FakeHubOptions = {}) {
    this.#maxRetention = options.maxRetention ?? DEFAULT_MAX_RETENTION
  }

  get events(): EventEmitter<{ status: MailboxHubEvent }> {
    return this.#events
  }

  simulateReconnecting(): void {
    void this.#events.emit('status', { type: 'reconnecting' })
  }

  simulateConnected(): void {
    void this.#events.emit('status', { type: 'connected' })
  }

  simulateDisconnected(): void {
    void this.#events.emit('status', { type: 'disconnected' })
  }

  /**
   * Refuses a retention above the ceiling, exactly as `createMemoryStore` does
   * (`hub-server/src/memoryStore.ts`) and as the hub contract states in as many words
   * (`HubSubscribeOptions.retention`: "refused, never clamped"). An infallible fixture cannot model
   * a hub saying no, and a subscribe that cannot fail is a subscribe whose failure handling is
   * never executed — which is how the transport below came to swallow every one of them unnoticed
   * (`createHubTunnelTransport`, "Best-effort subscribe; rejection is swallowed").
   *
   * Throws SYNCHRONOUSLY, which `HubBase.subscribe` allows (`Promise<void> | void`): a caller that
   * only catches a rejection is as broken as one that catches nothing.
   */
  subscribe(subscriberDID: string, topicID: string, options?: HubSubscribeOptions): void {
    if (options?.retention != null && options.retention > this.#maxRetention) {
      throw new RetentionExceededError(
        `Requested retention of ${options.retention}s exceeds the maximum of ${this.#maxRetention}s`,
      )
    }
    let set = this.#topics.get(topicID)
    if (set == null) {
      set = new Set()
      this.#topics.set(topicID, set)
    }
    set.add(subscriberDID)
  }

  unsubscribe(subscriberDID: string, topicID: string): void {
    const set = this.#topics.get(topicID)
    if (set == null) return
    set.delete(subscriberDID)
    if (set.size === 0) {
      this.#topics.delete(topicID)
    }
  }

  async publish(params: FakeHubPublishParams): Promise<{ sequenceID: string }> {
    // WHY: zero-padded to 12 digits like the real store (hub-server memoryStore), so lexicographic
    // `>` on sequenceIDs orders the same way here as in production. A bare decimal breaks at the
    // 9→10 boundary ('10' < '9'), which would let a fixture-only bug hide an ordering defect.
    const sequenceID = String(++this.#sequence).padStart(12, '0')
    const message: FakeHubMessage = {
      sequenceID,
      senderDID: params.senderDID,
      topicID: params.topicID,
      payload: params.payload,
    }

    const recipients = this.#topics.get(params.topicID)
    if (recipients != null) {
      for (const recipient of recipients) {
        // WHY: the real hub never echoes a publish back to its sender (hub-server handlers.ts
        // skips `recipientDID === senderDID`). A fixture that echoes lets a transport under test
        // see its own frames on a topic it both publishes to and subscribes to.
        if (recipient === params.senderDID) continue
        const action = this.#nextAction()
        this.#deliver(recipient, message, action)
      }
    }

    return { sequenceID }
  }

  receive(subscriberDID: string): AsyncIterable<FakeHubMessage> & { return: () => void } {
    const queue: Array<FakeHubMessage> = []
    const waiters: Array<(value: IteratorResult<FakeHubMessage>) => void> = []
    let closed = false

    const subscriber: Subscriber = {
      push(message) {
        if (closed) return
        const waiter = waiters.shift()
        if (waiter != null) {
          waiter({ value: message, done: false })
        } else {
          queue.push(message)
        }
      },
      close() {
        if (closed) return
        closed = true
        while (waiters.length > 0) {
          const w = waiters.shift()
          w?.({ value: undefined as unknown as FakeHubMessage, done: true })
        }
      },
    }

    let set = this.#subscribers.get(subscriberDID)
    if (set == null) {
      set = new Set()
      this.#subscribers.set(subscriberDID, set)
    }
    set.add(subscriber)

    const detach = (): void => {
      const current = this.#subscribers.get(subscriberDID)
      if (current != null) {
        current.delete(subscriber)
        if (current.size === 0) {
          this.#subscribers.delete(subscriberDID)
        }
      }
    }

    const iterator: AsyncIterator<FakeHubMessage> = {
      next() {
        if (queue.length > 0) {
          const value = queue.shift() as FakeHubMessage
          return Promise.resolve({ value, done: false })
        }
        if (closed) {
          return Promise.resolve({ value: undefined as unknown as FakeHubMessage, done: true })
        }
        return new Promise((resolve) => {
          waiters.push(resolve)
        })
      },
      return() {
        subscriber.close()
        detach()
        return Promise.resolve({ value: undefined as unknown as FakeHubMessage, done: true })
      },
    }

    return {
      [Symbol.asyncIterator]() {
        return iterator
      },
      return() {
        subscriber.close()
        detach()
      },
    }
  }

  subscriberCount(subscriberDID: string): number {
    const set = this.#subscribers.get(subscriberDID)
    return set == null ? 0 : set.size
  }

  disconnect(subscriberDID: string): void {
    const set = this.#subscribers.get(subscriberDID)
    if (set == null) return
    for (const subscriber of set) {
      subscriber.close()
    }
    this.#subscribers.delete(subscriberDID)
  }

  dropNext(n: number): void {
    this.#pendingDrops += n
  }

  duplicateNext(n: number): void {
    this.#pendingDuplicates += n
  }

  delayNext(ms: number, n: number): void {
    for (let i = 0; i < n; i++) {
      this.#pendingDelays.push(ms)
    }
  }

  swapNextPair(): void {
    this.#pendingSwap = 2
  }

  #nextAction(): DeliveryAction {
    if (this.#pendingDrops > 0) {
      this.#pendingDrops--
      return { kind: 'drop' }
    }
    if (this.#pendingDuplicates > 0) {
      this.#pendingDuplicates--
      return { kind: 'duplicate' }
    }
    if (this.#pendingDelays.length > 0) {
      const ms = this.#pendingDelays.shift() as number
      return { kind: 'delay', ms }
    }
    if (this.#pendingSwap > 0) {
      this.#pendingSwap--
      return this.#pendingSwap === 0 ? { kind: 'swap-flush' } : { kind: 'swap-hold' }
    }
    return { kind: 'normal' }
  }

  #deliver(recipient: string, message: FakeHubMessage, action: DeliveryAction): void {
    const subscribers = this.#subscribers.get(recipient)
    if (subscribers == null || subscribers.size === 0) return

    const push = (): void => {
      for (const sub of subscribers) {
        sub.push(message)
      }
    }

    switch (action.kind) {
      case 'drop':
        return
      case 'normal':
        push()
        return
      case 'duplicate':
        push()
        push()
        return
      case 'delay':
        setTimeout(push, action.ms)
        return
      case 'swap-hold':
        this.#heldForSwap.push({ recipient, message })
        return
      case 'swap-flush': {
        push()
        const held = this.#heldForSwap.splice(0)
        for (const { recipient: r, message: m } of held) {
          const subs = this.#subscribers.get(r)
          if (subs == null) continue
          for (const sub of subs) {
            sub.push(m)
          }
        }
        return
      }
    }
  }
}
