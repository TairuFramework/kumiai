export {
  type AppCompletionCoverage,
  type AppCompletionCoverageBinding,
  type AppCompletionCoverageSource,
  bindAppCompletionCoverage,
  registerAppCompletionCoverage,
} from './app-completion-coverage.js'
export { effectiveRecoveryEpochFloor } from './control/rejoin.js'
export { RecoveryTargetBehindError, SavedControlCompatibilityError } from './errors.js'
export { INTERNAL_OPERATION_PREFIX, type InternalOperations } from './peer-types.js'
/**
 * High-level MLS-aware group RPC for Enkaku.
 *
 * @module rpc
 */

export type { LogHub, MailboxHub } from '@kumiai/hub-tunnel'

export type { Anchor, AnchorSlot, AnchorStore } from './anchor.js'
export { type AppAAD, decodeAppAAD, encodeAppAAD } from './app-aad.js'
export {
  type AppBatchBinding,
  appBatch,
  type BatchBudget,
  type BatchKind,
  bindAppBatch,
  type GroupBatchScheduler,
  type StreamingOpenResult,
} from './app-batch.js'
export type { AppCursorStore, AppWindowPruned } from './app-cursor.js'
export { decodeAppEntry } from './app-entry.js'
export {
  type AppEventPlaintext,
  appFrameIdempotencyKey,
  decodeAppEventPlaintext,
  InvalidAppEntryError,
  isAppLogPosition,
  RETAINED_EPOCHS_DEFAULT,
  RETAINED_EPOCHS_MAX,
} from './app-frame.js'
export { type AppDeliveryResumed, type AppDeliveryStalled, frameID } from './app-lane.js'
export {
  type AppAttempt,
  type AppOutbox,
  type AppOutboxEntry,
  type AppPublicationOutcome,
  type AppSettlementExpected,
  type AppSettlementObligation,
  type AppSettlementResult,
  type AppStatusEvent,
  MAX_APP_ENTRY_BYTES,
} from './app-outbox.js'
export type {
  AppPublicationPort,
  AppPublicationSnapshot,
  PreparedAppPublication,
} from './app-publication.js'
export { checkpointServiceHostMembers, retainForkEvidence } from './checkpoint.js'
export type {
  AbandonedEpochRange,
  BranchAbandonedEvent,
  BranchReportCoverage,
  CheckpointComparison,
  CheckpointCoverage,
  CheckpointFactRecord,
  CheckpointPort,
  CheckpointRecord,
  CheckpointService,
  CheckpointStore,
  ManualRecoveryRecord,
  ManualRecoveryStatus,
  PersistedManualRecovery,
  SuccessorTombstone,
} from './checkpoint-types.js'
export { createCheckpointWorker } from './checkpoint-worker.js'
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
export type {
  ControlBuildPort,
  FrameControlBuild,
  PrepareControlResult,
  SaveControlBuild,
} from './control/build.js'
export type {
  LegacyControlOperation,
  LegacyControlSlot,
  LegacyControlSnapshot,
  LegacyMainJournal,
} from './control/legacy-input.js'
export { type ControlMigrationSource, migrateLegacyControl } from './control/legacy-migration.js'
export { searchOccurrence } from './control/occurrence.js'
export type { HostBuilt, OperationDeps } from './control/operations.js'
export {
  controlSafetyHeld,
  type ForkHalt,
  forkEventID,
  type GroupCondition,
  type GroupConditionEvent,
  type GroupForkEvidence,
  type GroupSafetyEvent,
  isHardControlHold,
  type NotMemberEvidence,
  type RecoveryUnavailableEvent,
  recoveryUnavailableEventID,
  type SafetyHold,
} from './control/safety.js'
export type {
  ControlEvidenceSnapshot,
  ControlFrameValidation,
  ControlHold,
  ControlLogFrame,
  ControlValidation,
  ControlValidationPort,
} from './control/search.js'
export {
  type BuildClosure,
  type ControlSlotDeps,
  closeControlBuild,
  consumeOwnOccurrence,
  controlBuildRef,
} from './control/slot.js'
export {
  applyChanges,
  applyResolved,
  assertCommitOnceChange,
  type CommitOnceWriteContext,
  ControlStoreInvariantError,
  controlAdoptionAllowed,
  controlOccurrenceCoverage,
  controlOwnConsumptionAllowed,
  controlSettled,
  deleteOperationChanges,
  pruneWindow,
  readmissionChanges,
} from './control/store.js'
export type {
  AdoptionExpected,
  AdoptionWrite,
  AdoptionWriteFactory,
  AppliedCommit,
  BuiltCommit,
  CommitCursor,
  ControlAdoptionPort,
  ControlBuildRef,
  ControlChanges,
  ControlSlot,
  ControlSnapshot,
  ControlSource,
  ControlStore,
  EpochIdentity,
  ExternalResponse,
  GroupKey,
  HostLostCommit,
  LegacyRejoinRecord,
  Operation,
  OperationRequest,
  Outcome,
  OwnOccurrence,
  RecoveryRefusal,
  RejoinRecord,
  StagedAdoption,
  WelcomeObligation,
} from './control/types.js'
export { executableOperations } from './control/types.js'
export { deliverObligations } from './control/welcome.js'
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
  type LegacyPendingRecovery,
  type OpenAppInput,
  type OpenAppResult,
  type OpenedRecoveryVerdict,
  type PendingAppFrame,
  type PendingAppFrames,
  type PendingRecovery,
  type PreOpenAppFrameRef,
  type ProcessCommitResult,
  type RecoveryCommitValidation,
  type RecoveryConfirmationBinding,
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
  compareLogPositions,
  type DeliveryPosition,
  type LogPosition,
} from './cursor.js'
export {
  AppEntryTooLargeError,
  AppOutboxFullError,
  ControlSafetyImmutableError,
  ControlWriteNotCommittedError,
  type GroupConditionErrorParams,
  GroupControlUnsettledError,
  GroupSafetyHeldError,
  OperationOutcomeError,
  type OperationOutcomeErrorParams,
  OperationRejectedError,
  PeerDisposedError,
  PeerRemovedError,
  SendNotAdmissibleError,
  SpentSetCorruptError,
  StorageOutcomeUnknownError,
} from './errors.js'
export {
  type CheckpointStatement,
  type CoverageGapReason,
  type ForkBranch,
  type ForkNotice,
  type ForkNoticeEvent,
  foldForkNotices,
  forkNoticeEmissions,
  type OwnBranchMessage,
  type ReportCoverage,
} from './fork-notice.js'
export { assertFrameFits, FrameTooLargeError } from './frame-size.js'
export type { GroupTransaction, HandlerCompletion } from './handler-completion.js'
export {
  combineDurableHandlers,
  type DurableHandler,
  type GroupHandlerMetadata,
  type GroupProcedureHandlers,
  groupHandlerMetadata,
  type MetadataHandler,
} from './handlers.js'
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
  DeliveredEntryCopyError,
  decodeLedgerEntries,
  encodeLedgerEntries,
  LEDGER_ENTRIES_VERSION,
  LedgerEntryRefusedError,
  UnsupportedLedgerEntriesVersionError,
} from './ledger-entries.js'
export type { AppOutboxCleared, EpochFloor } from './log-delivery.js'
export {
  assertOpenedDeliveryEntry,
  bindOpenedDelivery,
  createOpenedAppHandler,
  normaliseOpenedAppHandler,
  type OpenedAppHandler,
  type OpenedDeliveryBinding,
  type OpenedDeliveryContext,
  OpenedDeliveryReentryError,
  openedDeliveryBinding,
  requireOpenedDeliveryContext,
  runOpenedDelivery,
} from './opened-delivery.js'
export {
  type CurrentMoveInputs,
  canMoveCurrent,
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
export type { CommitPrefix } from './recovery-capture.js'
export {
  type AcceptedRejoinSettlement,
  type AuthenticatedRosterAbsence,
  assignRecoverySwitchMutationID,
  type CapturedAppliedRecovery,
  type CapturedPendingRecovery,
  type CapturedRecapture,
  type CapturedRecoveryPort,
  type CapturedRejoinRecord,
  type ConfirmedRecoveryHandoff,
  copyRecoveryOrigin,
  copyRecoverySource,
  copyRecoveryTargetCapture,
  type ForkRecoveryAttempt,
  type ForkRecoveryAuthorisation,
  type RecoveryCompletion,
  type RecoveryContinuation,
  type RecoveryContinuationPort,
  type RecoveryOrigin,
  type RecoveryReconciliation,
  type RecoverySource,
  type RecoveryTargetCapture,
  type ResyncProof,
  raiseRecoveryEpochFloor,
  type StoredRejoinRecord,
  validateCaptureHead,
} from './recovery-types.js'
export { detectLeafAdmission, detectRosterChange } from './roster.js'
export {
  APP_TOPIC_LABEL,
  COMMIT_LABEL,
  checkpointTopic,
  commitTopic,
  discoveryTopic,
  INBOX_LABEL,
  inboxTopic,
  protocolTopic,
  RENDEZVOUS_LABEL,
  rendezvousTopic,
} from './topic.js'
