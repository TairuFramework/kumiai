import { decodeClientState, type MemberCredential } from '@kumiai/mls'
import type { AdoptionExpected, LogPosition } from '@kumiai/rpc'

import { decodeStoredValue, encodeStoredValue } from './persistence-codec.js'

export type ControlJournal = {
  version: 1
  source: AdoptionExpected
  checkpoint: LogPosition | null
  sourceState: Uint8Array
  sourceCredential: MemberCredential
  sourceLedger: Array<string>
  referencedProposals?: Array<string>
  candidateAuthenticator?: Uint8Array
  candidate: Uint8Array
}

function assertJournal(value: unknown): asserts value is ControlJournal {
  const journal = value as ControlJournal | null
  const source = journal?.source
  const identity = source?.identity
  if (
    journal === null ||
    typeof journal !== 'object' ||
    journal.version !== 1 ||
    source == null ||
    !Number.isSafeInteger(source.stateVersion) ||
    source.stateVersion < 0 ||
    typeof source.key?.groupID !== 'string' ||
    !Number.isSafeInteger(source.key.incarnation) ||
    source.key.incarnation < 1 ||
    identity == null ||
    identity.groupID !== source.key.groupID ||
    identity.incarnation !== source.key.incarnation ||
    !Number.isSafeInteger(identity.epoch) ||
    identity.epoch < 0 ||
    !(identity.authenticator instanceof Uint8Array) ||
    !(journal.sourceState instanceof Uint8Array) ||
    !(journal.candidate instanceof Uint8Array) ||
    (journal.candidateAuthenticator !== undefined &&
      !(journal.candidateAuthenticator instanceof Uint8Array)) ||
    (journal.referencedProposals !== undefined &&
      (!Array.isArray(journal.referencedProposals) ||
        !journal.referencedProposals.every((ref) => typeof ref === 'string'))) ||
    (journal.checkpoint !== null && typeof journal.checkpoint !== 'string') ||
    typeof journal.sourceCredential?.id !== 'string' ||
    journal.sourceCredential.groupID !== source.key.groupID ||
    !Array.isArray(journal.sourceLedger) ||
    !journal.sourceLedger.every((token) => typeof token === 'string')
  )
    throw new TypeError('Malformed control journal')
  const state = decodeClientState(journal.sourceState)
  if (
    state == null ||
    Number(state.groupContext.epoch) !== identity.epoch ||
    new TextDecoder().decode(state.groupContext.groupId) !== source.key.groupID ||
    state.keySchedule.epochAuthenticator.length !== identity.authenticator.length ||
    !state.keySchedule.epochAuthenticator.every(
      (byte, index) => byte === identity.authenticator[index],
    )
  )
    throw new TypeError('Control journal source identity mismatch')
}

export function encodeControlJournal(value: ControlJournal): Uint8Array {
  assertJournal(value)
  return encodeStoredValue(value)
}

export function decodeControlJournal(bytes: Uint8Array): ControlJournal {
  const value = decodeStoredValue(bytes)
  assertJournal(value)
  return value
}
