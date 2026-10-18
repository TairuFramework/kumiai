import { type GroupHandle, mutexFor } from './group-handle.js'
import { type HoldingToken, withHoldingToken } from './send-policy.js'

/** Test-only hooks for independent application-crypto doubles. The reservation entry always serializes. */
export {
  assertApplicationSend,
  reserveApplicationKernel,
  withReservationLock,
} from './send-policy.js'

/** Test-only: shares the live handle serializer with contract doubles. */
export function serializeHandle<T>(
  handle: GroupHandle,
  fn: (holding: HoldingToken) => Promise<T>,
): Promise<T> {
  return mutexFor(handle).run(() => withHoldingToken(handle, fn))
}
