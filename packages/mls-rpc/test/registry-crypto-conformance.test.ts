import { AppFrameStorageError, isAppFrameStorageError } from '@kumiai/rpc'
import {
  testGroupCryptoConformance,
  testPendingGroupCryptoConformance,
  testRegistryCryptoConformance,
} from '@kumiai/rpc-conformance'
import { expect, test, vi } from 'vitest'

import { sourceResultBinding } from '../src/registry/source-crypto-commands.js'
import { registrySourceExecutor } from '../src/registry/source-executor.js'
import * as registryFixtures from './fixtures/registry.js'
import {
  createRegistryCryptoFixture,
  createRegistryCryptoGroup,
  createRegistryPendingCryptoFixture,
} from './fixtures/registry-crypto.js'
import { testRegistryBackgroundWarmup } from './fixtures/registry-maintenance.js'

for (const mode of ['real-mls', 'double'] as const) {
  test(`managed crypto bytes retain their originating source binding (${mode})`, async () => {
    const group = await createRegistryCryptoGroup(mode, crypto.randomUUID(), 2, {
      backgroundMaintenance: 'gated',
    })
    try {
      const commands = vi.spyOn(
        registrySourceExecutor(group.fixture().registry).executor,
        'execute',
      )
      const crypto = group.receiver()
      const sealed = await crypto.wrap(new Uint8Array([1]))
      expect(sourceResultBinding(sealed)?.key).toEqual(group.key)
      const entries = await crypto.sealEntries(new Uint8Array([2]))
      expect(sourceResultBinding(entries.sealed)?.key).toEqual(group.key)
      expect(await crypto.openEntries(entries.sealed)).toEqual(new Uint8Array([2]))
      await crypto.exportSecret('host-owned')
      expect(commands.mock.calls.map(([request]) => request.command)).toEqual([
        'app.seal',
        'crypto.sealEntries',
        'crypto.openEntries',
        'crypto.export',
      ])
      expect(commands.mock.calls.at(-1)?.[0].input).toEqual({ label: 'host-owned', length: 32 })
    } finally {
      await group.close()
    }
  })
  test(`invalid-position unwrap leaves persistence faults for write-staging calls (${mode})`, async () => {
    const original = registryFixtures.createRegistryFixture
    let arm: { mock: { calls: Array<unknown> } } | undefined
    const factory = vi
      .spyOn(registryFixtures, 'createRegistryFixture')
      .mockImplementation(async (params) => {
        const fixture = await original(params)
        arm = vi.spyOn(fixture, 'armNextWorkFault')
        return fixture
      })
    try {
      const fixture = await createRegistryPendingCryptoFixture(
        mode,
        'invalid-position-fault',
        'gated',
      )
      const payload = fixture.encode?.('retry')
      if (payload === undefined) throw new Error('Missing event encoder')
      const sealed = await fixture.sender.wrap(payload)
      const frame = fixture.frame?.(sealed, {
        groupID: 'pending-group',
        incarnation: 1,
        id: 'invalid-position',
        topicID: 'app-topic',
        protocol: 'chat',
        segment: 1,
        position: '',
      })
      if (frame === undefined || arm === undefined) throw new Error('Missing fault instrumentation')
      const calls = fixture.persistCalls()
      fixture.failPersist(true)
      await expect(fixture.receiver.unwrap(sealed, { frame })).rejects.toThrow('invalid-position')
      expect(arm.mock.calls).toHaveLength(0)
      expect(fixture.persistCalls()).toBe(calls)
      expect(await fixture.receiver.pending.list()).toEqual([])
      const valid = { ...frame, position: '000000000001' }
      await expect(fixture.receiver.unwrap(sealed, { frame: valid })).rejects.toBeInstanceOf(
        AppFrameStorageError,
      )
      expect(arm.mock.calls).toHaveLength(1)
      expect(fixture.persistCalls()).toBe(calls)
      expect(await fixture.receiver.pending.list()).toEqual([])
      fixture.failPersist(false)
      expect(await fixture.receiver.unwrap(sealed, { frame: valid })).toMatchObject({ payload })
      expect(fixture.persistCalls()).toBe(calls + 1)
    } finally {
      factory.mockRestore()
    }
  })

  testRegistryCryptoConformance({
    label: `registry / ${mode}`,
    createFixture: (id) => createRegistryCryptoFixture(mode, id, 'gated'),
  })

  testGroupCryptoConformance({
    label: `registry / ${mode}`,
    createGroup: async (size, id) => {
      const group = await createRegistryCryptoGroup(mode, id, size, {
        backgroundMaintenance: 'gated',
      })
      return {
        members: group.members,
        setEpochHintOffset: group.setEpochHintOffset,
        advance: () => group.advance(),
        removeMember: (index) => group.advance(index),
        dispose: group.close,
      }
    },
  })

  testPendingGroupCryptoConformance({
    label: `registry / ${mode}`,
    isStorageError: isAppFrameStorageError,
    createFixture: (id) => createRegistryPendingCryptoFixture(mode, id, 'gated'),
  })
}

testRegistryBackgroundWarmup('crypto-conformance')
