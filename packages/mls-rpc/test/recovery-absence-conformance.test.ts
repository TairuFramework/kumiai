import { verifyRecoveryRequest } from '@kumiai/mls'
import { testRosterAbsenceConformance } from '@kumiai/rpc-conformance'
import { expect, test } from 'vitest'

import { createGroupMLS } from '../src/mls.js'
import { createRosterAbsenceRealFixture } from './fixtures/captured-recovery.js'
import {
  createRealGroup,
  testGroupMLSDependencies,
  testHandleAccess,
} from './fixtures/real-group.js'

test('ordinary handle request preserves its signed comparison lower bound', async () => {
  const real = await createRealGroup(0, `request-span-${crypto.randomUUID()}`)
  const member = real.committer
  const access = testHandleAccess({
    handle: () => member.handle,
    adopt: (next) => {
      member.handle = next
    },
  })
  const mls = createGroupMLS({
    ...testGroupMLSDependencies(access),
    access,
    identity: member.identity,
    entrySlot: member.slot,
  })
  const held = await mls.createRecoveryRequest('ordinary-span', undefined, 0)
  expect(
    (await verifyRecoveryRequest(new TextDecoder().decode(held.request))).comparisonEpoch,
  ).toBe(0)
})

for (const transactional of [false, true]) {
  for (const ownership of ['supplied', 'absent'] as const) {
    testRosterAbsenceConformance({
      label: `real-mls, ${transactional ? 'transactional' : 'ordinary'}, ${ownership} ownership context`,
      createFixture: (scenario) =>
        createRosterAbsenceRealFixture(scenario, transactional, ownership),
    })
  }
}
