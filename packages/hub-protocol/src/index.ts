/**
 * Hub protocol for blind pub/sub messaging over opaque topic IDs.
 *
 * @module hub-protocol
 */

export { keyPackageDigest } from './digest.js'
export {
  AuthorizationDeniedError,
  HeadMismatchError,
  HUB_ERROR_CODES,
  type HubErrorCode,
  hubErrorCodeOf,
  hubErrorFromCode,
  InvalidPayloadError,
  KeyPackageFetchLimitError,
  KeyPackageQuotaExceededError,
  NotSubscribedError,
  RetentionExceededError,
  SubscriptionQuotaExceededError,
  WakeNotSupportedError,
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
export type {
  WakeRegistration,
  WakeRegistry,
  WakeSender,
  WakeSendParams,
  WakeVerdict,
} from './wake.js'
export {
  decodeBase64url,
  encodeBase64url,
  openWakeHint,
  sealWakeHint,
  WAKE_HINT_VERSION,
  WAKE_RECORD_SIZE,
  type WakeHint,
  type WakeOpener,
  type WakeRecipient,
} from './wake-envelope.js'
