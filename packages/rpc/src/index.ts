/**
 * High-level MLS-aware group RPC for Enkaku.
 *
 * @module rpc
 */

export { defineGroupProtocol, type GroupProtocolDefinition } from '@kumiai/broadcast'

export type { CommitContext, GroupCrypto, GroupMLS } from './crypto.js'
export {
  asDeliveryPosition,
  asLogPosition,
  type DeliveryPosition,
  type LogPosition,
} from './cursor.js'
export {
  decodeHandshakeFrame,
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
  HANDSHAKE_MAGIC,
  HANDSHAKE_VERSION,
  type HandshakeKind,
} from './handshake.js'
export {
  createMemoryGroupMLS,
  type MemoryGroupMLS,
  type MemoryGroupMLSOptions,
} from './memory-group-mls.js'
export {
  createGroupPeer,
  type GroupPeer,
  type GroupPeerParams,
  type ProtocolSurface,
} from './peer.js'
export {
  decodeRecoveryReply,
  decodeRecoveryRequest,
  encodeRecoveryReply,
  encodeRecoveryRequest,
} from './recovery.js'
export {
  COMMIT_LABEL,
  commitTopic,
  discoveryTopic,
  INBOX_LABEL,
  inboxTopic,
  protocolTopic,
  RENDEZVOUS_LABEL,
  rendezvousTopic,
} from './topic.js'
