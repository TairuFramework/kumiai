import { CodecError, CryptoVerificationError } from 'ts-mls'

export type DeviceRegistryCodecErrorParams = { message: string; cause?: unknown }

export class DeviceRegistryCodecError extends Error {
  constructor(params: DeviceRegistryCodecErrorParams) {
    super(params.message, { cause: params.cause })
    this.name = 'DeviceRegistryCodecError'
  }
}

export class CarryIdentityError extends Error {
  constructor() {
    super('Receive progress candidate does not retain the current epoch identity')
    this.name = 'CarryIdentityError'
  }
}

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

export class CommitValidationUnavailableError extends Error {
  #reason: CommitValidationUnavailableReason

  constructor(
    message?: string,
    options?: ErrorOptions & { reason?: CommitValidationUnavailableReason },
  ) {
    super(message, options)
    this.name = 'CommitValidationUnavailableError'
    this.#reason = options?.reason ?? 'unrecognised'
  }

  get reason(): CommitValidationUnavailableReason {
    return this.#reason
  }
}

export type CommitValidationUnavailableReason =
  | 'missing-proposal'
  | 'missing-key'
  | 'resolver'
  | 'unrecognised'

/** Verifiers/resolvers mark network or backend failures at their source, never policy refusals. */
export type TransientVerificationError = Error & { transient: true }

export function isTransientVerificationError(error: unknown): error is TransientVerificationError {
  return error instanceof Error && 'transient' in error && error.transient === true
}

// Pinned ts-mls rc.13 and kokuin/noble diagnostics. Unknown dependency failures stay unavailable.
const DEPENDENCY_REASONS: Record<
  string,
  CommitValidationUnavailableReason | 'authentication' | 'policy' | 'credential'
> = {
  'Could not validate credential': 'credential',
  'Could not find proposal with supplied reference': 'missing-proposal',
  'Desired gen in the past': 'missing-key',
  'Desired generation too far in the future': 'authentication',
  'aes-gcm: invalid tag': 'authentication',
  'invalid tag': 'authentication',
  'invalid ghash tag': 'authentication',
  'invalid poly1305 tag': 'authentication',
  'Invalid signature': 'authentication',
  'Invalid capability encoding': 'policy',
  'Invalid signed capability': 'policy',
  'Token expired': 'policy',
  'Unsupported signature algorithm': 'policy',
  'Could not validate epoch': 'policy',
  'Invalid proposals': 'policy',
  'Update path is required': 'policy',
  'Commit cannot contain an update proposal sent by committer': 'policy',
  'Commit cannot contain a remove proposal removing committer': 'policy',
  'Commit cannot contain multiple update and/or remove proposals that apply to the same leaf':
    'policy',
  'Commit cannot contain multiple Add proposals that contain KeyPackages that represent the same client':
    'policy',
  'Commit cannot contain an Add proposal for someone already in the group': 'policy',
  "Added leaf node that doesn't support extension in GroupContext": 'policy',
  'Commit cannot contain PreSharedKey proposals that reference the same PreSharedKeyID': 'policy',
  'Commit cannot contain multiple GroupContextExtensions proposals': 'policy',
  'Tried to remove empty leaf node': 'policy',
}

export function commitValidationReason(
  error: unknown,
): CommitValidationUnavailableReason | 'authentication' | 'policy' | 'credential' | undefined {
  if (!(error instanceof Error)) return undefined
  if (isTransientVerificationError(error)) return 'unrecognised'
  if (error instanceof CommitValidationUnavailableError) return error.reason
  return Object.hasOwn(DEPENDENCY_REASONS, error.message)
    ? DEPENDENCY_REASONS[error.message]
    : undefined
}

export function isConclusiveCommitError(error: unknown): boolean {
  const seen = new Set<unknown>()
  let cause: unknown = error
  while (cause instanceof Error && !seen.has(cause)) {
    if (isTransientVerificationError(cause)) return false
    seen.add(cause)
    cause = cause.cause
  }
  if (error instanceof LeafBindingError) return true
  const reason = commitValidationReason(error)
  return (
    error instanceof CodecError ||
    error instanceof CryptoVerificationError ||
    reason === 'authentication' ||
    reason === 'policy'
  )
}
