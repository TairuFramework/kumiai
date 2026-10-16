/**
 * Conformance suites for the two consumer ports of `@kumiai/rpc`: `GroupCrypto` and `GroupMLS`.
 *
 * ```ts
 * import { testGroupCryptoConformance, testGroupMLSConformance } from '@kumiai/rpc-conformance'
 * ```
 *
 * Both ports are supplied by the host, and both had exactly one implementation apiece for most of
 * their life — a test double. Six defects in one session had one root cause: **a double answered
 * where its real port refuses.** The worst two made the app lane fail to deliver a single message
 * over real MLS while 288 tests stayed green. Every clause in here is one of those, or something
 * found by running the two implementations against each other.
 *
 * The suites take a HARNESS rather than an implementation: a `GroupCrypto` alone cannot be asked
 * what happens at another epoch, because moving between epochs is `GroupMLS`'s job and, on a real
 * handle, a whole MLS commit. So each suite asks for a group it can rotate.
 *
 * @module rpc-conformance
 */

export {
  type AnchorStoreConformanceParams,
  type ConformanceAnchorSlot,
  type ConformanceAnchorStore,
  testAnchorStoreConformance,
} from './anchor-store.js'
export {
  type AppOutboxConformanceParams,
  type ConformanceAppOutbox,
  type ConformanceAppOutboxEntry,
  testAppOutboxConformance,
} from './app-outbox.js'
export {
  type CheckpointComparisonFixture,
  type CheckpointPortFixture,
  type CheckpointStorageConformanceParams,
  type ConformanceCheckpointComparison,
  type ConformanceCheckpointCoverage,
  type ConformanceCheckpointFactRecord,
  type ConformanceCheckpointPort,
  type ConformanceCheckpointRecord,
  type ConformanceCheckpointService,
  type ConformanceCheckpointStore,
  malformedCheckpointBodies,
  testCheckpointCacheConformance,
  testCheckpointComparisonConformance,
  testCheckpointCoverageConformance,
  testCheckpointPortConformance,
  testCheckpointStorageConformance,
} from './checkpoint.js'
export {
  type CommitOnceEvidence,
  type CommitOnceScenario,
  peerCommitOnceScenarios,
  testCommitOnceConformance,
} from './commit-once.js'
export { type ControlSafetyFixture, runControlSafetyContract } from './control-safety.js'
export {
  type ConformanceAcceptedRejoinSettlement,
  type ConformanceAdoptionExpected,
  type ConformanceAdoptionWrite,
  type ConformanceAppliedCommit,
  type ConformanceBuiltCommit,
  type ConformanceCapturedRejoinRecord,
  type ConformanceCommitSearchResult,
  type ConformanceControlAdoptionPort,
  type ConformanceControlBuildRef,
  type ConformanceControlChanges,
  type ConformanceControlCommitCursor,
  type ConformanceControlHold,
  type ConformanceControlHost,
  type ConformanceControlSearchPort,
  type ConformanceControlSlot,
  type ConformanceControlSnapshot,
  type ConformanceControlSource,
  type ConformanceControlStore,
  type ConformanceEpochIdentity,
  type ConformanceExternalResponse,
  type ConformanceFirstValidCommit,
  type ConformanceForkHalt,
  type ConformanceForkRecoveryAttempt,
  type ConformanceForkRecoveryAuthorisation,
  type ConformanceGroupCondition,
  type ConformanceGroupConditionEvent,
  type ConformanceGroupForkEvidence,
  type ConformanceGroupKey,
  type ConformanceGroupSafetyEvent,
  type ConformanceHostBuilt,
  type ConformanceLegacyRejoinRecord,
  type ConformanceNotMemberEvidence,
  type ConformanceOperation,
  type ConformanceOperationRequest,
  type ConformanceOutcome,
  type ConformanceRecoveryOrigin,
  type ConformanceRecoveryRefusal,
  type ConformanceRecoverySource,
  type ConformanceRecoveryTargetCapture,
  type ConformanceRecoveryUnavailableEvent,
  type ConformanceRejoinRecord,
  type ConformanceResyncProof,
  type ConformanceSafetyHold,
  type ConformanceStoredRejoinRecord,
  type ConformanceWelcomeObligation,
  type ControlStoreConformanceParams,
  decodeControlFixtureState,
  testControlSafetyInputConformance,
  testControlStoreConformance,
} from './control-store.js'
export { testDeviceStorageConformance } from './device-storage.js'
export {
  type ConformanceForkNotice,
  type ConformanceForkNoticeEvent,
  type ForkNoticeFixture,
  testForkNoticeConformance,
} from './fork-notice.js'
export {
  type ConformanceCryptoGroup,
  type ConformanceCryptoMember,
  type ConformanceGroupCrypto,
  type ConformanceUnwrapResult,
  type GroupCryptoConformanceParams,
  testGroupCryptoConformance,
} from './group-crypto.js'
export {
  type ConformanceAdoptionWriteFactory,
  type ConformanceAuthenticatedRosterAbsence,
  type ConformanceCapturedAppliedRecovery,
  type ConformanceCapturedPendingRecovery,
  type ConformanceCapturedRecapture,
  type ConformanceCapturedRecoveryPort,
  type ConformanceCommit,
  type ConformanceCommitContext,
  type ConformanceCommitHeader,
  type ConformanceConfirmedRecoveryHandoff,
  type ConformanceControlFrameValidation,
  type ConformanceControlValidation,
  type ConformanceControlValidationPort,
  type ConformanceGroupMLS,
  type ConformanceLegacyPendingRecovery,
  type ConformanceMLSGroup,
  type ConformanceMLSMember,
  type ConformanceRecoveryCompletion,
  type ConformanceRecoveryContinuation,
  type ConformanceRecoveryContinuationPort,
  type ConformanceRecoveryReconciliation,
  type ForkRecoveryFixture,
  type GroupMLSConformanceParams,
  testForkRecoveryConformance,
  testGroupMLSConformance,
} from './group-mls.js'
export {
  assertCorruptStorageRecovery,
  assertLowerEpochRefused,
  assertPartialLossSpentRefused,
  testGroupStorageConformance,
} from './group-storage.js'
export * from './manual-recovery.js'
export { createMemoryAppOutbox, type MemoryAppOutbox } from './memory-app-outbox.js'
export { createMemoryControlStore, type MemoryControlStore } from './memory-control-store.js'
export {
  type OwnershipPhasesConformanceParams,
  testOwnershipPhasesConformance,
} from './ownership-phases.js'
export {
  type ConformanceAppFrameRef,
  type ConformancePendingAppFrame,
  type PendingCrypto,
  type PendingCryptoConformanceParams,
  type PendingCryptoFixture,
  testPendingGroupCryptoConformance,
} from './pending-group-crypto.js'
export * from './persistence-fixture.js'
export { testRegistryConformance, testRegistryCrashConformance } from './registry.js'
export * from './registry-fixture.js'
export {
  type ConformanceGroupSafety,
  type ConformanceManualRecovery,
  type RosterAbsenceFixture,
  type RosterAbsenceScenario,
  runGroupSafetyContract,
  testRosterAbsenceConformance,
} from './safety.js'
