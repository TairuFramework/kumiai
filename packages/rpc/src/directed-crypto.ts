import type { ByteTransform, Unwrap, UnwrapResult } from '@kumiai/broadcast'
import type { StoredMessage } from '@kumiai/hub-protocol'
import type { HubLike, HubPublishParams, HubReceiveSubscription } from '@kumiai/hub-tunnel'

export type SealDirectedHubParams = {
  hub: HubLike
  wrap: ByteTransform
  unwrap: Unwrap
  /** When set, inbound frames whose recovered senderDID != this are dropped. */
  expectedSenderDID?: string
}

function normalizeUnwrap(result: Uint8Array | UnwrapResult): UnwrapResult {
  return result instanceof Uint8Array ? { payload: result } : result
}

/**
 * Wrap a HubLike so directed frames are sealed with `wrap` on publish and opened
 * with `unwrap` on receive. The recovered MLS `senderDID` replaces the
 * hub-asserted one (a lying hub cannot forge it); frames that fail to open, or
 * whose recovered sender != `expectedSenderDID`, are dropped.
 */
export function sealDirectedHub(params: SealDirectedHubParams): HubLike {
  const { hub, wrap, unwrap, expectedSenderDID } = params
  return {
    async publish(publishParams: HubPublishParams): Promise<{ sequenceID: string }> {
      const sealed = await wrap(publishParams.payload)
      return hub.publish({
        senderDID: publishParams.senderDID,
        topicID: publishParams.topicID,
        payload: sealed,
      })
    },
    subscribe: (subscriberDID, topicID) => hub.subscribe(subscriberDID, topicID),
    unsubscribe: (subscriberDID, topicID) => hub.unsubscribe?.(subscriberDID, topicID),
    receive(subscriberDID): HubReceiveSubscription {
      const inner = hub.receive(subscriberDID)
      const innerIterator = inner[Symbol.asyncIterator]()
      const iterator: AsyncIterator<StoredMessage> = {
        async next(): Promise<IteratorResult<StoredMessage>> {
          while (true) {
            const result = await innerIterator.next()
            if (result.done) {
              return { value: undefined as unknown as StoredMessage, done: true }
            }
            const message = result.value
            let opened: UnwrapResult
            try {
              opened = normalizeUnwrap(await unwrap(message.payload))
            } catch {
              continue // un-openable (garbage / another lane) — drop
            }
            if (expectedSenderDID != null && opened.senderDID !== expectedSenderDID) {
              continue
            }
            return {
              value: {
                sequenceID: message.sequenceID,
                senderDID: opened.senderDID ?? message.senderDID,
                topicID: message.topicID,
                payload: opened.payload,
              },
              done: false,
            }
          }
        },
        return(): Promise<IteratorResult<StoredMessage>> {
          innerIterator.return?.()
          return Promise.resolve({ value: undefined as unknown as StoredMessage, done: true })
        },
      }
      return {
        [Symbol.asyncIterator]() {
          return iterator
        },
        return() {
          inner.return?.()
        },
      }
    },
  }
}
