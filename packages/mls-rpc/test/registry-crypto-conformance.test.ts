import { AppFrameStorageError, isAppFrameStorageError } from '@kumiai/rpc'
import {
  testGroupCryptoConformance,
  testPendingGroupCryptoConformance,
  testRegistryCryptoConformance,
} from '@kumiai/rpc-conformance'
import { expect, test, vi } from 'vitest'

import * as registryFixtures from './fixtures/registry.js'
import {
  createRegistryCryptoFixture,
  createRegistryCryptoGroup,
  createRegistryPendingCryptoFixture,
} from './fixtures/registry-crypto.js'

for (const mode of ['real-mls', 'double'] as const) {
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
      const fixture = await createRegistryPendingCryptoFixture(mode, 'invalid-position-fault')
      const payload = fixture.encode?.('retry')
      if (payload === undefined) throw new Error('Missing event encoder')
      const sealed = await fixture.sender.wrap(payload)
      const frame = fixture.frame?.(sealed, {
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
    createFixture: (id) => createRegistryCryptoFixture(mode, id),
  })

  testGroupCryptoConformance({
    label: `registry / ${mode}`,
    createGroup: async (size, id) => {
      const group = await createRegistryCryptoGroup(mode, id, size)
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
    createFixture: (id) => createRegistryPendingCryptoFixture(mode, id),
  })
}
