import { randomIdentity } from '@kokuin/token'
import {
  commitLedgerEntries,
  createGroup,
  decodeClientState,
  type GroupHandle,
  restoreGroup,
  signLedgerEntry,
} from '@kumiai/mls'
import {
  createGroupCrypto,
  createGroupMLS,
  createLedgerEntrySlot,
  simpleHandleAccess,
} from '@kumiai/mls-rpc'
import { createGroupPeer } from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import {
  chat,
  createMemoryAnchorStore,
  createMemoryAppCursorStore,
  createMemoryAppOutbox,
  createMemoryCommitJournal,
  type Protocols,
} from './app-lane-e2e.js'
import { createWireHub } from './log-hub-over-wire.js'

test('real MLS publishes paired snapshots only after an awaited adoption callback', async () => {
  const identity = randomIdentity()
  const created = await createGroup(identity, 'admission-integration')
  let handle: GroupHandle = created.group
  const epochBefore = Number(handle.epoch)
  const access = simpleHandleAccess({
    handle: () => handle,
    adopt: async (next) => {
      handle = next
      const admissionInsideCallback = await mls.sendAdmission()
      expect(admissionInsideCallback).toEqual({ epoch: epochBefore, admissible: true })
      expect(crypto.epoch()).toBe(epochBefore)
    },
  })
  const crypto = createGroupCrypto({ access })
  const mls = createGroupMLS({ access, identity, entrySlot: createLedgerEntrySlot() })
  const token = await signLedgerEntry(identity, {
    groupID: handle.groupID,
    type: 'note',
    subject: identity.id,
    value: 'admission',
  })
  const result = await commitLedgerEntries(handle, [token])
  await access.replace(result.newGroup)
  expect(mls.sendAdmission()).toEqual({ epoch: Number(handle.epoch), admissible: true })
  expect(crypto.epoch()).toBe(mls.sendAdmission().epoch)
})

test('dispatch awaited inside adoption durably accepts at the pre-adoption admission without sealing', async () => {
  const hub = createWireHub()
  const identity = randomIdentity()
  const appOutbox = createMemoryAppOutbox()
  let releasePut: () => void = () => {}
  let enteredPut: () => void = () => {}
  const putGate = new Promise<void>((resolve) => {
    releasePut = resolve
  })
  const putEntered = new Promise<void>((resolve) => {
    enteredPut = resolve
  })
  let handle = (await createGroup(identity, 'admission-dispatch-integration')).group
  const epochBefore = Number(handle.epoch)
  const access = simpleHandleAccess({
    handle: () => handle,
    adopt: async (next) => {
      handle = next
      expect(await mls.sendAdmission()).toEqual({ epoch: epochBefore, admissible: true })
      await peer.protocol('chat').dispatch('chat/posted', { data: { text: 'during adoption' } })
      expect(await appOutbox.list()).toHaveLength(1)
      expect((await appOutbox.list())[0]).toMatchObject({
        protocol: 'chat',
        prc: 'chat/posted',
        lastAttempt: null,
      })
      expect(mls.sendAdmission()).toEqual({ epoch: epochBefore, admissible: true })
      expect(access.epoch()).toBe(epochBefore)
      expect(seals).toHaveLength(0)
    },
  })
  const crypto = createGroupCrypto({ access })
  const mls = createGroupMLS({ access, identity, entrySlot: createLedgerEntrySlot() })
  const seals: Array<number> = []
  const wrap = crypto.wrap.bind(crypto)
  vi.spyOn(crypto, 'wrap').mockImplementation(async (bytes, opts) => {
    const sealed = await wrap(bytes, opts)
    const admission = mls.sendAdmission()
    expect(admission.admissible).toBe(true)
    expect(crypto.frameEpoch(sealed)).toBe(admission.epoch)
    seals.push(admission.epoch)
    return sealed
  })
  const peer = createGroupPeer<Protocols>({
    hub: hub.connect(identity),
    crypto,
    mls,
    journal: createMemoryCommitJournal(),
    anchorStore: createMemoryAnchorStore(),
    appCursorStore: createMemoryAppCursorStore(),
    appOutbox: {
      ...appOutbox,
      put: async (entry) => {
        expect(mls.sendAdmission()).toEqual({ epoch: epochBefore, admissible: true })
        enteredPut()
        await putGate
        await appOutbox.put(entry)
      },
    },
    appOutboxLimit: 16,
    localDID: identity.id,
    protocols: { chat },
    handlers: {
      chat: {
        'chat/changed': () => {},
        'chat/posted': () => {},
        'chat/double': () => ({}),
      },
    },
    adoptJournalled: async (blob) => {
      const state = decodeClientState(blob)
      if (state == null) throw new Error('Invalid journal state')
      if (state.groupContext.epoch <= handle.epoch) return
      await access.replace(
        await restoreGroup({
          state,
          credential: handle.credential,
          ledgerEntries: handle.ledgerTokens,
        }),
      )
    },
  })
  try {
    await peer.resync()
    const token = await signLedgerEntry(identity, {
      groupID: handle.groupID,
      type: 'note',
      subject: identity.id,
      value: 'adoption',
    })
    const result = await commitLedgerEntries(handle, [token])
    let adopted = false
    const adoption = access.replace(result.newGroup).then(() => {
      adopted = true
    })
    await putEntered
    expect(adopted).toBe(false)
    expect(await appOutbox.list()).toEqual([])
    expect(seals).toEqual([])
    releasePut()
    await adoption
    expect(mls.sendAdmission()).toEqual({ epoch: epochBefore + 1, admissible: true })
    expect(seals).toEqual([])
    expect(await appOutbox.list()).toHaveLength(1)
    expect((await appOutbox.list())[0]?.lastAttempt).toBeNull()
  } finally {
    await peer.dispose()
    await hub.dispose()
  }
})

test.todo(
  'accepted adoption entries seal at the matching admission epoch once the delivery worker publishes them',
)
