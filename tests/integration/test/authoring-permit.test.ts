import { randomIdentity } from '@kokuin/token'
import { commitKeyRotation, createGroup } from '@kumiai/mls'
import { createLedgerEntrySlot } from '@kumiai/mls-rpc'
import { digestAppliedCommit } from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import { customOperation, encodeJournal, makeMember } from './app-lane-e2e.js'
import { createWireHub } from './log-hub-over-wire.js'

test('an off-permit host commit is rejected before mux publication', async () => {
  const identity = randomIdentity()
  const { group } = await createGroup(identity, 'off-permit-publication')
  const cached = await commitKeyRotation(group)
  const hub = createWireHub()
  const connect = hub.connect.bind(hub)
  const publish = vi.fn()
  vi.spyOn(hub, 'connect').mockImplementation((...args) => {
    const connection = connect(...args)
    const original = connection.publish.bind(connection)
    connection.publish = async (message) => {
      publish(message)
      return original(message)
    }
    return connection
  })
  const member = makeMember({ hub, identity, group, entrySlot: createLedgerEntrySlot() })
  try {
    await member.peer.resync()
    publish.mockClear()
    const request = customOperation(member, async () => ({
      commit: cached.commitMessage,
      journal: encodeJournal(cached.newGroup),
      bodies: [],
      welcome: null,
      epoch: Number(group.epoch),
      incarnation: 1,
      authenticatorBefore: group.state.keySchedule.epochAuthenticator.slice(),
      digest: digestAppliedCommit(cached.commitMessage),
    }))
    await expect(member.peer.commit(request)).rejects.toMatchObject({
      name: 'OperationOutcomeError',
      outcome: { kind: 'rejected', reason: 'commit not built under the control-build permit' },
    })
    expect(publish).not.toHaveBeenCalled()
    const saved = await member.control.load()
    expect(saved.commitOnce).toBeNull()
    expect(saved.welcomes).toEqual([])
    await member.peer.commit(
      customOperation(member, async (_op, permitted) => {
        const actual = await commitKeyRotation(permitted)
        return {
          commit: actual.commitMessage,
          journal: encodeJournal(actual.newGroup),
          bodies: [],
          welcome: null,
          epoch: Number(permitted.epoch),
          incarnation: 1,
          authenticatorBefore: permitted.state.keySchedule.epochAuthenticator.slice(),
          digest: digestAppliedCommit(actual.commitMessage),
        }
      }),
    )
    expect(publish).toHaveBeenCalled()
    expect(member.handle().epoch).toBe(group.epoch + 1n)
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
    member.disconnect()
    hub.dispose()
  }
})
