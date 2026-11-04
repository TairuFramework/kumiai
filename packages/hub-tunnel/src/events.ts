import type { DecryptError, EnvelopeDecodeError, ExpiredFrameError } from './errors.js'

export type FrameDroppedReason =
  | 'envelope-decode'
  | 'decrypt'
  /** Meant for this reader, but its key is gone: see `ExpiredFrameError`. */
  | 'expired'
  | 'group-mismatch'
  | 'topic-mismatch'
  | 'session-mismatch'
  | 'stale-session-end'
  | 'dedup'

export type ObservabilityEvent =
  | { type: 'decrypt-failed'; error: DecryptError }
  | { type: 'frame-expired'; error: ExpiredFrameError }
  | { type: 'envelope-decode-failed'; error: EnvelopeDecodeError }
  | { type: 'decrypt-drain-timeout'; timeoutMs: number }
  | { type: 'ack-failed'; sequenceID: string; error: unknown }
  | { type: 'frame-dropped'; reason: FrameDroppedReason }

export type ObservabilityEventListener = (event: ObservabilityEvent) => void
