/**
 * Wire codes for the hub's named errors, carried in the error reply's `code`. They exist so a
 * caller can tell "I lost the compare-and-set, rebase and retry" from "the hub is unreachable":
 * a transport failure carries no hub code at all.
 */
export const HUB_ERROR_CODES = {
  headMismatch: 'HUB_HEAD_MISMATCH',
  notSubscribed: 'HUB_NOT_SUBSCRIBED',
  retentionExceeded: 'HUB_RETENTION_EXCEEDED',
} as const

export type HubErrorCode = (typeof HUB_ERROR_CODES)[keyof typeof HUB_ERROR_CODES]

/** A conditional publish lost the compare-and-set: the topic's head was not `expectedHead`. */
export class HeadMismatchError extends Error {
  override name = 'HeadMismatchError'
}

/** `fetchTopic` was called by a DID that is not a current subscriber of the topic. */
export class NotSubscribedError extends Error {
  override name = 'NotSubscribedError'
}

/**
 * A subscribe requested a retention above the hub's maximum. The request is refused, never
 * clamped: a peer that believed it had asked for more would otherwise be stranded.
 */
export class RetentionExceededError extends Error {
  override name = 'RetentionExceededError'
}

/** The wire code a hub error crosses as, or null if it is not one of the named hub errors. */
export function hubErrorCodeOf(error: unknown): HubErrorCode | null {
  if (error instanceof HeadMismatchError) return HUB_ERROR_CODES.headMismatch
  if (error instanceof NotSubscribedError) return HUB_ERROR_CODES.notSubscribed
  if (error instanceof RetentionExceededError) return HUB_ERROR_CODES.retentionExceeded
  return null
}

/**
 * Rebuild a named hub error from an error reply's code, so a caller can branch on the error class
 * rather than on a string. Returns null for anything else — including a transport failure, which
 * is exactly the distinction that matters.
 */
export function hubErrorFromCode(code: string, message: string): Error | null {
  switch (code) {
    case HUB_ERROR_CODES.headMismatch:
      return new HeadMismatchError(message)
    case HUB_ERROR_CODES.notSubscribed:
      return new NotSubscribedError(message)
    case HUB_ERROR_CODES.retentionExceeded:
      return new RetentionExceededError(message)
    default:
      return null
  }
}
