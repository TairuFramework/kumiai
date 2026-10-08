import type { Outcome } from './control/types.js'

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

export class SendNotAdmissibleError extends Error {
  override name = 'SendNotAdmissibleError'
  #reason: 'lapsed'

  constructor(reason: 'lapsed') {
    super(`Send is not admissible: ${reason}`)
    this.#reason = reason
  }

  get reason(): 'lapsed' {
    return this.#reason
  }
}
