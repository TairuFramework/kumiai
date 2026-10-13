import type { GroupHandle } from '@kumiai/mls'
import { decodeClientState, encodeClientState, openRecoveryVerdict } from '@kumiai/mls'
import { describe, expect, expectTypeOf, test } from 'vitest'

import type {
  ConformanceRegistryFixtureBase,
  ConformanceRegistryHandle,
} from '../../rpc-conformance/lib/registry-fixture.js'
import { entryCapability } from '../src/entry-capability.js'
import { createVerdictJudge } from '../src/recovery.js'
import { decodeRecoveryCandidate } from '../src/recovery-codec.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { validateRegistryHandle } from '../src/registry/validation.js'
import { deferred } from '../src/runtime.js'
import {
  createRegistryFixture,
  type RegistryFixtureBase,
  registryFixtureRestore,
} from './fixtures/registry.js'
import { createRegistryWelcomeHistory } from './fixtures/registry-welcome.js'
import { makeStorageSeed } from './fixtures/storage-seed.js'

expectTypeOf<RegistryFixtureBase>().toExtend<ConformanceRegistryFixtureBase<GroupHandle>>()
expectTypeOf<keyof RegistryFixtureBase>().toEqualTypeOf<
  keyof ConformanceRegistryFixtureBase<GroupHandle>
>()

expectTypeOf<GroupHandle>().toExtend<ConformanceRegistryHandle>()

for (const mode of ['real-mls', 'double'] as const) {
  describe(`registry fixture (${mode})`, () => {
    const groupID = `registry-fixture-${mode}`
    const key = { groupID, incarnation: 1 }
    const create = (setup: 'empty' | 'seeded' = 'empty') =>
      createRegistryFixture({ mode, setup, groupID })

    test('empty fixture has no lifetime', async () => {
      const fixture = await create()
      try {
        expect(await fixture.device.groups.list()).toEqual([])
        expect(await fixture.device.groups.load(groupID)).toBeNull()
        expect(await fixture.device.groups.load('group-B')).toBeNull()
        expect((await fixture.device.load()).restoreWork).toBeNull()
      } finally {
        await fixture.close()
      }
    })

    test('failed mutation proof read preserves the next work phase callback', async () => {
      const fixture = await create('seeded')
      try {
        let calls = 0
        fixture.onPhase('work', () => {
          calls++
        })
        await expect(fixture.device.groups.resolve(groupID, 'missing-proof')).rejects.toMatchObject(
          {
            name: 'GroupStateUncertainError',
          },
        )
        await fixture.installRows({
          key,
          control: { strand: { reason: 'lost-state' } },
        })
        expect(calls).toBe(1)
      } finally {
        await fixture.close()
      }
    })

    test('fixture owner matches every credential', async () => {
      const fixture = await create('seeded')
      const cold = await fixture.reopen()
      try {
        const record = await cold.device.groups.loadState(key)
        if (record === null || record.deleted || record.state === null)
          throw new Error('Missing seed')
        const state = decodeClientState(record.state)
        if (state === undefined) throw new Error('Invalid seed')
        const handle = await registryFixtureRestore(cold)({ ...record, state: record.state })
        validateRegistryHandle({
          handle,
          key,
          record,
          trust: await cold.device.groups.loadTrust(groupID),
          environment: cold.environment,
          ownerDID: cold.device.ownerDID,
        })
        for (const candidate of [await cold.makeHandle(0), await cold.makeHandle(3)]) {
          expect(candidate.credential.id).toBe(cold.identity.id)
          validateRegistryHandle({
            handle: candidate,
            key,
            trust: null,
            environment: cold.environment,
            ownerDID: cold.device.ownerDID,
          })
        }
      } finally {
        await cold.close()
        await fixture.close()
      }
    })

    test('durable reopen drops runtime', async () => {
      const fixture = await create('seeded')
      let called = 0
      fixture.overrideRestore(async () => {
        called++
        throw new Error('stale restore')
      })
      fixture.onPhase('work', () => {
        called++
      })
      const restore = fixture.holdRestore(groupID)
      const proof = fixture.holdProof('cold-install')
      const cold = await fixture.reopen()
      try {
        expect(cold).not.toBe(fixture)
        expect(cold.device).not.toBe(fixture.device)
        expect(cold.environment).not.toBe(fixture.environment)
        expect(cold.restoreCount(groupID)).toBe(0)
        const record = await cold.device.groups.loadState(key)
        if (record === null || record.deleted || record.state === null)
          throw new Error('Missing cold source')
        const next = await registryFixtureRestore(cold)({ ...record, state: record.state })
        expect(cold.restoreCount(groupID)).toBe(1)
        await cold.device.groups
          .ports(key)
          .control.apply({ strand: { reason: 'lost-state' } }, 'cold-install')
        expect(next.credential.id).toBe(cold.identity.id)
        expect(called).toBe(0)
      } finally {
        restore.release()
        proof.release()
        await cold.close()
        await fixture.close()
      }
    })

    test.each(['after-first-write', 'before-commit', 'commit-then-reject'] as const)(
      'work fault misses prepare (%s)',
      async (point) => {
        const fixture = await create()
        try {
          const handle = await fixture.makeHandle(0)
          const fault = fixture.armNextWorkFault(point)
          const entry = entryCapability(fixture.device.groups)
          if (entry === null) throw new Error('Missing capability')
          expect(await entry.read(`${groupID}-read`, (reads) => reads.lifetime())).toBeNull()
          let prepareStoresRead = false
          fixture.onPhase('prepare', async () => {
            expect(await fixture.constructPrepareStores().lifetime.load()).toBeNull()
            prepareStoresRead = true
          })
          let prepared = false
          const operation = entry.run(
            { groupID, mutationID: 'install-work' },
            async (reads) => {
              expect(await reads.lifetime()).toBeNull()
              prepared = true
              return { expected: null, value: handle }
            },
            async (stores, candidate) => {
              await stores.lifetime.save({
                groupID,
                latestIncarnation: 1,
                activeIncarnation: 1,
                revision: 1,
                mutationID: 'install-work',
                restorePending: false,
              })
              await stores.incarnation(1).state.save({
                ...key,
                version: 1,
                deleted: false,
                terminal: false,
                epoch: 0,
                epochAuthenticator: candidate.state.keySchedule.epochAuthenticator,
                state: encodeClientState(candidate.state),
                credential: candidate.credential,
                ledger: candidate.ledgerTokens,
                senderHWM: 0,
              })
              await stores.trust.save(recoveryTrustFor(candidate, key, null))
            },
          )
          if (point === 'commit-then-reject') await operation
          else await expect(operation).rejects.toThrow(`Injected ${point} failure`)
          expect(prepareStoresRead).toBe(true)
          expect(prepared).toBe(true)
          expect(await fault.mutationID).toBe('install-work')
          expect(await fixture.device.groups.load(groupID)).toEqual(
            point === 'commit-then-reject'
              ? expect.objectContaining({ activeIncarnation: 1 })
              : null,
          )
        } finally {
          await fixture.close()
        }
      },
    )

    for (const arming of ['next', 'known'] as const) {
      test.each(['before-commit', 'commit-then-reject', 'pending', 'after-first-write'] as const)(
        `work fault isolates the selected transaction (${arming}, %s)`,
        async (point) => {
          const fixture = await create('seeded')
          const unrelated = await makeStorageSeed({
            id: `${groupID}-write`,
            incarnation: 1,
            epoch: 0,
            mode,
            identity: fixture.identity,
            options: fixture.environment.options,
          })
          await fixture.installRows(unrelated)
          const entry = entryCapability(fixture.device.groups)
          if (entry === null) throw new Error('Missing capability')
          const before = await fixture.device.groups.load(groupID)
          const work = deferred<void>()
          const released = deferred<void>()
          const mutationID = 'isolated-work'
          let proofs = 0
          fixture.onPhase('work', async () => {
            work.resolve()
            await released.promise
          })
          fixture.onPhase('proof', () => {
            proofs++
          })
          const pending =
            point !== 'pending'
              ? undefined
              : arming === 'next'
                ? fixture.armNextWorkFault('pending')
                : fixture.armWorkFault(mutationID, 'pending')
          if (point !== 'pending') {
            if (arming === 'next') fixture.armNextWorkFault(point)
            else fixture.armWorkFault(mutationID, point)
          }
          const operation = fixture.device.groups
            .ports(key)
            .control.apply({ strand: { reason: 'lost-state' } }, mutationID)
            .then(
              () => undefined,
              (error: unknown) => error,
            )
          let finished = false
          try {
            await work.promise
            await expect(
              entry.read(`${groupID}-first-read`, (reads) => reads.lifetime()),
            ).resolves.toBeNull()
            await expect(
              fixture.device.groups
                .ports(unrelated.key)
                .control.apply({ strand: { reason: 'lost-state' } }, 'unrelated-write'),
            ).resolves.toBeUndefined()
            expect((await fixture.device.groups.load(unrelated.key.groupID))?.revision).toBe(2)
            expect(
              (await fixture.device.groups.ports(unrelated.key).control.load()).strand,
            ).toEqual({
              reason: 'lost-state',
            })
            expect(proofs).toBe(0)
            released.resolve()
            if (pending !== undefined) {
              await pending.rejected
              await pending.finish('rollback')
              finished = true
            }
            const error = await operation
            if (point === 'commit-then-reject') expect(error).toBeUndefined()
            else if (point === 'pending') expect(error).toBeInstanceOf(Error)
            else expect(error).toEqual(new Error(`Injected ${point} failure`))
            expect(proofs).toBe(point === 'commit-then-reject' || point === 'pending' ? 1 : 0)
            expect((await fixture.device.groups.load(groupID))?.revision).toBe(
              (before?.revision ?? 0) + (point === 'commit-then-reject' ? 1 : 0),
            )
            expect((await fixture.device.groups.ports(key).control.load()).strand).toEqual(
              point === 'commit-then-reject' ? { reason: 'lost-state' } : null,
            )
          } finally {
            released.resolve()
            if (pending !== undefined && !finished) {
              await pending.rejected
              await pending.finish('rollback')
            }
            await operation
            await fixture.close()
          }
        },
      )
    }

    test.each(['commit', 'rollback'] as const)(
      'pending work is controllable (%s)',
      async (outcome) => {
        const fixture = await create('seeded')
        try {
          const before = await fixture.device.groups.load(groupID)
          const fault = fixture.armNextWorkFault('pending')
          const operation = fixture.device.groups
            .ports(key)
            .control.apply({ strand: { reason: 'lost-state' } }, 'pending-work')
          await fault.rejected
          expect(await fault.mutationID).toBe('pending-work')
          await fault.finish(outcome)
          if (outcome === 'commit') await operation
          else await expect(operation).rejects.toThrow()
          expect((await fixture.device.groups.load(groupID))?.revision).toBe(
            (before?.revision ?? 0) + (outcome === 'commit' ? 1 : 0),
          )
        } finally {
          await fixture.close()
        }
      },
    )

    test('reopen waits for pending backend completion', async () => {
      const fixture = await create('seeded')
      let cold: RegistryFixtureBase | undefined
      try {
        const fault = fixture.armNextWorkFault('pending')
        const operation = fixture.device.groups
          .ports(key)
          .control.apply({ strand: { reason: 'lost-state' } }, 'pending-reopen')
        await fault.rejected
        let reopened = false
        const reopening = fixture.reopen().then((next) => {
          reopened = true
          cold = next
          return next
        })
        await Promise.resolve()
        expect(reopened).toBe(false)
        await fault.finish('commit')
        await operation
        const next = await reopening
        expect((await next.device.groups.ports(key).control.load()).strand).toEqual({
          reason: 'lost-state',
        })
        expect(next.restoreCount(groupID)).toBe(0)
      } finally {
        await cold?.close()
        await fixture.close()
      }
    })

    test('next work fault captures the internally allocated installation ID', async () => {
      const fixture = await create()
      try {
        const handle = await fixture.makeHandle(0)
        const fault = fixture.armNextWorkFault('before-commit')
        await expect(
          fixture.installRows({
            key,
            state: {
              ...key,
              version: 1,
              deleted: false,
              terminal: false,
              epoch: 0,
              epochAuthenticator: handle.state.keySchedule.epochAuthenticator,
              state: encodeClientState(handle.state),
              credential: handle.credential,
              ledger: handle.ledgerTokens,
              senderHWM: 0,
            },
            trust: recoveryTrustFor(handle, key, null),
          }),
        ).rejects.toThrow('Injected before-commit failure')
        expect(await fault.mutationID).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/)
        expect(await fixture.device.groups.load(groupID)).toBeNull()
      } finally {
        await fixture.close()
      }
    })

    test('row setup installs transport, control and settlement fields', async () => {
      const fixture = await create('seeded')
      try {
        const entry = {
          seq: 11,
          protocol: 'chat',
          prc: 'posted',
          data: new Uint8Array([1]),
          status: 'accepted' as const,
          lastAttempt: null,
        }
        const settlement = {
          sequenceID: '11',
          attemptID: 'attempt-11',
          topicID: 'chat-topic',
          outcome: 'published' as const,
        }
        const event = { ...key, id: 'setup-event', kind: 'accepted' as const, entry }
        const anchor = { anchor: { epoch: 0, secret: new Uint8Array(32).fill(4) } }
        await fixture.installRows({
          key,
          control: { strand: { reason: 'lost-state' } },
          anchor,
          outbox: [entry],
          events: [event],
          settlements: [{ seq: 11, value: settlement }],
        })
        const ports = fixture.device.groups.ports(key)
        expect((await ports.control.load()).strand).toEqual({ reason: 'lost-state' })
        expect(await ports.anchor.load()).toEqual(anchor)
        expect(await ports.outbox.list()).toEqual([entry])
        expect(await ports.outbox.loadSettlement(11)).toEqual(settlement)
        expect(await ports.outbox.events()).toEqual([event])
      } finally {
        await fixture.close()
      }
    })

    test('restore hold and override exercise cold reconstruction', async () => {
      const fixture = await create('seeded')
      try {
        const record = await fixture.device.groups.loadState(key)
        if (record === null || record.deleted || record.state === null)
          throw new Error('Missing source')
        const held = fixture.holdRestore(groupID)
        let finished = false
        const operation = registryFixtureRestore(fixture)({ ...record, state: record.state }).then(
          (handle) => {
            finished = true
            return handle
          },
        )
        await held.started
        expect(finished).toBe(false)
        expect(fixture.restoreCount(groupID)).toBe(1)
        held.release()
        const first = await operation
        fixture.overrideRestore(async () => first)
        expect(await registryFixtureRestore(fixture)({ ...record, state: record.state })).toBe(
          first,
        )
        expect(fixture.restoreCount(groupID)).toBe(2)
      } finally {
        await fixture.close()
      }
    })

    test('proof hold targets its mutation only', async () => {
      const fixture = await create('seeded')
      try {
        const held = fixture.holdProof('target-proof')
        fixture.armWorkFault('other-proof', 'commit-then-reject')
        const control = fixture.device.groups.ports(key).control
        await control.apply({ strand: { reason: 'lost-state' } }, 'other-proof')
        const fault = fixture.armWorkFault('target-proof', 'pending')
        let finished = false
        const operation = control.apply({ strand: null }, 'target-proof').then(() => {
          finished = true
        })
        await fault.rejected
        await held.started
        await fault.finish('commit')
        expect(finished).toBe(false)
        held.release()
        await operation
        expect((await control.load()).strand).toBeNull()
      } finally {
        await fixture.close()
      }
    })

    test('corruption preserves lifetime and independent metadata', async () => {
      const fixture = await create('seeded')
      try {
        const entry = entryCapability(fixture.device.groups)
        if (entry === null) throw new Error('Missing capability')
        const metadata = await entry.read(groupID, (reads) => reads.metadata(1))
        await fixture.corruptState(key)
        expect(await entry.read(groupID, (reads) => reads.diagnoseState(1))).toBe('unreadable')
        expect(await entry.read(groupID, (reads) => reads.metadata(1))).toEqual(metadata)
        await fixture.removeStateBytes(key)
        expect(await entry.read(groupID, (reads) => reads.diagnoseState(1))).toBe('missing')
        expect(await entry.read(groupID, (reads) => reads.metadata(1))).toEqual(metadata)
        await fixture.mutateMetadata(key, (value) => {
          if (value === null || typeof value !== 'object') throw new Error('Missing metadata')
          return { ...value, version: 0 }
        })
        await expect(entry.read(groupID, (reads) => reads.metadata(1))).rejects.toThrow(
          'Unreadable state version metadata',
        )
        await fixture.corruptTrust(groupID)
        await expect(fixture.device.groups.loadTrust(groupID)).rejects.toThrow()
        expect(await fixture.device.groups.load(groupID)).toEqual(
          expect.objectContaining({ activeIncarnation: 1 }),
        )
      } finally {
        await fixture.close()
      }
    })

    test('advance creates independent durable candidates', async () => {
      const fixture = await create()
      try {
        const first = await fixture.makeHandle(0)
        const bytes = encodeClientState(first.state)
        const next = await fixture.advance(first)
        expect(next).not.toBe(first)
        expect(next.epoch).toBe(first.epoch + 1n)
        expect(encodeClientState(first.state)).toEqual(bytes)
        expect(next.state.keySchedule.epochAuthenticator).not.toEqual(
          first.state.keySchedule.epochAuthenticator,
        )
        validateRegistryHandle({
          handle: next,
          key,
          trust: null,
          environment: fixture.environment,
          ownerDID: fixture.device.ownerDID,
        })
      } finally {
        await fixture.close()
      }
    })

    test.each(['ordinary', 'last-resort'] as const)(
      'welcome history fixture joins (%s)',
      async (kind) => {
        const fixture = await create()
        try {
          const { history, retained } = await createRegistryWelcomeHistory({
            mode,
            groupID,
            identity: fixture.identity,
            options: fixture.environment.options,
            kind,
          })
          for (const artifact of retained) {
            const joined = await artifact.join()
            expect(joined.epoch).toBe(artifact.handle.epoch)
            expect(joined.state.keySchedule.epochAuthenticator).toEqual(
              artifact.handle.state.keySchedule.epochAuthenticator,
            )
            expect(joined.credential.id).toBe(fixture.identity.id)
          }
          expect(history.alternate.epoch).toBe(history.exact.epoch)
          expect(history.alternate.state.keySchedule.epochAuthenticator).not.toEqual(
            history.exact.state.keySchedule.epochAuthenticator,
          )
          expect(history.newer.epoch).toBeGreaterThan(history.exact.epoch)
          expect(history.unusedOlder.epoch).toBeLessThan(history.exact.epoch)
          expect(history.packageUse.kind).toBe(kind)
          const publicHistory = await fixture.welcomeHistory(kind)
          for (const handle of [
            publicHistory.exact,
            publicHistory.alternate,
            publicHistory.newer,
            publicHistory.unusedOlder,
          ]) {
            validateRegistryHandle({
              handle,
              key,
              trust: null,
              environment: fixture.environment,
              ownerDID: fixture.device.ownerDID,
            })
          }
        } finally {
          await fixture.close()
        }
      },
    )

    test('recovery verdict fixture is authoritative', async () => {
      const fixture = await create('seeded')
      try {
        const { candidate, record } = await fixture.confirmedRecovery(key)
        const snapshot = decodeRecoveryCandidate(record.candidate, record.requestKey)
        expect(encodeClientState(candidate.state)).toEqual(encodeClientState(snapshot.state))
        if (record.verdict === undefined) throw new Error('Missing verdict')
        const opened = await openRecoveryVerdict({
          group: candidate,
          sealed: record.verdict,
          requestID: record.requestID,
          ephemeralPrivateKey: record.requestKey,
        })
        const judge = createVerdictJudge({
          group: candidate,
          sourceTree: snapshot.sourceTree,
          known: snapshot.knownRegistry,
          requestID: record.requestID,
          boundCommit: snapshot.boundCommit,
        })
        expect(judge.judgeVerdict(opened)).toBe('authoritative')
        if (opened.verdict.verdict !== 'confirmed') throw new Error('Missing confirmation')
        expect(
          judge.judgeVerdict({ ...opened, verdict: { ...opened.verdict, tag: 'tampered' } }),
        ).toBe('advisory')
        expect(record.stage).toBe('confirmed')
        expect(record.source.key).toEqual(key)
      } finally {
        await fixture.close()
      }
    })
  })
}
