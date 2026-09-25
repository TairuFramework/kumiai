import type { StoredMessage } from '@kumiai/hub-protocol'

import type { GroupUnwrapResult } from './crypto.js'
import type { HubMux } from './hub-mux.js'

export type OpenOncePathParams<Opened> = {
  mux: HubMux
  topicID: string
  unwrap: (bytes: Uint8Array) => GroupUnwrapResult | Promise<GroupUnwrapResult>
  /**
   * Turn an opened frame into what this lane's consumers receive. Returning `undefined` drops
   * the frame — the open has already happened either way, so a lane rejects here rather than
   * leaving each consumer to decide.
   */
  project: (message: StoredMessage, opened: GroupUnwrapResult) => Opened | undefined
  /** Called with the raw message once its open settles: `undefined` when it opened, else the
   * throw. The throw carries the handle's locked answer ({@link "crypto".FrameEpochError}). */
  note?: (message: StoredMessage, failure: unknown) => void
  /** A live push that only asks its owner to read the retained log. */
  wakeup?: (message: StoredMessage) => boolean
  /**
   * Consulted when the open fails (any throw in the chain — `unwrap`, `project`, or a listener).
   * Answering `true` withholds the ack: the frame is sealed at an epoch this handle has not reached
   * yet (the window between a commit landing and this peer applying it) and must survive for a later
   * reconnect. Every other failure acks. See `app-lane.ts`'s `note` for the same distinction against
   * a live push.
   */
  retainOnFailure?: (message: StoredMessage, error: unknown) => boolean
}

/**
 * ONE INBOUND PATH PER TOPIC, shared by every consumer built on it.
 *
 * Opening is a CONSUMING operation: `unwrap` spends the frame's per-message ratchet key, so the same
 * bytes open exactly once (see {@link GroupCrypto.unwrap}). Two consumers each holding their own
 * `unwrap` would race for one key, the loser silently dropping the frame — so the frame is opened
 * HERE, once, and fanned out over plaintext. Every multi-consumer topic goes through this; the
 * self-inbox (an acceptor per protocol plus a directed client per member) is why a directed request
 * went unanswered over real MLS while the XOR fake, which could open bytes twice, stayed green.
 *
 * Opens are CHAINED, not per-message, so frames open in arrival order — out-of-order opens would
 * feed a tunnel a stale seq or double-create a session. Subscribed through the mux's raw inbound
 * path, not its bus view, because only the raw path carries the frame's log position. The
 * subscription is released with the last consumer, so a rotation's teardown leaves nothing behind.
 */
export function createOpenOncePath<Opened>(
  params: OpenOncePathParams<Opened>,
): (onOpened: (value: Opened) => void) => () => void {
  const { mux, topicID, unwrap, project, note, wakeup, retainOnFailure } = params
  const listeners = new Set<(value: Opened) => void>()
  let unsubscribe: (() => void) | undefined
  let opening: Promise<void> = Promise.resolve()
  return (onOpened: (value: Opened) => void): (() => void) => {
    listeners.add(onOpened)
    unsubscribe ??= mux.onInbound(topicID, (message, ack) => {
      if (wakeup?.(message) === true) {
        ack()
        return
      }
      // Every outcome is HANDLED — opened, or permanently unopenable — except a failure
      // `retainOnFailure` says is not yet reachable, which flips this false to withhold the ack.
      let handled = true
      opening = opening
        .then(async () => {
          let opened: GroupUnwrapResult
          try {
            opened = await unwrap(message.payload)
          } catch (error) {
            note?.(message, error)
            throw error
          }
          note?.(message, undefined)
          const value = project(message, opened)
          if (value === undefined) return
          // Snapshot: a consumer disposing from inside its own delivery must not perturb the
          // fan-out of the frame it is being given.
          for (const listener of [...listeners]) listener(value)
        })
        .catch((error: unknown) => {
          // A frame this handle cannot open — another epoch's, another group's, or not a frame at
          // all — is ordinary on a shared log; one failure must not break the chain. A frame sealed
          // ahead will open once the handle catches up, so acking it would reclaim a frame never
          // handled; `retainOnFailure` reads that from the open's own refusal.
          if (retainOnFailure?.(message, error) === true) handled = false
        })
        .finally(() => {
          // Acked once the frame's link settles, unless `handled` was flipped false. Acking on
          // arrival would release it before the open that consumes its ratchet key ran.
          if (handled) ack()
        })
    })
    return () => {
      listeners.delete(onOpened)
      if (listeners.size === 0) {
        unsubscribe?.()
        unsubscribe = undefined
      }
    }
  }
}
