import { randomIdentity } from '@kokuin/token'
import { createGroup, encodeClientState, GroupHandle } from '@kumiai/mls'
import { describe, expect, test, vi } from 'vitest'

import { coordinatorBinding } from '../src/entry-capability.js'
import { createGroupHandleRegistry, GroupUnavailableError } from '../src/index.js'
import { createMemoryDevicePersistence } from '../src/memory-device-persistence.js'
import { createOwnerQueues } from '../src/owner-queue.js'
import type { GroupKey, GroupStateRecord } from '../src/persistence-types.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { createMemoryTransaction } from '../src/testing.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
import {
  createRegistryFixture,
  type RegistryFixtureBase,
  registryFixtureRestore,
} from './fixtures/registry.js'

function registry(fixture: RegistryFixtureBase) {
  return createGroupHandleRegistry({
    persistence: fixture.device,
    providerID: fixture.device.providerID,
    recovery: fixture.environment,
    restore: registryFixtureRestore(fixture),
    restoreCandidate: async () => {
      throw new Error('Cold access must not restore a candidate')
    },
  })
}
async function recordFor(fixture: RegistryFixtureBase, key: GroupKey) {
  const record = await fixture.device.groups.loadState(key)
  if (record === null || record.deleted || record.state === null) throw new Error('Missing state')
  return { ...record, state: record.state }
}
async function installNext(fixture: RegistryFixtureBase, key: GroupKey) {
  const record = await recordFor(fixture, key)
  const handle = await fixture.advance(await registryFixtureRestore(fixture)(record))
  await fixture.installRows({
    key,
    state: {
      ...record,
      version: record.version + 1,
      epoch: Number(handle.epoch),
      epochAuthenticator: handle.state.keySchedule.epochAuthenticator,
      state: encodeClientState(handle.state),
    },
    trust: recoveryTrustFor(handle, key, await fixture.device.groups.loadTrust(key.groupID)),
  })
  return handle
}

for (const mode of ['real-mls', 'double'] as const) {
  describe(`registry cold access (${mode})`, () => {
    const groupID = `registry-cold-${mode}`
    const key = { groupID, incarnation: 1 }
    const create = (setup: 'empty' | 'seeded' = 'seeded') =>
      createRegistryFixture({ mode, groupID, setup })

    test('concurrent cold access shares validation', async () => {
      const fixture = await create()
      try {
        const owner = registry(fixture)
        const held = fixture.holdRestore(groupID)
        const first = owner.access(groupID)
        const second = owner.access(groupID)
        await held.started
        expect(fixture.restoreCount(groupID)).toBe(1)
        held.release()
        const [a, b] = await Promise.all([first, second])
        expect(a).toBe(b)
        expect(a.runtime.snapshot()).toMatchObject({
          ...key,
          epoch: 0,
          stateVersion: 1,
          available: true,
        })
        expect(a.runtime.snapshot()?.members).toEqual(new Set([fixture.identity.id]))
        expect(await a.read((handle) => handle.groupID)).toBe(groupID)
      } finally {
        await fixture.close()
      }
    })

    test('key and runtime values are defensive', async () => {
      const fixture = await create()
      try {
        const access = await registry(fixture).access(groupID)
        access.key.groupID = 'foreign'
        access.key.incarnation = 99
        const snapshot = access.runtime.snapshot()
        if (snapshot === null) throw new Error('Missing runtime')
        snapshot.authenticator.fill(0)
        ;(snapshot.members as Set<string>).clear()
        snapshot.groupID = 'foreign'
        expect(access.key).toEqual(key)
        expect(await access.read((handle) => handle.groupID)).toBe(groupID)
        expect(access.runtime.snapshot()?.members).toEqual(new Set([fixture.identity.id]))
        expect(access.runtime.snapshot()?.authenticator.some((byte) => byte !== 0)).toBe(true)
      } finally {
        await fixture.close()
      }
    })

    test.each([
      'absent',
      'deleted',
      'null',
      'null-bytes',
      'corrupt',
      'malformed',
      'missing-metadata',
      'missing-trust',
    ] as const)('cold %s refuses with a typed reason', async (kind) => {
      const fixture = await create(kind === 'absent' ? 'empty' : 'seeded')
      try {
        const owner = registry(fixture)
        if (kind === 'deleted') {
          const lifetime = await fixture.device.groups.load(groupID)
          if (lifetime === null) throw new Error('Missing lifetime')
          await fixture.device.groups.transition(
            { groupID, mutationID: 'delete-cold', expected: lifetime },
            async (stores) => {
              await stores.incarnation(1).state.save({ ...key, version: 2, deleted: true })
              await stores.lifetime.save({
                ...lifetime,
                revision: lifetime.revision + 1,
                mutationID: 'delete-cold',
                activeIncarnation: null,
              })
            },
          )
        }
        if (kind === 'null') await fixture.removeStateBytes(key)
        if (kind === 'null-bytes') {
          const record = await recordFor(fixture, key)
          await fixture.installRows({
            key,
            state: { ...record, version: record.version + 1, state: null },
          })
        }
        if (kind === 'corrupt') await fixture.corruptState(key)
        if (kind === 'malformed')
          await fixture.mutateMetadata(key, (value) => ({ ...(value as object), version: -1 }))
        if (kind === 'missing-metadata') await fixture.mutateMetadata(key, () => null)
        if (kind === 'missing-trust') await fixture.corruptTrust(groupID)
        const reason =
          kind === 'null' || kind === 'null-bytes' || kind === 'corrupt'
            ? 'state-unreadable'
            : kind === 'absent' || kind === 'deleted'
              ? kind
              : 'invalid'
        await expect(owner.access(groupID)).rejects.toBeInstanceOf(GroupUnavailableError)
        await expect(owner.access(groupID)).rejects.toMatchObject({ reason })
        expect(fixture.restoreCount(groupID)).toBe(0)
      } finally {
        await fixture.close()
      }
    })

    test('invalid cold restore is never cached', async () => {
      const fixture = await create()
      try {
        const good = await recordFor(fixture, key)
        fixture.overrideRestore(
          async () =>
            (await createGroup(randomIdentity(), groupID, fixture.environment.options)).group,
        )
        const owner = registry(fixture)
        await expect(owner.access(groupID)).rejects.toMatchObject({ reason: 'invalid' })
        // Restore the actual original state, not a newly created group's authenticator.
        fixture.overrideRestore(async () => {
          const { decodeClientState, restoreGroup } = await import('@kumiai/mls')
          const state = decodeClientState(good.state)
          if (state === undefined) throw new Error('Missing decoded state')
          return restoreGroup({
            state,
            credential: good.credential,
            ledgerEntries: good.ledger,
            options: fixture.environment.options,
          })
        })
        const access = await owner.access(groupID)
        expect(await access.read((handle) => handle.credential.id)).toBe(fixture.identity.id)
        expect(fixture.restoreCount(groupID)).toBe(3)
      } finally {
        await fixture.close()
      }
    })

    test('cold identity uses current trust instead of initial metadata', async () => {
      const fixture = await create()
      try {
        await installNext(fixture, key)
        await installNext(fixture, key)
        await installNext(fixture, key)
        const atThree = await recordFor(fixture, key)
        const initial = await import('../src/entry-capability.js').then(({ entryCapability }) =>
          entryCapability(fixture.device.groups)?.read(groupID, (reads) => reads.metadata(1)),
        )
        await fixture.mutateMetadata(key, (value) => ({
          ...(value as object),
          initialIdentity: {
            ...key,
            epoch: 3,
            authenticator: atThree.epochAuthenticator,
          },
        }))
        expect(initial?.initialIdentity?.epoch).toBe(0)
        const fourth = await installNext(fixture, key)
        const access = await registry(fixture).access(groupID)
        expect(access.runtime.snapshot()).toMatchObject({
          epoch: 4,
          authenticator: fourth.state.keySchedule.epochAuthenticator,
          stateVersion: 5,
        })
        await access.readControl(async (scope) => {
          expect(scope.source.identity).toMatchObject({
            epoch: 4,
            authenticator: fourth.state.keySchedule.epochAuthenticator,
          })
        })
      } finally {
        await fixture.close()
      }
    })

    test.each(['owner', 'anchor', 'suite', 'options'] as const)(
      'foreign %s restore refuses',
      async (kind) => {
        const fixture = await create()
        try {
          const record = await recordFor(fixture, key)
          const original = await registryFixtureRestore(fixture)(record)
          const foreign = (
            await createGroup(randomIdentity(), groupID, fixture.environment.options)
          ).group
          const state = structuredClone(original.state)
          if (kind === 'anchor')
            state.groupContext.extensions = foreign.state.groupContext.extensions
          const handle = new GroupHandle({
            state,
            credential: kind === 'owner' ? foreign.credential : original.credential,
            context:
              kind === 'suite'
                ? { ...original.context, cipherSuite: { ...original.context.cipherSuite, id: 3 } }
                : original.context,
            ledger: original.ledger,
            ...fixture.environment.options,
            ...(kind === 'options' ? { commitPolicy: () => 'accept' as const } : {}),
          })
          fixture.overrideRestore(async () => handle)
          await expect(registry(fixture).access(groupID)).rejects.toMatchObject({
            reason: 'invalid',
          })
        } finally {
          await fixture.close()
        }
      },
    )

    test('supplied options survive every isolated restoration', async () => {
      const fixture = await createRegistryFixture({
        mode,
        groupID,
        setup: 'seeded',
        options: {
          commitPolicy: () => 'accept',
          resolveLedgerEntries: async () => [],
          onLedgerEntries: () => {},
          keyRetention: { retainKeysForEpochs: 8 },
        },
      })
      try {
        const access = await registry(fixture).access(groupID)
        await access.read((handle) => {
          expect(handle.commitPolicy).toBe(fixture.environment.options.commitPolicy)
          expect(handle.resolveLedgerEntries).toBe(fixture.environment.options.resolveLedgerEntries)
          expect(handle.onLedgerEntries).toBe(fixture.environment.options.onLedgerEntries)
          expect(handle.context.clientConfig?.keyRetentionConfig.retainKeysForEpochs).toBe(8)
        })
      } finally {
        await fixture.close()
      }
    })

    test('read mutates only an isolated copy and leaves stored bytes unchanged', async () => {
      const fixture = await create()
      try {
        const stored = await recordFor(fixture, key)
        const access = await registry(fixture).access(groupID)
        const canonical = await access.read((handle) => encodeClientState(handle.state))
        let retained: GroupHandle | undefined
        await access.read((handle) => {
          retained = handle
          handle.state.keySchedule.epochAuthenticator.fill(0)
        })
        await access.read((handle) => {
          expect(handle).not.toBe(retained)
          expect(encodeClientState(handle.state)).toEqual(canonical)
        })
        expect(await recordFor(fixture, key)).toEqual(stored)
        expect(access.stateVersion()).toBe(1)
      } finally {
        await fixture.close()
      }
    })

    test('readControl refresh is isolated and expires with its callback', async () => {
      const fixture = await create()
      try {
        const access = await registry(fixture).access(groupID)
        let late: (() => Promise<unknown>) | undefined
        await access.readControl(async (scope) => {
          late = scope.refresh
          scope.handle.state.keySchedule.epochAuthenticator.fill(0)
          scope.source.key.incarnation = 99
          const refreshed = await scope.refresh()
          expect(refreshed.handle).not.toBe(scope.handle)
          expect(refreshed.source.key).toEqual(key)
          expect(refreshed.source.identity?.authenticator.some((byte) => byte !== 0)).toBe(true)
        })
        await expect(late?.()).rejects.toThrow('scope has ended')
      } finally {
        await fixture.close()
      }
    })

    test('warm version drift reloads after a facade change', async () => {
      const fixture = await create()
      try {
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        const next = await installNext(fixture, key)
        expect(await access.read((handle) => Number(handle.epoch))).toBe(1)
        expect(access.epoch()).toBe(1)
        expect(access.stateVersion()).toBe(2)
        expect(access.runtime.snapshot()?.authenticator).toEqual(
          next.state.keySchedule.epochAuthenticator,
        )
        expect(await owner.access(groupID)).toBe(access)
      } finally {
        await fixture.close()
      }
    })

    test.each(['null', 'corrupt'] as const)(
      'warm unchanged version refuses %s state',
      async (kind) => {
        const fixture = await create()
        try {
          const owner = registry(fixture)
          const access = await owner.access(groupID)
          if (kind === 'null') await fixture.removeStateBytes(key)
          else await fixture.corruptState(key)
          let called = false
          await expect(
            access.read(() => {
              called = true
            }),
          ).rejects.toMatchObject({ reason: 'state-unreadable' })
          expect(called).toBe(false)
          expect(access.runtime.snapshot()).toBeNull()
          await expect(owner.access(groupID)).rejects.toMatchObject({ reason: 'state-unreadable' })
        } finally {
          await fixture.close()
        }
      },
    )

    test('persisted strand and terminal state govern admission', async () => {
      const fixture = await create()
      try {
        await fixture.installRows({ key, control: { strand: { reason: 'lost-state' } } })
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        expect(access.admission()).toEqual({ epoch: 0, admissible: false, reason: 'stranded' })
        const record = await recordFor(fixture, key)
        await fixture.installRows({
          key,
          state: { ...record, version: record.version + 1, terminal: true },
        })
        await access.read(() => {})
        expect(access.admission()).toEqual({ epoch: 0, admissible: false, reason: 'terminal' })
        expect(access.runtime.snapshot()?.available).toBe(false)
      } finally {
        await fixture.close()
      }
    })

    test('control refresh keeps the same Read entry until the callback ends', async () => {
      const fixture = await create()
      try {
        const access = await registry(fixture).access(groupID)
        const lifetime = await fixture.device.groups.load(groupID)
        if (lifetime === null) throw new Error('Missing lifetime')
        const { deferred } = await import('../src/runtime.js')
        const entered = deferred<void>()
        const release = deferred<void>()
        let written = false
        const reading = access.readControl(async (scope) => {
          entered.resolve()
          await release.promise
          const next = await scope.refresh()
          expect(next.source.stateVersion).toBe(scope.source.stateVersion)
        })
        await entered.promise
        const writing = fixture.device.groups.transition(
          { groupID, mutationID: 'after-control-read', expected: lifetime },
          async () => {
            written = true
          },
        )
        try {
          await Promise.resolve()
          expect(written).toBe(false)
          release.resolve()
          await reading
          await writing
          expect(written).toBe(true)
        } finally {
          release.resolve()
        }
      } finally {
        await fixture.close()
      }
    })

    test('own removal is terminal while readable membership stays public', async () => {
      const fixture = await create()
      try {
        const record = await recordFor(fixture, key)
        const { decodeClientState } = await import('@kumiai/mls')
        const state = decodeClientState(record.state)
        if (state === undefined) throw new Error('Missing state')
        state.groupActiveState = { kind: 'removedFromGroup' }
        await fixture.installRows({
          key,
          state: { ...record, version: 2, state: encodeClientState(state) },
        })
        const access = await registry(fixture).access(groupID)
        expect(access.admission()).toEqual({ epoch: 0, admissible: false, reason: 'terminal' })
        expect(access.runtime.snapshot()?.available).toBe(false)
        expect(await access.read((handle) => handle.state.groupActiveState.kind)).toBe(
          'removedFromGroup',
        )
      } finally {
        await fixture.close()
      }
    })

    test('MLS lapse governs admission without hiding readable membership', async () => {
      const fixture = await create()
      try {
        const record = await recordFor(fixture, key)
        const original = await registryFixtureRestore(fixture)(record)
        fixture.overrideRestore(async () => {
          const handle = new GroupHandle({
            state: structuredClone(original.state),
            credential: original.credential,
            context: original.context,
            ledger: original.ledger,
            ...fixture.environment.options,
          })
          // This isolates the registry's projection from the fixture clock and lifecycle policy.
          handle.sendAdmission = () => ({ epoch: 0, admissible: false, reason: 'lapsed' })
          return handle
        })
        const access = await registry(fixture).access(groupID)
        expect(access.admission()).toEqual({ epoch: 0, admissible: false, reason: 'lapsed' })
        expect(access.runtime.snapshot()?.available).toBe(true)
        await fixture.installRows({ key, control: { strand: { reason: 'lost-state' } } })
        await access.read(() => {})
        expect(access.admission()).toEqual({ epoch: 0, admissible: false, reason: 'stranded' })
      } finally {
        await fixture.close()
      }
    })

    test('failed later restoration discards the warm cache', async () => {
      const fixture = await create()
      try {
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        fixture.overrideRestore(async () => {
          throw new Error('Host restore refused')
        })
        await expect(access.read(() => {})).rejects.toMatchObject({ reason: 'invalid' })
        expect(access.runtime.snapshot()).toBeNull()
        await expect(owner.access(groupID)).rejects.toMatchObject({ reason: 'invalid' })
        expect(fixture.restoreCount(groupID)).toBe(3)
      } finally {
        await fixture.close()
      }
    })

    test('unchanged reads do not notify runtime listeners', async () => {
      const fixture = await create()
      try {
        const access = await registry(fixture).access(groupID)
        let notifications = 0
        access.runtime.onEpochChanged(() => {
          notifications++
        })
        await access.read(() => {})
        await access.readControl(async (scope) => {
          await scope.refresh()
        })
        expect(notifications).toBe(0)
        await installNext(fixture, key)
        await access.read(() => {})
        expect(notifications).toBe(1)
      } finally {
        await fixture.close()
      }
    })

    test('stale generation discards the loaded access before return and revalidates', async () => {
      const fixture = await create()
      try {
        const { bindEntryCapability, entryCapability } = await import('../src/entry-capability.js')
        const capability = entryCapability(fixture.device.groups)
        const binding = coordinatorBinding(fixture.device.groups)
        if (capability === null || binding === null) throw new Error('Missing capability')
        let afterRead: (() => Promise<void>) | undefined
        bindEntryCapability({
          persistence: fixture.device.groups,
          coordinatorBinding: binding,
          capability: {
            ...capability,
            async read(groupID, fn) {
              const result = await capability.read(groupID, fn)
              const callback = afterRead
              afterRead = undefined
              await callback?.()
              return result
            },
          },
        })
        const owner = registry(fixture)
        const previous = await owner.access(groupID)
        const record = await recordFor(fixture, key)
        const original = await registryFixtureRestore(fixture)(record)
        afterRead = async () => {
          fixture.overrideRestore(async () => {
            throw new Error('Restore configuration changed')
          })
          await expect(previous.read(() => {})).rejects.toMatchObject({ reason: 'invalid' })
          fixture.overrideRestore(
            async () =>
              new GroupHandle({
                state: structuredClone(original.state),
                credential: original.credential,
                context: original.context,
                ledger: original.ledger,
                ...fixture.environment.options,
              }),
          )
        }
        const current = await owner.access(groupID)
        expect(current).not.toBe(previous)
        expect(previous.runtime.snapshot()).toBeNull()
        expect(current.runtime.snapshot()?.available).toBe(true)
        expect(await current.read((handle) => handle.credential.id)).toBe(fixture.identity.id)
      } finally {
        await fixture.close()
      }
    })

    test('restore pending refuses before restoration', async () => {
      const fixture = await create()
      try {
        const lifetime = await fixture.device.groups.load(groupID)
        if (lifetime === null) throw new Error('Missing lifetime')
        await fixture.device.groups.transition(
          { groupID, mutationID: 'restore-pending', expected: lifetime },
          async (stores) => {
            await stores.lifetime.save({
              ...lifetime,
              revision: lifetime.revision + 1,
              mutationID: 'restore-pending',
              restorePending: true,
            })
          },
        )
        const owner = registry(fixture)
        await expect(owner.start()).rejects.toMatchObject({ reason: 'restore-pending' })
        await expect(owner.access(groupID)).rejects.toMatchObject({ reason: 'restore-pending' })
        expect(fixture.restoreCount(groupID)).toBe(0)
      } finally {
        await fixture.close()
      }
    })
  })
}

test('two device factories on one database reject the second registry before reads', () => {
  const identity = randomIdentity()
  const db = createMemoryTransaction({ rows: {} })
  const owners = createOwnerQueues()
  const atRest = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(8) })
  const params = { db, owners, atRest, providerID: 'registry-provider', ownerDID: identity.id }
  const first = createMemoryDevicePersistence(params)
  const second = createMemoryDevicePersistence(params)
  expect(first.groups).not.toBe(second.groups)
  expect(coordinatorBinding(first.groups)).toBe(coordinatorBinding(second.groups))
  const restore = vi.fn(async (_record: GroupStateRecord) => {
    throw new Error('Unexpected restore')
  })
  const factory = (persistence: typeof first) =>
    createGroupHandleRegistry({
      persistence,
      providerID: params.providerID,
      recovery: { identity, options: {} },
      restore,
      restoreCandidate: async () => {
        throw new Error('Unexpected candidate')
      },
    })
  const transact = vi.spyOn(db, 'transact')
  factory(first)
  expect(() => factory(second)).toThrow('live registry')
  expect(transact).not.toHaveBeenCalled()
  expect(restore).not.toHaveBeenCalled()
})

test('copied unregistered wrapper and foreign provider refuse synchronously', async () => {
  const fixture = await createRegistryFixture({
    mode: 'double',
    groupID: 'registration',
    setup: 'empty',
  })
  try {
    const params = {
      persistence: fixture.device,
      providerID: fixture.device.providerID,
      recovery: fixture.environment,
      restore: registryFixtureRestore(fixture),
      restoreCandidate: async () => {
        throw new Error('Unexpected candidate')
      },
    }
    expect(() =>
      createGroupHandleRegistry({
        ...params,
        persistence: { ...fixture.device, groups: { ...fixture.device.groups } },
      }),
    ).toThrow('entry capability')
    expect(() => createGroupHandleRegistry({ ...params, providerID: 'foreign' })).toThrow(
      'provider',
    )
    expect(() => registry(fixture)).not.toThrow()
  } finally {
    await fixture.close()
  }
})
