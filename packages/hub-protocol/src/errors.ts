/** A conditional publish lost the compare-and-set: the topic's head was not `expectedHead`. */
export class HeadMismatchError extends Error {
  override name = 'HeadMismatchError'
}

/** `fetchTopic` was called by a DID that is not a current subscriber of the topic. */
export class NotSubscribedError extends Error {
  override name = 'NotSubscribedError'
}
