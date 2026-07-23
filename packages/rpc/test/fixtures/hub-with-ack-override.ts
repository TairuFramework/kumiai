import type { HubReceiveSubscription, LogHub } from '@kumiai/hub-tunnel'

import type { DurableFakeHub } from './durable-fake-hub.js'

/**
 * Wraps a `DurableFakeHub` instance, replacing its `receive` subscription's `ack` with
 * `ackOverride` (given the real subscription, so it may still delegate to it). The hub is
 * delegated per-method rather than spread (`{...instance}`): `DurableFakeHub` is a class, and a
 * spread copies only its own enumerable properties, dropping every prototype method. The
 * subscription IS spread (`...subscription`) — safe only because `DurableFakeHub.receive` returns
 * an object literal, so its members are own and enumerable; that distinction does not hold for the
 * hub itself, which is why the two are built differently here.
 */
export function hubWithAckOverride(
  instance: DurableFakeHub,
  ackOverride: (subscription: HubReceiveSubscription, sequenceID: string) => void | Promise<void>,
): LogHub {
  return {
    subscribe: (subscriberDID, topicID, options) =>
      instance.subscribe(subscriberDID, topicID, options),
    unsubscribe: (subscriberDID, topicID) => instance.unsubscribe(subscriberDID, topicID),
    publish: (params) => instance.publish(params),
    fetchTopic: (params) => instance.fetchTopic(params),
    receive: (subscriberDID) => {
      const subscription = instance.receive(subscriberDID)
      return {
        ...subscription,
        ack: (sequenceID: string) => ackOverride(subscription, sequenceID),
      }
    },
  }
}
