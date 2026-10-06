import { testCommitJournalConformance } from '@kumiai/rpc-conformance'

import { createMemoryCommitJournal } from './fixtures/journal.js'

testCommitJournalConformance({
  label: 'rpc host journal',
  createJournal: createMemoryCommitJournal,
})
