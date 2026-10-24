export type LeafBindingReason =
  | 'missing-holder-evidence'
  | 'holder-evidence-mismatch'
  | 'issuer-mismatch'
  | 'audience-mismatch'
  | 'permission-denied'
  | 'signature-invalid'
  | 'confirmation-invalid'
  | 'subject-mismatch'
  | 'chain-depth'
  | 'self-issued'
  | 'child-outlives-parent'
  | 'denied-issuer'
  | 'denied-id'
  | 'renewal-order'
  | 'lifetime-cap'
  | 'generation-floor'
  | 'identity-change'
  | 'controller-mismatch'
  | 'floating-refused'
  | 'history-horizon'
  | 'member-removed'
  | 'member-unavailable'
  | 'epoch-cap'

export class LeafBindingError extends Error {
  #reason: LeafBindingReason

  constructor(reason: LeafBindingReason) {
    super(`Invalid leaf binding: ${reason}`)
    this.name = 'LeafBindingError'
    this.#reason = reason
  }

  get reason(): LeafBindingReason {
    return this.#reason
  }
}

export type LeafLapsedReason = 'lapsed'

export class LeafLapsedError extends Error {
  #reason: LeafLapsedReason

  constructor(reason: LeafLapsedReason) {
    super(`Leaf lapsed: ${reason}`)
    this.name = 'LeafLapsedError'
    this.#reason = reason
  }

  get reason(): LeafLapsedReason {
    return this.#reason
  }
}

export type RevokeProofReason =
  | 'no-rev'
  | 'wrong-controller'
  | 'not-authority-signed'
  | 'not-endorsed'
  | 'generation-floor'
  | 'too-large'
  | 'detached'
  | 'needs-reset'
  | 'time-regression'
  | 'effects-mismatch'
  | 'removes-mismatch'

export class RevokeProofError extends Error {
  #reason: RevokeProofReason

  constructor(reason: RevokeProofReason) {
    super(`Invalid revoke proof: ${reason}`)
    this.name = 'RevokeProofError'
    this.#reason = reason
  }

  get reason(): RevokeProofReason {
    return this.#reason
  }
}

/** The sender must wait for an epoch advance before building another private commit. */
export class HandshakeWindowError extends Error {
  constructor() {
    super('Handshake sender generation reached the safe receiver window for this epoch')
    this.name = 'HandshakeWindowError'
  }
}

export class HandshakeWindowConfigError extends Error {
  constructor() {
    super('Handshake receiver window must be at least 2')
    this.name = 'HandshakeWindowConfigError'
  }
}

export class HandshakeReservationError extends Error {
  constructor() {
    super('No matching handshake reservation for the current epoch and generation')
    this.name = 'HandshakeReservationError'
  }
}

export class ClientStateReservationError extends Error {
  constructor() {
    super('Handshake reservation epoch must be a uint64 bigint and generation a uint32 integer')
    this.name = 'ClientStateReservationError'
  }
}
