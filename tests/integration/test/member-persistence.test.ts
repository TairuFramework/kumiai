import {
  commitLedgerEntries,
  decodeClientState,
  encodeClientState,
  signLedgerEntry,
} from '@kumiai/mls'
import { asLogPosition } from '@kumiai/rpc'
import { expect, test } from 'vitest'

import { createRealGroup } from '../../../packages/mls-rpc/test/fixtures/real-group.js'
import { createMemoryStateStore } from './app-lane-e2e.js'
import { createMemberPersistence } from './member-persistence.js'

test('member restart state and control survive the same after-save interruption', async () => {
  const group = await createRealGroup(0, 'member-atomic-control')
  const { handle, identity } = group.committer
  const base = createMemoryStateStore({ groupID: handle.groupID, incarnation: 1 })
  const member = createMemberPersistence(base, handle)
  const store = member.stateStore
  await store.save(handle)
  const token = await signLedgerEntry(identity, {
    type: 'note',
    groupID: handle.groupID,
    subject: identity.id,
    value: 'atomic control',
  })
  const { newGroup } = await commitLedgerEntries(handle, [token])
  const outcome = {
    id: 'landed-op',
    opID: 'landed-op',
    kind: 'landed' as const,
    position: asLogPosition('01'),
    at: 1,
  }
  store.database.seam('after-save', () => {
    throw new Error('Interrupted after save')
  })
  await expect(
    store.save(newGroup, {
      mutationID: 'atomic-control',
      changes: { putOutcomes: [outcome], cursor: { position: outcome.position, epoch: 1 } },
    }),
  ).rejects.toThrow('Interrupted after save')
  expect((await store.control.load()).outcomes).toEqual([outcome])
  expect(await store.control.lastMutation()).toBe('atomic-control')
  expect((await store.control.load()).cursor?.epoch).toBe(1)
  const saved = await store.saved()
  expect(saved?.ledger).toEqual([token])
  expect(saved?.state).toEqual(encodeClientState(newGroup.state))
  expect(saved === null ? null : decodeClientState(saved.state)?.groupContext.epoch).toBe(1n)
  let restarted: ReturnType<typeof createMemberPersistence> | undefined
  expect(() => {
    restarted = createMemberPersistence(
      createMemoryStateStore(base.control.key, base.database),
      newGroup,
    )
  }).not.toThrow()
  expect(await restarted?.stateStore.saved()).toEqual(saved)
})

test('member restart state and publication attempt survive the same after-save interruption', async () => {
  const group = await createRealGroup(0, 'member-atomic-publication')
  const { handle } = group.committer
  const base = createMemoryStateStore({ groupID: handle.groupID, incarnation: 1 })
  const member = createMemberPersistence(base, handle)
  const store = member.stateStore
  await store.save(handle)
  const original = {
    seq: 1,
    protocol: 'chat',
    prc: 'chat/posted',
    data: new Uint8Array([1]),
    lastAttempt: null,
    status: 'accepted' as const,
  }
  await store.appOutbox.put(original)
  const expected = await store.readEvidence()
  if (expected.source.identity === null) throw new Error('Missing publication identity')
  await handle.encrypt(new Uint8Array([1]))
  const entry = {
    ...original,
    lastAttempt: {
      incarnation: 1,
      epoch: 0,
      floor: null,
      attempts: 1,
      publishID: 'atomic-publication',
      segment: 0,
      topicID: 'app-topic',
    },
  }
  store.database.seam('after-save', () => {
    throw new Error('Interrupted after save')
  })
  await expect(
    store.prepareApp(original, entry, handle, {
      identity: expected.source.identity,
      stateVersion: expected.source.stateVersion,
      attemptID: 'atomic-publication',
    }),
  ).rejects.toThrow('Interrupted after save')
  expect(await store.appOutbox.list()).toEqual([entry])
  expect((await store.saved())?.state).toEqual(encodeClientState(handle.state))
})
