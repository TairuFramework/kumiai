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

// Awaited dispatch needs durable enqueue outside the handle lock before this can run.
test.skip('dispatch awaited inside adoption uses the pre-adoption admission and seals at a matching epoch', async () => {
  const hub = createWireHub()
  const identity = randomIdentity()
  let handle = (await createGroup(identity, 'admission-dispatch-integration')).group
  const epochBefore = Number(handle.epoch)
  const access = simpleHandleAccess({
    handle: () => handle,
    adopt: async (next) => {
      handle = next
      expect(await mls.sendAdmission()).toEqual({ epoch: epochBefore, admissible: true })
      await peer.protocol('chat').dispatch('chat/posted', { data: { text: 'during adoption' } })
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
    await access.replace(result.newGroup)
    expect(mls.sendAdmission()).toEqual({ epoch: epochBefore + 1, admissible: true })
    await vi.waitFor(() => {
      expect(seals).toEqual([epochBefore + 1])
    })
  } finally {
    await peer.dispose()
    await hub.dispose()
  }
})
