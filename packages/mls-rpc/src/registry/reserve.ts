import {
  type ClientState,
  decodeClientState,
  denyApplicationSend,
  encodeClientState,
  type GroupHandle,
  ownApplicationGeneration,
  type Relinquished,
  reserveApplicationRange,
  restrictCommitAuthoring,
} from '@kumiai/mls'
import { sha256 } from '@noble/hashes/sha2.js'

import { controlProjection } from '../control-compat.js'
import { GroupUnavailableError } from '../persistence-errors.js'
import type { EpochIdentity, GroupKey } from '../persistence-types.js'
import { type ColdEnvironment, copyRecord } from './cold.js'
import type { ReadableGroupState } from './types.js'

export const LEASE_SIZE = 16
export const LEASE_RENEW_BELOW = 4
export const LEASE_MAX_GENERATION = 500
export const LEASE_AWAIT_MS = 5_000

export type ReservationEnvelope = Readonly<{ saved: ReadableGroupState; version: number }>
export type Reservation = {
  identity: EpochIdentity
  envelope: ReservationEnvelope
  pre: ReadableGroupState
  start: number
  limit: number
  eligibility: Uint8Array
}

export function reservationEnvelope(record: ReadableGroupState): ReservationEnvelope {
  const saved = copyRecord(record)
  Object.freeze(saved.credential)
  Object.freeze(saved.ledger)
  Object.freeze(saved)
  return Object.freeze({ saved, version: saved.version })
}

export function capturedRecord(
  captured: Relinquished,
  key: GroupKey,
  version: number,
): ReadableGroupState {
  const state = decodeClientState(captured.state)
  if (state === undefined) throw new GroupUnavailableError({ reason: 'invalid' })
  return {
    ...key,
    version,
    deleted: false,
    terminal: false,
    epoch: Number(state.groupContext.epoch),
    epochAuthenticator: state.keySchedule.epochAuthenticator.slice(),
    state: captured.state,
    credential: captured.credential,
    ledger: captured.ledgerTokens,
    senderHWM: ownApplicationGeneration(state),
  }
}

export async function restoreCaptured(
  environment: ColdEnvironment,
  record: ReadableGroupState,
): Promise<GroupHandle> {
  try {
    return denyApplicationSend(
      restrictCommitAuthoring(await environment.restore(copyRecord(record))),
    )
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: The constructor forwards params.cause.
    throw new GroupUnavailableError({ reason: 'invalid', cause })
  }
}

export function eligibilityOf(state: ClientState, lapsed: boolean): Uint8Array {
  const projection = controlProjection(state)
  const eligibility = new TextEncoder().encode(
    JSON.stringify([
      Object.keys(state.unappliedProposals).sort(),
      state.groupActiveState.kind,
      lapsed,
    ]),
  )
  return sha256(new Uint8Array([...projection, ...eligibility]))
}

export function receiveProjection(state: ClientState): Uint8Array {
  const own = state.privatePath.leafIndex * 2
  const node = state.secretTree.leafNodes[own]
  return encodeClientState({
    ...state,
    secretTree: {
      ...state.secretTree,
      leafNodes: {
        ...state.secretTree.leafNodes,
        ...(node === undefined
          ? {}
          : {
              [own]: {
                ...node,
                application: { secret: new Uint8Array(), generation: 0, unusedGenerations: {} },
              },
            }),
      },
    },
  })
}

export async function reserveFromBytes(
  environment: ColdEnvironment,
  record: ReadableGroupState,
  floor: number,
): Promise<{
  handle: GroupHandle
  state: Uint8Array
  senderHWM: number
  reservation: Omit<Reservation, 'envelope'> | null
}> {
  const handle = await restoreCaptured(environment, record)
  const own = ownApplicationGeneration(handle.state)
  const lapsed = handle.ownLeafLapsed()
  if (
    lapsed ||
    handle.state.groupActiveState.kind !== 'active' ||
    Object.keys(handle.state.unappliedProposals).length !== 0
  )
    return { handle, state: record.state, senderHWM: Math.max(own, floor), reservation: null }
  const reserved = await reserveApplicationRange(handle, {
    floor,
    size: LEASE_SIZE,
    cap: LEASE_MAX_GENERATION,
  })
  if (reserved === null)
    return { handle, state: record.state, senderHWM: Math.max(own, floor), reservation: null }
  return {
    handle,
    state: reserved.advanced,
    senderHWM: reserved.limit,
    reservation: {
      identity: {
        groupID: record.groupID,
        incarnation: record.incarnation,
        epoch: Number(handle.epoch),
        authenticator: handle.state.keySchedule.epochAuthenticator.slice(),
      },
      pre: { ...copyRecord(record), state: reserved.pre, senderHWM: reserved.start },
      start: reserved.start,
      limit: reserved.limit,
      eligibility: eligibilityOf(handle.state, lapsed),
    },
  }
}
