import { createHash } from 'node:crypto'
import { randomIdentity } from '@kokuin/token'
import { ed25519 } from '@noble/curves/ed25519.js'
import { canonicalStringify, toB64U } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import {
  checkpointAuthHash,
  checkpointGenesisHash,
  checkpointKeyHash,
  checkpointSignatureInput,
  decodeEpochCheckpoint,
  decodeEpochRosterFact,
  type EpochCheckpointBodyV1,
  type EpochRosterFactV1,
  encodeEpochCheckpoint,
  encodeEpochRosterFact,
  verifyCheckpointPair,
} from '../src/index.js'

const utf8 = new TextEncoder()
const alice = randomIdentity()
const bob = randomIdentity()
const genesisHash = 'Zoa3EWqTcgHjSYgGxQlb5dLU-tn72n_sh2-1NFPkTgY'
const authHash = 'HxC91w3uF9m5nlj7LEcIYMRaqdGhcez1HIrNsBydpa8'
const otherHash = toB64U(new Uint8Array(32).fill(42))

// Independent reference encoder, including both length fields.
function u32(n: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, n)
  return bytes
}
function lp(bytes: Uint8Array): Uint8Array {
  return new Uint8Array([...u32(bytes.length), ...bytes])
}
function signatureInput(bytes: Uint8Array): Uint8Array {
  return new Uint8Array([...utf8.encode('kumiai/checkpoint-signature/v1'), 0, ...lp(bytes)])
}
function rawFrame(bytes: Uint8Array, signature = new Uint8Array(64)): Uint8Array {
  return new Uint8Array([1, 1, ...u32(bytes.length + 68), ...lp(bytes), ...signature])
}
function body(overrides: Partial<EpochCheckpointBodyV1> = {}): EpochCheckpointBodyV1 {
  return {
    v: 1,
    type: 'kumiai/checkpoint/v1',
    groupID: 'group',
    genesisHash,
    ciphersuite: 1,
    epoch: 4294967297,
    authHash,
    parentAuthHash: null,
    keyHash: checkpointKeyHash(alice.publicKey),
    leafIndex: 0,
    ...overrides,
  }
}
function fact(overrides: Partial<EpochRosterFactV1> = {}): EpochRosterFactV1 {
  return {
    v: 1,
    key: { groupID: 'group', incarnation: 0 },
    genesisHash,
    ciphersuite: 1,
    epoch: 4294967297,
    authHash,
    parentAuthHash: null,
    confirmedTranscriptHash: '',
    members: [alice, bob].map((identity, leafIndex) => ({
      signerDID: identity.id,
      keyHash: checkpointKeyHash(identity.publicKey),
      leafIndex,
      signaturePublicKey: toB64U(identity.publicKey),
    })),
    installation: { mutationID: 'install-genesis', stateVersion: 1 },
    ...overrides,
  }
}
function signed(value = body(), privateKey = alice.privateKey): Uint8Array {
  const bytes = utf8.encode(canonicalStringify(value))
  return encodeEpochCheckpoint(value, ed25519.sign(signatureInput(bytes), privateKey))
}
function pair(overrides = {}) {
  return {
    first: signed(),
    second: signed(body({ authHash: otherHash })),
    localRosterFact: encodeEpochRosterFact(fact()),
    ...overrides,
  }
}

describe('canonical checkpoints', () => {
  test('canonical checkpoint domains round trip', () => {
    expect(checkpointGenesisHash(new Uint8Array([0, 1, 255]))).toBe(genesisHash)
    expect(
      checkpointAuthHash({
        groupID: 'group',
        genesisHash,
        epoch: 4294967297,
        epochAuthenticator: new Uint8Array([2, 3]),
      }),
    ).toBe(authHash)
    const publicKey = new Uint8Array(32).fill(7)
    const keyReference = createHash('sha256')
      .update(new Uint8Array([...utf8.encode('kumiai/checkpoint-key/v1'), 0, ...lp(publicKey)]))
      .digest('base64url')
    expect(checkpointKeyHash(publicKey)).toBe(keyReference)
    const value = body({ keyHash: toB64U(publicKey) })
    const text = `{"authHash":"${authHash}","ciphersuite":1,"epoch":4294967297,"genesisHash":"${genesisHash}","groupID":"group","keyHash":"${toB64U(publicKey)}","leafIndex":0,"parentAuthHash":null,"type":"kumiai/checkpoint/v1","v":1}`
    const bytes = utf8.encode(text)
    expect(checkpointSignatureInput(value)).toEqual(signatureInput(bytes))
    const signature = ed25519.sign(signatureInput(bytes), new Uint8Array(32).fill(7))
    expect(Buffer.from(signature).toString('hex')).toBe(
      '6c7f480682a15ae5e807f02cae4596dbb636bdc55da68e14051f0e3c7de76ff4f2a9b16b8ba542f5c5c87dfed4bcfa664d15a571867f32921e856907c0fc4206',
    )
    const frame = encodeEpochCheckpoint(value, signature)
    expect(frame).toEqual(rawFrame(bytes, signature))
    expect(decodeEpochCheckpoint(frame)).toEqual({ body: value, bodyBytes: bytes, signature })
    const decoded = decodeEpochCheckpoint(frame)
    decoded.bodyBytes.fill(0)
    decoded.signature.fill(0)
    expect(frame).toEqual(rawFrame(bytes, signature))
  })

  test.each(['bodyBytes', 'signature'] as const)(
    'decoded %s mutations preserve the Buffer-backed frame',
    (field) => {
      const frame = signed()
      const backing = Buffer.alloc(frame.length + 16, 0xa5)
      const view = backing.subarray(7, 7 + frame.length)
      view.set(frame)
      const original = new Uint8Array(backing)
      const decoded = decodeEpochCheckpoint(view)

      decoded[field].fill(0)

      expect(new Uint8Array(backing)).toEqual(original)
      expect(decoded[field].constructor).toBe(Uint8Array)
    },
  )

  test.each(['bodyBytes', 'signature'] as const)(
    'Buffer-backed frame mutations preserve decoded %s',
    (field) => {
      const frame = signed()
      const backing = Buffer.alloc(frame.length + 16, 0xa5)
      const view = backing.subarray(7, 7 + frame.length)
      view.set(frame)
      const decoded = decodeEpochCheckpoint(view)
      const original = new Uint8Array(decoded[field])

      view.fill(0)

      expect(decoded[field]).toEqual(original)
      expect(decoded[field].constructor).toBe(Uint8Array)
    },
  )

  test('frame bound includes every header byte', () => {
    const initial = signed()
    const value = body({ groupID: 'g'.repeat(4096 - initial.length + 5) })
    const frame = signed(value)
    expect(frame.byteLength).toBe(4096)
    expect(decodeEpochCheckpoint(frame).body).toEqual(value)
    expect(() => signed({ ...value, groupID: `${value.groupID}g` })).toThrow()
    expect(() => decodeEpochCheckpoint(new Uint8Array(4097))).toThrow(/size|large|4096/i)
  })

  test('strict signatures and private signer resolution', async () => {
    const decoded = decodeEpochCheckpoint(signed())
    expect(decoded.body).not.toHaveProperty('signerDID')
    expect(await verifyCheckpointPair(pair())).toMatchObject({
      kind: 'conflict',
      signerDID: alice.id,
      keyHash: checkpointKeyHash(alice.publicKey),
      localAuthHash: authHash,
      remoteAuthHash: otherHash,
      parentAuthHash: null,
    })
    expect(
      await verifyCheckpointPair(pair({ first: pair().second, second: pair().first })),
    ).toMatchObject({ kind: 'conflict', remoteAuthHash: otherHash })
    expect(await verifyCheckpointPair(pair({ second: signed() }))).toMatchObject({
      kind: 'agreement',
      signerDID: alice.id,
    })
    // The identity point is accepted under ZIP215 but forbidden by strict Ed25519.
    const point = new Uint8Array(32)
    point[0] = 1
    const signature = new Uint8Array(64)
    signature[0] = 1
    const value = body({ keyHash: checkpointKeyHash(point) })
    const input = checkpointSignatureInput(value)
    expect(ed25519.verify(signature, input, point, { zip215: true })).toBe(true)
    const nonStrictFrame = encodeEpochCheckpoint(value, signature)
    const nonStrictPair = pair({
      first: nonStrictFrame,
      second: nonStrictFrame,
      localRosterFact: encodeEpochRosterFact(
        fact({
          members: [
            {
              signerDID: alice.id,
              keyHash: value.keyHash,
              leafIndex: 0,
              signaturePublicKey: toB64U(point),
            },
          ],
        }),
      ),
    })
    expect(await verifyCheckpointPair(nonStrictPair)).toMatchObject({ kind: 'invalid' })
    const corrupted = signed()
    corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 1
    expect(await verifyCheckpointPair(pair({ second: corrupted }))).toEqual({ kind: 'invalid' })
  })

  test.each([
    { v: 2 },
    { type: 'unknown' },
    { ciphersuite: 2 },
    { ciphersuite: 999 },
    { epoch: -1 },
    { epoch: 1.5 },
    { epoch: Number.MAX_SAFE_INTEGER + 1 },
    { leafIndex: -1 },
    { leafIndex: 1.5 },
    { leafIndex: 2 ** 32 },
    { genesisHash: `${genesisHash}=` },
    { authHash: `${'A'.repeat(42)}B` },
    { keyHash: '' },
    { parentAuthHash: 'bad' },
    { signerDID: alice.id },
    { groupID: '\ud800' },
    { groupID: '' },
  ])('rejects invalid body fields %j', (changes) => {
    const value = { ...body(), ...changes }
    expect(() => decodeEpochCheckpoint(rawFrame(utf8.encode(canonicalStringify(value))))).toThrow()
    expect(() =>
      encodeEpochCheckpoint(value as EpochCheckpointBodyV1, new Uint8Array(64)),
    ).toThrow()
  })

  test.each(['duplicate', 'extra', 'space', 'utf8', 'surrogate', 'bom'])(
    'rejects noncanonical %s JSON',
    (kind) => {
      const text = canonicalStringify(body())
      const invalidUTF8 = utf8.encode(text)
      invalidUTF8[text.indexOf('"group"') + 1] = 0xff
      const variants: Record<string, Uint8Array> = {
        duplicate: utf8.encode(text.replace('"v":1', '"v":1,"v":1')),
        extra: utf8.encode(text.replace('"v":1', '"v":1,"extra":0')),
        space: utf8.encode(` ${text}`),
        utf8: invalidUTF8,
        surrogate: utf8.encode(text.replace('"group"', '"\\ud800"')),
        bom: new Uint8Array([239, 187, 191, ...utf8.encode(text)]),
      }
      const bytes = variants[kind]
      if (bytes == null) throw new Error('missing variant')
      expect(() => decodeEpochCheckpoint(rawFrame(bytes))).toThrow()
    },
  )

  test.each([
    'version',
    'kind',
    'outer-length',
    'inner-length',
    'truncated',
    'trailing',
    'signature',
  ])('rejects malformed frame %s', (kind) => {
    const frame = signed()
    if (kind === 'version') frame[0] = 2
    if (kind === 'kind') frame[1] = 2
    if (kind === 'outer-length') frame[5] = (frame[5] ?? 0) ^ 1
    if (kind === 'inner-length') frame[9] = (frame[9] ?? 0) ^ 1
    const invalid =
      kind === 'truncated'
        ? frame.slice(0, -1)
        : kind === 'trailing'
          ? new Uint8Array([...frame, 0])
          : frame
    if (kind === 'signature') {
      expect(() => encodeEpochCheckpoint(body(), new Uint8Array(63))).toThrow()
    } else expect(() => decodeEpochCheckpoint(invalid)).toThrow()
  })

  test('frame signature boundary is exact even when the outer length is correct', () => {
    for (const delta of [-1, 1]) {
      const valid = signed()
      const altered = delta < 0 ? valid.slice(0, -1) : new Uint8Array([...valid, 0])
      new DataView(altered.buffer).setUint32(2, altered.length - 6)
      expect(() => decodeEpochCheckpoint(altered)).toThrow()
    }
  })

  test.each([
    [false, true],
    [true, false],
    [true, true],
  ])(
    'strict verification rejects noncanonical public key %s and R %s',
    async (noncanonicalKey, noncanonicalR) => {
      const identity = new Uint8Array(32)
      identity[0] = 1
      const noncanonical = new Uint8Array(32).fill(255)
      noncanonical[0] = 238
      noncanonical[31] = 127
      const publicKey = noncanonicalKey ? noncanonical : identity
      const signature = new Uint8Array(64)
      signature.set(noncanonicalR ? noncanonical : identity)
      const value = body({ keyHash: checkpointKeyHash(publicKey) })
      expect(
        ed25519.verify(signature, checkpointSignatureInput(value), publicKey, { zip215: true }),
      ).toBe(true)
      const frame = encodeEpochCheckpoint(value, signature)
      expect(
        await verifyCheckpointPair(
          pair({
            first: frame,
            second: frame,
            localRosterFact: encodeEpochRosterFact(
              fact({
                members: [
                  {
                    signerDID: alice.id,
                    keyHash: value.keyHash,
                    signaturePublicKey: toB64U(publicKey),
                    leafIndex: 0,
                  },
                ],
              }),
            ),
          }),
        ),
      ).toEqual({ kind: 'invalid' })
    },
  )

  test.each([
    'v',
    'type',
    'groupID',
    'genesisHash',
    'ciphersuite',
    'epoch',
    'authHash',
    'parentAuthHash',
    'keyHash',
    'leafIndex',
  ])('rejects missing body field %s', (field) => {
    const value: Record<string, unknown> = { ...body() }
    delete value[field]
    expect(() => decodeEpochCheckpoint(rawFrame(utf8.encode(canonicalStringify(value))))).toThrow()
  })

  test('local facts constrain pair verification', async () => {
    const result = await verifyCheckpointPair(pair({ localRosterFact: new Uint8Array() }))
    expect(result.kind).toBe('coverage-gap')
    for (const changes of [
      { groupID: 'elsewhere' },
      { genesisHash: otherHash },
      { epoch: 1 },
      { ciphersuite: 3 },
    ]) {
      expect(await verifyCheckpointPair(pair({ second: signed(body(changes)) }))).toEqual({
        kind: 'invalid',
      })
    }
    for (const changes of [
      { key: { groupID: 'elsewhere', incarnation: 0 } },
      { genesisHash: otherHash },
      { epoch: 1 },
      { ciphersuite: 3 },
    ]) {
      expect(
        await verifyCheckpointPair(pair({ localRosterFact: encodeEpochRosterFact(fact(changes)) })),
      ).toEqual({ kind: 'invalid' })
    }
    expect(
      await verifyCheckpointPair(pair({ first: signed(body({ authHash: otherHash })) })),
    ).toEqual({ kind: 'coverage-gap' })
    expect(
      await verifyCheckpointPair(
        pair({ localRosterFact: encodeEpochRosterFact(fact({ members: [] })) }),
      ),
    ).toEqual({ kind: 'coverage-gap' })
    expect(await verifyCheckpointPair(pair({ localRosterFact: utf8.encode('{}') }))).toEqual({
      kind: 'invalid',
    })
  })

  test('eligibility uses a bound prior roster and accepts foreign leaf indices', async () => {
    const local = fact({ members: [] })
    const prior = fact({ epoch: local.epoch - 1 })
    const params = pair({
      localRosterFact: encodeEpochRosterFact(local),
      eligibilityRosterFact: encodeEpochRosterFact(prior),
      second: signed(body({ authHash: otherHash, leafIndex: 12345 })),
    })
    expect(await verifyCheckpointPair(params)).toMatchObject({ kind: 'conflict' })
    for (const changes of [
      { epoch: local.epoch },
      { epoch: local.epoch - 2 },
      { genesisHash: otherHash },
      { key: { groupID: 'elsewhere', incarnation: 0 } },
      { key: { groupID: 'group', incarnation: 1 } },
      { ciphersuite: 3 },
    ]) {
      expect(
        await verifyCheckpointPair({
          ...params,
          eligibilityRosterFact: encodeEpochRosterFact(fact({ epoch: prior.epoch, ...changes })),
        }),
      ).toEqual({ kind: 'invalid' })
    }
  })

  test('ambiguous key-to-DID resolution and key substitution confer no eligibility', async () => {
    const original = fact()
    const member = original.members[0]
    if (member == null) throw new Error('missing member')
    const ambiguous = fact({ members: [member, { ...member, signerDID: bob.id, leafIndex: 1 }] })
    expect(
      await verifyCheckpointPair(pair({ localRosterFact: encodeEpochRosterFact(ambiguous) })),
    ).toEqual({ kind: 'invalid' })
    const substitute = fact({
      members: [
        {
          ...member,
          keyHash: checkpointKeyHash(bob.publicKey),
          signaturePublicKey: toB64U(bob.publicKey),
        },
      ],
    })
    expect(
      await verifyCheckpointPair(pair({ localRosterFact: encodeEpochRosterFact(substitute) })),
    ).toEqual({ kind: 'coverage-gap' })
    expect(
      await verifyCheckpointPair(
        pair({ second: signed(body({ keyHash: checkpointKeyHash(bob.publicKey) })) }),
      ),
    ).toEqual({ kind: 'invalid' })
  })

  test('distinct eligible devices attest conflict in either frame order', async () => {
    const remote = signed(
      body({
        authHash: otherHash,
        parentAuthHash: genesisHash,
        keyHash: checkpointKeyHash(bob.publicKey),
        leafIndex: 99,
      }),
      bob.privateKey,
    )
    const expected = {
      kind: 'conflict',
      epoch: fact().epoch,
      signerDID: bob.id,
      keyHash: checkpointKeyHash(bob.publicKey),
      localAuthHash: authHash,
      remoteAuthHash: otherHash,
      parentAuthHash: genesisHash,
    }
    expect(await verifyCheckpointPair(pair({ second: remote }))).toEqual(expected)
    expect(await verifyCheckpointPair(pair({ first: remote, second: signed() }))).toEqual(expected)
  })

  test.each(['first', 'second'] as const)(
    'each frame requires its own valid signature: %s',
    async (field) => {
      const invalid = signed()
      invalid[invalid.length - 1] = (invalid[invalid.length - 1] ?? 0) ^ 1
      expect(await verifyCheckpointPair(pair({ [field]: invalid }))).toEqual({ kind: 'invalid' })
    },
  )

  test('local transcript codec preserves MLS bytes', () => {
    for (const transcript of [new Uint8Array(), new Uint8Array([0, 1, 255, 32])]) {
      const value = fact({ confirmedTranscriptHash: toB64U(transcript) })
      const bytes = encodeEpochRosterFact(value)
      expect(decodeEpochRosterFact(bytes).confirmedTranscriptHash).toBe(toB64U(transcript))
      expect(decodeEpochCheckpoint(signed()).body).not.toHaveProperty('confirmedTranscriptHash')
    }
    expect(() => encodeEpochRosterFact(fact({ confirmedTranscriptHash: 'AB' }))).toThrow()
  })

  test('facts sort DID/key/leaf and reject noncanonical order', () => {
    const value = fact()
    const bytes = encodeEpochRosterFact(value)
    const decoded = decodeEpochRosterFact(bytes)
    expect(decoded.members.map((member) => member.signerDID)).toEqual(
      value.members.map((member) => member.signerDID).sort(),
    )
    expect(encodeEpochRosterFact({ ...value, members: [...value.members].reverse() })).toEqual(
      bytes,
    )
    expect(() =>
      decodeEpochRosterFact(
        utf8.encode(
          canonicalStringify({
            ...decoded,
            members: [...decoded.members].reverse(),
          }),
        ),
      ),
    ).toThrow()
    expect(value.members).toEqual(fact().members)
  })

  test.each([
    'duplicate-pair',
    'duplicate-leaf',
    'key-hash',
    'public-key',
    'did',
    'extra',
    'version',
    'incarnation',
    'mutation',
    'state-version',
    'transcript',
    'leaf',
  ])('rejects malformed fact %s', (kind) => {
    const value = fact()
    const member = value.members[0]
    if (member == null) throw new Error('missing member')
    if (kind === 'duplicate-pair') value.members.push({ ...member, leafIndex: 2 })
    if (kind === 'duplicate-leaf' && value.members[1]) value.members[1].leafIndex = member.leafIndex
    if (kind === 'key-hash') member.keyHash = otherHash
    if (kind === 'public-key') member.signaturePublicKey += '='
    if (kind === 'did') member.signerDID += '#fragment'
    if (kind === 'version') Object.assign(value, { v: 2 })
    if (kind === 'incarnation') value.key.incarnation = -1
    if (kind === 'mutation') value.installation.mutationID = ''
    if (kind === 'state-version') value.installation.stateVersion = 1.5
    if (kind === 'transcript') value.confirmedTranscriptHash = 'AA='
    if (kind === 'leaf') member.leafIndex = 2 ** 32
    const malformed = kind === 'extra' ? { ...value, extra: true } : value
    expect(() => encodeEpochRosterFact(malformed)).toThrow()
    expect(() => decodeEpochRosterFact(utf8.encode(canonicalStringify(malformed)))).toThrow()
  })

  test('hash inputs and scalar fact fields reject malformed values', () => {
    expect(() => checkpointKeyHash(new Uint8Array(31))).toThrow()
    expect(() =>
      checkpointAuthHash({
        groupID: 'group',
        genesisHash,
        epoch: -1,
        epochAuthenticator: new Uint8Array(),
      }),
    ).toThrow()
    for (const value of [null, [], 'fact']) {
      expect(() => decodeEpochRosterFact(utf8.encode(canonicalStringify(value)))).toThrow()
    }
    for (const changes of [
      { members: null },
      { members: [{ ...fact().members[0], signerDID: 'not-a-did' }] },
      { key: { groupID: 'group' } },
      { installation: { mutationID: 'mutation', stateVersion: -1 } },
      { confirmedTranscriptHash: 'A' },
      { authHash: toB64U(new Uint8Array(31)) },
    ]) {
      expect(() =>
        decodeEpochRosterFact(utf8.encode(canonicalStringify({ ...fact(), ...changes }))),
      ).toThrow()
    }
  })

  test('members with one DID sort by key hash without locale rules', () => {
    const value = fact()
    value.members = value.members.map((member) => ({ ...member, signerDID: alice.id }))
    const bytes = encodeEpochRosterFact(value)
    expect(decodeEpochRosterFact(bytes).members.map((member) => member.keyHash)).toEqual(
      value.members.map((member) => member.keyHash).sort(),
    )
    expect(encodeEpochRosterFact({ ...value, members: [...value.members].reverse() })).toEqual(
      bytes,
    )
  })

  test.each([
    'groupID',
    'genesisHash',
    'ciphersuite',
    'epoch',
    'authHash',
    'parentAuthHash',
    'keyHash',
    'leafIndex',
  ])('signature binds %s', async (field) => {
    const frame = decodeEpochCheckpoint(signed())
    const altered = {
      ...frame.body,
      [field]:
        field === 'leafIndex'
          ? 1
          : field === 'epoch'
            ? 1
            : field === 'ciphersuite'
              ? 3
              : field === 'keyHash'
                ? checkpointKeyHash(bob.publicKey)
                : otherHash,
    }
    expect(
      await verifyCheckpointPair(pair({ second: encodeEpochCheckpoint(altered, frame.signature) })),
    ).toEqual({ kind: 'invalid' })
  })
})
