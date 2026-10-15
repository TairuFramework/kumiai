import { expect, test } from 'vitest'

import {
  createLedgerEntryResolver,
  decodeLedgerEntries,
  encodeLedgerEntries,
  UnsupportedLedgerEntriesVersionError,
} from '../src/ledger-entries.js'

test('transient body resolver faults remain diagnostic', async () => {
  const fault = new Error('host unavailable')
  const resolve = createLedgerEntryResolver(new Uint8Array([1]), async () => {
    throw fault
  })
  await expect(resolve(['entry'])).rejects.toBe(fault)
})

test('no-entry commits ignore even unsupported nonempty blobs', async () => {
  const resolve = createLedgerEntryResolver(new Uint8Array([99]), async () => {
    throw new UnsupportedLedgerEntriesVersionError('unused blob')
  })
  await expect(resolve([])).resolves.toEqual([])
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

test('unsupported inner versions propagate as typed diagnostics even without a known-format header', async () => {
  const future = new Uint8Array([2])
  const resolve = createLedgerEntryResolver(future, async (sealed) => sealed)
  await expect(resolve(['entry'])).rejects.toBeInstanceOf(UnsupportedLedgerEntriesVersionError)
})

test('unsupported outer versions preserve the exact typed diagnostic', async () => {
  const fault = new UnsupportedLedgerEntriesVersionError('future sealed entries')
  const resolve = createLedgerEntryResolver(new Uint8Array([2]), async () => {
    throw fault
  })
  await expect(resolve(['entry'])).rejects.toBe(fault)
})
