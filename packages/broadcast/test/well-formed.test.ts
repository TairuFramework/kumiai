import { describe, expect, test } from 'vitest'

import { deriveTopicID } from '../src/topic.js'
import { isWellFormedUTF16 } from '../src/well-formed.js'

describe('isWellFormedUTF16', () => {
  test.each([
    { name: 'empty string', value: '', expected: true },
    { name: 'ASCII', value: 'abc', expected: true },
    { name: 'surrogate pair', value: '😀', expected: true },
    { name: 'lone high surrogate', value: '\uD83D', expected: false },
    { name: 'trailing high surrogate', value: 'a\uD83D', expected: false },
    { name: 'leading low surrogate', value: '\uDE00a', expected: false },
    { name: 'reversed surrogate pair', value: '\uDE00\uD83D', expected: false },
  ])('$name', ({ value, expected }) => {
    expect(isWellFormedUTF16(value)).toBe(expected)
  })

  test.skipIf(typeof String.prototype.isWellFormed !== 'function')(
    'agrees with native validation for 2000 seeded strings',
    () => {
      const alphabet = String.fromCharCode(0x41, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xffff)
      let seed = 0x12345678
      const next = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return seed
      }
      for (let sample = 0; sample < 2000; sample++) {
        const length = next() % 7
        let value = ''
        for (let index = 0; index < length; index++) {
          value += alphabet.charAt(next() % alphabet.length)
        }
        expect(isWellFormedUTF16(value), JSON.stringify(value)).toBe(value.isWellFormed())
      }
    },
  )
})

test.each(['label', 'scope'] as const)(
  'deriveTopicID preserves the lone-surrogate %s error without native validation',
  (component) => {
    const descriptor = Object.getOwnPropertyDescriptor(String.prototype, 'isWellFormed')
    Object.defineProperty(String.prototype, 'isWellFormed', {
      configurable: true,
      value: undefined,
    })
    try {
      expect(() =>
        deriveTopicID(
          new Uint8Array([1]),
          0,
          component === 'label' ? '\uD83D' : 'chat',
          component === 'scope' ? '\uD83D' : '',
        ),
      ).toThrowError(
        new Error(`deriveTopicID: ${component} must be well-formed UTF-16 (no lone surrogates)`),
      )
    } finally {
      if (descriptor == null) Reflect.deleteProperty(String.prototype, 'isWellFormed')
      else Object.defineProperty(String.prototype, 'isWellFormed', descriptor)
    }
  },
)
