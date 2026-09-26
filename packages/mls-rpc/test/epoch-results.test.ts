import { expect, test } from 'vitest'

import { simpleHandleAccess } from '../src/access.js'
import { createGroupCrypto } from '../src/crypto.js'
import { createGroupMLS } from '../src/mls.js'
import { buildRealCommit, createRealGroup } from './fixtures/real-group.js'

test('operation results carry the epoch used by the handle', async () => {
  const group = await createRealGroup(1, 'epoch-results')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const access = simpleHandleAccess({
    handle: () => member.handle,
    adopt: (next) => {
      member.handle = next
    },
  })
  const crypto = createGroupCrypto({ access })
  const sender = createGroupCrypto({
    access: simpleHandleAccess({
      handle: () => group.committer.handle,
      adopt: (next) => {
        group.committer.handle = next
      },
    }),
  })
  const mls = createGroupMLS({ access, identity: member.identity, entrySlot: member.slot })
  const epoch = Number(member.handle.epoch)

  const { secret, epoch: exportedAt } = await crypto.exportSecret('kumiai/test/epoch')
  expect(secret.length).toBeGreaterThan(0)
  expect(exportedAt).toBe(epoch)

  const { sealed, epoch: sealedAt } = await crypto.sealEntries(new Uint8Array([1, 2]))
  expect(await crypto.openEntries(sealed)).toEqual(new Uint8Array([1, 2]))
  expect(sealedAt).toBe(epoch)

  const frame = await sender.wrap(new Uint8Array([3]))
  const opened = await crypto.unwrap(frame)
  expect(opened.payload).toEqual(new Uint8Array([3]))
  expect(opened.epoch).toBe(epoch)

  const commit = await buildRealCommit(group)
  const result = await mls.processCommit(commit, {
    resolveLedgerEntries: group.resolveLedgerEntries,
  })
  expect(result).toEqual({ advanced: true, epochBefore: epoch, epochAfter: epoch + 1 })
})
