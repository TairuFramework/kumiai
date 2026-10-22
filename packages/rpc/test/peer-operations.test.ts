import { HeadMismatchError } from '@kumiai/hub-protocol'
import { describe, expect, test, vi } from 'vitest'

import { OperationOutcomeError } from '../src/errors.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryHostDatabase } from './fixtures/host-db.js'
import {
  buildInviteCommit,
  buildLedgerCommit,
  makeMLSPeer,
  seedBuiltOperation,
} from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(0x76)

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Operation did not settle')
}

describe('durable peer operations', () => {
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
          if (
            stage === 'intent'
              ? snapshot.operations[0]?.id === request.id
              : stage === 'built'
                ? snapshot.commitOnce?.opID === request.id
                : snapshot.commitOnce?.acceptedAs !== undefined
          )
            void seed.peer.dispose()
          else stopAtStage()
        })
      }
      stopAtStage()
      await seed.peer.enqueue(request).catch(() => {})
      await waitFor(async () => {
        const snapshot = await seed.control.load()
        return stage === 'intent'
          ? snapshot.operations[0]?.id === request.id
          : stage === 'built'
            ? snapshot.commitOnce?.opID === request.id
            : snapshot.commitOnce?.acceptedAs !== undefined
      })
      await seed.peer.dispose()
      await seed.peer.drained()
      const persistedSnapshot = await seed.control.load()
      const persisted = persistedSnapshot.operations[0]
      const restarted = makeMLSPeer(hub, 'alice', secret, { restartOf: seed })
      await waitFor(async () => (await restarted.peer.outcomes()).length === 1)
      expect(await restarted.peer.outcomes()).toEqual([
        expect.objectContaining({
          opID: request.id,
          kind: 'landed',
          id: expect.any(String),
          position: hub.head(commitTopic(secret)),
        }),
      ])
      expect(restarted.mls.epoch()).toBe(2)
      expect((await restarted.control.load()).operations).toEqual([])
      expect((await restarted.control.load()).applied).toHaveLength(1)
      const frames = hub.published.filter((row) => row.topicID === commitTopic(secret))
      expect(frames).toHaveLength(1)
      if (persisted?.stage !== 'intent')
        expect(frames[0]?.payload).toEqual(persistedSnapshot.commitOnce?.payload)
      expect(hub.published.filter((row) => row.topicID === rendezvousTopic(secret))).toEqual([])
      const landed = (await restarted.peer.outcomes())[0]
      if (landed === undefined) throw new Error('Missing landed outcome')
      await restarted.peer.ack(landed.id)
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
      expect((await seed.control.load()).commitOnce?.opID).toBe(request.id)
      const restarted = makeMLSPeer(hub, 'alice', secret, { restartOf: seed })
      await waitFor(async () => (await restarted.peer.outcomes()).length === 1)
      expect(await restarted.peer.outcomes()).toEqual([expect.objectContaining({ kind: 'landed' })])
      expect((await restarted.control.load()).welcomes).toEqual([])
      expect(restarted.welcomes).toEqual([request.id])
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
    const settled = await seed.control.load()
    const restarted = makeMLSPeer(hub, 'alice', secret, { restartOf: seed })
    await restarted.peer.resync()
    expect(restarted.mls.epoch()).toBe(2)
    expect((await restarted.control.load()).applied).toHaveLength(1)
    expect((await restarted.control.load()).operations).toEqual([])
    expect((await restarted.control.load()).applied).toEqual(settled.applied)
    expect((await restarted.control.load()).outcomes).toEqual(settled.outcomes)
    await restarted.peer.dispose()
  })

  test('failed adoption leaves state, control and live handle unchanged, then retries on restart', async () => {
    const hub = new FakeHub()
    const database = createMemoryHostDatabase()
    const seed = makeMLSPeer(hub, 'alice', secret, { database })
    await seed.peer.resync()
    const initialState = await seed.database.loadState('alice')
    database.failNext('mid-save')
    const request = buildInviteCommit(seed, 'dave')
    await seed.peer.enqueue(request)
    await waitFor(async () => (await seed.control.load()).commitOnce?.acceptedAs !== undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await seed.peer.dispose()
    await seed.peer.drained()
    expect(seed.mls.epoch()).toBe(1)
    expect((await seed.control.load()).applied).toEqual([])
    expect((await seed.control.load()).outcomes).toEqual([])
    expect(await seed.database.loadState('alice')).toEqual(initialState)
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
    let now = 1_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const seed = makeMLSPeer(hub, 'alice', secret, { database, operationTimeoutMs: 1_000 })
    await seed.peer.resync()
    database.seam('after-apply', () => {
      database.seam('after-apply', () => {
        void seed.peer.dispose()
      })
    })
    const request = buildLedgerCommit(seed, [])
    await seed.peer.enqueue(request)
    await waitFor(async () => (await seed.control.load()).commitOnce?.opID === request.id)
    await seed.peer.dispose()
    await seed.peer.drained()
    const savedControl = await seed.control.load()
    const slot = savedControl.commitOnce
    if (slot === null) throw new Error('Missing slot')
    expect(savedControl.operations).toEqual([])
    await hub.publish({
      senderDID: 'alice',
      topicID: commitTopic(secret),
      retain: 'log',
      payload: slot.payload,
      publishID: slot.publishID,
      expectedHead: slot.expectedHead,
    })
    expect(slot.deadline).toBe(2_000)
    now = 2_001
    const restarted = makeMLSPeer(hub, 'alice', secret, {
      restartOf: seed,
      operationTimeoutMs: 30_000,
    })
    await waitFor(async () => (await restarted.peer.outcomes()).length === 1)
    expect(await restarted.peer.outcomes()).toEqual([expect.objectContaining({ kind: 'landed' })])
    await restarted.peer.dispose()
    clock.mockRestore()
  })

  test('restart reports expired live-build unknown once and preserves its original deadline and executable material', async () => {
    const hub = new FakeHub()
    const seed = makeMLSPeer(hub, 'alice', secret)
    await seed.peer.replay()
    const saved = await seedBuiltOperation(seed, buildLedgerCommit(seed, ['expired']))
    await seed.peer.dispose()
    await seed.peer.drained()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(saved.deadline)
    const again = makeMLSPeer(hub, 'alice', secret, {
      restartOf: seed,
      operationTimeoutMs: 1_000_000,
    })
    try {
      await again.peer.replay()
      const report = (await again.peer.outcomes())[0]
      expect(report).toMatchObject({ opID: saved.id, kind: 'unknown' })
      expect((await again.control.load()).commitOnce).toMatchObject({
        ...saved.slot,
        reported: true,
      })
      expect(hub.published.filter((row) => row.topicID === commitTopic(secret))).toEqual([])
      if (report === undefined) throw new Error('Missing provisional')
      await again.peer.ack(report.id)
      await again.peer.replay()
      expect(await again.peer.outcomes()).toEqual([])
    } finally {
      await again.peer.dispose()
      await again.peer.drained()
      clock.mockRestore()
    }
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
      expect.objectContaining({ opID: request.id, kind: 'lost' }),
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
        if (outcome.opID == null) throw new Error('Missing operation owner')
        seen.push(outcome.opID)
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
