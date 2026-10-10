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

export class OutboxReplacementError extends Error {
  override name = 'OutboxReplacementError'
}

export class InvalidAppEntryError extends Error {
  override name = 'InvalidAppEntryError'
}

export class NonRootProviderError extends Error {
  override name = 'NonRootProviderError'
}
