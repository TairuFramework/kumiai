import { fromUTF, toUTF } from '@sozai/codec'

import type { GroupCrypto } from './crypto.js'

/**
 * The blob a commit frame carries: the signed control-ledger tokens the Commit enacts, sealed
 * with `GroupCrypto.sealEntries` under a key derived from the epoch the Commit is framed at (the
 * epoch every peer that can apply it holds). The hub sees only the sealed bytes, never a body.
 *
 *   [ VERSION(1) | count(2, LE) | (tokenLength(4, LE) | token utf8)... ]
 *
 * This module is the ONLY place a commit frame's blob is opened, via a resolver that runs only
 * when the MLS port asks for the bodies of a commit it is applying. Opening is a consequence
 * of "I can apply this frame", never a precondition of reading it.
 */

export const LEDGER_ENTRIES_VERSION = 1

const VERSION_BYTES = 1
const COUNT_BYTES = 2
const HEADER_BYTES = VERSION_BYTES + COUNT_BYTES
const LENGTH_BYTES = 4

export class LedgerEntryRefusedError extends Error {
  #reason: 'malformed' | 'authentication'

  constructor(
    message?: string,
    options?: ErrorOptions & { reason?: 'malformed' | 'authentication' },
  ) {
    super(message, options)
    this.name = 'LedgerEntryRefusedError'
    this.#reason = options?.reason ?? 'authentication'
  }

  get reason(): 'malformed' | 'authentication' {
    return this.#reason
  }
}

export class UnsupportedLedgerEntriesVersionError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'UnsupportedLedgerEntriesVersionError'
  }
}

/** Encode the signed tokens a Commit enacts, for sealing into its frame. */
export function encodeLedgerEntries(tokens: Array<string>): Uint8Array {
  const encoded = tokens.map((token) => fromUTF(token))
  const size = encoded.reduce((total, bytes) => total + LENGTH_BYTES + bytes.length, HEADER_BYTES)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  out[0] = LEDGER_ENTRIES_VERSION
  view.setUint16(VERSION_BYTES, encoded.length, true)
  let offset = HEADER_BYTES
  for (const bytes of encoded) {
    view.setUint32(offset, bytes.length, true)
    out.set(bytes, offset + LENGTH_BYTES)
    offset += LENGTH_BYTES + bytes.length
  }
  return out
}

/**
 * Decode the signed tokens sealed into a commit frame. Throws on bytes that are not a list, and
 * on a version this build does not know.
 */
export function decodeLedgerEntries(bytes: Uint8Array): Array<string> {
  if (bytes.length < HEADER_BYTES) {
    throw new Error('ledger entry blob is too short')
  }
  const version = bytes[0]
  if (version !== LEDGER_ENTRIES_VERSION) {
    throw new UnsupportedLedgerEntriesVersionError(
      `unsupported ledger entry blob version: ${version}`,
    )
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint16(VERSION_BYTES, true)
  const tokens: Array<string> = []
  let offset = HEADER_BYTES
  for (let i = 0; i < count; i++) {
    if (offset + LENGTH_BYTES > bytes.length) {
      throw new Error('ledger entry blob is truncated')
    }
    const length = view.getUint32(offset, true)
    const start = offset + LENGTH_BYTES
    if (start + length > bytes.length) {
      throw new Error('ledger entry blob is truncated')
    }
    tokens.push(toUTF(bytes.subarray(start, start + length)))
    offset = start + length
  }
  if (offset !== bytes.length) throw new Error('ledger entry blob has trailing bytes')
  return tokens
}

// Opening is pure: transport/storage failures must reach the walker without consuming a key.
export function createLedgerEntryResolver(
  sealedEntries: Uint8Array,
  openEntries: GroupCrypto['openEntries'],
): (ids: Array<string>) => Promise<Array<string>> {
  return async (_ids: Array<string>): Promise<Array<string>> => {
    let opened: Uint8Array
    try {
      opened = await openEntries(sealedEntries)
    } catch (error) {
      if (error instanceof LedgerEntryRefusedError) return []
      throw error
    }
    try {
      return decodeLedgerEntries(opened)
    } catch (error) {
      if (error instanceof UnsupportedLedgerEntriesVersionError) throw error
      return []
    }
  }
}
