import { keyPackageDigest } from '@kumiai/hub-protocol'
import { describe, expect, test } from 'vitest'

describe('keyPackageDigest', () => {
  // Pinned against a fixed vector, not against a second call to itself: client and server compare
  // digests across a wire, so the definition has to be a constant, not whatever the code does today.
  test('is lowercase hex SHA-256 of the string UTF-8 bytes', () => {
    expect(keyPackageDigest('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  test('distinguishes two stored packages', () => {
    expect(keyPackageDigest('kp-a')).not.toBe(keyPackageDigest('kp-b'))
  })

  test('is 64 hex characters', () => {
    expect(keyPackageDigest('kp')).toMatch(/^[0-9a-f]{64}$/)
  })
})
