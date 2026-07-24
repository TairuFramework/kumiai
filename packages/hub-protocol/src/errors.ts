/**
 * Wire codes for the hub's named errors, carried in the error reply's `code`. They exist so a
 * caller can tell "I lost the compare-and-set, rebase and retry" from "the hub is unreachable":
 * a transport failure carries no hub code at all.
 */
export const HUB_ERROR_CODES = {
  headMismatch: 'HUB_HEAD_MISMATCH',
  notSubscribed: 'HUB_NOT_SUBSCRIBED',
  retentionExceeded: 'HUB_RETENTION_EXCEEDED',
  invalidPayload: 'HUB_INVALID_PAYLOAD',
  authorizationDenied: 'HUB_AUTHORIZATION_DENIED',
  keyPackageQuota: 'HUB_KEYPACKAGE_QUOTA',
  subscriptionQuota: 'HUB_SUBSCRIPTION_QUOTA',
  keyPackageFetchLimit: 'HUB_KEYPACKAGE_FETCH_LIMIT',
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

/** A published payload was not decodable (e.g. malformed base64). The request is refused. */
export class InvalidPayloadError extends Error {
  override name = 'InvalidPayloadError'
}

/** An authorize hook refused the request. A settled answer, not a transient failure: the caller
 * must not retry it as though the hub were unreachable. */
export class AuthorizationDeniedError extends Error {
  override name = 'AuthorizationDeniedError'
}

/** An upload would push a DID's stored key packages past the hub's per-DID cap. Rejected, not
 * evicted: dropping an existing package would discard one the owner expects to be consumed. */
export class KeyPackageQuotaExceededError extends Error {
  override name = 'KeyPackageQuotaExceededError'
}

/** A subscribe would push a DID past the hub's per-DID subscription cap. */
export class SubscriptionQuotaExceededError extends Error {
  override name = 'SubscriptionQuotaExceededError'
}

/** A key-package fetch was throttled — the per-requester window or the per-target consumption
 * quota is exhausted. */
export class KeyPackageFetchLimitError extends Error {
  override name = 'KeyPackageFetchLimitError'
}

/** The wire code a hub error crosses as, or null if it is not one of the named hub errors. */
export function hubErrorCodeOf(error: unknown): HubErrorCode | null {
  if (error instanceof HeadMismatchError) return HUB_ERROR_CODES.headMismatch
  if (error instanceof NotSubscribedError) return HUB_ERROR_CODES.notSubscribed
  if (error instanceof RetentionExceededError) return HUB_ERROR_CODES.retentionExceeded
  if (error instanceof InvalidPayloadError) return HUB_ERROR_CODES.invalidPayload
  if (error instanceof AuthorizationDeniedError) return HUB_ERROR_CODES.authorizationDenied
  if (error instanceof KeyPackageQuotaExceededError) return HUB_ERROR_CODES.keyPackageQuota
  if (error instanceof SubscriptionQuotaExceededError) return HUB_ERROR_CODES.subscriptionQuota
  if (error instanceof KeyPackageFetchLimitError) return HUB_ERROR_CODES.keyPackageFetchLimit
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
    case HUB_ERROR_CODES.invalidPayload:
      return new InvalidPayloadError(message)
    case HUB_ERROR_CODES.authorizationDenied:
      return new AuthorizationDeniedError(message)
    case HUB_ERROR_CODES.keyPackageQuota:
      return new KeyPackageQuotaExceededError(message)
    case HUB_ERROR_CODES.subscriptionQuota:
      return new SubscriptionQuotaExceededError(message)
    case HUB_ERROR_CODES.keyPackageFetchLimit:
      return new KeyPackageFetchLimitError(message)
    default:
      return null
  }
}
