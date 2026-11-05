import {
  bindEntryReadsAttempt,
  type EntryReads,
  entryReadsAttempt,
} from '../../src/entry-capability.js'

export function copyEntryReads(reads: EntryReads, overrides: Partial<EntryReads>): EntryReads {
  const copy = { ...reads, ...overrides }
  bindEntryReadsAttempt(copy, entryReadsAttempt(reads))
  return copy
}
