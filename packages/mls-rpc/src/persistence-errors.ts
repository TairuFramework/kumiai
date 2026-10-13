import type { GroupKey } from './persistence-types.js'

export { GroupControlUnsettledError, StorageOutcomeUnknownError } from '@kumiai/rpc'

export class GroupStateConflictError extends Error {
  override name = 'GroupStateConflictError'
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
