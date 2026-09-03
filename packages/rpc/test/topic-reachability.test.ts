import { describe, expect, test } from 'vitest'

import { createGroupPeer } from '../src/peer.js'
import { defineGroupProtocol } from '../src/protocol.js'
import { createMemoryAnchorStore } from './fixtures/anchor.js'
import { createMemoryAppCursorStore } from './fixtures/app-cursor.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryCommitJournal } from './fixtures/journal.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { adoptJournalledBlob } from './fixtures/peer.js'

const room = defineGroupProtocol({
  'room/posted': { type: 'event', retain: 'log', data: { type: 'object' } },
})

type Protocols = { room: typeof room }

/**
 * Wires one peer over `localDID`, mirroring `peer-app-topic.test.ts`'s `makeRoomPeer`, then
 * drives it through `resync()` — the cheapest host-facing call that `await ready`s, the same
 * gate every entry point (`dispatch`/`request`/`gather`/`to`) waits on. `createGroupPeer` itself
 * never throws: `inboxTopic(localDID)` runs inside the async init IIFE (`buildEpoch`, called from
 * `ready`), so a malformed DID only surfaces once something awaits that promise.
 */
async function startPeerWithLocalDID(localDID: string) {
  const hub = new FakeHub()
  const recoverySecret = new Uint8Array(32).fill(0x70)
  const crypto = createFakeCrypto({ epoch: 1, localDID })
  const mls = createMemoryGroupMLS({
    recoverySecret,
    epoch: 1,
    localDID,
    members: [localDID],
    onAdvance: (e) => crypto.setEpoch(e),
  })
  const journal = createMemoryCommitJournal()
  const anchorStore = createMemoryAnchorStore()
  const appCursorStore = createMemoryAppCursorStore()
  const peer = createGroupPeer<Protocols>({
    hub,
    crypto,
    mls,
    journal,
    anchorStore,
    appCursorStore,
    adoptJournalled: async (blob) => {
      adoptJournalledBlob(mls, blob)
    },
    localDID,
    protocols: { room },
    handlers: { room: {} } as never,
  })
  // Surfaces `ready`'s rejection, if any: `resync` is `await ready; assertLive(); ...`.
  await peer.resync()
  return peer
}

describe('the topic guards sit on the paths a host actually reaches', () => {
  test('createGroupPeer rejects a NUL-bearing localDID at init', async () => {
    await expect(startPeerWithLocalDID('did:key:z\0evil')).rejects.toThrow()
  })

  test('createGroupPeer rejects a lone-surrogate localDID at init', async () => {
    await expect(startPeerWithLocalDID('did:key:z\uD800')).rejects.toThrow()
  })

  test('.to() rejects a lone-surrogate target DID', async () => {
    const peer = await startPeerWithLocalDID('did:key:zalice')
    // `to` is declared `async`, so even a synchronous throw inside it (from `inboxTopic`) reaches
    // the caller as a rejected promise, never a synchronous throw.
    await expect(peer.protocol('room').to('did:key:z\uD800')).rejects.toThrow()
    await peer.dispose()
  })

  test('.to() rejects a NUL-bearing target DID', async () => {
    const peer = await startPeerWithLocalDID('did:key:zalice')
    await expect(peer.protocol('room').to('did:key:z\0evil')).rejects.toThrow()
    await peer.dispose()
  })
})
