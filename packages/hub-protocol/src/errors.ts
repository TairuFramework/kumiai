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
