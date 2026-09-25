import { fromUTF } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import { decodeAppAAD, encodeAppAAD } from '../src/app-aad.js'

describe('app frame authenticated data', () => {
  test('round-trips both intents with a version byte and UTF-8 topic', () => {
    for (const intent of ['ephemeral', 'log'] as const) {
      const topicID = '組合/room/🗝️'
      const encoded = encodeAppAAD({ topicID, intent })
      expect([...encoded.slice(0, 2)]).toEqual([1, intent === 'log' ? 1 : 0])
      expect(encoded.slice(2)).toEqual(fromUTF(topicID))
      expect(decodeAppAAD(encoded)).toEqual({ topicID, intent })
    }
  })

  test('distinct topics and intents cannot encode to the same AAD', () => {
    const values = [
      { topicID: '', intent: 'ephemeral' },
      { topicID: '', intent: 'log' },
      { topicID: '\0', intent: 'ephemeral' },
      { topicID: 'a', intent: 'ephemeral' },
      { topicID: 'a\0', intent: 'ephemeral' },
      { topicID: '組合', intent: 'ephemeral' },
    ] as const
    const encoded = values.map((value) => Buffer.from(encodeAppAAD(value)).toString('hex'))
    expect(new Set(encoded).size).toBe(values.length)
    // TextEncoder replaces a lone surrogate with U+FFFD. Refuse that source spelling or it
    // would collide with the literal replacement character's valid UTF-8 encoding.
    expect(() => encodeAppAAD({ topicID: '\ud800', intent: 'log' })).toThrow()
  })

  test('rejects old, unknown, truncated, and malformed AAD', () => {
    expect(decodeAppAAD(fromUTF('topic'))).toBeNull()
    expect(decodeAppAAD(new Uint8Array([1]))).toBeNull()
    expect(decodeAppAAD(new Uint8Array([2, 1, 97]))).toBeNull()
    expect(decodeAppAAD(new Uint8Array([1, 2, 97]))).toBeNull()
    expect(decodeAppAAD(new Uint8Array([1, 1, 0xff]))).toBeNull()
  })
})
