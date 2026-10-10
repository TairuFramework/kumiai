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
  ConformanceGroupStores,
  ConformanceGroupTransaction,
  ConformancePersistenceFixture,
  ConformanceStorageAppOutboxEntry,
  StorageConformanceParams,
  StorageTestPorts,
} from './persistence-fixture.js'

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

export function testOwnershipPhasesConformance<TTx extends ConformanceGroupTransaction>(
  params: StorageConformanceParams<TTx>,
): void {
  type Fixture = ConformancePersistenceFixture<StorageTestPorts<TTx>>
  describe(`Ownership phases conformance -- ${params.label}`, () => {
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
            outbox: (tx) => within(params.writeSideRow(tx, 'effect', utf8('effect'))),
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
            async outbox() {
              await within(effectStores.incarnation(2).anchor.save(anchor))
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
        const fixture = await within(
          params.createFixture(groupID, {
            async outbox() {
              expect(await within(supplied.lifetime.load())).toMatchObject({
                mutationID: 'effect-load',
              })
            },
          }),
        )
        try {
          const groups = fixture.ports.device.groups
          await within(
            groups.transition(
              await within(storageChange(groups, groupID, 'effect-load')),
              async (stores) => {
                supplied = stores
                await within(stores.incarnation(1).meta.putEvents([event]))
              },
            ),
          )
        } finally {
          await within(fixture.close())
        }
      })
      test('delete effect can clear transaction-bound transport', async () => {
        let supplied!: ConformanceGroupStores<TTx>
        const fixture = await within(
          params.createFixture(groupID, {
            async delete(_tx, deletedKey) {
              await within(supplied.incarnation(deletedKey.incarnation).clearTransport())
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
            async outbox(tx) {
              await within(params.writeSideRow(tx, 'throw-effect', utf8('effect')))
              throw new Error('effect failure')
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
          const change = await within(storageChange(groups, groupID, 'committed-unknown'))
          const order: Array<string> = []
          const calls: Array<string> = []
          const started = Promise.withResolvers<void>()
          fixture.commitThenReject()
          const writer = observed(
            groups
              .transition(change, async (stores) => {
                hooks(stores.tx, calls)
                stores.tx.onCommit(() => {
                  order.push('hook')
                })
                await within(
                  stores
                    .incarnation(1)
                    .state.save({ ...seed.state, version: seed.state.version + 1, senderHWM: 32 }),
                )
                started.resolve()
              })
              .then((value) => {
                expect(calls).toEqual(['commit'])
                order.push('caller')
                return value
              }),
          )
          await within(started.promise)
          expect(calls).toEqual([])
          const reads = [
            groups.loadState(key),
            groups.load(groupID),
            groups.ports(key).control.load(),
            device.load(),
          ].map((read) =>
            observed(
              read.then((value) => {
                expect(calls).toEqual(['commit'])
                order.push('read')
                return value
              }),
            ),
          )
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
          for (const read of reads) expect(await within(read.result)).toMatchObject({ ok: true })
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
        const change = await within(storageChange(groups, groupID, 'pending'))
        const otherChange = await within(storageChange(groups, 'group-B', 'independent'))
        const fault = fixture.rejectCommitPending()
        try {
          const calls: Array<string> = []
          const writer = observed(
            groups.transition(change, async (stores) => {
              hooks(stores.tx, calls)
              await within(
                stores
                  .incarnation(1)
                  .state.save({ ...seed.state, version: seed.state.version + 1, senderHWM: 32 }),
              )
            }),
          )
          await within(fault.rejected)
          await within(fault.barrierWaiting)
          const reads = [
            groups.loadState(key),
            groups.load(groupID),
            groups.ports(key).control.load(),
            device.load(),
          ].map((read) => observed<unknown>(read))
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
          const early = reads.map((read) => read.settled())
          expect(calls).toEqual([])
          expect(writer.settled()).toBe(false)
          expect(next.settled()).toBe(false)
          await within(fault.finish('commit'))
          finished = true
          expect(await within(writer.result)).toMatchObject({ ok: true })
          for (const read of reads) expect(await within(read.result)).toMatchObject({ ok: true })
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
              const joined = observed(resolve())
              await turn()
              expect(calls).toEqual([])
              expect(joined.settled()).toBe(false)
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
              expect(await within(joined.result)).toEqual({ ok: true, value: classified })
              expect(await within(resolve())).toBe(classified)
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
                async outbox() {
                  if (phase === 'effects') {
                    nested = observed(invoke())
                    await within(nested.result)
                  }
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
          const firstRead = observed(
            fixture.reopen().then((ports) => ports.device.groups.loadState(key)),
          )
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
