import { setImmediate } from 'node:timers/promises'
import type { GroupHandle } from '@kumiai/mls'
import { asLogPosition } from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import { createGroupCrypto } from '../src/crypto.js'
import { createGroupMLS } from '../src/mls.js'
import { authenticateRecoveryReply } from '../src/recovery.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import {
  buildRealCommit,
  createRealGroup,
  testGroupMLSDependencies,
  testHandleAccess,
} from './fixtures/real-group.js'
import {
  createTransactionalAccess,
  createTransactionalStore,
} from './fixtures/transactional-access.js'

test.each(['simple', 'transactional'] as const)(
  '%s constructor dependencies retain the committed source and control cursor',
  async (mode) => {
    const group = await createRealGroup(1, `constructor-dependencies-${mode}`)
    const member = group.members[0]
    if (member === undefined) throw new Error('Missing member')
    const store = createTransactionalStore(member.handle)
    const access =
      mode === 'transactional'
        ? (await createTransactionalAccess(member, store)).access
        : testHandleAccess({
            handle: () => member.handle,
            adopt: (next) => {
              member.handle = next
            },
          })
    const dependencies = testGroupMLSDependencies(
      access,
      mode === 'transactional' ? store.control : undefined,
    )
    const source = await dependencies.readRecoverySource()
    expect(source).toEqual(await access.readControl(async (scope) => scope.source))
    expect(source).not.toHaveProperty('trust')
    expect(source).not.toHaveProperty('lifetimeRevision')
    expect(dependencies.control.key).toEqual(source.key)
    if (source.identity === null) throw new Error('Missing source identity')
    if (mode === 'transactional') expect(dependencies.control).toBe(store.control)
    const mls = createGroupMLS({
      ...dependencies,
      identity: member.identity,
      entrySlot: member.slot,
    })
    const requestID = 'committed-head'
    const { request, requestKey } = await mls.createRecoveryRequest(requestID)
    const trust = recoveryTrustFor(member.handle, source.key, null)
    for (const position of [null, asLogPosition('committed-prefix')]) {
      await dependencies.control.apply(
        { cursor: { position, epoch: source.identity.epoch } },
        crypto.randomUUID(),
      )
      const head = (await dependencies.control.load()).cursor?.position ?? null
      const sealed = await mls.sealGroupInfo(request, head)
      const reply = await authenticateRecoveryReply({
        trust,
        sealed,
        requestID,
        requestKey,
        options: {},
      })
      expect(reply?.captureHead).toBe(head)
      expect(reply?.groupInfoAuthenticator).toEqual(source.identity.authenticator)
    }
    await expect(mls.sealGroupInfo(request, asLogPosition('uncommitted'))).rejects.toThrow(
      'Capture head',
    )
    const commit = await buildRealCommit(group)
    expect(
      await mls.processCommit(commit, { resolveLedgerEntries: group.resolveLedgerEntries }),
    ).toMatchObject({ applied: true, advanced: true })
    const current = await dependencies.readRecoverySource()
    expect(current.identity?.epoch).toBe(source.identity.epoch + 1)
    expect(current).toEqual(await access.readControl(async (scope) => scope.source))
    if (mode === 'transactional') expect(current.stateVersion).toBe(store.snapshot().revision)
  },
)

test('replacement checks and carries under the same gate as persistence and sealing', async () => {
  const group = await createRealGroup(0, 'prepared-replacement')
  const member = group.committer
  const old = member.handle
  await buildRealCommit(group)
  const next = member.handle
  member.handle = old
  let release = () => {}
  const pause = new Promise<void>((resolve) => {
    release = resolve
  })
  const phases: Array<string> = []
  const access = testHandleAccess({
    handle: () => member.handle,
    adopt: (handle) => {
      member.handle = handle
    },
    persist: async () => {
      phases.push('persisted')
    },
  })
  const crypto = createGroupCrypto({ access })
  const replacing = access.replace(next, undefined, async (current: GroupHandle) => {
    expect(current).toBe(old)
    await current.carryReceiveProgress(next)
    phases.push('carried')
    await pause
    return true
  })
  let sealed = false
  const sealing = Promise.resolve(crypto.wrap(new Uint8Array([8]))).then((frame) => {
    sealed = true
    return frame
  })
  try {
    await setImmediate()
    expect(phases).toEqual(['carried'])
    expect(sealed).toBe(false)
    expect(member.handle).toBe(old)
    release()
    await replacing
    expect(crypto.frameEpoch(await sealing)).toBe(Number(next.epoch))
    expect(phases).toEqual(['carried', 'persisted', 'persisted'])
  } finally {
    release()
    await Promise.all([replacing, sealing])
  }
})

test('a replacement refused by the identity check never persists or installs', async () => {
  const group = await createRealGroup(0, 'refused-replacement')
  const member = group.committer
  const old = member.handle
  await buildRealCommit(group)
  const next = member.handle
  member.handle = old
  let saves = 0
  const access = testHandleAccess({
    handle: () => member.handle,
    adopt: (handle) => {
      member.handle = handle
    },
    persist: () => {
      saves += 1
    },
  })
  await access.replace(next, undefined, async () => false)
  expect(member.handle).toBe(old)
  expect(saves).toBe(0)
  expect(access.epoch()).toBe(Number(old.epoch))
})

test('admission stays synchronous at the old epoch through awaited adoption', async () => {
  const group = await createRealGroup(1, 'admission-adoption')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const epochBefore = Number(member.handle.epoch)
  const access = testHandleAccess({
    handle: () => member.handle,
    adopt: async (next) => {
      member.handle = next
      const admissionInsideCallback = await mls.sendAdmission()
      expect(admissionInsideCallback).toEqual({ epoch: epochBefore, admissible: true })
      expect(access.epoch()).toBe(epochBefore)
      expect(confirm).not.toHaveBeenCalled()
    },
  })
  const mls = createGroupMLS({
    ...testGroupMLSDependencies(access),
    identity: member.identity,
    entrySlot: member.slot,
  })
  expect(access.admission()).toEqual({ epoch: epochBefore, admissible: true })
  await buildRealCommit(group)
  const next = group.committer.handle
  const confirm = vi.spyOn(next, 'confirmAdopted')
  await access.replace(next)
  expect(confirm).toHaveBeenCalledOnce()
  expect(mls.sendAdmission()).toEqual({ epoch: Number(next.epoch), admissible: true })
  expect(access.epoch()).toBe(mls.sendAdmission().epoch)
})

test('failed adoption neither confirms the candidate nor publishes its snapshots', async () => {
  const group = await createRealGroup(1, 'failed-admission-adoption')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const access = testHandleAccess({
    handle: () => member.handle,
    adopt: async () => {
      throw new Error('adoption failed')
    },
  })
  const before = access.admission()
  await buildRealCommit(group)
  const next = group.committer.handle
  const confirm = vi.spyOn(next, 'confirmAdopted')
  await expect(access.replace(next)).rejects.toThrow('adoption failed')
  expect(access.admission()).toEqual(before)
  expect(access.epoch()).toBe(before.epoch)
  expect(confirm).not.toHaveBeenCalled()
})

test.each(['mutate', 'open'] as const)(
  '%s publishes admission with epoch only at successful completion',
  async (operation) => {
    const group = await createRealGroup(1, `admission-${operation}`)
    const member = group.members[0]
    if (member == null) throw new Error('missing member')
    const access = testHandleAccess({ handle: () => member.handle, adopt: () => {} })
    const before = access.admission()
    const commit = await buildRealCommit(group)
    const run = async () => {
      await member.handle.processMessage(commit)
      expect(member.handle.sendAdmission().epoch).toBe(before.epoch + 1)
      expect(access.admission()).toEqual(before)
      expect(access.epoch()).toBe(before.epoch)
    }
    if (operation === 'mutate') await access.mutate(run)
    else await access.open(run, async () => {})
    expect(access.admission()).toEqual({ epoch: before.epoch + 1, admissible: true })
    expect(access.epoch()).toBe(access.admission().epoch)
  },
)

test('sendAdmission reads only the published access snapshot', async () => {
  const group = await createRealGroup(1, 'admission-direct-access')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const access = testHandleAccess({ handle: () => member.handle, adopt: () => {} })
  const mls = createGroupMLS({
    ...testGroupMLSDependencies(access),
    identity: member.identity,
    entrySlot: member.slot,
  })
  const spies = [
    vi.spyOn(access, 'read'),
    vi.spyOn(access, 'mutate'),
    vi.spyOn(access, 'replace'),
    vi.spyOn(access, 'open'),
  ]
  expect(mls.sendAdmission()).toEqual(member.handle.sendAdmission())
  for (const spy of spies) expect(spy).not.toHaveBeenCalled()
})

test('one access instance serves both ports and publishes replacement after save', async () => {
  const group = await createRealGroup(1, 'shared-handle-access')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const saved = vi.fn()
  const access = testHandleAccess({
    handle: () => member.handle,
    adopt: (next) => {
      member.handle = next
    },
    persist: saved,
  })
  const crypto = createGroupCrypto({ access })
  const mls = createGroupMLS({
    ...testGroupMLSDependencies(access),
    identity: member.identity,
    entrySlot: member.slot,
  })
  expect(crypto.epoch()).toBe(Number(member.handle.epoch))
  expect(await mls.rosterEntries()).toContainEqual(
    expect.objectContaining({ did: member.identity.id }),
  )
  await buildRealCommit(group)
  const next = group.committer.handle
  await access.replace(next)
  expect(saved).toHaveBeenCalledWith(next, undefined)
  expect(member.handle).toBe(next)
  expect(crypto.epoch()).toBe(Number(next.epoch))
})

test('read holds access until its callback settles', async () => {
  const group = await createRealGroup(1, 'access-read-lifetime')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const access = testHandleAccess({ handle: () => member.handle, adopt: () => {} })
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
  const access = testHandleAccess({
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
  const access = testHandleAccess({
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
