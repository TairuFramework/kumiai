import { type CryptoProvider, nobleCrypto } from '@kokuin/crypto'
import {
  type CryptoOptions,
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
export const LEDGER_ENTRY_DIGEST_CACHE_SIZE = 4096
const LEDGER_ENTRY_DIGEST_CACHE = new Map<string, string>()

/** @internal */
export function ledgerEntryDigestCacheSize(): number {
  return LEDGER_ENTRY_DIGEST_CACHE.size
}

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

export type SignLedgerEntryParams = {
  identity: SigningIdentity
  entry: LedgerEntry
}

/**
 * Sign a ledger entry. The signer fills `iss` with its DID, so the signature
 * covers every claim field — including `groupID` and `ord` — and binds the
 * author. `ord` is signed only when present, so a claim without it never signs
 * an `ord: undefined` key. Returns the stringified token.
 */
export async function signLedgerEntry({ identity, entry }: SignLedgerEntryParams): Promise<string> {
  const signed = await identity.signToken({
    payload: {
      type: entry.type,
      groupID: entry.groupID,
      subject: entry.subject,
      value: entry.value,
      ...(entry.ord === undefined ? {} : { ord: entry.ord }),
    },
    embedLongForm: true,
  })
  return stringifyToken(signed)
}

class ProviderFailure extends Error {}

const OBSERVED_PROVIDERS = new WeakMap<CryptoProvider, CryptoProvider>()

// `verifyToken` throws for a bad token and a failed provider alike, so mark the second. Stable per
// provider: Kokuin keys its verifier memo and call coalescing on this object.
function observedProvider(crypto: CryptoProvider): CryptoProvider {
  let observed = OBSERVED_PROVIDERS.get(crypto)
  if (observed == null) {
    observed = {
      ...crypto,
      verify: async (item) => {
        try {
          return await crypto.verify(item)
        } catch (cause) {
          throw new ProviderFailure('Crypto provider failed', { cause })
        }
      },
      verifyBatch: async (items) => {
        try {
          return await crypto.verifyBatch(items)
        } catch (cause) {
          throw new ProviderFailure('Crypto provider failed', { cause })
        }
      },
    }
    OBSERVED_PROVIDERS.set(crypto, observed)
  }
  return observed
}
export type VerifyLedgerEntryParams<_TValue = unknown> = {
  token: string
} & CryptoOptions

/**
 * Verify a signed ledger token and extract its claim. Returns `null` when the
 * token is unparseable, unsigned (`alg: 'none'` — `verifyToken`
 * returns those without checking a signature, so an attacker could forge an
 * arbitrary `iss`; `isVerifiedToken` rejects them), or structurally malformed.
 * A missing or non-string `groupID` is malformed, as is a missing or non-string
 * `type` or `subject`, or an `ord` present but not a string. The claim fields
 * come from the verified payload only; the issuer is the normalized verified
 * `iss`. A provider failure rejects with the provider's error: it says nothing
 * about the token, and a caller reading it as invalid would drop an authentic entry.
 */
export async function verifyLedgerEntry<TValue = unknown>({
  token,
  ...options
}: VerifyLedgerEntryParams<TValue>): Promise<VerifiedLedgerEntry<TValue> | null> {
  let verified: Awaited<ReturnType<typeof verifyToken<LedgerEntry<TValue>>>>
  try {
    verified = await verifyToken<LedgerEntry<TValue>>({
      ...options,
      crypto: observedProvider(options?.crypto ?? nobleCrypto),
      token: token,
    })
  } catch (error) {
    if (error instanceof ProviderFailure) throw error.cause
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
  const cached = LEDGER_ENTRY_DIGEST_CACHE.get(signedToken)
  if (cached != null) {
    LEDGER_ENTRY_DIGEST_CACHE.delete(signedToken)
    LEDGER_ENTRY_DIGEST_CACHE.set(signedToken, cached)
    return cached
  }
  const digest = encodeMultibase(multihashSHA256(textEncoder.encode(signedToken)))
  LEDGER_ENTRY_DIGEST_CACHE.set(signedToken, digest)
  if (LEDGER_ENTRY_DIGEST_CACHE.size > LEDGER_ENTRY_DIGEST_CACHE_SIZE) {
    const oldest = LEDGER_ENTRY_DIGEST_CACHE.keys().next().value
    if (oldest != null) LEDGER_ENTRY_DIGEST_CACHE.delete(oldest)
  }
  return digest
}
