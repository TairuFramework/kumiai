import { encodeEventFrame } from '@kumiai/broadcast'
import { expect, test, vi } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import type { AppBatchBinding } from '../src/app-batch.js'
import { createAppLane } from '../src/app-lane.js'
import type { PendingAppFrame } from '../src/crypto.js'
import { APP_TOPIC_LABEL, protocolTopic } from '../src/topic.js'
import { testAppLaneParams } from './fixtures/app-lane.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { chat } from './fixtures/peer.js'

test('overlapping drains keep later arrivals behind the owned topic suffix', async () => {
  const key = { groupID: 'group', incarnation: 1 }
  const anchor = { epoch: 1, secret: fakeEpochSecret(1, APP_TOPIC_LABEL) }
  const topicID = protocolTopic(anchor.secret, anchor.epoch, 'chat')
  const records = new Map<string, PendingAppFrame>()
  const reader = createFakeCrypto({
    epoch: 1,
    localDID: 'bob',
    pending: {
      persistOpened: async (_state, record) => {
        records.set(record.frame.id, record)
      },
      list: async () => [...records.values()],
      complete: async (id) => {
        records.delete(id)
      },
    },
  })
  const sender = createFakeCrypto({ epoch: 1, localDID: 'alice' })
  const messages: Array<{ sequenceID: string; payload: Uint8Array }> = []
  const append = async (sequenceID: string) => {
    messages.push({
      sequenceID,
      payload: await sender.wrap(encodeEventFrame('chat/posted', { sequenceID }), {
        aad: encodeAppAAD({ topicID, intent: 'log' }),
      }),
    })
  }
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const opened: Array<string> = []
  const fetch = vi.fn(async ({ after }: { after?: string }) => ({
    messages: messages.filter((frame) => after == null || frame.sequenceID > after),
    head: messages.at(-1)?.sequenceID ?? null,
    oldest: messages[0]?.sequenceID ?? null,
    gap: false,
  }))
  const batch: AppBatchBinding = {
    key,
    scheduler: {
      schedule: (work) => {
        let taken = false
        return work.run({
          maxFrames: 1,
          maxWorkMs: 8,
          now: Date.now,
          begin() {},
          take() {
            if (taken) return false
            taken = true
            return true
          },
        })
      },
      close() {},
    },
    async openReady(inputs, budget) {
      const input = inputs[0]
      if (input === undefined || !budget.take()) throw new Error('Missing input')
      opened.push(input.frame.position)
      if (opened.length === 1) {
        expect(inputs.map((item) => item.frame.position)).toEqual(['1', '2'])
        started.resolve()
        await release.promise
      }
      await reader.unwrap(input.ciphertext, { frame: input.frame, expectedAAD: input.expectedAAD })
      const record = records.get(input.frame.id)
      if (record === undefined) throw new Error('Missing saved record')
      return { consumed: 1, results: [{ kind: 'opened', record, handleEpoch: 1 }] }
    },
  }
  const lane = createAppLane(
    testAppLaneParams({
      groupKey: key,
      mux: { retainTopic() {}, fetchTopic: fetch } as never,
      appliedEpoch: () => 1,
      crypto: reader,
      batch,
      localDID: 'bob',
      protocols: { chat },
      retentionSeconds: 60,
      anchor: () => anchor,
      groupID: () => key.groupID,
    }),
  )
  let first: Promise<void> | undefined
  try {
    await append('1')
    await append('2')
    first = lane.deliver()
    await started.promise
    await append('3')
    await lane.deliver()
    expect(fetch.mock.calls.some(([request]) => request.after === '2')).toBe(true)
    release.resolve()
    await first
    expect(opened).toEqual(['1', '2', '3'])
  } finally {
    release.resolve()
    await first
    lane.dispose()
  }
})
