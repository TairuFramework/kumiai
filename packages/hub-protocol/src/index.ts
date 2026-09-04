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
  CountKeyPackagesParams,
  FetchKeyPackagesParams,
  FetchLastResortKeyPackageParams,
  FetchParams,
  FetchResult,
  FetchTopicParams,
  FetchTopicResult,
  GetSubscribersParams,
  HubStore,
  HubStoreEvents,
  PublishParams,
  PublishResult,
  PurgeParams,
  StoredMessage,
  StoreKeyPackageParams,
  StoreLastResortKeyPackageParams,
  SubscribeParams,
  TrimParams,
  UnsubscribeParams,
} from './types.js'
export type {
  WakeRegistration,
  WakeRegistry,
  WakeSender,
  WakeSendParams,
  WakeVerdict,
} from './wake.js'
export {
  openWakeHint,
  sealWakeHint,
  WAKE_HINT_VERSION,
  WAKE_RECORD_SIZE,
  type WakeHint,
  type WakeOpener,
  type WakeRecipient,
  wakeRecipientKeyProblem,
} from './wake-envelope.js'
