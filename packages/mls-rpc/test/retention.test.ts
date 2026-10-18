import { encodeEventFrame } from '@kumiai/broadcast'
import {
  commitKeyRotation,
  createGroup,
  decodeClientState,
  encodeClientState,
  type GroupHandle,
  restoreGroup,
} from '@kumiai/mls'
import { describe, expect, test } from 'vitest'

import * as api from '../src/index.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { registryOptions } from '../src/registry/validation.js'
import { createRegistryFixture } from './fixtures/registry.js'
import { restoreMemoryControlHandle } from './fixtures/sealed-memory-mls.js'

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
      const fixture = await createRegistryFixture({
        mode,
        setup: 'seeded',
        groupID,
        options: { keyRetention: { retainKeysForEpochs: 2 } },
      })
      try {
        const access = await fixture.registry.access(groupID)
        const sender = () => {
          return access.read((handle) =>
            (mode === 'real-mls' ? restoreGroup : restoreMemoryControlHandle)({
              state: structuredClone(handle.state),
              credential: handle.credential,
              ledgerEntries: handle.ledgerTokens,
              options: fixture.environment.options,
            }),
          )
        }
        const seal = async (handle: GroupHandle, position: string) => {
          return {
            frame: {
              ...access.key,
              id: `frame-${position}`,
              protocol: 'chat',
              topicID: `app-${handle.epoch}`,
              segment: Number(handle.epoch),
              position,
            },
            ciphertext: await handle.encrypt(encodeEventFrame('posted', { position })),
          }
        }
        const advance = async () => {
          const { candidate, expected, write } = await fixture.acceptedOrdinary(access)
          expect(await access.adopt(candidate, expected, write)).toBe('installed')
        }
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
