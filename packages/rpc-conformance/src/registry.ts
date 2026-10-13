import { describe, expect, test } from 'vitest'

import type { ConformanceWelcomeObligation } from './control-store.js'
import type {
  ConformanceRegistryFixture,
  ConformanceRegistryHandle,
  ConformanceRegistrySwitchWrite,
} from './registry-fixture.js'

type RegistryConformanceParams<THandle extends ConformanceRegistryHandle> = {
  name: string
  createFixture(options: {
    groupID: string
    setup: 'empty' | 'seeded'
  }): Promise<ConformanceRegistryFixture<THandle>>
}

function signal() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const caught = <TValue>(promise: Promise<TValue>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )
function switchWrite<THandle extends ConformanceRegistryHandle>(
  recovery: Awaited<ReturnType<ConformanceRegistryFixture<THandle>['confirmedRecovery']>>,
): ConformanceRegistrySwitchWrite {
  return {
    mutationID: crypto.randomUUID(),
    source: { rejoinID: recovery.record.id },
    destination: {
      control: {
        cursor: { position: recovery.proof.position, epoch: Number(recovery.candidate.epoch) },
      },
    },
  }
}

export function testRegistryConformance<THandle extends ConformanceRegistryHandle>(
  params: RegistryConformanceParams<THandle>,
): void {
  describe(`registry conformance: ${params.name}`, () => {
    const groupID = 'registry-contract'
    const key = { groupID, incarnation: 1 }
    const create = (setup: 'empty' | 'seeded' = 'seeded') =>
      params.createFixture({ groupID, setup })

    test('complete fixture reopen preserves committed access and starts cold', async () => {
      let fixture = await create()
      try {
        const before = (await fixture.registry.access(groupID)).runtime.snapshot()
        fixture = await fixture.reopen()
        expect(fixture.restoreCount(groupID)).toBe(0)
        expect((await fixture.registry.access(groupID)).runtime.snapshot()).toEqual(before)
      } finally {
        await fixture.close()
      }
    })

    test('cold access shares one restore and pure reads change no rows or runtime', async () => {
      const fixture = await create()
      try {
        await fixture.registry.start()
        const before = await fixture.inspectRows()
        const held = fixture.holdColdPublication(groupID)
        const first = fixture.registry.access(groupID)
        await held.started
        const second = fixture.registry.access(groupID)
        held.release()
        const [access, shared] = await Promise.all([first, second])
        expect(shared).toBe(access)
        expect(fixture.restoreCount(groupID)).toBe(1)
        let notifications = 0
        access.runtime.onEpochChanged(() => {
          notifications++
        })
        expect(await access.read((handle) => handle.credential.id)).toBe(fixture.identity.id)
        await access.readControl(async (scope) => {
          expect((await scope.refresh()).source).toEqual(scope.source)
        })
        expect(notifications).toBe(0)
        expect(await fixture.inspectRows()).toEqual(before)
      } finally {
        await fixture.close()
      }
    })

    test.each(['absent', 'state', 'trust', 'missing-bytes', 'metadata'] as const)(
      'unavailable %s exposes no handle or fabricated snapshot',
      async (fault) => {
        const fixture = await create(fault === 'absent' ? 'empty' : 'seeded')
        try {
          if (fault === 'state') await fixture.corruptState(key)
          if (fault === 'trust') await fixture.corruptTrust(groupID)
          if (fault === 'missing-bytes') await fixture.removeStateBytes(key)
          if (fault === 'metadata')
            await fixture.mutateMetadata(key, (value) => ({ ...(value as object), version: -1 }))
          await expect(fixture.registry.access(groupID)).rejects.toMatchObject({
            name: 'GroupUnavailableError',
          })
          if (fault === 'state' || fault === 'missing-bytes') {
            expect((await fixture.registry.recoverySource(groupID)).key).toEqual(key)
          }
        } finally {
          await fixture.close()
        }
      },
    )

    test('restorePending gates start, access, seed, switch and delete', async () => {
      const fixture = await create()
      try {
        const recovery = await fixture.confirmedRecovery(key, { confirm: true })
        const lifetime = await fixture.device.groups.load(groupID)
        if (lifetime === null) throw new Error('Missing lifetime')
        const mutationID = crypto.randomUUID()
        await fixture.device.groups.transition(
          { groupID, mutationID, expected: lifetime },
          async (stores) => {
            await stores.lifetime.save({
              ...lifetime,
              revision: lifetime.revision + 1,
              mutationID,
              restorePending: true,
            })
          },
        )
        const before = await fixture.inspectRows()
        const candidate = await fixture.makeHandle(2)
        const owner = fixture.registry
        for (const call of [
          () => owner.start(),
          () => owner.access(groupID),
          () =>
            owner.seed(candidate, {
              replace: true,
              packageUse: { sourceID: 'source', ref: 'ref', kind: 'ordinary' },
            }),
          () =>
            owner.switchIncarnation(recovery.candidate, {
              source: recovery.source,
              rejoinID: recovery.record.id,
              proof: recovery.proof,
              write: switchWrite(recovery),
            }),
          () => owner.delete(key),
        ])
          await expect(call()).rejects.toMatchObject({ reason: 'restore-pending' })
        expect(await fixture.inspectRows()).toEqual(before)
      } finally {
        await fixture.close()
      }
    })

    test.each(['retainKeysForGenerations', 'maximumForwardRatchetSteps'] as const)(
      'registry refuses %s below its required window',
      async (field) => {
        const fixture = await create('empty')
        try {
          Object.assign(fixture.environment.options, { keyRetention: { [field]: 999 } })
          expect(() => fixture.registry).toThrow('>= 1000')
          expect(fixture.restoreCount(groupID)).toBe(0)
        } finally {
          await fixture.close()
        }
      },
    )

    test.each(['missing', 'source', 'ref'] as const)(
      'non-genesis seed refuses %s package metadata before installing',
      async (fault) => {
        const fixture = await create('empty')
        try {
          const handle = await fixture.makeHandle(1)
          const before = await fixture.inspectRows()
          const packageUse =
            fault === 'missing'
              ? null
              : {
                  sourceID: fault === 'source' ? '' : 'source',
                  ref: fault === 'ref' ? '' : 'ref',
                  kind: 'ordinary' as const,
                }
          await expect(fixture.registry.seed(handle, { packageUse })).rejects.toMatchObject({
            name: 'SeedAdmissionRefusedError',
            reason: 'invalid-package-use',
          })
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )

    test('genesis requires absence and null package; all installations spend once', async () => {
      const fixture = await create('empty')
      try {
        const genesis = await fixture.makeHandle(0)
        await expect(
          fixture.registry.seed(genesis, {
            packageUse: { sourceID: 'source', ref: 'ref', kind: 'ordinary' },
          }),
        ).rejects.toMatchObject({ name: 'SeedAdmissionRefusedError', reason: 'invalid-genesis' })
        expect(await fixture.registry.seed(genesis, { packageUse: null })).toEqual(key)
        await expect(
          fixture.registry.seed(genesis, { packageUse: null, replace: true }),
        ).rejects.toMatchObject({ reason: 'spent' })
        await expect(
          fixture.registry.seed(await fixture.makeHandle(0), { packageUse: null, replace: true }),
        ).rejects.toMatchObject({ reason: 'invalid-genesis' })
        expect(
          (await fixture.device.groups.loadTrust(groupID))?.spentEpochAuthenticators,
        ).toHaveLength(1)
      } finally {
        await fixture.close()
      }
    })

    test.each(['ordinary', 'last-resort'] as const)(
      'Welcome admission and tombstone preserve %s spent identity',
      async (kind) => {
        const fixture = await create('empty')
        try {
          const history = await fixture.welcomeHistory(kind)
          const owner = fixture.registry
          await owner.seed(history.exact, { packageUse: history.packageUse })
          const access = await owner.access(groupID)
          for (const replace of [undefined, false])
            await expect(
              owner.seed(history.newer, { replace, packageUse: history.packageUse }),
            ).rejects.toMatchObject({ reason: 'replace-required' })
          expect(await access.read((handle) => Number(handle.epoch))).toBe(
            Number(history.exact.epoch),
          )
          expect(
            await owner.seed(history.newer, { replace: true, packageUse: history.packageUse }),
          ).toEqual({ groupID, incarnation: 2 })
          const rows = await fixture.inspectRows()
          expect(await owner.seed(history.unusedOlder, { packageUse: history.packageUse })).toEqual(
            { groupID, incarnation: 2 },
          )
          expect(await fixture.inspectRows()).toEqual(rows)
          for (const candidate of [history.exact, history.restored])
            await expect(
              owner.seed(candidate, { replace: true, packageUse: history.packageUse }),
            ).rejects.toMatchObject({ reason: 'spent' })
          expect(history.restored).not.toBe(history.exact)
          expect(await fixture.authenticator(history.restored)).toEqual(
            await fixture.authenticator(history.exact),
          )
          await expect(access.read(() => {})).rejects.toMatchObject({
            name: 'DisplacedGroupHandleError',
          })
          expect(access.runtime.snapshot()).toBeNull()
          await owner.delete({ groupID, incarnation: 2 })
          expect(await owner.seed(history.unusedOlder, { packageUse: history.packageUse })).toEqual(
            { groupID, incarnation: 3 },
          )
          expect(
            (await fixture.device.groups.loadTrust(groupID))?.spentEpochAuthenticators,
          ).toHaveLength(3)
        } finally {
          await fixture.close()
        }
      },
    )

    test('retirement hook refusal restores source and a competing loser cannot lift the winning hold', async () => {
      const fixture = await create('empty')
      const release = signal()
      try {
        const history = await fixture.welcomeHistory('ordinary')
        const owner = fixture.registry
        await owner.seed(history.exact, { packageUse: history.packageUse })
        const access = await owner.access(groupID)
        const entered = signal()
        const remove = access.onRetire(async () => {
          expect(await fixture.device.groups.load(groupID)).toMatchObject({ activeIncarnation: 1 })
          entered.release()
          await release.promise
          throw new Error('Host refused retirement')
        })
        const attempt = caught(
          owner.seed(history.newer, { replace: true, packageUse: history.packageUse }),
        )
        await entered.promise
        await expect(owner.delete(key)).rejects.toMatchObject({ name: 'RegistryRetiringError' })
        await expect(access.read(() => {})).rejects.toMatchObject({ name: 'RegistryRetiringError' })
        release.release()
        expect(await attempt).toMatchObject({ error: { name: 'RegistryRetireHookError' } })
        remove()
        expect(await access.read((handle) => Number(handle.epoch))).toBe(
          Number(history.exact.epoch),
        )
        expect(
          (await fixture.device.groups.loadTrust(groupID))?.spentEpochAuthenticators,
        ).toHaveLength(1)
      } finally {
        release.release()
        await fixture.close()
      }
    })

    test('concurrent mutate serialises current source and co-writes trust once per operation', async () => {
      const fixture = await create()
      try {
        const access = await fixture.registry.access(groupID)
        const epochs = await Promise.all(
          [1, 2].map(() =>
            access.mutate(async (handle, persist) => {
              const next = await fixture.advance(handle)
              await persist(next)
              await persist(next)
              return Number(next.epoch)
            }),
          ),
        )
        expect(epochs).toEqual([1, 2])
        expect(access.stateVersion()).toBe(3)
        expect((await fixture.device.groups.loadTrust(groupID))?.installed.epoch).toBe(2)
        expect(
          (await fixture.device.groups.loadTrust(groupID))?.spentEpochAuthenticators,
        ).toHaveLength(3)
      } finally {
        await fixture.close()
      }
    })

    test('mutate persists final staged prepare progress and never publishes a throwing callback', async () => {
      const fixture = await create()
      try {
        const access = await fixture.registry.access(groupID)
        let finalBytes: Uint8Array | undefined
        await access.mutate(async (handle, persist) => {
          await persist(handle)
          await fixture.advanceSender(handle)
          finalBytes = fixture.stateBytes(handle)
          await persist(handle)
          await fixture.advanceSender(handle)
        })
        const committed = await fixture.device.groups.loadState(key)
        expect(committed).toMatchObject({ senderHWM: 1 })
        expect(committed !== null && !committed.deleted && committed.state).toEqual(finalBytes)
        const before = await fixture.inspectRows()
        const snapshot = access.runtime.snapshot()
        await expect(
          access.mutate(async (handle, persist) => {
            await persist(await fixture.advance(handle))
            throw new Error('Prepare refused')
          }),
        ).rejects.toThrow('Prepare refused')
        expect(await fixture.inspectRows()).toEqual(before)
        expect(access.runtime.snapshot()).toEqual(snapshot)
      } finally {
        await fixture.close()
      }
    })

    test.each(['accepted', 'unresolved'] as const)(
      'mutate without accepted provenance cannot bypass an %s control slot',
      async (stage) => {
        const fixture = await create()
        try {
          const access = await fixture.registry.access(groupID)
          const accepted = await fixture.acceptedOrdinary(access, {
            accepted: stage === 'accepted',
          })
          if (stage === 'unresolved')
            await fixture.installRows({
              key,
              control: {
                controlHold: { reason: 'acceptance-unknown', position: null },
              },
            })
          const control = await fixture.device.groups.ports(key).control.load()
          expect(control.commitOnce).not.toBeNull()
          if (stage === 'unresolved') expect(control.commitOnceAcceptance).toBeNull()
          else expect(control.commitOnceAcceptance).not.toBeNull()
          const before = await fixture.inspectRows()
          await expect(
            access.mutate(async (_handle, persist) => {
              await persist(accepted.candidate)
            }),
          ).rejects.toMatchObject({ name: 'ControlAdoptionMovedError' })
          expect(await fixture.inspectRows()).toEqual(before)
          expect(access.epoch()).toBe(0)
        } finally {
          await fixture.close()
        }
      },
    )

    test('ordinary replace refuses candidates without accepted provenance', async () => {
      const fixture = await create()
      try {
        const access = await fixture.registry.access(groupID)
        const candidate = await fixture.advance(await access.read((handle) => handle))
        const before = await fixture.inspectRows()
        await expect(access.replace(candidate)).rejects.toMatchObject({
          name: 'RegistryRecoveryReplacementError',
        })
        expect(await fixture.inspectRows()).toEqual(before)
      } finally {
        await fixture.close()
      }
    })

    test('dispose refuses every later lifecycle operation without writes', async () => {
      const fixture = await create()
      try {
        const recovery = await fixture.confirmedRecovery(key, { confirm: true })
        const owner = fixture.registry
        const access = await owner.access(groupID)
        await owner.dispose()
        const before = await fixture.inspectRows()
        const candidate = await fixture.makeHandle(3)
        for (const call of [
          () => owner.access(groupID),
          () =>
            owner.seed(candidate, {
              replace: true,
              packageUse: { sourceID: 'source', ref: 'ref', kind: 'ordinary' },
            }),
          () =>
            owner.switchIncarnation(recovery.candidate, {
              source: recovery.source,
              rejoinID: recovery.record.id,
              proof: recovery.proof,
              write: switchWrite(recovery),
            }),
          () => owner.delete(key),
        ])
          await expect(call()).rejects.toMatchObject({ name: 'DisplacedGroupHandleError' })
        expect(access.runtime.snapshot()).toBeNull()
        expect(await fixture.inspectRows()).toEqual(before)
      } finally {
        await fixture.close()
      }
    })

    test.each(['adopt', 'replace'] as const)(
      'ordinary %s requires the accepted candidate and replay never reinstalls',
      async (method) => {
        const fixture = await create()
        try {
          const access = await fixture.registry.access(groupID)
          const accepted = await fixture.acceptedOrdinary(access)
          const before = await fixture.inspectRows()
          if (method === 'adopt')
            expect(await access.adopt(accepted.alternate, accepted.expected, accepted.write)).toBe(
              'moved',
            )
          else
            await expect(
              access.replace(accepted.alternate, () => accepted.write),
            ).rejects.toMatchObject({ name: 'ControlAdoptionMovedError' })
          expect(await fixture.inspectRows()).toEqual(before)
          if (method === 'adopt')
            expect(await access.adopt(accepted.candidate, accepted.expected, accepted.write)).toBe(
              'installed',
            )
          else await access.replace(accepted.candidate, () => accepted.write)
          const installed = await fixture.inspectRows()
          if (method === 'adopt')
            expect(await access.adopt(accepted.candidate, accepted.expected, accepted.write)).toBe(
              'noop',
            )
          else await access.replace(accepted.candidate, () => accepted.write)
          expect(await fixture.inspectRows()).toEqual(installed)
          expect(access.epoch()).toBe(1)
        } finally {
          await fixture.close()
        }
      },
    )

    test.each([
      'key',
      'version',
      'identity',
      'revision',
      'unconfirmed',
      'spent',
      'cursor',
      'verdict',
    ] as const)('switch refuses %s without writes and preserves the source', async (fault) => {
      const fixture = await create()
      try {
        const recovery = await fixture.confirmedRecovery(key, { confirm: true })
        const owner = fixture.registry
        const access = await owner.access(groupID)
        const source = await owner.recoverySource(groupID)
        const write = switchWrite(recovery)
        let proof = recovery.proof
        if (fault === 'key') source.key.incarnation++
        if (fault === 'version') source.stateVersion++
        if (fault === 'identity' && source.identity !== null) source.identity.authenticator.fill(0)
        if (fault === 'revision') source.lifetimeRevision--
        if (fault === 'unconfirmed')
          await fixture.installRows({
            key,
            control: { putRejoin: { ...recovery.record, stage: 'published' } },
          })
        if (fault === 'spent') {
          const trust = await fixture.device.groups.loadTrust(groupID)
          if (trust === null) throw new Error('Missing trust')
          trust.spentEpochAuthenticators.push(await fixture.authenticator(recovery.candidate))
          await fixture.installRows({ key, trust })
        }
        if (fault === 'cursor') write.destination.control.cursor.position = 'wrong-position'
        if (fault === 'verdict') proof = { ...proof, verdict: new Uint8Array([0]) }
        const before = await fixture.inspectRows()
        await expect(
          owner.switchIncarnation(recovery.candidate, {
            source,
            rejoinID: recovery.record.id,
            proof,
            write,
          }),
        ).rejects.toThrow()
        expect(await fixture.inspectRows()).toEqual(before)
        expect(await access.read((handle) => handle.groupID)).toBe(groupID)
      } finally {
        await fixture.close()
      }
    })

    test('switch work rechecks metadata even when lifetime and state bytes are unchanged', async () => {
      const fixture = await create()
      try {
        const recovery = await fixture.confirmedRecovery(key, { confirm: true })
        const owner = fixture.registry
        const source = await owner.recoverySource(groupID)
        const lifetime = await fixture.device.groups.load(groupID)
        const state = await fixture.device.groups.loadState(key)
        const trust = await fixture.device.groups.loadTrust(groupID)
        const control = await fixture.device.groups.ports(key).control.load()
        let workReached = false
        fixture.onPhase('work', async () => {
          workReached = true
          await fixture.mutateMetadata(key, (value) => ({
            ...(value as object),
            version: source.stateVersion + 1,
          }))
        })
        const outcome = await caught(
          owner.switchIncarnation(recovery.candidate, {
            source,
            rejoinID: recovery.record.id,
            proof: recovery.proof,
            write: switchWrite(recovery),
          }),
        )
        expect(workReached).toBe(true)
        expect(outcome).toMatchObject({ error: { name: 'GroupStateConflictError' } })
        expect(await fixture.device.groups.load(groupID)).toEqual(lifetime)
        expect(await fixture.device.groups.loadState(key)).toEqual(state)
        expect(await fixture.device.groups.loadTrust(groupID)).toEqual(trust)
        expect(await fixture.device.groups.ports(key).control.load()).toEqual(control)
        expect(await fixture.device.groups.loadState({ groupID, incarnation: 2 })).toBeNull()
      } finally {
        await fixture.close()
      }
    })

    test('delete refuses owed control, then tombstones and permanently displaces', async () => {
      const fixture = await create()
      try {
        const owner = fixture.registry
        const access = await owner.access(groupID)
        await fixture.installRows({
          key,
          control: { putOutcomes: [{ id: 'owed', opID: null, at: 1, kind: 'unknown' }] },
        })
        const before = await fixture.inspectRows()
        await expect(owner.delete(key)).rejects.toMatchObject({
          name: 'GroupControlUnsettledError',
        })
        expect(await fixture.inspectRows()).toEqual(before)
        expect(await owner.access(groupID)).toBe(access)
        await fixture.device.groups
          .ports(key)
          .control.apply({ deleteOutcomes: ['owed'] }, 'ack-control')
        await owner.delete(key)
        expect(await fixture.device.groups.loadState(key)).toMatchObject({ deleted: true })
        expect(access.runtime.snapshot()).toBeNull()
        await expect(access.read(() => {})).rejects.toMatchObject({
          name: 'DisplacedGroupHandleError',
        })
        await expect(owner.access(groupID)).rejects.toMatchObject({ name: 'GroupUnavailableError' })
      } finally {
        await fixture.close()
      }
    })

    test('snapshots are defensive and listeners run FIFO outside ownership despite failures', async () => {
      const fixture = await create()
      const delayed = signal()
      try {
        const access = await fixture.registry.access(groupID)
        const snapshot = access.runtime.snapshot()
        if (snapshot === null) throw new Error('Missing snapshot')
        snapshot.authenticator.fill(0)
        ;(snapshot.members as Set<string>).clear()
        expect(access.runtime.snapshot()?.members.has(fixture.identity.id)).toBe(true)
        expect(access.runtime.snapshot()?.authenticator).not.toEqual(snapshot.authenticator)
        const order: Array<number> = []
        const reads: Array<Promise<unknown>> = []
        access.runtime.onEpochChanged((value) => {
          order.push(value?.stateVersion ?? -1)
          reads.push(fixture.device.groups.load(groupID))
          return delayed.promise
        })
        access.runtime.onEpochChanged(() => {
          throw new Error('Listener refused')
        })
        await fixture.device.groups.ports(key).cursor.save('fifo', '1')
        await fixture.device.groups.ports(key).cursor.save('fifo', '2')
        expect(order).toEqual([2, 3])
        expect((await Promise.all(reads)).every((value) => value !== null)).toBe(true)
      } finally {
        delayed.release()
        await fixture.close()
      }
    })
  })
}

export function testRegistryCrashConformance<THandle extends ConformanceRegistryHandle>(
  params: RegistryConformanceParams<THandle>,
): void {
  describe(`registry crash conformance: ${params.name}`, () => {
    const groupID = 'registry-crash-contract'
    const key = { groupID, incarnation: 1 }
    const destination = { groupID, incarnation: 2 }
    const create = (setup: 'empty' | 'seeded' = 'empty') => params.createFixture({ groupID, setup })

    test('seed committed before reopen retains marker proof and refuses fresh spent seed', async () => {
      let fixture = await create()
      try {
        const history = await fixture.welcomeHistory('ordinary')
        const fault = fixture.armNextWorkFault('commit-then-reject')
        expect(
          await fixture.registry.seed(history.exact, { packageUse: history.packageUse }),
        ).toEqual(key)
        const mutationID = await fault.mutationID
        fixture = await fixture.reopen()
        expect((await fixture.registry.access(groupID)).key).toEqual(key)
        expect(await fixture.device.groups.resolve(groupID, mutationID)).toBe('committed')
        await expect(
          fixture.registry.seed(history.restored, {
            replace: true,
            packageUse: history.packageUse,
          }),
        ).rejects.toMatchObject({ name: 'SeedAdmissionRefusedError', reason: 'spent' })
      } finally {
        await fixture.close()
      }
    })

    test('superseded seed resolve is uncertain while access and spent admission remain correct', async () => {
      let fixture = await create()
      try {
        const history = await fixture.welcomeHistory('ordinary')
        const fault = fixture.armNextWorkFault('commit-then-reject')
        await fixture.registry.seed(history.exact, { packageUse: history.packageUse })
        const mutationID = await fault.mutationID
        await fixture.device.groups
          .ports(key)
          .control.apply({ deleteOutcomes: [] }, 'later-control')
        fixture = await fixture.reopen()
        await expect(fixture.device.groups.resolve(groupID, mutationID)).rejects.toMatchObject({
          name: 'GroupStateUncertainError',
        })
        expect((await fixture.registry.access(groupID)).key).toEqual(key)
        await expect(
          fixture.registry.seed(history.exact, { replace: true, packageUse: history.packageUse }),
        ).rejects.toMatchObject({ reason: 'spent' })
      } finally {
        await fixture.close()
      }
    })

    for (const kind of ['ordinary', 'last-resort'] as const) {
      test.each(['commit', 'rollback'] as const)(
        `pending switch %s reopens spent Welcome identities (${kind})`,
        async (outcome) => {
          let fixture = await create()
          let finished = false
          let fault:
            | { rejected: Promise<void>; finish(outcome: 'commit' | 'rollback'): Promise<void> }
            | undefined
          try {
            const history = await fixture.welcomeHistory(kind)
            const owner = fixture.registry
            await owner.seed(history.exact, { packageUse: history.packageUse })
            const sourceAccess = await owner.access(groupID)
            await sourceAccess.mutate(async (handle, persist) => {
              await persist(await fixture.advance(handle))
            })
            const advancedAuthenticator = await sourceAccess.read((handle) =>
              fixture.authenticator(handle),
            )
            const recovery = await fixture.confirmedRecovery(key, { confirm: true })
            const source = await owner.recoverySource(groupID)
            const write = switchWrite(recovery)
            const snapshot = sourceAccess.runtime.snapshot()
            let notifications = 0
            sourceAccess.runtime.onEpochChanged(() => {
              notifications++
            })
            const pending = fixture.armWorkFault(write.mutationID, 'pending')
            fault = pending
            const operation = caught(
              owner.switchIncarnation(recovery.candidate, {
                source,
                rejoinID: recovery.record.id,
                proof: recovery.proof,
                write,
              }),
            )
            await pending.rejected
            await expect(sourceAccess.read(() => {})).rejects.toMatchObject({
              name: 'RegistryRetiringError',
            })
            expect(sourceAccess.runtime.snapshot()).toEqual(snapshot)
            expect(notifications).toBe(0)
            const other = await fixture.makeHandle(0, `${groupID}-B`)
            expect(await owner.seed(other, { packageUse: null })).toEqual({
              groupID: other.groupID,
              incarnation: 1,
            })
            await pending.finish(outcome)
            finished = true
            if (outcome === 'commit') expect(await operation).toEqual({ value: destination })
            else expect(await operation).toHaveProperty('error')
            if (outcome === 'rollback') {
              expect(await fixture.device.groups.loadState(destination)).toBeNull()
              expect(await sourceAccess.read((handle) => fixture.authenticator(handle))).toEqual(
                advancedAuthenticator,
              )
            }
            const spentBefore = source.trust.spentEpochAuthenticators
            fixture = await fixture.reopen()
            const trust = await fixture.device.groups.loadTrust(groupID)
            if (outcome === 'commit') {
              expect(await fixture.device.groups.loadState(key)).toMatchObject({ deleted: true })
              expect(await fixture.device.groups.loadState(destination)).toMatchObject({
                version: 1,
                senderHWM: 0,
                state: fixture.stateBytes(recovery.candidate),
              })
              const ports = fixture.device.groups.ports(destination)
              expect(await ports.control.load()).toMatchObject({
                operations: [],
                outcomes: [],
                welcomes: [],
                applied: [],
                responses: [],
                rejoin: null,
                cursor: {
                  position: recovery.proof.position,
                  epoch: Number(recovery.candidate.epoch),
                },
              })
              expect(await ports.outbox.list()).toEqual([])
              expect(await ports.cursor.load('old-app-topic')).toBeNull()
              expect(await ports.anchor.load()).toMatchObject({
                anchor: { epoch: Number(recovery.candidate.epoch) },
              })
            }
            expect(trust?.spentEpochAuthenticators).toHaveLength(
              spentBefore.length + (outcome === 'commit' ? 1 : 0),
            )
            if (outcome === 'rollback') expect(trust?.spentEpochAuthenticators).toEqual(spentBefore)
            for (const candidate of [history.exact, history.restored])
              await expect(
                fixture.registry.seed(candidate, { replace: true, packageUse: history.packageUse }),
              ).rejects.toMatchObject({ name: 'SeedAdmissionRefusedError', reason: 'spent' })
            expect((await fixture.registry.access(groupID)).key).toEqual(
              outcome === 'commit' ? destination : key,
            )
          } finally {
            if (!finished && fault !== undefined) await fault.finish('rollback')
            await fixture.close()
          }
        },
      )
    }

    test('adopted switch replay survives marker supersession and preserves missing-token continuation', async () => {
      let fixture = await create('seeded')
      try {
        const recovery = await fixture.confirmedRecovery(key, {
          confirm: true,
          missingLedger: true,
        })
        expect(
          recovery.record.ledgerBefore.some(
            (token) => !recovery.candidate.ledgerTokens.includes(token),
          ),
        ).toBe(true)
        const source = await fixture.registry.recoverySource(groupID)
        const write = switchWrite(recovery)
        const switchParams = { source, rejoinID: recovery.record.id, proof: recovery.proof, write }
        expect(await fixture.registry.switchIncarnation(recovery.candidate, switchParams)).toEqual(
          destination,
        )
        await fixture.device.groups
          .ports(destination)
          .control.apply({ deleteOutcomes: [] }, 'later-control')
        fixture = await fixture.reopen()
        const access = await fixture.registry.access(groupID)
        let hooks = 0
        access.onRetire(async () => {
          hooks++
        })
        const before = await fixture.inspectRows()
        const count = fixture.restoreCount(groupID)
        expect(await fixture.registry.switchIncarnation(recovery.candidate, switchParams)).toEqual(
          destination,
        )
        expect(hooks).toBe(0)
        expect(fixture.restoreCount(groupID)).toBe(count)
        expect(await fixture.inspectRows()).toEqual(before)
        expect((await fixture.device.groups.ports(key).control.load()).rejoin).toEqual({
          ...recovery.record,
          stage: 'adopted',
        })
        await expect(fixture.registry.delete(destination)).rejects.toMatchObject({
          name: 'GroupControlUnsettledError',
        })
      } finally {
        await fixture.close()
      }
    })

    test('retirement events replay with stable IDs and data until individual acknowledgement', async () => {
      let fixture = await create()
      try {
        const history = await fixture.welcomeHistory('ordinary')
        await fixture.registry.seed(history.exact, { packageUse: history.packageUse })
        const entries = [1, 2, 3].map((seq) => ({
          seq,
          protocol: 'chat',
          prc: 'post',
          data: new Uint8Array([seq]),
          status: 'accepted' as const,
          lastAttempt:
            seq === 2
              ? {
                  incarnation: 1,
                  epoch: Number(history.exact.epoch),
                  floor: null,
                  attempts: 1,
                  publishID: 'unproven-attempt',
                  segment: 1,
                  topicID: 'old-topic',
                }
              : null,
        }))
        const settlement = {
          sequenceID: 'published-position',
          attemptID: 'certified-attempt',
          topicID: 'old-topic',
          outcome: 'published' as const,
        }
        await fixture.installRows({
          key,
          outbox: entries,
          settlements: [{ seq: 3, value: settlement }],
        })
        await fixture.registry.seed(history.newer, {
          replace: true,
          packageUse: history.packageUse,
        })
        const events = await fixture.device.groups.ports(key).outbox.events()
        expect(events).toHaveLength(2)
        expect(events).toMatchObject([
          { reason: 'incarnation-abandoned', nextIncarnation: 2 },
          { reason: 'incarnation-abandoned', nextIncarnation: 2 },
        ])
        fixture = await fixture.reopen()
        expect(fixture.restoreCount(groupID)).toBe(0)
        const ports = fixture.device.groups.ports(key)
        expect(await ports.outbox.events()).toEqual(events)
        expect(await ports.outbox.list()).toEqual(entries.slice(2))
        const event = events[0]
        if (event === undefined) throw new Error('Missing retirement event')
        await ports.outbox.ackEvent(event.id)
        fixture = await fixture.reopen()
        expect(await fixture.device.groups.ports(key).outbox.events()).toEqual(events.slice(1))
        expect(fixture.restoreCount(groupID)).toBe(0)
      } finally {
        await fixture.close()
      }
    })

    test('Welcome acceptance before obligation deletion crash repeats exact bytes after reopen', async () => {
      let fixture = await create()
      try {
        const history = await fixture.welcomeHistory('ordinary')
        await fixture.registry.seed(history.exact, { packageUse: history.packageUse })
        const welcome: ConformanceWelcomeObligation = {
          opID: 'owed-welcome',
          welcome: new Uint8Array([7, 8, 9]),
          recipients: ['recipient'],
          committed: true,
        }
        await fixture.installRows({ key, control: { putWelcomes: [welcome] } })
        await fixture.registry.seed(history.newer, {
          replace: true,
          packageUse: history.packageUse,
        })
        const delivered: Array<typeof welcome> = []
        fixture.armNextWorkFault('before-commit')
        const first = await fixture.serveRetiredWelcomes(key, async (value) => {
          delivered.push(value)
        })
        expect(first.remaining).toEqual([welcome.opID])
        expect(first.failures).toHaveLength(1)
        fixture = await fixture.reopen()
        const second = await fixture.serveRetiredWelcomes(key, async (value) => {
          delivered.push(value)
        })
        expect(second.remaining).toEqual([])
        expect(second.failures).toEqual([])
        expect(delivered).toEqual([welcome, welcome])
        expect(fixture.restoreCount(groupID)).toBe(0)
      } finally {
        await fixture.close()
      }
    })

    test('initially absent seed waits earlier pending work while unrelated group proceeds', async () => {
      const fixture = await create()
      await fixture.registry.start()
      const genesis = await fixture.makeHandle(0)
      const pending = fixture.armNextWorkFault('pending')
      let finished = false
      try {
        const earlier = caught(fixture.registry.seed(genesis, { packageUse: null }))
        await pending.rejected
        let published = false
        const seed = caught(
          fixture.registry.seed(genesis, { packageUse: null }).then((value) => {
            published = true
            return value
          }),
        )
        await turn()
        expect(published).toBe(false)
        await fixture.registry.seed(await fixture.makeHandle(0, `${groupID}-B`), {
          packageUse: null,
        })
        await pending.finish('rollback')
        finished = true
        expect(await earlier).toHaveProperty('error')
        expect(await seed).toEqual({ value: key })
      } finally {
        if (!finished) await pending.finish('rollback')
        await fixture.close()
      }
    })

    for (const action of ['seed', 'switch', 'delete'] as const) {
      test.each(['completion', 'proof'] as const)(
        `${action} waits unfinished %s without publication or late writes`,
        async (boundary) => {
          const fixture = await create('seeded')
          let finished = false
          let pending:
            | { rejected: Promise<void>; finish(outcome: 'commit' | 'rollback'): Promise<void> }
            | undefined
          let proof: { started: Promise<void>; release(): void } | undefined
          try {
            const recovery = await fixture.confirmedRecovery(key, { confirm: true })
            if (action === 'delete')
              await fixture.device.groups
                .ports(key)
                .control.apply({ deleteRejoin: true }, 'clear-rejoin-before-completion')
            const candidate = await fixture.makeHandle(3)
            const owner = fixture.registry
            const access = await owner.access(groupID)
            const snapshot = access.runtime.snapshot()
            pending = fixture.armWorkFault('earlier-completion', 'pending')
            proof = boundary === 'proof' ? fixture.holdProof('earlier-completion') : undefined
            const earlier = caught(
              fixture.device.groups
                .ports(key)
                .control.apply({ deleteOutcomes: [] }, 'earlier-completion'),
            )
            await pending.rejected
            if (proof !== undefined) await proof.started
            let done = false
            const operation = caught(
              (action === 'seed'
                ? owner.seed(candidate, {
                    replace: true,
                    packageUse: { sourceID: 'source', ref: 'ref', kind: 'ordinary' },
                  })
                : action === 'switch'
                  ? owner.switchIncarnation(recovery.candidate, {
                      source: recovery.source,
                      rejoinID: recovery.record.id,
                      proof: recovery.proof,
                      write: switchWrite(recovery),
                    })
                  : owner.delete(key)
              ).then((value) => {
                done = true
                return value
              }),
            )
            await turn()
            expect(done).toBe(false)
            expect(access.runtime.snapshot()).toEqual(snapshot)
            await owner.seed(await fixture.makeHandle(0, `${groupID}-B`), { packageUse: null })
            expect(done).toBe(false)
            if (boundary === 'proof') {
              await pending.finish('commit')
              finished = true
              await turn()
              expect(done).toBe(false)
              proof?.release()
            } else {
              await pending.finish('rollback')
              finished = true
            }
            await earlier
            const result = await operation
            if (action === 'seed') expect(result).toEqual({ value: destination })
            else if (action === 'delete') expect(result).toEqual({ value: undefined })
            else if (action === 'switch' && boundary === 'completion')
              expect(result).toEqual({ value: destination })
            else expect(result).toHaveProperty('error')
            const rows = await fixture.inspectRows()
            await turn()
            expect(await fixture.inspectRows()).toEqual(rows)
            if (action === 'seed') expect(done).toBe(true)
          } finally {
            proof?.release()
            if (!finished) await pending?.finish('rollback')
            await fixture.close()
          }
        },
      )
    }

    test.each(['seed', 'switch'] as const)(
      'dispose awaits in-flight %s settlement and permits no late writes',
      async (action) => {
        const fixture = await create('seeded')
        const release = signal()
        let operation: ReturnType<typeof caught<unknown>> | undefined
        let disposal: ReturnType<typeof caught<void>> | undefined
        try {
          const recovery = await fixture.confirmedRecovery(key, { confirm: true })
          const owner = fixture.registry
          const access = await owner.access(groupID)
          const entered = signal()
          access.onRetire(async () => {
            entered.release()
            await release.promise
          })
          const candidate = await fixture.makeHandle(3)
          operation = caught<unknown>(
            action === 'seed'
              ? owner.seed(candidate, {
                  replace: true,
                  packageUse: { sourceID: 'source', ref: 'ref', kind: 'ordinary' },
                })
              : owner.switchIncarnation(recovery.candidate, {
                  source: recovery.source,
                  rejoinID: recovery.record.id,
                  proof: recovery.proof,
                  write: switchWrite(recovery),
                }),
          )
          await entered.promise
          let disposed = false
          disposal = caught(
            owner.dispose().then(() => {
              disposed = true
            }),
          )
          await turn()
          expect(disposed).toBe(false)
          release.release()
          await operation
          expect(await disposal).toEqual({ value: undefined })
          const before = await fixture.inspectRows()
          await turn()
          expect(await fixture.inspectRows()).toEqual(before)
          expect(access.runtime.snapshot()).toBeNull()
        } finally {
          release.release()
          await operation
          await disposal
          await fixture.close()
        }
      },
    )

    for (const action of ['seed', 'switch', 'delete'] as const) {
      test.each(['commit', 'rollback', 'refusal'] as const)(
        `cold restore versus ${action} ${'%s'} discards stale loads and preserves the winning hold`,
        async (outcome) => {
          const fixture = await create('seeded')
          let held: ReturnType<typeof fixture.holdColdPublication> | undefined
          let restoring: ReturnType<typeof fixture.holdRestore> | undefined
          let pending:
            | { rejected: Promise<void>; finish(outcome: 'commit' | 'rollback'): Promise<void> }
            | undefined
          let finished = false
          try {
            const recovery = await fixture.confirmedRecovery(key, { confirm: true })
            if (action === 'delete')
              await fixture.device.groups
                .ports(key)
                .control.apply({ deleteRejoin: true }, 'clear-rejoin')
            const candidate = await fixture.makeHandle(3)
            const owner = fixture.registry
            await owner.start()
            held =
              action === 'delete'
                ? fixture.holdRestore(groupID)
                : fixture.holdColdPublication(groupID)
            if (action !== 'delete') restoring = fixture.holdRestore(groupID)
            let returned = false
            const opening = caught(
              owner.access(groupID).then((value) => {
                returned = true
                return value
              }),
            )
            await (restoring ?? held).started
            if (outcome === 'refusal') fixture.armNextWorkFault('before-commit')
            const write = switchWrite(recovery)
            if (outcome !== 'refusal') pending = fixture.armNextWorkFault('pending')
            const operation = caught<unknown>(
              action === 'seed'
                ? owner.seed(candidate, {
                    replace: true,
                    packageUse: { sourceID: 'source', ref: 'ref', kind: 'ordinary' },
                  })
                : action === 'switch'
                  ? owner.switchIncarnation(recovery.candidate, {
                      source: recovery.source,
                      rejoinID: recovery.record.id,
                      proof: recovery.proof,
                      write,
                    })
                  : owner.delete(key),
            )
            // Admission queues behind restore; hold its returned result before publication.
            await turn()
            if (restoring !== undefined) {
              restoring.release()
              await held.started
            } else held.release()
            if (pending !== undefined) {
              await pending.rejected
              expect(returned).toBe(false)
              await expect(owner.access(groupID)).rejects.toMatchObject({
                name: 'RegistryRetiringError',
              })
              await expect(owner.delete(key)).rejects.toMatchObject({
                name: 'RegistryRetiringError',
              })
              await expect(owner.access(groupID)).rejects.toMatchObject({
                name: 'RegistryRetiringError',
              })
              await pending.finish(outcome === 'commit' ? 'commit' : 'rollback')
              finished = true
            }
            await operation
            held.release()
            const old = await opening
            if (outcome === 'commit' && action === 'delete') expect(old).toHaveProperty('error')
            else if ('value' in old)
              expect(old.value.key).toEqual(outcome === 'commit' ? destination : key)
            const result = await operation
            if (outcome === 'commit') {
              expect(result).toHaveProperty('value')
              if (action === 'delete')
                await expect(owner.access(groupID)).rejects.toMatchObject({ reason: 'deleted' })
              else expect((await owner.access(groupID)).key).toEqual(destination)
            } else {
              expect(result).toHaveProperty('error')
              const access = await owner.access(groupID)
              expect(access.key).toEqual(key)
              expect(access.runtime.snapshot()?.available).toBe(true)
              expect(fixture.restoreCount(groupID)).toBeGreaterThan(1)
            }
          } finally {
            restoring?.release()
            held?.release()
            if (!finished && pending !== undefined) await pending.finish('rollback')
            await fixture.close()
          }
        },
      )
    }
  })
}
