import { describe, expect, test } from 'vitest'

import type { RegistryLeaseFixture } from './persistence-fixture.js'

type Input = { ciphertext: Uint8Array; expectedAAD: Uint8Array }
export type RegistryLeaseConformanceFixture = RegistryLeaseFixture & {
  providerTransactions(): number
  opens(ciphertext: Uint8Array, receiver?: 'local' | 'peer'): number
  sealEphemeral(
    plaintext?: Uint8Array,
    aad?: Uint8Array,
  ): ReturnType<RegistryLeaseFixture['sealEphemeral']>
  aad(intent: 'log' | 'ephemeral'): Uint8Array
  senderFrame(generation?: number, aad?: Uint8Array): Promise<Input>
  setReceiveCapacity(cap: number): void
  consumed(): { count: number; closed: Array<number> }
  defer(kind: 'removed' | 'suspended' | 'proposal'): Promise<void>
  controlProgress(): Promise<void>
  foreignEvict(): Promise<void>
  blockedCallerSend(): Promise<void>
  lapsedReservation(): Promise<void>
  removedReplay(): Promise<void>
  acceptedHold(count?: number): Promise<{
    check(): Promise<void>
    resume(): Promise<{ epoch: number; payloads: Array<unknown> }>
    close(): void
  }>
  replyAAD(): Uint8Array
  retention(
    path: 'create' | 'restore' | 'Welcome' | 'external join' | 'derive' | 'recovery',
  ): Promise<{
    retainKeysForGenerations: number
    maximumForwardRatchetSteps: number
  }>
  ordinaryAdoption(): Promise<void>
}

export type RegistryLeaseConformanceParams = {
  label: string
  createFixture(
    source?: 'seed' | 'welcome',
    initialGeneration?: number,
  ): Promise<RegistryLeaseConformanceFixture>
}

export function testRegistryLeaseConformance(params: RegistryLeaseConformanceParams): void {
  const run = async (
    work: (fixture: RegistryLeaseConformanceFixture) => Promise<void>,
    source: 'seed' | 'welcome' = 'welcome',
    generation = 0,
  ) => {
    const fixture = await params.createFixture(source, generation)
    try {
      await work(fixture)
    } finally {
      await fixture.close()
    }
  }
  const invariant = async (h: RegistryLeaseConformanceFixture) => {
    const lease = h.lease()
    expect(lease).not.toBeNull()
    if (lease === null) throw new Error('Missing lease')
    expect(lease.own).toBeLessThanOrEqual(lease.limit)
    expect(lease.limit).toBeLessThanOrEqual(await h.storedGeneration())
  }

  describe(`registry leases and ephemeral crypto (${params.label})`, () => {
    test('S1 holds after install, renewal, failed encryptions, owner loss and restart', () =>
      run(async (h) => {
        const peer = await h.peerAccess()
        const published = new Set<string>()
        const send = async () => {
          await invariant(h)
          const sealed = await h.sealEphemeral()
          const id = `${sealed.epoch}:${sealed.generation}`
          expect(published.has(id)).toBe(false)
          published.add(id)
          const frame = { ciphertext: sealed.ciphertext, expectedAAD: h.aad('ephemeral') }
          expect(await peer.receive([frame])).toMatchObject([{ kind: 'opened' }])
          expect(await peer.receive([frame])).toMatchObject([{ kind: 'refused' }])
          expect(h.opens(frame.ciphertext, 'peer')).toBe(1)
          await invariant(h)
        }
        for (let index = 0; index < 14; index++) await send()
        await h.drainMaintenance()
        expect(h.lease()?.limit).toBeGreaterThan(16)
        for (const when of ['throw-before', 'throw-after'] as const) {
          h.failNextEncrypt(when)
          await expect(h.sealEphemeral()).rejects.toThrow('Injected encryption failure')
          await send()
        }
        await h.dropOwner()
        await h.drainMaintenance()
        await send()
        await h.reopen()
        await h.drainMaintenance()
        await send()
      }))

    test('a blocked caller send during reservation is refused', () =>
      run((h) => h.blockedCallerSend(), 'seed'))

    test('committed reservation before seal is skipped after reconstruction', () =>
      run(async (h) => {
        const committed = await h.storedGeneration()
        expect(committed).toBe(16)
        await h.reopen()
        await h.drainMaintenance()
        const sealed = await h.sealEphemeral()
        expect(sealed.generation).toBeGreaterThanOrEqual(committed)
        await invariant(h)
      }, 'seed'))

    test('lapsed leaf defers reservation without blocking control or receive', () =>
      run((h) => h.lapsedReservation(), 'seed'))

    test('removed member defers reservation, keeps control and pending replay, and decrypts with raw retained keys', () =>
      run((h) => h.removedReplay()))

    test.each(['suspended', 'proposal'] as const)(
      '%s defers reservations without blocking control or receive',
      (kind) =>
        run(async (h) => {
          const input = await h.senderFrame()
          await h.defer(kind)
          await h.drainMaintenance()
          expect(h.lease()).toBeNull()
          const generation = await h.storedGeneration()
          await expect(h.sealEphemeral()).rejects.toThrow()
          await h.controlProgress()
          expect(await h.openEphemeral([input])).toMatchObject([{ kind: 'opened' }])
          expect(await h.storedGeneration()).toBe(generation)
        }),
    )

    test.each(['fork-halted', 'recovery-unavailable', 'spent-set-corrupt'] as const)(
      '%s blocks seal and receive live and after restart',
      (reason) =>
        run(async (h) => {
          const input = await h.senderFrame()
          await h.holdSafety(reason)
          for (const restarted of [false, true]) {
            if (restarted) await h.reopen()
            await expect(h.sealEphemeral()).rejects.toThrow()
            await expect(h.openEphemeral([input])).rejects.toThrow()
            expect(h.admission()).toMatchObject({ admissible: false, reason })
          }
        }),
    )

    test('500 bound: final lease is usable through 499, then rejects and holds', () =>
      run(
        async (h) => {
          const held = await h.acceptedHold()
          try {
            expect(h.lease()).toMatchObject({ own: 484, limit: 500 })
            expect(h.admission()).toMatchObject({ admissible: true })
            for (let generation = 484; generation < 500; generation++) {
              expect((await h.sealEphemeral()).generation).toBe(generation)
              await invariant(h)
            }
            expect(h.admission()).toMatchObject({ admissible: false, reason: 'rotation-required' })
            const rows = await h.inspectRows()
            const transactions = h.providerTransactions()
            await expect(h.sealEphemeral()).rejects.toThrow()
            await expect(h.sealDurable()).rejects.toMatchObject({ reason: 'rotation-required' })
            expect(h.providerTransactions()).toBe(transactions)
            expect(await h.inspectRows()).toEqual(rows)
            await held.check()
          } finally {
            held.close()
          }
          await h.reopen()
          expect(h.admission()).toMatchObject({ admissible: false, reason: 'rotation-required' })
        },
        'seed',
        484,
      ))
    test('automatic rotation resumes accepted entries held at the 500 generation bound exactly once', () =>
      run(
        async (h) => {
          const held = await h.acceptedHold(2)
          try {
            expect(h.lease()).toMatchObject({ own: 484, limit: 500 })
            for (let generation = 484; generation < 500; generation++) {
              expect((await h.sealEphemeral()).generation).toBe(generation)
              await invariant(h)
            }
            expect(h.admission()).toMatchObject({ admissible: false, reason: 'rotation-required' })
            await held.check()
            const resumed = await held.resume()
            expect(resumed.epoch).toBe(1)
            expect(resumed.payloads).toEqual([
              { typ: 'event', prc: 'posted', data: { text: 'held-0' } },
              { typ: 'event', prc: 'posted', data: { text: 'held-1' } },
            ])
            expect(h.admission()).toMatchObject({ admissible: true, epoch: 1 })
            await invariant(h)
          } finally {
            held.close()
          }
        },
        'seed',
        484,
      ))

    test('forward window covers the bound and preserves skipped earlier generations', () =>
      run(async (h) => {
        const earlier = await h.senderFrame(0)
        const last = await h.senderFrame(499)
        expect(await h.openEphemeral([last, earlier])).toMatchObject([
          { kind: 'opened' },
          { kind: 'opened' },
        ])
      }))

    test.each(['create', 'restore', 'Welcome', 'external join', 'derive', 'recovery'] as const)(
      '1000 retention and forward window survive %s',
      (path) =>
        run(async (h) => {
          const config = await h.retention(path)
          expect(config.retainKeysForGenerations).toBeGreaterThanOrEqual(1000)
          expect(config.maximumForwardRatchetSteps).toBeGreaterThanOrEqual(1000)
        }, 'seed'),
    )

    test('ordinary adoption preserves sender and receive history without resurrecting evicted epochs', () =>
      run((h) => h.ordinaryAdoption()))

    test('ephemeral persists nothing: eight seals and opens with directed-reply AAD', () =>
      run(async (h) => {
        const peer = await h.peerAccess()
        const aad = h.replyAAD()
        const input = await h.senderFrame(undefined, aad)
        await h.drainMaintenance()
        const before = await h.inspectRows()
        const transactions = h.providerTransactions()
        const frames = [input]
        for (let index = 1; index < 8; index++) frames.push(await h.senderFrame(undefined, aad))
        for (let index = 0; index < 8; index++) {
          const sealed = await h.sealEphemeral(new Uint8Array([index]), aad)
          expect(
            await peer.receive([{ ciphertext: sealed.ciphertext, expectedAAD: aad }]),
          ).toMatchObject([{ kind: 'opened', payload: new Uint8Array([index]) }])
        }
        expect(
          await h.openEphemeral([{ ...input, expectedAAD: new Uint8Array([0]) }]),
        ).toMatchObject([{ kind: 'refused', reason: 'invalid' }])
        expect(await h.openEphemeral(frames)).toMatchObject(
          frames.map(() => ({ kind: 'opened', aad })),
        )
        expect(h.providerTransactions() - transactions).toBe(0)
        expect(await h.inspectRows()).toEqual(before)
      }))

    test.each(['local', 'foreign'] as const)(
      '%s durable eviction governs ephemeral receive',
      (writer) =>
        run(async (h) => {
          const first = await h.senderFrame()
          const unopened = await h.senderFrame()
          expect(await h.openEphemeral([first])).toMatchObject([{ kind: 'opened' }])
          if (writer === 'foreign') await h.foreignEvict()
          else await h.jumpEpochs(5)
          expect(await h.openEphemeral([unopened])).toMatchObject([
            { kind: 'refused', reason: 'past-epoch' },
          ])
          await h.reopen()
          expect(await h.openEphemeral([unopened])).toMatchObject([
            { kind: 'refused', reason: 'past-epoch' },
          ])
        }),
    )

    test('overlapping receives open once', () =>
      run(async (h) => {
        const input = await h.senderFrame()
        const results = (
          await Promise.all([h.openEphemeral([input]), h.openEphemeral([input])])
        ).flat()
        expect(results.filter((result) => result.kind === 'opened')).toHaveLength(1)
        expect(results.filter((result) => result.kind === 'refused')).toHaveLength(1)
        expect(h.opens(input.ciphertext)).toBe(1)
      }))

    test('receive refuses generations at or above 500 without consuming capacity', () =>
      run(async (h) => {
        for (const generation of [500, 501]) {
          const over = await h.senderFrame(generation)
          expect(await h.openEphemeral([over])).toMatchObject([
            { kind: 'refused', reason: 'generation-bound' },
          ])
        }
        expect(h.consumed().count).toBe(0)
      }))

    test('consumed set stays under its cap and closes the oldest retained epoch', () =>
      run(async (h) => {
        h.setReceiveCapacity(2)
        const first = await h.senderFrame()
        const old = await h.senderFrame()
        expect(await h.openEphemeral([first])).toMatchObject([{ kind: 'opened' }])
        await h.advanceEpoch()
        for (let index = 0; index < 2; index++) {
          expect(await h.openEphemeral([await h.senderFrame()])).toMatchObject([{ kind: 'opened' }])
          expect(h.consumed().count).toBeLessThanOrEqual(2)
        }
        expect(h.consumed().closed).toHaveLength(1)
        expect(await h.openEphemeral([old])).toMatchObject([
          { kind: 'refused', reason: 'closed-epoch' },
        ])
        const next = await h.senderFrame()
        expect(await h.openEphemeral([next])).toMatchObject([
          { kind: 'refused', reason: 'capacity' },
        ])
        expect(h.consumed().count).toBe(2)
      }))

    test('exhausted copy rejects without a transaction while independent maintenance refills', () =>
      run(async (h) => {
        const blocked = h.blockMaintenance()
        try {
          for (let index = 0; index < 16; index++) await h.sealEphemeral()
          await blocked.started
          const rows = await h.inspectRows()
          const transactions = h.providerTransactions()
          await expect(h.sealEphemeral()).rejects.toMatchObject({ reason: 'exhausted' })
          expect(h.providerTransactions()).toBe(transactions)
          expect(await h.inspectRows()).toEqual(rows)
        } finally {
          blocked.release()
        }
        await h.drainMaintenance()
        expect((await h.sealEphemeral()).generation).toBe(16)
      }))
  })
}
