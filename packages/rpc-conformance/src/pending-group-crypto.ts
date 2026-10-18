import { describe, expect, test } from 'vitest'

import type { ConformanceGroupCrypto, ConformanceUnwrapResult } from './group-crypto.js'

export type ConformanceAppFrameRef = {
  id: string
  topicID: string
  protocol: string
  segment: number
  position: string
}

export type ConformancePendingAppFrame = {
  frame: ConformanceAppFrameRef
  payload: Uint8Array
  senderDID: string
}

export type PendingCrypto = Omit<ConformanceGroupCrypto, 'unwrap'> & {
  unwrap(
    bytes: Uint8Array,
    opts?: { expectedAAD?: Uint8Array; frame?: ConformanceAppFrameRef },
  ): ConformanceUnwrapResult | Promise<ConformanceUnwrapResult>
  pending: {
    list(): Promise<Array<ConformancePendingAppFrame>>
    complete(id: string): Promise<void>
  }
}

export type PendingCryptoFixture = {
  senderDID: string
  sender: ConformanceGroupCrypto
  receiver: PendingCrypto
  /** Construct a new port over the saved state and the same pending-record store. */
  restore(): Promise<PendingCrypto>
  failPersist(yes: boolean): void
  saveHandle(): Promise<void>
  /** Make an otherwise valid frame resolve without an authenticated sender. */
  unnamedSender?(): () => void
  encode?(text: string): Uint8Array
  frame?(ciphertext: Uint8Array, ref: ConformanceAppFrameRef): ConformanceAppFrameRef
  probeRestored?(): Promise<{
    unwrap(bytes: Uint8Array, opts?: { expectedAAD?: Uint8Array }): Promise<ConformanceUnwrapResult>
  }>
  /** Verify that staging did not replace the receiver's live context owner. */
  liveContextOwned(): boolean
  /** Snapshot the live handle state to check a rejected staged open leaves it untouched. */
  liveState(): Uint8Array
  persistCalls(): number
  retainedEpochs?: number
  advance(): Promise<void>
}

export type PendingCryptoConformanceParams = {
  label: string
  createFixture(id: string): Promise<PendingCryptoFixture>
  isStorageError(error: unknown): boolean
}

const bytes = new TextEncoder()
const frame = (id: string, segment = 1, position = '1'): ConformanceAppFrameRef => ({
  id,
  topicID: 'app-topic',
  protocol: 'chat',
  segment,
  position,
})

function encode(fixture: PendingCryptoFixture, text: string): Uint8Array {
  return fixture.encode?.(text) ?? bytes.encode(text)
}

function reference(
  fixture: PendingCryptoFixture,
  ciphertext: Uint8Array,
  id: string,
  segment = 1,
  position = '1',
): ConformanceAppFrameRef {
  const ref = frame(id, segment, position)
  return fixture.frame?.(ciphertext, ref) ?? ref
}

async function replay(
  fixture: PendingCryptoFixture,
  call: () => unknown,
  first: ConformanceUnwrapResult,
): Promise<void> {
  const calls = fixture.persistCalls()
  let result: unknown
  try {
    result = await call()
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    return
  } finally {
    expect(fixture.persistCalls()).toBe(calls)
  }
  expect(result).toMatchObject({
    payload: first.payload,
    senderDID: first.senderDID,
    epoch: first.epoch,
  })
}

/** Ports may refuse a frame synchronously or through a rejected promise. */
async function refuses(call: () => unknown): Promise<void> {
  await expect((async () => await call())()).rejects.toThrow()
}

export function testPendingGroupCryptoConformance(params: PendingCryptoConformanceParams): void {
  const { label, createFixture, isStorageError } = params
  describe(`GroupCrypto pending conformance — ${label}`, () => {
    test('a past frame is refused before a durable open or store write', async () => {
      const fixture = await createFixture('epoch-refusal')
      const sealed = await fixture.sender.wrap(encode(fixture, 'old frame'))
      const frameEpoch = fixture.sender.frameEpoch(sealed)
      if (frameEpoch == null) throw new Error('sender did not frame an epoch')
      const advances = (fixture.retainedEpochs ?? 4) + 1
      for (let i = 0; i < advances; i++) await fixture.advance()
      const calls = fixture.persistCalls()
      await expect(
        Promise.resolve().then(() =>
          fixture.receiver.unwrap(sealed, { frame: reference(fixture, sealed, 'old') }),
        ),
      ).rejects.toMatchObject({
        name: 'FrameEpochError',
        frameEpoch,
        handleEpoch: frameEpoch + advances,
      })
      expect(fixture.persistCalls()).toBe(calls)
      expect(await fixture.receiver.pending.list()).toEqual([])
    })

    test('a retained past-epoch durable unwrap saves one record', async () => {
      const fixture = await createFixture('retained-success')
      const payload = encode(fixture, 'retained')
      const sealed = await fixture.sender.wrap(payload)
      const from = fixture.receiver.epoch()
      const advances = fixture.retainedEpochs ?? 4
      for (let i = 0; i < advances; i++) await fixture.advance()
      const calls = fixture.persistCalls()
      const ref = reference(fixture, sealed, 'retained')
      const first = await fixture.receiver.unwrap(sealed, { frame: ref })
      expect(first).toEqual({
        payload,
        senderDID: fixture.senderDID,
        epoch: from + advances,
      })
      expect(fixture.persistCalls()).toBe(calls + 1)
      const records = await fixture.receiver.pending.list()
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ frame: ref, payload, senderDID: fixture.senderDID })
      await replay(fixture, () => fixture.receiver.unwrap(sealed, { frame: ref }), first)
      const restarted = await fixture.restore()
      await replay(fixture, () => restarted.unwrap(sealed, { frame: ref }), first)
      expect(fixture.persistCalls()).toBe(calls + 1)
      const restoredRecords = await restarted.pending.list()
      expect(restoredRecords).toHaveLength(1)
      expect(restoredRecords[0]).toMatchObject({
        frame: ref,
        payload,
        senderDID: fixture.senderDID,
      })
    })

    test('durable open saves a record and spent state; replay cannot save another', async () => {
      const fixture = await createFixture('success')
      const { sender, senderDID, receiver, restore, saveHandle } = fixture
      const payload = encode(fixture, 'first')
      const aad = bytes.encode('topic AAD')
      const sealed = await sender.wrap(payload, { aad })
      const ref = reference(fixture, sealed, 'first')
      const epoch = receiver.epoch()
      const first = await receiver.unwrap(sealed, { expectedAAD: aad, frame: ref })
      expect(first).toMatchObject({
        payload,
        senderDID,
        epoch,
      })
      const records = await receiver.pending.list()
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ frame: ref, payload, senderDID })
      await replay(fixture, () => receiver.unwrap(sealed, { expectedAAD: aad, frame: ref }), first)
      expect(await receiver.pending.list()).toHaveLength(1)
      await receiver.wrap(encode(fixture, 'later send'))
      await saveHandle()
      const restarted = await restore()
      expect(await restarted.pending.list()).toHaveLength(1)
      await replay(fixture, () => restarted.unwrap(sealed, { expectedAAD: aad, frame: ref }), first)
      expect(await restarted.pending.list()).toHaveLength(1)
    })

    test('wrong AAD leaves a durable frame openable without persisting', async () => {
      const fixture = await createFixture('wrong-aad')
      const payload = encode(fixture, 'aad retry')
      const aad = bytes.encode('correct AAD')
      const sealed = await fixture.sender.wrap(payload, { aad })
      const before = fixture.liveState()
      const calls = fixture.persistCalls()
      await refuses(() =>
        fixture.receiver.unwrap(sealed, {
          expectedAAD: bytes.encode('wrong AAD'),
          frame: reference(fixture, sealed, 'wrong-aad'),
        }),
      )
      expect(fixture.persistCalls()).toBe(calls)
      expect(fixture.liveState()).toEqual(before)
      expect(await fixture.receiver.pending.list()).toEqual([])
      expect(
        await fixture.receiver.unwrap(sealed, {
          expectedAAD: aad,
          frame: reference(fixture, sealed, 'wrong-aad'),
        }),
      ).toMatchObject({ payload, senderDID: fixture.senderDID })
      expect(fixture.persistCalls()).toBe(calls + 1)
    })

    test('failed storage leaves live and stored ratchets able to open the frame', async () => {
      const fixture = await createFixture('storage-failure')
      const sealed = await fixture.sender.wrap(encode(fixture, 'retry'))
      fixture.failPersist(true)
      let failure: unknown
      try {
        await fixture.receiver.unwrap(sealed, { frame: reference(fixture, sealed, 'retry') })
      } catch (error) {
        failure = error
      }
      expect(isStorageError(failure)).toBe(true)
      expect(await fixture.receiver.pending.list()).toEqual([])
      expect(fixture.liveContextOwned()).toBe(true)
      const restarted = fixture.probeRestored
        ? await fixture.probeRestored()
        : await fixture.restore()
      expect(await restarted.unwrap(sealed)).toMatchObject({ payload: encode(fixture, 'retry') })
      fixture.failPersist(false)
      expect(
        await fixture.receiver.unwrap(sealed, { frame: reference(fixture, sealed, 'retry') }),
      ).toMatchObject({
        payload: encode(fixture, 'retry'),
      })
      expect(fixture.liveContextOwned()).toBe(true)
    })

    test('unnamed sender is rejected before persistence without consuming the key', async ({
      skip,
    }) => {
      const fixture = await createFixture('unnamed')
      if (fixture.unnamedSender == null) {
        skip(
          'No unnamed-sender instrument; substitute coverage: legacy ports-conformance and registry-double unnamed-sender refusal/retry tests',
        )
        return
      }
      const sealed = await fixture.sender.wrap(encode(fixture, 'unnamed'))
      const undo = fixture.unnamedSender()
      try {
        await refuses(() =>
          fixture.receiver.unwrap(sealed, { frame: reference(fixture, sealed, 'unnamed') }),
        )
        expect(await fixture.receiver.pending.list()).toEqual([])
        expect(fixture.liveContextOwned()).toBe(true)
      } finally {
        undo()
      }
      const restarted = await fixture.restore()
      expect(await restarted.unwrap(sealed)).toMatchObject({ payload: encode(fixture, 'unnamed') })
      expect(
        await fixture.receiver.unwrap(sealed, { frame: reference(fixture, sealed, 'unnamed') }),
      ).toMatchObject({
        payload: encode(fixture, 'unnamed'),
      })
    })

    test('records survive restart, sort by segment and position, and complete idempotently', async () => {
      const fixture = await createFixture('records')
      const refs = new Map<string, ConformanceAppFrameRef>()
      for (const [id, segment, position] of [
        ['late', 2, '000000000010'],
        ['first', 1, '000000000002'],
        ['middle', 2, '000000000003'],
      ] as const) {
        const sealed = await fixture.sender.wrap(encode(fixture, id))
        const ref = reference(fixture, sealed, id, segment, position)
        refs.set(id, ref)
        await fixture.receiver.unwrap(sealed, { frame: ref })
      }
      const restarted = await fixture.restore()
      expect((await restarted.pending.list()).map((record) => record.frame.id)).toEqual([
        refs.get('first')?.id,
        refs.get('middle')?.id,
        refs.get('late')?.id,
      ])
      await restarted.pending.complete('missing')
      const middleID = refs.get('middle')?.id
      if (middleID == null) throw new Error('Missing middle frame')
      await restarted.pending.complete(middleID)
      await restarted.pending.complete(middleID)
      expect((await restarted.pending.list()).map((record) => record.frame.id)).toEqual([
        refs.get('first')?.id,
        refs.get('late')?.id,
      ])
    })

    test.each([
      { positions: ['a', 'B'], expected: ['B', 'a'] },
      { positions: ['9', '10'], expected: ['10', '9'] },
    ])('pending positions use code-unit order: $positions', async ({ positions, expected }) => {
      const fixture = await createFixture(`positions-${positions.join('-')}`)
      for (const position of positions) {
        const sealed = await fixture.sender.wrap(encode(fixture, position))
        await fixture.receiver.unwrap(sealed, {
          frame: reference(fixture, sealed, position, 1, position),
        })
      }
      expect((await fixture.receiver.pending.list()).map((row) => row.frame.position)).toEqual(
        expected,
      )
      const restarted = await fixture.restore()
      expect((await restarted.pending.list()).map((row) => row.frame.position)).toEqual(expected)
    })

    test('a storage failure is distinct from an unopenable frame', async () => {
      const fixture = await createFixture('dead')
      let failure: unknown
      try {
        await fixture.receiver.unwrap(new Uint8Array([0xff]), {
          frame: reference(fixture, new Uint8Array([0xff]), 'dead'),
        })
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      expect(isStorageError(failure)).toBe(false)
      expect(await fixture.receiver.pending.list()).toEqual([])
    })

    test('a below-epoch frame fails closed without persisting or changing live state', async () => {
      const fixture = await createFixture('past-epoch')
      const sealed = await fixture.sender.wrap(encode(fixture, 'past'))
      const frameEpoch = fixture.sender.frameEpoch(sealed)
      if (frameEpoch == null) throw new Error('sender did not frame an epoch')
      const advances = (fixture.retainedEpochs ?? 4) + 1
      for (let i = 0; i < advances; i++) await fixture.advance()
      const before = fixture.liveState()
      const calls = fixture.persistCalls()
      for (let attempt = 0; attempt < 2; attempt++) {
        let failure: unknown
        try {
          await fixture.receiver.unwrap(sealed, { frame: reference(fixture, sealed, 'past') })
        } catch (error) {
          failure = error
        }
        expect(failure).toMatchObject({
          name: 'FrameEpochError',
          frameEpoch,
          handleEpoch: frameEpoch + advances,
        })
        expect(isStorageError(failure)).toBe(false)
        expect(fixture.persistCalls()).toBe(calls)
        expect(fixture.liveState()).toEqual(before)
        expect(await fixture.receiver.pending.list()).toEqual([])
      }
    })
  })
}
