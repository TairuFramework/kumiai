import type { DeviceRegistry } from '@kumiai/mls'
import { expect, test } from 'vitest'

import {
  decodeStoredValue,
  encodeStoredValue,
  openRecord,
  physicalRecordKey,
  recordAAD,
  sealRecord,
  topicLocator,
} from '../src/persistence-codec.js'
import type { AtRestCodec } from '../src/persistence-types.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'

test('binds sealed records to all address components and round trips nested MLS values', async () => {
  const address = { groupID: 'group-A', incarnation: 1, namespace: 'pending', recordID: 'frame-1' }
  const codec = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(97) })
  const value = { data: new Uint8Array([0, 1]), n: 0n, map: new Map([['leaf', 0]]) }
  const bytes = await sealRecord(codec, address, value)
  expect(await openRecord(codec, address, bytes)).toEqual(value)
  for (const wrong of [
    { ...address, groupID: 'group-B' },
    { ...address, incarnation: 2 },
    { ...address, namespace: 'outbox' },
    { ...address, recordID: 'frame-2' },
  ]) {
    await expect(openRecord(codec, wrong, bytes)).rejects.toThrow()
  }
  expect(new TextDecoder().decode(recordAAD(address))).toBe(
    '["kumiai/at-rest/v1","group-A",1,"pending","frame-1"]',
  )
  expect(await sealRecord(codec, address, { n: 0 })).toEqual(
    await sealRecord(codec, address, { n: 0 }),
  )
  expect(await topicLocator('topic-secret')).toMatch(/^[0-9a-f]{64}$/)
})

const address = { groupID: 'group-A', incarnation: 1, namespace: 'pending', recordID: 'frame-1' }
const codec = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(97) })

test('keeps physical identities unambiguous and hashes topics as UTF-8 SHA-256', async () => {
  expect(physicalRecordKey(address)).toBe('["group-A",1,"frame-1"]')
  expect(physicalRecordKey({ ...address, incarnation: null })).toBe('["group-A",null,"frame-1"]')
  expect(physicalRecordKey({ ...address, groupID: 'a/b', recordID: 'c' })).not.toBe(
    physicalRecordKey({ ...address, groupID: 'a', recordID: 'b/c' }),
  )
  expect(await topicLocator('abc')).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
})

test('preserves tags as user data, undefined, map keys, and non-zero-offset bytes', () => {
  const backing = new Uint8Array([99, 0, 1, 99])
  const value = {
    $type: 'bytes',
    nested: [undefined, null, false, '', 0, 0n],
    data: backing.subarray(1, 3),
    map: new Map<unknown, unknown>([[0n, new Map([['leaf', undefined]])]]),
  }
  const encoded = encodeStoredValue(value)
  const decoded = decodeStoredValue(encoded)
  expect(decoded).toEqual(value)
  backing.fill(7)
  expect(decoded).toEqual({ ...value, data: new Uint8Array([0, 1]) })
  expect(decodeStoredValue(encodeStoredValue({ ['__proto__']: { safe: true } }))).toEqual({
    ['__proto__']: { safe: true },
  })
})

test('preserves special numbers without silently converting them to null or zero', () => {
  expect(
    decodeStoredValue(
      encodeStoredValue([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0]),
    ),
  ).toEqual([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0])
})

test('rejects malformed UTF-8, JSON, and tagged nodes', () => {
  expect(() => decodeStoredValue(new Uint8Array([0xc3, 0x28]))).toThrow()
  expect(() => decodeStoredValue(new TextEncoder().encode('{'))).toThrow()
  for (const malformed of [
    null,
    ['unknown', 1],
    ['undefined', 1],
    ['scalar', {}],
    ['bytes', [256]],
    ['bytes', [-1]],
    ['bytes', [1.5]],
    ['bigint', '01'],
    ['bigint', 'no'],
    ['array', [null]],
    ['map', [['key']]],
    ['object', [[0, ['scalar', 1]]]],
    [
      'object',
      [
        ['key', ['scalar', 1]],
        ['key', ['scalar', 2]],
      ],
    ],
    ['scalar', 0, 'extra'],
  ]) {
    expect(() => decodeStoredValue(new TextEncoder().encode(JSON.stringify(malformed)))).toThrow()
  }
  expect(() => encodeStoredValue(() => {})).toThrow()
  expect(() => encodeStoredValue(Symbol('unsupported'))).toThrow()
  expect(() => encodeStoredValue(new Date(0))).toThrow()
})

test('serializes trust registries through the canonical registry codec', async () => {
  const registry: DeviceRegistry = {
    devices: new Map([['did:key:device', { controller: 'did:key:controller', status: 'active' }]]),
    controllers: new Map([['did:key:controller', { genFloor: 0, timeFloor: 0, recordedLog: [] }]]),
  }
  const trustAddress = { ...address, incarnation: null, namespace: 'trust', recordID: 'current' }
  const value = { registry, ledger: ['token'] }
  const bytes = await sealRecord(codec, trustAddress, value)
  expect(await openRecord(codec, trustAddress, bytes)).toEqual(value)
  expect(decodeStoredValue(await codec.open(bytes, recordAAD(trustAddress)))).toMatchObject({
    registry: expect.any(Uint8Array),
  })
  await expect(sealRecord(codec, trustAddress, { registry: {} })).rejects.toThrow()
  const malformed = await codec.seal(
    encodeStoredValue({ registry: new Uint8Array() }),
    recordAAD(trustAddress),
  )
  await expect(openRecord(codec, trustAddress, malformed)).rejects.toThrow()
})

test('copies buffers across the host codec boundary', async () => {
  const sealed = new Uint8Array([1, 2])
  let opened: Uint8Array = new Uint8Array()
  const host: AtRestCodec = {
    seal: async () => sealed,
    open: async (bytes) => {
      bytes.fill(99)
      return opened
    },
  }
  const stored = await sealRecord(host, address, { data: new Uint8Array([0, 1]) })
  sealed.fill(9)
  expect(stored).toEqual(new Uint8Array([1, 2]))
  opened = encodeStoredValue({ data: new Uint8Array([0, 1]) })
  const value = await openRecord(host, address, stored)
  opened.fill(9)
  expect(stored).toEqual(new Uint8Array([1, 2]))
  expect(value).toEqual({ data: new Uint8Array([0, 1]) })
})

test('test codec rejects tampering, wrong keys, and truncated ciphertext', async () => {
  const bytes = await sealRecord(codec, address, { data: new Uint8Array([0, 1]) })
  const tampered = bytes.slice()
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1
  await expect(openRecord(codec, address, tampered)).rejects.toThrow()
  await expect(openRecord(codec, address, bytes.subarray(0, 12))).rejects.toThrow()
  const wrong = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(98) })
  await expect(openRecord(wrong, address, bytes)).rejects.toThrow()
  expect(() => createDeterministicAtRestCodec({ key: new Uint8Array(31) })).toThrow()
  const key = new Uint8Array(32).fill(97)
  const owned = createDeterministicAtRestCodec({ key })
  key.fill(0)
  expect(await sealRecord(owned, address, { n: 0 })).toEqual(
    await sealRecord(codec, address, { n: 0 }),
  )
})
