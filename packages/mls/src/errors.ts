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
