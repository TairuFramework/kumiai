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

export { type HandleAccess, type SimpleHandleAccessParams, simpleHandleAccess } from './access.js'
export { type ApplyCommitContext, type ApplyCommitResult, applyCommit } from './apply-commit.js'
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
  createRecoveryPending,
  deriveRecoverySecret,
  type GroupMLSParams,
  type LedgerEntrySlot,
  RECOVERY_LABEL,
  type RecoveryPending,
} from './mls.js'
