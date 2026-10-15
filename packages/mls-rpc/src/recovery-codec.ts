import { normalizeDID } from '@kokuin/token'
import {
  type ClientState,
  type DeviceRegistry,
  decodeClientState,
  decodeDeviceRegistry,
  encodeClientState,
  encodeDeviceRegistry,
  GROUP_ANCHOR_EXTENSION_TYPE,
  parseMLSCredentialIdentity,
  type RecoveryTrustInputs,
} from '@kumiai/mls'
import {
  copyRecoverySource,
  copyRecoveryTargetCapture,
  type LogPosition,
  type RecoveryTargetCapture,
  validateCaptureHead,
} from '@kumiai/rpc'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { base64ToBytes, bytesToBase64, decode, mlsMessageDecoder, wireformats } from 'ts-mls'

import {
  decodeStoredValue,
  decodeTrust,
  encodeStoredValue,
  encodeTrust,
} from './persistence-codec.js'
import type { BoundRecoveryCommit } from './recovery.js'
import { recoveryTrustDigest } from './recovery-trust-digest.js'
import type { RegistryRecoverySource } from './registry/types.js'

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

export type CapturedRecoverySnapshot = RecoverySnapshot & {
  source: RegistryRecoverySource
  target: RecoveryTargetCapture
  captureHead: LogPosition | null
  searchFrom: LogPosition | null
  attestedReply: Uint8Array
}

const CAPTURED_AAD = new TextEncoder().encode('kumiai/recovery-candidate/v3')

const AAD = new TextEncoder().encode('kumiai/recovery-candidate/v2')
const VERSION = 2
const NONCE_BYTES = 24

export function encodeRecoveryCandidate(
  snapshot: RecoverySnapshot,
  requestKey: Uint8Array,
): Uint8Array {
  // Only the public tree belongs to the source; context/schedule remain those of the candidate.
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

export function validateRecoverySource(source: RegistryRecoverySource): void {
  const trust: RecoveryTrustInputs = source?.trust
  if (
    source == null ||
    trust == null ||
    typeof source.key?.groupID !== 'string' ||
    source.key.groupID !== trust.groupID ||
    !Number.isSafeInteger(source.key.incarnation) ||
    source.key.incarnation < 1 ||
    !Number.isSafeInteger(source.stateVersion) ||
    source.stateVersion < 0 ||
    !Number.isSafeInteger(source.lifetimeRevision) ||
    source.lifetimeRevision < 0 ||
    source.trust.installed?.incarnation !== source.key.incarnation
  )
    throw new TypeError('Invalid recovery source')
  if (source.trustDigest !== recoveryTrustDigest(source.trust))
    throw new TypeError('Recovery trust digest mismatch')
  if (
    source.identity !== null &&
    (source.identity?.groupID !== source.key.groupID ||
      source.identity.incarnation !== source.key.incarnation ||
      source.identity.epoch !== source.trust.installed.epoch ||
      !(source.identity.authenticator instanceof Uint8Array) ||
      !equalBytes(source.identity.authenticator, source.trust.installed.authenticator))
  )
    throw new TypeError('Recovery source identity mismatch')
}

export function validateRecoveryCapture(value: {
  target: RecoveryTargetCapture
  captureHead: LogPosition | null
  searchFrom: LogPosition | null
}): void {
  const { target } = value
  if (
    target == null ||
    typeof target.targetID !== 'string' ||
    target.targetID.length === 0 ||
    typeof target.topicID !== 'string' ||
    target.topicID.length === 0 ||
    !Number.isSafeInteger(target.groupInfoEpoch) ||
    target.groupInfoEpoch < 0 ||
    !(target.groupInfoAuthenticator instanceof Uint8Array) ||
    target.groupInfoAuthenticator.length === 0 ||
    validateCaptureHead(target.captureHead) !== validateCaptureHead(value.captureHead) ||
    validateCaptureHead(value.searchFrom) !== value.captureHead
  )
    throw new TypeError('Invalid recovery capture')
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

function validateCapturedSnapshot(snapshot: CapturedRecoverySnapshot): void {
  validateRecoverySource(snapshot.source)
  validateRecoveryCapture(snapshot)
  const { state, source, target } = snapshot
  const leaf = state.ratchetTree[state.privatePath.leafIndex * 2]
  const info = decode(mlsMessageDecoder, snapshot.groupInfo)
  if (info?.wireformat !== wireformats.mls_group_info)
    throw new TypeError('Invalid captured GroupInfo')
  const groupContext = info.groupInfo.groupContext
  const anchor = groupContext.extensions.find(
    (entry) => entry.extensionType === GROUP_ANCHOR_EXTENSION_TYPE,
  )?.extensionData
  if (
    snapshot.epoch !== target.groupInfoEpoch + 1 ||
    state.groupContext.epoch !== BigInt(snapshot.epoch) ||
    new TextDecoder('utf-8', { fatal: true }).decode(state.groupContext.groupId) !==
      source.key.groupID ||
    new TextDecoder('utf-8', { fatal: true }).decode(groupContext.groupId) !== source.key.groupID ||
    !(anchor instanceof Uint8Array) ||
    !equalBytes(anchor, source.trust.genesisAnchor) ||
    groupContext.epoch !== BigInt(target.groupInfoEpoch) ||
    target.groupInfoAuthenticator.length !== source.trust.installed.authenticator.length ||
    leaf?.nodeType !== 1 ||
    !('identity' in leaf.leaf.credential) ||
    normalizeDID(parseMLSCredentialIdentity(leaf.leaf.credential.identity).id) !==
      normalizeDID(source.trust.credential.id) ||
    !(snapshot.attestedReply instanceof Uint8Array) ||
    snapshot.attestedReply.length === 0 ||
    typeof snapshot.requestID !== 'string' ||
    snapshot.requestID.length === 0 ||
    typeof snapshot.signer !== 'string' ||
    !(snapshot.commit instanceof Uint8Array) ||
    snapshot.commit.length === 0 ||
    !Array.isArray(snapshot.replyLedger) ||
    !snapshot.replyLedger.every((token) => typeof token === 'string') ||
    (snapshot.boundCommit !== undefined && !isBoundCommit(snapshot.boundCommit))
  )
    throw new TypeError('Captured recovery candidate identity mismatch')
}

export function encodeCapturedRecoveryCandidate(
  snapshot: CapturedRecoverySnapshot,
  requestKey: Uint8Array,
): Uint8Array {
  validateCapturedSnapshot(snapshot)
  const { sourceTree, ...fields } = snapshot
  const body = encodeStoredValue({
    ...fields,
    state: encodeClientState(snapshot.state),
    sourceState: encodeClientState({ ...snapshot.state, ratchetTree: sourceTree }),
    knownRegistry: encodeDeviceRegistry(snapshot.knownRegistry),
    source: { ...copyRecoverySource(snapshot.source), trust: encodeTrust(snapshot.source.trust) },
    target: copyRecoveryTargetCapture(snapshot.target),
  })
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const sealed = xchacha20poly1305(requestKey, nonce, CAPTURED_AAD).encrypt(body)
  return new Uint8Array([3, ...nonce, ...sealed])
}

export function decodeCapturedRecoveryCandidate(
  bytes: Uint8Array,
  requestKey: Uint8Array,
): CapturedRecoverySnapshot {
  if (bytes.length < 1 + NONCE_BYTES + 16) throw new Error('Truncated recovery candidate')
  if (bytes[0] !== 3) throw new Error(`Unsupported recovery candidate version ${bytes[0]}`)
  const body = xchacha20poly1305(
    requestKey,
    bytes.subarray(1, 1 + NONCE_BYTES),
    CAPTURED_AAD,
  ).decrypt(bytes.subarray(1 + NONCE_BYTES))
  const value = decodeStoredValue(body)
  if (
    !isObject(value) ||
    !isObject(value.source) ||
    !(value.state instanceof Uint8Array) ||
    !(value.sourceState instanceof Uint8Array) ||
    !(value.knownRegistry instanceof Uint8Array)
  )
    throw new TypeError('Invalid captured recovery candidate')
  const state = decodeClientState(value.state)
  const sourceState = decodeClientState(value.sourceState)
  if (state == null || sourceState == null) throw new TypeError('Invalid captured recovery state')
  // sourceState retains the complete candidate context/schedule with only its public tree replaced.
  if (
    !equalBytes(
      encodeClientState({ ...sourceState, ratchetTree: state.ratchetTree }),
      encodeClientState(state),
    )
  )
    throw new TypeError('Invalid captured recovery sourceState')
  const snapshot = {
    state,
    sourceTree: sourceState.ratchetTree,
    source: { ...value.source, trust: decodeTrust(value.source.trust) },
    knownRegistry: decodeDeviceRegistry(value.knownRegistry),
    target: value.target,
    captureHead: value.captureHead,
    searchFrom: value.searchFrom,
    attestedReply: value.attestedReply,
    groupInfo: value.groupInfo,
    replyLedger: value.replyLedger,
    signer: value.signer,
    commit: value.commit,
    epoch: value.epoch,
    requestID: value.requestID,
    ...(value.boundCommit === undefined ? {} : { boundCommit: value.boundCommit }),
  } as CapturedRecoverySnapshot
  validateCapturedSnapshot(snapshot)
  return snapshot
}
