import type { GroupHandle } from '@kumiai/mls'
import { commitTopic, rendezvousTopic } from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import { simpleHandleAccess } from '../src/access.js'
import { createGroupMLS, deriveRecoverySecret } from '../src/mls.js'
import { createRealGroup } from './fixtures/real-group.js'

async function port(name: string, recoverySecret?: (handle: GroupHandle) => Promise<Uint8Array>) {
  const group = await createRealGroup(1, name)
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const access = simpleHandleAccess({
    handle: () => member.handle,
    adopt: (next) => {
      member.handle = next
    },
  })
  const mls = createGroupMLS({
    access,
    identity: member.identity,
    entrySlot: member.slot,
    ...(recoverySecret != null && { recoverySecret }),
  })
  return { group, member, access, mls }
}

test('without an override the recovery secret is the anchor KDF', async () => {
  const { member, mls } = await port('recovery-default')
  expect(await mls.exportRecoverySecret()).toEqual(await deriveRecoverySecret(member.handle))
})

test('an override supplies the secret both topics derive from', async () => {
  const seed = new Uint8Array(32).fill(7)
  const override = vi.fn(async () => seed)
  const { member, mls } = await port('recovery-override', override)
  const secret = await mls.exportRecoverySecret()
  expect(secret).toEqual(seed)
  expect(override).toHaveBeenCalledWith(member.handle)
  const fallback = await deriveRecoverySecret(member.handle)
  expect(commitTopic(secret)).not.toBe(commitTopic(fallback))
  expect(rendezvousTopic(secret)).not.toBe(rendezvousTopic(fallback))
})

test('the override reads the handle a replacement published', async () => {
  const seen: Array<GroupHandle> = []
  const { group, access, mls } = await port('recovery-restore', async (handle) => {
    seen.push(handle)
    return new Uint8Array(32).fill(9)
  })
  await access.replace(group.committer.handle)
  await mls.exportRecoverySecret()
  expect(seen.at(-1)).toBe(group.committer.handle)
})

test('an absent or short secret from the override is refused, never replaced by the default', async () => {
  for (const bad of [new Uint8Array(), new Uint8Array(8), 'seed' as unknown as Uint8Array]) {
    const { mls } = await port('recovery-invalid', async () => bad)
    await expect(mls.exportRecoverySecret()).rejects.toThrow('recoverySecret')
  }
  const failing = await port('recovery-throws', async () => {
    throw new Error('no seed in anchor')
  })
  await expect(failing.mls.exportRecoverySecret()).rejects.toThrow('no seed in anchor')
})
