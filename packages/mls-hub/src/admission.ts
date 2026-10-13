export type WelcomeAdmissionParams = {
  held: {
    incarnation: number
    epoch: number | null
    deleted: boolean
    forkHalted: boolean
  } | null
  spentEpochAuthenticators: Array<Uint8Array>
  welcome: { epoch: number; epochAuthenticator: Uint8Array }
}

function validEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validAuthenticator(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.length > 0
}

/** Judge verified Welcome identity against held metadata and retained spent identities. */
export function judgeWelcomeAdmission(
  params: WelcomeAdmissionParams,
): 'join' | 'alreadyJoined' | 'replace' | 'refused' {
  if (params == null || typeof params !== 'object') {
    throw new TypeError('Invalid Welcome admission parameters')
  }
  const { held, spentEpochAuthenticators, welcome } = params
  if (!Array.isArray(spentEpochAuthenticators)) {
    throw new TypeError('Invalid spent epoch authenticators')
  }
  for (const authenticator of spentEpochAuthenticators) {
    if (!validAuthenticator(authenticator)) {
      throw new TypeError('Invalid spent epoch authenticator')
    }
  }
  if (
    welcome == null ||
    !validEpoch(welcome.epoch) ||
    !validAuthenticator(welcome.epochAuthenticator)
  ) {
    throw new TypeError('Invalid Welcome identity')
  }
  if (
    held !== null &&
    (held == null ||
      typeof held !== 'object' ||
      !Number.isSafeInteger(held.incarnation) ||
      held.incarnation < 1 ||
      (held.epoch !== null && !validEpoch(held.epoch)) ||
      typeof held.deleted !== 'boolean' ||
      typeof held.forkHalted !== 'boolean')
  ) {
    throw new TypeError('Invalid held Welcome metadata')
  }

  // Replays refuse even when the held epoch would otherwise report alreadyJoined.
  if (
    spentEpochAuthenticators.some(
      (spent) =>
        spent.length === welcome.epochAuthenticator.length &&
        spent.every((byte, index) => byte === welcome.epochAuthenticator[index]),
    )
  ) {
    return 'refused'
  }
  if (held?.forkHalted) return 'refused'
  if (held === null || held.deleted) return 'join'
  if (held.epoch === null) return 'refused'
  return welcome.epoch > held.epoch ? 'replace' : 'alreadyJoined'
}
