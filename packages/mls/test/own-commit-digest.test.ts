import { randomIdentity } from '@kokuin/token'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'
import { decode, encode, mlsMessageDecoder, mlsMessageEncoder } from 'ts-mls'
import { expect, test } from 'vitest'

import { createGroup } from '../src/group-create.js'
import { commitKeyRotation } from '../src/group-rotation.js'
import { ownCommitDigest } from '../src/index.js'

test('recognition hashes the complete re-encoded MLS commit without changing its bytes', async () => {
  const { group } = await createGroup(randomIdentity(), 'own-digest')
  const first = (await commitKeyRotation(group)).commitMessage
  const second = (await commitKeyRotation(group)).commitMessage
  const decoded = decode(mlsMessageDecoder, first)
  if (decoded === undefined) throw new Error('missing message')
  const canonical = encode(mlsMessageEncoder, decoded)
  const before = first.slice()
  expect(ownCommitDigest(first)).toBe(toB64U(sha256(canonical)))
  expect(ownCommitDigest(canonical)).toBe(ownCommitDigest(first))
  const reencoded = new Uint8Array([
    ...first.subarray(0, 4),
    0x40,
    first[4] ?? 0,
    ...first.subarray(5),
  ])
  expect(reencoded).not.toEqual(first)
  expect(ownCommitDigest(reencoded)).toBe(ownCommitDigest(first))
  expect(ownCommitDigest(second)).not.toBe(ownCommitDigest(first))
  expect(first).toEqual(before)
})

test('malformed and non-commit messages have no recognition digest', async () => {
  const { group } = await createGroup(randomIdentity(), 'own-digest-malformed')
  for (const bytes of [new Uint8Array(), new Uint8Array([1, 2, 3]), new Uint8Array(64).fill(255)])
    expect(ownCommitDigest(bytes)).toBeNull()
  expect(ownCommitDigest(await group.encrypt(new Uint8Array([42])))).toBeNull()
})
