import { encodeEventFrame } from '@kumiai/broadcast'
import { expect, test } from 'vitest'

import {
  appFrameIdempotencyKey,
  decodeAppEventPlaintext,
  isAppLogPosition,
  RETAINED_EPOCHS_DEFAULT,
  RETAINED_EPOCHS_MAX,
} from '../src/index.js'

test('decodes the canonical event frame', () => {
  expect(decodeAppEventPlaintext(encodeEventFrame('posted', { text: 'hi' }))).toEqual({
    procedure: 'posted',
    data: { text: 'hi' },
  })
  expect(
    decodeAppEventPlaintext(
      new TextEncoder().encode('{"v":2,"payload":{"typ":"event","prc":"posted"}}'),
    ),
  ).toEqual({ procedure: 'posted', data: {} })
})

test('refuses every malformed envelope', () => {
  const malformed = [
    'not JSON',
    'null',
    '[]',
    '42',
    { payload: { typ: 'event', prc: 'posted' } },
    { v: 1, payload: { typ: 'event', prc: 'posted' } },
    { v: 3, payload: { typ: 'event', prc: 'posted' } },
    { v: 2 },
    { v: 2, payload: null },
    { v: 2, payload: [] },
    { v: 2, payload: 'event' },
    { v: 2, payload: { typ: 'request', prc: 'posted' } },
    { v: 2, payload: { typ: 'event' } },
    { v: 2, payload: { typ: 'event', prc: '' } },
    { v: 2, payload: { typ: 'event', prc: 42 } },
    { v: 2, payload: { typ: 'event', prc: '\ud800' } },
    { v: 2, payload: { typ: 'event', prc: '\udc00' } },
    { v: 2, payload: { typ: 'event', prc: 'posted', data: [] } },
    { v: 2, payload: { typ: 'event', prc: 'posted', data: null } },
    { v: 2, payload: { typ: 'event', prc: 'posted', data: 'hi' } },
  ]
  for (const value of malformed) {
    const json = typeof value === 'string' ? value : JSON.stringify(value)
    expect(decodeAppEventPlaintext(new TextEncoder().encode(json)), json).toBeNull()
  }
  expect(decodeAppEventPlaintext(new Uint8Array([0xff]))).toBeNull()
  const prefix = new TextEncoder().encode('{"v":2,"payload":{"typ":"event","prc":"')
  const suffix = new TextEncoder().encode('"}}')
  expect(decodeAppEventPlaintext(new Uint8Array([...prefix, 0xff, ...suffix]))).toBeNull()
})

test('frame key is the spec tuple', () => {
  expect(
    appFrameIdempotencyKey({
      groupID: 'g',
      incarnation: 2,
      topicID: 't',
      position: '10',
      protocol: 'chat',
      procedure: 'posted',
    }),
  ).toBe(JSON.stringify(['kumiai/frame/v1', 'g', 2, 't', '10', 'chat', 'posted']))
})

test('app positions share the fetched bound', () => {
  expect(isAppLogPosition('x')).toBe(true)
  expect(isAppLogPosition('000000000042')).toBe(true)
  expect(isAppLogPosition('x'.repeat(64))).toBe(true)
  expect(isAppLogPosition('')).toBe(false)
  expect(isAppLogPosition(42)).toBe(false)
  expect(isAppLogPosition('x'.repeat(65))).toBe(false)
})

test('retention constants', () => {
  expect(RETAINED_EPOCHS_DEFAULT).toBe(4)
  expect(RETAINED_EPOCHS_MAX).toBe(32)
})
