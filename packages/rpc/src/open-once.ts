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
  /** Called with the raw message BEFORE the open, for anything that must be recorded at the
   * epoch the frame is about to be opened against. */
  note?: (message: StoredMessage) => void
}

/**
 * ONE INBOUND PATH PER TOPIC, shared by every consumer built on it.
 *
 * OPENING IS A CONSUMING OPERATION. `unwrap` spends the frame's own per-message ratchet key on
 * the handle it opens against, so the same bytes open exactly once and every later open of them
 * fails — not because the frame is bad, but because its key is gone. The port says so (see
 * {@link GroupCrypto.unwrap}); it cannot be duplicated, and a lane that gave two consumers an
 * `unwrap` each would have them race for one key with the loser silently dropping the frame.
 *
 * So the frame is opened HERE, once, and the opened result is fanned out over plaintext.
 *
 * EVERY multi-consumer topic goes through this, not just the app lane. The self-inbox topic has
 * the most consumers of any — an acceptor per protocol, plus one directed client per member being
 * spoken to — and each holding its own `unwrap` is exactly why a directed request went unanswered
 * over real MLS while the XOR fake, which could open the same bytes twice, stayed green.
 *
 * Opens are chained rather than launched per message, so frames are opened in arrival order.
 * `unwrap` is async with variable latency, and a lane whose opens resolved out of order would
 * feed a tunnel out of wire order — dropped as a stale seq — or double-create a session.
 *
 * Subscribed through the mux's raw inbound path rather than its bus view, because the bus view
 * hands on the payload alone and a frame's log position is the one thing a lane could not
 * otherwise write down.
 *
 * The mux subscription is held for as long as a consumer wants it and released with the last one,
 * which is what keeps a rotation's teardown from leaving a listener behind on a topic the group
 * has left.
 */
export function createOpenOncePath<Opened>(
  params: OpenOncePathParams<Opened>,
): (onOpened: (value: Opened) => void) => () => void {
  const { mux, topicID, unwrap, project, note } = params
  const listeners = new Set<(value: Opened) => void>()
  let unsubscribe: (() => void) | undefined
  let opening: Promise<void> = Promise.resolve()
  return (onOpened: (value: Opened) => void): (() => void) => {
    listeners.add(onOpened)
    unsubscribe ??= mux.onInbound(topicID, (message, ack) => {
      note?.(message)
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
          // all. Ordinary on a shared log, and the read paths are built to walk past it. One
          // frame's failure must not break the chain the rest are opened on.
        })
        .finally(() => {
          // Acked on BOTH paths, and only once this frame's link has settled. A frame that could
          // not be opened has still been handled — leaving it unacked redelivers the same
          // undecryptable bytes on every reconnect, forever. Acking on arrival instead would
          // release it before the open that consumes its ratchet key had run.
          ack()
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
