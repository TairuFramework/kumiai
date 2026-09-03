import { fromUTF } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import { deriveTopicID } from '../src/topic.js'

const secret = fromUTF('test-group-secret-material')

describe('deriveTopicID', () => {
  test('is deterministic for identical inputs', () => {
    expect(deriveTopicID(secret, 1, 'control')).toBe(deriveTopicID(secret, 1, 'control'))
  })

  test('returns a non-empty base64url string', () => {
    const id = deriveTopicID(secret, 1, 'control')
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
    expect(id).toMatch(/^[A-Za-z0-9_-]+={0,2}$/)
  })

  test('differs by epoch', () => {
    expect(deriveTopicID(secret, 1, 'control')).not.toBe(deriveTopicID(secret, 2, 'control'))
  })

  test('differs by label', () => {
    expect(deriveTopicID(secret, 1, 'control')).not.toBe(deriveTopicID(secret, 1, 'sync'))
  })

  test('differs by scope', () => {
    expect(deriveTopicID(secret, 1, 'sync')).not.toBe(
      deriveTopicID(secret, 1, 'sync', 'subgroup-a'),
    )
    expect(deriveTopicID(secret, 1, 'sync', 'a')).not.toBe(deriveTopicID(secret, 1, 'sync', 'b'))
  })

  test('differs by secret', () => {
    expect(deriveTopicID(secret, 1, 'control')).not.toBe(
      deriveTopicID(fromUTF('other-secret'), 1, 'control'),
    )
  })

  test('label/scope boundary is unambiguous', () => {
    // 'ab' + '' must not collide with 'a' + 'b'
    expect(deriveTopicID(secret, 1, 'ab', '')).not.toBe(deriveTopicID(secret, 1, 'a', 'b'))
  })

  test('valid derivations are unchanged (no rotation)', () => {
    expect(deriveTopicID(secret, 1, 'control')).toBe('oZs89MaXFLarS-d0ghsM-mvWa5XzRUawxpZtApDaCec')
  })

  test('rejects a NUL in the label', () => {
    expect(() => deriveTopicID(secret, 1, 'a\0b')).toThrow(/label/)
  })

  test('rejects a NUL in the scope', () => {
    expect(() => deriveTopicID(secret, 1, 'sync', 'a\0b')).toThrow(/scope/)
  })

  test('rejects a lone surrogate in the label', () => {
    expect(() => deriveTopicID(secret, 1, '\uD800')).toThrow(/label/)
  })

  test('rejects a lone surrogate in the scope', () => {
    expect(() => deriveTopicID(secret, 1, 'sync', '\uDC00')).toThrow(/scope/)
  })

  test('rejects a negative epoch', () => {
    expect(() => deriveTopicID(secret, -1, 'control')).toThrow(/epoch/)
  })

  test('rejects a non-integer epoch', () => {
    expect(() => deriveTopicID(secret, 1.5, 'control')).toThrow(/epoch/)
  })

  test('rejects an unsafe-integer epoch', () => {
    expect(() => deriveTopicID(secret, 2 ** 53, 'control')).toThrow(/epoch/)
  })

  test('treats +0 and -0 as the same epoch', () => {
    expect(deriveTopicID(secret, -0, 'control')).toBe(deriveTopicID(secret, 0, 'control'))
  })
})
