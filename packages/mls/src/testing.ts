import { type GroupHandle, mutexFor } from './group-handle.js'
import { type HoldingToken, withHoldingToken } from './send-policy.js'

/** Test-only hooks for independent application-crypto doubles. */
export { assertApplicationSend, reserveApplicationKernel } from './send-policy.js'

/** Test-only: shares the live handle serializer with contract doubles. */
export function serializeHandle<T>(
  handle: GroupHandle,
  fn: (holding: HoldingToken) => Promise<T>,
): Promise<T> {
  return mutexFor(handle).run(() => withHoldingToken(handle, fn))
}
