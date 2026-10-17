import { encodeEventFrame } from '@kumiai/broadcast'
import type { HubFetchTopicParams, HubFetchTopicResult } from '@kumiai/hub-tunnel'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import type * as AppLaneModule from '../src/app-lane.js'
import { type AppLane, type AppLaneParams, createAppLane } from '../src/app-lane.js'
import type { PendingAppFrame } from '../src/crypto.js'
import { adaptBusHandlers } from '../src/handlers.js'
import { APP_TOPIC_LABEL, commitTopic, protocolTopic } from '../src/topic.js'
import { createMemoryAppCursorStore } from './fixtures/app-cursor.js'
import { publishCommit } from './fixtures/commits.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { buildLedgerCommit, chat, makeMLSPeer, type TestPeer } from './fixtures/peer.js'

// Capture the real peer/lane boundary without replacing either scheduler.
const captured = vi.hoisted(
  () =>
    [] as Array<{ lane: AppLane; params: AppLaneParams; queue: { pending: number; peak: number } }>,
)
vi.mock('../src/app-lane.js', async (original) => {
  const module = await original<typeof AppLaneModule>()
  return {
    ...module,
    createAppLane(params: AppLaneParams) {
      const queue = { pending: 0, peak: 0 }
      const enqueue = () => {
        queue.pending += 1
        queue.peak = Math.max(queue.peak, queue.pending)
      }
      const lane = module.createAppLane({
        ...params,
        ...(params.onAppDeliveryStalled == null
          ? {}
          : {
              onAppDeliveryStalled: (event) => {
                enqueue()
                params.onAppDeliveryStalled?.(event)
              },
            }),
        ...(params.onAppDeliveryResumed == null
          ? {}
          : {
              onAppDeliveryResumed: (event) => {
                enqueue()
                params.onAppDeliveryResumed?.(event)
              },
            }),
        scheduleDelivery: (start) => {
          enqueue()
          const deliver = () => {
            queue.pending -= 1
            start()
          }
          if (params.scheduleDelivery == null) deliver()
          else params.scheduleDelivery(deliver)
        },
      })
      captured.push({ lane, params, queue })
      return lane
    },
  }
})

const secret = new Uint8Array(32).fill(0xb3)
const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')
const peers: Array<TestPeer> = []
const lanes: Array<AppLane> = []
const releases: Array<() => void> = []
const tasks: Array<Promise<unknown>> = []
function track<T>(task: Promise<T>): Promise<T> {
  tasks.push(task)
  void task.catch(() => {})
  return task
}

function gate() {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  releases.push(release.resolve)
  return { entered, release }
}

class GatedHub extends DurableFakeHub {
  appGate: ReturnType<typeof gate> | undefined
  controlGate: ReturnType<typeof gate> | undefined
  override async fetchTopic(params: HubFetchTopicParams): Promise<HubFetchTopicResult> {
    const pause =
      params.topicID === topicID
        ? this.appGate
        : params.topicID === commitTopic(secret)
          ? this.controlGate
          : undefined
    if (pause != null) {
      pause.entered.resolve()
      await pause.release.promise
    }
    return super.fetchTopic(params)
  }
}

async function setup(options: Parameters<typeof makeMLSPeer>[3] = {}, durable = true) {
  const hub = new GatedHub()
  const rows = new Map<string, PendingAppFrame>()
  const reader = createFakeCrypto({
    epoch: 1,
    localDID: 'bob',
    retainedEpochs: 2,
    ...(durable
      ? {
          pending: {
            async persistOpened(_state: Uint8Array, record: PendingAppFrame) {
              rows.set(record.frame.id, record)
            },
            async list() {
              return [...rows.values()]
            },
            async complete(id: string) {
              rows.delete(id)
            },
          },
        }
      : {}),
  })
  const bob = makeMLSPeer(hub, 'bob', secret, {
    ...options,
    crypto: reader,
    ...(options.onAppDeliveryStalled == null
      ? {}
      : {
          onAppDeliveryStalled: (event) => {
            if (entry != null) entry.queue.pending -= 1
            options.onAppDeliveryStalled?.(event)
          },
        }),
    ...(options.onAppDeliveryResumed == null
      ? {}
      : {
          onAppDeliveryResumed: (event) => {
            if (entry != null) entry.queue.pending -= 1
            options.onAppDeliveryResumed?.(event)
          },
        }),
  })
  peers.push(bob)
  const entry = captured.at(-1)
  if (entry == null) throw new Error('missing peer lane')
  await bob.peer.protocol('chat').to('alice')
  await entry.lane.deliver()
  hub.detach('bob')
  return { hub, bob, rows, reader, ...entry }
}

async function append(hub: DurableFakeHub, epoch = 1, text = 'hello') {
  return hub.publish({
    topicID,
    senderDID: 'alice',
    retain: 'log',
    payload: await createFakeCrypto({ epoch, localDID: 'alice' }).wrap(
      encodeEventFrame('chat/posted', { text }),
      { aad: encodeAppAAD({ topicID, intent: 'log' }) },
    ),
  })
}

async function remoteCommit(f: Awaited<ReturnType<typeof setup>>) {
  await publishCommit({ hub: f.hub, senderDID: 'alice', recoverySecret: secret, epoch: 1 })
  const replay = track(f.bob.controlWalk.reconcileCommitPrefix())
  void replay.catch(() => {})
  await vi.waitFor(() => expect(f.bob.mls.epoch()).toBe(2), { timeout: 500 })
  await replay
}

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.allSettled(tasks.splice(0))
  for (const lane of lanes.splice(0)) lane.dispose()
  for (const member of peers.splice(0)) await member.peer.dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
  captured.length = 0
})

describe('app work leaves the commit queue', () => {
  test('commit applies while an app retry awaits a withheld fetch', async () => {
    const f = await setup()
    await append(f.hub, 3)
    await f.lane.deliver()
    const pause = gate()
    f.hub.appGate = pause
    f.lane.retryDelivery()
    await pause.entered.promise
    await remoteCommit(f)
    pause.release.resolve()
    await f.lane.deliver()
  })

  test.each([
    { durable: false, name: 'non-durable' },
    { durable: true, name: 'durable' },
  ])('commit applies while a $name handler never returns', async ({ durable }) => {
    const pause = gate()
    const f = await setup(
      {
        handlers: {
          'chat/posted': () => {
            pause.entered.resolve()
            return pause.release.promise
          },
        },
      },
      durable,
    )
    await append(f.hub)
    const retry = track(f.params.scheduleDrain?.(() => f.lane.deliver()) ?? Promise.resolve())
    await pause.entered.promise
    await remoteCommit(f)
    pause.release.resolve()
    await retry
  })

  test('dropAppFrame does not hold the commit queue behind app work', async () => {
    const f = await setup()
    const frame = await append(f.hub, 3)
    await f.lane.deliver()
    const pause = gate()
    f.hub.appGate = pause
    // Hold only the app mutex, so this catches dropAppFrame's own serial reservation.
    const drain = track(f.lane.deliver())
    await pause.entered.promise
    let dropped = false
    const drop = track(f.bob.peer.dropAppFrame(topicID, frame.sequenceID)).then(() => {
      dropped = true
    })
    void drop.catch(() => {})
    await Promise.resolve()
    expect(dropped).toBe(false)
    await remoteCommit(f)
    pause.release.resolve()
    await drain
    await drop
  })

  test('kicks coalesce', async () => {
    const pause = gate()
    let fetches = 0
    const lane = createAppLane({
      mux: {
        retainTopic() {},
        async fetchTopic() {
          fetches += 1
          if (fetches === 1) {
            pause.entered.resolve()
            await pause.release.promise
          }
          return { messages: [], head: null, oldest: null, gap: false }
        },
      } as never,
      appliedEpoch: () => 1,
      crypto: createFakeCrypto({ epoch: 1, localDID: 'bob' }),
      localDID: 'bob',
      protocols: { chat },
      eventHandlers: new Map(),
      retentionSeconds: 60,
      anchor: () => ({ epoch: 1, secret: fakeEpochSecret(1, APP_TOPIC_LABEL) }),
      groupID: () => 'group',
    })
    lanes.push(lane)
    const kick = () => lane.kick()
    expect(kick()).toBeUndefined()
    await pause.entered.promise
    for (let i = 0; i < 1_000; i++) expect(kick()).toBeUndefined()
    pause.release.resolve()
    await vi.waitFor(() => expect(fetches).toBe(2))
    await lane.deliver()
    expect(fetches).toBe(3)
  })

  test('a failed kick stays detached and retries without new traffic', async () => {
    const f = await setup()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let schedules = 0
    const lane = createAppLane({
      ...f.params,
      scheduleDrain: (drain) => {
        schedules += 1
        if (schedules === 1) throw new Error('transient scheduling failure')
        return drain()
      },
    })
    lanes.push(lane)
    expect(() => lane.kick()).not.toThrow()
    await vi.advanceTimersByTimeAsync(999)
    expect(schedules).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(schedules).toBe(2)
  })

  test('a delivery start queued after the last app task still runs', async () => {
    const seen = vi.fn()
    const f = await setup({ handlers: { 'chat/posted': seen } })
    await append(f.hub)
    await f.params.scheduleDrain?.(() => f.lane.deliver())
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1))
    await vi.waitFor(async () => expect(await f.reader.pending?.list()).toEqual([]))
    expect(f.rows.size).toBe(0)
    expect(f.queue.pending).toBe(0)
  })

  test('a live durable arrival drains while a serial control fetch remains gated', async () => {
    const seen = vi.fn()
    const f = await setup({ handlers: { 'chat/posted': seen } })
    const pause = gate()
    f.hub.controlGate = pause
    const operation = track(f.bob.controlWalk.reconcileCommitPrefix())
    await pause.entered.promise
    f.hub.reattach('bob')
    const frame = await append(f.hub)

    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1), { timeout: 500 })
    await vi.waitFor(() => {
      expect(f.rows.size).toBe(0)
      expect(f.bob.appCursorStore.stored(topicID)).toBe(frame.sequenceID)
    })
    expect(f.bob.mls.epoch()).toBe(1)
    expect(f.queue.pending).toBe(0)
    pause.release.resolve()
    await operation
  })

  test('a live far-future frame waits for missed commits before advancing its cursor', async () => {
    const seen: Array<string> = []
    const stalled = vi.fn()
    const f = await setup({
      handlers: {
        'chat/posted': ({ data }: { data: { text: string } }) => void seen.push(data.text),
      },
      onAppDeliveryStalled: stalled,
    })
    expect(f.params.commitLaneCaughtUp?.()).toBe(true)
    for (const epoch of [1, 2, 3]) {
      await publishCommit({ hub: f.hub, senderDID: 'alice', recoverySecret: secret, epoch })
    }
    expect(f.bob.mls.epoch()).toBe(1)
    expect(f.params.commitLaneCaughtUp?.()).toBe(true)
    const pause = gate()
    f.hub.controlGate = pause
    f.hub.reattach('bob')
    const frame = await append(f.hub, 4, 'epoch four')
    await pause.entered.promise

    expect(f.bob.appCursorStore.stored(topicID)).toBeNull()
    expect(seen).toEqual([])
    expect(stalled).toHaveBeenCalledWith(
      expect.objectContaining({ topicID, position: frame.sequenceID, reason: 'future-epoch' }),
    )
    pause.release.resolve()

    await vi.waitFor(() => expect(f.bob.mls.epoch()).toBe(4))
    await vi.waitFor(() => expect(seen).toEqual(['epoch four']))
    await vi.waitFor(() => {
      expect(f.rows.size).toBe(0)
      expect(f.bob.appCursorStore.stored(topicID)).toBe(frame.sequenceID)
    })
    expect(f.bob.peer.anchorEpoch()).toBe(1)
    expect(f.queue.pending).toBe(0)
  })

  test('a live arrival invalidates a commit snapshot already being fetched', async () => {
    const seen: Array<string> = []
    const outcome = Promise.withResolvers<'stalled' | 'skipped'>()
    const f = await setup({
      handlers: {
        'chat/posted': ({ data }: { data: { text: string } }) => void seen.push(data.text),
      },
      onAppDeliveryStalled: () => outcome.resolve('stalled'),
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const snapshot = gate()
    const fetch = f.hub.fetchTopic.bind(f.hub)
    let holdSnapshot = true
    vi.spyOn(f.hub, 'fetchTopic').mockImplementation(async (params) => {
      const result = await fetch(params)
      if (params.topicID === commitTopic(secret) && holdSnapshot) {
        holdSnapshot = false
        snapshot.entered.resolve()
        await snapshot.release.promise
      }
      return result
    })
    const operation = track(f.bob.controlWalk.reconcileCommitPrefix())
    await snapshot.entered.promise
    for (const epoch of [1, 2, 3]) {
      await publishCommit({ hub: f.hub, senderDID: 'alice', recoverySecret: secret, epoch })
    }
    const app = gate()
    f.hub.appGate = app
    const save = f.bob.appCursorStore.save.bind(f.bob.appCursorStore)
    vi.spyOn(f.bob.appCursorStore, 'save').mockImplementation(async (topic, position) => {
      await save(topic, position)
      if (topic === topicID && seen.length === 0) outcome.resolve('skipped')
    })
    f.hub.reattach('bob')
    const frame = await append(f.hub, 4, 'epoch four')
    await app.entered.promise
    snapshot.release.resolve()
    await operation
    app.release.resolve()

    expect(await outcome.promise).toBe('stalled')
    expect(f.bob.mls.epoch()).toBe(1)
    expect(f.bob.appCursorStore.stored(topicID)).toBeNull()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(seen).toEqual(['epoch four']))
    await vi.waitFor(() => {
      expect(f.rows.size).toBe(0)
      expect(f.bob.appCursorStore.stored(topicID)).toBe(frame.sequenceID)
    })
    expect(f.bob.mls.epoch()).toBe(4)
    expect(f.bob.peer.anchorEpoch()).toBe(1)
  })

  test.each(['cursor load', 'fetch', 'open'] as const)(
    'anchor rotation during a gated %s reloads the new segment without another wakeup',
    async (boundary) => {
      const pause = gate()
      let anchor = { epoch: 1, secret: fakeEpochSecret(1, APP_TOPIC_LABEL) }
      const newTopic = protocolTopic(fakeEpochSecret(2, APP_TOPIC_LABEL), 2, 'chat')
      const cursor = createMemoryAppCursorStore()
      await cursor.save(topicID, '000000000009')
      const load = cursor.load.bind(cursor)
      vi.spyOn(cursor, 'load').mockImplementation(async (topic) => {
        const position = await load(topic)
        if (boundary === 'cursor load' && topic === topicID) {
          pause.entered.resolve()
          await pause.release.promise
        }
        return position
      })
      const records = new Map<string, PendingAppFrame>()
      const persisted: Array<PendingAppFrame['frame']> = []
      const reader = createFakeCrypto({
        epoch: 1,
        localDID: 'bob',
        retainedEpochs: 2,
        pending: {
          async persistOpened(_state, record) {
            persisted.push(record.frame)
            records.set(record.frame.id, record)
          },
          async list() {
            return [...records.values()]
          },
          async complete(id) {
            records.delete(id)
          },
        },
      })
      const unwrap = reader.unwrap.bind(reader)
      vi.spyOn(reader, 'unwrap').mockImplementation(async (bytes, options) => {
        const opened = await unwrap(bytes, options)
        if (boundary === 'open' && options?.frame?.topicID === topicID) {
          pause.entered.resolve()
          await pause.release.promise
        }
        return opened
      })
      const oldFrame = {
        sequenceID: '000000000010',
        payload: await createFakeCrypto({ epoch: 1, localDID: 'alice' }).wrap(
          encodeEventFrame('chat/posted', { text: 'old' }),
          { aad: encodeAppAAD({ topicID, intent: 'log' }) },
        ),
      }
      const newFrame = {
        sequenceID: '000000000001',
        payload: await createFakeCrypto({ epoch: 2, localDID: 'alice' }).wrap(
          encodeEventFrame('chat/posted', { text: 'new' }),
          { aad: encodeAppAAD({ topicID: newTopic, intent: 'log' }) },
        ),
      }
      const seen: Array<string> = []
      const lane = createAppLane({
        mux: {
          retainTopic() {},
          async fetchTopic({ topicID: topic, after }: { topicID: string; after?: string }) {
            if (boundary === 'fetch' && topic === topicID) {
              pause.entered.resolve()
              await pause.release.promise
            }
            const frame = topic === topicID ? oldFrame : newFrame
            return {
              messages: after == null || frame.sequenceID > after ? [frame] : [],
              head: frame.sequenceID,
              oldest: frame.sequenceID,
              gap: false,
            }
          },
        } as never,
        crypto: reader,
        appliedEpoch: () => reader.epoch(),
        localDID: 'bob',
        protocols: { chat },
        eventHandlers: new Map([
          [
            'chat',
            adaptBusHandlers(chat, {
              'chat/posted': ({ data }: { data: { text: string } }) => void seen.push(data.text),
            }).events,
          ],
        ]),
        retentionSeconds: 60,
        appCursorStore: cursor,
        anchor: () => anchor,
        groupID: () => 'group',
      })
      lanes.push(lane)
      lane.kick()
      await pause.entered.promise
      reader.setEpoch(2)
      anchor = { epoch: 2, secret: fakeEpochSecret(2, APP_TOPIC_LABEL) }
      lane.reset()
      pause.release.resolve()

      await vi.waitFor(() => expect(seen).toContain('new'), { timeout: 500 })
      await vi.waitFor(() => expect(cursor.stored(newTopic)).toBe('000000000001'))
      expect(seen.filter((text) => text === 'new')).toHaveLength(1)
      expect(persisted.filter((frame) => frame.topicID === newTopic)).toMatchObject([
        { segment: 2, position: '000000000001' },
      ])
      expect(cursor.history(newTopic)).toEqual(['000000000001'])
      expect(cursor.stored(topicID)).toBe('000000000009')
      expect(records.size).toBe(0)
    },
  )

  test.each([
    { gated: false, name: 'stall notices flow without commit activity' },
    { gated: true, name: 'app delivery proceeds while a serial operation is gated' },
  ])('$name', async ({ gated }) => {
    const order: Array<string> = []
    let callbackCommit: Promise<unknown> | undefined
    let bob: TestPeer | undefined
    const seen = vi.fn()
    const f = await setup({
      handlers: { 'chat/posted': seen },
      onAppDeliveryStalled: (event) => {
        order.push(`stalled:${event.position}`)
        if (gated && callbackCommit == null && bob != null) {
          callbackCommit = track(bob.peer.commit(buildLedgerCommit(bob, [])))
          void callbackCommit.catch(() => {})
        }
      },
      onAppDeliveryResumed: (event) => {
        order.push(`resumed:${event.position}`)
      },
    })
    bob = f.bob
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let operation: Promise<unknown> | undefined
    const pause = gate()
    if (gated) {
      f.hub.controlGate = pause
      operation = track(f.bob.controlWalk.reconcileCommitPrefix())
      void operation.catch(() => {})
      await pause.entered.promise
      const frame = await append(f.hub)
      await f.lane.deliver()
      await vi.advanceTimersByTimeAsync(0)
      expect(seen).toHaveBeenCalledTimes(1)
      expect(f.rows.size).toBe(0)
      expect(f.bob.appCursorStore.stored(topicID)).toBe(frame.sequenceID)
    }
    const writer = createFakeCrypto({ epoch: 3, localDID: 'alice' })
    for (let i = 0; i < 200; i++) {
      const frame = await f.hub.publish({
        topicID,
        senderDID: 'alice',
        retain: 'log',
        payload: await writer.wrap(encodeEventFrame('chat/posted', {}), {
          aad: encodeAppAAD({ topicID, intent: 'log' }),
        }),
      })
      await f.lane.deliver()
      await f.lane.deliver()
      await Promise.resolve()
      expect(f.queue.pending).toBe(0)
      expect(f.queue.peak).toBeLessThanOrEqual(2)
      expect(order).toHaveLength(i * 2 + 1)
      expect(order.at(-1)).toBe(`stalled:${frame.sequenceID}`)
      await vi.advanceTimersByTimeAsync(30_000)
      if (gated) await f.lane.dropFrame(topicID, frame.sequenceID)
      await Promise.resolve()
      expect(f.queue.pending).toBe(0)
      expect(f.queue.peak).toBeLessThanOrEqual(2)
      expect(order).toHaveLength(i * 2 + 2)
      expect(order.at(-1)).toBe(`resumed:${frame.sequenceID}`)
    }
    pause.release.resolve()
    await operation
    await callbackCommit
    if (gated) expect(f.bob.mls.epoch()).toBe(2)
    expect(order).toHaveLength(400)
  })

  test('applied epoch follows authenticated walks and advancement despite display hints', async () => {
    const f = await setup()
    const epoch = f.params.appliedEpoch
    expect(epoch()).toBe(1)
    vi.spyOn(f.reader, 'epoch').mockReturnValue(80)
    await remoteCommit(f)
    expect(epoch()).toBe(2)
    await f.bob.peer.commit(buildLedgerCommit(f.bob, []))
    expect(epoch()).toBe(3)
  })

  test('departing-epoch frame delivers through retention', async () => {
    const seen = vi.fn()
    const f = await setup({ handlers: { 'chat/posted': seen } })
    await remoteCommit(f)
    await append(f.hub)
    await f.lane.deliver()
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1))
    await f.lane.deliver()
    expect(seen).toHaveBeenCalledTimes(1)
  })

  test('lag beyond retention leaves frames undelivered without a stall', async () => {
    const seen = vi.fn()
    const stalled = vi.fn()
    const f = await setup({ handlers: { 'chat/posted': seen }, onAppDeliveryStalled: stalled })
    for (const epoch of [1, 2, 3]) {
      await publishCommit({ hub: f.hub, senderDID: 'alice', recoverySecret: secret, epoch })
      await f.bob.controlWalk.reconcileCommitPrefix()
    }
    expect(f.bob.mls.epoch()).toBe(4)
    const frame = await append(f.hub)
    await f.lane.deliver()
    expect(f.bob.appCursorStore.stored(topicID)).toBe(frame.sequenceID)
    expect(seen).not.toHaveBeenCalled()
    expect(stalled).not.toHaveBeenCalled()
  })
})
