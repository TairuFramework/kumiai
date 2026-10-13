import { describe, expect, test } from 'vitest'

import {
  assertCorruptStorageRecovery,
  assertLowerEpochRefused,
  assertPartialLossSpentRefused,
  storageChange,
  storageSeed,
  writeStorageInstall,
} from './group-storage.js'
import type {
  ConformanceAccountedGroupObservation,
  ConformanceEntryCapability,
  ConformanceEntryReads,
  ConformanceGroupLifetime,
  ConformanceGroupStores,
  ConformanceGroupTransaction,
  ConformanceOwnershipContextPort,
  ConformancePersistenceFixture,
  ConformanceStorageAppOutboxEntry,
  StorageConformanceParams,
  StorageTestPorts,
} from './persistence-fixture.js'

function localDeferred<TValue>(): { promise: Promise<TValue>; resolve(value: TValue): void } {
  let resolve!: (value: TValue) => void
  const promise = new Promise<TValue>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const groupID = 'group-A'
const key = { groupID, incarnation: 1 }
const utf8 = (value: string) => new TextEncoder().encode(value)
const entry: ConformanceStorageAppOutboxEntry = {
  seq: 7,
  protocol: 'chat',
  prc: 'posted',
  data: utf8('plaintext-sentinel'),
  status: 'accepted',
  lastAttempt: null,
}
const event = { ...key, id: 'ownership-event', kind: 'accepted' as const, entry }
const anchor = { anchor: { epoch: 3, secret: new Uint8Array(32).fill(97) } }

// Apply the same bound to callbacks, queued roots, proof signals and fixture cleanup.
async function within<TValue>(promise: Promise<TValue>): Promise<TValue> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), 2000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function observed<TValue>(promise: Promise<TValue>) {
  let settled = false
  const result = promise.then(
    (value) => {
      settled = true
      return { ok: true as const, value }
    },
    (error: unknown) => {
      settled = true
      return { ok: false as const, error }
    },
  )
  return { result, settled: () => settled }
}

async function turn(): Promise<void> {
  await within(new Promise<void>((resolve) => setTimeout(resolve, 0)))
}

function hooks(tx: ConformanceGroupTransaction, calls: Array<string>): void {
  tx.onCommit(() => {
    calls.push('commit')
  })
  tx.onRollback(() => {
    calls.push('rollback')
  })
}

function runOwnershipPhasesConformance<TTx extends ConformanceGroupTransaction>(
  params: OwnershipPhasesConformanceParams<TTx>,
): void {
  type Fixture = ConformancePersistenceFixture<StorageTestPorts<TTx>>
  describe(`Ownership phases conformance -- ${params.label}`, () => {
    testCommitObservation(params)
    testPreparedOwnership(params)
    testOperationOwnership(params)
    describe('phase capabilities', () => {
      for (const access of ['supplied', 'constructed'] as const) {
        test.each(['state', 'trust', 'lifetime'] as const)(
          `${access} %s write in effects refuses without changing domain rows`,
          async (domain) => {
            let supplied!: ConformanceGroupStores<TTx>
            let fixture!: Fixture
            const refusals: Array<unknown> = []
            fixture = await within(
              params.createFixture(groupID, {
                effects: {
                  async outbox(tx) {
                    const stores =
                      access === 'supplied' ? supplied : fixture.constructGroupStores(tx, key)
                    const operation =
                      domain === 'state'
                        ? stores.incarnation(1).state.save({
                            ...seed.state,
                            version: seed.state.version + 2,
                            senderHWM: 64,
                          })
                        : domain === 'trust'
                          ? stores.trust.save({
                              ...seed.trust,
                              ledger: [...seed.trust.ledger, ...seed.trust.ledger],
                            })
                          : stores.lifetime.save({
                              ...seed.lifetime,
                              revision: seed.lifetime.revision + 1,
                              mutationID: 'phase',
                              restorePending: true,
                            })
                    const refusal = await within(observed(operation).result)
                    refusals.push(refusal)
                    await within(params.writeSideRow(tx, 'phase-effect', utf8('effect')))
                  },
                },
              }),
            )
            const groups = fixture.ports.device.groups
            const seed = await within(storageSeed(groups))
            try {
              await within(
                groups.transition(
                  await within(storageChange(groups, groupID, 'phase')),
                  async (stores) => {
                    supplied = stores
                    await within(
                      stores.incarnation(1).state.save({
                        ...seed.state,
                        version: seed.state.version + 1,
                        senderHWM: 32,
                      }),
                    )
                    await within(stores.trust.save(seed.trust))
                    await within(
                      stores.lifetime.save({
                        ...seed.lifetime,
                        revision: seed.lifetime.revision + 1,
                        mutationID: 'phase',
                      }),
                    )
                    await within(stores.incarnation(1).meta.putEvents([event]))
                  },
                ),
              )
              // Check the committed rows even while the error-name assertion is still red.
              expect(await within(groups.loadState(key))).toEqual({
                ...seed.state,
                version: seed.state.version + 1,
                senderHWM: 32,
              })
              expect(await within(groups.loadTrust(groupID))).toEqual(seed.trust)
              expect(await within(groups.load(groupID))).toEqual({
                ...seed.lifetime,
                revision: seed.lifetime.revision + 1,
                mutationID: 'phase',
              })
              expect(await within(fixture.inspectSideRow('phase-effect'))).toEqual(utf8('effect'))
              expect(refusals).toEqual([
                { ok: false, error: expect.objectContaining({ name: 'PersistencePhaseError' }) },
              ])
            } finally {
              await within(fixture.close())
            }
          },
        )
      }
      test('effect side row commits with the transition', async () => {
        const fixture = await within(
          params.createFixture(groupID, {
            effects: {
              outbox: (tx) => within(params.writeSideRow(tx, 'effect', utf8('effect'))),
            },
          }),
        )
        try {
          const groups = fixture.ports.device.groups
          await within(
            groups.transition(
              await within(storageChange(groups, groupID, 'side-effect')),
              async (stores) => {
                await within(stores.incarnation(1).meta.putEvents([event]))
              },
            ),
          )
          expect(await within(fixture.inspectSideRow('effect'))).toEqual(utf8('effect'))
          expect((await within(groups.load(groupID)))?.mutationID).toBe('side-effect')
        } finally {
          await within(fixture.close())
        }
      })
    })

    describe('sequencing', () => {
      test('suspended outbox write, control write and finalisation complete in order', async () => {
        const fixture = await within(params.createFixture(groupID))
        // This case updates an uncertified entry, rather than violating a settlement obligation.
        await within(
          fixture.deleteCommittedRow(
            'meta',
            JSON.stringify([groupID, 1, JSON.stringify(['settlement', 7])]),
          ),
        )
        const latch = fixture.holdNextSeal()
        try {
          const groups = fixture.ports.device.groups
          const seed = await within(storageSeed(groups))
          const change = await within(storageChange(groups, groupID, 'sequence'))
          const changedEntry = {
            ...entry,
            lastAttempt: {
              incarnation: 1,
              epoch: 3,
              floor: '2',
              attempts: 1,
              publishID: 'publish-1',
              segment: 3,
              topicID: 'topic-secret',
            },
          }
          const outcome = {
            id: 'sequence-outcome',
            opID: 'operation-1',
            at: 1000,
            kind: 'unknown' as const,
          }
          const operations: Array<Promise<unknown>> = []
          const writer = observed(
            groups.transition(change, async (stores) => {
              operations.push(observed(stores.incarnation(1).outbox.put([changedEntry])).result)
              await within(latch.reached)
              operations.push(
                observed(
                  stores.incarnation(1).control.apply({ putOutcomes: [outcome] }, 'sequence'),
                ).result,
              )
              // Abandoned promises still belong to the entry sequencer.
            }),
          )
          await within(latch.reached)
          await turn()
          expect(writer.settled()).toBe(false)
          latch.release()
          expect(await within(writer.result)).toMatchObject({ ok: true })
          for (const operation of operations)
            expect(await within(operation)).toMatchObject({ ok: true })
          expect(await within(groups.ports(key).outbox.list())).toContainEqual(changedEntry)
          expect((await within(groups.ports(key).control.load())).outcomes).toContainEqual(outcome)
          expect((await within(groups.load(groupID)))?.revision).toBe(seed.lifetime.revision + 1)
        } finally {
          latch.release()
          await within(fixture.close())
        }
      })

      test('effect side writes are accounted like work side writes', async () => {
        const workFixture = await within(params.createFixture(groupID))
        const donor = await within(params.createFixture(groupID))
        let effectStores!: ConformanceGroupStores<TTx>
        const effectFixture = await within(
          params.createFixture(groupID, {
            effects: {
              async outbox() {
                await within(effectStores.incarnation(2).anchor.save(anchor))
              },
            },
          }),
        )
        try {
          const fresh = await within(storageSeed(donor.ports.device.groups))
          for (const [fixture, inEffect] of [
            [workFixture, false],
            [effectFixture, true],
          ] as const) {
            const groups = fixture.ports.device.groups
            await within(
              groups.transition(
                await within(storageChange(groups, groupID, 'install-fresh')),
                async (stores) => {
                  await within(writeStorageInstall(stores, fresh, 'install-fresh', 2))
                },
              ),
            )
            const installed = await within(groups.loadState({ ...key, incarnation: 2 }))
            if (installed === null) throw new Error('Missing installed state')
            await within(
              groups.transition(
                await within(storageChange(groups, groupID, 'account')),
                async (stores) => {
                  if (inEffect) effectStores = stores
                  else await within(stores.incarnation(2).anchor.save(anchor))
                  // Trigger the effect on retired incarnation one, keeping two's accounting independent.
                  await within(stores.incarnation(1).meta.putEvents([event]))
                },
              ),
            )
            expect(await within(groups.ports({ ...key, incarnation: 2 }).anchor.load())).toEqual(
              anchor,
            )
            expect((await within(groups.loadState({ ...key, incarnation: 2 })))?.version).toBe(
              installed.version + 1,
            )
          }
          expect(
            (await within(effectFixture.ports.device.groups.loadState({ ...key, incarnation: 2 })))
              ?.version,
          ).toBe(
            (await within(workFixture.ports.device.groups.loadState({ ...key, incarnation: 2 })))
              ?.version,
          )
        } finally {
          await within(workFixture.close())
          await within(effectFixture.close())
          await within(donor.close())
        }
      })
    })

    describe('effect store calls/exceptions', () => {
      test('outbox effect can load supplied lifetime', async () => {
        let supplied!: ConformanceGroupStores<TTx>
        let effectCalls = 0
        let loaded: ConformanceGroupLifetime | null | undefined
        const fixture = await within(
          params.createFixture(groupID, {
            effects: {
              async outbox() {
                effectCalls++
                loaded = await within(supplied.lifetime.load())
              },
            },
          }),
        )
        try {
          const groups = fixture.ports.device.groups
          const before = await within(groups.load(groupID))
          if (before === null) throw new Error('Missing installed lifetime')
          await within(
            groups.transition(
              await within(storageChange(groups, groupID, 'effect-load')),
              async (stores) => {
                supplied = stores
                await within(stores.incarnation(1).meta.putEvents([event]))
              },
            ),
          )
          expect(effectCalls).toBe(1)
          expect(loaded).toEqual({
            ...before,
            revision: before.revision + 1,
            mutationID: 'effect-load',
          })
        } finally {
          await within(fixture.close())
        }
      })
      test('delete effect can clear transaction-bound transport', async () => {
        let supplied!: ConformanceGroupStores<TTx>
        const fixture = await within(
          params.createFixture(groupID, {
            effects: {
              async delete(_tx, deletedKey) {
                await within(supplied.incarnation(deletedKey.incarnation).clearTransport())
              },
            },
          }),
        )
        try {
          // Transport clearing requires settled obligations.
          await within(
            fixture.deleteCommittedRow(
              'meta',
              JSON.stringify([groupID, 1, JSON.stringify(['settlement', 7])]),
            ),
          )
          const groups = fixture.ports.device.groups
          const seed = await within(storageSeed(groups))
          await within(
            groups.transition(
              await within(storageChange(groups, groupID, 'delete-effect')),
              async (stores) => {
                supplied = stores
                await within(
                  stores.lifetime.save({
                    ...seed.lifetime,
                    revision: seed.lifetime.revision + 1,
                    mutationID: 'delete-effect',
                    activeIncarnation: null,
                  }),
                )
              },
            ),
          )
          expect(await within(groups.loadState(key))).toMatchObject({ deleted: true })
          expect(await within(groups.ports(key).outbox.list())).toEqual([])
        } finally {
          await within(fixture.close())
        }
      })
      test('throwing effect rolls back transition and side row', async () => {
        const fixture = await within(
          params.createFixture(groupID, {
            effects: {
              async outbox(tx) {
                await within(params.writeSideRow(tx, 'throw-effect', utf8('effect')))
                throw new Error('effect failure')
              },
            },
          }),
        )
        try {
          const groups = fixture.ports.device.groups
          const before = await within(fixture.inspectRows())
          await within(
            expect(
              groups.transition(
                await within(storageChange(groups, groupID, 'throw-effect')),
                async (stores) => {
                  await within(stores.incarnation(1).anchor.save(anchor))
                  await within(stores.incarnation(1).meta.putEvents([event]))
                },
              ),
            ).rejects.toThrow('effect failure'),
          )
          expect(await within(fixture.inspectRows())).toEqual(before)
          expect(await within(fixture.inspectSideRow('throw-effect'))).toBeNull()
        } finally {
          await within(fixture.close())
        }
      })
      test.each(['commit', 'rollback'] as const)(
        'throwing %s hook is contained and later hook runs',
        async (outcome) => {
          const fixture = await within(params.createFixture(groupID))
          try {
            const groups = fixture.ports.device.groups
            const before = await within(fixture.inspectRows())
            const calls: Array<string> = []
            const writer = groups.transition(
              await within(storageChange(groups, groupID, 'throw-hook')),
              async (stores) => {
                const register = outcome === 'commit' ? stores.tx.onCommit : stores.tx.onRollback
                register(() => {
                  calls.push('first')
                  throw new Error('hook failure')
                })
                register(() => {
                  calls.push('second')
                })
                await within(params.writeSideRow(stores.tx, 'hook-row', utf8('effect')))
                if (outcome === 'rollback') throw new Error('work failure')
                return 'saved-result'
              },
            )
            if (outcome === 'commit') {
              expect(await within(writer)).toBe('saved-result')
              expect(await within(fixture.inspectSideRow('hook-row'))).toEqual(utf8('effect'))
              expect((await within(groups.load(groupID)))?.mutationID).toBe('throw-hook')
            } else {
              await within(expect(writer).rejects.toThrow('work failure'))
              expect(await within(fixture.inspectRows())).toEqual(before)
            }
            expect(calls).toEqual(['first', 'second'])
          } finally {
            await within(fixture.close())
          }
        },
      )
    })

    describe('ambiguous transition fence', () => {
      test('commit then reject settles one hook queue before queued readers and writer', async () => {
        const fixture = await within(params.createFixture(groupID))
        try {
          const { device } = fixture.ports
          const groups = device.groups
          const seed = await within(storageSeed(groups))
          const beforeDevice = await within(device.load())
          const outcome = {
            id: 'queued-control',
            opID: 'queued-control',
            at: 1000,
            kind: 'unknown' as const,
          }
          const change = await within(storageChange(groups, groupID, 'committed-unknown'))
          const order: Array<string> = []
          const calls: Array<string> = []
          const started = localDeferred<void>()
          fixture.commitThenReject()
          const writer = observed(
            device
              .transition(
                {
                  mutationID: change.mutationID,
                  expectedRevision: beforeDevice.revision,
                  group: change,
                },
                async (deviceStores) => {
                  const stores = deviceStores.group
                  if (stores === null) throw new Error('Missing combined group participant')
                  hooks(stores.tx, calls)
                  stores.tx.onCommit(() => {
                    order.push('hook')
                  })
                  await within(
                    stores.incarnation(1).state.save({
                      ...seed.state,
                      version: seed.state.version + 1,
                      senderHWM: 32,
                    }),
                  )
                  await within(
                    stores
                      .incarnation(1)
                      .control.apply({ putOutcomes: [outcome] }, change.mutationID),
                  )
                  started.resolve()
                },
              )
              .then((value) => {
                expect(calls).toEqual(['commit'])
                order.push('caller')
                return value
              }),
          )
          await within(started.promise)
          expect(calls).toEqual([])
          const observeRead = <TValue>(read: Promise<TValue>) =>
            observed(
              read.then((value) => {
                expect(calls).toEqual(['commit'])
                order.push('read')
                return value
              }),
            )
          const reads = {
            state: observeRead(groups.loadState(key)),
            lifetime: observeRead(groups.load(groupID)),
            control: observeRead(groups.ports(key).control.load()),
            device: observeRead(device.load()),
          }
          const next = observed(
            groups.transition(
              {
                ...change,
                mutationID: 'next',
                expected: { revision: seed.lifetime.revision + 1, activeIncarnation: 1 },
              },
              async () => 'next',
            ),
          )
          expect(await within(writer.result)).toMatchObject({ ok: true })
          expect(await within(reads.state.result)).toEqual({
            ok: true,
            value: { ...seed.state, version: seed.state.version + 1, senderHWM: 32 },
          })
          expect(await within(reads.lifetime.result)).toEqual({
            ok: true,
            value: {
              ...seed.lifetime,
              revision: seed.lifetime.revision + 1,
              mutationID: change.mutationID,
            },
          })
          expect(await within(reads.control.result)).toMatchObject({
            ok: true,
            value: { outcomes: expect.arrayContaining([outcome]) },
          })
          expect(await within(reads.device.result)).toEqual({
            ok: true,
            value: {
              ...beforeDevice,
              revision: beforeDevice.revision + 1,
              mutationID: change.mutationID,
            },
          })
          expect(await within(next.result)).toEqual({ ok: true, value: 'next' })
          expect(order[0]).toBe('hook')
          expect(calls).toEqual(['commit'])
          expect(await within(groups.loadState(key))).toMatchObject({ senderHWM: 32 })
        } finally {
          await within(fixture.close())
        }
      })

      test('unfinished transition fences every read and same-group writer while group B commits', async () => {
        const fixture = await within(params.createFixture(groupID))
        let finished = false
        const { device } = fixture.ports
        const groups = device.groups
        const seed = await within(storageSeed(groups))
        const beforeDevice = await within(device.load())
        const outcome = {
          id: 'queued-control',
          opID: 'queued-control',
          at: 1000,
          kind: 'unknown' as const,
        }
        const change = await within(storageChange(groups, groupID, 'pending'))
        const otherChange = await within(storageChange(groups, 'group-B', 'independent'))
        const fault = fixture.rejectCommitPending()
        try {
          const calls: Array<string> = []
          const writer = observed(
            device.transition(
              {
                mutationID: change.mutationID,
                expectedRevision: beforeDevice.revision,
                group: change,
              },
              async (deviceStores) => {
                const stores = deviceStores.group
                if (stores === null) throw new Error('Missing combined group participant')
                hooks(stores.tx, calls)
                await within(
                  stores
                    .incarnation(1)
                    .state.save({ ...seed.state, version: seed.state.version + 1, senderHWM: 32 }),
                )
                await within(
                  stores
                    .incarnation(1)
                    .control.apply({ putOutcomes: [outcome] }, change.mutationID),
                )
              },
            ),
          )
          await within(fault.rejected)
          await within(fault.barrierWaiting)
          const reads = {
            state: observed(groups.loadState(key)),
            lifetime: observed(groups.load(groupID)),
            control: observed(groups.ports(key).control.load()),
            device: observed(device.load()),
          }
          const next = observed(
            groups.transition(
              {
                ...change,
                mutationID: 'next',
                expected: { revision: seed.lifetime.revision + 1, activeIncarnation: 1 },
              },
              async () => 'next',
            ),
          )
          await within(
            groups.transition(otherChange, async (stores) => {
              await within(stores.incarnation(1).anchor.save(anchor))
            }),
          )
          await turn()
          const early = Object.values(reads).map((read) => read.settled())
          expect(calls).toEqual([])
          expect(writer.settled()).toBe(false)
          expect(next.settled()).toBe(false)
          await within(fault.finish('commit'))
          finished = true
          expect(await within(writer.result)).toMatchObject({ ok: true })
          expect(await within(reads.state.result)).toEqual({
            ok: true,
            value: { ...seed.state, version: seed.state.version + 1, senderHWM: 32 },
          })
          expect(await within(reads.lifetime.result)).toEqual({
            ok: true,
            value: {
              ...seed.lifetime,
              revision: seed.lifetime.revision + 1,
              mutationID: change.mutationID,
            },
          })
          expect(await within(reads.control.result)).toMatchObject({
            ok: true,
            value: { outcomes: expect.arrayContaining([outcome]) },
          })
          expect(await within(reads.device.result)).toEqual({
            ok: true,
            value: {
              ...beforeDevice,
              revision: beforeDevice.revision + 1,
              mutationID: change.mutationID,
            },
          })
          expect(await within(next.result)).toEqual({ ok: true, value: 'next' })
          expect(calls).toEqual(['commit'])
          expect(await within(groups.loadState(key))).toMatchObject({ senderHWM: 32 })
          expect((await within(groups.load('group-B')))?.mutationID).toBe('independent')
          expect(early).toEqual([false, false, false, false])
        } finally {
          if (!finished) await within(fault.finish('rollback'))
          await within(fixture.close())
        }
      })
    })

    describe('ambiguous read releases', () => {
      test.each(['commit-then-reject', 'unfinished'] as const)(
        '%s root read rejects and releases ownership',
        async (kind) => {
          const fixture = await within(params.createFixture(groupID))
          let finished = false
          const groups = fixture.ports.device.groups
          const change = await within(storageChange(groups, groupID, 'after-read'))
          const fault = kind === 'unfinished' ? fixture.rejectCommitPending() : undefined
          if (fault === undefined) fixture.commitThenReject()
          try {
            await within(
              expect(groups.loadState(key)).rejects.toMatchObject({
                name: 'StorageOutcomeUnknownError',
              }),
            )
            const nextRead = observed(groups.loadState(key))
            const nextWrite = observed(groups.transition(change, async () => 'after-read'))
            if (fault !== undefined) {
              await within(fault.rejected)
              await within(fault.finish('commit'))
              finished = true
            }
            expect(await within(nextRead.result)).toMatchObject({
              ok: true,
              value: { deleted: false },
            })
            expect(await within(nextWrite.result)).toEqual({ ok: true, value: 'after-read' })
          } finally {
            if (fault !== undefined && !finished) await within(fault.finish('rollback'))
            await within(fixture.close())
          }
        },
      )
    })

    describe('proof classification/join', () => {
      for (const scope of ['group', 'device'] as const) {
        test.each(['commit', 'rollback'] as const)(
          `${scope} proof %s joins and settles exactly once`,
          async (outcome) => {
            const fixture = await within(params.createFixture(groupID))
            const { device } = fixture.ports
            const change = await within(storageChange(device.groups, groupID, 'joined-proof'))
            const beforeDevice = await within(device.load())
            const calls: Array<string> = []
            const fault = fixture.rejectCommitPending()
            let finished = false
            try {
              const writer = observed(
                scope === 'group'
                  ? device.groups.transition(change, async (stores) => {
                      hooks(stores.tx, calls)
                      return 'saved'
                    })
                  : device.transition(
                      {
                        mutationID: 'joined-proof',
                        expectedRevision: beforeDevice.revision,
                        group: null,
                      },
                      async (stores) => {
                        hooks(stores.tx, calls)
                        return 'saved'
                      },
                    ),
              )
              await within(fault.rejected)
              await within(fault.barrierWaiting)
              const resolve = () =>
                scope === 'group'
                  ? device.groups.resolve(groupID, 'joined-proof')
                  : device.resolve('joined-proof')
              const joined = [observed(resolve()), observed(resolve()), observed(resolve())]
              await turn()
              expect(calls).toEqual([])
              for (const resolver of joined) expect(resolver.settled()).toBe(false)
              await within(fault.finish(outcome))
              finished = true
              expect(await within(writer.result)).toEqual(
                outcome === 'commit'
                  ? { ok: true, value: 'saved' }
                  : {
                      ok: false,
                      error: expect.objectContaining({ name: 'StorageOutcomeUnknownError' }),
                    },
              )
              const classified = outcome === 'commit' ? 'committed' : 'rolled-back'
              for (const resolver of joined)
                expect(await within(resolver.result)).toEqual({ ok: true, value: classified })
              expect(calls).toEqual([outcome])
              if (outcome === 'rollback')
                await within(
                  expect(resolve()).rejects.toMatchObject({ name: 'GroupStateUncertainError' }),
                )
              else expect(await within(resolve())).toBe('committed')
              expect(calls).toEqual([outcome])
            } finally {
              if (!finished) await within(fault.finish('rollback'))
              await within(fixture.close())
            }
          },
        )
      }
      test('fallback resolution of superseded mutation is uncertain', async () => {
        const fixture = await within(params.createFixture(groupID))
        try {
          const groups = fixture.ports.device.groups
          for (const mutationID of ['M', 'N'])
            await within(
              groups.transition(
                await within(storageChange(groups, groupID, mutationID)),
                async () => {},
              ),
            )
          const reopened = await within(fixture.reopen())
          await within(
            expect(reopened.device.groups.resolve(groupID, 'M')).rejects.toMatchObject({
              name: 'GroupStateUncertainError',
            }),
          )
        } finally {
          await within(fixture.close())
        }
      })
      test('conflict drops hooks and fail-stops later entries on every scope', async () => {
        const fixture = await within(params.createFixture(groupID))
        const { device } = fixture.ports
        const groups = device.groups
        const change = await within(storageChange(groups, groupID, 'conflict'))
        const otherChange = await within(storageChange(groups, 'group-B', 'after-conflict'))
        const fault = fixture.rejectCommitPending()
        let finished = false
        try {
          const calls: Array<string> = []
          const writer = observed(
            groups.transition(change, async (stores) => {
              hooks(stores.tx, calls)
            }),
          )
          await within(fault.rejected)
          await within(fault.barrierWaiting)
          const joined = observed(groups.resolve(groupID, 'conflict'))
          await within(
            fixture.forceOwnerMarker({ groupID }, { mutationID: 'intruder', revision: 99 }),
          )
          await within(fault.finish('rollback'))
          finished = true
          const results: Array<unknown> = [await within(writer.result), await within(joined.result)]
          const later = [
            groups.load(groupID),
            groups.transition(otherChange, async () => 'illegal'),
            device.load(),
          ].map((operation) => observed<unknown>(operation))
          for (const operation of later) results.push(await within(operation.result))
          expect(calls).toEqual([])
          for (const result of results)
            expect(result).toMatchObject({ ok: false, error: { name: 'GroupStateConflictError' } })
        } finally {
          if (!finished) await within(fault.finish('rollback'))
          await within(fixture.close())
        }
      })
      test('conflict also rejects another already ambiguous group and its joined resolver', async () => {
        const fixture = await within(params.createFixture(groupID))
        const groups = fixture.ports.device.groups
        const changeA = await within(storageChange(groups, groupID, 'conflict-A'))
        const changeB = await within(storageChange(groups, 'group-B', 'pending-B'))
        const faultA = fixture.rejectCommitPending()
        const calls: Array<string> = []
        const writerA = observed(
          groups.transition(changeA, async (stores) => {
            hooks(stores.tx, calls)
          }),
        )
        await within(faultA.rejected)
        await within(faultA.barrierWaiting)
        const faultB = fixture.rejectCommitPending()
        let finishedA = false
        let finishedB = false
        try {
          const writerB = observed(
            groups.transition(changeB, async (stores) => {
              hooks(stores.tx, calls)
            }),
          )
          await within(faultB.rejected)
          await within(faultB.barrierWaiting)
          const joinedB = observed(groups.resolve('group-B', 'pending-B'))
          await within(
            fixture.forceOwnerMarker({ groupID }, { mutationID: 'intruder', revision: 99 }),
          )
          await within(faultA.finish('rollback'))
          finishedA = true
          expect(await within(writerA.result)).toMatchObject({
            ok: false,
            error: { name: 'GroupStateConflictError' },
          })
          // Backend disposal may be needed before the already-open transaction can finish.
          await within(faultB.finish('rollback'))
          finishedB = true
          const resultB = await within(writerB.result)
          const resolvedB = await within(joinedB.result)
          expect(calls).toEqual([])
          expect(resultB).toMatchObject({ ok: false, error: { name: 'GroupStateConflictError' } })
          expect(resolvedB).toMatchObject({ ok: false, error: { name: 'GroupStateConflictError' } })
        } finally {
          if (!finishedA) await within(faultA.finish('rollback'))
          if (!finishedB) await within(faultB.finish('rollback'))
          await within(fixture.close())
        }
      })
      test.each(['normal', 'device-conflict'] as const)(
        'combined classification: %s',
        async (kind) => {
          const fixture = await within(params.createFixture(groupID))
          const { device } = fixture.ports
          const change = await within(storageChange(device.groups, groupID, 'combined'))
          const before = await within(device.load())
          const otherChange = await within(
            storageChange(device.groups, 'group-B', 'after-combined-conflict'),
          )
          const calls: Array<string> = []
          const fault = fixture.rejectCommitPending()
          let finished = false
          try {
            const writer = observed(
              device.transition(
                { mutationID: 'combined', expectedRevision: before.revision, group: change },
                async (stores) => {
                  hooks(stores.tx, calls)
                  if (stores.group === null) throw new Error('Missing group participant')
                  await within(stores.group.incarnation(1).anchor.save(anchor))
                  await within(params.writeSideRow(stores.tx, 'combined-side', utf8('effect')))
                  return 'combined-result'
                },
              ),
            )
            await within(fault.rejected)
            await within(fault.barrierWaiting)
            const joined = observed(device.resolve('combined'))
            expect(calls).toEqual([])
            if (kind === 'device-conflict')
              await within(
                fixture.forceOwnerMarker(
                  { ownerDID: device.ownerDID },
                  { mutationID: 'intruder', revision: 99 },
                ),
              )
            await within(fault.finish(kind === 'normal' ? 'commit' : 'rollback'))
            finished = true
            const result = await within(writer.result)
            const resolution = await within(joined.result)
            if (kind === 'normal') {
              expect(result).toEqual({ ok: true, value: 'combined-result' })
              expect(resolution).toEqual({ ok: true, value: 'committed' })
              expect(calls).toEqual(['commit'])
              expect(await within(device.load())).toMatchObject({
                revision: before.revision + 1,
                mutationID: 'combined',
              })
              expect(await within(device.groups.load(groupID))).toMatchObject({
                revision: (change.expected?.revision ?? 0) + 1,
                mutationID: 'combined',
              })
              expect(await within(fixture.inspectSideRow('combined-side'))).toEqual(utf8('effect'))
            } else {
              expect(result).toMatchObject({
                ok: false,
                error: { name: 'GroupStateConflictError' },
              })
              expect(resolution).toMatchObject({
                ok: false,
                error: { name: 'GroupStateConflictError' },
              })
              expect(calls).toEqual([])
              await within(
                expect(device.groups.transition(otherChange, async () => {})).rejects.toMatchObject(
                  { name: 'GroupStateConflictError' },
                ),
              )
            }
          } finally {
            if (!finished) await within(fault.finish('rollback'))
            await within(fixture.close())
          }
        },
      )
    })

    describe('ordering/reentrancy/deletion', () => {
      for (const phase of ['work', 'effects', 'hook'] as const) {
        test.each(['group-read', 'group-transition', 'device-read', 'device-transition'] as const)(
          `${phase} root %s refuses promptly`,
          async (operation) => {
            let nested: ReturnType<typeof observed<unknown>> | undefined
            let invoke!: () => Promise<unknown>
            const fixture = await within(
              params.createFixture(groupID, {
                effects: {
                  async outbox() {
                    if (phase === 'effects') {
                      nested = observed(invoke())
                      await within(nested.result)
                    }
                  },
                },
              }),
            )
            try {
              const { device } = fixture.ports
              const change = await within(storageChange(device.groups, groupID, 'reentrant'))
              const revision = (await within(device.load())).revision
              invoke = () =>
                operation === 'group-read'
                  ? device.groups.loadState(key)
                  : operation === 'group-transition'
                    ? device.groups.transition({ ...change, mutationID: 'nested' }, async () => {})
                    : operation === 'device-read'
                      ? device.load()
                      : device.transition(
                          { mutationID: 'nested', expectedRevision: revision, group: null },
                          async () => {},
                        )
              await within(
                device.groups.transition(change, async (stores) => {
                  if (phase === 'work') {
                    nested = observed(invoke())
                    await within(nested.result)
                  }
                  if (phase === 'hook')
                    stores.tx.onCommit(() => {
                      nested = observed(invoke())
                    })
                  await within(stores.incarnation(1).meta.putEvents([event]))
                }),
              )
              if (nested === undefined) throw new Error('Missing nested root call')
              expect(await within(nested.result)).toMatchObject({
                ok: false,
                error: { name: 'ReentrantOwnershipError' },
              })
            } finally {
              await within(fixture.close())
            }
          },
        )
      }
    })

    describe('restart before proof', () => {
      test('reopened first read sees committed rows only after backend completion', async () => {
        const fixture = await within(params.createFixture(groupID))
        const groups = fixture.ports.device.groups
        const seed = await within(storageSeed(groups))
        const change = await within(storageChange(groups, groupID, 'restart'))
        const fault = fixture.rejectCommitPending()
        let finished = false
        try {
          const writer = observed(
            groups.transition(change, async (stores) => {
              await within(
                stores
                  .incarnation(1)
                  .state.save({ ...seed.state, version: seed.state.version + 1, senderHWM: 32 }),
              )
            }),
          )
          await within(fault.rejected)
          await within(fault.barrierWaiting)
          const reopened = await within(fixture.reopenWithoutBarrier())
          expect(writer.settled()).toBe(false)
          const firstRead = observed(reopened.device.groups.loadState(key))
          await turn()
          expect(firstRead.settled()).toBe(false)
          await within(fault.finish('commit'))
          finished = true
          expect(await within(writer.result)).toMatchObject({ ok: true })
          expect(await within(firstRead.result)).toMatchObject({
            ok: true,
            value: { senderHWM: 32, version: seed.state.version + 1 },
          })
        } finally {
          if (!finished) await within(fault.finish('rollback'))
          await within(fixture.close())
        }
      })
    })

    describe('storage guard witnesses', () => {
      test('partial-loss spent reinstall at incarnation one refuses', async () => {
        await within(assertPartialLossSpentRefused(params))
      })
      test.each(['state', 'trust'] as const)(
        'corrupt %s recovery preserves the readable counterpart',
        async (namespace) => {
          await within(assertCorruptStorageRecovery(params, namespace))
        },
      )
      test('internally consistent lower epoch refuses epoch regression', async () => {
        await within(assertLowerEpochRefused(params))
      })
    })
  })
}

function testOperationOwnership<TTx extends ConformanceGroupTransaction>(
  params: OwnershipPhasesConformanceParams<TTx>,
): void {
  type Fixture = ConformancePersistenceFixture<StorageTestPorts<TTx>>
  const outcome = (id: string) => ({ id, opID: id, at: 1000, kind: 'unknown' as const })
  const refused = { ok: false, error: { name: 'PersistencePhaseError' } }

  describe('operation ownership', () => {
    test('concurrent same-record calls register before closure and both persist', async () => {
      const fixture = await within(params.createFixture(groupID))
      const groups = fixture.ports.device.groups
      const change = await within(storageChange(groups, groupID, 'siblings'))
      const before = await within(groups.loadState(key))
      const latch = fixture.holdNextSeal()
      const operations: Array<ReturnType<typeof observed<void>>> = []
      try {
        const writer = observed(
          groups.transition(change, async (stores) => {
            const control = stores.incarnation(1).control
            operations.push(
              observed(control.apply({ putOutcomes: [outcome('sibling-A')] }, 'siblings')),
            )
            await within(latch.reached)
            operations.push(
              observed(control.apply({ putOutcomes: [outcome('sibling-B')] }, 'siblings')),
            )
          }),
        )
        await within(latch.reached)
        await operationReady(writer, () => (operations.length === 2 ? operations : undefined))
        expect(writer.settled()).toBe(false)
        expect(operations.every((op) => !op.settled())).toBe(true)
        latch.release()
        expect(await within(writer.result)).toEqual({ ok: true, value: undefined })
        expect(await within(Promise.all(operations.map((op) => op.result)))).toEqual([
          { ok: true, value: undefined },
          { ok: true, value: undefined },
        ])
        const control = await within(groups.ports(key).control.load())
        expect(control.outcomes).toEqual(
          expect.arrayContaining([outcome('sibling-A'), outcome('sibling-B')]),
        )
        expect((await within(groups.load(groupID)))?.revision).toBe(
          (change.expected?.revision ?? 0) + 1,
        )
        expect((await within(groups.loadState(key)))?.version).toBe((before?.version ?? 0) + 1)
      } finally {
        latch.release()
        await within(fixture.close())
      }
    })

    test('work drains before effects reopen stores supplied in work', async () => {
      let supplied!: ConformanceGroupStores<TTx>
      let workOperation!: ReturnType<typeof observed<void>>
      const order: Array<string> = []
      const fixture = await within(
        params.createFixture(groupID, {
          effects: {
            async outbox() {
              expect(workOperation.settled()).toBe(true)
              order.push('effects')
              await within(supplied.incarnation(1).cursor.save('reopened', '3'))
            },
          },
        }),
      )
      const groups = fixture.ports.device.groups
      let latch: ReturnType<Fixture['holdNextSeal']> | undefined
      try {
        const writer = observed(
          groups.transition(
            await within(storageChange(groups, groupID, 'reopen-stores')),
            async (stores) => {
              supplied = stores
              await within(stores.incarnation(1).meta.putEvents([event]))
              latch = fixture.holdNextSeal()
              workOperation = observed(
                stores
                  .incarnation(1)
                  .cursor.save('drained', '2')
                  .then(() => {
                    order.push('work')
                  }),
              )
            },
          ),
        )
        // Wait for the work callback to arm the codec latch.
        latch = await operationReady(writer, () => latch)
        await within(latch.reached)
        expect(order).toEqual([])
        latch.release()
        expect(await within(writer.result)).toEqual({ ok: true, value: undefined })
        expect(order).toEqual(['work', 'effects'])
        expect(await within(groups.ports(key).cursor.load('drained'))).toBe('2')
        expect(await within(groups.ports(key).cursor.load('reopened'))).toBe('3')
      } finally {
        latch?.release()
        await within(fixture.close())
      }
    })

    test.each(['abandoned seal', 'caught required open', 'caught partial write'] as const)(
      '%s failure makes the transition rollback-only',
      async (failure) => {
        const fixture = await within(params.createFixture(groupID))
        const groups = fixture.ports.device.groups
        const change = await within(storageChange(groups, groupID, 'fatal-operation'))
        const before = await within(fixture.inspectRows())
        let operation!: ReturnType<typeof observed<unknown>>
        try {
          const writer = observed(
            groups.transition(change, async (stores) => {
              const rows = stores.incarnation(1)
              if (failure === 'abandoned seal') {
                fixture.failNextSeal()
                operation = observed(rows.cursor.save('fatal', '4'))
              } else if (failure === 'caught required open') {
                fixture.failNextOpen()
                operation = observed(rows.state.load())
                expect((await within(operation.result)).ok).toBe(false)
              } else {
                operation = observed(
                  rows.outbox.put([
                    { ...entry, seq: 8 },
                    { ...entry, seq: -1 },
                  ]),
                )
                expect((await within(operation.result)).ok).toBe(false)
              }
            }),
          )
          expect((await within(writer.result)).ok).toBe(false)
          expect((await within(operation.result)).ok).toBe(false)
          expect(await within(fixture.inspectRows())).toEqual(before)
          await within(groups.transition(change, async () => {}))
        } finally {
          await within(fixture.close())
        }
      },
    )

    test('caught non-mutating refusal after a successful write still commits', async () => {
      let supplied!: ConformanceGroupStores<TTx>
      let refusal: unknown
      const fixture = await within(
        params.createFixture(groupID, {
          effects: {
            async outbox() {
              const life = await within(supplied.lifetime.load())
              if (life === null) throw new Error('Missing lifetime')
              refusal = await within(
                observed(supplied.lifetime.save({ ...life, restorePending: true })).result,
              )
            },
          },
        }),
      )
      try {
        const groups = fixture.ports.device.groups
        await within(
          groups.transition(
            await within(storageChange(groups, groupID, 'nonfatal')),
            async (stores) => {
              supplied = stores
              await within(stores.incarnation(1).cursor.save('successful', '3'))
              await within(stores.incarnation(1).meta.putEvents([event]))
            },
          ),
        )
        expect(refusal).toMatchObject(refused)
        expect(await within(groups.ports(key).cursor.load('successful'))).toBe('3')
        expect(await within(groups.load(groupID))).toMatchObject({
          mutationID: 'nonfatal',
          restorePending: false,
        })
      } finally {
        await within(fixture.close())
      }
    })

    test('late calls from a rolled-back attempt cannot write in its retry', async () => {
      const fixture = await within(params.createFixture(groupID))
      try {
        const groups = fixture.ports.device.groups
        const change = await within(storageChange(groups, groupID, 'retry-attempt'))
        fixture.retryNextTransition()
        let previous: ConformanceGroupStores<TTx> | undefined
        let late: unknown
        let attempts = 0
        await within(
          groups.transition(change, async (stores) => {
            attempts++
            if (previous === undefined) previous = stores
            else
              late = await within(
                observed(previous.incarnation(1).cursor.save('late-attempt', '9')).result,
              )
            await within(stores.incarnation(1).cursor.save('live-attempt', String(attempts)))
          }),
        )
        expect(attempts).toBe(2)
        expect(late).toMatchObject(refused)
        expect(await within(groups.ports(key).cursor.load('late-attempt'))).toBeNull()
        expect(await within(groups.ports(key).cursor.load('live-attempt'))).toBe('2')
        expect((await within(groups.load(groupID)))?.revision).toBe(
          (change.expected?.revision ?? 0) + 1,
        )
      } finally {
        await within(fixture.close())
      }
    })

    test.each(['work', 'effects'] as const)(
      '%s rejection revokes suspended operations before rollback',
      async (phase) => {
        let operation!: ReturnType<typeof observed<void>>
        let supplied!: ConformanceGroupStores<TTx>
        let latch: ReturnType<Fixture['holdNextSeal']> | undefined
        let fixture!: Fixture
        const suspend = async () => {
          latch = fixture.holdNextSeal()
          operation = observed(supplied.incarnation(1).cursor.save('revoked', '5'))
          await within(latch.reached)
          throw new Error('host callback failed')
        }
        fixture = await within(
          params.createFixture(groupID, {
            effects: {
              async outbox() {
                if (phase === 'effects') await suspend()
              },
            },
          }),
        )
        const groups = fixture.ports.device.groups
        const change = await within(storageChange(groups, groupID, 'rejected-callback'))
        const before = await within(fixture.inspectRows())
        try {
          const writer = observed(
            groups.transition(change, async (stores) => {
              supplied = stores
              if (phase === 'work') await suspend()
              else await within(stores.incarnation(1).meta.putEvents([event]))
            }),
          )
          expect(await within(operationReady(writer, () => operation))).toBeDefined()
          expect(await within(operation.result)).toMatchObject(refused)
          expect((await within(writer.result)).ok).toBe(false)
          await within(groups.transition(change, async () => {}))
          const after = await within(fixture.inspectRows())
          expect(after.cursor).toEqual(before.cursor)
          expect(after.meta).toEqual(before.meta)
          latch?.release()
          await turn()
          expect(await within(groups.ports(key).cursor.load('revoked'))).toBeNull()
        } finally {
          latch?.release()
          await within(fixture.close())
        }
      },
    )

    test('failed Read revokes its open and releases before the codec resumes', async () => {
      const fixture = await within(params.createFixture(groupID))
      const latch = fixture.holdNextOpen()
      let operation!: ReturnType<typeof observed<unknown>>
      try {
        const read = observed(
          fixture.readWith(async (stores) => {
            operation = observed(stores.ordinary('source-1').list(fixture.ports.device.ownerDID))
            await within(latch.started)
            throw new Error('read callback failed')
          }),
        )
        await within(latch.started)
        expect(await within(operation.result)).toMatchObject(refused)
        expect(await within(read.result)).toMatchObject({
          ok: false,
          error: { message: 'read callback failed' },
        })
        expect(await within(fixture.ports.device.load())).toMatchObject({ revision: 1 })
        await within(fixture.combinedWith(new AbortController().signal))
      } finally {
        latch.release()
        await within(fixture.close())
      }
    })

    test('effect getters are captured before finalise drains their work-store operations', async () => {
      let supplied!: ConformanceGroupStores<TTx>
      const probes: Array<Promise<unknown>> = []
      let reads = 0
      const fixture = await within(
        params.createFixture(groupID, {
          effects: {
            get outbox() {
              if (supplied !== undefined) {
                reads++
                probes.push(observed(supplied.lifetime.load()).result)
                probes.push(
                  observed(supplied.incarnation(1).cursor.save('getter-write', '9')).result,
                )
              }
              return async () => {}
            },
          },
        }),
      )
      try {
        const groups = fixture.ports.device.groups
        await within(
          groups.transition(
            await within(storageChange(groups, groupID, 'effect-getter')),
            async (stores) => {
              supplied = stores
              await within(stores.incarnation(1).meta.putEvents([event]))
            },
          ),
        )
        expect(reads).toBe(1)
        expect(await within(Promise.all(probes))).toMatchObject([
          { ok: true, value: { groupID } },
          { ok: true, value: undefined },
        ])
        expect(await within(groups.ports(key).cursor.load('getter-write'))).toBe('9')
      } finally {
        await within(fixture.close())
      }
    })

    test.each(['finalise', 'account'] as const)(
      '%s host accessor and codec cannot read or write',
      async (phase) => {
        const fixture = await within(params.createFixture(groupID))
        const groups = fixture.ports.device.groups
        const change = await within(storageChange(groups, groupID, `privacy-${phase}`))
        let supplied!: ConformanceGroupStores<TTx>
        const results: Array<unknown> = []
        try {
          fixture.onPhase(phase, () => {
            const stores = fixture.constructGroupStores(supplied.tx, key)
            const accessor = {
              get value() {
                return Promise.all([
                  observed(stores.lifetime.load()).result,
                  observed(stores.incarnation(1).cursor.save('accessor-write', '9')).result,
                ])
              },
            }
            fixture.probeCodec(async (currentPhase) => {
              expect(currentPhase).toBe(phase)
              results.push(...(await within(accessor.value)))
              results.push(await within(observed(stores.lifetime.load()).result))
              results.push(
                await within(
                  observed(stores.incarnation(1).cursor.save('codec-write', '9')).result,
                ),
              )
            })
          })
          const withEffects = phase === 'account'
          // Account needs a side change made by effects to exercise its codec path.
          if (withEffects)
            fixture.onPhase('effects', async () => {
              await within(supplied.incarnation(1).cursor.save('effect-privacy', '3'))
            })
          await within(
            groups.transition(change, async (stores) => {
              supplied = stores
            }),
          )
          expect(results).toHaveLength(4)
          for (const result of results) expect(result).toMatchObject(refused)
          expect(await within(groups.ports(key).cursor.load('accessor-write'))).toBeNull()
          expect(await within(groups.ports(key).cursor.load('codec-write'))).toBeNull()
        } finally {
          await within(fixture.close())
        }
      },
    )

    test('a hook-scheduled root succeeds after its entry releases', async () => {
      const fixture = await within(params.createFixture(groupID))
      let scheduled!: Promise<unknown>
      try {
        const groups = fixture.ports.device.groups
        await within(
          groups.transition(
            await within(storageChange(groups, groupID, 'released-hook')),
            async (stores) => {
              stores.tx.onCommit(() => {
                scheduled = new Promise((resolve, reject) => {
                  setTimeout(() => {
                    groups.load(groupID).then(resolve, reject)
                  }, 0)
                })
              })
            },
          ),
        )
        expect(await within(scheduled)).toMatchObject({ mutationID: 'released-hook' })
      } finally {
        await within(fixture.close())
      }
    })

    test('independent concurrent roots stay unbound on different groups', async () => {
      const fixture = await within(params.createFixture(groupID))
      const latch = fixture.holdNextSeal()
      try {
        const groups = fixture.ports.device.groups
        const changeA = await within(storageChange(groups, groupID, 'independent-A'))
        const changeB = await within(storageChange(groups, 'group-B', 'independent-B'))
        const first = observed(
          groups.transition(changeA, async (stores) => {
            await within(stores.incarnation(1).cursor.save('independent-A', '2'))
          }),
        )
        await within(latch.reached)
        await within(
          groups.transition(changeB, async (stores) => {
            await within(stores.incarnation(1).cursor.save('independent-B', '3'))
          }),
        )
        expect(first.settled()).toBe(false)
        latch.release()
        expect(await within(first.result)).toEqual({ ok: true, value: undefined })
        expect((await within(groups.load(groupID)))?.mutationID).toBe('independent-A')
        expect((await within(groups.load('group-B')))?.mutationID).toBe('independent-B')
      } finally {
        latch.release()
        await within(fixture.close())
      }
    })

    for (const phase of [
      'prepare',
      'work',
      'effects',
      'finalise',
      'account',
      'proof',
      'hook',
    ] as const) {
      for (const timing of params.ownershipContext === undefined
        ? (['synchronous'] as const)
        : (['synchronous', 'after await'] as const)) {
        test(`${phase} root ${timing} rejects reentrancy`, async () => {
          const port = params.ownershipContext?.()
          const fixture = await within(params.createFixture(groupID, { ownershipContext: port }))
          const groups = fixture.ports.device.groups
          const change = await within(storageChange(groups, groupID, 'phase-reentrant'))
          let nested: ReturnType<typeof observed<unknown>> | undefined
          let token: object | undefined
          try {
            fixture.onPhase(phase, async () => {
              if (timing === 'after await') await Promise.resolve()
              token = port?.get()
              nested = observed(groups.load(groupID))
              await within(nested.result)
            })
            if (phase === 'proof') fixture.commitThenReject()
            const transition = await within(
              observed(groups.transition(change, async () => {})).result,
            )
            expect(transition).toEqual({ ok: true, value: undefined })
            if (nested === undefined) throw new Error('Missing nested root call')
            expect(await within(nested.result)).toMatchObject({
              ok: false,
              error: { name: 'ReentrantOwnershipError' },
            })
            if (port !== undefined) {
              expect(token).toBeDefined()
              expect(Object.isFrozen(token)).toBe(true)
              expect(Object.keys(token ?? {})).toEqual([])
              expect(port.get()).toBeUndefined()
            }
          } finally {
            await within(fixture.close())
          }
        })
      }
    }

    if (params.ownershipContext !== undefined) {
      test('ownership context restores the caller after a throwing provider callback', async () => {
        const port = params.ownershipContext?.()
        if (port === undefined) throw new Error('Missing ownership context')
        const fixture = await within(params.createFixture(groupID, { ownershipContext: port }))
        let bound: object | undefined
        let nextBound: object | undefined
        const failure = new Error('callback failed')
        try {
          const groups = fixture.ports.device.groups
          const change = await within(storageChange(groups, groupID, 'throwing-context'))
          fixture.onPhase('work', () => {
            bound = port.get()
            throw failure
          })
          expect(await within(observed(groups.transition(change, async () => {})).result)).toEqual({
            ok: false,
            error: failure,
          })
          expect(port.get()).toBeUndefined()
          expect(await within(groups.load(groupID))).toMatchObject({ groupID })
          fixture.onPhase('work', () => {
            nextBound = port.get()
          })
          await within(groups.transition(change, async () => {}))
          expect(bound).toBeDefined()
          expect(Object.isFrozen(bound)).toBe(true)
          expect(nextBound).toBeDefined()
          expect(nextBound).not.toBe(bound)
          expect(port.get()).toBeUndefined()
        } finally {
          await within(fixture.close())
        }
      })
    }

    test('device loads, transitions, package reads and Combined complete without nesting', async () => {
      const fixture = await within(params.createFixture('group-B'))
      try {
        const device = fixture.ports.device
        const loaded = await within(device.load())
        const reopened = await within(fixture.reopen())
        expect(await within(reopened.device.load())).toEqual(loaded)
        await within(
          reopened.device.transition(
            { mutationID: 'device-nonnested', expectedRevision: loaded.revision, group: null },
            async (stores) => {
              expect(await within(stores.restore.load())).not.toBeNull()
            },
          ),
        )
        expect(
          await within(reopened.packageStores('source-1').ordinary.list(device.ownerDID)),
        ).toHaveLength(1)
        const change = await within(
          storageChange(reopened.device.groups, 'group-B', 'combined-nonnested'),
        )
        await within(
          reopened.device.transition(
            {
              mutationID: 'combined-nonnested',
              expectedRevision: loaded.revision + 1,
              group: change,
            },
            async (stores) => {
              if (stores.group === null) throw new Error('Missing group participant')
              await within(stores.group.incarnation(1).cursor.save('combined-nonnested', '3'))
              await within(stores.cleanup.list())
            },
          ),
        )
        expect((await within(reopened.device.load())).revision).toBe(loaded.revision + 2)
      } finally {
        await within(fixture.close())
      }
    })

    test('cancelling a Combined group wait releases both entries', async () => {
      const fixture = await within(params.createFixture(groupID))
      const groups = fixture.ports.device.groups
      const change = await within(storageChange(groups, groupID, 'held-group'))
      const latch = fixture.holdNextSeal()
      const cancel = new AbortController()
      try {
        const writer = observed(
          groups.transition(change, async (stores) => {
            await within(stores.incarnation(1).cursor.save('held-group', '3'))
          }),
        )
        await within(latch.reached)
        const combined = observed(fixture.combinedWith(cancel.signal))
        await turn()
        expect(combined.settled()).toBe(false)
        const reason = new Error('cancel combined')
        cancel.abort(reason)
        expect(await within(combined.result)).toEqual({ ok: false, error: reason })
        expect(await within(fixture.ports.device.load())).toMatchObject({ revision: 1 })
        latch.release()
        expect((await within(writer.result)).ok).toBe(true)
        await within(fixture.combinedWith(new AbortController().signal))
      } finally {
        cancel.abort()
        latch.release()
        await within(fixture.close())
      }
    })

    test('fail-stop rejects active queued and draining operations with one conflict instance', async () => {
      const fixture = await within(params.createFixture(groupID))
      const groups = fixture.ports.device.groups
      const changeA = await within(storageChange(groups, groupID, 'conflicted-owner'))
      const changeB = await within(storageChange(groups, 'group-B', 'draining-owner'))
      const before = await within(fixture.inspectRows())
      const fault = fixture.rejectCommitPending()
      let latch: ReturnType<Fixture['holdNextSeal']> | undefined
      let finished = false
      try {
        const conflicted = observed(groups.transition(changeA, async () => {}))
        await within(fault.rejected)
        await within(fault.barrierWaiting)
        latch = fixture.holdNextSeal()
        const operations: Array<ReturnType<typeof observed<void>>> = []
        const draining = observed(
          groups.transition(changeB, async (stores) => {
            operations.push(observed(stores.incarnation(1).cursor.save('active', '2')))
            operations.push(observed(stores.incarnation(1).cursor.save('queued', '3')))
          }),
        )
        await within(latch.reached)
        expect(draining.settled()).toBe(false)
        await within(
          fixture.forceOwnerMarker({ groupID }, { mutationID: 'intruder', revision: 99 }),
        )
        await within(fault.finish('rollback'))
        finished = true
        const conflict = await within(conflicted.result)
        expect(conflict).toMatchObject({ ok: false, error: { name: 'GroupStateConflictError' } })
        if (conflict.ok) throw new Error('Expected conflict')
        const results = await within(
          Promise.all([draining.result, ...operations.map((op) => op.result)]),
        )
        for (const result of results) {
          expect(result.ok).toBe(false)
          if (result.ok) throw new Error('Expected conflict')
          expect(result.error).toBe(conflict.error)
        }
        latch.release()
        await turn()
        const after = await within(fixture.inspectRows())
        expect(after.cursor).toEqual(before.cursor)
        expect(after.lifetime).toEqual(before.lifetime)
      } finally {
        latch?.release()
        if (!finished) await within(fault.finish('rollback'))
        await within(fixture.close())
      }
    })

    test.each(['state', 'trust'] as const)(
      'corrupt %s preserves safety events and control obligations',
      async (namespace) => {
        const fixture = await within(params.createFixture(groupID))
        try {
          const row = (await within(fixture.inspectRawBytes())).find(
            (row) =>
              row.namespace === namespace && row.groupID === groupID && row.recordID === 'current',
          )
          if (row === undefined) throw new Error('Missing safety row')
          await within(
            fixture.mutateStoredRecord(namespace, row.key, (bytes) => {
              bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1
              return bytes
            }),
          )
          const corrupt = await within(fixture.inspectRawBytes())
          const groups = fixture.ports.device.groups
          await within(
            groups.transition(
              await within(storageChange(groups, groupID, 'safety-obligation')),
              async (stores) => {
                await within(
                  stores
                    .incarnation(1)
                    .control.apply(
                      { putOutcomes: [outcome('safety-outcome')] },
                      'safety-obligation',
                    ),
                )
                await within(
                  stores.incarnation(1).meta.putEvents([
                    {
                      ...key,
                      id: 'safety-event',
                      kind: 'group:recovery-unavailable',
                      reason: 'trust-unreadable',
                    },
                  ]),
                )
              },
            ),
          )
          expect((await within(groups.ports(key).control.load())).outcomes).toContainEqual(
            outcome('safety-outcome'),
          )
          let events: Array<unknown> = []
          await within(
            groups.transition(
              await within(storageChange(groups, groupID, 'read-safety-event')),
              async (stores) => {
                events = await within(stores.incarnation(1).meta.events())
              },
            ),
          )
          expect(events).toContainEqual({
            ...key,
            id: 'safety-event',
            kind: 'group:recovery-unavailable',
            reason: 'trust-unreadable',
          })
          const after = await within(fixture.inspectRawBytes())
          expect(
            after.find((value) => value.namespace === namespace && value.key === row.key),
          ).toEqual(corrupt.find((value) => value.namespace === namespace && value.key === row.key))
        } finally {
          await within(fixture.close())
        }
      },
    )
  })
}

async function operationReady<T>(
  writer: ReturnType<typeof observed<unknown>>,
  get: () => T | undefined,
): Promise<T> {
  return await within(
    (async () => {
      while (get() === undefined) {
        if (writer.settled()) throw new Error('Callback did not start an operation')
        await turn()
      }
      return get() as T
    })(),
  )
}

export type OwnershipPhasesConformanceParams<TTx extends ConformanceGroupTransaction> = Omit<
  StorageConformanceParams<TTx>,
  'createFixture'
> & {
  createFixture(
    id: string,
    options?: Parameters<StorageConformanceParams<TTx>['createFixture']>[1],
  ): Promise<
    Omit<ConformancePersistenceFixture<StorageTestPorts<TTx>>, 'entry'> & {
      entry(): ConformanceEntryCapability<TTx>
    }
  >

  ownershipContext?: () => ConformanceOwnershipContextPort
}

export function testOwnershipPhasesConformance<TTx extends ConformanceGroupTransaction>(
  params: OwnershipPhasesConformanceParams<TTx>,
): void {
  for (const ownershipContext of [
    undefined,
    ...(params.ownershipContext === undefined ? [] : [params.ownershipContext]),
  ]) {
    runOwnershipPhasesConformance({
      ...params,
      label: `${params.label} -- ${ownershipContext === undefined ? 'without port' : 'with port'}`,
      ownershipContext,
      createFixture: (id, options) =>
        params.createFixture(id, {
          ...options,
          ownershipContext: options?.ownershipContext ?? ownershipContext?.(),
        }),
    })
  }
}

function testPreparedOwnership<TTx extends ConformanceGroupTransaction>(
  params: OwnershipPhasesConformanceParams<TTx>,
): void {
  const expected = (life: ConformanceGroupLifetime | null) =>
    life === null ? null : { revision: life.revision, activeIncarnation: life.activeIncarnation }
  const request = (mutationID: string) => ({ groupID, mutationID })
  describe('prepare capability', () => {
    test('fresh prepare stores refuse domain and side writes', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        const before = await fixture.inspectRows()
        let codecs = 0
        await fixture.entry().run(
          request('prepare-writes'),
          async (reads) => {
            const life = await reads.lifetime()
            if (life === null) throw new Error('Missing lifetime')
            const stores = fixture.constructPrepareStores(key)
            fixture.probeCodec(async () => {
              codecs++
            })
            await expect(stores.lifetime.save(life)).rejects.toMatchObject({
              name: 'PersistencePhaseError',
            })
            expect(codecs).toBe(0)
            await expect(
              stores.incarnation(1).control.apply({ putOutcomes: [] }, 'forbidden'),
            ).rejects.toMatchObject({ name: 'PersistencePhaseError' })
            await expect(
              params.writeSideRow(stores.tx, 'prepare-side', utf8('forbidden')),
            ).rejects.toMatchObject({ name: 'PersistencePhaseError' })
            expect(codecs).toBe(0)
            expect(await fixture.inspectRows()).toEqual(before)
            return { expected: expected(life), value: null }
          },
          async () => undefined,
        )
        expect(await fixture.inspectSideRow('prepare-side')).toBeNull()
      } finally {
        await fixture.close()
      }
    })
    test('prepare bindings expire', async () => {
      const fixture = await params.createFixture(groupID)
      let captured!: ConformanceEntryReads
      let constructed!: ConformanceGroupStores<TTx>
      try {
        await fixture.entry().run(
          request('prepare-expire'),
          async (reads) => {
            captured = reads
            constructed = fixture.constructPrepareStores(key)
            return { expected: expected(await reads.lifetime()), value: null }
          },
          async () => {
            await expect(captured.lifetime()).rejects.toMatchObject({
              name: 'PersistencePhaseError',
            })
            await expect(constructed.trust.load()).rejects.toMatchObject({
              name: 'PersistencePhaseError',
            })
          },
        )
        await expect(captured.control(1)).rejects.toMatchObject({ name: 'PersistencePhaseError' })
        await expect(constructed.lifetime.load()).rejects.toMatchObject({
          name: 'PersistencePhaseError',
        })
      } finally {
        await fixture.close()
      }
    })
    test('prepared CAS serialises concurrent writes', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        const revisions = await Promise.all(
          ['one', 'two'].map((mutationID) =>
            fixture.entry().run(
              request(mutationID),
              async (reads) => {
                const life = await reads.lifetime()
                if (life === null) throw new Error('Missing lifetime')
                return { expected: expected(life), value: life.revision }
              },
              async (stores, revision) => {
                expect((await stores.lifetime.load())?.revision).toBe(revision)
                return revision + 1
              },
            ),
          ),
        )
        expect(revisions).toEqual([3, 4])
        expect((await fixture.ports.device.groups.load(groupID))?.revision).toBe(4)
      } finally {
        await fixture.close()
      }
    })
    test('work refuses stale prepared expected', async () => {
      const fixture = await params.createFixture(groupID)
      let work = 0
      try {
        const before = await fixture.inspectRows()
        await expect(
          fixture.entry().run(
            request('stale'),
            async (reads) => {
              const life = await reads.lifetime()
              expect(await reads.trust()).not.toBeNull()
              expect(await reads.state(1)).toMatchObject({ deleted: false })
              if (life === null) throw new Error('Missing lifetime')
              return {
                expected: { revision: life.revision - 1, activeIncarnation: 1 },
                value: null,
              }
            },
            async () => {
              work++
            },
          ),
        ).rejects.toMatchObject({ name: 'GroupStateConflictError' })
        expect(work).toBe(0)
        expect(await fixture.inspectRows()).toEqual(before)
      } finally {
        await fixture.close()
      }
    })
    test('event reads are neutral and proof fenced', async () => {
      const fixture = await params.createFixture(groupID)
      let fault: ReturnType<typeof fixture.rejectCommitPending> | undefined
      let committed = false
      try {
        const groups = fixture.ports.device.groups
        const before = await fixture.inspectRows()
        const phases: Array<string> = []
        fixture.onPhase('work', () => {
          phases.push('work')
        })
        const events = await fixture.entry().read(groupID, (reads) => reads.events(1))
        expect(events).toHaveLength(1)
        expect(phases).toEqual([])
        const first = events[0]
        if (first?.kind !== 'accepted') throw new Error('Missing app event')
        first.entry.data.fill(0)
        expect(await fixture.entry().read(groupID, (reads) => reads.events(1))).toEqual([
          expect.objectContaining({
            entry: expect.objectContaining({ data: utf8('plaintext-sentinel') }),
          }),
        ])
        expect(await fixture.inspectRows()).toEqual(before)
        const mutationID = 'event-tombstone'
        await groups.transition(
          await storageChange(groups, groupID, mutationID),
          async (stores) => {
            const life = await stores.lifetime.load()
            const state = await stores.incarnation(1).state.load()
            if (life === null || state === null) throw new Error('Missing source')
            await stores.lifetime.save({
              ...life,
              activeIncarnation: null,
              revision: life.revision + 1,
              mutationID,
            })
            await stores
              .incarnation(1)
              .state.save({ ...key, deleted: true, version: state.version + 1 })
          },
        )
        const tombstone = await fixture.inspectRows()
        expect(await fixture.entry().read(groupID, (reads) => reads.events(1))).toHaveLength(1)
        expect(await fixture.inspectRows()).toEqual(tombstone)
        fixture.onPhase('work', () => {
          fault = fixture.rejectCommitPending()
        })
        const writing = observed(
          groups.transition(
            await storageChange(groups, groupID, 'event-pending'),
            async (stores) => {
              await stores.incarnation(1).meta.putEvents([event])
            },
          ),
        )
        while (fault === undefined) await turn()
        await within(fault.barrierWaiting)
        let readStarted = false
        const reading = observed(
          fixture.entry().read(groupID, async (reads) => {
            readStarted = true
            return await reads.events(1)
          }),
        )
        await turn()
        expect(readStarted).toBe(false)
        expect(reading.settled()).toBe(false)
        await fault.finish('commit')
        committed = true
        expect((await within(writing.result)).ok).toBe(true)
        const committedRows = await fixture.inspectRows()
        const result = await within(reading.result)
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value).toHaveLength(2)
        expect(await fixture.inspectRows()).toEqual(committedRows)
      } finally {
        await fault?.finish(committed ? 'commit' : 'rollback')
        await fixture.close()
      }
    })
    test('read preserves revisions', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        const before = await fixture.inspectRows()
        for (let index = 0; index < 3; index++) {
          await fixture.entry().read(groupID, async (reads) => {
            expect((await reads.lifetime())?.revision).toBe(2)
            expect((await reads.metadata(1))?.version).toBe(2)
            expect((await reads.state(1))?.version).toBe(2)
            expect(await reads.controlMutation(1)).toBe('seed-records')
            expect((await reads.control(1)).outcomes).toHaveLength(1)
            expect(await reads.diagnoseState(1)).toBe('readable')
          })
        }
        expect(await fixture.inspectRows()).toEqual(before)
      } finally {
        await fixture.close()
      }
    })
    test.each(['proof', 'backend'] as const)(
      'prepare waits behind committed but unsettled entry (%s)',
      async (settlement) => {
        const fixture = await params.createFixture(groupID)
        const proof = localDeferred<void>()
        const release = localDeferred<void>()
        let prepared = false
        const fault = settlement === 'backend' ? fixture.rejectCommitPending() : undefined
        let completed = false
        try {
          if (settlement === 'proof') {
            fixture.onPhase('proof', async () => {
              proof.resolve()
              await release.promise
            })
            fixture.commitThenReject()
          }
          const first = fixture.entry().run(
            request('unsettled'),
            async (reads) => ({ expected: expected(await reads.lifetime()), value: null }),
            async () => undefined,
          )
          await within(fault?.barrierWaiting ?? proof.promise)
          const next = fixture.entry().read(groupID, async (reads) => {
            prepared = true
            return await reads.lifetime()
          })
          await turn()
          expect(prepared).toBe(false)
          expect(
            await within(fixture.entry().read('group-B', (reads) => reads.lifetime())),
          ).toMatchObject({ revision: 1 })
          release.resolve()
          await fault?.finish('commit')
          completed = true
          await within(first)
          expect(await within(next)).toMatchObject({ revision: 3 })
        } finally {
          release.resolve()
          if (!completed) await fault?.finish('rollback')
          await fixture.close()
        }
      },
    )
    test('prepare roots refuse', async () => {
      const fixture = await params.createFixture(groupID, {
        ownershipContext: params.ownershipContext?.(),
      })
      try {
        await fixture.entry().run(
          request('prepare-root'),
          async (reads) => {
            const root = fixture.ports.device.groups.load(groupID)
            await expect(within(root)).rejects.toMatchObject({ name: 'ReentrantOwnershipError' })
            if (params.ownershipContext !== undefined) {
              await Promise.resolve()
              await expect(within(fixture.ports.device.groups.load(groupID))).rejects.toMatchObject(
                { name: 'ReentrantOwnershipError' },
              )
            }
            return { expected: expected(await reads.lifetime()), value: null }
          },
          async () => undefined,
        )
      } finally {
        await fixture.close()
      }
    })
    test('diagnostic does not authorise state', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        const record = (await fixture.inspectRawBytes()).find(
          (row) => row.namespace === 'state' && row.groupID === groupID,
        )
        if (record === undefined) throw new Error('Missing state row')
        await fixture.mutateStoredRecord('state', record.key, (bytes) => {
          bytes[0] = (bytes[0] ?? 0) ^ 1
          return bytes
        })
        await fixture.entry().run(
          request('diagnose-safety'),
          async (reads) => {
            expect(await reads.diagnoseState(1)).toBe('unreadable')
            expect(await reads.metadata(1)).toMatchObject({ version: 2, deleted: false })
            return { expected: expected(await reads.lifetime()), value: null }
          },
          async (stores) => {
            await stores
              .incarnation(1)
              .control.apply(
                { putOutcomes: [{ id: 'safety', opID: 'safety', at: 1, kind: 'unknown' }] },
                'diagnose-safety',
              )
          },
        )
        const before = await fixture.inspectRows()
        await expect(
          fixture.entry().run(
            request('required'),
            async (reads) => {
              await expect(reads.state(1)).rejects.toBeDefined()
              return { expected: expected(await reads.lifetime()), value: null }
            },
            async () => undefined,
          ),
        ).rejects.toMatchObject({ name: 'GroupStateConflictError' })
        expect(await fixture.inspectRows()).toEqual(before)
      } finally {
        await fixture.close()
      }
    })
  })
}

function testCommitObservation<TTx extends ConformanceGroupTransaction>(
  params: OwnershipPhasesConformanceParams<TTx>,
): void {
  describe('accounted commit observation', () => {
    test('every facade commit is observed with final versions', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        const groups = fixture.ports.device.groups
        const seed = await storageSeed(groups)
        const observations: Array<ConformanceAccountedGroupObservation> = []
        const unsubscribe = fixture.entry().observe(groupID, (value) => observations.push(value))
        const ports = groups.ports(key)
        await ports.control.apply(
          { cursor: { position: null, epoch: seed.state.epoch } },
          'control-observed',
        )
        await ports.anchor.save({ anchor: { epoch: 3, secret: new Uint8Array(32).fill(98) } })
        await ports.cursor.save('observed-topic', '000000000001')
        await ports.outbox.put({ ...entry, seq: 8 })
        expect(observations).toHaveLength(4)
        for (const [index, value] of observations.entries()) {
          expect(value.lifetime?.revision).toBe(seed.lifetime.revision + index + 1)
          expect(value.activeKey).toEqual(key)
          expect(value.activeVersion).toBe(seed.state.version + index + 1)
          expect(value.metadata).toContainEqual(
            expect.objectContaining({ ...key, version: value.activeVersion }),
          )
          expect(value.trust).toEqual(seed.trust)
          expect(value.trustStatus).toBe('readable')
          expect(value.stateStatus).toBe('readable')
          expect(value.terminal).toBe(false)
          expect(value.control?.cursor?.epoch).toBe(seed.state.epoch)
        }
        unsubscribe()
        await ports.cursor.save('observed-topic', '000000000002')
        expect(observations).toHaveLength(4)
      } finally {
        await fixture.close()
      }
    })

    test('effect-only observation uses accounting once after side writes', async () => {
      let supplied!: ConformanceGroupStores<TTx>
      const donor = await params.createFixture(groupID)
      const fixture = await params.createFixture(groupID, {
        effects: {
          async outbox() {
            await supplied.incarnation(2).cursor.save('effect-observed', '000000000001')
          },
        },
      })
      try {
        const groups = fixture.ports.device.groups
        const fresh = await storageSeed(donor.ports.device.groups)
        await groups.transition(
          await storageChange(groups, groupID, 'install-observed'),
          async (stores) => {
            await writeStorageInstall(stores, fresh, 'install-observed', 2)
          },
        )
        const installed = await groups.loadState({ ...key, incarnation: 2 })
        const observations: Array<ConformanceAccountedGroupObservation> = []
        fixture.entry().observe(groupID, (value) => observations.push(value))
        const change = await storageChange(groups, groupID, 'effect-observed')
        await groups.transition(change, async (stores) => {
          supplied = stores
          await stores.incarnation(1).meta.putEvents([event])
        })
        expect(observations).toHaveLength(1)
        expect(observations[0]?.activeVersion).toBe((installed?.version ?? 0) + 1)
        expect(await groups.ports({ ...key, incarnation: 2 }).cursor.load('effect-observed')).toBe(
          '000000000001',
        )
      } finally {
        await fixture.close()
        await donor.close()
      }
    })

    test.each(['commit', 'rollback', 'conflict'] as const)(
      'pending proof publishes once and retains prior observation: %s',
      async (outcome) => {
        const fixture = await params.createFixture(groupID)
        let fault: ReturnType<typeof fixture.rejectCommitPending> | undefined
        try {
          const groups = fixture.ports.device.groups
          const observations: Array<ConformanceAccountedGroupObservation> = []
          const released: Array<ConformanceAccountedGroupObservation> = []
          fixture.entry().observe(
            groupID,
            (value) => observations.push(value),
            (value) => released.push(value),
          )
          await groups.ports(key).cursor.save('prior', '1')
          await turn()
          const prior = observations[0]
          const change = await storageChange(groups, groupID, 'pending-observed')
          fixture.onPhase('work', () => {
            fault = fixture.rejectCommitPending()
          })
          const saving = observed(
            groups.transition(change, async (stores) => {
              await stores.incarnation(1).cursor.save('pending', '2')
            }),
          )
          const pending = await within(waitForFault())
          await within(pending.rejected)
          await within(pending.barrierWaiting)
          expect(observations, 'no observation before proof').toEqual([prior])
          expect(released).toEqual([prior])
          if (outcome === 'conflict')
            await fixture.forceOwnerMarker({ groupID }, { mutationID: 'intruder', revision: 99 })
          await pending.finish(outcome === 'commit' ? 'commit' : 'rollback')
          const result = await within(saving.result)
          await turn()
          expect(observations).toHaveLength(outcome === 'commit' ? 2 : 1)
          expect(released).toHaveLength(observations.length)
          if (outcome === 'commit') {
            expect(result.ok).toBe(true)
            expect(observations[1]?.mutationID).toBe(change.mutationID)
            expect(released[1]).toBe(observations[1])
          } else expect(result.ok).toBe(false)
          async function waitForFault() {
            while (fault === undefined) await turn()
            return fault
          }
        } finally {
          await fault?.finish(outcome === 'commit' ? 'commit' : 'rollback')
          await fixture.close()
        }
      },
    )

    test.each([false, true])(
      'afterRelease can call persistence roots; Combined=%s',
      async (combined) => {
        const context = params.ownershipContext?.()
        const fixture = await params.createFixture(groupID, { ownershipContext: context })
        try {
          const device = fixture.ports.device
          const groups = device.groups
          const change = await storageChange(groups, groupID, 'release-observed')
          const revision = (await device.load()).revision
          const completed = localDeferred<void>()
          let synchronous!: ConformanceAccountedGroupObservation
          let token: object | undefined
          let failure: unknown
          const unsubscribe = fixture.entry().observe(
            groupID,
            (value) => {
              synchronous = value
            },
            (value) => {
              token = context?.get()
              unsubscribe()
              void (async () => {
                expect(value).toBe(synchronous)
                expect(token, 'afterRelease clears callback context').toBeUndefined()
                expect(await groups.load(groupID)).toEqual(value.lifetime)
                expect((await device.load()).revision).toBe(revision + (combined ? 1 : 0))
                await groups.transition(
                  await storageChange(groups, groupID, 'listener-transition'),
                  async () => {},
                )
              })()
                .catch((error: unknown) => {
                  failure = error
                })
                .finally(() => completed.resolve())
            },
          )
          if (combined)
            await device.transition(
              { mutationID: change.mutationID, expectedRevision: revision, group: change },
              async (stores) => {
                await stores.group?.incarnation(1).cursor.save('release', '1')
              },
            )
          else await groups.transition(change, async () => {})
          await within(completed.promise)
          expect(failure).toBeUndefined()
        } finally {
          await fixture.close()
        }
      },
    )

    test('retried attempts drop their staged observation', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        const groups = fixture.ports.device.groups
        const observations: Array<ConformanceAccountedGroupObservation> = []
        const released: Array<ConformanceAccountedGroupObservation> = []
        fixture.entry().observe(
          groupID,
          (value) => observations.push(value),
          (value) => released.push(value),
        )
        const change = await storageChange(groups, groupID, 'retry-observed')
        let attempts = 0
        fixture.retryNextTransition()
        await groups.transition(change, async (stores) => {
          await stores.incarnation(1).cursor.save('retry-observed', String(++attempts))
        })
        await turn()
        expect(attempts).toBe(2)
        expect(observations, 'only the final accounted attempt is published').toHaveLength(1)
        expect(released).toHaveLength(1)
        expect(released[0]).toBe(observations[0])
      } finally {
        await fixture.close()
      }
    })

    test('Combined observation waits both owners to prove', async () => {
      const fixture = await params.createFixture(groupID)
      let fault: ReturnType<typeof fixture.rejectCommitPending> | undefined
      try {
        const device = fixture.ports.device
        const change = await storageChange(device.groups, groupID, 'combined-observed')
        const revision = (await device.load()).revision
        const observations: Array<ConformanceAccountedGroupObservation> = []
        fixture.entry().observe(groupID, (value) => observations.push(value))
        fixture.onPhase('work', () => {
          fault = fixture.rejectCommitPending()
        })
        const saving = observed(
          device.transition(
            { mutationID: change.mutationID, expectedRevision: revision, group: change },
            async () => {},
          ),
        )
        while (fault === undefined) await turn()
        await within(fault.rejected)
        await within(fault.barrierWaiting)
        expect(observations).toEqual([])
        await fixture.forceOwnerMarker(
          { groupID },
          { mutationID: change.mutationID, revision: (change.expected?.revision ?? 0) + 1 },
        )
        await fault.finish('rollback')
        expect(await within(saving.result)).toMatchObject({
          ok: false,
          error: { name: 'GroupStateConflictError' },
        })
        expect(observations).toEqual([])
      } finally {
        await fault?.finish('rollback')
        await fixture.close()
      }
    })
  })
}
