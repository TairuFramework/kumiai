import { randomIdentity } from '@kokuin/token'
import { expect, test, vi } from 'vitest'

import { GROUP_ANCHOR_EXTENSION_TYPE } from '../src/anchor.js'
import { createGroup, GroupHandle, restoreGroup } from '../src/group.js'

test('restoration marks deterministic constructor refusal with its cause', async () => {
  const { group, credential } = await createGroup(randomIdentity(), 'restore-refusal')
  const state = {
    ...group.state,
    groupContext: {
      ...group.state.groupContext,
      extensions: group.state.groupContext.extensions.filter(
        (extension) => extension.extensionType !== GROUP_ANCHOR_EXTENSION_TYPE,
      ),
    },
  }
  await expect(restoreGroup({ state, credential })).rejects.toMatchObject({
    name: 'GroupRestoreError',
    cause: expect.any(Error),
  })
})

test('restoration preserves provider construction error identity', async () => {
  const { group, credential } = await createGroup(randomIdentity(), 'restore-provider')
  const error = new TypeError('Provider context unavailable')
  await expect(
    restoreGroup({
      state: group.state,
      credential,
      options: {
        cryptoProvider: {
          getCiphersuiteImpl: async () => {
            throw error
          },
        },
      },
    }),
  ).rejects.toBe(error)
})

test('restoration marks deterministic saved ledger refusal with its cause', async () => {
  const { group, credential } = await createGroup(randomIdentity(), 'restore-ledger-refusal')
  const error = new TypeError('Invalid saved ledger')
  const apply = vi.spyOn(GroupHandle.prototype, 'applyLedgerEntries').mockRejectedValueOnce(error)
  try {
    await expect(restoreGroup({ state: group.state, credential })).rejects.toMatchObject({
      name: 'GroupRestoreError',
      cause: error,
    })
  } finally {
    apply.mockRestore()
  }
})
