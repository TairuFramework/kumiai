import { describe, expect, test } from 'vitest'

import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'

// A freshly created 3-member group occupies dense slots 0,1,2; removing the
// middle member frees slot 1; the next add refills slot 1 (leftmost blank),
// NOT slot 3 — this is exactly what compaction gets wrong.
describe('memory double slot model', () => {
  test('remove frees a slot and the next add reuses it (ascending order preserved)', async () => {
    const g = createMemoryGroupMLS({ localDID: 'alice', members: ['alice', 'bob', 'carol'] })
    expect(g.leaves()).toEqual(['alice', 'bob', 'carol'])

    g.adopt(g.buildCommit([], { removes: ['bob'] }))
    expect(g.leaves()).toEqual(['alice', 'carol']) // hole at slot 1

    g.adopt(g.buildCommit([], { adds: ['dave'] }))
    // dave takes freed slot 1 -> ascending order is alice, dave, carol
    expect(g.leaves()).toEqual(['alice', 'dave', 'carol'])
  })
})
