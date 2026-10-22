import { decodeClientState } from '@kumiai/mls'
import { testCommitOnceConformance } from '@kumiai/rpc-conformance'
import { expect, test } from 'vitest'

import { testControlCrashBoundaries } from './fixtures/control-crash.js'
import {
  createControlCrashHarness,
  runControlProofConflict,
} from './fixtures/storage-persistence.js'

for (const mode of ['double', 'real-mls'] as const) {
  testControlCrashBoundaries(mode)
  testCommitOnceConformance({
    label: `sealed provider: ${mode}`,
    scenarios: ['ownership-conflict'],
    run: () => runControlProofConflict(mode),
  })
}

test('double control builds and reconstructs independent memory MLS state', async () => {
  const h = await createControlCrashHarness('double')
  try {
    const stored = await h.groups.loadState(h.key)
    if (stored === null || stored.deleted || stored.state === null) throw new Error('Missing state')
    const state = decodeClientState(stored.state)
    if (state === undefined) throw new Error('Invalid state')
    expect(new TextDecoder().decode(state.confirmationTag)).toMatch(/^\{"epoch":3,"slots":/)
    const built = await h.build()
    const { decodeControlJournal } = await import('../src/control-journal.js')
    const candidate = decodeClientState(decodeControlJournal(built.slot.journal).candidate)
    if (candidate === undefined) throw new Error('Invalid candidate')
    expect(JSON.parse(new TextDecoder().decode(candidate.confirmationTag))).toMatchObject({
      epoch: 4,
    })
    await h.saveBuilt(built.intent, built.slot, built.expected, 'built')
    const reopened = await h.reopen()
    expect((await reopened.control.load()).commitOnce).toEqual(built.slot)
  } finally {
    await h.fixture.close()
  }
})
