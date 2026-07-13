import { createIdentity, createUnsignedToken, normalizeDID, stringifyToken } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import {
  type LedgerEntry,
  ledgerEntryDigest,
  signLedgerEntry,
  type VerifiedLedgerEntry,
  verifyLedgerEntry,
} from '../src/ledger.js'

function createSigner() {
  return createIdentity({ keys: [{ purpose: 'sig', alg: 'EdDSA' }], didMethod: 'key' })
}

/**
 * A three-line stand-in for the fold's group filter: keep only the entries whose
 * `groupID` matches the group being folded. `@kumiai/mls` does not ship the fold
 * here — this local helper is only present to exercise the property `groupID`
 * enables.
 */
function keepForGroup<TValue>(
  entries: Array<VerifiedLedgerEntry<TValue>>,
  groupID: string,
): Array<VerifiedLedgerEntry<TValue>> {
  return entries.filter((verified) => verified.entry.groupID === groupID)
}

describe('signLedgerEntry / verifyLedgerEntry', () => {
  test('round trip: verify recovers issuer and the full entry, without ord', async () => {
    const signer = await createSigner()
    const entry: LedgerEntry<string> = {
      type: 'group.role',
      groupID: 'A',
      subject: 'did:example:subject',
      value: 'admin',
    }

    const token = await signLedgerEntry(signer, entry)
    const verified = await verifyLedgerEntry<string>(token)

    expect(verified).not.toBeNull()
    expect(verified?.issuer).toBe(normalizeDID(signer.id))
    expect(verified?.entry).toEqual(entry)
    // `ord` was never signed, so it must not appear on the recovered entry.
    expect(verified?.entry).not.toHaveProperty('ord')
  })

  test('round trip: an entry carrying ord recovers ord too', async () => {
    const signer = await createSigner()
    const entry: LedgerEntry<{ level: number }> = {
      type: 'group.role',
      groupID: 'A',
      subject: 'did:example:subject',
      value: { level: 2 },
      ord: '2026-07-10T00:00:00Z:0001',
    }

    const token = await signLedgerEntry(signer, entry)
    const verified = await verifyLedgerEntry<{ level: number }>(token)

    expect(verified).not.toBeNull()
    expect(verified?.issuer).toBe(normalizeDID(signer.id))
    expect(verified?.entry).toEqual(entry)
    expect(verified?.entry.ord).toBe('2026-07-10T00:00:00Z:0001')
  })

  test('the replay drop: a group-A entry is dropped when folding group B, kept for A', async () => {
    const mallory = await createSigner()
    // A well-formed, correctly signed grant of admin in group A.
    const entry: LedgerEntry<string> = {
      type: 'group.role',
      groupID: 'A',
      subject: 'did:mallory',
      value: 'admin',
    }

    const token = await signLedgerEntry(mallory, entry)

    // It parses fine in both groups — verification is not the defence.
    const verifiedForA = await verifyLedgerEntry<string>(token)
    const verifiedForB = await verifyLedgerEntry<string>(token)
    expect(verifiedForA).not.toBeNull()
    expect(verifiedForB).not.toBeNull()
    if (verifiedForA == null || verifiedForB == null) throw new Error('expected verified entries')

    // Content-addressing is no defence: identical bytes replayed into group B
    // carry the identical id. The digest cannot tell A's grant from B's replay.
    expect(ledgerEntryDigest(token)).toBe(ledgerEntryDigest(token))

    // The signed `groupID` is what lets the fold drop the replay: folding group B
    // discards the entry, folding group A keeps it.
    expect(keepForGroup([verifiedForB], 'B')).toHaveLength(0)
    expect(keepForGroup([verifiedForA], 'A')).toEqual([verifiedForA])
  })

  test('returns null, never throws, on a non-token string', async () => {
    await expect(verifyLedgerEntry('not-a-token')).resolves.toBeNull()
  })

  test('returns null, never throws, on an alg:none forged token', async () => {
    // An unsigned token lets an attacker place an arbitrary `iss`; the signature
    // was never checked. It must never verify.
    const forged = stringifyToken(
      createUnsignedToken({
        iss: 'did:example:mallory',
        type: 'group.role',
        groupID: 'A',
        subject: 'did:mallory',
        value: 'admin',
      }),
    )
    // The stringified unsigned token has two segments, so it is rejected at the
    // JWT format check before the header is even read.
    await expect(verifyLedgerEntry(forged)).resolves.toBeNull()

    // A well-formed three-segment alg:none token (a trailing signature segment
    // appended) does reach the header: `verifyToken` returns it without checking
    // a signature, and `isVerifiedToken` is the guard that then rejects it.
    const wellFormedAlgNone = `${forged}.QQ`
    await expect(verifyLedgerEntry(wellFormedAlgNone)).resolves.toBeNull()
  })

  test('returns null on a signed token whose payload omits groupID', async () => {
    const signer = await createSigner()
    const signed = await signer.signToken(
      { type: 'group.role', subject: 'did:example:subject', value: 'admin' },
      { embedLongForm: true },
    )
    await expect(verifyLedgerEntry(stringifyToken(signed))).resolves.toBeNull()
  })

  test('returns null on a signed token whose groupID is not a string', async () => {
    const signer = await createSigner()
    const signed = await signer.signToken(
      { type: 'group.role', groupID: 123, subject: 'did:example:subject', value: 'admin' },
      { embedLongForm: true },
    )
    await expect(verifyLedgerEntry(stringifyToken(signed))).resolves.toBeNull()
  })

  test('returns null on a signed token whose type is missing', async () => {
    const signer = await createSigner()
    const signed = await signer.signToken(
      { groupID: 'A', subject: 'did:example:subject', value: 'admin' },
      { embedLongForm: true },
    )
    await expect(verifyLedgerEntry(stringifyToken(signed))).resolves.toBeNull()
  })

  test('returns null on a signed token whose ord is not a string', async () => {
    const signer = await createSigner()
    const signed = await signer.signToken(
      { type: 'group.role', groupID: 'A', subject: 'did:example:subject', value: 'admin', ord: 7 },
      { embedLongForm: true },
    )
    await expect(verifyLedgerEntry(stringifyToken(signed))).resolves.toBeNull()
  })

  test('tamper: flipping one byte of the token makes verification return null', async () => {
    const signer = await createSigner()
    const token = await signLedgerEntry(signer, {
      type: 'group.role',
      groupID: 'A',
      subject: 'did:example:subject',
      value: 'admin',
    })

    // Flip a character inside the signature segment (the third JWT part), but
    // NOT its last one: an Ed25519 signature is 64 bytes = 512 bits, which
    // base64url encodes in 86 characters = 516 bits, so the final character
    // carries 4 padding bits. A flip landing only in the padding decodes to the
    // identical signature bytes and verification legitimately succeeds. Every
    // other character carries 6 significant bits.
    const signatureStart = token.lastIndexOf('.') + 1
    const original = token[signatureStart]
    const flipped = `${token.slice(0, signatureStart)}${original === 'A' ? 'B' : 'A'}${token.slice(signatureStart + 1)}`
    expect(flipped).not.toBe(token)

    await expect(verifyLedgerEntry(flipped)).resolves.toBeNull()
  })
})

describe('ledgerEntryDigest', () => {
  test('is deterministic for the same token string', async () => {
    const signer = await createSigner()
    const token = await signLedgerEntry(signer, {
      type: 'group.role',
      groupID: 'A',
      subject: 'did:example:subject',
      value: 'admin',
    })
    expect(ledgerEntryDigest(token)).toBe(ledgerEntryDigest(token))
  })

  test('differs for two different tokens', async () => {
    const signer = await createSigner()
    const tokenA = await signLedgerEntry(signer, {
      type: 'group.role',
      groupID: 'A',
      subject: 'did:example:subject',
      value: 'admin',
    })
    const tokenB = await signLedgerEntry(signer, {
      type: 'group.role',
      groupID: 'B',
      subject: 'did:example:subject',
      value: 'admin',
    })
    expect(ledgerEntryDigest(tokenA)).not.toBe(ledgerEntryDigest(tokenB))
  })
})
