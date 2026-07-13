/**
 * High-level MLS-aware group RPC for Enkaku.
 *
 * @module rpc
 */

export { defineGroupProtocol, type GroupProtocolDefinition } from '@kumiai/broadcast'

export {
  type CommitFrame,
  decodeCommitFrame,
  encodeCommitFrame,
} from './commit-frame.js'
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
  createLedgerEntryResolver,
  decodeLedgerEntries,
  encodeLedgerEntries,
} from './ledger-entries.js'
export {
  createMemoryGroupMLS,
  encodeMemoryCommit,
  type MemoryGroupMLS,
  type MemoryGroupMLSOptions,
  MissingLedgerEntriesError,
  memoryEntryID,
} from './memory-group-mls.js'
export {
  createGroupPeer,
  type GroupPeer,
  type GroupPeerParams,
  type LocalCommitOptions,
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
