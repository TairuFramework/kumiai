import type { LogHub } from '@kumiai/hub-tunnel'

export type RecordingHub = {
  /** The hub to hand a peer. Delegates every call to the inner hub. */
  hub: LogHub
  /** Calls recorded since `start()`, in order. */
  calls: () => Array<string>
  /** Begin recording. Everything before this is delegated and forgotten. */
  start: () => void
}

/**
 * A `LogHub` that delegates everything and records what it was asked for, from `start()` onwards.
 *
 * The late start is the point: a peer's init and teardown talk to the hub constantly, and what these
 * tests assert is that a peer talks to it NEVER — after a specific moment. Recording from
 * construction would bury that in a peer's ordinary life.
 *
 * Hand this to ONE peer. A live peer's mux drain calls `receive` on a loop, so a recorder shared
 * with a second peer can never report an empty list no matter what the peer under test does.
 */
export function createRecordingHub(inner: LogHub): RecordingHub {
  let recording = false
  const calls: Array<string> = []
  const record = (call: string): void => {
    if (recording) calls.push(call)
  }
  return {
    hub: {
      publish: (params) => {
        record(`publish:${params.topicID}`)
        return inner.publish(params)
      },
      subscribe: (subscriberDID, topicID, options) => {
        record(`subscribe:${topicID}`)
        return inner.subscribe(subscriberDID, topicID, options)
      },
      unsubscribe: (subscriberDID, topicID) => {
        record(`unsubscribe:${topicID}`)
        return inner.unsubscribe?.(subscriberDID, topicID)
      },
      receive: (subscriberDID) => {
        record('receive')
        return inner.receive(subscriberDID)
      },
      fetchTopic: (params) => {
        record(`fetchTopic:${params.topicID}`)
        return inner.fetchTopic(params)
      },
    },
    calls: () => calls,
    start: () => {
      recording = true
    },
  }
}
