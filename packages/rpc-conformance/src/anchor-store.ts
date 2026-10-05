import { describe, expect, test } from 'vitest'

export type ConformanceAnchorSlot = {
  anchor: { secret: Uint8Array<ArrayBufferLike>; epoch: number }
  pending?: {
    epochBefore: number
    epochAfter: number
    rosterBefore: Array<string>
    forced: boolean
    advance: string
  }
}

export type ConformanceAnchorStore = {
  load(): Promise<ConformanceAnchorSlot | null>
  save(slot: ConformanceAnchorSlot): Promise<void>
}

export type AnchorStoreConformanceParams = {
  label: string
  createStore(): ConformanceAnchorStore
}

export function testAnchorStoreConformance(params: AnchorStoreConformanceParams): void {
  describe(`AnchorStore conformance — ${params.label}`, () => {
    test('the single slot durably preserves and replaces the anchor and one rotation record', async () => {
      const store = params.createStore()
      expect(await store.load()).toBeNull()
      const anchor = { secret: new Uint8Array([1, 2, 3]), epoch: 7 }
      await store.save({ anchor })
      expect(await store.load()).toEqual({ anchor })
      const pending = {
        epochBefore: 8,
        epochAfter: 9,
        rosterBefore: ['alice', 'bob'],
        forced: true,
        advance: 'digest-one',
      }
      await store.save({ anchor, pending })
      expect(await store.load()).toEqual({ anchor, pending })
      const retried = { ...pending, forced: false, advance: 'digest-two' }
      await store.save({ anchor, pending: retried })
      expect(await store.load()).toEqual({ anchor, pending: retried })
      const rotated = { secret: new Uint8Array([4, 5, 6]), epoch: 9 }
      await store.save({ anchor: rotated })
      expect(await store.load()).toEqual({ anchor: rotated })
    })
  })
}
