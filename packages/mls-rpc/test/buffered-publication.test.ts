import { commitTopic, decodeAppAAD, type ProtocolSurface } from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import { createGroupCrypto } from '../src/crypto.js'
import { createRegistryFixture } from './fixtures/registry.js'
import { startLeaseRotationPeer } from './fixtures/registry-lease-rotation.js'

test.each(['real-mls', 'double'] as const)(
  'buffered reconciliation certifies an acknowledged publication past control garbage (%s)',
  async (mode) => {
    const fixture = await createRegistryFixture({
      mode,
      setup: 'empty',
      groupID: crypto.randomUUID(),
      backgroundMaintenance: 'gated',
    })
    const key = await fixture.registry.seed(await fixture.makeHandle(0), { packageUse: null })
    const outbox = fixture.device.groups.ports(key).outbox
    const f = await startLeaseRotationPeer({ mode, fixture, key, outbox })
    await f.owner.ready
    const peer = f.owner.peer()
    if (peer === null) throw new Error('Missing peer')
    const access = await fixture.registry.access(key.groupID)
    const groupCrypto = createGroupCrypto({ access })
    const topicID = commitTopic(await f.mls().exportRecoverySecret())
    const protocol = peer.protocol('chat') as ProtocolSurface<{
      posted: { type: 'event'; retain: 'log'; data: { type: 'object' } }
    }>
    const publish = f.hub.publish.bind(f.hub)
    let garbagePosition: string | undefined
    vi.spyOn(f.hub, 'publish').mockImplementation(async (input) => {
      const aad = groupCrypto.frameAAD(input.payload)
      if (aad !== null && decodeAppAAD(aad)?.intent === 'log' && garbagePosition === undefined) {
        const garbage = await publish({
          senderDID: fixture.identity.id,
          topicID,
          payload: new Uint8Array([0]),
          retain: 'log',
        })
        garbagePosition = garbage.sequenceID
      }
      return await publish(input)
    })
    try {
      await peer.replay()
      await protocol.dispatch('posted', { data: {} })
      await vi.waitFor(async () => {
        expect(garbagePosition).toBeDefined()
        expect((await fixture.device.groups.ports(key).control.load()).cursor?.position).toBe(
          garbagePosition,
        )
      })
      await peer.replay()
      await vi.waitFor(async () => expect(await outbox.list()).toHaveLength(0))
      expect((await outbox.events()).map((event) => event.kind)).toEqual(['accepted', 'published'])
    } finally {
      await f.owner.dispose()
      await fixture.close()
    }
  },
)
