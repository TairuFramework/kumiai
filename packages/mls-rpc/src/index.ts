/**
 * The `@kumiai/rpc` consumer ports implemented over `@kumiai/mls`.
 *
 * ## Why this is its own package
 *
 * `@kumiai/rpc` does not depend on `@kumiai/mls` and must not: it owns transport and
 * orchestration, and its whole design rests on never importing MLS — `GroupCrypto` and
 * `GroupMLS` exist precisely so the consumer supplies that half. `@kumiai/mls` in turn does
 * not depend on `@kumiai/rpc`: it is the crypto core, and a group library that imported an
 * RPC package's types would invert the stack.
 *
 * So the implementation of one package's ports over the other's handle belongs above both,
 * and it is a real implementation rather than a fixture: it is what a host wires, and it is
 * the only place where the two contracts are checked against each other by a compiler. Living
 * in `rpc/src` as a default would give rpc an MLS dependency; living in `mls/src` would mean
 * writing the port shape from memory with nothing to verify it against, which is the exact
 * failure mode the seam already has.
 *
 * @module mls-rpc
 */

export type {
  ControlAdoptionPort,
  ForkHalt,
  GroupSafetyEvent,
  RecoveryUnavailableEvent,
  SafetyHold,
} from '@kumiai/rpc'

export {
  type ControlHandleAccess,
  type ControlRead,
  type ControlReadScope,
  type HandleAccess,
  type SimpleHandleAccessParams,
  simpleHandleAccess,
} from './access.js'
export { type ApplyCommitParams, type ApplyCommitResult, applyCommit } from './apply-commit.js'
export { createControlAdoptionPort } from './control-adoption.js'
export {
  createControlBuildPort,
  createPersistenceBuildSaver,
  type SaveControlBuild,
} from './control-build.js'
export {
  type ControlJournal,
  decodeControlJournal,
  encodeControlJournal,
} from './control-journal.js'
export { createControlValidationPort } from './control-validation.js'
export {
  createGroupCrypto,
  deriveEntryKey,
  ENTRY_SEAL_LABEL,
  type GroupCryptoParams,
  openEntries,
  sealEntries,
} from './crypto.js'
export {
  createGroupMLS,
  createLedgerEntrySlot,
  deriveRecoverySecret,
  type GroupMLSDependencies,
  type GroupMLSParams,
  type LedgerEntrySlot,
  RECOVERY_LABEL,
  type RecoveryAdoptionDependencies,
  type RecoveryRouting,
} from './mls.js'
export type {
  EntryKind,
  EntryPhase,
  OwnerEntry,
  OwnerQueues,
  OwnerScopes,
  ProofOutcome,
  WriteTarget,
} from './owner-queue.js'
export {
  DisplacedGroupHandleError,
  ForkReportRefusedError,
  GroupControlUnsettledError,
  GroupStateConflictError,
  GroupStateUncertainError,
  GroupUnavailableError,
  type GroupUnavailableReason,
  InvalidAppEntryError,
  ManualRecoveryUnavailableError,
  NonRootProviderError,
  OutboxReplacementError,
  PersistencePhaseError,
  ReentrantOwnershipError,
  RegistrySourceMovedError,
  StorageOutcomeUnknownError,
} from './persistence-errors.js'
export type {
  AppAttempt,
  AppFrameRef,
  AppOutbox,
  AppOutboxEntry,
  AppPoisonRecord,
  AppPublicationOutcome,
  AppSettlementExpected,
  AppSettlementObligation,
  AppSettlementResult,
  AppStatusEvent,
  AtRestCodec,
  DevicePackageAdapters,
  DevicePersistence,
  DeviceRecord,
  DeviceStores,
  EpochIdentity,
  GroupBatchOptions,
  GroupForkEvidence,
  GroupKey,
  GroupLifetime,
  GroupPersistence,
  GroupPersistencePorts,
  GroupRecoveryTrust,
  GroupStateRecord,
  GroupStores,
  GroupTransaction,
  GroupTransition,
  HubCleanupRow,
  IncarnationStores,
  MemoryDatabase,
  MemoryStoreRows,
  MemoryTransaction,
  OutcomeAwareTransactionOptions,
  OwnershipContextPort,
  PackageUse,
  PendingAppFrame,
  PendingCommitFault,
  PersistenceEvent,
  PersistenceFixture,
  PreOpenAppFrameRef,
  RawStoredRecord,
  RestoreWork,
  TransactionalGroupEffects,
  TransactionHookSettlement,
} from './persistence-types.js'
export {
  type AuthenticateRecoveryReplyParams,
  authenticateRecoveryReply,
  buildRecoveryCandidate,
  type CapturedRecoveryEnvironment,
  createRecoveryRequestFromTrust,
  deriveRecoverySecretFromTrust,
  openRecoveryVerdictFromTrust,
  restoreRecoveryCandidate,
} from './recovery.js'
export { createRecoveryContinuationPort } from './registry/continuation.js'
export { createGroupHandleRegistry } from './registry/registry.js'
export {
  ackRetiredOutcome,
  listRetiredOutcomes,
  serveRetiredObligations,
} from './registry/retired.js'
export { createRecoverySwitchFactory, toRegistrySwitchWrite } from './registry/switch-write.js'
export type {
  GroupEpochRuntime,
  GroupHandleRegistry,
  GroupHandleRegistryParams,
  GroupRuntimeSnapshot,
  LegacyRegistryRecoverySource,
  LegacyResyncProof,
  RegistryHandleAccess,
  RegistryRecoverySource,
  RegistrySwitchWrite,
  ResyncProof,
} from './registry/types.js'
export type { RecoveryEnvironment } from './registry/validation.js'
export { createRegistryGroupMLS, type RegistryGroupMLSParams } from './registry-group-mls.js'
export { createRegistryHandleAccess } from './registry-handle-access.js'
export {
  createRegistryPeer,
  type RegistryPeer,
  type RegistryPeerOptions,
  type RegistryPeerParams,
} from './registry-peer.js'
export {
  buildRevokeProofOnHandle,
  buildRevokeProofOperation,
  type PublishRevokeProofParams,
  type PublishRevokeResult,
  publishRevokeProof,
  type RevokeJournalOptions,
} from './revoke.js'
export {
  createGroupSafety,
  type GroupSafety,
  type ManualRecovery,
  type RecoveryTarget,
} from './safety.js'
