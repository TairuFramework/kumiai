import { type DIDCache, decodePeer4, isPeer4 } from '@kokuin/token'

/**
 * Local member state (never serialized to the MLS leaf). `id` is the member's own
 * DID; `groupID` names the group the handle belongs to.
 */
export type MemberCredential = {
  id: string
  groupID: string
}

/**
 * Wire shape for the MLS basic credential `identity` field. Identity binding
 * only — group membership state lives elsewhere.
 *
 * - did:key identities omit `longForm`.
 * - did:peer:4 identities MUST carry `longForm`; the auth service decodes it
 *   inline and binds the MLS leaf signature key to a verification method.
 *
 * `v` is the format version. Unlike the client-state blob, this is baked into an MLS leaf and
 * covered by its signature — leaves can never be rewritten. So an identity written before `v`
 * existed lives in a leaf that will exist forever, and absent `v` MUST read as `1` permanently.
 * That tolerance is not a courtesy owed to a transition; there is no version of this code that
 * can stop honoring it without refusing leaves nothing is wrong with.
 */
export type MLSCredentialIdentity = {
  v?: 1
  id: string
  longForm?: string
}

export type GroupMember = {
  /** MLS leaf index (ratchet-tree array position / 2, matching findMemberLeafIndex). */
  leafIndex: number
  /** DID parsed from the leaf's MLS credential identity. */
  id: string
}

export function parseMLSCredentialIdentity(identity: Uint8Array): MLSCredentialIdentity {
  const text = new TextDecoder().decode(identity)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new Error('Invalid MLS credential: identity bytes are not valid JSON', { cause })
  }
  if (parsed == null || typeof parsed !== 'object') {
    throw new Error('Invalid MLS credential: identity must be a JSON object')
  }
  const candidate = parsed as Record<string, unknown>
  // Absent `v` is v1, permanently — not a default that will one day stop applying. Leaves
  // written before this field existed are signed and can never be rewritten to add it.
  if ('v' in candidate && candidate.v !== 1) {
    throw new Error(`Invalid MLS credential: unsupported identity version ${String(candidate.v)}`)
  }
  if (typeof candidate.id !== 'string') {
    throw new Error('Invalid MLS credential: id must be a string')
  }
  if ('longForm' in candidate && typeof candidate.longForm !== 'string') {
    throw new Error('Invalid MLS credential: longForm must be a string when present')
  }
  // `v` is not echoed back into the result. It is a wire concern — it tells this function how
  // to read the bytes — not something a caller needs to act on; every parsed identity is
  // already normalized to what v1 means by the time it gets here. Add it back only if a
  // caller needs to distinguish a v1-tagged payload from an untagged one, which none do today.
  const result: MLSCredentialIdentity = { id: candidate.id }
  if (typeof candidate.longForm === 'string') {
    result.longForm = candidate.longForm
  }
  return result
}

/**
 * If the parsed credential carries a did:peer:4 long form, decode it and write
 * to the cache. Hash binding is enforced (decoded short form must equal `id`).
 * No-op for did:key.
 */
export async function populateCacheFromCredential(
  parsed: MLSCredentialIdentity,
  cache: DIDCache,
): Promise<void> {
  if (parsed.longForm == null) return
  if (!isPeer4(parsed.id)) return
  const { shortForm, doc } = decodePeer4(parsed.longForm)
  if (shortForm !== parsed.id) {
    throw new Error('Credential longForm does not match credential.id')
  }
  await cache.set(shortForm, doc)
}
