import { HeadMismatchError } from '@kumiai/hub-protocol'
import { fromUTF } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import { OperationOutcomeError } from '../src/errors.js'
import { createGroupPeer } from '../src/peer.js'
import { commitTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import {
  buildInviteCommit,
  buildLedgerCommit,
  chat,
  makeMLSPeer,
  type Protocols,
} from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(0x25)

describe('operation compare and set', () => {
  test('two local operations build at successive epochs and settle in FIFO order', async () => {
    const hub = new FakeHub()
    const member = makeMLSPeer(hub, 'alice', secret)
    const framedAt: Array<number> = []
    const first = buildLedgerCommit(member, ['first=admin'], { framedAt })
    const second = buildLedgerCommit(member, ['second=admin'], { framedAt })
    const positions = await Promise.all([member.peer.commit(first), member.peer.commit(second)])
    expect(framedAt).toEqual([1, 2])
    expect(positions.map((row) => row.position)).toEqual(
      [...positions.map((row) => row.position)].sort(),
    )
    expect(new Set(positions.map((row) => row.position)).size).toBe(2)
    expect((await member.peer.outcomes()).map((row) => row.opID)).toEqual([first.id, second.id])
    expect((await member.control.load()).operations).toEqual([])
    await member.peer.dispose()
  })

  test('a losing build is discarded and rebuilt after pulling the winner', async () => {
    const hub = new FakeHub()
    const publish = hub.publish.bind(hub)
    let race = true
    hub.publish = async (params) => {
      if (params.topicID === commitTopic(secret) && params.senderDID === 'alice' && race) {
        race = false
        await publishCommit({
          hub: { ...hub, publish } as FakeHub,
          senderDID: 'zoe',
          recoverySecret: secret,
          epoch: 1,
        })
      }
      return publish(params)
    }
    const member = makeMLSPeer(hub, 'alice', secret)
    const framedAt: Array<number> = []
    await member.peer.commit(buildLedgerCommit(member, ['role=admin'], { framedAt }))
    expect(framedAt).toEqual([1, 2])
    expect(member.mls.epoch()).toBe(3)
    expect((await member.peer.outcomes()).map((row) => row.kind)).toEqual(['landed'])
    await member.peer.dispose()
  })

  test('reconstructed head mismatch errors use the same search and retry rule', async () => {
    const hub = new FakeHub()
    const publish = hub.publish.bind(hub)
    let attempts = 0
    hub.publish = async (params) => {
      if (params.topicID === commitTopic(secret) && attempts++ < 5) {
        const error = new Error('Head moved')
        error.name = 'HeadMismatchError'
        throw error
      }
      return publish(params)
    }
    const member = makeMLSPeer(hub, 'alice', secret)
    const framedAt: Array<number> = []
    await member.peer.commit(buildLedgerCommit(member, [], { framedAt }))
    expect(framedAt).toHaveLength(6)
    expect((await member.control.load()).operations).toEqual([])
    await member.peer.dispose()
  })

  test('a deadline loss is a durable outcome, carried by the commit error', async () => {
    const hub = new FakeHub()
    const publish = hub.publish.bind(hub)
    hub.publish = async (params) => {
      if (params.topicID === commitTopic(secret)) throw new HeadMismatchError('Head moved')
      return publish(params)
    }
    const member = makeMLSPeer(hub, 'alice', secret, { operationTimeoutMs: 0 })
    const request = buildLedgerCommit(member, [])
    try {
      await member.peer.commit(request)
      throw new Error('Expected loss')
    } catch (error) {
      expect(error).toBeInstanceOf(OperationOutcomeError)
      expect((error as OperationOutcomeError).outcome).toMatchObject({
        id: request.id,
        kind: 'lost',
      })
    }
    expect((await member.control.load()).operations).toEqual([])
    await member.peer.dispose()
  })

  test('an accepted invite delivers its complete Welcome obligation', async () => {
    const member = makeMLSPeer(new FakeHub(), 'alice', secret)
    const request = buildInviteCommit(member, 'dave')
    await member.peer.commit(request)
    expect((await member.control.load()).welcomes).toEqual([])
    expect(member.welcomes).toEqual([request.id])
    await member.peer.dispose()
  })

  test('a mailbox frame does not change the commit head', async () => {
    const hub = new FakeHub()
    const member = makeMLSPeer(hub, 'alice', secret, { operationTimeoutMs: 0 })
    await member.peer.resync()
    await hub.publish({
      topicID: commitTopic(secret),
      senderDID: 'mallory',
      payload: fromUTF('garbage'),
      retain: 'mailbox',
    })
    await member.peer.commit(buildLedgerCommit(member, []))
    expect(member.mls.epoch()).toBe(2)
    await member.peer.dispose()
  })

  test('a swept log still uses its retained head as the publish condition', async () => {
    const hub = new FakeHub()
    await publishCommit({ hub, senderDID: 'zoe', recoverySecret: secret, epoch: 1 })
    hub.trim(commitTopic(secret), '999999999999')
    const member = makeMLSPeer(hub, 'alice', secret, { epoch: 2, operationTimeoutMs: 0 })
    await member.peer.commit(buildLedgerCommit(member, []))
    expect(member.mls.epoch()).toBe(3)
    await member.peer.dispose()
  })

  test('a peer with no MLS port refuses a commit', async () => {
    const peer = createGroupPeer<Protocols>({
      hub: new FakeHub(),
      crypto: createFakeCrypto({ epoch: 1, localDID: 'bob' }),
      localDID: 'bob',
      protocols: { chat },
      handlers: { chat: {} } as never,
    })
    await expect(
      peer.commit({ id: crypto.randomUUID(), kind: 'ledger', revokes: false, body: fromUTF('[]') }),
    ).rejects.toThrow(/no MLS port/)
    await peer.dispose()
  })
})
