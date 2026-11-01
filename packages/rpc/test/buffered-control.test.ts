import { expect, test, vi } from 'vitest'

import { createBufferedControlIntake } from '../src/buffered-control.js'
import { bindControlBatch, type ControlBatchBinding, controlBatch } from '../src/control-batch.js'
import { checkedFetchResult } from '../src/log-delivery.js'
import { FAKE_BASE_SECRET } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { makeMLSPeer } from './fixtures/peer.js'

const key = { groupID: 'buffered-control', incarnation: 1 }
function page(generation: number, positions: Array<string>, after: string | null = null) {
  return {
    topicID: 'commits',
    after,
    generation,
    result: checkedFetchResult({
      messages: positions.map((sequenceID) => ({
        topicID: 'commits',
        sequenceID,
        senderDID: 'did:key:sender',
        payload: new Uint8Array([1]),
      })),
      head: positions.at(-1) ?? after,
      oldest: positions[0] ?? null,
      gap: true,
    }),
  }
}

test('buffered control intake preserves checked page order and generation', () => {
  const ready = vi.fn()
  const intake = createBufferedControlIntake({ key, ready })
  intake.reset(1)
  expect(intake.next()).toBeUndefined()
  const first = page(1, ['10', '2'])
  const second = page(1, ['20', '3'], '2')
  intake.offer(first)
  expect(ready).toHaveBeenCalledOnce()
  intake.offer(second)
  expect(ready).toHaveBeenCalledOnce()
  for (const [value, index] of [
    [first, 0],
    [first, 1],
    [second, 0],
    [second, 1],
  ] as const) {
    expect(intake.next()).toEqual({ page: value, index })
    expect(intake.next()?.page.result).toBe(value.result)
    expect(intake.next()?.page.result.gap).toBe(true)
    const position = value.result.messages[index]?.sequenceID
    if (position === undefined) throw new Error('Missing occurrence')
    intake.consumed({ generation: 1, topicID: 'wrong-topic', position })
    intake.consumed({ generation: 1, topicID: 'commits', position: 'unfetched' })
    expect(intake.next()).toEqual({ page: value, index })
    intake.consumed({ generation: 1, topicID: 'commits', position })
  }
  expect(intake.next()).toBeUndefined()
  expect(ready).toHaveBeenCalledTimes(4)
  intake.offer(page(1, []))
  expect(intake.next()).toBeUndefined()
  expect(ready).toHaveBeenCalledTimes(4)

  intake.offer(page(1, ['same']))
  intake.reset(2)
  const fresh = page(2, ['same'])
  intake.offer(fresh)
  intake.consumed({ generation: 1, topicID: 'commits', position: 'same' })
  intake.offer(page(1, ['stale']))
  intake.reset(1)
  expect(intake.next()).toEqual({ page: fresh, index: 0 })
  intake.consumed({ generation: 2, topicID: 'commits', position: 'same' })
  expect(intake.next()).toBeUndefined()
})

test('control coordination binds the original MLS once', () => {
  const mls = createMemoryGroupMLS()
  const binding: ControlBatchBinding = {
    key,
    run: async () => {
      throw new Error('Unused')
    },
  }
  expect(controlBatch(mls)).toBeUndefined()
  bindControlBatch(mls, binding)
  bindControlBatch(mls, binding)
  expect(controlBatch(mls)).toBe(binding)
  expect(controlBatch({ ...mls })).toBeUndefined()
  expect(() => bindControlBatch(mls, { ...binding })).toThrow('already has a control batch binding')
})

test.each(['group', 'incarnation'] as const)(
  'control coordination refuses a different key before source installation / %s',
  (part) => {
    const mls = createMemoryGroupMLS()
    const wrongKey = { ...mls.control().key }
    if (part === 'group') wrongKey.groupID = 'other'
    else wrongKey.incarnation++
    const run = vi.fn(async () => {
      throw new Error('Unused')
    })
    bindControlBatch(mls, { key: wrongKey, run })
    const hub = new FakeHub()
    const subscribe = vi.spyOn(hub, 'subscribe')
    const read = vi.spyOn(mls, 'readEpoch')
    expect(() => makeMLSPeer(hub, 'local', FAKE_BASE_SECRET, { mls })).toThrow(
      'Peer coordination key mismatch',
    )
    expect(subscribe).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  },
)

test('buffered control refuses unchecked coverage before readiness', () => {
  const ready = vi.fn()
  const intake = createBufferedControlIntake({ key, ready })
  const unchecked = page(0, ['1'])
  Reflect.deleteProperty(unchecked.result, 'gap')
  expect(() => intake.offer(unchecked)).toThrow('Commit fetch requires a boolean gap')
  expect(ready).not.toHaveBeenCalled()
  expect(intake.next()).toBeUndefined()
})
