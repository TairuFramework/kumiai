/**
 * Hub protocol for blind pub/sub messaging over opaque topic IDs.
 *
 * @module hub-protocol
 */

export { HeadMismatchError, NotSubscribedError } from './errors.js'
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
  PurgeParams,
  StoredMessage,
  TrimParams,
} from './types.js'
