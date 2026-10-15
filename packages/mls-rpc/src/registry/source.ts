import type { AdoptionExpected } from '@kumiai/rpc'

import type { EntryReads, StateMetadata } from '../entry-capability.js'
import { decodeStoredValue, encodeStoredValue, isStoredOpenFailure } from '../persistence-codec.js'
import { GroupStateConflictError, GroupUnavailableError } from '../persistence-errors.js'
import type { GroupLifetime, GroupRecoveryTrust } from '../persistence-types.js'
import { recoveryTrustDigest } from '../recovery-trust-digest.js'
import { readRetainedTrust } from './safety.js'
import type { RegistryRecoverySource } from './types.js'

export function recoverySourceIdentity(source: RegistryRecoverySource): AdoptionExpected {
  return {
    key: { ...source.key },
    stateVersion: source.stateVersion,
    identity:
      source.identity === null
        ? null
        : {
            ...source.identity,
            authenticator: source.identity.authenticator.slice(),
          },
  }
}

function refuseUnreadable(cause: unknown): never {
  if (!isStoredOpenFailure(cause) && !(cause instanceof GroupStateConflictError)) throw cause
  throw new GroupUnavailableError({ reason: 'invalid', cause })
}

export async function readRecoverySource(
  reads: EntryReads,
  groupID: string,
): Promise<RegistryRecoverySource> {
  let lifetime: GroupLifetime | null
  try {
    lifetime = await reads.lifetime()
  } catch (cause) {
    refuseUnreadable(cause)
  }
  if (lifetime === null) throw new GroupUnavailableError({ reason: 'absent' })
  if (lifetime.restorePending) throw new GroupUnavailableError({ reason: 'restore-pending' })
  if (lifetime.activeIncarnation === null) throw new GroupUnavailableError({ reason: 'deleted' })
  const key = { groupID, incarnation: lifetime.activeIncarnation }
  if (
    lifetime.groupID !== groupID ||
    !Number.isSafeInteger(key.incarnation) ||
    key.incarnation < 1 ||
    !Number.isSafeInteger(lifetime.latestIncarnation) ||
    key.incarnation > lifetime.latestIncarnation ||
    !Number.isSafeInteger(lifetime.revision) ||
    lifetime.revision < 1
  )
    throw new GroupUnavailableError({ reason: 'invalid' })

  let metadata: StateMetadata | null
  const trust = await readRetainedTrust(reads, key)
  try {
    metadata = await reads.metadata(key.incarnation)
  } catch (cause) {
    refuseUnreadable(cause)
  }
  try {
    if (
      metadata === null ||
      metadata.groupID !== groupID ||
      metadata.incarnation !== key.incarnation ||
      metadata.deleted !== false ||
      !Number.isSafeInteger(metadata.version) ||
      metadata.version < 1
    )
      throw new GroupStateConflictError('Recovery source metadata or trust unavailable')
    // Clone both projections separately: callers can mutate identity without changing retained trust.
    return {
      key,
      stateVersion: metadata.version,
      identity: { ...trust.installed, authenticator: trust.installed.authenticator.slice() },
      trust: decodeStoredValue(encodeStoredValue(trust)) as GroupRecoveryTrust,
      lifetimeRevision: lifetime.revision,
      trustDigest: recoveryTrustDigest(trust),
    }
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: The constructor forwards params.cause to Error.
    throw new GroupUnavailableError({ reason: 'invalid', cause })
  }
}
