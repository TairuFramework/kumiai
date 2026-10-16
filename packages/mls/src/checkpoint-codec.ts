import { normalizeDID } from '@kokuin/token'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { canonicalStringify, fromB64U, fromUTF, toB64U, toUTF } from '@sozai/codec'

import type {
  CheckpointMember,
  EpochCheckpointBodyV1,
  EpochRosterFactV1,
} from './checkpoint-types.js'

const BODY_FIELDS = [
  'v',
  'type',
  'groupID',
  'genesisHash',
  'ciphersuite',
  'epoch',
  'authHash',
  'parentAuthHash',
  'keyHash',
  'leafIndex',
]
const FACT_FIELDS = [
  'v',
  'key',
  'genesisHash',
  'ciphersuite',
  'epoch',
  'authHash',
  'parentAuthHash',
  'confirmedTranscriptHash',
  'members',
  'installation',
]

function reject(): never {
  throw new Error('Invalid canonical checkpoint data')
}

function object(value: unknown, fields: Array<string>): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) reject()
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field))
  )
    reject()
  return record
}

function text(value: unknown, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && value.length === 0) || !value.isWellFormed()) reject()
}

function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max)
    reject()
}

function base64(value: unknown, length?: number): Uint8Array {
  text(value, true)
  const bytes = fromB64U(value)
  if (toB64U(bytes) !== value || (length != null && bytes.length !== length)) reject()
  return bytes
}

function binding(value: Record<string, unknown>): void {
  if (value.v !== 1 || (value.ciphersuite !== 1 && value.ciphersuite !== 3)) reject()
  integer(value.epoch)
  base64(value.genesisHash, 32)
  base64(value.authHash, 32)
  if (value.parentAuthHash !== null) base64(value.parentAuthHash, 32)
}

function validateBody(value: unknown): EpochCheckpointBodyV1 {
  const record = object(value, BODY_FIELDS)
  binding(record)
  if (record.type !== 'kumiai/checkpoint/v1') reject()
  text(record.groupID)
  base64(record.keyHash, 32)
  integer(record.leafIndex, 0xffffffff)
  return record as EpochCheckpointBodyV1
}

function compareMembers(first: CheckpointMember, second: CheckpointMember): number {
  for (const field of ['signerDID', 'keyHash'] as const) {
    if (first[field] < second[field]) return -1
    if (first[field] > second[field]) return 1
  }
  return first.leafIndex - second.leafIndex
}

function validateFact(value: unknown): EpochRosterFactV1 {
  const record = object(value, FACT_FIELDS)
  binding(record)
  const key = object(record.key, ['groupID', 'incarnation'])
  text(key.groupID)
  integer(key.incarnation)
  const installation = object(record.installation, ['mutationID', 'stateVersion'])
  text(installation.mutationID)
  integer(installation.stateVersion)
  base64(record.confirmedTranscriptHash)
  if (!Array.isArray(record.members)) reject()
  const pairs = new Set<string>()
  const leaves = new Set<number>()
  const members = record.members.map((value) => {
    const member = object(value, ['signerDID', 'keyHash', 'leafIndex', 'signaturePublicKey'])
    text(member.signerDID)
    if (
      !/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+(?::[A-Za-z0-9._:%-]+)*$/.test(member.signerDID) ||
      normalizeDID(member.signerDID) !== member.signerDID
    )
      reject()
    base64(member.keyHash, 32)
    const publicKey = base64(member.signaturePublicKey, 32)
    if (checkpointKeyHash(publicKey) !== member.keyHash) reject()
    integer(member.leafIndex, 0xffffffff)
    const pair = canonicalStringify([member.signerDID, member.keyHash])
    if (pairs.has(pair) || leaves.has(member.leafIndex)) reject()
    pairs.add(pair)
    leaves.add(member.leafIndex)
    return { ...member } as CheckpointMember
  })
  return {
    ...record,
    key: { ...key },
    installation: { ...installation },
    members: members.sort(compareMembers),
  } as EpochRosterFactV1
}

function parse(bytes: Uint8Array): unknown {
  const text = toUTF(bytes)
  const value: unknown = JSON.parse(text)
  // Re-encoding also rejects duplicate fields, alternate escapes and number spellings.
  if (canonicalStringify(value) !== text) reject()
  return value
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value)
  return bytes
}

function lp(bytes: Uint8Array): Uint8Array {
  return concatBytes(u32(bytes.length), bytes)
}

function hash(label: string, ...parts: Array<Uint8Array>): string {
  return toB64U(sha256(concatBytes(fromUTF(label), new Uint8Array([0]), ...parts.map(lp))))
}

export function checkpointGenesisHash(anchor: Uint8Array): string {
  return hash('kumiai/checkpoint-genesis/v1', anchor)
}

export function checkpointKeyHash(signaturePublicKey: Uint8Array): string {
  if (signaturePublicKey.length !== 32) reject()
  return hash('kumiai/checkpoint-key/v1', signaturePublicKey)
}

export function checkpointAuthHash(params: {
  groupID: string
  genesisHash: string
  epoch: number
  epochAuthenticator: Uint8Array
}): string {
  text(params.groupID)
  integer(params.epoch)
  const epoch = new Uint8Array(8)
  new DataView(epoch.buffer).setBigUint64(0, BigInt(params.epoch))
  return hash(
    'kumiai/checkpoint-authenticator/v1',
    fromUTF(params.groupID),
    base64(params.genesisHash, 32),
    epoch,
    params.epochAuthenticator,
  )
}

export function checkpointSignatureInput(body: EpochCheckpointBodyV1): Uint8Array {
  const bytes = fromUTF(canonicalStringify(validateBody(body)))
  return concatBytes(fromUTF('kumiai/checkpoint-signature/v1'), new Uint8Array([0]), lp(bytes))
}

export function encodeEpochRosterFact(fact: EpochRosterFactV1): Uint8Array {
  return fromUTF(canonicalStringify(validateFact(fact)))
}

export function decodeEpochRosterFact(bytes: Uint8Array): EpochRosterFactV1 {
  const fact = validateFact(parse(bytes))
  if (canonicalStringify(fact) !== toUTF(bytes)) reject()
  return fact
}

export function encodeEpochCheckpoint(
  body: EpochCheckpointBodyV1,
  signature: Uint8Array,
): Uint8Array {
  const bytes = fromUTF(canonicalStringify(validateBody(body)))
  if (signature.length !== 64) reject()
  if (bytes.length + 74 > 4096) throw new Error('Checkpoint frame exceeds 4096 byte size')
  return concatBytes(new Uint8Array([1, 1]), u32(bytes.length + 68), lp(bytes), signature)
}

export function decodeEpochCheckpoint(frame: Uint8Array): {
  body: EpochCheckpointBodyV1
  bodyBytes: Uint8Array
  signature: Uint8Array
} {
  if (frame.length > 4096) throw new Error('Checkpoint frame exceeds 4096 byte size')
  if (frame.length < 74 || frame[0] !== 1 || frame[1] !== 1) reject()
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const length = view.getUint32(2)
  const bodyLength = view.getUint32(6)
  if (length !== frame.length - 6 || bodyLength !== frame.length - 74) reject()
  const bodyBytes = new Uint8Array(frame.subarray(10, 10 + bodyLength))
  const body = validateBody(parse(bodyBytes))
  return { body, bodyBytes, signature: new Uint8Array(frame.subarray(10 + bodyLength)) }
}
