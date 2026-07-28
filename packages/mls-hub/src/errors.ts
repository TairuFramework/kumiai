import { ErrorCodes } from '@enkaku/protocol'
import { HUB_ERROR_CODES, type HubErrorCode, hubErrorCodeOf } from '@kumiai/hub-protocol'

/** Which hub call failed. `'status'`: nothing was attempted. `'upload'`: attempted, outcome unknown. */
export type HubCallStage = 'status' | 'upload'

/**
 * The hub could not be made to answer, or answered something that clears on its own. Retrying later
 * can succeed and nothing needs changing, so this is returned rather than thrown — an unhandled
 * throw would take down a host that could otherwise carry on entirely offline.
 */
export class HubRetryableError extends Error {
  override name = 'HubRetryableError'
  #code: string | null
  #stage: HubCallStage

  constructor(stage: HubCallStage, code: string | null, cause: unknown) {
    super(
      `mls-hub: the hub could not complete the ${stage} request${code == null ? '' : ` (${code})`}; retry later`,
      { cause },
    )
    this.#code = code
    this.#stage = stage
  }

  /** The code the error carried, if any — not proof it's a hub wire code; see `codeOf`. */
  get code(): string | null {
    return this.#code
  }

  get stage(): HubCallStage {
    return this.#stage
  }
}

/**
 * The hub has answered settled: the app or its operator must change something before this call can
 * ever succeed. Thrown, so a host that writes no handler still gets told.
 */
export class HubRefusedError extends Error {
  override name = 'HubRefusedError'
  #code: string
  #stage: HubCallStage

  constructor(stage: HubCallStage, code: string, cause: unknown) {
    super(`mls-hub: the hub refused the ${stage} request (${code})`, { cause })
    this.#code = code
    this.#stage = stage
  }

  get code(): string {
    return this.#code
  }

  get stage(): HubCallStage {
    return this.#stage
  }
}

/** Codes that will never succeed on a retry: credentials, or a request this hub will always reject. */
const REFUSED_CODES: ReadonlySet<string> = new Set<string>([
  HUB_ERROR_CODES.authorizationDenied,
  HUB_ERROR_CODES.invalidPayload,
  ErrorCodes.ACCESS_DENIED,
  ErrorCodes.MESSAGE_TOO_LARGE,
  // Reachable, not theoretical: the upload schema caps `keyPackages` at 50 and nothing validates
  // `target` against it, so a misconfigured pool would re-mint a doomed batch on every call.
  ErrorCodes.INVALID_MESSAGE,
])

/** Hub error class names, for an error that crossed a boundary and lost its class. */
const CODE_BY_NAME: Readonly<Record<string, HubErrorCode>> = {
  AuthorizationDeniedError: HUB_ERROR_CODES.authorizationDenied,
  HeadMismatchError: HUB_ERROR_CODES.headMismatch,
  InvalidPayloadError: HUB_ERROR_CODES.invalidPayload,
  KeyPackageFetchLimitError: HUB_ERROR_CODES.keyPackageFetchLimit,
  KeyPackageQuotaExceededError: HUB_ERROR_CODES.keyPackageQuota,
  NotSubscribedError: HUB_ERROR_CODES.notSubscribed,
  RetentionExceededError: HUB_ERROR_CODES.retentionExceeded,
  SubscriptionQuotaExceededError: HUB_ERROR_CODES.subscriptionQuota,
}

/**
 * The wire code an error carries, or null if it never reached the hub.
 *
 * `code` comes FIRST because it is the only path that works in production: `hub-client` is a
 * pass-through wrapper, so a hub answer arrives as an enkaku `RequestError` whose `code` is the wire
 * code and which is not an instance of any hub-protocol class. The class and name checks cover a
 * store error thrown in-process and an error rebuilt across a bundle boundary.
 */
function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const byClass = hubErrorCodeOf(error)
  if (byClass != null) return byClass
  return error instanceof Error ? (CODE_BY_NAME[error.name] ?? null) : null
}

/**
 * Classify a failed hub call: return it for the caller to retry, or throw because retrying is
 * pointless. Unrecognised is retryable — the cost of retrying a real refusal is a bounded schedule,
 * while the cost of not retrying a real outage is provisioning that never recovers.
 */
export function toRetryableOrThrow(error: unknown, stage: HubCallStage): HubRetryableError {
  const code = codeOf(error)
  if (code != null && REFUSED_CODES.has(code)) {
    throw new HubRefusedError(stage, code, error)
  }
  return new HubRetryableError(stage, code, error)
}
