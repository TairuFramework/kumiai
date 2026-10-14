import { encodeClientState } from '@kumiai/mls'
import type { ResyncProof as PortableResyncProof, RecoverySource } from '@kumiai/rpc'
import { describe, expect, expectTypeOf, test, vi } from 'vitest'

import {
  bindEntryCapability,
  coordinatorBinding,
  type EntryReads,
  entryCapability,
} from '../src/entry-capability.js'
import {
  createGroupHandleRegistry,
  GroupUnavailableError,
  type LegacyRegistryRecoverySource,
  type RegistryRecoverySource,
  type ResyncProof,
} from '../src/index.js'
import type { GroupRecoveryTrust } from '../src/persistence-types.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
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
      throw new Error('Source read must not restore a candidate')
    },
  })
}

function intercept(fixture: RegistryFixtureBase, wrap: (reads: EntryReads) => EntryReads) {
  const capability = entryCapability(fixture.device.groups)
  const binding = coordinatorBinding(fixture.device.groups)
  if (capability === null || binding === null) throw new Error('Missing capability')
  const read = vi.fn((groupID: string, fn: (reads: EntryReads) => Promise<unknown>) =>
    capability.read(groupID, (reads) => fn(wrap(reads))),
  )
  bindEntryCapability({
    persistence: fixture.device.groups,
    coordinatorBinding: binding,
    capability: {
      ...capability,
      read: (groupID, fn) => read(groupID, fn) as ReturnType<typeof fn>,
    },
  })
  return read
}

async function advance(fixture: RegistryFixtureBase, groupID: string) {
  const key = { groupID, incarnation: 1 }
  const record = await fixture.device.groups.loadState(key)
  if (record === null || record.deleted || record.state === null) throw new Error('Missing state')
  const handle = await fixture.advance(
    await registryFixtureRestore(fixture)({ ...record, state: record.state }),
  )
  await fixture.installRows({
    key,
    state: {
      ...record,
      version: record.version + 1,
      epoch: Number(handle.epoch),
      epochAuthenticator: handle.state.keySchedule.epochAuthenticator,
      state: encodeClientState(handle.state),
      ledger: handle.ledgerTokens,
    },
    trust: recoveryTrustFor(handle, key, await fixture.device.groups.loadTrust(groupID)),
  })
}

for (const mode of ['real-mls', 'double'] as const) {
  describe(`registry recovery source (${mode})`, () => {
    const groupID = `registry-source-${mode}`
    const key = { groupID, incarnation: 1 }
    const create = (setup: 'empty' | 'seeded' = 'seeded') =>
      createRegistryFixture({ mode, groupID, setup })

    test.each(['corrupt', 'null'] as const)(
      'current identity survives %s private state while access refuses',
      async (damage) => {
        const fixture = await create()
        try {
          for (let epoch = 1; epoch <= 3; epoch++) await advance(fixture, groupID)
          const owner = registry(fixture)
          const previous = await owner.recoverySource(groupID)
          await advance(fixture, groupID)
          const trust = await fixture.device.groups.loadTrust(groupID)
          const lifetime = await fixture.device.groups.load(groupID)
          if (trust === null || lifetime === null)
            throw new Error('Missing current administrative rows')
          const expected: LegacyRegistryRecoverySource = {
            key,
            stateVersion: 5,
            identity: trust.installed,
            trust,
            lifetimeRevision: lifetime.revision,
          }
          expect(previous.identity?.epoch).toBe(3)
          expect(expected.identity?.epoch).toBe(4)
          if (damage === 'corrupt') await fixture.corruptState(key)
          else await fixture.removeStateBytes(key)
          const restores = fixture.restoreCount(groupID)
          expect(await owner.recoverySource(groupID)).toEqual(expected)
          expect(fixture.restoreCount(groupID)).toBe(restores)
          await expect(owner.access(groupID)).rejects.toBeInstanceOf(GroupUnavailableError)
          expect(await owner.recoverySource(groupID)).toEqual(expected)
        } finally {
          await fixture.close()
        }
      },
    )

    test('source uses one Read and advances no revisions', async () => {
      const fixture = await create()
      try {
        const lifetime = vi.fn()
        const metadata = vi.fn()
        const trust = vi.fn()
        const forbidden = vi.fn(async () => {
          throw new Error('Private/control read forbidden')
        })
        const read = intercept(fixture, (reads) => ({
          ...reads,
          lifetime: async () => {
            lifetime()
            return reads.lifetime()
          },
          metadata: async (incarnation) => {
            metadata(incarnation)
            return reads.metadata(incarnation)
          },
          trust: async () => {
            trust()
            return reads.trust()
          },
          state: forbidden,
          control: forbidden,
          diagnoseState: forbidden,
        }))
        const owner = registry(fixture)
        const before = await fixture.inspectRows()
        await owner.recoverySource(groupID)
        expect(read).toHaveBeenCalledTimes(1)
        expect(lifetime).toHaveBeenCalledTimes(1)
        expect(metadata).toHaveBeenCalledExactlyOnceWith(1)
        expect(trust).toHaveBeenCalledTimes(1)
        expect(forbidden).not.toHaveBeenCalled()
        expect(await fixture.inspectRows()).toEqual(before)
      } finally {
        await fixture.close()
      }
    })

    test('source fields are defensive across nested data and identities', async () => {
      const fixture = await create()
      try {
        // Return the same retained objects so provider copying cannot hide source aliasing.
        const capability = entryCapability(fixture.device.groups)
        if (capability === null) throw new Error('Missing capability')
        const retained = await capability.read(groupID, async (reads) => ({
          lifetime: await reads.lifetime(),
          metadata: await reads.metadata(1),
          trust: await reads.trust(),
        }))
        intercept(fixture, (reads) => ({
          ...reads,
          lifetime: async () => retained.lifetime,
          metadata: async () => retained.metadata,
          trust: async () => retained.trust,
        }))
        const owner = registry(fixture)
        const first = await owner.recoverySource(groupID)
        const expected = await owner.recoverySource(groupID)
        if (first.identity === null || expected.identity === null)
          throw new Error('Missing installed identity')
        const spent = first.trust.spentEpochAuthenticators[0]
        if (spent === undefined) throw new Error('Missing spent authenticator')
        first.key.groupID = 'foreign'
        first.identity.authenticator.fill(0)
        first.trust.installed.authenticator.fill(1)
        first.trust.genesisAnchor.fill(0)
        spent.fill(0)
        first.trust.credential.id = 'foreign'
        if (
          !(first.trust.registry.devices instanceof Map) ||
          !(first.trust.registry.controllers instanceof Map)
        )
          throw new Error('Missing registry maps')
        first.trust.registry.devices.clear()
        first.trust.registry.controllers.clear()
        first.trust.ledger.push('foreign')
        const leaf = first.trust.signerTree.find((node) => node?.nodeType === 1)
        if (leaf?.nodeType !== 1) throw new Error('Missing public signer leaf')
        leaf.leaf.signaturePublicKey.fill(0)
        expect(await owner.recoverySource(groupID)).toEqual(expected)
        expect(expected.identity.authenticator).toEqual(expected.trust.installed.authenticator)
        const fresh = await owner.recoverySource(groupID)
        if (fresh.identity === null) throw new Error('Missing installed identity')
        fresh.identity.authenticator.fill(0)
        expect(fresh.trust.installed.authenticator).toEqual(expected.trust.installed.authenticator)
      } finally {
        await fixture.close()
      }
    })

    test.each([
      'missing-metadata',
      'malformed-metadata',
      'missing-trust',
      'corrupt-trust',
      'malformed-trust',
      'empty-spent',
      'foreign-installed',
      'retired-installed',
    ] as const)('%s refuses without initial identity or empty trust fallback', async (damage) => {
      const fixture = await create()
      try {
        if (damage === 'missing-metadata') await fixture.mutateMetadata(key, () => null)
        if (damage === 'malformed-metadata')
          await fixture.mutateMetadata(key, (value) => ({ ...(value as object), version: -1 }))
        if (damage === 'corrupt-trust') await fixture.corruptTrust(groupID)
        intercept(fixture, (reads) => ({
          ...reads,
          lifetime: async () => {
            const lifetime = await reads.lifetime()
            return damage === 'retired-installed' && lifetime !== null
              ? { ...lifetime, activeIncarnation: 2, latestIncarnation: 2 }
              : lifetime
          },
          metadata: async (incarnation) => {
            const metadata = await reads.metadata(damage === 'retired-installed' ? 1 : incarnation)
            return damage === 'retired-installed' && metadata !== null
              ? { ...metadata, incarnation: 2 }
              : metadata
          },
          trust: async () => {
            const trust = await reads.trust()
            if (trust === null) throw new Error('Missing fixture trust')
            if (damage === 'missing-trust') return null
            if (damage === 'malformed-trust')
              return { ...trust, installed: { ...trust.installed, epoch: -1 } }
            if (damage === 'empty-spent') return { ...trust, spentEpochAuthenticators: [] }
            if (damage === 'foreign-installed')
              return { ...trust, installed: { ...trust.installed, groupID: 'foreign' } }
            return trust
          },
        }))
        await expect(registry(fixture).recoverySource(groupID)).rejects.toBeInstanceOf(
          GroupUnavailableError,
        )
      } finally {
        await fixture.close()
      }
    })

    const malformedTrustCases: Array<{
      name: string
      damage(trust: GroupRecoveryTrust): unknown
    }> = [
      {
        name: 'missing leaf payload',
        damage: (trust) => ({ ...trust, signerTree: [{ nodeType: 1 }] }),
      },
      {
        name: 'missing parent payload',
        damage: (trust) => ({ ...trust, signerTree: [{ nodeType: 2 }] }),
      },
      { name: 'numeric ledger token', damage: (trust) => ({ ...trust, ledger: [42] }) },
      { name: 'missing member ID', damage: (trust) => ({ ...trust, credential: { groupID } }) },
      {
        name: 'incomplete binding',
        damage: (trust) => ({ ...trust, binding: { id: 'controller' } }),
      },
      {
        name: 'malformed binding prefix',
        damage: (trust) => ({
          ...trust,
          binding: { id: 'controller', capability: 'token', prefix: [42] },
        }),
      },
      {
        name: 'malformed device record',
        damage: (trust) => ({
          ...trust,
          registry: { ...trust.registry, devices: new Map([['device', 42]]) },
        }),
      },
      {
        name: 'malformed controller record',
        damage: (trust) => ({
          ...trust,
          registry: { ...trust.registry, controllers: new Map([['controller', 42]]) },
        }),
      },
      {
        name: 'malformed parent fields',
        damage: (trust) => ({
          ...trust,
          signerTree: [
            {
              nodeType: 2,
              parent: {
                hpkePublicKey: new Uint8Array(),
                parentHash: new Uint8Array(),
                unmergedLeaves: ['leaf'],
              },
            },
          ],
        }),
      },
      ...[
        'hpkePublicKey',
        'signaturePublicKey',
        'credential',
        'capabilities',
        'leafNodeSource',
        'extensions',
        'signature',
        'lifetime',
      ].map((field) => ({
        name: `malformed leaf ${field}`,
        damage: (trust: GroupRecoveryTrust) => {
          const node = trust.signerTree.find((entry) => entry?.nodeType === 1)
          if (node?.nodeType !== 1) throw new Error('Missing fixture leaf')
          return { ...trust, signerTree: [{ ...node, leaf: { ...node.leaf, [field]: 42 } }] }
        },
      })),
    ]

    test.each(malformedTrustCases)(
      '$name refuses malformed nested recovery trust',
      async ({ damage }) => {
        const fixture = await create()
        try {
          intercept(fixture, (reads) => ({
            ...reads,
            trust: async () => {
              const trust = await reads.trust()
              if (trust === null) throw new Error('Missing fixture trust')
              // Inject a serializable malformed provider row at the administrative read boundary.
              return damage(trust) as GroupRecoveryTrust
            },
          }))
          await expect(registry(fixture).recoverySource(groupID)).rejects.toMatchObject({
            name: 'GroupUnavailableError',
            reason: 'recovery-unavailable',
          })
        } finally {
          await fixture.close()
        }
      },
    )

    test('complete public parent, update, commit and binding fields remain available', async () => {
      const fixture = await create()
      try {
        const retained = await fixture.device.groups.loadTrust(groupID)
        if (retained === null) throw new Error('Missing fixture trust')
        const node = retained.signerTree.find((entry) => entry?.nodeType === 1)
        if (node?.nodeType !== 1) throw new Error('Missing fixture leaf')
        const { lifetime: _lifetime, ...publicLeaf } = node.leaf as typeof node.leaf & {
          lifetime?: unknown
        }
        const trust: GroupRecoveryTrust = {
          ...retained,
          signerTree: [
            node,
            {
              nodeType: 2,
              parent: {
                hpkePublicKey: new Uint8Array([1]),
                parentHash: new Uint8Array([2]),
                unmergedLeaves: [0],
              },
            },
            undefined,
            { nodeType: 1, leaf: { ...publicLeaf, leafNodeSource: 2 } },
            {
              nodeType: 1,
              leaf: { ...publicLeaf, leafNodeSource: 3, parentHash: new Uint8Array([3]) },
            },
          ],
          binding: {
            id: 'controller',
            capability: 'capability',
            holderGrant: 'grant',
            prefix: [{ event: { v: 1, t: 'icp', g: 0, s: 0, crit: true }, sigs: ['signature'] }],
          },
          ledger: ['token'],
        }
        intercept(fixture, (reads) => ({ ...reads, trust: async () => trust }))
        expect((await registry(fixture).recoverySource(groupID)).trust).toEqual(trust)
      } finally {
        await fixture.close()
      }
    })

    test.each(['absent', 'deleted'] as const)('%s source is unavailable', async (reason) => {
      const fixture = await create(reason === 'absent' ? 'empty' : 'seeded')
      try {
        if (reason === 'deleted') {
          const lifetime = await fixture.device.groups.load(groupID)
          if (lifetime === null) throw new Error('Missing lifetime')
          await fixture.device.groups.transition(
            { groupID, mutationID: 'delete-source', expected: lifetime },
            async (stores) => {
              await stores.incarnation(1).state.save({ ...key, version: 2, deleted: true })
              await stores.lifetime.save({
                ...lifetime,
                activeIncarnation: null,
                revision: lifetime.revision + 1,
                mutationID: 'delete-source',
              })
            },
          )
        }
        await expect(registry(fixture).recoverySource(groupID)).rejects.toMatchObject({
          name: 'GroupUnavailableError',
          reason,
        })
      } finally {
        await fixture.close()
      }
    })
  })
}

test('registry captured declarations specialise portable opaque trust without changing legacy sources', () => {
  expectTypeOf<RegistryRecoverySource>().toEqualTypeOf<RecoverySource<GroupRecoveryTrust>>()
  expectTypeOf<ResyncProof>().toEqualTypeOf<PortableResyncProof>()
  expectTypeOf<Extract<keyof LegacyRegistryRecoverySource, 'trustDigest'>>().toEqualTypeOf<never>()
})
