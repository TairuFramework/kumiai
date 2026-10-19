import { encodeEventFrame } from '@kumiai/broadcast'
import {
  commitKeyRotation,
  createGroup,
  decodeClientState,
  encodeClientState,
  type GroupHandle,
  restoreGroup,
} from '@kumiai/mls'
import { frameID } from '@kumiai/rpc'
import { describe, expect, test } from 'vitest'

import * as api from '../src/index.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { registryOptions } from '../src/registry/validation.js'
import { createRegistryFixture } from './fixtures/registry.js'
import { createRegistryCryptoGroup } from './fixtures/registry-crypto.js'

test('epoch retention defaults to 4 and caps at 32', () => {
  expect(registryOptions({}).keyRetention?.retainKeysForEpochs).toBe(4)
  expect(registryOptions({ keyRetention: { retainKeysForEpochs: 32 } }).keyRetention).toMatchObject(
    {
      retainKeysForEpochs: 32,
    },
  )
  expect(registryOptions({ keyRetention: { retainKeysForEpochs: 1 } }).keyRetention).toMatchObject({
    retainKeysForEpochs: 1,
  })
  for (const value of [0, 33, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => registryOptions({ keyRetention: { retainKeysForEpochs: value } })).toThrow(
      api.KeyRetentionRangeError,
    )
  }
})

test('epoch retention refuses nonnumeric values', () => {
  for (const retainKeysForEpochs of [null, '2', true]) {
    expect(() =>
      Reflect.apply(registryOptions, undefined, [{ keyRetention: { retainKeysForEpochs } }]),
    ).toThrow(api.KeyRetentionRangeError)
  }
})

for (const mode of ['real-mls', 'double'] as const) {
  describe(`registry retention -- ${mode}`, () => {
    test('restore refuses a state holding more retained epochs than configured', async () => {
      const fixture = await createRegistryFixture({
        mode,
        setup: 'empty',
        groupID: `retention-restore-${mode}`,
        options: { keyRetention: { retainKeysForEpochs: 2 } },
      })
      try {
        let handle = (
          await createGroup(fixture.identity, `retention-restore-${mode}`, registryOptions({}))
        ).group
        for (let index = 0; index < 3; index++) handle = (await commitKeyRotation(handle)).newGroup
        fixture.overrideRestore(async (record) => {
          const state = decodeClientState(record.state)
          if (state === undefined) throw new Error('Missing restored state')
          return restoreGroup({
            state,
            credential: record.credential,
            ledgerEntries: record.ledger,
            options: fixture.environment.options,
          })
        })
        expect(handle.state.historicalReceiverData.size).toBe(3)
        const key = { groupID: handle.groupID, incarnation: 1 }
        await fixture.installRows({
          key,
          state: {
            ...key,
            deleted: false,
            terminal: false,
            version: 1,
            epoch: Number(handle.epoch),
            epochAuthenticator: handle.state.keySchedule.epochAuthenticator.slice(),
            state: encodeClientState(handle.state),
            credential: handle.credential,
            ledger: handle.ledgerTokens,
            senderHWM: 0,
          },
          trust: recoveryTrustFor(handle, key, null),
        })
        const before = await fixture.inspectRows()
        await expect(fixture.registry.access(key.groupID)).rejects.toMatchObject({
          name: 'GroupUnavailableError',
          reason: 'invalid',
          cause: {
            name: 'GroupStateConflictError',
            message: 'Registry retained epoch limit exceeded',
          },
        })
        expect(await fixture.inspectRows()).toEqual(before)
      } finally {
        await fixture.close()
      }
    })

    test('non-default retention is honoured', async () => {
      const groupID = `retention-window-${mode}`
      const group = await createRegistryCryptoGroup(mode, groupID, 1, {
        options: { keyRetention: { retainKeysForEpochs: 2 } },
      })
      const fixture = group.fixture()
      try {
        const access = group.access()
        const sender = () => group.sender.handle
        const seal = async (handle: GroupHandle, position: string) => {
          const topicID = `app-${handle.epoch}`
          const ciphertext = await handle.encrypt(encodeEventFrame('posted', { position }))
          return {
            frame: {
              ...access.key,
              id: frameID(topicID, ciphertext),
              protocol: 'chat',
              topicID,
              segment: Number(handle.epoch),
              position,
            },
            ciphertext,
          }
        }
        const advance = () => group.advance()
        const epoch = access.epoch()
        const first = await sender()
        const f0 = await seal(first, '00000')
        const f1 = await seal(first, '00001')
        await advance()
        const f2 = await seal(await sender(), '00002')
        await advance()
        expect(access.epoch()).toBe(epoch + 2)
        expect(
          await access.read((handle) => [...handle.state.historicalReceiverData.keys()]),
        ).toEqual([BigInt(epoch), BigInt(epoch + 1)])
        expect(await access.openBatch([f1, f2])).toMatchObject([
          { kind: 'opened' },
          { kind: 'opened' },
        ])
        await advance()
        expect(
          await access.read((handle) => [...handle.state.historicalReceiverData.keys()]),
        ).toEqual([BigInt(epoch + 1), BigInt(epoch + 2)])
        expect(await access.openBatch([f0])).toMatchObject([
          { kind: 'refused', reason: 'past-epoch', keyConsumed: false },
        ])
      } finally {
        await fixture.close()
      }
    })
  })
}
