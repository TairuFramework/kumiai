import { type AdoptionExpected, PeerRemovedError } from '@kumiai/rpc'

import type { EntryReads, StateMetadata } from '../entry-capability.js'
import { copyStoredValue } from '../memory-incarnation-stores.js'
import type { OwnerAttempt } from '../owner-queue.js'
import { isStoredOpenFailure } from '../persistence-codec.js'
import {
  DisplacedGroupHandleError,
  GroupStateConflictError,
  GroupUnavailableError,
} from '../persistence-errors.js'
import type { GroupKey, GroupLifetime } from '../persistence-types.js'
import { readRetainedTrust } from './safety.js'
import type { SourceCommands } from './source-executor-types.js'

export class SourceProjectionUnavailableError extends GroupUnavailableError {
  constructor() {
    super({ reason: 'invalid' })
  }
}

export type SourceAdmission = {
  lifetime: GroupLifetime
  metadata: StateMetadata
  source: AdoptionExpected
}

function assertSourceLifetime(key: GroupKey, lifetime: GroupLifetime): void {
  if (lifetime.groupID !== key.groupID || lifetime.activeIncarnation !== key.incarnation)
    throw new DisplacedGroupHandleError('Source incarnation is displaced')
  if (lifetime.restorePending) throw new GroupUnavailableError({ reason: 'restore-pending' })
}

export function assertSourceAdmission(
  key: GroupKey,
  admission: Pick<SourceAdmission, 'lifetime' | 'metadata'>,
): void {
  const { lifetime, metadata } = admission
  assertSourceLifetime(key, lifetime)
  if (
    metadata.groupID !== key.groupID ||
    metadata.incarnation !== key.incarnation ||
    metadata.deleted ||
    !Number.isSafeInteger(metadata.version) ||
    metadata.version < 1
  )
    throw new GroupUnavailableError({ reason: 'invalid' })
  if (metadata.terminal) throw new PeerRemovedError()
}

export async function readSourceMetadata(
  reads: EntryReads,
  key: GroupKey,
): Promise<Pick<SourceAdmission, 'lifetime' | 'metadata'>> {
  let lifetime: GroupLifetime | null
  let metadata: StateMetadata | null
  try {
    lifetime = await reads.lifetime()
    if (lifetime === null) throw new GroupUnavailableError({ reason: 'absent' })
    assertSourceLifetime(key, lifetime)
    metadata = await reads.metadata(key.incarnation)
    if (metadata === null) throw new GroupUnavailableError({ reason: 'invalid' })
    assertSourceAdmission(key, { lifetime, metadata })
  } catch (cause) {
    if (
      cause instanceof DisplacedGroupHandleError ||
      cause instanceof PeerRemovedError ||
      cause instanceof GroupUnavailableError
    )
      throw cause
    if (!isStoredOpenFailure(cause) && !(cause instanceof GroupStateConflictError)) throw cause
    // biome-ignore lint/style/useErrorCause: The constructor forwards params.cause to Error.
    throw new GroupUnavailableError({ reason: 'invalid', cause })
  }
  return { lifetime, metadata }
}

export async function readSourceAdmission(
  reads: EntryReads,
  key: GroupKey,
): Promise<SourceAdmission> {
  const { lifetime, metadata } = await readSourceMetadata(reads, key)
  const trust = await readRetainedTrust(reads, key)
  return copyStoredValue({
    lifetime,
    metadata,
    source: { key, stateVersion: metadata.version, identity: trust.installed },
  })
}

// The dispatcher owns purpose and output shape. No host callback or private state crosses it.
export function runSourceCommand<TName extends keyof SourceCommands>(
  request: {
    command: TName
    input: SourceCommands[TName]['input']
  },
  admission: SourceAdmission,
  attempt: OwnerAttempt,
): SourceCommands[TName]['output'] {
  attempt.assertLive()
  if (request.command !== 'source.inspect' || request.input !== undefined)
    throw new TypeError('Unknown source command or invalid input')
  return copyStoredValue(admission.source)
}
