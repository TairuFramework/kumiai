import { nobleCrypto } from '@kokuin/crypto'
import {
  commitLedgerEntries,
  ledgerEntryDigest,
  MissingLedgerEntriesError,
  restoreGroup,
  signLedgerEntry,
} from '@kumiai/mls'
import type * as SozaiAsync from '@sozai/async'
import { expect, test, vi } from 'vitest'

import { applyCommit } from '../src/apply-commit.js'
import { createRealGroup } from './fixtures/real-group.js'

const timers = vi.hoisted(() =>
  vi.fn((callback: () => void) => {
    setTimeout(callback, 0)
  }),
)
vi.mock('@sozai/async', async (importOriginal) => {
  const original = await importOriginal<typeof SozaiAsync>()
  return {
    ...original,
    maybeYield: original.createYielder({ budgetMs: 0, schedule: timers }).maybeYield,
  }
})

for (const policy of [{ yield: false }, {}, { yield: true }]) {
  test(`applyCommit yield=${policy.yield} preserves acceptance and resolver errors`, async () => {
    const f = await createRealGroup(1, 'yield-policy')
    const self = f.members[0]
    if (self == null) throw new Error('Missing recipient')
    const token = await signLedgerEntry({
      identity: f.committer.identity,
      entry: {
        type: 'app.note',
        groupID: self.handle.groupID,
        subject: self.identity.id,
        value: 'hello',
      },
    })
    f.bodies.set(ledgerEntryDigest(token), token)
    const built = await commitLedgerEntries({ group: f.committer.handle, tokens: [token] })
    const params = {
      commit: built.commitMessage,
      entrySlot: self.slot,
      ownDID: self.identity.id,
      senderDID: f.committer.identity.id,
      ...policy,
    }
    const handle = await restoreGroup({
      state: structuredClone(self.handle.state),
      credential: self.handle.credential,
      ledgerEntries: self.handle.ledgerTokens,
      options: { crypto: { ...nobleCrypto }, resolveLedgerEntries: self.slot.resolve },
    })
    const before = structuredClone(handle.state)
    timers.mockClear()
    await expect(
      applyCommit({
        ...params,
        handle: handle,
        resolveLedgerEntries: async () => ['invalid'],
      }),
    ).rejects.toBeInstanceOf(MissingLedgerEntriesError)
    expect(handle.state).toEqual(before)
    expect(timers.mock.calls.length > 0).toBe(policy.yield !== false)
    timers.mockClear()
    const result = await applyCommit({
      ...params,
      handle: handle,
      resolveLedgerEntries: f.resolveLedgerEntries,
    })
    expect(result).toMatchObject({
      applied: true,
      advanced: true,
      epochAfter: Number(built.epoch),
      surfacedEntries: [{ entry: { value: 'hello' } }],
    })
    expect(timers.mock.calls.length > 0).toBe(policy.yield !== false)
  })
}
