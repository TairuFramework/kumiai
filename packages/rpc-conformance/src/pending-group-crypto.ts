import { describe, expect, test } from 'vitest'

import type { ConformanceGroupCrypto } from './group-crypto.js'

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
  ):
    | { payload: Uint8Array; senderDID: string }
    | Promise<{ payload: Uint8Array; senderDID: string }>
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
  unnamedSender(): () => void
  /** Verify that staging did not replace the receiver's live context owner. */
  liveContextOwned(): boolean
  /** Snapshot the live handle state to check a rejected staged open leaves it untouched. */
  liveState(): Uint8Array
  persistCalls(): number
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

/** Ports may refuse a frame synchronously or through a rejected promise. */
async function refuses(call: () => unknown): Promise<void> {
  await expect((async () => await call())()).rejects.toThrow()
}

export function testPendingGroupCryptoConformance(params: PendingCryptoConformanceParams): void {
  const { label, createFixture, isStorageError } = params
  describe(`GroupCrypto pending conformance — ${label}`, () => {
    test('durable open saves a record and spent state; replay cannot save another', async () => {
      const { sender, senderDID, receiver, restore, saveHandle } = await createFixture('success')
      const payload = bytes.encode('first')
      const aad = bytes.encode('topic AAD')
      const sealed = await sender.wrap(payload, { aad })
      const ref = frame('first')
      expect(await receiver.unwrap(sealed, { expectedAAD: aad, frame: ref })).toEqual({
        payload,
        senderDID,
      })
      expect(await receiver.pending.list()).toEqual([{ frame: ref, payload, senderDID }])
      await refuses(() => receiver.unwrap(sealed, { expectedAAD: aad, frame: ref }))
      expect(await receiver.pending.list()).toHaveLength(1)
      await receiver.wrap(bytes.encode('later send'))
      await saveHandle()
      const restarted = await restore()
      expect(await restarted.pending.list()).toHaveLength(1)
      await refuses(() => restarted.unwrap(sealed, { expectedAAD: aad, frame: ref }))
      expect(await restarted.pending.list()).toHaveLength(1)
    })

    test('wrong AAD leaves a durable frame openable without persisting', async () => {
      const fixture = await createFixture('wrong-aad')
      const payload = bytes.encode('aad retry')
      const aad = bytes.encode('correct AAD')
      const sealed = await fixture.sender.wrap(payload, { aad })
      const before = fixture.liveState()
      const calls = fixture.persistCalls()
      await refuses(() =>
        fixture.receiver.unwrap(sealed, {
          expectedAAD: bytes.encode('wrong AAD'),
          frame: frame('wrong-aad'),
        }),
      )
      expect(fixture.persistCalls()).toBe(calls)
      expect(fixture.liveState()).toEqual(before)
      expect(await fixture.receiver.pending.list()).toEqual([])
      expect(
        await fixture.receiver.unwrap(sealed, {
          expectedAAD: aad,
          frame: frame('wrong-aad'),
        }),
      ).toEqual({ payload, senderDID: fixture.senderDID })
      expect(fixture.persistCalls()).toBe(calls + 1)
    })

    test('failed storage leaves live and stored ratchets able to open the frame', async () => {
      const fixture = await createFixture('storage-failure')
      const sealed = await fixture.sender.wrap(bytes.encode('retry'))
      fixture.failPersist(true)
      let failure: unknown
      try {
        await fixture.receiver.unwrap(sealed, { frame: frame('retry') })
      } catch (error) {
        failure = error
      }
      expect(isStorageError(failure)).toBe(true)
      expect(await fixture.receiver.pending.list()).toEqual([])
      expect(fixture.liveContextOwned()).toBe(true)
      const restarted = await fixture.restore()
      expect(await restarted.unwrap(sealed)).toMatchObject({ payload: bytes.encode('retry') })
      fixture.failPersist(false)
      expect(await fixture.receiver.unwrap(sealed, { frame: frame('retry') })).toMatchObject({
        payload: bytes.encode('retry'),
      })
      expect(fixture.liveContextOwned()).toBe(true)
    })

    test('unnamed sender is rejected before persistence without consuming the key', async () => {
      const fixture = await createFixture('unnamed')
      const sealed = await fixture.sender.wrap(bytes.encode('unnamed'))
      const undo = fixture.unnamedSender()
      try {
        await refuses(() => fixture.receiver.unwrap(sealed, { frame: frame('unnamed') }))
        expect(await fixture.receiver.pending.list()).toEqual([])
        expect(fixture.liveContextOwned()).toBe(true)
      } finally {
        undo()
      }
      const restarted = await fixture.restore()
      expect(await restarted.unwrap(sealed)).toMatchObject({ payload: bytes.encode('unnamed') })
      expect(await fixture.receiver.unwrap(sealed, { frame: frame('unnamed') })).toMatchObject({
        payload: bytes.encode('unnamed'),
      })
    })

    test('records survive restart, sort by segment and position, and complete idempotently', async () => {
      const fixture = await createFixture('records')
      for (const [id, segment, position] of [
        ['late', 2, '10'],
        ['first', 1, '2'],
        ['middle', 2, '3'],
      ] as const) {
        const sealed = await fixture.sender.wrap(bytes.encode(id))
        await fixture.receiver.unwrap(sealed, { frame: frame(id, segment, position) })
      }
      const restarted = await fixture.restore()
      expect((await restarted.pending.list()).map((record) => record.frame.id)).toEqual([
        'first',
        'middle',
        'late',
      ])
      await restarted.pending.complete('missing')
      await restarted.pending.complete('middle')
      await restarted.pending.complete('middle')
      expect((await restarted.pending.list()).map((record) => record.frame.id)).toEqual([
        'first',
        'late',
      ])
    })

    test('a storage failure is distinct from an unopenable frame', async () => {
      const fixture = await createFixture('dead')
      let failure: unknown
      try {
        await fixture.receiver.unwrap(new Uint8Array([0xff]), { frame: frame('dead') })
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      expect(isStorageError(failure)).toBe(false)
      expect(await fixture.receiver.pending.list()).toEqual([])
    })

    test('a below-epoch frame fails closed without persisting or changing live state', async () => {
      const fixture = await createFixture('past-epoch')
      const sealed = await fixture.sender.wrap(bytes.encode('past'))
      await fixture.advance()
      const before = fixture.liveState()
      const calls = fixture.persistCalls()
      for (let attempt = 0; attempt < 2; attempt++) {
        let failure: unknown
        try {
          await fixture.receiver.unwrap(sealed, { frame: frame('past') })
        } catch (error) {
          failure = error
        }
        expect(failure).toBeInstanceOf(Error)
        expect(isStorageError(failure)).toBe(false)
        expect(fixture.persistCalls()).toBe(calls)
        expect(fixture.liveState()).toEqual(before)
        expect(await fixture.receiver.pending.list()).toEqual([])
      }
    })
  })
}
