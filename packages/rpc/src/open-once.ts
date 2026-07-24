import type { Unwrap, UnwrapResult } from '@kumiai/broadcast'
import type { StoredMessage } from '@kumiai/hub-protocol'

import type { HubMux } from './hub-mux.js'

export type OpenOncePathParams<Opened> = {
  mux: HubMux
  topicID: string
  unwrap: Unwrap
  /**
   * Turn an opened frame into what this lane's consumers receive. Returning `undefined` drops
   * the frame — the open has already happened either way, so a lane rejects here rather than
   * leaving each consumer to decide.
   */
  project: (message: StoredMessage, opened: UnwrapResult) => Opened | undefined
  /** Called with the raw message BEFORE the open, for anything recorded at the epoch the frame
   * opens against. */
  note?: (message: StoredMessage) => void
  /**
   * Consulted when the open fails (any throw in the chain — `unwrap`, `project`, or a listener).
   * Answering `true` withholds the ack: the frame is sealed at an epoch this handle has not reached
   * yet (the window between a commit landing and this peer applying it) and must survive for a later
   * reconnect. Every other failure acks; `unwrap`'s throw alone can't tell them apart. See
   * `app-lane.ts`'s `note`/`ahead` for the same distinction against a live push.
   */
  retainOnFailure?: (message: StoredMessage) => boolean
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
  const { mux, topicID, unwrap, project, note, retainOnFailure } = params
  const listeners = new Set<(value: Opened) => void>()
  let unsubscribe: (() => void) | undefined
  let opening: Promise<void> = Promise.resolve()
  return (onOpened: (value: Opened) => void): (() => void) => {
    listeners.add(onOpened)
    unsubscribe ??= mux.onInbound(topicID, (message, ack) => {
      note?.(message)
      // Every outcome is HANDLED — opened, or permanently unopenable — except a failure
      // `retainOnFailure` says is not yet reachable, which flips this false to withhold the ack.
      let handled = true
      opening = opening
        .then(async () => {
          const result = await unwrap(message.payload)
          const opened = result instanceof Uint8Array ? { payload: result } : result
          const value = project(message, opened)
          if (value === undefined) return
          // Snapshot: a consumer disposing from inside its own delivery must not perturb the
          // fan-out of the frame it is being given.
          for (const listener of [...listeners]) listener(value)
        })
        .catch(() => {
          // A frame this handle cannot open — another epoch's, another group's, or not a frame at
          // all — is ordinary on a shared log; one failure must not break the chain. `unwrap`'s
          // throw can't say which case it is, and a frame sealed one epoch ahead will open once the
          // handle catches up — acking it here would reclaim a frame never handled. `retainOnFailure`
          // reads the frame's cleartext epoch to tell that apart; every other failure acks.
          if (retainOnFailure?.(message) === true) handled = false
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
