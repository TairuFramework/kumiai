import {
  type ClientState,
  type DeviceRegistry,
  decodeClientState,
  decodeDeviceRegistry,
  encodeClientState,
  encodeDeviceRegistry,
} from '@kumiai/mls'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { base64ToBytes, bytesToBase64 } from 'ts-mls'

import type { BoundRecoveryCommit } from './recovery.js'

export type RecoverySnapshot = {
  state: ClientState
  sourceTree: ClientState['ratchetTree']
  groupInfo: Uint8Array
  knownRegistry: DeviceRegistry
  replyLedger: Array<string>
  signer: string
  commit: Uint8Array
  epoch: number
  requestID: string
  boundCommit?: BoundRecoveryCommit
}

const AAD = new TextEncoder().encode('kumiai/recovery-candidate/v2')
const VERSION = 2
const NONCE_BYTES = 24

export function encodeRecoveryCandidate(
  snapshot: RecoverySnapshot,
  requestKey: Uint8Array,
): Uint8Array {
  const sourceState = encodeClientState({ ...snapshot.state, ratchetTree: snapshot.sourceTree })
  const body = new TextEncoder().encode(
    JSON.stringify({
      epoch: snapshot.epoch,
      requestID: snapshot.requestID,
      replyLedger: snapshot.replyLedger,
      signer: snapshot.signer,
      boundCommit: snapshot.boundCommit,
      state: bytesToBase64(encodeClientState(snapshot.state)),
      sourceState: bytesToBase64(sourceState),
      groupInfo: bytesToBase64(snapshot.groupInfo),
      knownRegistry: bytesToBase64(encodeDeviceRegistry(snapshot.knownRegistry)),
      commit: bytesToBase64(snapshot.commit),
    }),
  )
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const sealed = xchacha20poly1305(requestKey, nonce, AAD).encrypt(body)
  const bytes = new Uint8Array(1 + NONCE_BYTES + sealed.length)
  bytes[0] = VERSION
  bytes.set(nonce, 1)
  bytes.set(sealed, 1 + NONCE_BYTES)
  return bytes
}

export function decodeRecoveryCandidate(
  bytes: Uint8Array,
  requestKey: Uint8Array,
): RecoverySnapshot {
  if (bytes.length < 1 + NONCE_BYTES + 16) throw new Error('Truncated recovery candidate')
  if (bytes[0] !== VERSION) throw new Error(`Unsupported recovery candidate version ${bytes[0]}`)
  const body = xchacha20poly1305(requestKey, bytes.subarray(1, 1 + NONCE_BYTES), AAD).decrypt(
    bytes.subarray(1 + NONCE_BYTES),
  )
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  if (
    !isObject(value) ||
    !Number.isSafeInteger(value.epoch) ||
    Number(value.epoch) < 0 ||
    typeof value.requestID !== 'string' ||
    typeof value.signer !== 'string' ||
    !Array.isArray(value.replyLedger) ||
    value.replyLedger.some((token: unknown) => typeof token !== 'string') ||
    (value.boundCommit !== undefined && !isBoundCommit(value.boundCommit))
  ) {
    throw new Error('Invalid recovery candidate')
  }
  const state = decodeClientState(readBytes(value.state))
  if (state == null || Number(state.groupContext.epoch) !== value.epoch)
    throw new Error('Invalid recovery state')
  const source = decodeClientState(readBytes(value.sourceState))
  if (source == null) throw new Error('Invalid recovery source tree')
  return {
    state,
    sourceTree: source.ratchetTree,
    groupInfo: readBytes(value.groupInfo),
    knownRegistry: decodeDeviceRegistry(readBytes(value.knownRegistry)),
    replyLedger: value.replyLedger as Array<string>,
    signer: value.signer,
    commit: readBytes(value.commit),
    epoch: Number(value.epoch),
    requestID: value.requestID,
    ...(value.boundCommit == null ? {} : { boundCommit: value.boundCommit }),
  }
}

function readBytes(value: unknown): Uint8Array {
  if (typeof value !== 'string') throw new Error('Invalid recovery bytes')
  const bytes = base64ToBytes(value)
  if (bytesToBase64(bytes) !== value) throw new Error('Invalid recovery bytes')
  return bytes
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isBoundCommit(value: unknown): value is BoundRecoveryCommit {
  return (
    isObject(value) &&
    typeof value.position === 'string' &&
    typeof value.commitDigest === 'string' &&
    (value.tag === undefined || typeof value.tag === 'string')
  )
}
