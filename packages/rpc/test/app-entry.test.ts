import * as broadcast from '@kumiai/broadcast'
import { encodeEventFrame, encodeFrame } from '@kumiai/broadcast'
import { expect, test, vi } from 'vitest'

import { decodeAppEntry } from '../src/app-entry.js'
import { InvalidAppEntryError } from '../src/app-frame.js'
import { type AppOutboxEntry, createAppOutboxAcceptance } from '../src/app-outbox.js'
import { createMemoryAppOutbox } from './fixtures/outbox.js'

const key = { groupID: 'app-entry', incarnation: 1 }
const identity = { ...key, epoch: 2, authenticator: new Uint8Array([7]) }
const store = () => createMemoryAppOutbox({ key, snapshot: () => ({ identity, stateVersion: 3 }) })
const entry = (data = encodeEventFrame('chat/posted', { text: 'hello' })): AppOutboxEntry => ({
  seq: 0,
  protocol: 'chat',
  prc: 'chat/posted',
  data,
  lastAttempt: null,
  status: 'accepted',
})

test('acceptance validates a broadcast v2 log event before writing', async () => {
  const outbox = store()
  const queue = createAppOutboxAcceptance({
    outbox,
    limit: 4,
    admission: () => ({ admissible: true, epoch: 2 }),
  })
  const input = { ...entry(), epoch: 2, incarnation: 1, at: Date.now() }
  await queue.accept(input)
  expect(decodeAppEntry(entry())).toEqual({ procedure: 'chat/posted', payload: { text: 'hello' } })
  expect(await outbox.list()).toEqual([entry()])
  expect(await outbox.events()).toMatchObject([{ kind: 'accepted', entry: { status: 'accepted' } }])
  queue.close()
})

test.each([undefined, null, false, 0, 'text'])(
  'absent event data decodes to an empty object (%s)',
  (data) => {
    expect(
      decodeAppEntry(entry(encodeFrame({ payload: { typ: 'event', prc: 'chat/posted', data } }))),
    ).toEqual({ procedure: 'chat/posted', payload: data ?? {} })
  },
)

test.each([
  [
    'UTF-8',
    new Uint8Array([
      ...new TextEncoder().encode('{"v":2,"payload":{"typ":"event","prc":"chat/posted","data":"'),
      255,
      ...new TextEncoder().encode('"}}'),
    ]),
  ],
  ['JSON', new TextEncoder().encode('{')],
  ['version', new TextEncoder().encode('{"v":1,"payload":{"typ":"event","prc":"chat/posted"}}')],
  ['event', encodeFrame({ payload: { typ: 'ctrl', prc: 'chat/posted' } })],
  ['procedure', encodeEventFrame('chat/other', {})],
])('invalid app plaintext never reaches storage (%s)', async (kind, data) => {
  const parser = vi.spyOn(broadcast, 'decodeFrame')
  const outbox = store()
  const queue = createAppOutboxAcceptance({
    outbox,
    limit: 4,
    admission: () => ({ admissible: true, epoch: 2 }),
  })
  await expect(queue.accept(entry(data))).rejects.toBeInstanceOf(InvalidAppEntryError)
  expect(await outbox.list()).toEqual([])
  expect(await outbox.events()).toEqual([])
  expect(await outbox.loadSettlement(0)).toBeNull()
  if (kind === 'UTF-8') expect(parser).not.toHaveBeenCalled()
  parser.mockRestore()
  queue.close()
})

test('outbox values cannot mutate stored plaintext or an obligated attempt', async () => {
  const outbox = store()
  const original = entry()
  await outbox.put(original)
  original.data.fill(0)
  const listed = await outbox.list()
  listed[0]?.data.fill(1)
  expect(await outbox.list()).toEqual([entry()])
  for (const changed of [{ protocol: 'other' }, { prc: 'other' }, { data: new Uint8Array([1]) }]) {
    await expect(outbox.put({ ...entry(), ...changed })).rejects.toThrow()
  }
  const attempted = {
    ...entry(),
    lastAttempt: {
      incarnation: 1,
      epoch: 2,
      floor: null,
      attempts: 1,
      publishID: 'first',
      segment: 2,
      topicID: 'topic',
    },
  }
  await outbox.put(attempted)
  await expect(
    outbox.recordSettlement(
      0,
      { sequenceID: 'position', attemptID: 'first', topicID: 'topic', outcome: 'published' },
      { identity, stateVersion: 3, attemptID: 'first' },
    ),
  ).resolves.toEqual({ recorded: true })
  await expect(
    outbox.put({ ...attempted, lastAttempt: { ...attempted.lastAttempt, publishID: 'second' } }),
  ).rejects.toThrow()
  expect(await outbox.list()).toEqual([attempted])
})

test('unknown remove and event acknowledgement are harmless', async () => {
  const outbox = store()
  await outbox.remove(99)
  await outbox.ackEvent('unknown')
  expect(await outbox.events()).toEqual([])
  await outbox.put(entry())
  const accepted = (await outbox.events())[0]
  if (accepted === undefined) throw new Error('Missing accepted event')
  await outbox.ackEvent(accepted.id)
  await outbox.ackEvent(accepted.id)
  await outbox.remove(0)
  const failed = await outbox.events()
  expect(failed).toMatchObject([{ kind: 'failed', reason: 'removed' }])
  await outbox.remove(0)
  expect(await outbox.events()).toEqual(failed)
})

test('clear preserves every entry when one has a settlement obligation', async () => {
  const outbox = store()
  await outbox.put(entry())
  const attempted = {
    ...entry(),
    seq: 1,
    lastAttempt: {
      incarnation: 1,
      epoch: 2,
      floor: null,
      attempts: 1,
      publishID: 'owed',
      segment: 2,
      topicID: 'topic',
    },
  }
  await outbox.put(attempted)
  const obligation = {
    sequenceID: 'accepted',
    attemptID: 'owed',
    topicID: 'topic',
    outcome: 'published' as const,
  }
  expect(
    await outbox.recordSettlement(1, obligation, { identity, stateVersion: 3, attemptID: 'owed' }),
  ).toEqual({ recorded: true })
  const rows = await outbox.list()
  const events = await outbox.events()
  await expect(outbox.clear()).rejects.toThrow()
  expect(await outbox.list()).toEqual(rows)
  expect(await outbox.events()).toEqual(events)
  expect(await outbox.loadSettlement(1)).toEqual(obligation)
})
