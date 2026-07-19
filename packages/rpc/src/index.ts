/**
 * High-level MLS-aware group RPC for Enkaku.
 *
 * @module rpc
 */

export type { Anchor, AnchorStore } from './anchor.js'
export type { AppCursorStore, AppWindowPruned } from './app-cursor.js'
export {
  type CommitClassifierState,
  type CommitDisposition,
  classifyCommit,
} from './classify.js'
export {
  CommitDeadlineError,
  type CommitJournal,
  type CommitKind,
  isHeadMismatch,
  type JournalEntry,
  JournalEpochError,
  type LaneResult,
  type LostCommit,
  type PendingCommit,
  RecoveryRequiredError,
} from './commit.js'
export {
  type CommitFrame,
  decodeCommitFrame,
  encodeCommitFrame,
} from './commit-frame.js'
export {
  type CommitContext,
  type CommitHeader,
  type GroupCrypto,
  type GroupMLS,
  isMissingLedgerEntries,
  type PendingRecovery,
} from './crypto.js'
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
export type { ReceiveLaneEnded, SubscribeFailure } from './hub-mux.js'
export {
  createLedgerEntryResolver,
  decodeLedgerEntries,
  encodeLedgerEntries,
} from './ledger-entries.js'
export {
  createGroupPeer,
  type GroupPeer,
  type GroupPeerMLSParams,
  type GroupPeerParams,
  type ProtocolSurface,
} from './peer.js'
export {
  defineGroupProtocol,
  type GroupProcedureDefinition,
  type GroupProtocolDefinition,
  type RetainableEventProcedureDefinition,
  type Retention,
  retentionOf,
} from './protocol.js'
export {
  decodeLedgerReply,
  decodeLedgerRequest,
  decodeRecoveryReply,
  decodeRecoveryRequest,
  encodeLedgerReply,
  encodeLedgerRequest,
  encodeRecoveryReply,
  encodeRecoveryRequest,
} from './recovery.js'
export { detectRosterChange } from './roster.js'
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
