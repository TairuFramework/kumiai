import { describe, expect, test, vi } from 'vitest'

import { entryCapability } from '../src/entry-capability.js'
import type { DevicePackageAdapters, PackageUse } from '../src/persistence-types.js'
import { createGroupHandleRegistry } from '../src/registry/registry.js'
import type { GroupHandleRegistry } from '../src/registry/types.js'
import { gateRegistryMaintenance } from '../src/testing.js'
import { createDevicePackages, provisionDevicePackage } from './fixtures/device-packages.js'
import { createRegistryFixture, registryFixtureRestore } from './fixtures/registry.js'
import { requireValue } from './fixtures/require-value.js'

async function setup() {
  const fixture = await createRegistryFixture({
    mode: 'double',
    groupID: 'participants',
    setup: 'empty',
  })
  const packages = createDevicePackages(fixture.device, [
    { sourceID: 'ordinary', kind: 'ordinary' },
    { sourceID: 'fallback', kind: 'last-resort' },
  ])
  const use = await provisionDevicePackage({
    device: fixture.device,
    identity: fixture.identity,
    sourceID: 'ordinary',
    kind: 'ordinary',
  })
  const fallbackUse = await provisionDevicePackage({
    device: fixture.device,
    identity: fixture.identity,
    sourceID: 'fallback',
    kind: 'last-resort',
  })
  const capability = requireValue(entryCapability(fixture.device.groups))
  const reads = [
    vi.spyOn(capability, 'read'),
    vi.spyOn(capability, 'run'),
    vi.spyOn(fixture.device, 'load'),
    ...['load', 'loadState', 'loadTrust', 'list'].map((name) =>
      vi.spyOn(fixture.device.groups, name as 'load'),
    ),
  ]
  const callbacks: Array<unknown> = [
    vi.spyOn(packages, 'rotateAvailability'),
    vi.spyOn(packages, 'cleanup'),
  ]
  for (const source of packages.sources) {
    callbacks.push(
      vi.spyOn(source, 'bundles'),
      vi.spyOn(source, 'consume'),
      vi.spyOn(source, 'receipt'),
    )
  }
  for (const { store } of packages.stores) {
    for (const name of ['list', 'put', 'delete', 'consume', 'receipt'] as const)
      callbacks.push(vi.spyOn(store, name))
  }
  const restore = vi.fn(registryFixtureRestore(fixture))
  const restoreCandidate = vi.fn(async () => {
    throw new Error('Unexpected candidate')
  })
  const params = {
    persistence: fixture.device,
    providerID: fixture.device.providerID,
    recovery: fixture.environment,
    restore,
    restoreCandidate,
    packages,
  }
  const owners: Array<GroupHandleRegistry> = []
  function construct(input: unknown = packages) {
    const owner = createGroupHandleRegistry({ ...params, packages: input as DevicePackageAdapters })
    owners.push(owner)
    gateRegistryMaintenance(owner)
    return owner
  }
  function untouched() {
    for (const callback of [...reads, ...callbacks, restore, restoreCandidate])
      expect(callback).not.toHaveBeenCalled()
    expect(fixture.restores()).toBe(0)
  }
  return {
    fixture,
    packages,
    params,
    construct,
    untouched,
    reads,
    callbacks,
    restore,
    use,
    fallbackUse,
    async close() {
      for (const owner of owners) await owner.dispose()
      await fixture.close()
    },
  }
}

describe('device package validation', () => {
  test('missing package participants refuse before registry registration', async () => {
    const s = await setup()
    try {
      const { packages: _packages, ...missing } = s.params
      expect(() => createGroupHandleRegistry(missing as typeof s.params)).toThrow(TypeError)
      s.untouched()
      expect(() => s.construct()).not.toThrow()
      s.untouched()
    } finally {
      await s.close()
    }
  })

  test('foreign package participant identities refuse before callbacks', async () => {
    const s = await setup()
    try {
      for (const field of ['providerID', 'ownerDID'] as const) {
        for (const location of ['adapter', 'source', 'store'] as const) {
          const input = {
            ...s.packages,
            sources: s.packages.sources.map((x) => ({ ...x })),
            stores: s.packages.stores.map((x) => ({ ...x })),
          }
          if (location === 'adapter') input[field] = 'foreign'
          else if (location === 'source') requireValue(input.sources[0])[field] = 'foreign'
          else requireValue(input.stores[0])[field] = 'foreign'
          expect(() => s.construct(input), `${location}.${field}`).toThrow(TypeError)
          s.untouched()
        }
      }
      expect(() => s.construct()).not.toThrow()
    } finally {
      await s.close()
    }
  })

  test('invalid source IDs kinds and operations refuse before callbacks', async () => {
    const s = await setup()
    try {
      const invalid: Array<unknown> = [
        { ...s.packages, sources: null },
        { ...s.packages, stores: null },
        ...['', null, 7].flatMap((sourceID) => [
          { ...s.packages, sources: [{ ...requireValue(s.packages.sources[0]), sourceID }] },
          { ...s.packages, stores: [{ ...requireValue(s.packages.stores[0]), sourceID }] },
        ]),
        {
          ...s.packages,
          sources: [requireValue(s.packages.sources[0]), requireValue(s.packages.sources[0])],
        },
        ...['unknown', null].map((kind) => ({
          ...s.packages,
          sources: [{ ...requireValue(s.packages.sources[0]), kind }],
        })),
      ]
      for (const name of ['rotateAvailability', 'cleanup'])
        invalid.push({ ...s.packages, [name]: null })
      for (const name of ['bundles', 'consume', 'receipt'])
        invalid.push({
          ...s.packages,
          sources: [
            { ...requireValue(s.packages.sources[0]), [name]: null },
            s.packages.sources[1],
          ],
        })
      for (const name of ['list', 'put', 'delete', 'consume', 'receipt'])
        invalid.push({
          ...s.packages,
          stores: [
            {
              ...requireValue(s.packages.stores[0]),
              store: { ...requireValue(s.packages.stores[0]).store, [name]: null },
            },
            s.packages.stores[1],
          ],
        })
      for (const input of invalid) {
        expect(() => s.construct(input)).toThrow(TypeError)
        s.untouched()
      }
    } finally {
      await s.close()
    }
  })

  test('source store pairs require an exact bijection', async () => {
    const s = await setup()
    try {
      const [ordinary, fallback] = s.packages.stores
      for (const stores of [
        [ordinary],
        [ordinary, fallback, { ...ordinary, sourceID: 'extra' }],
        [ordinary, fallback, ordinary],
        [ordinary, { ...fallback, kind: 'ordinary' }],
        [ordinary, { ...fallback, sourceID: 'other' }],
      ]) {
        expect(() => s.construct({ ...s.packages, stores })).toThrow(TypeError)
        s.untouched()
      }
      expect(() => s.construct()).not.toThrow()
      s.untouched()
    } finally {
      await s.close()
    }
  })

  test('participant descriptors are defensively copied', async () => {
    const s = await setup()
    try {
      const owner = s.construct()
      const original = {
        ...s.packages,
        sources: s.packages.sources.map((x) => ({ ...x })),
        stores: s.packages.stores.map((x) => ({ ...x })),
      }
      requireValue(s.packages.sources[0]).sourceID = 'retargeted'
      requireValue(s.packages.sources[0]).kind = 'last-resort'
      requireValue(s.packages.stores[0]).sourceID = 'retargeted'
      requireValue(s.packages.stores[0]).kind = 'last-resort'
      s.packages.sources.splice(1)
      s.packages.stores.splice(1)
      const candidate = await s.fixture.makeHandle(1)
      await expect(
        owner.seed(candidate, {
          packageUse: { sourceID: 'retargeted', ref: 'ref', kind: 'last-resort' },
        }),
      ).rejects.toMatchObject({ name: 'SeedAdmissionRefusedError', reason: 'invalid-package-use' })
      s.untouched()
      expect(await owner.seed(candidate, { packageUse: s.use })).toEqual({
        groupID: candidate.groupID,
        incarnation: 1,
      })
      const fallback = await s.fixture.makeHandle(1, 'fallback-participants')
      expect(await owner.seed(fallback, { packageUse: s.fallbackUse })).toEqual({
        groupID: fallback.groupID,
        incarnation: 1,
      })
      const { validateDevicePackages } = await import('../src/device-packages.js')
      const copied = validateDevicePackages(s.fixture.device, original)
      expect(copied.sources).not.toBe(original.sources)
      expect(copied.stores).not.toBe(original.stores)
      expect(copied.rotateAvailability).toBe(original.rotateAvailability)
      expect(copied.cleanup).toBe(original.cleanup)
      for (const [index, source] of original.sources.entries()) {
        expect(requireValue(copied.sources[index])).not.toBe(source)
        for (const name of ['bundles', 'consume', 'receipt'] as const)
          expect(requireValue(copied.sources[index])[name]).toBe(source[name])
        expect(requireValue(copied.stores[index])).not.toBe(requireValue(original.stores[index]))
        expect(requireValue(copied.stores[index]).store).toBe(
          requireValue(original.stores[index]).store,
        )
      }
    } finally {
      await s.close()
    }
  })

  test('empty participants permit genesis but refuse requested package use', async () => {
    const s = await setup()
    try {
      const owner = s.construct(createDevicePackages(s.fixture.device))
      const candidate = await s.fixture.makeHandle(1)
      for (const use of [
        { sourceID: 'ordinary', ref: 'ref', kind: 'ordinary' },
        { sourceID: 'fallback', ref: 'ref', kind: 'last-resort' },
      ] satisfies Array<PackageUse>) {
        await expect(owner.seed(candidate, { packageUse: use })).rejects.toMatchObject({
          name: 'SeedAdmissionRefusedError',
          reason: 'invalid-package-use',
        })
        s.untouched()
      }
      const genesis = await s.fixture.makeHandle(0)
      expect(await owner.seed(genesis, { packageUse: null })).toEqual({
        groupID: genesis.groupID,
        incarnation: 1,
      })
      for (const callback of s.callbacks) expect(callback).not.toHaveBeenCalled()
    } finally {
      await s.close()
    }
  })
})
