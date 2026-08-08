import {
  decodeBase64url,
  sealWakeHint,
  type WakeRegistry,
  type WakeSender,
} from '@kumiai/hub-protocol'

export type WakeDispatcherParams = {
  registry: WakeRegistry
  sender: WakeSender
  /** Coalescing window in milliseconds. Default: 10 000. */
  debounceMs?: number
  /** Reports a transient send failure or a throwing sender. Fire-and-forget. */
  onError?: (params: { did: string; error: unknown }) => void
}

export type WakeNotifyParams = {
  did: string
  topicID: string
  sequenceID: string
}

export type WakeDispatcher = {
  /** A frame was queued for an OFFLINE subscriber. Never throws, never awaited by the caller. */
  notify(params: WakeNotifyParams): void
  /** The device bound a receive channel: drop any pending trailing ping. */
  online(did: string): void
  dispose(): void
}

type Pending = {
  timer: ReturnType<typeof setTimeout>
  latest: { topicID: string; sequenceID: string } | null
  count: number
}

const DEFAULT_DEBOUNCE_MS = 10_000

/**
 * Coalesces wake pings per DID on a LEADING edge: the first frame pings immediately, then a window
 * opens and everything inside it collapses into one trailing summary.
 *
 * Leading rather than trailing because the timer map is in-process. A hub restart drops pending
 * windows; on a leading edge that loses at most a summary, whereas trailing-only would lose the
 * notification itself every time a restart landed inside a window.
 */
export function createWakeDispatcher(params: WakeDispatcherParams): WakeDispatcher {
  const debounceMs = params.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const pending = new Map<string, Pending>()
  let disposed = false

  function report(did: string, error: unknown): void {
    try {
      params.onError?.({ did, error })
    } catch {
      // A reporter that throws must not take the dispatcher with it.
    }
  }

  function send(did: string, topicID: string, sequenceID: string, count: number): void {
    // Deliberately not awaited: a slow or hanging provider must never delay the publish fan-out
    // this is called from.
    void (async () => {
      try {
        const registration = await params.registry.get(did)
        if (registration == null) return
        const body = sealWakeHint(
          { topicID, sequenceID, count },
          {
            publicKey: decodeBase64url(registration.publicKey),
            authSecret: decodeBase64url(registration.authSecret),
          },
        )
        const verdict = await params.sender.send({ registration, body })
        if (verdict === 'gone') {
          await params.registry.delete(did)
        } else if (verdict === 'retry') {
          report(did, new Error('Wake send failed transiently'))
        }
      } catch (error) {
        report(did, error)
      }
    })()
  }

  function openWindow(did: string): Pending {
    const entry: Pending = {
      timer: setTimeout(() => {
        const current = pending.get(did)
        pending.delete(did)
        if (current?.latest == null) return
        send(did, current.latest.topicID, current.latest.sequenceID, current.count)
        // Traffic is still flowing, so a fresh window opens behind the summary rather than letting
        // the next frame ping immediately and undo the coalescing.
        pending.set(did, openWindow(did))
      }, debounceMs),
      latest: null,
      count: 0,
    }
    // A pending wake must never hold a process open by itself.
    entry.timer.unref?.()
    return entry
  }

  return {
    notify({ did, topicID, sequenceID }: WakeNotifyParams): void {
      if (disposed) return
      const entry = pending.get(did)
      if (entry == null) {
        pending.set(did, openWindow(did))
        send(did, topicID, sequenceID, 1)
        return
      }
      entry.latest = { topicID, sequenceID }
      entry.count += 1
    },
    online(did: string): void {
      const entry = pending.get(did)
      if (entry == null) return
      clearTimeout(entry.timer)
      pending.delete(did)
    },
    dispose(): void {
      disposed = true
      for (const entry of pending.values()) clearTimeout(entry.timer)
      pending.clear()
    },
  }
}
