import { randomIdentity } from '@kokuin/token'
import { makeCustomExtension } from 'ts-mls'
import { describe, expect, test } from 'vitest'

import { controlCapabilities, LEDGER_HEAD_EXTENSION_TYPE } from '../src/anchor.js'
import { createGroup } from '../src/group.js'
import {
  assertHeadMatches,
  buildLedgerHeadExtension,
  computeHead,
  decodeLedgerHead,
  encodeLedgerHead,
  extendHead,
  genesisHead,
  LEDGER_HEAD_VERSION,
  type LedgerHead,
  LedgerIncompleteError,
  readLedgerHead,
  readLedgerHeadExtension,
} from '../src/head.js'

describe('ledger head chain', () => {
  test('genesis is pure and group-scoped', () => {
    // Deterministic across calls for the same group id.
    expect(genesisHead('g')).toEqual(genesisHead('g'))
    // A 32-byte SHA-256 digest.
    expect(genesisHead('g')).toBeInstanceOf(Uint8Array)
    expect(genesisHead('g').length).toBe(32)
    // Different group ids never share a genesis.
    expect(genesisHead('g')).not.toEqual(genesisHead('h'))
  })

  test('extend is order-sensitive', () => {
    const h = genesisHead('g')
    expect(extendHead(h, ['a', 'b'])).not.toEqual(extendHead(h, ['b', 'a']))
  })

  test('extend is length-framed so a boundary shift cannot collide', () => {
    // ["ab","c"] and ["a","bc"] carry the same concatenated characters; only the
    // per-id length framing keeps them apart.
    expect(computeHead('g', ['ab', 'c'])).not.toEqual(computeHead('g', ['a', 'bc']))
  })

  test('a joiner reproduces the chain by folding batch-by-batch', () => {
    const ids = ['id-a', 'id-b', 'id-c']
    // One shot from genesis.
    const full = computeHead('g', ids)
    // Fold the same ids one batch at a time, starting from genesis.
    const genesis = genesisHead('g')
    const folded = extendHead(extendHead(genesis, ['id-a', 'id-b']), ['id-c'])
    expect(folded).toEqual(full)
    // And extending id-by-id reaches the same head.
    const stepwise = ids.reduce((acc, id) => extendHead(acc, [id]), genesis)
    expect(stepwise).toEqual(full)
  })

  test('omission breaks the recomputation at any position', () => {
    const ids = ['first', 'middle', 'last']
    const full = computeHead('g', ids)
    // Drop first, middle, last in turn.
    expect(computeHead('g', ['middle', 'last'])).not.toEqual(full)
    expect(computeHead('g', ['first', 'last'])).not.toEqual(full)
    expect(computeHead('g', ['first', 'middle'])).not.toEqual(full)
  })

  test('an empty batch is a no-op', () => {
    const h = extendHead(genesisHead('g'), ['x', 'y'])
    expect(extendHead(h, [])).toEqual(h)
  })

  test('encode/decode round trips in binary form', () => {
    const head = computeHead('g', ['a', 'b'])
    const bytes = encodeLedgerHead(head)
    // One version byte + 32 digest bytes.
    expect(bytes.length).toBe(33)
    expect(bytes[0]).toBe(LEDGER_HEAD_VERSION)

    const decoded = decodeLedgerHead(bytes)
    expect(decoded).not.toBeNull()
    expect(decoded?.v).toBe(LEDGER_HEAD_VERSION)
    expect(decoded?.head).toEqual(head)
  })

  test('decodeLedgerHead returns null (never throws) on wrong length or unknown version', () => {
    // Too short.
    expect(decodeLedgerHead(new Uint8Array([LEDGER_HEAD_VERSION, 0, 0]))).toBeNull()
    // Too long.
    expect(decodeLedgerHead(new Uint8Array(34))).toBeNull()
    // Empty.
    expect(decodeLedgerHead(new Uint8Array(0))).toBeNull()
    // Right length, unknown version byte.
    const wrongVersion = new Uint8Array(33)
    wrongVersion[0] = 0xff
    expect(decodeLedgerHead(wrongVersion)).toBeNull()
  })

  test('readLedgerHead reads a head off a real group', async () => {
    const alice = randomIdentity()
    const head = computeHead('scoped', ['e1', 'e2'])

    const { group } = await createGroup(alice, 'scoped', {
      extensions: [buildLedgerHeadExtension(head)],
      capabilities: controlCapabilities(),
    })

    const read: LedgerHead | null = readLedgerHead(group)
    expect(read).not.toBeNull()
    expect(read?.v).toBe(LEDGER_HEAD_VERSION)
    expect(read?.head).toEqual(head)

    // The raw extension is available for verbatim byte copying.
    const extension = readLedgerHeadExtension(group)
    expect(extension?.extensionType).toBe(LEDGER_HEAD_EXTENSION_TYPE)
    expect(extension?.extensionData).toEqual(encodeLedgerHead(head))
  })

  test('createGroup auto-seeds the ledger head at genesis', async () => {
    const alice = randomIdentity()
    const { group } = await createGroup(alice, 'plain')
    const read = readLedgerHead(group)
    expect(read?.head).toEqual(genesisHead('plain'))
    expect(readLedgerHeadExtension(group)).not.toBeNull()
  })

  test('readLedgerHead throws when the head extension is present but undecodable', async () => {
    const alice = randomIdentity()
    const corrupt = makeCustomExtension({
      extensionType: LEDGER_HEAD_EXTENSION_TYPE,
      extensionData: new Uint8Array([0xff, 0xff]),
    })
    const { group } = await createGroup(alice, 'corrupt', {
      extensions: [corrupt],
      capabilities: controlCapabilities(),
    })
    expect(() => readLedgerHead(group)).toThrow()
    // Corruption is not absence: the raw extension is still readable.
    expect(readLedgerHeadExtension(group)).not.toBeNull()
  })

  test('assertHeadMatches returns for equal heads and throws for unequal', () => {
    const head = computeHead('g', ['a', 'b'])
    // A distinct 32-byte value.
    const other = computeHead('g', ['a', 'c'])
    expect(() => assertHeadMatches(head, computeHead('g', ['a', 'b']))).not.toThrow()

    let caught: unknown
    try {
      assertHeadMatches(head, other)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(LedgerIncompleteError)
    const error = caught as LedgerIncompleteError
    expect(error.expected).toEqual(head)
    expect(error.actual).toEqual(other)
  })
})
