import { p256 } from '@noble/curves/nist.js'
import { toB64U } from '@sozai/codec'
import { createRuntime, type Runtime } from '@sozai/runtime'

export type CreateWakeKeysParams = {
  /**
   * Where the randomness comes from. Default: `createRuntime()`, i.e. `globalThis.crypto`.
   *
   * React Native has no usable global `crypto`, so an Expo app must pass `@sozai/runtime-expo`'s
   * runtime here — the same one it already gives `@kumiai/mls`. Without it key generation fails on
   * device, which is exactly where these keys are made.
   */
  runtime?: Runtime
}

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
export function createWakeKeys(params: CreateWakeKeysParams = {}): WakeKeys {
  const runtime = params.runtime ?? createRuntime()
  const random = (length: number): Uint8Array => runtime.getRandomValues(new Uint8Array(length))

  // Seeded rather than left to noble's own `randomBytes`, which reaches for `globalThis.crypto`
  // directly and so ignores the injected runtime. The seed is 48 bytes for P-256 — wider than the
  // 32-byte key, which is what makes the reduction to a scalar unbiased. noble checks the length
  // it was handed, so a future curve change surfaces as a throw here rather than a weaker key.
  const privateKey = p256.utils.randomSecretKey(random(p256.lengths.seed ?? 48))
  return {
    privateKey,
    publicKey: toB64U(p256.getPublicKey(privateKey, false)),
    authSecret: toB64U(random(16)),
  }
}
