import { deriveTopicID } from '@kumiai/broadcast'
import type { StoredMessage } from '@kumiai/hub-protocol'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { copyCheckpointValue } from '../src/checkpoint.js'
import type { CheckpointRecord, CheckpointService } from '../src/checkpoint-types.js'
import { createCheckpointWorker } from '../src/checkpoint-worker.js'
import { createHubMux, type HubMux, type InboundListener } from '../src/hub-mux.js'
import { checkpointTopic, commitTopic } from '../src/topic.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'

const key = { groupID: 'checkpoint-worker', incarnation: 1 }
const recoverySecret = new Uint8Array(32).fill(7)
const workers: Array<ReturnType<typeof createCheckpointWorker>> = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10000)
})
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.dispose()))
  vi.useRealTimers()
})

function setup(count = 1) {
  let records: Array<CheckpointRecord> = Array.from({ length: count }, (_, i) => [
    {
      kind: 'fact' as const,
      id: `fact-${i}`,
      key,
      epoch: i,
      canonical: new Uint8Array([i]),
      supersededAt: i === count - 1 ? null : 10000,
    },
    {
      kind: 'publication' as const,
      id: `publication-${i}`,
      key,
      factID: `fact-${i}`,
      frame: null,
      publishID: null,
      accepted: false,
      nextHeartbeatAt: null,
    },
  ]).flat()
  let listener: InboundListener | undefined
  const release = vi.fn()
  const mux: Pick<HubMux, 'onInbound' | 'fetchTopic' | 'publish'> = {
    onInbound: vi.fn((_topic, callback) => {
      listener = callback
      return release
    }),
    fetchTopic: vi.fn(async () => ({ messages: [], head: null, oldest: null, gap: false })),
    publish: vi.fn(async () => ({ sequenceID: '1' })),
  }
  const service: CheckpointService = {
    signInstalled: vi.fn(async (id) => {
      const fact = records.find((row) => row.kind === 'fact' && row.id === id)
      const debt = records.find((row) => row.kind === 'publication' && row.factID === id)
      if (fact?.kind !== 'fact' || debt?.kind !== 'publication') return null
      debt.frame ??= new Uint8Array([fact.epoch])
      debt.publishID ??= crypto.randomUUID()
      return debt.frame.slice()
    }),
    compare: vi.fn(async () => ({ kind: 'invalid' as const })),
    exportCheckpoints: vi.fn(async () => []),
    checkpointFact: vi.fn(async () => null),
    checkpointCoverage: vi.fn(async () => ({
      groupID: key.groupID,
      current: null,
      retained: [],
      effectiveFloor: null,
      gaps: [],
    })),
    importCheckpoint: vi.fn(async () => {}),
    forkNotices: vi.fn(async () => []),
    ackForkNotice: vi.fn(async () => {}),
    events: vi.fn(async () => []),
    readRecords: vi.fn(async () => copyCheckpointValue(records)),
    updateRecords: vi.fn(async (change: Parameters<CheckpointService['updateRecords']>[0]) => {
      for (const row of change.put ?? []) {
        if (row.kind === 'cursor' && row.intake !== undefined)
          await service.importCheckpoint(row.key, row.intake)
      }
      records = records.filter(
        (row) =>
          !change.remove?.includes(row.id) && !change.put?.some((next) => next.id === row.id),
      )
      records.push(
        ...copyCheckpointValue(change.put ?? []).map((row) => {
          if (row.kind === 'cursor') delete row.intake
          return row
        }),
      )
    }),
  }
  const create = () => {
    const worker = createCheckpointWorker({
      key,
      mux,
      recoverySecret,
      checkpoints: service,
      networkAllowed: () => true,
      now: Date.now,
      random: () => 0.5,
    })
    workers.push(worker)
    return worker
  }
  return {
    create,
    mux,
    service,
    release,
    records: () => copyCheckpointValue(records),
    wake(message = frame(1)) {
      const ack = vi.fn()
      listener?.(message, ack)
      return ack
    },
  }
}

function required<TValue>(value: TValue | undefined | null): TValue {
  if (value == null) throw new Error('Missing test value')
  return value
}

function frame(index: number, length = 4096): StoredMessage {
  const payload = new Uint8Array(length)
  new DataView(payload.buffer).setUint32(0, index)
  return {
    sequenceID: String(index).padStart(8, '0'),
    topicID: checkpointTopic(recoverySecret),
    senderDID: 'remote',
    payload,
  }
}

test('installation debt is never coalesced', async () => {
  const f = setup(12)
  await f.create().start()
  expect(f.mux.publish).toHaveBeenCalledTimes(8)
  await vi.advanceTimersByTimeAsync(999)
  expect(f.mux.publish).toHaveBeenCalledTimes(8)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.mux.publish).toHaveBeenCalledTimes(9)
  await vi.advanceTimersByTimeAsync(3000)
  expect(f.mux.publish).toHaveBeenCalledTimes(12)
  expect(new Set(vi.mocked(f.mux.publish).mock.calls.map(([row]) => row.payload[0])).size).toBe(12)
})

test('idle restart refills no more than one burst', async () => {
  const f = setup(20)
  const worker = f.create()
  await worker.start()
  await worker.dispose()
  vi.setSystemTime(Date.now() + 60000)
  await f.create().start()
  expect(f.mux.publish).toHaveBeenCalledTimes(16)
})

test('only the current installation gets heartbeats', async () => {
  const f = setup(2)
  await f.create().start()
  await vi.advanceTimersByTimeAsync(1800000)
  expect(f.mux.publish).toHaveBeenCalledTimes(3)
  expect(vi.mocked(f.mux.publish).mock.calls[2]?.[0].payload).toEqual(new Uint8Array([1]))
})

test('heartbeat deadline persists across restart', async () => {
  const f = setup()
  const first = f.create()
  await first.start()
  const debt = f.records().find((row) => row.kind === 'publication')
  if (debt?.kind !== 'publication') throw new Error('Missing debt')
  expect(required(debt.nextHeartbeatAt) - Date.now()).toBeGreaterThanOrEqual(1440000)
  expect(required(debt.nextHeartbeatAt) - Date.now()).toBeLessThanOrEqual(2160000)
  const saved = vi.mocked(f.mux.publish).mock.calls[0]?.[0]
  await first.dispose()
  vi.setSystemTime(required(debt.nextHeartbeatAt) - 1)
  const beforeDeadline = f.create()
  await beforeDeadline.start()
  expect(f.mux.publish).toHaveBeenCalledTimes(1)
  expect(f.records().find((row) => row.kind === 'publication')).toMatchObject({
    nextHeartbeatAt: debt.nextHeartbeatAt,
  })
  await beforeDeadline.dispose()
  vi.setSystemTime(required(debt.nextHeartbeatAt) + 10000000)
  await f.create().start()
  expect(f.mux.publish).toHaveBeenCalledTimes(2)
  const heartbeat = vi.mocked(f.mux.publish).mock.calls[1]?.[0]
  expect(heartbeat?.payload).toEqual(saved?.payload)
  expect(heartbeat?.publishID).not.toBe(saved?.publishID)
  expect(f.service.signInstalled).toHaveBeenCalledTimes(1)
})

test('ambiguous handoff retries identical frame and ID', async () => {
  const f = setup()
  vi.mocked(f.mux.publish).mockRejectedValueOnce(new Error('accepted then disconnected'))
  const worker = f.create()
  await worker.start()
  const saved = vi.mocked(f.mux.publish).mock.calls[0]?.[0]
  await worker.dispose()
  await f.create().start()
  expect(f.mux.publish).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1000)
  const retry = vi.mocked(f.mux.publish).mock.calls[1]?.[0]
  expect(retry?.payload).toEqual(saved?.payload)
  expect(retry?.publishID).toBe(saved?.publishID)
})

test('flood yields after bounded verification', async () => {
  const f = setup(0)
  const messages = Array.from({ length: 80 }, (_, i) => frame(i + 1))
  vi.mocked(f.mux.fetchTopic).mockResolvedValue({
    messages,
    head: '00000080',
    oldest: '00000001',
    gap: false,
  })
  await f.create().start()
  const framesProcessed = vi.mocked(f.service.importCheckpoint).mock.calls.length
  const bytesProcessed = vi
    .mocked(f.service.importCheckpoint)
    .mock.calls.reduce((sum, [, bytes]) => sum + bytes.length, 0)
  const signatureChecks = framesProcessed * 2
  expect(framesProcessed).toBe(32)
  expect(framesProcessed).toBeLessThanOrEqual(32)
  expect(bytesProcessed).toBeLessThanOrEqual(131072)
  expect(signatureChecks).toBeLessThanOrEqual(64)
  expect(f.service.signInstalled).not.toHaveBeenCalled()
})

test('checkpoint traffic never moves commit head', async () => {
  const f = setup()
  await f.create().start()
  expect(checkpointTopic(recoverySecret)).toBe(
    deriveTopicID(recoverySecret, 0, 'kumiai/checkpoint/v1', ''),
  )
  expect(f.mux.onInbound).toHaveBeenCalledWith(
    checkpointTopic(recoverySecret),
    expect.any(Function),
    { retention: 604800 },
  )
  expect(vi.mocked(f.mux.onInbound).mock.invocationCallOrder[0]).toBeLessThan(
    required(vi.mocked(f.mux.fetchTopic).mock.invocationCallOrder[0]),
  )
  const sent = vi.mocked(f.mux.publish).mock.calls[0]?.[0]
  expect(sent).toMatchObject({ topicID: checkpointTopic(recoverySecret), retain: 'log' })
  expect(sent).not.toHaveProperty('expectedHead')
  expect(sent?.topicID).not.toBe(commitTopic(recoverySecret))
  expect(f.wake()).toHaveBeenCalledOnce()
  expect(f.records().find((row) => row.kind === 'cursor')).toMatchObject({ position: null })
  await vi.advanceTimersByTimeAsync(1)
  expect(f.mux.fetchTopic).toHaveBeenCalledTimes(2)
})

test('checkpoint outage leaves ordinary sends open', async () => {
  const f = setup(0)
  vi.mocked(f.mux.fetchTopic).mockRejectedValue(new Error('offline'))
  const worker = f.create()
  await expect(worker.start()).resolves.toBeUndefined()
  f.wake()
  await worker.resume()
  expect(f.service.signInstalled).not.toHaveBeenCalled()
  expect(f.records().some((row) => row.kind === 'notice')).toBe(false)
})

test('backwards clock and reconnect storm preserve budgets', async () => {
  const f = setup(12)
  const worker = f.create()
  await worker.start()
  const fetches = vi.mocked(f.mux.fetchTopic).mock.calls.length
  vi.setSystemTime(0)
  for (let i = 0; i < 100; i++) {
    f.wake()
    await worker.resume()
  }
  expect(f.mux.publish).toHaveBeenCalledTimes(8)
  expect(f.mux.fetchTopic).toHaveBeenCalledTimes(fetches)
  await worker.dispose()
  await f.create().start()
  expect(f.mux.publish).toHaveBeenCalledTimes(8)
  expect(f.mux.fetchTopic).toHaveBeenCalledTimes(fetches)
})

test('cursor advances only after proven import and rejects oversized positions', async () => {
  const f = setup(0)
  vi.mocked(f.mux.fetchTopic).mockResolvedValue({
    messages: [frame(1)],
    head: '00000001',
    oldest: '00000001',
    gap: false,
  })
  vi.mocked(f.service.importCheckpoint).mockRejectedValueOnce(new Error('persistence failed'))
  await f.create().start()
  expect(f.records().find((row) => row.kind === 'cursor')).toMatchObject({ position: null })
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.records().find((row) => row.kind === 'cursor')).toMatchObject({ position: '00000001' })
  vi.mocked(f.mux.fetchTopic).mockResolvedValue({
    messages: [{ ...frame(2), sequenceID: 'z'.repeat(65) }],
    head: null,
    oldest: null,
    gap: false,
  })
  f.wake()
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.records().find((row) => row.kind === 'cursor')).toMatchObject({ position: '00000001' })
})

test('checkpoint worker shares one receive channel', async () => {
  const hub = new DurableFakeHub()
  const receive = vi.spyOn(hub, 'receive')
  const mux = createHubMux({ hub, localDID: 'local' })
  const ordinary = vi.fn((_message: StoredMessage, ack: () => void) => ack())
  for (const topic of ['commit', 'app', 'rendezvous']) mux.onInbound(topic, ordinary)
  const f = setup(0)
  const worker = createCheckpointWorker({
    key,
    mux,
    recoverySecret,
    checkpoints: f.service,
    now: Date.now,
    random: () => 0.5,
    networkAllowed: () => true,
  })
  workers.push(worker)
  let finishRead = () => {}
  let finishFetch = () => {}
  try {
    vi.mocked(f.service.readRecords).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = () => resolve([])
        }),
    )
    const starting = worker.start()
    for (const topicID of ['commit', 'app', 'rendezvous'])
      await hub.publish({
        topicID,
        senderDID: 'remote',
        payload: new Uint8Array([1]),
        retain: 'log',
      })
    await vi.advanceTimersByTimeAsync(1)
    expect(ordinary).toHaveBeenCalledTimes(3)
    finishRead()
    await starting
    vi.spyOn(mux, 'fetchTopic').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFetch = () => resolve({ messages: [], head: null, oldest: null, gap: false })
        }),
    )
    await hub.publish({
      topicID: checkpointTopic(recoverySecret),
      senderDID: 'remote',
      payload: new Uint8Array([1]),
      retain: 'log',
    })
    await vi.advanceTimersByTimeAsync(1)
    let drained = false
    const disposal = worker.dispose().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    for (const topicID of ['commit', 'app', 'rendezvous'])
      await hub.publish({
        topicID,
        senderDID: 'remote',
        payload: new Uint8Array([2]),
        retain: 'log',
      })
    await vi.advanceTimersByTimeAsync(1)
    expect(receive).toHaveBeenCalledTimes(1)
    expect(ordinary).toHaveBeenCalledTimes(6)
    finishFetch()
    await disposal
    for (const topicID of ['commit', 'app', 'rendezvous'])
      await hub.publish({
        topicID,
        senderDID: 'remote',
        payload: new Uint8Array([3]),
        retain: 'log',
      })
    await vi.advanceTimersByTimeAsync(1)
    expect(ordinary).toHaveBeenCalledTimes(9)
  } finally {
    finishRead()
    finishFetch()
    await worker.dispose()
    await mux.dispose()
  }
})

test('failed handoffs retry exponentially with a fifteen second cap', async () => {
  const f = setup()
  const attempts: Array<number> = []
  vi.mocked(f.mux.publish).mockImplementation(async () => {
    attempts.push(Date.now())
    throw new Error('offline')
  })
  await f.create().start()
  await vi.advanceTimersByTimeAsync(60000)
  expect(attempts.slice(0, 7).map((at) => at - 10000)).toEqual([
    0, 1000, 3000, 7000, 15000, 30000, 45000,
  ])
  const calls = vi.mocked(f.mux.publish).mock.calls.map(([row]) => row)
  expect(new Set(calls.map((row) => row.publishID)).size).toBe(1)
  expect(calls.every((row) => row.payload[0] === 0)).toBe(true)
})

test('duplicate and oversized frames consume no new signature work', async () => {
  const f = setup(0)
  const first = frame(1)
  const duplicate = { ...first, sequenceID: '00000002' }
  const oversize = frame(3, 4097)
  vi.mocked(f.mux.fetchTopic).mockResolvedValue({
    messages: [first, duplicate, oversize],
    head: '00000003',
    oldest: '00000001',
    gap: false,
  })
  await f.create().start()
  expect(f.service.importCheckpoint).toHaveBeenCalledTimes(1)
  expect(f.records().find((row) => row.kind === 'cursor')).toMatchObject({ position: '00000003' })
})

test('disposal drains in-flight work and fences late service calls', async () => {
  const f = setup()
  let finish = () => {}
  vi.mocked(f.mux.publish).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ sequenceID: '1' })
      }),
  )
  const worker = f.create()
  const starting = worker.start()
  for (let i = 0; i < 100 && vi.mocked(f.mux.publish).mock.calls.length === 0; i++)
    await Promise.resolve()
  expect(f.mux.publish).toHaveBeenCalledOnce()
  let drained = false
  const disposal = worker.dispose().then(() => {
    drained = true
  })
  const calls = vi.mocked(f.service.updateRecords).mock.calls.length
  await Promise.resolve()
  expect(drained).toBe(false)
  finish()
  await disposal
  await starting
  f.wake()
  await worker.resume()
  await vi.advanceTimersByTimeAsync(10000)
  expect(f.release).toHaveBeenCalledOnce()
  expect(f.service.updateRecords).toHaveBeenCalledTimes(calls)
  expect(f.mux.fetchTopic).not.toHaveBeenCalled()
})

test('network admission fences subscription signing and handoff', async () => {
  const f = setup()
  let allowed = false
  const networkAllowed = vi.fn(() => allowed)
  const worker = createCheckpointWorker({
    key,
    mux: f.mux,
    recoverySecret,
    checkpoints: f.service,
    now: Date.now,
    random: () => 0.5,
    networkAllowed,
  })
  workers.push(worker)
  await worker.start()
  expect(f.mux.onInbound).not.toHaveBeenCalled()
  expect(f.service.signInstalled).not.toHaveBeenCalled()
  allowed = true
  await worker.resume()
  expect(f.mux.publish).toHaveBeenCalledOnce()
  f.wake()
  allowed = false
  await vi.advanceTimersByTimeAsync(3000)
  expect(networkAllowed.mock.calls.length).toBeLessThanOrEqual(80)
  expect(f.mux.publish).toHaveBeenCalledOnce()
})

test('provider failures back off without a busy loop', async () => {
  const f = setup()
  const worker = f.create()
  await worker.start()
  vi.mocked(f.service.readRecords).mockRejectedValue(new Error('provider unavailable'))
  f.wake()
  await vi.advanceTimersByTimeAsync(3000)
  expect(vi.mocked(f.service.readRecords).mock.calls.length).toBeLessThanOrEqual(8)
})

test('a new installation after a clock rewind keeps the saved clock floor', async () => {
  const f = setup()
  const worker = f.create()
  await worker.start()
  const previous = f.records().find((row) => row.kind === 'publication')
  if (previous?.kind !== 'publication') throw new Error('Missing publication')
  vi.setSystemTime(0)
  await f.service.updateRecords({
    put: [
      {
        kind: 'fact',
        id: 'new-fact',
        key,
        epoch: 1,
        canonical: new Uint8Array([1]),
        supersededAt: null,
      },
      {
        ...previous,
        id: 'new-publication',
        factID: 'new-fact',
        accepted: false,
        frame: null,
        publishID: null,
        nextHeartbeatAt: null,
      },
    ],
  })
  await worker.resume()
  expect(f.mux.publish).toHaveBeenCalledTimes(2)
  const next = f.records().find((row) => row.id === 'new-publication')
  expect(next).toMatchObject({ nextHeartbeatAt: previous.nextHeartbeatAt })
})
