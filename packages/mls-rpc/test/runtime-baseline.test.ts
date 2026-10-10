import { afterAll, describe, expect, test, vi } from 'vitest'

const originalPromiseMethods = new Map<PropertyKey, PropertyDescriptor | undefined>()
const originalAbortSignalMethods = new Map<PropertyKey, PropertyDescriptor | undefined>()

function removeStatic(
  owner: object,
  key: PropertyKey,
  saved: Map<PropertyKey, PropertyDescriptor | undefined>,
) {
  saved.set(key, Object.getOwnPropertyDescriptor(owner, key))
  Reflect.deleteProperty(owner, key)
}

afterAll(() => {
  vi.unstubAllGlobals()
  for (const [key, descriptor] of originalPromiseMethods) {
    if (descriptor === undefined) Reflect.deleteProperty(Promise, key)
    else Object.defineProperty(Promise, key, descriptor)
  }
  for (const [key, descriptor] of originalAbortSignalMethods) {
    if (descriptor === undefined) Reflect.deleteProperty(AbortSignal, key)
    else Object.defineProperty(AbortSignal, key, descriptor)
  }
})

describe('runtime baseline capability smoke', () => {
  test('runs memory persistence without optional host globals', async () => {
    for (const name of [
      'structuredClone',
      'SharedArrayBuffer',
      'Atomics',
      'setImmediate',
      'process',
      'Buffer',
    ])
      vi.stubGlobal(name, undefined)
    removeStatic(Promise, 'withResolvers', originalPromiseMethods)
    removeStatic(AbortSignal, 'any', originalAbortSignalMethods)
    removeStatic(AbortSignal, 'timeout', originalAbortSignalMethods)

    for (const name of [
      'structuredClone',
      'SharedArrayBuffer',
      'Atomics',
      'setImmediate',
      'process',
      'Buffer',
    ])
      expect(globalThis[name as keyof typeof globalThis]).toBeUndefined()
    expect('withResolvers' in Promise).toBe(false)
    expect('any' in AbortSignal).toBe(false)
    expect('timeout' in AbortSignal).toBe(false)
    expect(typeof WeakMap).toBe('function')
    expect(typeof WeakSet).toBe('function')
    expect(typeof AbortController).toBe('function')
    expect(typeof queueMicrotask).toBe('function')
    expect(typeof setTimeout).toBe('function')
    expect(typeof TextEncoder).toBe('function')
    expect(typeof TextDecoder).toBe('function')
    expect(typeof crypto.getRandomValues).toBe('function')
    expect(typeof crypto.subtle).toBe('object')
    expect(typeof crypto.randomUUID).toBe('function')

    const [
      { createMemoryDevicePersistence, createMemoryTransaction, createMemoryPackageStores },
      { physicalRecordKey, sealRecord },
    ] = await Promise.all([import('../src/testing.js'), import('../src/persistence-codec.js')])
    const atRest = {
      async seal(bytes: Uint8Array) {
        return bytes.slice()
      },
      async open(bytes: Uint8Array) {
        return bytes.slice()
      },
    }
    const groupID = 'group-baseline'
    const groupLifetime = {
      groupID,
      latestIncarnation: 1,
      activeIncarnation: 1,
      revision: 1,
      mutationID: 'initial-group',
      restorePending: false,
    }
    const lifetimeAddress = {
      groupID,
      incarnation: null,
      namespace: 'lifetime',
      recordID: 'current',
    }
    const groupOwnerKey = JSON.stringify([groupID, null, 'current'])
    const db = createMemoryTransaction({
      rows: {
        lifetime: new Map([
          [
            physicalRecordKey(lifetimeAddress),
            await sealRecord(atRest, lifetimeAddress, groupLifetime),
          ],
        ]),
        'group-owner': new Map([[groupOwnerKey, { revision: 1, mutationID: 'initial-group' }]]),
      },
    })
    const device = createMemoryDevicePersistence({
      db,
      atRest,
      providerID: 'runtime-baseline',
      ownerDID: 'device-baseline',
    })

    expect(await device.load()).toMatchObject({ revision: 0 })
    await device.transition(
      { mutationID: 'initial-device-write', expectedRevision: 0, group: null },
      async (stores) => stores.ordinary('packages').list(device.ownerDID),
    )
    const packages = createMemoryPackageStores({ device, sourceID: 'packages' })
    expect(await packages.ordinary.list(device.ownerDID)).toEqual([])

    const nextDevice = await device.load()
    const mutationID = 'combined-control-write'
    await device.transition(
      {
        mutationID,
        expectedRevision: nextDevice.revision,
        group: {
          groupID,
          mutationID,
          expected: { revision: 1, activeIncarnation: 1 },
        },
      },
      async (stores) => {
        if (stores.group === null) throw new Error('Missing combined group participant')
        await stores.group
          .incarnation(1)
          .control.apply({ cursor: { position: null, epoch: 0 } }, mutationID)
      },
    )
    expect(await device.load()).toMatchObject({ revision: 2, mutationID })
  })
})
