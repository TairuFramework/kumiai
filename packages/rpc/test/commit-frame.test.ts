import { describe, expect, test } from 'vitest'

import { decodeCommitFrame, encodeCommitFrame } from '../src/commit-frame.js'
import {
  createLedgerEntryResolver,
  decodeLedgerEntries,
  encodeLedgerEntries,
} from '../src/ledger-entries.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'

describe('the commit frame', () => {
  test('carries the commit and the sealed bodies, and splits them back apart', () => {
    const commit = Uint8Array.from([1, 2, 3, 4, 5])
    const sealed = Uint8Array.from([9, 9, 9])
    const frame = decodeCommitFrame(encodeCommitFrame(commit, sealed))
    expect(Array.from(frame.commit)).toEqual([1, 2, 3, 4, 5])
    expect(Array.from(frame.sealedEntries)).toEqual([9, 9, 9])
  })

  test('the commit half is read from a frame whose blob is bytes nobody can open', () => {
    // The load-bearing property: the peer that cannot open the blob is not the peer that
    // cannot read the commit. Every peer walking the log meets frames like this one.
    const commit = Uint8Array.from([7, 7])
    const unopenable = Uint8Array.from([0xde, 0xad, 0xbe, 0xef])
    const frame = decodeCommitFrame(encodeCommitFrame(commit, unopenable))
    expect(Array.from(frame.commit)).toEqual([7, 7])
  })

  test('a commit with no bodies still frames, with an empty blob', () => {
    const frame = decodeCommitFrame(encodeCommitFrame(Uint8Array.from([1]), new Uint8Array()))
    expect(frame.sealedEntries).toHaveLength(0)
  })

  test('bytes that are not a frame are rejected', () => {
    expect(() => decodeCommitFrame(Uint8Array.from([1, 2]))).toThrow(/too short/)
    // A length that runs past the end: truncated, not a frame.
    const truncated = encodeCommitFrame(Uint8Array.from([1, 2, 3, 4]), new Uint8Array()).subarray(
      0,
      6,
    )
    expect(() => decodeCommitFrame(truncated)).toThrow(/truncated/)
  })
})

describe('the sealed ledger-entry blob', () => {
  test('round-trips the signed tokens a commit enacts', () => {
    const tokens = ['token-one', 'token-two-🔑']
    expect(decodeLedgerEntries(encodeLedgerEntries(tokens))).toEqual(tokens)
    expect(decodeLedgerEntries(encodeLedgerEntries([]))).toEqual([])
  })

  test('the resolver serves the bodies sealed into the frame being applied', async () => {
    const crypto = createFakeCrypto({ epoch: 3, localDID: 'alice' })
    const sealed = await crypto.sealEntries(encodeLedgerEntries(['a-token']))
    const resolve = createLedgerEntryResolver(sealed, crypto.openEntries)
    expect(await resolve(['some-id'])).toEqual(['a-token'])
  })

  test('the resolver may be called twice and answers the same both times', async () => {
    // The property the derived key buys, and the reason the blob is not an application message:
    // the MLS port calls this from inside the apply of the commit that carries it, so an open
    // that consumed a ratchet generation would be unsound however it was scheduled.
    const crypto = createFakeCrypto({ epoch: 3, localDID: 'alice' })
    const sealed = await crypto.sealEntries(encodeLedgerEntries(['a-token']))
    const resolve = createLedgerEntryResolver(sealed, crypto.openEntries)
    expect(await resolve(['some-id'])).toEqual(['a-token'])
    expect(await resolve(['some-id'])).toEqual(['a-token'])
  })

  test('a blob this member cannot open yields no entries, and no error', async () => {
    const admin = createFakeCrypto({ epoch: 3, localDID: 'alice' })
    const sealed = await admin.sealEntries(encodeLedgerEntries(['a-token']))
    // A member at another epoch derives a different key. The frame is history it cannot open,
    // not corruption: it answers with nothing rather than raising.
    const behind = createFakeCrypto({ epoch: 1, localDID: 'dave' })
    const resolve = createLedgerEntryResolver(sealed, behind.openEntries)
    expect(await resolve(['some-id'])).toEqual([])
  })
})
