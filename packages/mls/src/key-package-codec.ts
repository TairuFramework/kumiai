import { fromB64, toB64 } from '@sozai/codec'
import {
  encode,
  type KeyPackage,
  keyPackageDecoder,
  keyPackageEncoder,
  makeKeyPackageRef,
  type PrivateKeyPackage,
  privateKeyPackageDecoder,
  privateKeyPackageEncoder,
} from 'ts-mls'

import { resolveMlsContext } from './group-context.js'
import type { GroupOptions } from './types.js'

/**
 * Serialize a key package to the string form the hub stores.
 *
 * Returns a `string` rather than the `Uint8Array` every other encoder in this package returns
 * (`encodeGroupAnchor`, `encodeClientState`, `encodeLedgerHead`), and the deviation is the point.
 * Those blobs are read only by the process that wrote them; this one is a wire format two peers
 * must agree on before either has met the other. `@sozai/codec` exports both `toB64` and `toB64U`
 * and they are not interchangeable, so handing bytes back and leaving the string step to each host
 * is precisely how an uploader and a fetcher end up disagreeing about packages already sitting in
 * a hub. One canonical form, decided here, removes the choice.
 */
export function encodeKeyPackage(keyPackage: KeyPackage): string {
  return toB64(encode(keyPackageEncoder, keyPackage))
}

/**
 * Parse a key package from its stored string form, or `null` if the string is not exactly one.
 *
 * **A successful decode proves well-formedness and nothing else.** No signature is verified, no
 * lifetime is checked, no capability is inspected. ts-mls performs all of those at Add time, on
 * the inviter, with the group context in hand — which a decoder does not have. Repeating them
 * here would be redundant where it duplicated that gate and actively misleading where it did not,
 * because a caller could reasonably read "it decoded" as "it is safe to add". It is not.
 *
 * Strict in three separate ways, each closing a path by which one package gains a second string
 * form:
 *
 * 1. `fromB64` throws on a bad alphabet rather than returning a sentinel, so the throw is absorbed.
 * 2. The re-encode comparison requires the input to be the canonical base64 of its own bytes.
 *    `fromB64` trims surrounding whitespace and tolerates some padding variation, and the hub
 *    stores and compares *strings* — so a byte-level guarantee alone never reaches the layer that
 *    needs it.
 * 3. `keyPackageDecoder` is called directly rather than through ts-mls's `decode()`, which is
 *    `dec(t, 0)?.[0]` and discards the consumed length — silently accepting trailing garbage. The
 *    length is compared against the input instead.
 *
 * `keyPackageDecoder`'s own type says it returns `undefined` on failure, never throws — true for
 * a buffer that is simply too short for a fixed-size field, but a variable-length field whose
 * declared length overruns the buffer (truncated input, not merely short input) makes
 * `varLenDataDecoder` throw `CodecError` instead. That throw is absorbed separately from
 * `fromB64`'s, in its own `try`, so the two failure paths stay independent.
 *
 * One canonical representation per package is what any later attempt to dedup or identify a
 * package by its stored form depends on.
 */
export function decodeKeyPackage(encoded: string): KeyPackage | null {
  let bytes: Uint8Array
  try {
    bytes = fromB64(encoded)
  } catch {
    return null
  }
  if (toB64(bytes) !== encoded) return null
  let decoded: ReturnType<typeof keyPackageDecoder>
  try {
    decoded = keyPackageDecoder(bytes, 0)
  } catch {
    return null
  }
  // The tuple's second element is the CONSUMED LENGTH (ts-mls's `mapDecoders` returns
  // `cursor - offset`), so this is a whole-input check, not an offset comparison.
  if (decoded == null || decoded[1] !== bytes.length) return null
  return decoded[0]
}

/**
 * Serialize a private key package for durable storage.
 *
 * A last-resort key package is reusable, so its private half must OUTLIVE the process that
 * generated it — see `@kumiai/mls-hub`. That makes the string form a persistence format two
 * versions of one host must agree on, which is the same reason {@link encodeKeyPackage} refuses to
 * hand bytes back and leave the base64 choice to each caller.
 *
 * **The result is secret key material.** It is not a public wire form: never publish it, never log
 * it, and store it only where the host stores private keys.
 */
export function encodePrivateKeyPackage(privatePackage: PrivateKeyPackage): string {
  return toB64(encode(privateKeyPackageEncoder, privatePackage))
}

/**
 * Parse a stored private key package, or `null` if the string is not exactly one.
 *
 * Strict in the same three ways {@link decodeKeyPackage} is, for the same reasons: `fromB64`'s
 * throw on a bad alphabet is absorbed; the input must be the canonical base64 of its own bytes,
 * because a store compares strings and `fromB64` tolerates padding variation and trims whitespace;
 * and `privateKeyPackageDecoder` is called directly rather than through ts-mls's `decode()`, whose
 * `dec(t, 0)?.[0]` discards the consumed length and so accepts trailing garbage in silence.
 *
 * A successful decode proves well-formedness and nothing else — in particular it does not prove the
 * keys match any public package.
 */
export function decodePrivateKeyPackage(encoded: string): PrivateKeyPackage | null {
  let bytes: Uint8Array
  try {
    bytes = fromB64(encoded)
  } catch {
    return null
  }
  if (toB64(bytes) !== encoded) return null
  let decoded: ReturnType<typeof privateKeyPackageDecoder>
  try {
    decoded = privateKeyPackageDecoder(bytes, 0)
  } catch {
    return null
  }
  // The tuple's second element is the CONSUMED LENGTH, so this is a whole-input check.
  if (decoded == null || decoded[1] !== bytes.length) return null
  return decoded[0]
}

/**
 * The KeyPackageRef for a key package, base64 — the value a Welcome names when it says which
 * package a set of encrypted group secrets is for.
 *
 * Used as the stable identity of a stored package. It is a hash over the package's canonical
 * encoding, so it is unchanged by a codec round trip, and it is derived under the ciphersuite's
 * hash — a package encoded under one suite and referenced under another yields a different ref,
 * which is why `options` is threaded through rather than defaulted here.
 */
export async function keyPackageRef(
  keyPackage: KeyPackage,
  options?: GroupOptions,
): Promise<string> {
  const { cipherSuite } = await resolveMlsContext(options)
  return toB64(await makeKeyPackageRef(keyPackage, cipherSuite.hash))
}
