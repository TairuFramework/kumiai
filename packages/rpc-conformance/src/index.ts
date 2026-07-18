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
  type ConformanceGroupMLS,
  type ConformanceMLSGroup,
  type ConformanceMLSMember,
  type GroupMLSConformanceParams,
  testGroupMLSConformance,
} from './group-mls.js'
