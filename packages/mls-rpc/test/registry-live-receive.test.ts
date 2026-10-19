import { encodeAppAAD, GroupSafetyHeldError } from '@kumiai/rpc'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { registryReceiveSlots, setReceiveBase } from '../src/registry/live-receive.js'
import { registryRetirement } from '../src/registry/retirement.js'
import { deferred } from '../src/runtime.js'
import { receiveRebuilds, setReceiveCapacity } from '../src/testing.js'
import { createRegistryLeaseFixture } from './fixtures/registry-lease.js'

type Fixture = Awaited<ReturnType<typeof createRegistryLeaseFixture>>
const fixtures: Array<Fixture> = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()))
})
async function setup(mode: 'real-mls' | 'double') {
  const fixture = await createRegistryLeaseFixture(mode, 'welcome')
  fixtures.push(fixture)
  return fixture
}
async function frame(fixture: Fixture, intent: 'ephemeral' | 'log' = 'ephemeral') {
  if (fixture.group === null) throw new Error('Missing peer')
  const expectedAAD = fixture.aad(intent)
  const ciphertext = await fixture.group.sender.handle.encrypt(new Uint8Array([7]), {
    aad: expectedAAD,
  })
  return { ciphertext, expectedAAD }
}
function slot(fixture: Fixture) {
  const value = registryReceiveSlots.get(fixture.access())
  if (value === undefined) throw new Error('Missing receive slot')
  return value
}
async function warm(fixture: Fixture) {
  receiveRebuilds(fixture.access())
  await fixture.access().receive([])
}
async function foreignWithoutRefresh(fixture: Fixture, kind: 'receive' | 'proposal') {
  const live = slot(fixture)
  const refresh = live.refresh
  live.refresh = () => null
  try {
    await fixture.writeElsewhere(kind)
  } finally {
    live.refresh = refresh
  }
}
for (const mode of ['real-mls', 'double'] as const) {
  describe(`live receive (${mode})`, () => {
    test('reservation keeps the receive handle; durable open rebuilds it', async () => {
      const fixture = await setup(mode)
      await warm(fixture)
      expect(fixture.receiveRebuilds()).toBe(1)
      await fixture.reserveNow()
      let transactions = fixture.transactions()
      await fixture.openEphemeral([])
      expect(fixture.receiveRebuilds()).toBe(1)
      expect(fixture.transactions()).toBe(transactions)
      await fixture.openDurable()
      transactions = fixture.transactions()
      await fixture.openEphemeral([])
      expect(fixture.receiveRebuilds()).toBe(2)
      expect(fixture.transactions()).toBe(transactions)
    })
    test('durable consumption and eviction are authoritative', async () => {
      const fixture = await setup(mode)
      const consumed = await frame(fixture)
      await warm(fixture)
      await fixture.openDurable(consumed)
      expect(await fixture.openEphemeral([consumed])).toMatchObject([
        { kind: 'refused', reason: 'invalid' },
      ])
      const old = await frame(fixture)
      await fixture.jumpEpochs(2)
      // Remove retained keys through a committed base rather than the live handle.
      const base = fixture.fixture()
      const handle = await base.restoreCommittedSender(fixture.key.groupID)
      handle.state.historicalReceiverData.clear()
      const { encodeClientState } = await import('@kumiai/mls')
      const record = await fixture.record()
      await base.installRows({
        key: fixture.key,
        state: { ...record, version: record.version + 1, state: encodeClientState(handle.state) },
      })
      expect(await fixture.openEphemeral([old])).toMatchObject([
        { kind: 'refused', reason: 'past-epoch' },
      ])
    })
    test('an older own proof cannot replace the receive base', async () => {
      const fixture = await setup(mode)
      const input = await frame(fixture)
      const older = await fixture.record()
      await fixture.openDurable(input)
      setReceiveBase(slot(fixture), older)
      expect(await fixture.openEphemeral([input])).toMatchObject([
        { kind: 'refused', reason: 'invalid' },
      ])
    })
    test('a new incarnation clears consumed tuples even when epoch numbers coincide', async () => {
      const fixture = await setup(mode)
      const input = await frame(fixture)
      const base = await fixture.record()
      expect(await fixture.openEphemeral([input])).toMatchObject([{ kind: 'opened' }])
      setReceiveBase(slot(fixture), { ...base, incarnation: base.incarnation + 1 })
      expect(await fixture.openEphemeral([input])).toMatchObject([{ kind: 'opened' }])
    })
    test('overlapping receive across a rebuild opens once', async () => {
      const fixture = await setup(mode)
      const input = await frame(fixture)
      await warm(fixture)
      const handle = slot(fixture).receive
      if (handle === null) throw new Error('Missing receiver')
      const entered = deferred<void>()
      const release = deferred<void>()
      const decrypt = handle.decrypt.bind(handle)
      vi.spyOn(handle, 'decrypt').mockImplementationOnce(async (...args) => {
        entered.resolve()
        await release.promise
        return decrypt(...args)
      })
      const first = fixture.openEphemeral([input])
      await entered.promise
      try {
        await fixture.openDurable()
        let secondFinished = false
        const second = fixture.openEphemeral([input]).then((results) => {
          secondFinished = true
          return results
        })
        await new Promise<void>((resolve) => setTimeout(resolve, 50))
        expect(secondFinished).toBe(false)
        release.resolve()
        expect(await first).toMatchObject([{ kind: 'opened' }])
        expect(await second).toMatchObject([{ kind: 'refused', reason: 'consumed' }])
      } finally {
        release.resolve()
      }
    })
    test('receive queued behind the lock rechecks availability and retirement drains admitted work', async () => {
      const fixture = await setup(mode)
      const input = await frame(fixture)
      await warm(fixture)
      const entered = deferred<void>()
      const release = deferred<void>()
      const held = slot(fixture).lock.run(async () => {
        entered.resolve()
        await release.promise
      })
      await entered.promise
      const receiving = fixture.openEphemeral([input]).then(
        () => 'opened',
        (error: unknown) => error,
      )
      const attempt = registryRetirement(fixture.fixture().registry).beginRetirement(fixture.key)
      let drained = false
      const draining = attempt.drain().then(() => {
        drained = true
      })
      await Promise.resolve()
      expect(drained).toBe(false)
      release.resolve()
      await held
      expect(await receiving).toMatchObject({ name: 'RegistryRetiringError' })
      await draining
      attempt.settle('rolled-back')
      expect(await fixture.openEphemeral([input])).toMatchObject([{ kind: 'opened' }])
    })
    test('cold receive wait aborts on retirement start, including immediate rollback', async () => {
      const fixture = await setup(mode)
      const input = await frame(fixture)
      await foreignWithoutRefresh(fixture, 'proposal')
      const hold = fixture.fixture().holdRestore(fixture.key.groupID)
      const receiving = fixture.openEphemeral([input]).then(
        () => 'opened',
        (error: unknown) => error,
      )
      await hold.started
      const attempt = registryRetirement(fixture.fixture().registry).beginRetirement(fixture.key)
      attempt.settle('rolled-back')
      try {
        expect(
          await Promise.race([
            receiving,
            new Promise((resolve) => setTimeout(() => resolve('timed out'), 500)),
          ]),
        ).toMatchObject({ name: 'RegistryRetiringError' })
      } finally {
        hold.release()
      }
    })
    test('cold receive waits at most five seconds for its refresh', async () => {
      const fixture = await setup(mode)
      const input = await frame(fixture)
      await foreignWithoutRefresh(fixture, 'proposal')
      const hold = fixture.fixture().holdRestore(fixture.key.groupID)
      vi.useFakeTimers()
      try {
        let result: unknown
        const receiving = fixture
          .openEphemeral([input])
          .then(
            () => 'opened',
            (error: unknown) => error,
          )
          .then((value) => {
            result = value
            return value
          })
        await vi.advanceTimersByTimeAsync(1)
        await hold.started
        await vi.advanceTimersByTimeAsync(4_998)
        expect(result).toBeUndefined()
        await vi.advanceTimersByTimeAsync(1)
        expect(result).toMatchObject({ reason: 'cold' })
        expect(await receiving).toMatchObject({ reason: 'cold' })
      } finally {
        vi.useRealTimers()
        hold.release()
      }
    })
    test.each(['control', 'cursor'] as const)(
      'unchanged version keeps the base after %s writes',
      async (kind) => {
        const fixture = await setup(mode)
        await warm(fixture)
        const base = slot(fixture).base
        await fixture.writeElsewhere(kind)
        expect(slot(fixture).base).toBe(base)
        await fixture.openEphemeral([])
        expect(fixture.receiveRebuilds()).toBe(1)
      },
    )
    test('foreign write clears the base and refresh restores it', async () => {
      const fixture = await setup(mode)
      const input = await frame(fixture)
      await foreignWithoutRefresh(fixture, 'receive')
      expect(slot(fixture).base).toBeNull()
      const hold = fixture.fixture().holdRestore(fixture.key.groupID)
      const receiving = fixture.openEphemeral([input])
      await hold.started
      hold.release()
      expect(await receiving).toMatchObject([{ kind: 'opened' }])
      expect(slot(fixture).base).not.toBeNull()
    })
    test('consumed bound closes the oldest non-current epoch and refuses a full current epoch', async () => {
      const fixture = await setup(mode)
      setReceiveCapacity(fixture.access(), 4)
      const old = await frame(fixture)
      expect(await fixture.openEphemeral([old])).toMatchObject([{ kind: 'opened' }])
      await fixture.advanceEpoch()
      const inputs = []
      for (let index = 0; index < 5; index++) inputs.push(await frame(fixture))
      expect(await fixture.openEphemeral(inputs)).toMatchObject([
        { kind: 'opened' },
        { kind: 'opened' },
        { kind: 'opened' },
        { kind: 'opened' },
        { kind: 'refused', reason: 'capacity' },
      ])
      expect(await fixture.openEphemeral([old])).toMatchObject([
        { kind: 'refused', reason: 'closed-epoch' },
      ])
      expect(
        [...slot(fixture).consumed.epochs.values()].reduce((sum, bucket) => sum + bucket.size, 0),
      ).toBe(4)
      await fixture.advanceEpoch()
      expect(await fixture.openEphemeral([await frame(fixture)])).toMatchObject([
        { kind: 'opened' },
      ])
      await fixture.switchIncarnation()
      expect(slot(fixture).consumed.epochs.size).toBe(0)
      expect(slot(fixture).consumed.closed.size).toBe(0)
    })
    test('a reduced consumed cap closes old epochs before another frame is considered', async () => {
      const fixture = await setup(mode)
      setReceiveCapacity(fixture.access(), 4)
      for (let index = 0; index < 3; index++) await fixture.openEphemeral([await frame(fixture)])
      await fixture.advanceEpoch()
      await fixture.openEphemeral([await frame(fixture)])
      setReceiveCapacity(fixture.access(), 2)
      await fixture.openEphemeral([])
      expect(
        [...slot(fixture).consumed.epochs.values()].reduce((sum, bucket) => sum + bucket.size, 0),
      ).toBe(1)
    })
    test('generation bound is receive-only and sender-data failures map to invalid', async () => {
      const fixture = await setup(mode)
      if (fixture.group === null) throw new Error('Missing peer')
      for (let index = 0; index < 499; index++) await frame(fixture)
      const lastAllowed = await frame(fixture)
      const bounded = await frame(fixture)
      const durable = await frame(fixture)
      expect(await fixture.openEphemeral([lastAllowed, bounded])).toMatchObject([
        { kind: 'opened' },
        { kind: 'refused', reason: 'generation-bound' },
      ])
      expect(await fixture.openDurable(durable)).toMatchObject([
        { kind: 'refused', reason: 'malformed-plaintext', keyConsumed: true },
      ])
      await warm(fixture)
      const handle = slot(fixture).receive
      if (handle === null) throw new Error('Missing receiver')
      const input = await frame(fixture)
      vi.spyOn(handle, 'readSenderData')
        .mockRejectedValueOnce(new Error('missing-key'))
        .mockResolvedValueOnce(null)
      expect(await fixture.openEphemeral([input, input])).toMatchObject([
        { kind: 'refused', reason: 'invalid' },
        { kind: 'refused', reason: 'invalid' },
      ])
    })
    test('peer access is registry-backed across rotation and same-epoch unavailability', async () => {
      const fixture = await setup(mode)
      const peer = await fixture.peerAccess()
      const aad = fixture.aad('ephemeral')
      for (let index = 0; index < 2; index++) {
        const sealed = await peer.seal(new Uint8Array([9]), { aad, intent: 'ephemeral' })
        expect(
          await fixture.openEphemeral([{ ciphertext: sealed.ciphertext, expectedAAD: aad }]),
        ).toMatchObject([{ kind: 'opened', payload: new Uint8Array([9]) }])
        const reply = await fixture.sealEphemeral(new Uint8Array([10]))
        expect(
          await peer.receive([{ ciphertext: reply.ciphertext, expectedAAD: aad }]),
        ).toMatchObject([{ kind: 'opened', payload: new Uint8Array([10]) }])
        if (index === 0) await fixture.advanceEpoch()
      }
      const epoch = fixture.access().epoch()
      await fixture.setUnavailable()
      expect(fixture.access().runtime.snapshot()).toMatchObject({ available: false, epoch })
    })
    test('epoch gates preserve retained frames and prune consumed epochs when keys expire', async () => {
      const fixture = await setup(mode)
      const old = await frame(fixture)
      expect(await fixture.openEphemeral([old])).toMatchObject([{ kind: 'opened' }])
      if (fixture.group === null) throw new Error('Missing peer')
      const future = await fixture.group.sealAhead(new Uint8Array([7]))
      expect(
        await fixture.openEphemeral([{ ciphertext: future, expectedAAD: new Uint8Array() }]),
      ).toMatchObject([{ kind: 'refused', reason: 'future-epoch' }])
      await fixture.advanceEpoch()
      expect(await fixture.openEphemeral([old])).toMatchObject([
        { kind: 'refused', reason: 'consumed' },
      ])
      const handle = await fixture.fixture().restoreCommittedSender(fixture.key.groupID)
      handle.state.historicalReceiverData.clear()
      const { encodeClientState } = await import('@kumiai/mls')
      const record = await fixture.record()
      await fixture.fixture().installRows({
        key: fixture.key,
        state: { ...record, version: record.version + 1, state: encodeClientState(handle.state) },
      })
      expect(await fixture.openEphemeral([old])).toMatchObject([
        { kind: 'refused', reason: 'past-epoch' },
      ])
      expect(slot(fixture).consumed.epochs.size).toBe(0)
    })
    test('invalid ciphertext and decrypt failure do not consume a tuple', async () => {
      const fixture = await setup(mode)
      const input = await frame(fixture)
      await warm(fixture)
      const handle = slot(fixture).receive
      if (handle === null) throw new Error('Missing receiver')
      vi.spyOn(handle, 'decrypt').mockRejectedValueOnce(new Error('Injected decrypt failure'))
      expect(
        await fixture.openEphemeral([
          { ciphertext: new Uint8Array([0]), expectedAAD: new Uint8Array() },
          input,
          input,
        ]),
      ).toMatchObject([
        { kind: 'refused', reason: 'invalid' },
        { kind: 'refused', reason: 'invalid' },
        { kind: 'opened' },
      ])
    })
    test('missing expected AAD refuses without consuming the frame', async () => {
      const fixture = await setup(mode)
      const input = await frame(fixture)
      // @ts-expect-error Untyped callers must supply the required expectation too.
      const missing = fixture.access().receive([{ ciphertext: input.ciphertext }])
      expect(await missing).toMatchObject([{ kind: 'refused', reason: 'invalid' }])
      expect(await fixture.openEphemeral([input])).toMatchObject([{ kind: 'opened' }])
    })
    test('expired receive epochs prune closed markers', async () => {
      const fixture = await setup(mode)
      setReceiveCapacity(fixture.access(), 1)
      await fixture.openEphemeral([await frame(fixture)])
      await fixture.advanceEpoch()
      await fixture.openEphemeral([await frame(fixture)])
      expect(slot(fixture).consumed.closed.size).toBe(1)
      const handle = await fixture.fixture().restoreCommittedSender(fixture.key.groupID)
      handle.state.historicalReceiverData.clear()
      const { encodeClientState } = await import('@kumiai/mls')
      const record = await fixture.record()
      await fixture.fixture().installRows({
        key: fixture.key,
        state: { ...record, version: record.version + 1, state: encodeClientState(handle.state) },
      })
      await fixture.openEphemeral([])
      expect(slot(fixture).consumed.closed.size).toBe(0)
    })
    test('receive handle is private, send-denied and commit-restricted', async () => {
      const fixture = await setup(mode)
      await warm(fixture)
      const handle = slot(fixture).receive
      if (handle === null) throw new Error('Missing receiver')
      await expect(handle.encryptApplication(new Uint8Array([1]))).rejects.toMatchObject({
        name: 'ApplicationSendRefusedError',
      })
      const { commitKeyRotation } = await import('@kumiai/mls')
      await expect(commitKeyRotation(handle)).rejects.toMatchObject({
        name: 'CommitAuthoringRefusedError',
      })
    })
    test('peer removal commits a changed roster', async () => {
      const fixture = await setup(mode)
      const peer = await fixture.peerAccess()
      const peerDID = (await peer.read((handle) => handle.credential)).id
      const before = fixture.access().runtime.snapshot()
      await fixture.removePeer()
      const after = fixture.access().runtime.snapshot()
      expect(after?.epoch).toBe((before?.epoch ?? 0) + 1)
      expect(after?.members.size).toBe((before?.members.size ?? 0) - 1)
      expect(after?.members.has(peerDID)).toBe(false)
      expect(peer.runtime.snapshot()?.available).toBe(false)
    })
    test('zero transactions and exact counts, replay survives owner drop and resets on restart', async () => {
      const fixture = await setup(mode)
      const input = await frame(fixture)
      const before = fixture.transactions()
      const rows = await fixture.inspectRows()
      expect(await fixture.access().receive([input, input])).toMatchObject([
        { kind: 'opened', payload: new Uint8Array([7]) },
        { kind: 'refused', reason: 'consumed' },
      ])
      expect(fixture.transactions()).toBe(before)
      expect(await fixture.inspectRows()).toEqual(rows)
      await fixture.dropOwner()
      expect(await fixture.access().receive([input])).toMatchObject([
        { kind: 'refused', reason: 'consumed' },
      ])
      await fixture.reopen()
      expect(await fixture.access().receive([input])).toMatchObject([{ kind: 'opened' }])
    })
    test('wrong AAD reports invalid whether consumed or not; log intent never consumes', async () => {
      const fixture = await setup(mode)
      const input = await frame(fixture)
      const wrong = {
        ...input,
        expectedAAD: encodeAppAAD({ topicID: 'wrong', intent: 'ephemeral' }),
      }
      const log = await frame(fixture, 'log')
      expect(await fixture.access().receive([wrong, log, input, wrong, log])).toMatchObject([
        { kind: 'refused', reason: 'invalid' },
        { kind: 'refused', reason: 'log-intent' },
        { kind: 'opened' },
        { kind: 'refused', reason: 'invalid' },
        { kind: 'refused', reason: 'log-intent' },
      ])
      await expect(
        fixture.access().receive(Array.from({ length: 65 }, () => input)),
      ).rejects.toBeInstanceOf(RangeError)
    })
    test.each(['fork-halted', 'recovery-unavailable', 'spent-set-corrupt'] as const)(
      'safety hold %s blocks receive live and after reopen',
      async (reason) => {
        const fixture = await setup(mode)
        const input = await frame(fixture)
        await fixture.holdSafety(reason)
        await expect(fixture.access().receive([input])).rejects.toBeInstanceOf(GroupSafetyHeldError)
        await fixture.reopen()
        await expect(fixture.access().receive([input])).rejects.toBeInstanceOf(GroupSafetyHeldError)
      },
    )
    test('first receive after reopen opens without a manual maintenance drain', async () => {
      const fixture = await setup(mode)
      const input = await frame(fixture)
      await fixture.reopen()
      expect(await fixture.access().receive([input])).toMatchObject([{ kind: 'opened' }])
    })
    test('cold receive needs no send eligibility with a pending proposal', async () => {
      const fixture = await setup(mode)
      const input = await frame(fixture)
      await fixture.writeElsewhere('proposal')
      expect(await fixture.access().receive([input])).toMatchObject([{ kind: 'opened' }])
      await fixture.reopen()
      expect(await fixture.access().receive([input])).toMatchObject([{ kind: 'opened' }])
    })
    test('lapsed group refreshes its cold base without send eligibility', async () => {
      const fixture = await setup(mode)
      const input = await frame(fixture)
      const { decodeClientState, restoreGroup } = await import('@kumiai/mls')
      const { restoreMemoryControlHandle } = await import('./fixtures/sealed-memory-mls.js')
      const base = fixture.fixture()
      base.overrideRestore(async (record) => {
        const state = decodeClientState(record.state)
        if (state === undefined) throw new Error('Invalid state')
        const handle = await (mode === 'double' ? restoreMemoryControlHandle : restoreGroup)({
          state,
          credential: record.credential,
          ledgerEntries: record.ledger,
          options: base.environment.options,
        })
        vi.spyOn(handle, 'ownLeafLapsed').mockReturnValue(true)
        vi.spyOn(handle, 'sendAdmission').mockReturnValue({
          epoch: Number(handle.epoch),
          admissible: false,
          reason: 'lapsed',
        })
        return handle
      })
      await fixture.dropOwner()
      expect(fixture.access().admission()).toMatchObject({ admissible: false, reason: 'lapsed' })
      await foreignWithoutRefresh(fixture, 'receive')
      expect(slot(fixture).base).toBeNull()
      expect(await fixture.openEphemeral([input])).toMatchObject([{ kind: 'opened' }])
    })
    test('retirement refuses new receive calls', async () => {
      const fixture = await setup(mode)
      const input = await frame(fixture)
      const attempt = registryRetirement(fixture.fixture().registry).beginRetirement(fixture.key)
      await expect(fixture.access().receive([input])).rejects.toMatchObject({
        name: 'RegistryRetiringError',
      })
      attempt.settle('rolled-back')
      expect(await fixture.access().receive([input])).toMatchObject([{ kind: 'opened' }])
    })
  })
}
