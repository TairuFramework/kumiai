import {
  encodeMultibase,
  isVerifiedToken,
  multihashSHA256,
  normalizeDID,
  type SignedPayload,
  type SigningIdentity,
  stringifyToken,
  verifyToken,
} from '@kokuin/token'

const textEncoder = new TextEncoder()

/**
 * A control-ledger claim. The payload of a signed ledger token: `type` selects
 * the reducer, `groupID` binds the claim to a single group, `subject` is the
 * entity the claim is about, and `value` carries the claim data. The
 * authenticated author is never part of this shape — it comes from the verified
 * token's `iss`.
 */
export type LedgerEntry<TValue = unknown> = {
  type: string
  groupID: string
  subject: string
  value: TValue
  /**
   * Consumer-supplied total-order key, signed with the rest of the claim.
   * `@kumiai/mls` never reads it — kumiai orders by the epoch chain. Kubun sets
   * it to its HLC. Optional.
   */
  ord?: string
}

/** A ledger entry whose token signature has been cryptographically verified. */
export type VerifiedLedgerEntry<TValue = unknown> = {
  /** Authenticated author DID (the verified token issuer), normalized. */
  issuer: string
  entry: LedgerEntry<TValue>
}

/**
 * Sign a ledger entry. The signer fills `iss` with its DID, so the signature
 * covers every claim field — including `groupID` and `ord` — and binds the
 * author. `ord` is signed only when present, so a claim without it never signs
 * an `ord: undefined` key. Returns the stringified token.
 */
export async function signLedgerEntry(
  identity: SigningIdentity,
  entry: LedgerEntry,
): Promise<string> {
  const signed = await identity.signToken(
    {
      type: entry.type,
      groupID: entry.groupID,
      subject: entry.subject,
      value: entry.value,
      ...(entry.ord === undefined ? {} : { ord: entry.ord }),
    },
    // Embed the long-form DID so each entry is self-verifying offline: the
    // ledger is the source of truth and receivers fold it long after first
    // contact, when the author's DID document may no longer be cached. No-op
    // for did:key (long form === id).
    { embedLongForm: true },
  )
  return stringifyToken(signed)
}

/**
 * Verify a signed ledger token and extract its claim. Returns `null` (never
 * throws) when the token is unparseable, unsigned (`alg: 'none'` — `verifyToken`
 * returns those without checking a signature, so an attacker could forge an
 * arbitrary `iss`; `isVerifiedToken` rejects them), or structurally malformed.
 * A missing or non-string `groupID` is malformed, as is a missing or non-string
 * `type` or `subject`, or an `ord` present but not a string. The claim fields
 * come from the verified payload only; the issuer is the normalized verified
 * `iss`.
 */
export async function verifyLedgerEntry<TValue = unknown>(
  token: string,
): Promise<VerifiedLedgerEntry<TValue> | null> {
  let verified: Awaited<ReturnType<typeof verifyToken<LedgerEntry<TValue>>>>
  try {
    verified = await verifyToken<LedgerEntry<TValue>>(token)
  } catch {
    return null
  }
  if (!isVerifiedToken<SignedPayload & LedgerEntry<TValue>>(verified)) {
    return null
  }
  const { iss, type, groupID, subject, value, ord } = verified.payload
  if (
    typeof type !== 'string' ||
    typeof groupID !== 'string' ||
    typeof subject !== 'string' ||
    (ord !== undefined && typeof ord !== 'string')
  ) {
    return null
  }
  return {
    issuer: normalizeDID(iss),
    entry: { type, groupID, subject, value, ...(ord === undefined ? {} : { ord }) },
  }
}

/**
 * Content-addressed digest of a signed ledger token, used as the append-only
 * store's dedup key. Multibase-encoded SHA-256 multihash over the token bytes.
 */
export function ledgerEntryDigest(signedToken: string): string {
  return encodeMultibase(multihashSHA256(textEncoder.encode(signedToken)))
}
