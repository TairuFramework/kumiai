import { describe, expect, test } from 'vitest'

export type ConformanceJournalEntry = {
  publishID: string
  expectedHead: string | null
  epoch: number
  acceptedAs?: string
  holdsLogSends?: true
  commit: Uint8Array
  bodies: Array<string>
  kind: 'ledger' | 'invite' | 'remove'
  journal: Uint8Array
}
export type ConformanceCommitJournal = {
  put(entry: ConformanceJournalEntry): Promise<void>
  get(): Promise<ConformanceJournalEntry | null>
  markAccepted(publishID: string, sequenceID: string): Promise<void>
  clear(publishID: string): Promise<void>
}

export type CommitJournalConformanceParams = {
  label: string
  createJournal(): ConformanceCommitJournal
}

export function testCommitJournalConformance(params: CommitJournalConformanceParams): void {
  describe(`CommitJournal conformance — ${params.label}`, () => {
    test('a flagged entry retains its hold through acceptance and unrelated clears', async () => {
      const journal = params.createJournal()
      const entry: ConformanceJournalEntry = {
        publishID: 'held-proof',
        expectedHead: null,
        epoch: 1,
        holdsLogSends: true,
        commit: new Uint8Array([1]),
        bodies: ['proof'],
        kind: 'ledger',
        journal: new Uint8Array([2]),
      }
      await journal.put(entry)
      expect(await journal.get()).toEqual(entry)
      await journal.markAccepted('other', 'wrong')
      await journal.clear('other')
      expect(await journal.get()).toEqual(entry)
      await journal.markAccepted(entry.publishID, 'accepted')
      expect(await journal.get()).toEqual({ ...entry, acceptedAs: 'accepted' })
      await journal.clear('other')
      expect((await journal.get())?.holdsLogSends).toBe(true)
      await journal.clear(entry.publishID)
      expect(await journal.get()).toBeNull()
      await journal.put({ ...entry, publishID: 'ordinary', holdsLogSends: undefined })
      expect((await journal.get())?.holdsLogSends).toBeUndefined()
    })
  })
}
