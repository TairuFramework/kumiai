import { describe, expect, test, vi } from 'vitest'

import { retirementDomain } from '../src/closing-preparation.js'
import { type DeviceEntryReads, deviceEntryCapability } from '../src/device-entry-capability.js'
import type { ClosingPreparation, EntryReads, Prepared } from '../src/entry-capability.js'
import { createGroupStateStores } from '../src/memory-group-state.js'
import { physicalRecordKey, sealRecord } from '../src/persistence-codec.js'
import { DisplacedGroupHandleError } from '../src/persistence-errors.js'
import type { GroupStateRecord } from '../src/persistence-types.js'
import { memoryFaults } from '../src/testing.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { requireValue } from './fixtures/require-value.js'
import { sourceExecutorFixture } from './fixtures/source-executor.js'
import { makeStorageSeed, writeInstallationCheckpoint } from './fixtures/storage-seed.js'

type Fixture = Awaited<ReturnType<typeof sourceExecutorFixture>>
async function terminal(
  f: Fixture,
  reads: EntryReads,
  closing: ClosingPreparation,
  expectedDeviceRevision?: number,
) {
  expect(closing, 'entry supplies private closing preparation').toBeDefined()
  const record = await reads.state(1)
  if (record === null || record.deleted) throw new Error('Missing source')
  const state = { ...record, terminal: true, version: record.version + 1 }
  return closing.freeze({
    source: f.seed.key,
    reason: 'terminal',
    prepared: {
      expected: await reads.lifetime(),
      value: { state },
      ...(expectedDeviceRevision === undefined ? {} : { expectedDeviceRevision }),
    },
    domain: { states: [state], lifetime: null },
  })
}
async function writeTerminal(f: Fixture, mutationID: string = crypto.randomUUID()) {
  return f.entry.run(
    { groupID: f.seed.key.groupID, mutationID },
    (reads, closing) => terminal(f, reads, closing),
    async (stores, value) => {
      await stores.incarnation(1).state.save(value.state)
      return 'persisted'
    },
  )
}

for (const context of [false, true]) {
  describe(`closing authority (ownershipContext=${context})`, () => {
    const fixture = () =>
      sourceExecutorFixture({
        ownershipContext: context ? createAsyncLocalOwnershipContext() : undefined,
      })

    test('closing mutation persists frozen data without renewed authority', async () => {
      const f = await fixture()
      const binding = await f.control.admit(f.seed.key, 'source')
      let original!: GroupStateRecord
      await f.entry.run(
        { groupID: f.seed.key.groupID, mutationID: 'frozen-removal' },
        async (reads, closing) => {
          const frozen = await terminal(f, reads, closing)
          original = frozen.value.state
          // The returned value is detached again at submission.
          return frozen
        },
        async (stores, value) => {
          expect(() => f.control.assertCurrent(binding), 'closed before frozen write').toThrow(
            DisplacedGroupHandleError,
          )
          if (!original.deleted) original.terminal = false
          expect(value.state.terminal, 'work receives frozen bytes').toBe(true)
          await stores.incarnation(1).state.save(value.state)
        },
      )
      expect(await f.persistence.groups.loadState(f.seed.key)).toMatchObject({ terminal: true })
      const opens = f.opens.filter((namespace) => namespace === 'state').length
      await expect(
        f.executor.execute({ binding, command: 'source.inspect', input: undefined }),
      ).rejects.toBeInstanceOf(DisplacedGroupHandleError)
      expect(
        f.opens.filter((namespace) => namespace === 'state').length,
        'refused source starts no private primitive',
      ).toBe(opens)
    })

    test.each(['switch', 'readmission'] as const)(
      'closing %s persists its frozen domain',
      async (reason) => {
        const f = await fixture()
        const old = await f.control.admit(f.seed.key, 'source')
        const destination = await makeStorageSeed({
          id: f.seed.key.groupID,
          incarnation: 2,
          epoch: 3,
          mode: 'double',
          identity: f.environment.identity,
        })
        destination.trust.spentEpochAuthenticators.push(...f.seed.trust.spentEpochAuthenticators)
        await f.entry.run(
          { groupID: f.seed.key.groupID, mutationID: reason },
          async (reads, closing) => {
            const previous = await reads.lifetime()
            if (previous === null) throw new Error('Missing source')
            const lifetime = {
              ...destination.lifetime,
              revision: previous.revision + 1,
              mutationID: reason,
            }
            const prepared = {
              expected: previous,
              value: { lifetime, state: destination.state, trust: destination.trust },
            }
            return closing.freeze({
              source: f.seed.key,
              reason,
              prepared,
              domain: await retirementDomain(reads, lifetime, [destination.state]),
            })
          },
          async (stores, value) => {
            expect(() => f.control.assertCurrent(old)).toThrow(DisplacedGroupHandleError)
            await stores.lifetime.save(value.lifetime)
            await stores.incarnation(2).state.save(value.state)
            await stores.trust.save(value.trust)
            await writeInstallationCheckpoint(stores, {
              key: destination.key,
              confirmedTranscriptHash: destination.confirmedTranscriptHash,
              stateVersion: 1,
              mutationID: reason,
            })
          },
        )
        expect(await f.persistence.groups.loadState(f.seed.key)).toMatchObject({ deleted: true })
        const fresh = await f.control.admit(destination.key, 'source')
        await expect(
          f.executor.execute({ binding: fresh, command: 'source.inspect', input: undefined }),
        ).resolves.toHaveProperty('binding', fresh)
        expect(() => f.control.assertCurrent(old)).toThrow(DisplacedGroupHandleError)
      },
    )

    test('source closes before backend commit can precede proof', async () => {
      const f = await fixture()
      const binding = await f.control.admit(f.seed.key, 'source')
      const proofEntered = Promise.withResolvers<void>()
      const proofRelease = Promise.withResolvers<void>()
      const barrier = f.db.completionBarrier.bind(f.db)
      const spy = vi.spyOn(f.db, 'completionBarrier').mockImplementation(async (scope) => {
        await barrier(scope)
        if (scope.groupID === f.seed.key.groupID) {
          proofEntered.resolve()
          await proofRelease.promise
        }
      })
      const fault = memoryFaults(f.db).rejectCommitPending()
      let published = 0
      const stop = f.entry.observe(f.seed.key.groupID, () => published++)
      const result = writeTerminal(f)
      await Promise.race([fault.rejected, result])
      await fault.barrierWaiting
      expect(() => f.control.assertCurrent(binding), 'closure precedes proof').toThrow(
        DisplacedGroupHandleError,
      )
      expect(published, 'no terminal fact before proof').toBe(0)
      await fault.finish('commit')
      await proofEntered.promise
      expect(await f.reopenPersistence().groups.loadState(f.seed.key)).toMatchObject({
        terminal: true,
      })
      expect(() => f.control.assertCurrent(binding), 'backend commit still precedes proof').toThrow(
        DisplacedGroupHandleError,
      )
      expect(published, 'committed rows publish no terminal fact before proof').toBe(0)
      proofRelease.resolve()
      expect(await result).toBe('persisted')
      expect(published).toBe(1)
      stop()
      spy.mockRestore()
    })

    test('unknown outcome retains closure and both Combined owners', async () => {
      const f = await fixture()
      await f.control.admit(f.seed.key, 'source')
      const combined = deviceEntryCapability(f.persistence)
      if (combined === null) throw new Error('Missing Combined')
      const fault = memoryFaults(f.db).rejectCommitPending()
      const result = combined.runCombined(
        { groupID: f.seed.key.groupID, mutationID: 'combined-close' },
        async (reads, closing) => {
          const revision = (await reads.device()).revision
          const prepared = await terminal(f, reads.group, closing, revision)
          return Object.assign(prepared, { expectedDeviceRevision: revision })
        },
        async (stores, value) => {
          if (stores.group === null) throw new Error('Missing group')
          await stores.group.incarnation(1).state.save(value.state)
        },
      )
      await Promise.race([fault.rejected, result])
      await fault.barrierWaiting
      const progressed: Array<string> = []
      const pending = [
        combined.read(async (stores) => {
          await stores.ordinary('source').list(f.environment.identity.id)
          progressed.push('package')
        }),
        f.entry.read(f.seed.key.groupID, async (reads) => {
          await reads.pendingFrames(1)
          progressed.push('completion')
        }),
        f.control.admit(f.seed.key, 'source').catch(() => progressed.push('source')),
      ]
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        await vi.advanceTimersByTimeAsync(86_400_000)
        await f.flushReady()
        expect(progressed, 'unknown retains D and G without elapsed-time release').toEqual([])
      } finally {
        vi.useRealTimers()
      }
      await fault.finish('commit')
      await result
      await Promise.all(pending)
      expect(progressed.sort()).toEqual(['completion', 'package', 'source'])
    })

    test('Combined closing binds its prepared device revision before transact', async () => {
      const f = await fixture()
      await f.control.admit(f.seed.key, 'source')
      const combined = deviceEntryCapability(f.persistence)
      if (combined === null) throw new Error('Missing Combined')
      f.transactions.mockClear()
      await expect(
        combined.runCombined(
          { groupID: f.seed.key.groupID, mutationID: 'device-guard' },
          async (reads, closing) => {
            const revision = (await reads.device()).revision
            const prepared = await terminal(f, reads.group, closing, revision)
            return Object.assign(prepared, { expectedDeviceRevision: revision + 1 })
          },
          async () => {},
        ),
      ).rejects.toThrow()
      expect(f.transactions.mock.calls, 'device guard is frozen before submission').toHaveLength(0)
    })

    test('rollback retry retains the original Combined device guard', async () => {
      for (const changed of [false, true]) {
        const f = await fixture()
        const old = await f.control.admit(f.seed.key, 'source')
        const combined = deviceEntryCapability(f.persistence)
        if (combined === null) throw new Error('Missing Combined')
        const prepare = async (reads: DeviceEntryReads, closing: ClosingPreparation) => {
          const revision = (await reads.device()).revision
          const prepared = await terminal(f, reads.group, closing, revision)
          return Object.assign(prepared, { expectedDeviceRevision: revision })
        }
        const fault = memoryFaults(f.db).rejectCommitPending()
        const first = combined
          .runCombined(
            { groupID: f.seed.key.groupID, mutationID: 'device-retry' },
            prepare,
            async (stores, value) => {
              if (stores.group === null) throw new Error('Missing group')
              await stores.group.incarnation(1).state.save(value.state)
            },
          )
          .catch((error: unknown) => error)
        await Promise.race([
          fault.rejected,
          first.then((error) => {
            throw error
          }),
        ])
        await fault.barrierWaiting
        await fault.finish('rollback')
        expect(await first).toMatchObject({ name: 'StorageOutcomeUnknownError' })
        await f.control.admit(f.seed.key, 'source')
        if (changed) {
          const device = await f.persistence.load()
          await f.persistence.transition(
            { mutationID: 'device-progress', expectedRevision: device.revision, group: null },
            async () => {},
          )
        }
        f.transactions.mockClear()
        const retry = combined.runCombined(
          { groupID: f.seed.key.groupID, mutationID: 'device-retry' },
          prepare,
          async (stores, value) => {
            if (stores.group === null) throw new Error('Missing group')
            await stores.group.incarnation(1).state.save(value.state)
          },
        )
        if (changed) {
          await expect(retry, 'retry retains original device revision').rejects.toThrow()
          expect(f.transactions.mock.calls, 'changed guard refuses before transact').toHaveLength(0)
        } else await expect(retry, 'unchanged Combined retry succeeds').resolves.toBeUndefined()
        expect(() => f.control.assertCurrent(old)).toThrow(DisplacedGroupHandleError)
      }
    })

    test('fresh admission never revives superseded references', async () => {
      for (const changed of [false, true]) {
        const f = await fixture()
        const old = await f.control.admit(f.seed.key, 'source')
        const fault = memoryFaults(f.db).rejectCommitPending()
        let frozen!: Prepared<{ state: GroupStateRecord }>
        const failed = f.entry
          .run(
            { groupID: f.seed.key.groupID, mutationID: 'retry-removal' },
            async (reads, closing) => {
              frozen = await terminal(f, reads, closing)
              return frozen
            },
            async (stores, value) => {
              await stores.incarnation(1).state.save(value.state)
            },
          )
          .catch((error: unknown) => error)
        await Promise.race([
          fault.rejected,
          failed.then((error) => {
            throw error
          }),
        ])
        await fault.barrierWaiting
        await fault.finish('rollback')
        expect(await failed).toMatchObject({ name: 'StorageOutcomeUnknownError' })
        const fresh = await f.control.admit(f.seed.key, 'source')
        expect(fresh.generation).not.toBe(old.generation)
        expect(() => f.control.assertCurrent(old), 'old generation never reopens').toThrow(
          DisplacedGroupHandleError,
        )
        await expect(
          f.executor.execute({ binding: fresh, command: 'source.inspect', input: undefined }),
        ).resolves.toHaveProperty('binding', fresh)
        if (changed) await f.save('progress')
        const transactions = f.transactions.mock.calls.length
        const retry = f.entry.run(
          { groupID: f.seed.key.groupID, mutationID: 'retry-removal' },
          (_reads, closing) =>
            closing.freeze({
              source: f.seed.key,
              reason: 'terminal',
              prepared: { ...frozen, closing: undefined },
              domain: { states: [frozen.value.state], lifetime: null },
            }),
          async (stores, value) => {
            await stores.incarnation(1).state.save(value.state)
          },
        )
        if (changed) {
          await expect(retry, 'retry revalidates original expected tuple').rejects.toThrow()
          expect(f.transactions.mock.calls.length, 'rollback retry refuses before transact').toBe(
            transactions,
          )
          await expect(writeTerminal(f, 'fresh-retry-control')).resolves.toBe('persisted')
        } else
          await expect(
            retry,
            'unchanged frozen retry succeeds under fresh authority',
          ).resolves.toBeUndefined()
        expect(() => f.control.assertCurrent(old)).toThrow(DisplacedGroupHandleError)
      }
    })

    test('rollback retry retains the original identity with unchanged counters', async () => {
      const f = await fixture()
      await f.control.admit(f.seed.key, 'source')
      let frozen!: Prepared<{ state: GroupStateRecord }>
      const fault = memoryFaults(f.db).rejectCommitPending()
      const first = f.entry
        .run(
          { groupID: f.seed.key.groupID, mutationID: 'identity-retry' },
          async (reads, closing) => {
            frozen = await terminal(f, reads, closing)
            return frozen
          },
          async (stores, value) => {
            await stores.incarnation(1).state.save(value.state)
          },
        )
        .catch((error: unknown) => error)
      await Promise.race([
        fault.rejected,
        first.then((error) => {
          throw error
        }),
      ])
      await fault.barrierWaiting
      await fault.finish('rollback')
      expect(await first).toMatchObject({ name: 'StorageOutcomeUnknownError' })
      const location = {
        groupID: f.seed.key.groupID,
        incarnation: null,
        namespace: 'trust',
        recordID: 'current',
      }
      const authenticator = new Uint8Array(32).fill(91)
      const bytes = await sealRecord(f.codec, location, {
        ...f.seed.trust,
        installed: { ...f.seed.trust.installed, authenticator },
        spentEpochAuthenticators: [...f.seed.trust.spentEpochAuthenticators, authenticator],
      })
      memoryFaults(f.db).forceCommittedRow('trust', physicalRecordKey(location), bytes)
      await f.control.admit(f.seed.key, 'source')
      f.transactions.mockClear()
      await expect(
        f.entry.run(
          { groupID: f.seed.key.groupID, mutationID: 'identity-retry' },
          (_reads, closing) =>
            closing.freeze({
              source: f.seed.key,
              reason: 'terminal',
              prepared: { ...frozen, closing: undefined },
              domain: { states: [frozen.value.state], lifetime: null },
            }),
          async (stores, value) => {
            await stores.incarnation(1).state.save(value.state)
          },
        ),
        'retry retains original source identity',
      ).rejects.toThrow()
      expect(
        f.transactions.mock.calls,
        'changed identity refuses retry before transact',
      ).toHaveLength(0)
    })

    test('copied closing token cannot persist arbitrary data', async () => {
      for (const kind of ['copy', 'object', 'mutation', 'value', 'data', 'attempt'] as const) {
        const f = await fixture()
        let retained!: Prepared<{ state: GroupStateRecord }>
        let effects = 0
        const before = f.db.snapshot()
        await expect(
          f.entry.run(
            { groupID: f.seed.key.groupID, mutationID: 'authentic' },
            async (reads, closing) => {
              const prepared: Prepared<{ state: GroupStateRecord }> = await terminal(
                f,
                reads,
                closing,
              )
              retained = prepared
              if (kind === 'value' && !prepared.value.state.deleted)
                prepared.value.state = { ...prepared.value.state, senderHWM: 1000 }
              return kind === 'copy'
                ? { ...prepared, closing: { ...requireValue(prepared.closing) } }
                : kind === 'object'
                  ? { ...prepared }
                  : kind === 'mutation'
                    ? { ...prepared, mutationID: 'foreign' }
                    : prepared
            },
            async (stores, value) => {
              if (kind === 'attempt') throw new Error('force rollback')
              await stores
                .incarnation(1)
                .state.save(
                  kind === 'data' && !value.state.deleted
                    ? { ...value.state, senderHWM: 1000 }
                    : value.state,
                )
            },
            async () => {
              effects++
            },
          ),
        ).rejects.toThrow()
        expect(retained, 'closing token was actually issued').toBeDefined()
        expect(f.db.snapshot(), 'refused token leaves rows unchanged').toEqual(before)
        expect(effects).toBe(0)
        if (kind === 'attempt')
          await expect(
            f.entry.run(
              { groupID: f.seed.key.groupID, mutationID: 'authentic' },
              async () => retained,
              async (stores, value) => {
                await stores.incarnation(1).state.save(value.state)
              },
            ),
            'token is entry and attempt bound',
          ).rejects.toThrow()
      }
    })

    test('closing revalidates installed identity independently of the version', async () => {
      const f = await fixture()
      await f.control.admit(f.seed.key, 'source')
      const location = {
        groupID: f.seed.key.groupID,
        incarnation: null,
        namespace: 'trust',
        recordID: 'current',
      }
      const authenticator = new Uint8Array(32).fill(77)
      const bytes = await sealRecord(f.codec, location, {
        ...f.seed.trust,
        installed: { ...f.seed.trust.installed, authenticator },
        spentEpochAuthenticators: [...f.seed.trust.spentEpochAuthenticators, authenticator],
      })
      const transact = f.db.transact.bind(f.db)
      f.transactions.mockImplementationOnce((scope, work, options) => {
        memoryFaults(f.db).forceCommittedRow('trust', physicalRecordKey(location), bytes)
        return transact(scope, work, options)
      })
      const state = f.db.snapshot().state
      await expect(
        writeTerminal(f),
        'changed installed identity refuses frozen persistence',
      ).rejects.toThrow()
      expect(f.db.snapshot().state).toEqual(state)
    })

    test('frozen declarations require every domain write', async () => {
      const f = await fixture()
      await f.control.admit(f.seed.key, 'source')
      const before = f.db.snapshot()
      await expect(
        f.entry.run(
          { groupID: f.seed.key.groupID, mutationID: 'omitted-domain' },
          (reads, closing) => terminal(f, reads, closing),
          async () => {},
        ),
        'omitted frozen state refuses',
      ).rejects.toThrow()
      expect(f.db.snapshot()).toEqual(before)
    })

    test('alternate state writer commits the exact frozen terminal version', async () => {
      const f = await fixture()
      let frozen!: GroupStateRecord
      const result = f.entry.run(
        { groupID: f.seed.key.groupID, mutationID: 'alternate-terminal' },
        async (reads, closing) => {
          const prepared = await terminal(f, reads, closing)
          frozen = structuredClone(prepared.value.state)
          return prepared
        },
        async (stores, value) => {
          await createGroupStateStores({
            tx: stores.tx,
            groupID: f.seed.key.groupID,
            atRest: f.codec,
          })
            .state(1)
            .save(value.state)
        },
      )
      await expect(result, 'declared alternate writer commits').resolves.toBeUndefined()
      expect(frozen.version).toBe(2)
      expect(
        await f.persistence.groups.loadState(f.seed.key),
        'alternate writer must persist the exact frozen terminal record',
      ).toEqual(frozen)
    })

    test('alternate terminal writer refuses unclosed queued control work', async () => {
      const f = await fixture()
      await f.entry.run(
        { groupID: f.seed.key.groupID, mutationID: 'queued-control' },
        async (reads) => ({ expected: await reads.lifetime(), value: undefined }),
        async (stores) => {
          await stores.incarnation(1).control.apply(
            {
              putOperations: [
                {
                  id: 'queued-rotation',
                  kind: 'rotation',
                  revokes: false,
                  body: new Uint8Array(),
                  seq: 1,
                  enqueuedAt: 0,
                  deadline: 30_000,
                  stage: 'intent',
                },
              ],
            },
            'queued-control',
          )
        },
      )
      const before = f.db.snapshot()
      let effects = 0
      await expect(
        f.entry.run(
          { groupID: f.seed.key.groupID, mutationID: 'unclosed-terminal' },
          (reads, closing) => terminal(f, reads, closing),
          async (stores, value) => {
            stores.tx.onCommit(() => effects++)
            await createGroupStateStores({
              tx: stores.tx,
              groupID: f.seed.key.groupID,
              atRest: f.codec,
            })
              .state(1)
              .save(value.state)
          },
        ),
        'terminal persistence requires atomic closure of queued control work',
      ).rejects.toThrow('Source consumption requires atomic control closure')
      expect(f.db.snapshot(), 'refused alternate writer rolls back every row').toEqual(before)
      expect(effects).toBe(0)
    })

    test.each(['state', 'lifetime'] as const)(
      'closing validates the final persisted %s against the frozen domain',
      async (namespace) => {
        const f = await fixture()
        const before = f.db.snapshot()
        await expect(
          f.entry.run(
            { groupID: f.seed.key.groupID, mutationID: 'final-domain' },
            async (reads, closing) => {
              const record = await reads.state(1)
              const previous = await reads.lifetime()
              if (record === null || record.deleted || previous === null)
                throw new Error('Missing source')
              const state = { ...record, terminal: true, version: record.version + 1 }
              const lifetime = {
                ...previous,
                revision: previous.revision + 1,
                mutationID: 'final-domain',
              }
              return closing.freeze({
                source: f.seed.key,
                reason: 'terminal',
                prepared: { expected: previous, value: { state, lifetime } },
                domain: { states: [state], lifetime },
              })
            },
            async (stores, value) => {
              await stores.incarnation(1).state.save(value.state)
              await stores.lifetime.save(value.lifetime)
              const address = {
                groupID: f.seed.key.groupID,
                incarnation: namespace === 'state' ? 1 : null,
                namespace,
                recordID: 'current',
              }
              const changed =
                namespace === 'state'
                  ? { ...value.state, senderHWM: value.state.senderHWM + 1 }
                  : { ...value.lifetime, restorePending: true }
              stores.tx.rows[namespace]?.set(
                physicalRecordKey(address),
                await sealRecord(f.codec, address, changed),
              )
            },
          ),
          'final persisted domain cannot differ from its declaration',
        ).rejects.toThrow(`Persisted ${namespace} differs from frozen closing domain`)
        expect(f.db.snapshot(), 'final domain mismatch rolls back every row').toEqual(before)
      },
    )

    test('rollback retry retains the complete frozen persistence payload', async () => {
      const f = await fixture()
      await f.control.admit(f.seed.key, 'source')
      let frozen!: Prepared<{
        state: GroupStateRecord
        cursor: { topicID: string; position: string }
      }>
      const fault = memoryFaults(f.db).rejectCommitPending()
      const first = f.entry
        .run(
          { groupID: f.seed.key.groupID, mutationID: 'payload-retry' },
          async (reads, closing) => {
            const record = await reads.state(1)
            if (record === null || record.deleted) throw new Error('Missing source')
            const state = { ...record, terminal: true, version: record.version + 1 }
            frozen = await closing.freeze({
              source: f.seed.key,
              reason: 'terminal',
              prepared: {
                expected: await reads.lifetime(),
                value: { state, cursor: { topicID: 'saved-topic', position: '1' } },
              },
              domain: { states: [state], lifetime: null },
            })
            return frozen
          },
          async (stores, value) => {
            await stores.incarnation(1).state.save(value.state)
            await stores.incarnation(1).cursor.save(value.cursor.topicID, value.cursor.position)
          },
        )
        .catch((error: unknown) => error)
      await Promise.race([
        fault.rejected,
        first.then((error) => {
          throw error
        }),
      ])
      await fault.barrierWaiting
      await fault.finish('rollback')
      expect(await first).toMatchObject({ name: 'StorageOutcomeUnknownError' })
      await f.control.admit(f.seed.key, 'source')
      const retry = (position: string) =>
        f.entry.run(
          { groupID: f.seed.key.groupID, mutationID: 'payload-retry' },
          (_reads, closing) =>
            closing.freeze({
              source: f.seed.key,
              reason: 'terminal',
              prepared: {
                expected: frozen.expected,
                value: { state: frozen.value.state, cursor: { topicID: 'saved-topic', position } },
              },
              domain: { states: [frozen.value.state], lifetime: null },
            }),
          async (stores, value) => {
            await stores.incarnation(1).state.save(value.state)
            await stores.incarnation(1).cursor.save(value.cursor.topicID, value.cursor.position)
          },
        )
      f.transactions.mockClear()
      const before = f.db.snapshot()
      await expect(retry('2'), 'same mutation cannot replace its frozen cursor').rejects.toThrow()
      expect(f.transactions.mock.calls, 'changed payload refuses before transact').toHaveLength(0)
      expect(f.db.snapshot()).toEqual(before)
      await expect(retry('1'), 'unchanged payload retry succeeds').resolves.toBeUndefined()
      expect(await f.persistence.groups.loadState(f.seed.key)).toEqual(frozen.value.state)
      expect(
        await f.entry.read(f.seed.key.groupID, (reads) => reads.appCursor(1, 'saved-topic')),
      ).toBe('1')
    })

    test('closing declaration precedes transact and work', async () => {
      const f = await fixture()
      const binding = await f.control.admit(f.seed.key, 'source')
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const transact = f.db.transact.bind(f.db)
      let work = 0
      f.transactions.mockImplementationOnce(async (scope, callback, options) => {
        entered.resolve()
        await release.promise
        return transact(scope, callback, options)
      })
      const result = f.entry.run(
        { groupID: f.seed.key.groupID, mutationID: 'early-close' },
        (reads, closing) => terminal(f, reads, closing),
        async (stores, value) => {
          work++
          await stores.incarnation(1).state.save(value.state)
        },
      )
      await Promise.race([entered.promise, result])
      expect(work).toBe(0)
      expect(() => f.control.assertCurrent(binding), 'closure precedes backend entry').toThrow(
        DisplacedGroupHandleError,
      )
      release.resolve()
      await result
      expect(work).toBe(1)
    })

    test('closing preparation refuses missing and conflicting mutation IDs', async () => {
      for (const mode of ['missing', 'conflicting'] as const) {
        const f = await fixture()
        const sentinel = new Error('finish prepare')
        let rejected = false
        await expect(
          f.entry.run(
            { groupID: f.seed.key.groupID, mutationID: mode === 'missing' ? null : 'request-id' },
            async (reads, closing) => {
              const state = { ...f.seed.state, terminal: true, version: 2 }
              await closing
                .freeze({
                  source: f.seed.key,
                  reason: 'terminal',
                  prepared: {
                    expected: await reads.lifetime(),
                    value: { state },
                    ...(mode === 'conflicting' ? { mutationID: 'prepared-id' } : {}),
                  },
                  domain: { states: [state], lifetime: null },
                })
                .catch(() => {
                  rejected = true
                })
              throw sentinel
            },
            async () => {},
          ),
        ).rejects.toBe(sentinel)
        expect(rejected, 'invalid mutation IDs cannot issue a closing token').toBe(true)
      }
    })

    test('closing lifetime rejects values outside its frozen domain', async () => {
      const f = await fixture()
      const before = f.db.snapshot()
      await expect(
        f.entry.run(
          { groupID: f.seed.key.groupID, mutationID: 'frozen-life' },
          async (reads, closing) => {
            const previous = await reads.lifetime()
            if (previous === null) throw new Error('Missing lifetime')
            const lifetime = {
              ...previous,
              activeIncarnation: null,
              revision: previous.revision + 1,
              mutationID: 'frozen-life',
            }
            return closing.freeze({
              source: f.seed.key,
              reason: 'delete',
              prepared: { expected: previous, value: lifetime },
              domain: await retirementDomain(reads, lifetime),
            })
          },
          async (stores, value) => {
            await stores.lifetime.save({ ...value, restorePending: true })
          },
        ),
        'writer rejects changed frozen lifetime',
      ).rejects.toThrow()
      expect(f.db.snapshot()).toEqual(before)
    })

    test('undeclared lifetime displacement refuses at the writer', async () => {
      const f = await fixture()
      const previous = await f.persistence.groups.load(f.seed.key.groupID)
      if (previous === null) throw new Error('Missing lifetime')
      let refused = false
      await f.persistence.groups
        .transition(
          { groupID: previous.groupID, mutationID: 'undeclared-life', expected: previous },
          async (stores) => {
            try {
              await stores.lifetime.save({
                ...previous,
                activeIncarnation: null,
                revision: previous.revision + 1,
                mutationID: 'undeclared-life',
              })
            } catch {
              refused = true
            }
          },
        )
        .catch(() => {})
      expect(refused, 'undeclared displacement refuses before changing the lifetime').toBe(true)
    })

    test('alternate metadata writer refuses before changing admission facts', async () => {
      const f = await fixture()
      await f.control.admit(f.seed.key, 'source')
      let refused = false
      await f.persistence.groups
        .transition(
          {
            groupID: f.seed.key.groupID,
            mutationID: 'alternate-metadata',
            expected: await f.persistence.groups.load(f.seed.key.groupID),
          },
          async (stores) => {
            const metadata = createGroupStateStores({
              tx: stores.tx,
              groupID: f.seed.key.groupID,
              atRest: f.codec,
            }).stateMetadata(1)
            const previous = await metadata.load()
            if (previous === null) throw new Error('Missing metadata')
            try {
              await metadata.save({ ...previous, terminal: true, version: previous.version + 1 })
            } catch {
              refused = true
            }
          },
        )
        .catch(() => {})
      expect(refused, 'metadata cannot invent terminal closure').toBe(true)
    })

    test('direct persistence cannot commit undeclared closure', async () => {
      for (const kind of ['terminal', 'delete', 'displacement', 'alternate'] as const) {
        const f = await fixture()
        await f.control.admit(f.seed.key, 'source')
        const before = f.db.snapshot()
        let effects = 0
        const lifetime = await f.persistence.groups.load(f.seed.key.groupID)
        await expect(
          f.persistence.groups.transition(
            {
              groupID: f.seed.key.groupID,
              mutationID: 'undeclared',
              expected: lifetime,
            },
            async (stores) => {
              stores.tx.onCommit(() => {
                effects++
              })
              if (kind === 'displacement') {
                if (lifetime === null) throw new Error('Missing lifetime')
                await stores.lifetime.save({
                  ...lifetime,
                  activeIncarnation: null,
                  revision: lifetime.revision + 1,
                  mutationID: 'undeclared',
                })
              } else {
                const state =
                  kind === 'alternate'
                    ? createGroupStateStores({
                        tx: stores.tx,
                        groupID: f.seed.key.groupID,
                        atRest: f.codec,
                      }).state(1)
                    : stores.incarnation(1).state
                await state.save(
                  kind === 'delete'
                    ? { ...f.seed.key, version: 2, deleted: true }
                    : { ...f.seed.state, terminal: true, version: 2 },
                )
              }
            },
          ),
          'undeclared closing write refuses',
        ).rejects.toThrow()
        expect(f.db.snapshot(), 'no domain mutation or hook delta').toEqual(before)
        expect(effects).toBe(0)
        await expect(f.save('progress')).resolves.toBeUndefined()
      }
    })
  })
}
