import { describe, expect, test } from 'vitest'

import {
  COMMIT_FRAME_VERSION,
  decodeCommitFrame,
  encodeCommitFrame,
  isUnsupportedCommitFrameVersion,
  UnsupportedCommitFrameVersionError,
} from '../src/commit-frame.js'
import {
  createLedgerEntryResolver,
  decodeLedgerEntries,
  encodeLedgerEntries,
  LEDGER_ENTRIES_VERSION,
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

  test('leads with the version byte', () => {
    const frame = encodeCommitFrame(Uint8Array.from([1]), new Uint8Array())
    expect(frame[0]).toBe(COMMIT_FRAME_VERSION)
  })

  test('a version this build does not know is refused, and NAMED', () => {
    // The failure this byte exists to stop, and it is worse than any other in this file: without
    // it a later frame carrying a third section decodes here SUCCESSFULLY, the new section
    // silently swallowed into `sealedEntries`. The assertion is the named refusal, never
    // falsiness — a decoder that merely returned nothing would be indistinguishable from an
    // empty frame.
    const frame = encodeCommitFrame(Uint8Array.from([1, 2]), Uint8Array.from([3]))
    frame[0] = COMMIT_FRAME_VERSION + 1
    expect(() => decodeCommitFrame(frame)).toThrow(UnsupportedCommitFrameVersionError)
    expect(() => decodeCommitFrame(frame)).toThrow(/unsupported commit frame version: 2/)
  })

  test('an unknown version is DISTINGUISHABLE from bytes that are not a frame', () => {
    // The lane branches on this: an unknown version heals (the group moved to a format this build
    // cannot read), while "not a frame" is dropped. Proving only that both throw — which is all
    // this file did while the lane dropped both — is how that distinction went missing for a
    // whole release. `peer-unknown-commit-frame-version.test.ts` proves the lane end of it.
    const unknownVersion = encodeCommitFrame(Uint8Array.from([1, 2]), new Uint8Array())
    unknownVersion[0] = COMMIT_FRAME_VERSION + 1
    expect(isUnsupportedCommitFrameVersion(caught(unknownVersion))).toBe(true)

    // Too short to hold the header, and a commit length running past the end: genuinely not a
    // frame, and nothing a future build would have written.
    expect(
      isUnsupportedCommitFrameVersion(caught(Uint8Array.from([COMMIT_FRAME_VERSION, 0]))),
    ).toBe(false)
    const truncated = encodeCommitFrame(Uint8Array.from([1, 2, 3, 4]), new Uint8Array()).subarray(
      0,
      6,
    )
    expect(isUnsupportedCommitFrameVersion(caught(truncated))).toBe(false)
  })
})

/** The error `decodeCommitFrame` threw, so the predicate can be asked about it. */
function caught(frame: Uint8Array): unknown {
  try {
    decodeCommitFrame(frame)
  } catch (error) {
    return error
  }
  throw new Error('decodeCommitFrame accepted bytes the test expected it to refuse')
}

describe('the sealed ledger-entry blob', () => {
  test('round-trips the signed tokens a commit enacts', () => {
    const tokens = ['token-one', 'token-two-🔑']
    expect(decodeLedgerEntries(encodeLedgerEntries(tokens))).toEqual(tokens)
    expect(decodeLedgerEntries(encodeLedgerEntries([]))).toEqual([])
  })

  test('leads with the version byte', () => {
    expect(encodeLedgerEntries(['a-token'])[0]).toBe(LEDGER_ENTRIES_VERSION)
  })

  test('a version this build does not know is refused, and NAMED', () => {
    // Unversioned, this blob degraded tolerably only by accident — the resolver's `catch` turned
    // a mis-parse into poison. An accident is not a contract, and a named error is the whole
    // value here: diagnosis, not compatibility.
    const blob = encodeLedgerEntries(['a-token'])
    blob[0] = LEDGER_ENTRIES_VERSION + 1
    expect(() => decodeLedgerEntries(blob)).toThrow(/unsupported ledger entry blob version: 2/)
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
