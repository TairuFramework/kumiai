import * as rpc from '@kumiai/rpc'
import { expect, test } from 'vitest'

import { createGroupCrypto } from '../src/crypto.js'
import * as mlsRpc from '../src/index.js'
import { createGroupMLS } from '../src/mls.js'
import {
  buildRealCommit,
  createRealGroup,
  testGroupMLSDependencies,
  testHandleAccess,
} from './fixtures/real-group.js'

test('one InvalidAppEntryError class', () => {
  expect(mlsRpc.InvalidAppEntryError).toBe(rpc.InvalidAppEntryError)
})

test('operation results carry the epoch used by the handle', async () => {
  const group = await createRealGroup(1, 'epoch-results')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const access = testHandleAccess({
    handle: () => member.handle,
    adopt: (next) => {
      member.handle = next
    },
  })
  const crypto = createGroupCrypto({ access })
  const sender = createGroupCrypto({
    access: testHandleAccess({
      handle: () => group.committer.handle,
      adopt: (next) => {
        group.committer.handle = next
      },
    }),
  })
  const mls = createGroupMLS({
    ...testGroupMLSDependencies(access),
    identity: member.identity,
    entrySlot: member.slot,
  })
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
  expect(result).toEqual({
    applied: true,
    advanced: true,
    epochBefore: epoch,
    epochAfter: epoch + 1,
  })
})
