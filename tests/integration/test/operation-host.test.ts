import { randomIdentity } from '@kokuin/token'
import { commitLedgerEntries, createGroup, signLedgerEntry } from '@kumiai/mls'
import { simpleHandleAccess } from '@kumiai/mls-rpc'
import { expect, test } from 'vitest'

import { createOperationHost, encodeJournal } from './app-lane-e2e.js'

test('standalone operation adoption co-commits the anchor landed mark with control', async () => {
  const identity = randomIdentity()
  let current = (await createGroup(identity, 'standalone-operation-host')).group
  const access = simpleHandleAccess({
    handle: () => current,
    adopt: (next) => {
      current = next
    },
  })
  const host = createOperationHost(access)
  const token = await signLedgerEntry(identity, {
    groupID: current.groupID,
    type: 'note',
    subject: identity.id,
    value: 'atomic',
  })
  const next = (await commitLedgerEntries(current, [token])).newGroup
  const epochBefore = Number(current.epoch)
  const expected = {
    epoch: epochBefore,
    authenticatorBefore: current.state.keySchedule.epochAuthenticator.slice(),
    lineage: 0,
  }
  await host.anchorStore.save({
    anchor: { epoch: epochBefore, secret: new Uint8Array(32).fill(1) },
    pending: {
      epochBefore,
      epochAfter: Number(next.epoch),
      rosterBefore: [identity.id],
      forced: false,
      advance: 'own-commit',
    },
  })
  await expect(
    host.adopt(encodeJournal(next), expected, {
      mutationID: 'adoption-mutation',
      anchorLanded: 'own-commit',
      changes: { putOutcomes: [{ id: 'own-op', opID: 'own-op', kind: 'unknown', at: 1 }] },
    }),
  ).resolves.toBe('installed')
  expect(await host.control.lastMutation()).toBe('adoption-mutation')
  expect((await host.anchorStore.load())?.pending?.landed).toBe(true)
  expect((await host.control.load()).outcomes).toEqual([
    { id: 'own-op', opID: 'own-op', kind: 'unknown', at: 1 },
  ])
  expect(current.epoch).toBe(next.epoch)
})
