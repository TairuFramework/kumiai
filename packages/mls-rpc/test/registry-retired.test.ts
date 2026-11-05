import type { ControlChanges, WelcomeObligation } from '@kumiai/rpc'
import { describe, expect, test } from 'vitest'

import { entryCapability } from '../src/entry-capability.js'
import { createGroupHandleRegistry } from '../src/registry/registry.js'
import {
  ackRetiredOutcome,
  listRetiredOutcomes,
  retireIncarnation,
  serveRetiredObligations,
} from '../src/registry/retired.js'
import {
  createRegistryFixture,
  type RegistryFixtureBase,
  registryFixtureMutateControl,
  registryFixtureRestore,
} from './fixtures/registry.js'
import {
  makeStorageSeed,
  nextChange,
  writeInstallationCheckpoint,
} from './fixtures/storage-seed.js'

const key = { groupID: 'retired-service', incarnation: 1 }
const bytes = new Uint8Array([1, 2, 3])
const welcome: WelcomeObligation = { opID: 'invite', welcome: bytes, recipients: ['recipient'] }

async function setup(fixture: RegistryFixtureBase, changes: ControlChanges = {}) {
  await fixture.installRows({
    key,
    control: {
      putWelcomes: [welcome],
      ...changes,
    },
  })
}

async function retire(fixture: RegistryFixtureBase, mode: 'real-mls' | 'double') {
  const groups = fixture.device.groups
  const seed = await makeStorageSeed({
    id: key.groupID,
    incarnation: 2,
    epoch: 1,
    mode,
    identity: fixture.identity,
    options: fixture.environment.options,
  })
  const mutationID = 'retirement'
  await groups.transition(await nextChange(groups, key.groupID, mutationID), async (stores) => {
    const lifetime = await stores.lifetime.load()
    if (lifetime === null) throw new Error('Missing lifetime')
    await retireIncarnation(stores, { source: key, nextIncarnation: 2, mutationID, at: 12 })
    await stores.lifetime.save({
      ...lifetime,
      latestIncarnation: 2,
      activeIncarnation: 2,
      revision: lifetime.revision + 1,
      mutationID,
    })
    await stores.incarnation(2).state.save(seed.state)
    const trust = await stores.trust.load()
    if (trust === null) throw new Error('Missing trust')
    await stores.trust.save({
      ...seed.trust,
      genesisAnchor: trust.genesisAnchor,
      spentEpochAuthenticators: trust.spentEpochAuthenticators,
    })
    await writeInstallationCheckpoint(stores, {
      key: seed.key,
      confirmedTranscriptHash: seed.confirmedTranscriptHash,
      mutationID,
      stateVersion: seed.state.version,
    })
  })
}

for (const mode of ['real-mls', 'double'] as const) {
  describe(`retired storage service (${mode})`, () => {
    const create = () => createRegistryFixture({ mode, groupID: key.groupID, setup: 'seeded' })

    test('retired startup promotes a legacy Welcome before serving it under its origin', async () => {
      const fixture = await create()
      let reopened: Awaited<ReturnType<typeof fixture.reopen>> | undefined
      try {
        await setup(fixture)
        await retire(fixture, mode)
        await registryFixtureMutateControl(
          fixture,
          key,
          (snapshot) =>
            ({
              ...snapshot,
              schemaVersion: undefined,
              welcomes: [{ ...welcome, committed: false }],
            }) as unknown as typeof snapshot,
        )
        reopened = await fixture.reopen()
        const seen: Array<WelcomeObligation> = []
        const result = await serveRetiredObligations({
          persistence: reopened.device.groups,
          key,
          deliverWelcome: async (owed) => {
            seen.push(owed)
          },
        })
        expect(seen).toEqual([welcome])
        expect(result).toEqual({ delivered: ['invite'], remaining: [], failures: [] })
        expect((await reopened.device.groups.ports(key).control.load()).schemaVersion).toBe(1)
      } finally {
        await reopened?.close()
        await fixture.close()
      }
    })

    test('independent obligations deliver outside ownership then delete', async () => {
      const fixture = await create()
      try {
        await setup(fixture, {
          putWelcomes: [welcome, { ...welcome, opID: 'committed' }],
        })
        await retire(fixture, mode)
        const capability = entryCapability(fixture.device.groups)
        if (capability === null) throw new Error('Missing capability')
        const activity = capability.activity(key.groupID)
        const calls: Array<string> = []
        const result = await serveRetiredObligations({
          persistence: fixture.device.groups,
          key,
          deliverWelcome: async (obligation) => {
            expect(await fixture.device.groups.load(key.groupID)).toMatchObject({
              activeIncarnation: 2,
            })
            calls.push(obligation.opID)
          },
        })
        expect(calls).toEqual(['invite', 'committed'])
        expect(result).toEqual({ delivered: ['invite', 'committed'], remaining: [], failures: [] })
        // Each deletion increments activity on admission and completion.
        expect(capability.activity(key.groupID).generation - activity.generation).toBe(4)
        expect(fixture.restoreCount(key.groupID)).toBe(0)
      } finally {
        await fixture.close()
      }
    })

    test('transport accepted crash before deletion repeats identical Welcome after durable reopen', async () => {
      let fixture = await create()
      try {
        await setup(fixture, { putWelcomes: [{ ...welcome }] })
        await retire(fixture, mode)
        fixture.armNextWorkFault('before-commit')
        const accepted: Array<WelcomeObligation> = []
        const serve = () =>
          serveRetiredObligations({
            persistence: fixture.device.groups,
            key,
            deliverWelcome: async (obligation) => {
              accepted.push(obligation)
            },
          })
        const first = await serve()
        expect(first.delivered).toEqual([])
        expect(first.remaining).toEqual(['invite'])
        expect(first.failures).toHaveLength(1)
        expect((await fixture.device.groups.ports(key).control.load()).welcomes).toEqual([
          { ...welcome },
        ])
        fixture = await fixture.reopen()
        expect((await fixture.device.groups.ports(key).control.load()).commitOnce).toBeNull()
        expect(await serve()).toEqual({ delivered: ['invite'], remaining: [], failures: [] })
        expect(accepted).toEqual([{ ...welcome }, { ...welcome }])
        fixture = await fixture.reopen()
        expect((await fixture.device.groups.ports(key).control.load()).welcomes).toEqual([])
        expect(
          (await fixture.device.groups.ports({ ...key, incarnation: 2 }).control.load()).welcomes,
        ).toEqual([])
        expect(fixture.restoreCount(key.groupID)).toBe(0)
      } finally {
        await fixture.close()
      }
    })

    test('one failed delivery does not block other obligations', async () => {
      const fixture = await create()
      try {
        await setup(fixture, {
          putWelcomes: [{ ...welcome }, { ...welcome, opID: 'other' }],
        })
        await retire(fixture, mode)
        const failure = new Error('transport failed')
        const result = await serveRetiredObligations({
          persistence: fixture.device.groups,
          key,
          deliverWelcome: async (obligation) => {
            if (obligation.opID === 'invite') throw failure
          },
        })
        expect(result).toEqual({ delivered: ['other'], remaining: ['invite'], failures: [failure] })
      } finally {
        await fixture.close()
      }
    })

    test('retired outcome ack is fixed-key and idempotent; active keys refuse', async () => {
      const fixture = await create()
      try {
        const outcome = { id: 'owed', opID: 'invite', at: 5, kind: 'unknown' as const }
        await setup(fixture, { putOutcomes: [outcome] })
        const params = { persistence: fixture.device.groups, key }
        await expect(listRetiredOutcomes(params)).rejects.toThrow()
        await expect(ackRetiredOutcome({ ...params, id: 'owed' })).rejects.toThrow()
        await expect(
          serveRetiredObligations({
            ...params,
            deliverWelcome: async () => {
              throw new Error('Active delivery')
            },
          }),
        ).rejects.toThrow()
        await retire(fixture, mode)
        await fixture.device.groups
          .ports({ ...key, incarnation: 2 })
          .control.apply({ putOutcomes: [outcome] }, 'new-outcome')
        expect(await listRetiredOutcomes(params)).toEqual([outcome])
        await ackRetiredOutcome({ ...params, id: 'owed' })
        await ackRetiredOutcome({ ...params, id: 'owed' })
        expect(await listRetiredOutcomes(params)).toEqual([])
        expect((await fixture.device.groups.ports(key).control.load()).welcomes).toEqual([welcome])
        expect(
          (await fixture.device.groups.ports({ ...key, incarnation: 2 }).control.load()).outcomes,
        ).toEqual([outcome])
      } finally {
        await fixture.close()
      }
    })

    test('retirement consumes retained internal reports and lists only host reports by operation ID', async () => {
      const fixture = await create()
      try {
        const internal = {
          id: 'retained-internal',
          opID: 'kumiai/internal/rotation',
          at: 5,
          kind: 'unknown' as const,
        }
        const host = {
          id: 'kumiai/internal/host-report',
          opID: 'host-operation',
          at: 6,
          kind: 'lost' as const,
        }
        const recovery = {
          id: 'kumiai/internal/recovery-report',
          opID: null,
          at: 7,
          kind: 'unknown' as const,
        }
        await setup(fixture, { putOutcomes: [internal, host, recovery] })
        await retire(fixture, mode)
        expect((await fixture.device.groups.ports(key).control.load()).outcomes).toEqual([
          host,
          recovery,
        ])
        // Older retired snapshots may still contain an internal row.
        await registryFixtureMutateControl(fixture, key, (snapshot) => ({
          ...snapshot,
          outcomes: [internal, host, recovery],
        }))
        expect(await listRetiredOutcomes({ persistence: fixture.device.groups, key })).toEqual([
          host,
          recovery,
        ])
        await serveRetiredObligations({
          persistence: fixture.device.groups,
          key,
          deliverWelcome: async () => {},
        })
        for (const id of [host.id, recovery.id])
          await ackRetiredOutcome({ persistence: fixture.device.groups, key, id })
        await fixture.registry.delete({ ...key, incarnation: 2 })
        expect((await fixture.device.groups.load(key.groupID))?.activeIncarnation).toBeNull()
      } finally {
        await fixture.close()
      }
    })

    test('old access cannot supply a restarted owner', async () => {
      const fixture = await create()
      try {
        const owner = createGroupHandleRegistry({
          persistence: fixture.device,
          providerID: fixture.device.providerID,
          packages: fixture.packages,
          recovery: fixture.environment,
          restore: registryFixtureRestore(fixture),
          restoreCandidate: async () => {
            throw new Error('No old candidate')
          },
        })
        const access = await owner.access(key.groupID)
        await setup(fixture)
        await retire(fixture, mode)
        let constructed = false
        await expect(
          access.read(() => {
            constructed = true
          }),
        ).rejects.toMatchObject({ name: 'DisplacedGroupHandleError' })
        expect(constructed).toBe(false)
      } finally {
        await fixture.close()
      }
    })
  })
}
