import { gcm } from '@noble/ciphers/aes.js'

import type { AtRestCodec } from '../../src/persistence-types.js'

// Deterministic nonces are exclusively for fixtures, never host encryption.
export function createDeterministicAtRestCodec(params: { key: Uint8Array }): AtRestCodec {
  if (params.key.length !== 32) throw new TypeError('Expected a 32-byte at-rest key')
  const key = Uint8Array.from(params.key)
  return {
    async seal(plaintext, aad) {
      const data = Uint8Array.from(plaintext)
      const context = Uint8Array.from(aad)
      const input = new Uint8Array(8 + context.length + data.length)
      const view = new DataView(input.buffer)
      view.setUint32(0, context.length)
      input.set(context, 4)
      view.setUint32(4 + context.length, data.length)
      input.set(data, 8 + context.length)
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input))
      const nonce = digest.slice(0, 12)
      const encrypted = gcm(key, nonce, context).encrypt(data)
      const bytes = new Uint8Array(nonce.length + encrypted.length)
      bytes.set(nonce)
      bytes.set(encrypted, nonce.length)
      return bytes
    },
    async open(ciphertext, aad) {
      const bytes = Uint8Array.from(ciphertext)
      if (bytes.length < 28) throw new TypeError('Truncated sealed record')
      return gcm(key, bytes.slice(0, 12), Uint8Array.from(aad)).decrypt(bytes.slice(12))
    },
  }
}
