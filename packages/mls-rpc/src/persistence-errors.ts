import type { GroupKey } from './persistence-types.js'

export { GroupControlUnsettledError, StorageOutcomeUnknownError } from '@kumiai/rpc'

export class GroupStateConflictError extends Error {
  override name = 'GroupStateConflictError'
}

export class RegistrySourceMovedError extends GroupStateConflictError {
  override name = 'RegistrySourceMovedError'
}

export class GroupStateUncertainError extends Error {
  override name = 'GroupStateUncertainError'
}

export class DisplacedGroupHandleError extends Error {
  override name = 'DisplacedGroupHandleError'
}

export class RegistryRetiringError extends Error {
  override name = 'RegistryRetiringError'
  #key: GroupKey

  constructor(params: { key: GroupKey }) {
    super(`Registry key is retiring: ${params.key.groupID}/${params.key.incarnation}`)
    this.#key = { ...params.key }
  }

  get key(): GroupKey {
    return { ...this.#key }
  }
}

export class RegistryRetireHookError extends Error {
  override name = 'RegistryRetireHookError'
}

export class OutboxReplacementError extends Error {
  override name = 'OutboxReplacementError'
}

export class InvalidAppEntryError extends Error {
  override name = 'InvalidAppEntryError'
}

export class NonRootProviderError extends Error {
  override name = 'NonRootProviderError'
}

export class PersistencePhaseError extends Error {
  override name = 'PersistencePhaseError'
}

export class ReentrantOwnershipError extends Error {
  override name = 'ReentrantOwnershipError'
}

export type GroupUnavailableReason =
  | 'absent'
  | 'deleted'
  | 'state-unreadable'
  | 'recovery-unavailable'
  | 'invalid'
  | 'restore-pending'

export class GroupUnavailableError extends Error {
  override name = 'GroupUnavailableError'
  #reason: GroupUnavailableReason

  constructor(params: { reason: GroupUnavailableReason; cause?: unknown }) {
    super(`Group unavailable: ${params.reason}`, { cause: params.cause })
    this.#reason = params.reason
  }

  get reason(): GroupUnavailableReason {
    return this.#reason
  }
}

export type RegistryResyncRefusalReason =
  | 'fork-halted'
  | 'recovery-unavailable'
  | 'malformed'
  | 'unaccepted'
  | 'source'
  | 'candidate'
  | 'tuple'
  | 'ineligible'

export class RegistryResyncRefusedError extends Error {
  override name = 'RegistryResyncRefusedError'
  #reason: RegistryResyncRefusalReason

  constructor(params: { reason: RegistryResyncRefusalReason; cause?: unknown }) {
    super(`Registry resync refused: ${params.reason}`, { cause: params.cause })
    this.#reason = params.reason
  }

  get reason(): RegistryResyncRefusalReason {
    return this.#reason
  }
}

export type SeedAdmissionRefusalReason =
  | 'spent'
  | 'fork-halted'
  | 'replace-required'
  | 'invalid-active-metadata'
  | 'unavailable'
  | 'invalid-genesis'
  | 'invalid-package-use'

export class SeedAdmissionRefusedError extends Error {
  override name = 'SeedAdmissionRefusedError'
  #reason: SeedAdmissionRefusalReason

  constructor(params: { reason: SeedAdmissionRefusalReason; cause?: unknown }) {
    super(`Seed admission refused: ${params.reason}`, { cause: params.cause })
    this.#reason = params.reason
  }

  get reason(): SeedAdmissionRefusalReason {
    return this.#reason
  }
}

export class RegistryRecoveryReplacementError extends Error {
  override name = 'RegistryRecoveryReplacementError'
}

export class ForkReportRefusedError extends Error {
  override name = 'ForkReportRefusedError'
  #reason: 'key' | 'epoch' | 'authenticator'

  constructor(params: { reason: 'key' | 'epoch' | 'authenticator' }) {
    super(`Fork report refused: ${params.reason}`)
    this.#reason = params.reason
  }

  get reason(): 'key' | 'epoch' | 'authenticator' {
    return this.#reason
  }
}

export class ManualRecoveryUnavailableError extends Error {
  override name = 'ManualRecoveryUnavailableError'
}
