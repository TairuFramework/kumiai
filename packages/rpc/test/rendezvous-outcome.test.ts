import { describe, expect, test, vi } from 'vitest'

import { PeerDisposedError } from '../src/errors.js'
import { decodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { rendezvousTopic } from '../src/topic.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { makeMLSPeer } from './fixtures/peer.js'

const members = ['alice', 'bob', 'carol']

describe('recovery rendezvous outcomes', () => {
  test('a request publish failure rejects recover with that error', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0xa1)
    const error = new Error('request publish refused')
    const publish = hub.publish.bind(hub)
    hub.publish = async (params) => {
      if (
        params.topicID === rendezvousTopic(rs) &&
        decodeHandshakeFrame(params.payload).kind === HANDSHAKE_KIND.recoveryRequest
      )
        throw error
      return publish(params)
    }
    const bob = makeMLSPeer(hub, 'bob', rs, {
      members,
      recovery: { timeoutMs: 10, deadlineMs: 30 },
    })
    await expect(bob.peer.recover()).rejects.toBe(error)
    await bob.peer.dispose()
  })

  test('dispose while waiting for a reply rejects recover as disposed', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0xa2)
    const bob = makeMLSPeer(hub, 'bob', rs, {
      members,
      recovery: { timeoutMs: 5000, deadlineMs: 10000 },
    })
    const recovering = bob.peer.recover()
    await vi.waitFor(() =>
      expect(hub.published.some((m) => m.topicID === rendezvousTopic(rs))).toBe(true),
    )
    await bob.peer.dispose()
    await expect(recovering).rejects.toBeInstanceOf(PeerDisposedError)
  })

  test.each([
    { timeoutMs: 10, deadlineMs: 100 },
    { timeoutMs: 100, deadlineMs: 10 },
  ])('a silent rendezvous returns advanced false (%o)', async (recovery) => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0xa3)
    const bob = makeMLSPeer(hub, 'bob', rs, { members, recovery })
    await expect(bob.peer.recover()).resolves.toEqual({ advanced: false, reenact: [] })
    await bob.peer.dispose()
  })
})
