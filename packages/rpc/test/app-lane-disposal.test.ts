import { encodeEventFrame } from '@kumiai/broadcast'
import { expect, test } from 'vitest'

import {
  type AppCompletionCoverageSource,
  registerAppCompletionCoverage,
} from '../src/app-completion-coverage.js'
import { createAppLane } from '../src/app-lane.js'
import { testAppLaneParams } from './fixtures/app-lane.js'
import { completeTestRecord, createFakeCrypto } from './fixtures/fake-crypto.js'

test('disposing without a drain releases the lane from the shared completion service', () => {
  const key = { groupID: 'disposed-lane', incarnation: 1 }
  const params = testAppLaneParams({
    groupKey: key,
    mux: {} as never,
    appliedEpoch: () => 1,
    crypto: createFakeCrypto(),
    localDID: 'bob',
    protocols: {},
    retentionSeconds: 60,
    anchor: () => ({ epoch: 1, secret: new Uint8Array(32).fill(1) }),
    groupID: () => key.groupID,
  })
  const registrations = new Set<AppCompletionCoverageSource>()
  registerAppCompletionCoverage(params.completion, (source) => {
    registrations.add(source)
    return {
      advance: async () => {},
      unbind: () => {
        registrations.delete(source)
      },
    }
  })
  const first = createAppLane(params)
  expect(registrations.size).toBe(1)
  first.dispose()
  expect(registrations.size).toBe(0)
  const second = createAppLane(params)
  expect(registrations.size).toBe(1)
  second.dispose()
  second.releaseOpened()
  expect(registrations.size).toBe(0)
})

test('an in-flight handler completes after disposal without advancing an unbound registration', async () => {
  const key = { groupID: 'disposed-in-flight', incarnation: 1 }
  const record = completeTestRecord(
    {
      frame: { id: 'saved', topicID: 'chat', protocol: 'chat', segment: 1, position: '01' },
      payload: encodeEventFrame('posted', {}),
      senderDID: 'alice',
    },
    key,
    'posted',
    1,
  )
  const records = new Map([[record.frame.id, record]])
  const reader = createFakeCrypto({
    pending: {
      persistOpened: async (_state, saved) => {
        records.set(saved.frame.id, saved)
      },
      list: async () => [...records.values()],
      complete: async (id) => {
        records.delete(id)
      },
    },
  })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const failure = new AbortController()
  const params = testAppLaneParams({
    groupKey: key,
    mux: {} as never,
    appliedEpoch: () => 1,
    crypto: reader,
    localDID: 'bob',
    protocols: { chat: { posted: { type: 'event', retain: 'log' } } },
    retentionSeconds: 60,
    anchor: () => ({ epoch: 1, secret: new Uint8Array(32).fill(1) }),
    groupID: () => key.groupID,
    openedFailureSignal: failure.signal,
    deliver: async () => {
      entered.resolve()
      await release.promise
    },
  })
  let active = true
  registerAppCompletionCoverage(params.completion, () => ({
    advance: async () => {
      if (!active) {
        failure.abort(new Error('Disposed coverage advance'))
        throw failure.signal.reason
      }
    },
    unbind: () => {
      active = false
    },
  }))
  const lane = createAppLane(params)
  try {
    await lane.restore([record])
    lane.retryDelivery()
    await entered.promise
    lane.dispose()
    release.resolve()
    await expect(lane.idle()).resolves.toBeUndefined()
    expect(records.size).toBe(0)
    expect(lane.pendingRecords()).toEqual([])
  } finally {
    release.resolve()
    lane.dispose()
  }
})
