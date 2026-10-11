import { expect, test } from 'vitest'

import {
  createLedgerEntryResolver,
  decodeLedgerEntries,
  encodeLedgerEntries,
} from '../src/ledger-entries.js'

test('transient body resolver faults remain diagnostic', async () => {
  const fault = new Error('host unavailable')
  const resolve = createLedgerEntryResolver(new Uint8Array([1]), async () => {
    throw fault
  })
  await expect(resolve(['entry'])).rejects.toBe(fault)
})

test('malformed body lists are conclusive refusal', async () => {
  const resolve = createLedgerEntryResolver(new Uint8Array([1]), async () => new Uint8Array([1]))
  await expect(resolve(['entry'])).resolves.toEqual([])
})

test('ledger entry lists roundtrip and reject trailing bytes', () => {
  const encoded = encodeLedgerEntries(['one', 'two'])
  expect(decodeLedgerEntries(encoded)).toEqual(['one', 'two'])
  expect(() => decodeLedgerEntries(new Uint8Array([...encoded, 1]))).toThrow()
})
