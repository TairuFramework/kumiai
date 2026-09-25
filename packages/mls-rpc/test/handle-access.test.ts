import { expect, test, vi } from 'vitest'

import { simpleHandleAccess } from '../src/access.js'
import { createGroupCrypto } from '../src/crypto.js'
import { createGroupMLS } from '../src/mls.js'
import { buildRealCommit, createRealGroup } from './fixtures/real-group.js'

test('one access instance serves both ports and publishes replacement after save', async () => {
  const group = await createRealGroup(1, 'shared-handle-access')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const saved = vi.fn()
  const access = simpleHandleAccess({
    handle: () => member.handle,
    adopt: (next) => {
      member.handle = next
    },
    persist: saved,
  })
  const crypto = createGroupCrypto({ access })
  const mls = createGroupMLS({ access, identity: member.identity, entrySlot: member.slot })
  expect(crypto.epoch()).toBe(Number(member.handle.epoch))
  expect(await mls.rosterEntries()).toContainEqual(
    expect.objectContaining({ did: member.identity.id }),
  )
  await buildRealCommit(group)
  const next = group.committer.handle
  await access.replace(next)
  expect(saved).toHaveBeenCalledWith(next)
  expect(member.handle).toBe(next)
  expect(crypto.epoch()).toBe(Number(next.epoch))
})

test('read holds access until its callback settles', async () => {
  const group = await createRealGroup(1, 'access-read-lifetime')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const access = simpleHandleAccess({ handle: () => member.handle, adopt: () => {} })
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const reading = access.read(async (handle) => {
    await held
    return handle.epoch
  })
  const entered = vi.fn()
  const second = access.read((handle) => {
    entered()
    return handle.epoch
  })
  await Promise.resolve()
  expect(entered).not.toHaveBeenCalled()
  release()
  await reading
  await second
  expect(entered).toHaveBeenCalledOnce()
})

test('mutate saves once at the library boundary and publishes only a successful save', async () => {
  const group = await createRealGroup(1, 'access-mutate-save')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const saved = vi.fn()
  const access = simpleHandleAccess({
    handle: () => member.handle,
    adopt: () => {},
    persist: saved,
  })
  await access.mutate(async (handle, persist) => {
    await persist(handle)
  })
  expect(saved).toHaveBeenCalledOnce()
  await access.mutate(async () => {})
  expect(saved).toHaveBeenCalledTimes(2)
  saved.mockRejectedValueOnce(new Error('disk failed'))
  await expect(access.mutate(async () => {})).rejects.toThrow('disk failed')
  expect(access.epoch()).toBe(Number(member.handle.epoch))
})

test('replace saves before adoption and open passes through the staged writer', async () => {
  const group = await createRealGroup(1, 'access-replace-order')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const old = member.handle
  await buildRealCommit(group)
  const next = group.committer.handle
  let finish!: () => void
  const waiting = new Promise<void>((resolve) => {
    finish = resolve
  })
  const persist = vi.fn(async () => {
    await waiting
  })
  const access = simpleHandleAccess({
    handle: () => member.handle,
    adopt: (handle) => {
      member.handle = handle
    },
    persist,
  })
  const replacement = access.replace(next)
  await Promise.resolve()
  expect(member.handle).toBe(old)
  expect(access.epoch()).toBe(Number(old.epoch))
  finish()
  await replacement
  expect(member.handle).toBe(next)
  expect(access.epoch()).toBe(Number(next.epoch))
  const record = {
    frame: { id: 'one', topicID: 'topic', protocol: 'chat', segment: 1, position: '1' },
    payload: new Uint8Array(),
    senderDID: member.identity.id,
  }
  const writer = vi.fn()
  await access.open(async (handle, persistOpened) => {
    expect(handle).toBe(next)
    await persistOpened(new Uint8Array([1]), record)
  }, writer)
  expect(writer).toHaveBeenCalledWith(new Uint8Array([1]), record)
  expect(persist).toHaveBeenCalledOnce()
})
