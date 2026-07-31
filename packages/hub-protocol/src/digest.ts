import { sha256 } from '@noble/hashes/sha2.js'

/**
 * The digest `hub/v1/keypackage/status` reports for the caller's own last-resort slot: SHA-256 over
 * the stored string's UTF-8 bytes, lowercase hex.
 *
 * Lives here rather than in each `HubStore` so no implementation can drift from the definition, and
 * so a client comparing its own retained record against the hub's is comparing the same function.
 *
 * Hex rather than base64url only to keep `@kumiai/hub-protocol` free of a codec dependency for a
 * value nobody parses.
 */
export function keyPackageDigest(stored: string): string {
  const bytes = sha256(new TextEncoder().encode(stored))
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
