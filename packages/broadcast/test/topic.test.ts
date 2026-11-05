import { fromUTF } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import { deriveTopicID } from '../src/topic.js'

const secret = fromUTF('test-group-secret-material')

describe('deriveTopicID', () => {
  test('is deterministic for identical inputs', () => {
    expect(deriveTopicID({ secret, epoch: 1, label: 'control' })).toBe(
      deriveTopicID({ secret, epoch: 1, label: 'control' }),
    )
  })

  test('returns a non-empty base64url string', () => {
    const id = deriveTopicID({ secret, epoch: 1, label: 'control' })
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
    expect(id).toMatch(/^[A-Za-z0-9_-]+={0,2}$/)
  })

  test('differs by epoch', () => {
    expect(deriveTopicID({ secret, epoch: 1, label: 'control' })).not.toBe(
      deriveTopicID({ secret, epoch: 2, label: 'control' }),
    )
  })

  test('differs by label', () => {
    expect(deriveTopicID({ secret, epoch: 1, label: 'control' })).not.toBe(
      deriveTopicID({ secret, epoch: 1, label: 'sync' }),
    )
  })

  test('differs by scope', () => {
    expect(deriveTopicID({ secret, epoch: 1, label: 'sync' })).not.toBe(
      deriveTopicID({ secret, epoch: 1, label: 'sync', scope: 'subgroup-a' }),
    )
    expect(deriveTopicID({ secret, epoch: 1, label: 'sync', scope: 'a' })).not.toBe(
      deriveTopicID({ secret, epoch: 1, label: 'sync', scope: 'b' }),
    )
  })

  test('differs by secret', () => {
    expect(deriveTopicID({ secret, epoch: 1, label: 'control' })).not.toBe(
      deriveTopicID({ secret: fromUTF('other-secret'), epoch: 1, label: 'control' }),
    )
  })

  test('label/scope boundary is unambiguous', () => {
    // 'ab' + '' must not collide with 'a' + 'b'
    expect(deriveTopicID({ secret, epoch: 1, label: 'ab', scope: '' })).not.toBe(
      deriveTopicID({ secret, epoch: 1, label: 'a', scope: 'b' }),
    )
  })

  test('valid derivations are unchanged (no rotation)', () => {
    expect(deriveTopicID({ secret, epoch: 1, label: 'control' })).toBe(
      'oZs89MaXFLarS-d0ghsM-mvWa5XzRUawxpZtApDaCec',
    )
  })

  test('rejects a NUL in the label', () => {
    expect(() => deriveTopicID({ secret, epoch: 1, label: 'a\0b' })).toThrow(/label/)
  })

  test('rejects a NUL in the scope', () => {
    expect(() => deriveTopicID({ secret, epoch: 1, label: 'sync', scope: 'a\0b' })).toThrow(/scope/)
  })

  test('rejects a lone surrogate in the label', () => {
    expect(() => deriveTopicID({ secret, epoch: 1, label: '\uD800' })).toThrow(/label/)
  })

  test('rejects a lone surrogate in the scope', () => {
    expect(() => deriveTopicID({ secret, epoch: 1, label: 'sync', scope: '\uDC00' })).toThrow(
      /scope/,
    )
  })

  test('rejects a negative epoch', () => {
    expect(() => deriveTopicID({ secret, epoch: -1, label: 'control' })).toThrow(/epoch/)
  })

  test('rejects a non-integer epoch', () => {
    expect(() => deriveTopicID({ secret, epoch: 1.5, label: 'control' })).toThrow(/epoch/)
  })

  test('rejects an unsafe-integer epoch', () => {
    expect(() => deriveTopicID({ secret, epoch: 2 ** 53, label: 'control' })).toThrow(/epoch/)
  })

  test('treats +0 and -0 as the same epoch', () => {
    expect(deriveTopicID({ secret, epoch: -0, label: 'control' })).toBe(
      deriveTopicID({ secret, epoch: 0, label: 'control' }),
    )
  })
})
