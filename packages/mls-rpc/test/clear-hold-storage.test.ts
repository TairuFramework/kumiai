import { type CheckpointRecord, forkEventID, recoveryUnavailableEventID } from '@kumiai/rpc'
import { testReportedHoldStorageConformance } from '@kumiai/rpc-conformance'
import { describe, expect, test } from 'vitest'

import { createCheckpointService } from '../src/checkpoint.js'
import { createClearReportedHold } from '../src/clear-hold.js'
import { entryCapability } from '../src/entry-capability.js'
import { decodeStoredValue } from '../src/persistence-codec.js'
import type { MemoryTransaction } from '../src/persistence-types.js'
import { bindRegistrySafety, registrySafety } from '../src/registry/safety.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createRegistryFixture, type RegistryFixture } from './fixtures/registry.js'

for (const mode of ['real-mls', 'double'] as const) {
  for (const context of ['supplied', 'absent'] as const) {
    describe(`app hold storage / ${mode} / ownership context ${context}`, () => {
      const key = { groupID: `app-hold-${mode}-${context}`, incarnation: 1 }
      async function run(work: (f: RegistryFixture) => Promise<void>) {
        const f = await createRegistryFixture({
          mode,
          groupID: key.groupID,
          setup: 'seeded',
          ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        })
        try {
          await work(f)
        } finally {
          await f.close()
        }
      }
      const control = (f: RegistryFixture) => f.device.groups.ports(key).control
      const clear = (f: RegistryFixture) =>
        createClearReportedHold({ registry: f.registry, persistence: f.device.groups })
      function entry(f: RegistryFixture) {
        const value = entryCapability(f.device.groups)
        if (value === null) throw new Error('Missing coordinator')
        return value
      }
      const records = (f: RegistryFixture) =>
        entry(f).read(key.groupID, (reads) => reads.checkpoints())
      const history = async (f: RegistryFixture) =>
        (await records(f)).flatMap((row) => (row.kind === 'hold-history' ? [row.halt] : []))
      async function report(f: RegistryFixture, mask = 1) {
        const trust = await f.device.groups.loadTrust(key.groupID)
        if (trust === null) throw new Error('Missing trust')
        const local = trust.installed.authenticator
        const remote = local.slice()
        remote[0] = (remote[0] ?? 0) ^ mask
        await f.safety().reportFork(key, {
          kind: 'epoch-authenticator',
          epoch: trust.installed.epoch,
          local,
          remote,
        })
        const halt = (await control(f).load()).forkHalt
        if (halt === null) throw new Error('Missing reported halt')
        return halt
      }
      const halt = () => ({
        eventID: forkEventID(key),
        detectedAt: 42,
        evidence: {
          kind: 'unexplained-own-commit' as const,
          epoch: 0,
          position: '1',
          digest: 'conflict',
        },
      })

      test('only matching app report can be cleared', () =>
        run(async (f) => {
          const original = await report(f)
          const provenance = (await records(f)).find((row) => row.kind === 'app-hold')
          expect(original.producer).toBe('app-report')
          expect(provenance).toMatchObject({
            kind: 'app-hold',
            key,
            producer: 'app-report',
            eventID: original.eventID,
            clearedAt: null,
          })
          if (provenance?.kind !== 'app-hold') throw new Error('Missing provenance')
          for (const request of [
            { eventID: 'wrong-event', reportMutationID: provenance.reportMutationID },
            { eventID: original.eventID, reportMutationID: 'wrong-report' },
            { eventID: original.eventID, reportMutationID: provenance.reportMutationID },
          ]) {
            const before = await f.inspectRows()
            await expect(
              control(f).apply({ clearAppHold: request }, crypto.randomUUID()),
            ).rejects.toThrow()
            expect(await f.inspectRows()).toEqual(before)
          }
          await clear(f)({ ...key, incarnation: 2 })
          await clear(f)({ ...key, groupID: 'another-group' })
          expect((await control(f).load()).forkHalt).toEqual(original)
          await clear(f)(key)
          expect((await control(f).load()).forkHalt).toBeNull()
        }))

      test('clear keeps immutable evidence in history', () =>
        run(async (f) => {
          const originalAppHalt = await report(f)
          await clear(f)(key)
          expect(await history(f)).toContainEqual(originalAppHalt)
          const before = await f.inspectRows()
          await clear(f)(key)
          expect(await f.inspectRows()).toEqual(before)
          const reopened = await f.reopen()
          try {
            expect((await control(reopened).load()).forkHalt).toBeNull()
            expect(await history(reopened)).toEqual([originalAppHalt])
            const rows = await records(reopened)
            expect(rows.find((row) => row.kind === 'app-hold')).toMatchObject({
              clearedAt: expect.any(Number),
            })
            const stored = (await reopened.inspectRows()).checkpoints
            expect(stored).toBeDefined()
            for (const [address, bytes] of stored ?? []) {
              expect(JSON.parse(address)[1]).toBeNull()
              expect(bytes).toBeInstanceOf(Uint8Array)
              expect(() => decodeStoredValue(bytes as Uint8Array)).toThrow()
            }
          } finally {
            await reopened.close()
          }
        }))

      test.each(['rollback', 'commit'] as const)(
        'rollback and uncertain clear preserve hold: late %s',
        (outcome) =>
          run(async (f) => {
            const original = await report(f)
            const before = await f.inspectRows()
            const fault = f.armNextWorkFault('pending')
            let completed = false
            const pending = clear(f)(key).then(() => {
              completed = true
            })
            const result = pending.then(
              () => null,
              (error: unknown) => error,
            )
            await fault.rejected
            expect(completed).toBe(false)
            expect(await f.inspectRows()).toEqual(before)
            await fault.finish(outcome)
            const error = await result
            if (outcome === 'commit') {
              expect(error).toBeNull()
              expect((await control(f).load()).forkHalt).toBeNull()
              expect(await history(f)).toEqual([original])
            } else {
              expect(error).not.toBeNull()
              expect(await f.inspectRows()).toEqual(before)
              expect((await control(f).load()).forkHalt).toEqual(original)
            }
          }),
      )

      test('committed clear waits for proof before resolving', () =>
        run(async (f) => {
          await report(f)
          const access = await f.registry.access(key.groupID)
          const fault = f.armNextWorkFault('commit-then-reject')
          let completed = false
          const pending = clear(f)(key).then(() => {
            completed = true
          })
          const proof = f.holdProof(await fault.mutationID)
          try {
            await proof.started
            expect(completed).toBe(false)
            expect(access.admission()).toMatchObject({ reason: 'fork-halted' })
          } finally {
            proof.release()
          }
          await pending
          expect(completed).toBe(true)
          expect((await control(f).load()).forkHalt).toBeNull()
        }))

      test('legacy halt with app event ID remains uncleareable', () =>
        run(async (f) => {
          const legacyHaltBeforeClear = halt()
          await f.installRows({ key, control: { forkHalt: legacyHaltBeforeClear } })
          const reopened = await f.reopen()
          try {
            const before = await reopened.inspectRows()
            await clear(reopened)(key)
            const legacyHaltAfterClear = (await control(reopened).load()).forkHalt
            expect(legacyHaltAfterClear).toEqual(legacyHaltBeforeClear)
            expect(await history(reopened)).toEqual([])
            expect(await reopened.inspectRows()).toEqual(before)
          } finally {
            await reopened.close()
          }
        }))

      test('internal provenance cannot inherit app ownership', () =>
        run(async (f) => {
          await report(f)
          await clear(f)(key)
          const internalHoldBeforeClear = { ...halt(), producer: 'internal' as const }
          await f.installRows({ key, control: { forkHalt: internalHoldBeforeClear } })
          const before = await f.inspectRows()
          await Promise.all([
            clear(f)(key),
            f.safety().reportFork(key, internalHoldBeforeClear.evidence),
          ])
          const internalHoldAfterClear = (await control(f).load()).forkHalt
          expect(internalHoldAfterClear).toEqual(internalHoldBeforeClear)
          expect(internalHoldAfterClear?.producer).toBe('internal')
          expect(await f.inspectRows()).toEqual(before)
        }))

      test('app producer without private report provenance cannot clear', () =>
        run(async (f) => {
          await f.installRows({ key, control: { forkHalt: { ...halt(), producer: 'app-report' } } })
          const before = await f.inspectRows()
          await clear(f)(key)
          expect(await f.inspectRows()).toEqual(before)
        }))

      test.each(['key', 'producer', 'event', 'report'] as const)(
        'forged %s provenance cannot release the current report',
        (field) =>
          run(async (f) => {
            await report(f)
            const before = await f.inspectRows()
            const capability = registrySafety<MemoryTransaction>(f.registry)
            if (capability === null) throw new Error('Missing safety capability')
            bindRegistrySafety(f.registry, {
              ...capability,
              entry: {
                ...capability.entry,
                run: (request, prepare, work) =>
                  capability.entry.run(
                    request,
                    (reads) =>
                      prepare({
                        ...reads,
                        checkpoints: async () =>
                          (await reads.checkpoints()).map((row) => {
                            if (row.kind !== 'app-hold') return row
                            if (field === 'key') return { ...row, key: { ...key, incarnation: 2 } }
                            if (field === 'producer')
                              return { ...row, producer: 'internal' } as unknown as CheckpointRecord
                            if (field === 'event') return { ...row, eventID: 'another-event' }
                            return { ...row, reportMutationID: 'another-report' }
                          }),
                      }),
                    work,
                  ),
              },
            })
            if (field === 'report') await expect(clear(f)(key)).rejects.toThrow()
            else await clear(f)(key)
            expect(await f.inspectRows()).toEqual(before)
          }),
      )

      test.each(['history', 'provenance', 'evidence', 'event', 'report'] as const)(
        'clear requires its exact %s co-write and request',
        (field) =>
          run(async (f) => {
            await report(f)
            const before = await f.inspectRows()
            const capability = registrySafety<MemoryTransaction>(f.registry)
            if (capability === null) throw new Error('Missing safety capability')
            bindRegistrySafety(f.registry, {
              ...capability,
              entry: {
                ...capability.entry,
                run: (request, prepare, work) =>
                  capability.entry.run(request, prepare, (stores, prepared) =>
                    work(
                      {
                        ...stores,
                        checkpoints: {
                          ...stores.checkpoints,
                          put: async (row) => {
                            if (
                              (field === 'history' && row.kind === 'hold-history') ||
                              (field === 'provenance' && row.kind === 'app-hold')
                            )
                              return
                            const value =
                              field === 'evidence' && row.kind === 'hold-history'
                                ? {
                                    ...row,
                                    halt: { ...row.halt, detectedAt: row.halt.detectedAt + 1 },
                                  }
                                : row
                            await stores.checkpoints.put(value)
                          },
                        },
                        incarnation: (incarnation) => {
                          const target = stores.incarnation(incarnation)
                          return {
                            ...target,
                            control: {
                              ...target.control,
                              apply: (changes, mutationID) => {
                                if (
                                  changes.clearAppHold !== undefined &&
                                  (field === 'event' || field === 'report')
                                )
                                  return target.control.apply(
                                    {
                                      ...changes,
                                      clearAppHold: {
                                        ...changes.clearAppHold,
                                        ...(field === 'event'
                                          ? { eventID: 'another-event' }
                                          : { reportMutationID: 'another-report' }),
                                      },
                                    },
                                    mutationID,
                                  )
                                return target.control.apply(changes, mutationID)
                              },
                            },
                          }
                        },
                      },
                      prepared,
                    ),
                  ),
              },
            })
            await expect(clear(f)(key)).rejects.toThrow()
            expect(await f.inspectRows()).toEqual(before)
          }),
      )

      test('non app conditions survive clear', () =>
        run(async (f) => {
          await f.installRows({
            key,
            control: {
              controlHold: { reason: 'unsupported-version', position: null },
              recoveryUnavailable: {
                ...key,
                id: recoveryUnavailableEventID(key),
                kind: 'group:recovery-unavailable',
                reason: 'trust-unreadable',
              },
            },
          })
          await report(f)
          const before = await control(f).load()
          await clear(f)(key)
          expect(await control(f).load()).toEqual({ ...before, forkHalt: null })
          // Live latches stay held until release propagation is installed.
          expect((await f.safety().status(key)).hold).toBe('fork-halted')
        }))

      test('repeated reports after clear preserve both incidents', () =>
        run(async (f) => {
          const first = await report(f)
          await clear(f)(key)
          await Promise.all([report(f, 2), report(f, 2)])
          const second = (await control(f).load()).forkHalt
          expect(second?.producer).toBe('app-report')
          expect(await f.safety().events(key)).toEqual([
            { ...key, id: second?.eventID, kind: 'group:fork', halt: second },
          ])
          await clear(f)(key)
          expect(await history(f)).toEqual([first, second])
          const incidents = (await records(f)).filter((row) => row.kind === 'hold-history')
          expect(new Set(incidents.map((row) => row.id)).size).toBe(2)
        }))

      test('generic records cannot fabricate, replace or remove report provenance and history', () =>
        run(async (f) => {
          await report(f)
          await clear(f)(key)
          const protectedRows = (await records(f)).filter(
            (row) => row.kind === 'app-hold' || row.kind === 'hold-history',
          )
          const service = createCheckpointService({
            registry: f.registry,
            key,
            identity: f.identity,
          })
          for (const row of protectedRows) {
            for (const change of [
              { put: [row] },
              { put: [{ ...row, id: `forged:${row.id}` }] },
              { remove: [row.id] },
            ]) {
              const before = await f.inspectRows()
              await expect(service.updateRecords(change)).rejects.toThrow()
              expect(await f.inspectRows()).toEqual(before)
            }
            for (const action of ['add', 'replace', 'remove'] as const) {
              const before = await f.inspectRows()
              await expect(
                entry(f).run(
                  { groupID: key.groupID, mutationID: crypto.randomUUID() },
                  async (reads) => ({ expected: await reads.lifetime(), value: null }),
                  async (stores) => {
                    if (action === 'remove') await stores.checkpoints.remove([row.id])
                    else
                      await stores.checkpoints.put({
                        ...row,
                        id: action === 'add' ? `forged:${row.id}` : row.id,
                        reportMutationID: 'another-report',
                      } as CheckpointRecord)
                  },
                ),
              ).rejects.toThrow()
              expect(await f.inspectRows()).toEqual(before)
            }
          }
        }))
    })
  }
}

for (const mode of ['real-mls', 'double'] as const) {
  for (const context of ['supplied', 'absent'] as const) {
    testReportedHoldStorageConformance({
      label: `${mode} / ownership context ${context}`,
      async createFixture() {
        const key = { groupID: `reported-hold-contract-${mode}-${context}`, incarnation: 1 }
        const fixture = await createRegistryFixture({
          mode,
          groupID: key.groupID,
          setup: 'seeded',
          ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        })
        const reopened: Array<RegistryFixture> = []
        const records = (f = fixture) => {
          const entry = entryCapability(f.device.groups)
          if (entry === null) throw new Error('Missing coordinator')
          return entry.read(key.groupID, (reads) => reads.checkpoints())
        }
        return {
          key,
          control: fixture.device.groups.ports(key).control,
          async report() {
            const identity = await fixture.safety().epochAuthenticator(key)
            if (identity === null) throw new Error('Missing identity')
            const remote = identity.authenticator.slice()
            remote[0] = (remote[0] ?? 0) ^ 1
            await fixture.safety().reportFork(key, {
              kind: 'epoch-authenticator',
              epoch: identity.epoch,
              local: identity.authenticator,
              remote,
            })
            const halt = (await fixture.device.groups.ports(key).control.load()).forkHalt
            if (halt === null) throw new Error('Missing halt')
            return halt
          },
          clear: () =>
            createClearReportedHold({
              registry: fixture.registry,
              persistence: fixture.device.groups,
            })(key),
          records: () => records(),
          async reopen() {
            const f = await fixture.reopen()
            reopened.push(f)
            return { control: f.device.groups.ports(key).control, records: () => records(f) }
          },
          async close() {
            for (const f of reopened) await f.close()
            await fixture.close()
          },
        }
      },
    })
  }
}
