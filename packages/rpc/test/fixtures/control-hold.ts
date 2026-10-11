import { expect, vi } from 'vitest'

import type { ControlHold } from '../../src/control/search.js'
import { decodeHandshakeFrame, HANDSHAKE_KIND } from '../../src/handshake.js'
import { commitTopic, rendezvousTopic } from '../../src/topic.js'
import type { FakeHub } from './fake-hub.js'
import { buildLedgerCommit, makeMLSPeer, type TestPeer } from './peer.js'

export async function assertDurableControlHold(
  member: TestPeer,
  hub: FakeHub,
  secret: Uint8Array,
  did: string,
  expected: Omit<Partial<ControlHold>, 'position' | 'evidence'> & {
    position?: string | null
    evidence?: Partial<NonNullable<ControlHold['evidence']>>
  },
): Promise<void> {
  await vi.waitFor(async () =>
    expect((await member.control.load()).controlHold).toMatchObject(expected),
  )
  const before = await member.control.load()
  const epoch = member.mls.epoch()
  const requests = () =>
    hub.published.filter((message) => {
      if (message.topicID !== rendezvousTopic(secret) || message.senderDID !== did) return false
      try {
        return decodeHandshakeFrame(message.payload).kind === HANDSHAKE_KIND.recoveryRequest
      } catch {
        return false
      }
    })
  expect(requests()).toEqual([])
  expect(before.cursor?.position ?? null).not.toBe(before.controlHold?.position)
  await member.peer.dispose()
  await member.peer.drained()
  hub.trim(commitTopic(secret), '999999999999')
  const subscriptions = vi.spyOn(hub, 'subscribe')
  const restarted = makeMLSPeer(hub, did, secret, { restartOf: member })
  try {
    await restarted.peer.replay()
    expect(subscriptions).not.toHaveBeenCalled()
    const after = await restarted.control.load()
    expect(after.controlHold).toEqual(before.controlHold)
    expect(after.strand).toEqual(before.strand)
    expect(after.cursor).toEqual(before.cursor)
    expect(restarted.mls.epoch()).toBe(epoch)
    await expect(
      restarted.peer.protocol('chat').dispatch('chat/changed', { data: {} }),
    ).rejects.toMatchObject({ name: 'RecoveryRequiredError' })
    const publications = hub.published.length
    await restarted.peer.enqueue(buildLedgerCommit(restarted, ['held']))
    expect((await restarted.control.load()).operations.at(-1)?.stage).toBe('intent')
    expect(hub.published).toHaveLength(publications)
    expect(requests()).toEqual([])
  } finally {
    await restarted.peer.dispose()
    await restarted.peer.drained()
    subscriptions.mockRestore()
  }
}
