import { HeadMismatchError } from '@kumiai/hub-protocol'
import { describe, expect, test } from 'vitest'

import { OperationOutcomeError } from '../src/errors.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryHostDatabase } from './fixtures/host-db.js'
import { buildInviteCommit, buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(0x76)

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Operation did not settle')
}

describe('durable peer operations', () => {
  test('an accepted operation on a departed branch lets recovery run and settles unknown', async () => {
    const hub = new FakeHub()
    const database = createMemoryHostDatabase()
    const seed = makeMLSPeer(hub, 'bob', secret, { database, members: ['alice', 'bob'] })
    await seed.peer.resync()
    const request = buildLedgerCommit(seed, ['departed'])
    const stopAfterAcceptance = (): void => {
      database.seam('after-apply', async () => {
        if ((await seed.control.load()).operations[0]?.stage === 'accepted')
          void seed.peer.dispose()
        else stopAfterAcceptance()
      })
    }
    stopAfterAcceptance()
    await seed.peer.enqueue(request)
    await waitFor(async () => (await seed.control.load()).operations[0]?.stage === 'accepted')
    await seed.peer.dispose()
    await seed.peer.drained()
    seed.mls.adopt(seed.mls.buildCommit(['other-local-branch']))
    const options = {
      members: ['alice', 'bob'],
      recovery: { timeoutMs: 200, deadlineMs: 1000, getDelayMs: () => 0 },
    }
    const alice = makeMLSPeer(hub, 'alice', secret, { ...options, epoch: 3 })
    const bob = makeMLSPeer(hub, 'bob', secret, {
      ...options,
      database,
      mls: seed.mls,
      crypto: seed.crypto,
      anchorStore: seed.anchorStore,
    })
    try {
      await bob.peer.replay()
      expect((await bob.peer.recover()).advanced).toBe(true)
      expect((await bob.control.load()).operations).toEqual([])
      expect(await bob.peer.outcomes()).toEqual([
        expect.objectContaining({ opID: request.id, kind: 'unknown' }),
      ])
      expect(bob.mls.epoch()).toBe(4)
    } finally {
      await Promise.all([bob.peer.dispose(), alice.peer.dispose()])
      await Promise.all([bob.peer.drained(), alice.peer.drained()])
    }
  })
  test.each(['intent', 'built', 'accepted'] as const)(
    'restart after %s was written resumes the operation once',
    async (stage) => {
      const hub = new FakeHub()
      const database = createMemoryHostDatabase()
      const seed = makeMLSPeer(hub, 'alice', secret, { database })
      await seed.peer.resync()
      const request = buildInviteCommit(seed, 'dave')
      const stopAtStage = (): void => {
        database.seam('after-apply', async () => {
          const snapshot = await seed.control.load()
          if (snapshot.operations[0]?.stage === stage) void seed.peer.dispose()
          else stopAtStage()
        })
      }
      stopAtStage()
      await seed.peer.enqueue(request).catch(() => {})
      await waitFor(async () => (await seed.control.load()).operations[0]?.stage === stage)
      await seed.peer.dispose()
      await seed.peer.drained()
      const persisted = (await seed.control.load()).operations[0]
      const restarted = makeMLSPeer(hub, 'alice', secret, { restartOf: seed })
      await waitFor(async () => (await restarted.peer.outcomes()).length === 1)
      expect(await restarted.peer.outcomes()).toEqual([
        expect.objectContaining({ id: request.id, kind: 'landed' }),
      ])
      expect(restarted.mls.epoch()).toBe(2)
      expect((await restarted.control.load()).operations).toEqual([])
      expect((await restarted.control.load()).applied).toHaveLength(1)
      const frames = hub.published.filter((row) => row.topicID === commitTopic(secret))
      expect(frames).toHaveLength(1)
      if (persisted?.stage !== 'intent')
        expect(frames[0]?.payload).toEqual(persisted?.built.payload)
      expect(hub.published.filter((row) => row.topicID === rendezvousTopic(secret))).toEqual([])
      await restarted.peer.ack(request.id)
      expect(await restarted.peer.outcomes()).toEqual([])
      await restarted.peer.dispose()
    },
  )

  test.each([false, true])(
    'hub acceptance survives a lost answer (dedup forgotten: %s)',
    async (forget) => {
      const hub = new FakeHub()
      let seed: ReturnType<typeof makeMLSPeer>
      const view = {
        publish: async (params: Parameters<FakeHub['publish']>[0]) => {
          const result = await hub.publish(params)
          if (params.topicID === commitTopic(secret)) {
            if (forget) hub.forgetPublishRecords()
            void seed.peer.dispose()
            throw new Error('Process died after hub acceptance')
          }
          return result
        },
        subscribe: hub.subscribe.bind(hub),
        unsubscribe: hub.unsubscribe.bind(hub),
        receive: hub.receive.bind(hub),
        fetchTopic: hub.fetchTopic.bind(hub),
      }
      seed = makeMLSPeer(view, 'alice', secret)
      await seed.peer.resync()
      const request = buildInviteCommit(seed, 'dave')
      await seed.peer.enqueue(request)
      await waitFor(async () => hub.published.some((row) => row.topicID === commitTopic(secret)))
      await seed.peer.dispose()
      await seed.peer.drained()
      expect((await seed.control.load()).operations[0]?.stage).toBe('built')
      const restarted = makeMLSPeer(hub, 'alice', secret, { restartOf: seed })
      await waitFor(async () => (await restarted.peer.outcomes()).length === 1)
      expect(await restarted.peer.outcomes()).toEqual([expect.objectContaining({ kind: 'landed' })])
      expect((await restarted.control.load()).welcomes).toHaveLength(1)
      expect(hub.published.filter((row) => row.topicID === commitTopic(secret))).toHaveLength(1)
      await restarted.peer.dispose()
    },
  )

  test('own adoption commits state and settlement together before restart', async () => {
    const hub = new FakeHub()
    const database = createMemoryHostDatabase()
    const seed = makeMLSPeer(hub, 'alice', secret, { database })
    await seed.peer.resync()
    database.seam('after-save', () => {
      void seed.peer.dispose()
    })
    const request = buildInviteCommit(seed, 'dave')
    await seed.peer.enqueue(request)
    await waitFor(async () => (await seed.control.load()).outcomes.length === 1)
    await seed.peer.dispose()
    await seed.peer.drained()
    expect((await seed.anchorStore.load())?.pending).toMatchObject({ landed: true })
    const mutation = await seed.control.lastMutation()
    const restarted = makeMLSPeer(hub, 'alice', secret, { restartOf: seed })
    await restarted.peer.resync()
    expect(restarted.mls.epoch()).toBe(2)
    expect((await restarted.control.load()).applied).toHaveLength(1)
    expect((await restarted.control.load()).operations).toEqual([])
    expect(await restarted.control.lastMutation()).toBe(mutation)
    await restarted.peer.dispose()
  })

  test('failed adoption leaves state, control and live handle unchanged, then retries on restart', async () => {
    const hub = new FakeHub()
    const database = createMemoryHostDatabase()
    const seed = makeMLSPeer(hub, 'alice', secret, { database })
    await seed.peer.resync()
    database.failNext('mid-save')
    const request = buildInviteCommit(seed, 'dave')
    await seed.peer.enqueue(request)
    await waitFor(async () => (await seed.control.load()).operations[0]?.stage === 'accepted')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await seed.peer.dispose()
    await seed.peer.drained()
    expect(seed.mls.epoch()).toBe(1)
    expect((await seed.control.load()).applied).toEqual([])
    expect((await seed.control.load()).outcomes).toEqual([])
    expect(await seed.database.loadState('alice')).toBeNull()
    expect((await seed.anchorStore.load())?.pending?.landed).toBeUndefined()
    const restarted = makeMLSPeer(hub, 'alice', secret, { restartOf: seed })
    await waitFor(async () => (await restarted.peer.outcomes()).length === 1)
    expect(restarted.mls.epoch()).toBe(2)
    expect((await restarted.control.load()).applied).toHaveLength(1)
    await restarted.peer.dispose()
  })

  test('restart preserves the enqueue deadline and discovers an old acceptance', async () => {
    const hub = new FakeHub()
    const database = createMemoryHostDatabase()
    const seed = makeMLSPeer(hub, 'alice', secret, { database, operationTimeoutMs: 0 })
    await seed.peer.resync()
    database.seam('after-apply', () => {
      database.seam('after-apply', () => {
        void seed.peer.dispose()
      })
    })
    const request = buildLedgerCommit(seed, [])
    await seed.peer.enqueue(request)
    await waitFor(async () => (await seed.control.load()).operations[0]?.stage === 'built')
    await seed.peer.dispose()
    await seed.peer.drained()
    const op = (await seed.control.load()).operations[0]
    if (op?.stage !== 'built') throw new Error('Missing built operation')
    await hub.publish({
      senderDID: 'alice',
      topicID: commitTopic(secret),
      retain: 'log',
      payload: op.built.payload,
      publishID: op.built.publishID,
      expectedHead: op.built.expectedHead,
    })
    const restarted = makeMLSPeer(hub, 'alice', secret, { restartOf: seed, operationTimeoutMs: 0 })
    await waitFor(async () => (await restarted.peer.outcomes()).length === 1)
    expect(await restarted.peer.outcomes()).toEqual([expect.objectContaining({ kind: 'landed' })])
    await restarted.peer.dispose()
  })

  test('commit rejects with the durable lost outcome', async () => {
    const hub = new FakeHub()
    const view = {
      publish: async (params: Parameters<FakeHub['publish']>[0]) => {
        if (params.topicID === commitTopic(secret)) throw new HeadMismatchError('Race lost')
        return hub.publish(params)
      },
      subscribe: hub.subscribe.bind(hub),
      unsubscribe: hub.unsubscribe.bind(hub),
      receive: hub.receive.bind(hub),
      fetchTopic: hub.fetchTopic.bind(hub),
    }
    const member = makeMLSPeer(view, 'alice', secret, { operationTimeoutMs: 0 })
    const request = buildLedgerCommit(member, [])
    await expect(member.peer.commit(request)).rejects.toBeInstanceOf(OperationOutcomeError)
    expect(await member.peer.outcomes()).toEqual([
      expect.objectContaining({ id: request.id, kind: 'lost' }),
    ])
    await member.peer.dispose()
  })
  test('outcome callbacks see durable settlement and can ack and enqueue outside the lane', async () => {
    const hub = new FakeHub()
    const seen: Array<string> = []
    let member: ReturnType<typeof makeMLSPeer>
    let followup: ReturnType<typeof buildLedgerCommit>
    member = makeMLSPeer(hub, 'alice', secret, {
      onOutcome: async (outcome) => {
        expect(await member.peer.outcomes()).toContainEqual(outcome)
        await member.peer.ack(outcome.id)
        seen.push(outcome.id)
        if (seen.length === 1) await member.peer.enqueue(followup)
      },
    })
    const first = buildLedgerCommit(member, ['first'])
    followup = buildLedgerCommit(member, ['second'])
    await member.peer.commit(first)
    await waitFor(async () => seen.length === 2)
    expect(seen).toEqual([first.id, followup.id])
    expect(member.mls.epoch()).toBe(3)
    expect(await member.peer.outcomes()).toEqual([])
    await member.peer.dispose()
    await member.peer.drained()
    const restarted = makeMLSPeer(hub, 'alice', secret, { restartOf: member })
    expect(await restarted.peer.outcomes()).toEqual([])
    await restarted.peer.dispose()
  })
})
