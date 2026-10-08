/**
 * High-level MLS-aware group RPC for Enkaku.
 *
 * @module rpc
 */

export type { Anchor, AnchorSlot, AnchorStore } from './anchor.js'
export { type AppAAD, decodeAppAAD, encodeAppAAD } from './app-aad.js'
export type { AppCursorStore, AppWindowPruned } from './app-cursor.js'
export type { AppDeliveryResumed, AppDeliveryStalled } from './app-lane.js'
export {
  type AppOutbox,
  type AppOutboxEntry,
  MAX_APP_ENTRY_BYTES,
} from './app-outbox.js'
export {
  type ClassifyCommitParams,
  type CommitClassifierState,
  type CommitDisposition,
  type CommitFrameEvidence,
  classifyCommit,
  digestAppliedCommit,
  UNKNOWN_FRAME_VERSION,
} from './classify.js'
export {
  CommitDeadlineError,
  isHeadMismatch,
  RecoveryRequiredError,
} from './commit.js'
export {
  COMMIT_FRAME_VERSION,
  type CommitFrame,
  decodeCommitFrame,
  encodeCommitFrame,
  isUnsupportedCommitFrameVersion,
  UnsupportedCommitFrameVersionError,
} from './commit-frame.js'
export type { HostBuilt, OperationDeps } from './control/operations.js'
export { applyChanges, applyResolved, controlSettled, pruneWindow } from './control/store.js'
export type {
  AdoptionWrite,
  AdoptionWriteFactory,
  AppliedCommit,
  BuiltCommit,
  CommitCursor,
  ControlChanges,
  ControlSnapshot,
  ControlStore,
  ExternalResponse,
  ForkEvidence,
  Operation,
  OperationRequest,
  Outcome,
  RecoveryRefusal,
  RejoinRecord,
  StagedAdoption,
  WelcomeObligation,
} from './control/types.js'
export {
  type AppFrameRef,
  AppFrameStorageError,
  type AppliedRecovery,
  type CommitContext,
  type CommitHeader,
  type ExportSecretResult,
  FrameEpochError,
  type GroupCrypto,
  type GroupMLS,
  type GroupUnwrapResult,
  isAppFrameStorageError,
  isMissingLedgerEntries,
  type OpenedRecoveryVerdict,
  type PendingAppFrame,
  type PendingAppFrames,
  type PendingRecovery,
  type ProcessCommitResult,
  type RecoveryConfirmationKey,
  type RecoveryRefusalReason,
  type RecoveryVerdict,
  type RestoredPendingRecovery,
  type RosterEntry,
  type SealEntriesResult,
  type SendAdmission,
  sortPendingAppFrames,
  type VerifiedRecoveryRequest,
} from './crypto.js'
export {
  asDeliveryPosition,
  asLogPosition,
  type DeliveryPosition,
  type LogPosition,
} from './cursor.js'
export {
  AppEntryTooLargeError,
  AppOutboxFullError,
  ControlWriteNotCommittedError,
  GroupControlUnsettledError,
  OperationOutcomeError,
  type OperationOutcomeErrorParams,
  OperationRejectedError,
  PeerDisposedError,
  PeerRemovedError,
  SendNotAdmissibleError,
  StorageOutcomeUnknownError,
} from './errors.js'
export { assertFrameFits, FrameTooLargeError } from './frame-size.js'
export type { GroupProcedureHandlers } from './handlers.js'
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
  LEDGER_ENTRIES_VERSION,
} from './ledger-entries.js'
export type { AppOutboxCleared, EpochFloor } from './log-delivery.js'
export {
  createGroupPeer,
  type GroupPeer,
  type GroupPeerMLSParams,
  type GroupPeerParams,
  type ProtocolSurface,
  type RecoveryEvent,
  type RecoveryFailureDetails,
  type RecoveryFailureReason,
  type RecoveryTrigger,
  type StrandConfidence,
  type StrandKind,
  type StrandObservation,
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
  decodeRecoveryConfirmRequest,
  decodeRecoveryReply,
  decodeRecoveryRequest,
  decodeRecoveryVerdict,
  encodeLedgerReply,
  encodeLedgerRequest,
  encodeRecoveryConfirmRequest,
  encodeRecoveryReply,
  encodeRecoveryRequest,
  encodeRecoveryVerdict,
  type RecoveryConfirmRequest,
  type RecoveryVerdictFrame,
} from './recovery.js'
export { detectRosterChange } from './roster.js'
export {
  APP_TOPIC_LABEL,
  COMMIT_LABEL,
  commitTopic,
  discoveryTopic,
  INBOX_LABEL,
  inboxTopic,
  protocolTopic,
  RENDEZVOUS_LABEL,
  rendezvousTopic,
} from './topic.js'
