import { encodeEventFrame } from '@kumiai/broadcast'
import type { HubPublishParams } from '@kumiai/hub-tunnel'
import { commitTopic, encodeAppAAD, protocolTopic } from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import { createRealGroup } from '../../../packages/mls-rpc/test/fixtures/real-group.js'
import { buildRemoveCommit, type Member, makeMember, restoreMemberHandle } from './app-lane-e2e.js'
import { createWireHub } from './log-hub-over-wire.js'

test('abandon releases a real MLS revoke blocked on an application submission', async () => {
  const group = await createRealGroup(1, 'abandon-submission-drain')
  const recipient = group.members[0]
  if (recipient === undefined) throw new Error('Missing recipient')
  const wire = createWireHub()
  const release = Promise.withResolvers<void>()
  const submitting = Promise.withResolvers<void>()
  let topicID: string | undefined
  let controlHandoffs = 0
  let appAcceptances = 0
  const hub: typeof wire = {
    ...wire,
    connect: (identity) => {
      const connection = wire.connect(identity)
      return {
        ...connection,
        publish: async (request: HubPublishParams) => {
          if (request.topicID === topicID) controlHandoffs++
          else if (request.retain === 'log') {
            submitting.resolve()
            await release.promise
          }
          const accepted = await connection.publish(request)
          if (request.topicID !== topicID && request.retain === 'log') appAcceptances++
          return accepted
        },
      }
    },
  }
  const member = makeMember({
    hub,
    identity: group.committer.identity,
    group: group.committer.handle,
    entrySlot: group.committer.slot,
  })
  let abandoning: Promise<void> | undefined
  try {
    await member.peer.replay()
    topicID = commitTopic(await member.mls.exportRecoverySecret())
    await member.peer.protocol('chat').dispatch('chat/posted', { data: { beforeRevoke: true } })
    await submitting.promise
    const request = buildRemoveCommit(member, recipient.identity.id)
    await member.peer.enqueue(request)
    await vi.waitFor(async () =>
      expect((await member.control.load()).commitOnce?.opID).toBe(request.id),
    )
    let closed = false
    abandoning = member.peer.abandon().then(() => {
      closed = true
    })
    await vi.waitFor(() => expect(closed).toBe(true))
    expect((await member.control.load()).commitOnce).toBeNull()
    expect(await member.peer.outcomes()).toMatchObject([{ opID: request.id, kind: 'unknown' }])
    expect(appAcceptances).toBe(0)
    await member.peer.protocol('chat').dispatch('chat/posted', { data: { afterAbandon: true } })
    expect(await member.appOutbox.list()).toHaveLength(2)
    release.resolve()
    await vi.waitFor(async () => expect(await member.appOutbox.list()).toEqual([]), {
      timeout: 5000,
    })
    expect(appAcceptances).toBe(2)
    expect(controlHandoffs).toBe(0)
  } finally {
    release.resolve()
    await abandoning
    await member.peer.dispose()
    await member.peer.drained()
    await hub.dispose()
  }
})

test('terminal restart retains the outbox until real MLS plaintext delivery completes', async () => {
  const group = await createRealGroup(1, 'terminal-plaintext-drain')
  const recipient = group.members[0]
  if (recipient === undefined) throw new Error('Missing recipient')
  const hub = createWireHub()
  const alice = makeMember({
    hub,
    identity: group.committer.identity,
    group: group.committer.handle,
    entrySlot: group.committer.slot,
  })
  const bob = makeMember({
    hub,
    identity: recipient.identity,
    group: recipient.handle,
    entrySlot: recipient.slot,
    durablePending: true,
  })
  const handler = Promise.withResolvers<void>()
  let again: Member | undefined
  try {
    await Promise.all([alice.peer.replay(), bob.peer.replay()])
    const anchor = bob.anchorStore.stored()
    if (anchor === null) throw new Error('Missing anchor')
    const topicID = protocolTopic(anchor.secret, anchor.epoch, 'chat')
    const aad = encodeAppAAD({ topicID, intent: 'log' })
    const plaintext = encodeEventFrame('chat/posted', { text: 'opened before removal' })
    const sealed = await alice.crypto.wrap(plaintext, { aad })
    const frame = {
      id: 'opened-before-removal',
      topicID,
      protocol: 'chat',
      segment: anchor.epoch,
      position: '000000000001',
    }
    await bob.crypto.unwrap(sealed, { expectedAAD: aad, frame })
    expect(bob.pendingStore?.size).toBe(1)
    bob.stateStore.database.seam('after-save', () => {
      void bob.peer.dispose()
    })
    await alice.peer.commit(buildRemoveCommit(alice, bob.identity.id))
    await vi.waitFor(async () => expect((await bob.stateStore.readEvidence()).terminal).toBe(true))
    await bob.peer.dispose()
    await bob.peer.drained()
    await bob.disconnect()
    await bob.appOutbox.put({
      seq: 1,
      protocol: 'chat',
      prc: 'chat/posted',
      data: encodeEventFrame('chat/posted', { text: 'retained' }),
      lastAttempt: null,
      status: 'accepted',
    })
    const retained = await bob.appOutbox.list()
    const seen: Array<unknown> = []
    again = makeMember({
      hub,
      identity: recipient.identity,
      group: await restoreMemberHandle(bob, recipient.slot),
      entrySlot: recipient.slot,
      restartOf: bob,
      handlers: {
        'chat/posted': async (event: { data: unknown }) => {
          seen.push(event.data)
          await handler.promise
        },
      },
    })
    await again.peer.outcomes()
    await vi.waitFor(() => expect(seen).toEqual([{ text: 'opened before removal' }]))
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(await again.appOutbox.list()).toEqual(retained)
    expect(again.pendingStore?.size).toBe(1)
    handler.resolve()
    await vi.waitFor(async () => expect(await again?.appOutbox.list()).toEqual([]))
    expect(again.pendingStore?.size).toBe(0)
  } finally {
    handler.resolve()
    await again?.peer.dispose()
    await again?.peer.drained()
    await bob.peer.dispose()
    await bob.peer.drained()
    await alice.peer.dispose()
    await alice.peer.drained()
    await hub.dispose()
  }
})
