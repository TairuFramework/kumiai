import type { OwnIdentity } from '@kokuin/token'
import type { ControllerBinding, GroupHandle } from '@kumiai/mls'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

const removedGlobals = [
  'structuredClone',
  'SharedArrayBuffer',
  'Atomics',
  'setImmediate',
  'process',
  'Buffer',
  'Float16Array',
]
const removedMembers: Array<[object, string]> = [
  [Promise, 'withResolvers'],
  [AbortSignal, 'any'],
  [AbortSignal, 'timeout'],
  [String.prototype, 'isWellFormed'],
  [String.prototype, 'toWellFormed'],
  [AbortSignal.prototype, 'throwIfAborted'],
]
const originalMembers: Array<[object, string, PropertyDescriptor | undefined]> = []

beforeAll(() => {
  for (const name of removedGlobals) vi.stubGlobal(name, undefined)
  for (const [owner, key] of removedMembers) {
    originalMembers.push([owner, key, Object.getOwnPropertyDescriptor(owner, key)])
    Reflect.deleteProperty(owner, key)
  }
})

afterAll(() => {
  vi.unstubAllGlobals()
  for (const [owner, key, descriptor] of originalMembers) {
    if (descriptor === undefined) Reflect.deleteProperty(owner, key)
    else Object.defineProperty(owner, key, descriptor)
  }
})

function assertRestrictedCapabilities(): void {
  for (const name of removedGlobals)
    expect(globalThis[name as keyof typeof globalThis]).toBeUndefined()
  for (const [owner, key] of removedMembers) expect(key in owner).toBe(false)
  expect(typeof WeakMap).toBe('function')
  expect(typeof WeakSet).toBe('function')
  expect(typeof AbortController).toBe('function')
  expect(typeof queueMicrotask).toBe('function')
  expect(typeof setTimeout).toBe('function')
  expect(typeof clearTimeout).toBe('function')
  expect(typeof setInterval).toBe('function')
  expect(typeof clearInterval).toBe('function')
  expect(typeof TextEncoder).toBe('function')
  expect(typeof TextDecoder).toBe('function')
  expect(typeof crypto.getRandomValues).toBe('function')
  expect(typeof crypto.subtle).toBe('object')
  expect(typeof crypto.randomUUID).toBe('function')
  expect(typeof ReadableStream).toBe('function')
  expect(typeof WritableStream).toBe('function')
  expect(typeof CountQueuingStrategy).toBe('function')
}

describe('runtime baseline capability smoke', () => {
  beforeEach(assertRestrictedCapabilities)

  test('runs memory persistence without optional host globals', async () => {
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

  test('renews a bound device leaf without optional host capabilities', async () => {
    const { randomIdentity } = await import('@kokuin/token')
    const { createGroup, renewLeaf, parseMLSCredentialIdentity } = await import('@kumiai/mls')
    const { nodeTypes } = await import('ts-mls')
    const { timedBinding } = (await import(
      new URL('../../mls/test/fixtures/lifecycle-pipeline.ts', import.meta.url).href
    )) as {
      timedBinding(params: {
        identity: OwnIdentity
        iat: number
        exp: number
      }): Promise<ControllerBinding>
    }
    const identity = randomIdentity()
    const now = Math.floor(Date.now() / 1000)
    const { group } = await createGroup(identity, 'baseline-bound-device', {
      controller: await timedBinding({ identity, iat: now - 20, exp: now + 1000 }),
    })
    const index = group.state.privatePath.leafIndex * 2
    const original = group.state.ratchetTree[index]
    if (original?.nodeType !== nodeTypes.leaf || !('identity' in original.leaf.credential))
      throw new Error('Missing bound device leaf')
    const credential = original.leaf.credential.identity.slice()
    const binding = await timedBinding({ identity, iat: now - 10, exp: now + 1000 })
    const result = await renewLeaf(group, binding)
    expect(result.epoch).toBe(group.epoch + 1n)
    expect(group.state.ratchetTree[index]).toBe(original)
    expect(original.leaf.credential.identity).toEqual(credential)
    const renewed = result.newGroup.state.ratchetTree[index]
    if (renewed?.nodeType !== nodeTypes.leaf || !('identity' in renewed.leaf.credential))
      throw new Error('Missing renewed device leaf')
    expect(parseMLSCredentialIdentity(renewed.leaf.credential.identity).controller).toEqual(binding)
  })

  test('carries receive progress for current and earlier retained epochs', async () => {
    const { carryReceiveFixture } = (await import(
      new URL('../../mls/test/fixtures/carry-receive-progress.ts', import.meta.url).href
    )) as {
      carryReceiveFixture(groupID: string): Promise<{
        aliceGroup: GroupHandle
        bobGroup: GroupHandle
        candidate: GroupHandle
        earlierSender: GroupHandle
      }>
    }
    const { aliceGroup, bobGroup, candidate, earlierSender } =
      await carryReceiveFixture('baseline-history')
    expect(aliceGroup.listMembers()).toHaveLength(2)
    expect(earlierSender.epoch).toBeLessThan(aliceGroup.epoch)
    const utf8 = new TextEncoder()
    await aliceGroup.encrypt(utf8.encode('current'))
    await aliceGroup.decrypt(await earlierSender.encrypt(utf8.encode('earlier')))
    await aliceGroup.carryReceiveProgress(candidate)
    const index = aliceGroup.state.privatePath.leafIndex * 2
    for (const epoch of [aliceGroup.epoch, earlierSender.epoch]) {
      const source =
        epoch === aliceGroup.epoch
          ? aliceGroup.state.secretTree
          : aliceGroup.state.historicalReceiverData.get(epoch)?.secretTree
      const live = source?.leafNodes[index]
      const copy = candidate.state.historicalReceiverData.get(epoch)?.secretTree.leafNodes[index]
      if (live == null || copy == null) throw new Error('Missing retained receive secrets')
      const bytes = copy.application.secret.slice()
      expect(bytes.some((byte) => byte !== 0)).toBe(true)
      live.application.secret.fill(0)
      expect(copy.application.secret).toEqual(bytes)
    }
    const message = utf8.encode('receive after carry')
    expect((await candidate.decrypt(await bobGroup.encrypt(message))).payload).toEqual(message)
  })

  test('deriveTopicID rejects a lone surrogate with the domain error', async () => {
    const { randomIdentity } = await import('@kokuin/token')
    const { createGroup } = await import('@kumiai/mls')
    const { deriveTopicID } = await import('@kumiai/broadcast')
    const { group } = await createGroup(randomIdentity(), 'baseline-topic')
    const secret = await group.exportSecret('runtime-baseline', new Uint8Array())
    expect(() => deriveTopicID(secret, Number(group.epoch), 'label\uD83D')).toThrowError(
      new Error('deriveTopicID: label must be well-formed UTF-16 (no lone surrogates)'),
    )
  })

  test('discoveryTopic rejects a lone surrogate with the domain error', async () => {
    const { randomIdentity } = await import('@kokuin/token')
    const { createGroup } = await import('@kumiai/mls')
    const { discoveryTopic } = await import('@kumiai/rpc')
    const { group } = await createGroup(randomIdentity(), 'baseline-discovery')
    expect(() => discoveryTopic(`${group.credential.id}\uD83D`)).toThrowError(
      new Error('discoveryTopic: memberDID must be well-formed UTF-16 (no lone surrogates)'),
    )
  })

  test('applyResolved rejects an ambiguous write with the identical abort reason', async () => {
    const { applyResolved, StorageOutcomeUnknownError } = await import('@kumiai/rpc')
    const { randomIdentity } = await import('@kokuin/token')
    const { createGroup } = await import('@kumiai/mls')
    const { createMemoryGroupPersistence, createMemoryTransaction, createOwnerQueues } =
      await import('../src/testing.js')
    const { physicalRecordKey, sealRecord } = await import('../src/persistence-codec.js')
    const { group } = await createGroup(randomIdentity(), 'baseline-aborted-write')
    const groupID = group.groupID
    const atRest = {
      async seal(bytes: Uint8Array) {
        return bytes.slice()
      },
      async open(bytes: Uint8Array) {
        return bytes.slice()
      },
    }
    const address = { groupID, incarnation: null, namespace: 'lifetime', recordID: 'current' }
    const lifetime = {
      groupID,
      latestIncarnation: 1,
      activeIncarnation: 1,
      revision: 1,
      mutationID: 'initial-group',
      restorePending: false,
    }
    const db = createMemoryTransaction({
      rows: {
        lifetime: new Map([
          [physicalRecordKey(address), await sealRecord(atRest, address, lifetime)],
        ]),
        'group-owner': new Map([
          [
            JSON.stringify([groupID, null, 'current']),
            { revision: 1, mutationID: 'initial-group' },
          ],
        ]),
      },
    })
    const groups = createMemoryGroupPersistence({
      db,
      owners: createOwnerQueues(),
      atRest,
      providerID: 'runtime-baseline',
    })
    const controller = new AbortController()
    const reason = new Error('cancelled before read-back')
    controller.abort(reason)
    const control = groups.ports({ groupID, incarnation: 1 }).control
    await expect(
      applyResolved(
        {
          ...control,
          async apply() {
            throw new StorageOutcomeUnknownError()
          },
        },
        {},
        'baseline-aborted-mutation',
        undefined,
        controller.signal,
      ),
    ).rejects.toBe(reason)
  })
})
