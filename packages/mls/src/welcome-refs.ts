import { toB64 } from '@sozai/codec'
import { decode, mlsMessageDecoder, type Welcome, wireformats } from 'ts-mls'

/**
 * The KeyPackageRefs a Welcome names, base64 — one per set of encrypted group secrets it carries.
 *
 * Same encoding as {@link keyPackageRef}, so a holder of several retained bundles can pick the one
 * this Welcome is for by comparison instead of trying each until one decrypts.
 *
 * Accepts framed `MLSMessage(Welcome)` bytes or a pre-decoded ts-mls Welcome, exactly as
 * `processWelcome` does — the same value reaches both.
 */
export function welcomeKeyPackageRefs(welcome: Uint8Array | unknown): Array<string> {
  let resolved: unknown = welcome
  if (welcome instanceof Uint8Array) {
    const decoded = decode(mlsMessageDecoder, welcome)
    if (decoded == null || decoded.wireformat !== wireformats.mls_welcome) {
      throw new Error('welcomeKeyPackageRefs: expected a framed MLSMessage(Welcome)')
    }
    resolved = decoded.welcome
  }
  const secrets = (resolved as Welcome | undefined)?.secrets
  if (!Array.isArray(secrets)) {
    throw new Error('welcomeKeyPackageRefs: not a Welcome')
  }
  return secrets.map((secret) => toB64(secret.newMember))
}
