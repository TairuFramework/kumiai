import type { SafetyHold } from './control/safety.js'
import type { GroupKey, Outcome } from './control/types.js'
import type { SendAdmission } from './crypto.js'

export type GroupConditionErrorParams = { key?: GroupKey; cause?: unknown }

/** `key` is absent only where the throw site has no group binding (the trust-envelope codec). */
export class SpentSetCorruptError extends Error {
  override name = 'SpentSetCorruptError'
  #key: GroupKey | undefined

  constructor(params: GroupConditionErrorParams = {}) {
    super('Surviving spent set is missing or malformed', { cause: params.cause })
    this.#key = params.key === undefined ? undefined : { ...params.key }
  }

  get key(): GroupKey | undefined {
    return this.#key === undefined ? undefined : { ...this.#key }
  }
}

/**
 * A peer that has been disposed refused an operation. A caller branches on this: retry against a
 * fresh peer, versus surface to the user. Lifecycle conditions a caller acts on get a named class;
 * programmer errors (`Unknown protocol`, no-MLS-port) stay bare `Error`.
 */
export class PeerDisposedError extends Error {
  override name = 'PeerDisposedError'
}

export class PeerRemovedError extends Error {
  override name = 'PeerRemovedError'
}

export class StorageOutcomeUnknownError extends Error {
  override name = 'StorageOutcomeUnknownError'
}

export class ControlWriteNotCommittedError extends Error {
  override name = 'ControlWriteNotCommittedError'
}

export class ControlSafetyImmutableError extends Error {
  override name = 'ControlSafetyImmutableError'
  #field: 'forkHalt' | 'recoveryUnavailable'

  constructor(field: 'forkHalt' | 'recoveryUnavailable') {
    super(`Control safety field is immutable: ${field}`)
    this.#field = field
  }

  get field(): 'forkHalt' | 'recoveryUnavailable' {
    return this.#field
  }
}

export class GroupSafetyHeldError extends Error {
  override name = 'GroupSafetyHeldError'
  #reason: NonNullable<SafetyHold>

  constructor(reason: NonNullable<SafetyHold>) {
    super(`Group safety held: ${reason}`)
    this.#reason = reason
  }

  get reason(): NonNullable<SafetyHold> {
    return this.#reason
  }
}

export class GroupControlUnsettledError extends Error {
  override name = 'GroupControlUnsettledError'
}

export class OperationRejectedError extends Error {
  override name = 'OperationRejectedError'
}

export type OperationOutcomeErrorParams = { outcome: Outcome }

export class OperationOutcomeError extends Error {
  override name = 'OperationOutcomeError'
  #outcome: Outcome

  constructor(params: OperationOutcomeErrorParams) {
    super(`Operation settled with outcome: ${params.outcome.kind}`)
    this.#outcome = params.outcome
  }

  get outcome(): Outcome {
    return this.#outcome
  }
}

export class AppOutboxFullError extends Error {
  override name = 'AppOutboxFullError'
}

export class AppEntryTooLargeError extends Error {
  override name = 'AppEntryTooLargeError'
}

type SendNotAdmissibleReason = Extract<SendAdmission, { admissible: false }>['reason']

export class SendNotAdmissibleError extends Error {
  override name = 'SendNotAdmissibleError'
  #reason: SendNotAdmissibleReason

  constructor(reason: SendNotAdmissibleReason) {
    super(`Send is not admissible: ${reason}`)
    this.#reason = reason
  }

  get reason(): SendNotAdmissibleReason {
    return this.#reason
  }
}

export class RecoveryTargetBehindError extends Error {
  override name = 'RecoveryTargetBehindError'
}
