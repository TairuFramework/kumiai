import {
  type ControlSnapshot,
  type ForkHalt,
  recoveryUnavailableEventID,
  type SafetyHold,
} from '@kumiai/rpc'

import type { EntryCapability, EntryReads } from '../entry-capability.js'
import { isStoredOpenFailure } from '../persistence-codec.js'
import { GroupStateConflictError, GroupUnavailableError } from '../persistence-errors.js'
import type { GroupKey, GroupRecoveryTrust, GroupTransaction } from '../persistence-types.js'
import type { RegistryConsumers } from './consumers.js'
import { assertRecoverySourceTrust } from './source-trust.js'
import type { GroupHandleRegistry } from './types.js'

export type RegistrySafetyCapability<TTx extends GroupTransaction> = RegistryConsumers & {
  binding: object
  entry: EntryCapability<TTx>
  latch(key: GroupKey, reason: NonNullable<SafetyHold>): void
  reportHold(key: GroupKey, halt: ForkHalt): void
  prepareReportedHoldRelease(key: GroupKey, halt: ForkHalt): () => void
  observeHold(key: GroupKey, control: ControlSnapshot): void
  held(key: GroupKey): SafetyHold
  persistTrustUnavailable(key: GroupKey): Promise<void>
}

const capabilities = new WeakMap<GroupHandleRegistry, unknown>()

export function bindRegistrySafety<TTx extends GroupTransaction>(
  registry: GroupHandleRegistry,
  capability: RegistrySafetyCapability<TTx>,
): void {
  capabilities.set(registry, capability)
}

export function registrySafety<TTx extends GroupTransaction>(
  registry: GroupHandleRegistry,
): RegistrySafetyCapability<TTx> | null {
  return (capabilities.get(registry) as RegistrySafetyCapability<TTx> | undefined) ?? null
}

export class RetainedTrustUnavailableError extends GroupUnavailableError {
  #key: GroupKey

  constructor(params: { key: GroupKey; cause: unknown }) {
    super({ reason: 'recovery-unavailable', cause: params.cause })
    this.#key = { ...params.key }
  }

  get key(): GroupKey {
    return { ...this.#key }
  }
}

export async function readRetainedTrust(
  reads: Pick<EntryReads, 'trust'>,
  key: GroupKey,
): Promise<GroupRecoveryTrust> {
  let trust: GroupRecoveryTrust | null
  try {
    trust = await reads.trust()
  } catch (cause) {
    if (!isStoredOpenFailure(cause) && !(cause instanceof GroupStateConflictError)) throw cause
    // biome-ignore lint/style/useErrorCause: The diagnosis retains cause.
    throw new RetainedTrustUnavailableError({ key, cause })
  }
  if (trust === null)
    throw new RetainedTrustUnavailableError({
      key,
      cause: new GroupStateConflictError('Missing retained trust'),
    })
  // A readable identity for another owner is invalid, never evidence of trust loss.
  if (
    trust.groupID !== key.groupID ||
    (trust.installed != null &&
      (trust.installed.groupID !== key.groupID || trust.installed.incarnation !== key.incarnation))
  )
    throw new GroupUnavailableError({ reason: 'invalid' })
  try {
    assertRecoverySourceTrust(trust)
    if (trust.spentEpochAuthenticators.length === 0)
      throw new GroupStateConflictError('Empty surviving spent trust')
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: The diagnosis retains cause.
    throw new RetainedTrustUnavailableError({ key, cause })
  }
  return trust
}

class SafetyNoop extends Error {}

export function trustUnavailableWriter<TTx extends GroupTransaction>(params: {
  entry: EntryCapability<TTx>
  observeHold(key: GroupKey, control: ControlSnapshot): void
  latch(key: GroupKey, reason: NonNullable<SafetyHold>): void
}): (key: GroupKey) => Promise<void> {
  return async (requested) => {
    const key = { ...requested }
    const mutationID = crypto.randomUUID()
    const event = {
      ...key,
      id: recoveryUnavailableEventID(key),
      kind: 'group:recovery-unavailable' as const,
      reason: 'trust-unreadable' as const,
    }
    try {
      await params.entry.run(
        { groupID: key.groupID, mutationID },
        async (reads) => {
          const lifetime = await reads.lifetime()
          if (lifetime?.groupID !== key.groupID || lifetime.activeIncarnation !== key.incarnation)
            throw new SafetyNoop()
          let control: ControlSnapshot
          try {
            control = await reads.control(key.incarnation)
          } catch (cause) {
            if (!isStoredOpenFailure(cause) && !(cause instanceof GroupStateConflictError))
              throw cause
            // biome-ignore lint/style/useErrorCause: The constructor forwards cause.
            throw new GroupUnavailableError({ reason: 'invalid', cause })
          }
          params.observeHold(key, control)
          params.latch(key, 'recovery-unavailable')
          if (control.recoveryUnavailable !== null) throw new SafetyNoop()
          return { expected: lifetime, value: null }
        },
        async (stores) => {
          const lifetime = await stores.lifetime.load()
          if (lifetime?.groupID !== key.groupID || lifetime.activeIncarnation !== key.incarnation)
            throw new SafetyNoop()
          const target = stores.incarnation(key.incarnation)
          let control: ControlSnapshot
          try {
            control = await target.control.load()
          } catch (cause) {
            if (!isStoredOpenFailure(cause) && !(cause instanceof GroupStateConflictError))
              throw cause
            // biome-ignore lint/style/useErrorCause: The constructor forwards cause.
            throw new GroupUnavailableError({ reason: 'invalid', cause })
          }
          if (control.recoveryUnavailable !== null) throw new SafetyNoop()
          await target.control.apply({ recoveryUnavailable: event }, mutationID)
        },
      )
    } catch (error) {
      if (!(error instanceof SafetyNoop)) throw error
    }
  }
}
