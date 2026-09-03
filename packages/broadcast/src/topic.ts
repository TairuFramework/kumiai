import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromUTF, toB64U } from '@sozai/codec'

const TOPIC_INFO_PREFIX = 'kumiai/topic/v1'
const SEP = '\0'
const TOPIC_ID_BYTES = 32

function encodeEpoch(epoch: number): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(epoch), true)
  return bytes
}

function assertComponent(value: string, name: string): void {
  // NUL would forge the label/scope split; a lone surrogate collapses to U+FFFD under fromUTF
  // (TextEncoder), so two distinct strings would hash identically. Both break injectivity.
  if (value.includes('\0')) {
    throw new Error(`deriveTopicID: ${name} must not contain a NUL byte`)
  }
  if (!value.isWellFormed()) {
    throw new Error(`deriveTopicID: ${name} must be well-formed UTF-16 (no lone surrogates)`)
  }
}

function assertEpoch(epoch: number): void {
  // Safe-integer floor is the real limit: two epochs at/above 2**53 round to one float before
  // BigInt, and non-integer/negative epochs have no defined encoding. Subsumes the mod-2**64 wrap.
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error(`deriveTopicID: epoch must be a non-negative safe integer, got ${epoch}`)
  }
}

/**
 * Derive an opaque, secret-gated, epoch-rotating topic ID.
 *
 * `secret` is any keying material, `epoch` a rotation counter, `label` a
 * channel name, `scope` an optional subgroup/target discriminator. NUL
 * separators make the `label`/`scope` boundary unambiguous.
 */
export function deriveTopicID(
  secret: Uint8Array,
  epoch: number,
  label: string,
  scope = '',
): string {
  assertEpoch(epoch)
  assertComponent(label, 'label')
  assertComponent(scope, 'scope')

  const info = fromUTF(`${TOPIC_INFO_PREFIX}${SEP}${label}${SEP}${scope}`)
  const okm = hkdf(sha256, secret, encodeEpoch(epoch), info, TOPIC_ID_BYTES)
  return toB64U(okm)
}
