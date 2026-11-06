/**
 * Generic fan-out broadcast primitives for Enkaku RPC.
 *
 * @module broadcast
 */

export type { BroadcastBusPublishParams, BroadcastBusSubscribeParams } from './bus.js'
export { type BroadcastBus, createMemoryBus } from './bus.js'
export type {
  BroadcastClientDispatchParams,
  BroadcastClientGatherParams,
  BroadcastClientRequestParams,
} from './client.js'
export {
  BroadcastClient,
  type BroadcastClientParams,
  type GatheredReply,
  type GatherOptions,
  type ReplyData,
  type RequestData,
  type RequestOptions,
} from './client.js'
export type { BuildEventMessageParams, EncodeEventFrameParams } from './event-frame.js'
export { buildEventMessage, encodeEventFrame } from './event-frame.js'
export { defineGroupProtocol, type GroupProtocolDefinition } from './protocol.js'
export type { BroadcastHandlerParams, SuppressibleParams } from './responder.js'
export {
  type BroadcastHandler,
  type BroadcastResponderParams,
  type BusEvent,
  type BusEvents,
  createBroadcastResponder,
  type SuppressConfig,
  type SuppressibleHandler,
  suppressible,
} from './responder.js'
export type { DeriveTopicIDParams } from './topic.js'
export { deriveTopicID } from './topic.js'
export {
  BROADCAST_VERSION,
  type BroadcastMessage,
  type BroadcastTransportParams,
  type ByteTransform,
  createBroadcastTransport,
  decodeFrame,
  encodeFrame,
  type Unwrap,
  type UnwrapResult,
} from './transport.js'
export { defaultJitter, defaultRandomID, defaultSleep, isSuppressible } from './utils.js'
