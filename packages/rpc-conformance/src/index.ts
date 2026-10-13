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
  type CommitOnceEvidence,
  type CommitOnceScenario,
  peerCommitOnceScenarios,
  testCommitOnceConformance,
} from './commit-once.js'
export {
  type ConformanceAdoptionExpected,
  type ConformanceAdoptionWrite,
  type ConformanceAppliedCommit,
  type ConformanceBuiltCommit,
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
  type ConformanceForkEvidence,
  type ConformanceForkHalt,
  type ConformanceGroupForkEvidence,
  type ConformanceGroupKey,
  type ConformanceGroupSafetyEvent,
  type ConformanceHostBuilt,
  type ConformanceOperation,
  type ConformanceOperationRequest,
  type ConformanceOutcome,
  type ConformanceRecoveryRefusal,
  type ConformanceRecoveryUnavailableEvent,
  type ConformanceRejoinRecord,
  type ConformanceSafetyHold,
  type ConformanceWelcomeObligation,
  type ControlStoreConformanceParams,
  testControlSafetyInputConformance,
  testControlStoreConformance,
} from './control-store.js'
export { testDeviceStorageConformance } from './device-storage.js'
export {
  type ConformanceCryptoGroup,
  type ConformanceCryptoMember,
  type ConformanceGroupCrypto,
  type ConformanceUnwrapResult,
  type GroupCryptoConformanceParams,
  testGroupCryptoConformance,
} from './group-crypto.js'
export {
  type ConformanceCommit,
  type ConformanceCommitContext,
  type ConformanceCommitHeader,
  type ConformanceControlFrameValidation,
  type ConformanceControlValidation,
  type ConformanceControlValidationPort,
  type ConformanceGroupMLS,
  type ConformanceMLSGroup,
  type ConformanceMLSMember,
  type GroupMLSConformanceParams,
  testGroupMLSConformance,
} from './group-mls.js'
export {
  assertCorruptStorageRecovery,
  assertLowerEpochRefused,
  assertPartialLossSpentRefused,
  testGroupStorageConformance,
} from './group-storage.js'
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
