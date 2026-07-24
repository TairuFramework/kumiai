/**
 * Hub protocol for blind pub/sub messaging over opaque topic IDs.
 *
 * @module hub-protocol
 */

export {
  HeadMismatchError,
  HUB_ERROR_CODES,
  type HubErrorCode,
  hubErrorCodeOf,
  hubErrorFromCode,
  InvalidPayloadError,
  NotSubscribedError,
  RetentionExceededError,
} from './errors.js'
export type { HubProtocol } from './protocol.js'
export { hubProtocol } from './protocol.js'
export type {
  AckParams,
  FetchParams,
  FetchResult,
  FetchTopicParams,
  FetchTopicResult,
  HubStore,
  HubStoreEvents,
  PublishParams,
  PublishResult,
  PurgeParams,
  StoredMessage,
  SubscribeParams,
  TrimParams,
} from './types.js'
