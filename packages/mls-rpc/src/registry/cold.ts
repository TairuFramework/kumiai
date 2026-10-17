import { normalizeDID } from '@kokuin/token'
import type { GroupHandle } from '@kumiai/mls'
import { restrictCommitAuthoring } from '@kumiai/mls'
import { type ControlSnapshot, controlSafetyHeld, type SendAdmission } from '@kumiai/rpc'

import type { EntryReads, StateMetadata } from '../entry-capability.js'
import { decodeStoredValue, encodeStoredValue, isStoredOpenFailure } from '../persistence-codec.js'
import {
  GroupStateConflictError,
  GroupUnavailableError,
  type GroupUnavailableReason,
} from '../persistence-errors.js'
import type {
  GroupKey,
  GroupLifetime,
  GroupRecoveryTrust,
  GroupStateRecord,
} from '../persistence-types.js'
import { readRetainedTrust } from './safety.js'
import type { GroupRuntimeSnapshot, ReadableGroupState } from './types.js'
import { type RecoveryEnvironment, validateRegistryHandle } from './validation.js'

export type ValidatedGroupState = {
  key: GroupKey
  record: ReadableGroupState
  trust: GroupRecoveryTrust
  snapshot: GroupRuntimeSnapshot
  ownMember: boolean
  lapsed: boolean
}
export type ColdEnvironment = {
  ownerDID: string
  recovery: RecoveryEnvironment
  restore(record: ReadableGroupState): Promise<GroupHandle>
}

export function copyRecord(record: ReadableGroupState): ReadableGroupState {
  return decodeStoredValue(encodeStoredValue(record)) as ReadableGroupState
}
function sameValue(left: unknown, right: unknown): boolean {
  const a = encodeStoredValue(left)
  const b = encodeStoredValue(right)
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}

function refuseStoredValue(cause: unknown, reason: GroupUnavailableReason): never {
  if (!isStoredOpenFailure(cause) && !(cause instanceof GroupStateConflictError)) throw cause
  throw new GroupUnavailableError({ reason, cause })
}

export async function restoreValidated(
  value: ValidatedGroupState,
  environment: ColdEnvironment,
): Promise<GroupHandle> {
  try {
    const handle = restrictCommitAuthoring(await environment.restore(copyRecord(value.record)))
    validateRegistryHandle({
      handle,
      key: { ...value.key },
      record: copyRecord(value.record),
      trust: decodeStoredValue(encodeStoredValue(value.trust)) as GroupRecoveryTrust,
      environment: environment.recovery,
      ownerDID: environment.ownerDID,
    })
    return handle
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: The constructor forwards params.cause to Error.
    throw new GroupUnavailableError({ reason: 'invalid', cause })
  }
}

export async function loadValidatedGroup(
  reads: EntryReads,
  groupID: string,
  cached: ValidatedGroupState | null,
  environment: ColdEnvironment,
  assertMutationSafety?: () => void,
): Promise<{ value: ValidatedGroupState; control: ControlSnapshot }> {
  let lifetime: GroupLifetime | null
  try {
    lifetime = await reads.lifetime()
  } catch (cause) {
    refuseStoredValue(cause, 'invalid')
  }
  if (lifetime === null) throw new GroupUnavailableError({ reason: 'absent' })
  if (lifetime.restorePending) throw new GroupUnavailableError({ reason: 'restore-pending' })
  if (lifetime.activeIncarnation === null) throw new GroupUnavailableError({ reason: 'deleted' })
  const key = { groupID, incarnation: lifetime.activeIncarnation }
  let metadata: StateMetadata | null
  let trust: GroupRecoveryTrust
  let control: ControlSnapshot
  try {
    if (
      lifetime.groupID !== groupID ||
      !Number.isSafeInteger(key.incarnation) ||
      key.incarnation < 1 ||
      !Number.isSafeInteger(lifetime.latestIncarnation) ||
      key.incarnation > lifetime.latestIncarnation
    )
      throw new GroupUnavailableError({ reason: 'invalid' })
    control = await reads.control(key.incarnation)
    trust = await readRetainedTrust(reads, key)
    metadata = await reads.metadata(key.incarnation)
    if (
      metadata === null ||
      metadata.groupID !== groupID ||
      metadata.incarnation !== key.incarnation ||
      metadata.deleted ||
      !Number.isSafeInteger(metadata.version) ||
      metadata.version < 1
    )
      throw new GroupUnavailableError({ reason: 'invalid' })
  } catch (cause) {
    refuseStoredValue(cause, 'invalid')
  }
  let record: GroupStateRecord | null
  try {
    record = await reads.state(key.incarnation)
  } catch (cause) {
    refuseStoredValue(cause, 'state-unreadable')
  }
  if (record === null || (!record.deleted && record.state === null))
    throw new GroupUnavailableError({ reason: 'state-unreadable' })
  if (record.deleted) throw new GroupUnavailableError({ reason: 'invalid' })
  assertMutationSafety?.()
  try {
    if (
      !(record.state instanceof Uint8Array) ||
      record.version !== metadata.version ||
      typeof record.terminal !== 'boolean' ||
      !Number.isSafeInteger(record.senderHWM) ||
      record.senderHWM < 0
    )
      throw new Error('Invalid active state')
    const readable = { ...record, state: record.state }
    // Even unchanged versions must successfully open current bytes before consulting the cache.
    if (
      cached !== null &&
      cached.key.incarnation === key.incarnation &&
      cached.record.version === metadata.version &&
      sameValue(cached.record, readable) &&
      sameValue(cached.trust, trust)
    )
      return { value: cached, control }
    const retainedRecord = copyRecord(readable)
    const retainedTrust = decodeStoredValue(encodeStoredValue(trust)) as GroupRecoveryTrust
    const handle = restrictCommitAuthoring(await environment.restore(copyRecord(retainedRecord)))
    validateRegistryHandle({
      handle,
      key,
      record: retainedRecord,
      trust: retainedTrust,
      environment: environment.recovery,
      ownerDID: environment.ownerDID,
    })
    const members = handle.listMembers()
    const ownMember =
      handle.state.groupActiveState.kind !== 'removedFromGroup' &&
      members.some(
        (member) =>
          member.leafIndex === handle.state.privatePath.leafIndex &&
          normalizeDID(member.id) === normalizeDID(environment.ownerDID),
      )
    return {
      value: {
        key,
        record: retainedRecord,
        trust: retainedTrust,
        ownMember,
        lapsed: !handle.sendAdmission().admissible,
        snapshot: {
          ...retainedTrust.installed,
          authenticator: retainedTrust.installed.authenticator.slice(),
          stateVersion: retainedRecord.version,
          members: new Set(members.map((member) => normalizeDID(member.id))),
          available: ownMember && !retainedRecord.terminal,
        },
      },
      control,
    }
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: The constructor forwards params.cause to Error.
    throw new GroupUnavailableError({ reason: 'invalid', cause })
  }
}

export function admissionFor(value: ValidatedGroupState, control: ControlSnapshot): SendAdmission {
  const epoch = value.snapshot.epoch
  const safety = controlSafetyHeld(control, value.snapshot.condition)
  if (safety !== null) return { epoch, admissible: false, reason: safety }
  if (value.record.terminal || !value.ownMember)
    return { epoch, admissible: false, reason: 'terminal' }
  if (control.strand !== null) return { epoch, admissible: false, reason: 'stranded' }
  if (value.lapsed) return { epoch, admissible: false, reason: 'lapsed' }
  return { epoch, admissible: true }
}
