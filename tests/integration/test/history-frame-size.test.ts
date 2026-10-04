import { randomIdentity } from '@kokuin/token'
import { commitLedgerEntries, createGroup, encodeClientState, signLedgerEntry } from '@kumiai/mls'
import {
  createGroupCrypto,
  createGroupMLS,
  createLedgerEntrySlot,
  simpleHandleAccess,
} from '@kumiai/mls-rpc'
import { assertFrameFits, commitTopic, createGroupPeer, FrameTooLargeError } from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import {
  chat,
  createMemoryAnchorStore,
  createMemoryAppCursorStore,
  createMemoryCommitJournal,
  type Protocols,
} from './app-lane-e2e.js'
import { createWireHub } from './log-hub-over-wire.js'

test('horizon history and a 64 KiB consumer entry fit the real hub with the final recovery seal', async () => {
  const fixturePath = new URL(
    '../../../packages/mls/test/fixtures/history-probe.ts',
    import.meta.url,
  ).href
  const probe = (await import(fixturePath)) as {
    frameMeasurements: (options: {
      onlyHorizon: boolean
      onHorizonFrames: (frames: Record<string, Uint8Array>, delta: number) => Promise<void>
    }) => Promise<boolean>
  }
  const hub = createWireHub()
  const identity = randomIdentity()
  const connection = hub.connect(identity)
  const topicID = commitTopic(new Uint8Array(32).fill(53))
  const seen: Array<number> = []
  try {
    await connection.subscribe(identity.id, topicID, { retention: 3600 })
    expect(
      await probe.frameMeasurements({
        onlyHorizon: true,
        onHorizonFrames: async (frames, delta) => {
          seen.push(delta)
          for (const name of ['commit', 'Welcome', 'sealed GroupInfo + ledger']) {
            const frame = frames[name]
            if (frame == null) throw new Error('Missing horizon frame')
            assertFrameFits(frame)
            await connection.publish({
              senderDID: identity.id,
              topicID,
              payload: frame,
              retain: 'log',
            })
          }
        },
      }),
    ).toBe(true)
    expect(seen).toEqual([85, 85])
    const stored = await connection.fetchTopic({ subscriberDID: identity.id, topicID, limit: 10 })
    expect(stored.messages).toHaveLength(6)
  } finally {
    await hub.dispose()
  }
}, 600_000)

test('a final frame one byte above the hub cap is rejected before journalling or publication', async () => {
  const hub = createWireHub()
  const identity = randomIdentity()
  let group = (await createGroup(identity, 'frame-cap-side-effects')).group
  const access = simpleHandleAccess({
    handle: () => group,
    adopt: (next) => {
      group = next
    },
  })
  const crypto = createGroupCrypto({ access })
  const mls = createGroupMLS({ access, identity, entrySlot: createLedgerEntrySlot() })
  const connection = hub.connect(identity)
  const publish = vi.spyOn(connection, 'publish')
  const journal = createMemoryCommitJournal()
  const put = vi.spyOn(journal, 'put')
  const peer = createGroupPeer<Protocols>({
    hub: connection,
    crypto,
    mls,
    localDID: identity.id,
    journal,
    anchorStore: createMemoryAnchorStore(),
    appCursorStore: createMemoryAppCursorStore(),
    protocols: { chat },
    handlers: {
      chat: { 'chat/changed': () => {}, 'chat/posted': () => {}, 'chat/double': () => ({}) },
    },
    adoptJournalled: async () => {},
  })
  try {
    await peer.resync()
    const token = await signLedgerEntry(identity, {
      groupID: group.groupID,
      type: 'note',
      subject: identity.id,
      value: 'cap',
    })
    const built = await commitLedgerEntries(group, [token])
    vi.spyOn(crypto, 'sealEntries').mockResolvedValue({
      sealed: new Uint8Array(786433 - built.commitMessage.length - 9),
      epoch: Number(group.epoch),
    })
    const before = publish.mock.calls.length
    await expect(
      peer.commit(async () => ({
        commit: built.commitMessage,
        bodies: [token],
        kind: 'ledger',
        journal: encodeClientState(built.newGroup.state),
        onAccepted: async () => access.replace(built.newGroup),
      })),
    ).rejects.toBeInstanceOf(FrameTooLargeError)
    expect(put).toHaveBeenCalledTimes(0)
    expect(journal.slot()).toBeNull()
    expect(publish.mock.calls.length).toBe(before)
    const fetched = await connection.fetchTopic({
      subscriberDID: identity.id,
      topicID: commitTopic(await mls.exportRecoverySecret()),
    })
    expect(fetched.messages).toHaveLength(0)
    expect(group.epoch).toBe(0n)
  } finally {
    await peer.dispose()
    await hub.dispose()
  }
})
