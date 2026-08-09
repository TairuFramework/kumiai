import { encodeBase64url } from '@kumiai/hub-protocol'
import { p256 } from '@noble/curves/nist.js'
import { randomBytes } from '@noble/hashes/utils.js'

export type WakeKeys = {
  /** Keep this on the device. It is the only thing that can open a wake ping. */
  privateKey: Uint8Array
  /** base64url, for `registerWake`. */
  publicKey: string
  /** base64url, for `registerWake`. */
  authSecret: string
}

/**
 * Fresh RFC 8291 key material for one device.
 *
 * The private half never leaves the device — the hub stores only the public key and the auth
 * secret, which are all it needs to seal. Rotation is a new call followed by `registerWake`.
 *
 * On iOS the private key must be reachable from the Notification Service Extension, which means
 * the Keychain behind a shared App Group; an in-process-only copy leaves the extension unable to
 * open anything.
 */
export function createWakeKeys(): WakeKeys {
  const privateKey = p256.utils.randomSecretKey()
  return {
    privateKey,
    publicKey: encodeBase64url(p256.getPublicKey(privateKey, false)),
    authSecret: encodeBase64url(randomBytes(16)),
  }
}
