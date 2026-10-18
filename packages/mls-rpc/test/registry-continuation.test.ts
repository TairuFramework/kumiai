import { encodeClientState, restoreGroup, signLedgerEntry } from '@kumiai/mls'
import { asLogPosition, type Operation, type RecoveryContinuation } from '@kumiai/rpc'
import { describe, expect, test } from 'vitest'

import * as MlsRPC from '../src/index.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { createRealGroup } from './fixtures/real-group.js'
import {
  createRegistryFixture,
  type RegistryFixture,
  registryFixtureRecoverySource,
} from './fixtures/registry.js'
import { createRegistryRecovery } from './fixtures/registry-recovery.js'

const groupID = 'registry-continuation'
const source = { groupID, incarnation: 1 }
const destination = { groupID, incarnation: 2 }
const accepted: Operation = {
  id: 'accepted',
  kind: 'rotation',
  revokes: false,
  body: new Uint8Array([1]),
  seq: 1,
  enqueuedAt: 1,
  deadline: 100,
  stage: 'accepted',
  built: {
    incarnation: 1,
    epoch: 0,
    publishID: 'accepted-publication',
    payloadDigest: 'accepted-payload',
  },
  acceptedAs: asLogPosition('accepted-position'),
  acceptance: {
    source: { key: source, stateVersion: 1, identity: null },
    from: null,
    position: asLogPosition('accepted-position'),
    payloadDigest: 'accepted-payload',
  },
}
const owed = { id: 'owed', opID: null, at: 12, kind: 'unknown' as const }
const welcome = {
  opID: 'owed',
  welcome: new Uint8Array([9]),
  recipients: ['member'],
  committed: true as const,
}

function port(fixture: RegistryFixture) {
  expect(MlsRPC.createRecoveryContinuationPort).toBeTypeOf('function')
  return MlsRPC.createRecoveryContinuationPort({
    registry: fixture.registry,
    persistence: fixture.device.groups,
  })
}

for (const mode of ['real-mls', 'double'] as const) {
  describe(`retired recovery continuation -- ${mode}`, () => {
    async function setup(format: 'legacy' | 'captured' = 'captured') {
      const fixture = await createRegistryFixture({ mode, setup: 'seeded', groupID })
      await fixture.installRows({
        key: source,
        control: { putOperations: [accepted], putOutcomes: [owed], putWelcomes: [welcome] },
      })
      const recovery = await fixture.confirmedRecovery(source, {
        confirm: true,
        missingLedger: true,
        format,
      })
      await fixture.registry.switchIncarnation(recovery.candidate, {
        source: await fixture.registry.recoverySource(groupID),
        rejoinID: recovery.record.id,
        proof: recovery.proof,
        write: {
          mutationID:
            'format' in recovery.record ? (recovery.record.switchMutationID ?? 'switch') : 'switch',
          source: { rejoinID: recovery.record.id },
          destination: {
            control: {
              cursor: {
                position: recovery.proof.position,
                epoch: Number(recovery.candidate.epoch),
              },
            },
          },
        },
      })
      return { fixture, recovery }
    }

    test('switch leaves accepted operations for destination completion', async () => {
      const { fixture } = await setup()
      try {
        expect((await fixture.device.groups.ports(source).control.load()).operations).toEqual([
          accepted,
        ])
        expect((await fixture.device.groups.ports(source).control.load()).outcomes).toEqual([owed])
      } finally {
        await fixture.close()
      }
    })

    test('switch-before-peer restart finds the initial installation after epoch advancement', async () => {
      const s = await setup()
      let fixture = s.fixture
      try {
        const advanced = await fixture.advance(await fixture.restoreCommittedSender(groupID))
        const state = await fixture.device.groups.loadState(destination)
        const trust = await fixture.device.groups.loadTrust(groupID)
        if (state === null || state.deleted) throw new Error('Missing destination')
        await fixture.installRows({
          key: destination,
          state: {
            ...state,
            version: state.version + 1,
            epoch: Number(advanced.epoch),
            epochAuthenticator: advanced.state.keySchedule.epochAuthenticator,
            state: encodeClientState(advanced.state),
          },
          trust: recoveryTrustFor(advanced, destination, trust),
        })
        fixture = await fixture.reopen()
        const before = await fixture.inspectRows()
        const continuation = await port(fixture).loadRecoveryContinuation(destination)
        expect(continuation).toEqual({
          source,
          destination,
          record: {
            ...s.recovery.record,
            stage: 'adopted',
            ...('format' in s.recovery.record ? { destinationKey: destination } : {}),
          },
        })
        expect(await fixture.inspectRows()).toEqual(before)
        expect(fixture.restoreCount(groupID)).toBe(0)
        expect(await port(fixture).loadRecoveryContinuation(source)).toBeNull()
      } finally {
        await fixture.close()
      }
    })

    test.each(['after-first-write', 'before-commit', 'commit-then-reject'] as const)(
      'completion is atomic and retryable through %s',
      async (fault) => {
        const s = await setup()
        let fixture = s.fixture
        try {
          const continuationPort = port(fixture)
          const continuation = await continuationPort.loadRecoveryContinuation(destination)
          if (continuation === null) throw new Error('Missing continuation')
          await fixture.device.groups.ports(destination).control.apply(
            {
              cursor: {
                position: asLogPosition('destination-tip'),
                epoch: s.recovery.record.epochAfter,
                incomplete: true,
              },
            },
            'destination-progress',
          )
          const destinationBefore = await fixture.device.groups.ports(destination).control.load()
          const before = await fixture.device.groups.ports(source).control.load()
          fixture.armWorkFault('finish', fault)
          const finish = (mutationID: string) =>
            continuationPort.finishRecoveryContinuation({
              continuation,
              ledger: s.recovery.candidate.ledgerTokens,
              mutationID,
            })
          if (fault === 'commit-then-reject') await finish('finish')
          else {
            await expect(finish('finish')).rejects.toThrow()
            expect(await fixture.device.groups.ports(source).control.load()).toEqual(before)
          }
          await Promise.all([finish('finish-retry'), finish('finish-concurrent')])
          const completed = await fixture.device.groups.ports(source).control.load()
          expect(completed.rejoin).toBeNull()
          expect(completed.operations).toEqual([])
          expect(completed.welcomes).toEqual([welcome])
          expect(completed.cursor).toEqual(before.cursor)
          expect(completed.settledRejoins).toEqual(before.settledRejoins)
          expect(completed.outcomes).toEqual([
            owed,
            { id: 'accepted', opID: 'accepted', at: expect.any(Number), kind: 'unknown' },
            {
              id: s.recovery.record.id,
              opID: null,
              at: expect.any(Number),
              kind: 'reenact',
              tokens: [s.recovery.record.ledgerBefore[0]],
            },
          ])
          expect(await fixture.device.groups.ports(destination).control.load()).toEqual(
            destinationBefore,
          )
          await finish('finish-again')
          expect(await fixture.device.groups.ports(source).control.load()).toEqual(completed)
          fixture = await fixture.reopen()
          expect(await port(fixture).loadRecoveryContinuation(destination)).toBeNull()
          await port(fixture).finishRecoveryContinuation({
            continuation: {
              ...continuation,
              record: { ...continuation.record, requestKey: new Uint8Array(32) },
            },
            ledger: [],
            mutationID: 'restart-retry',
          })
          expect(await fixture.device.groups.ports(source).control.load()).toEqual(completed)
        } finally {
          await fixture.close()
        }
      },
    )

    test.each(['missing-proof', 'wrong-proof'] as const)(
      'legacy adopted record requires independent installation: %s',
      async (fault) => {
        const s = await setup('legacy')
        try {
          if (fault === 'missing-proof')
            await s.fixture.mutateMetadata(destination, (value) => ({
              ...(value as object),
              initialIdentity: null,
            }))
          else
            await s.fixture.mutateMetadata(destination, (value) => ({
              ...(value as object),
              initialIdentity: {
                ...destination,
                epoch: s.recovery.record.epochAfter,
                authenticator: new Uint8Array(32),
              },
            }))
          const before = await s.fixture.inspectRows()
          expect(await port(s.fixture).loadRecoveryContinuation(destination)).toBeNull()
          expect(await s.fixture.inspectRows()).toEqual(before)
        } finally {
          await s.fixture.close()
        }
      },
    )

    test('completion rejects a changed record and a mismatched coordinator', async () => {
      const s = await setup()
      const other = await createRegistryFixture({ mode, setup: 'empty', groupID })
      try {
        expect(() =>
          MlsRPC.createRecoveryContinuationPort({
            registry: s.fixture.registry,
            persistence: other.device.groups,
          }),
        ).toThrow(TypeError)
        const continuationPort = port(s.fixture)
        const saved = await continuationPort.loadRecoveryContinuation(destination)
        if (saved === null) throw new Error('Missing continuation')
        const changed: RecoveryContinuation = {
          ...saved,
          record: { ...saved.record, ledgerBefore: [] },
        }
        const before = await s.fixture.inspectRows()
        await expect(
          continuationPort.finishRecoveryContinuation({
            continuation: changed,
            ledger: [],
            mutationID: 'invalid-completion',
          }),
        ).rejects.toThrow()
        expect(await s.fixture.inspectRows()).toEqual(before)
      } finally {
        await Promise.all([s.fixture.close(), other.close()])
      }
    })
  })
}

test('captured switch resumes its empty destination ledger and preserves settled obligations', async () => {
  const real = await createRealGroup(2, groupID)
  const requester = real.members[0]
  const responder = real.members[1]
  if (requester === undefined || responder === undefined) throw new Error('Missing members')
  let fixture = await createRegistryFixture({
    mode: 'real-mls',
    setup: 'empty',
    groupID,
    identity: requester.identity,
  })
  try {
    const handle = requester.handle
    const trust = recoveryTrustFor(handle, source, null)
    await fixture.installRows({
      key: source,
      state: {
        ...source,
        version: 1,
        deleted: false,
        terminal: false,
        epoch: Number(handle.epoch),
        epochAuthenticator: handle.state.keySchedule.epochAuthenticator,
        state: encodeClientState(handle.state),
        credential: handle.credential,
        ledger: handle.ledgerTokens,
        senderHWM: 0,
      },
      trust,
    })
    const recovery = await createRegistryRecovery({
      mode: 'real-mls',
      format: 'captured',
      recoverySource: await registryFixtureRecoverySource(fixture, source),
      identity: requester.identity,
      options: fixture.environment.options,
      source: handle,
      sourceKey: source,
      sourceTrust: (await fixture.device.groups.loadTrust(groupID)) ?? undefined,
      responder: { identity: responder.identity, group: responder.handle },
    })
    const missing = await signLedgerEntry(requester.identity, {
      type: 'kumiai.role',
      groupID,
      subject: requester.identity.id,
      value: 'member',
    })
    recovery.record.ledgerBefore = [missing, ...handle.ledgerTokens, missing]
    const settled = {
      kind: 'accepted-unadoptable' as const,
      id: 'settled-before',
      digest: 'prior-commit',
      payloadDigest: 'prior-payload',
      epochAfter: recovery.record.epochAfter,
      acceptedEpoch: recovery.record.epochAfter,
      origin: {
        sourceKey: source,
        target: recovery.record.target,
        searchFrom: recovery.record.searchFrom,
      },
      leafDigest: 'prior-leaf',
      ledgerBefore: [missing],
    }
    await fixture.installRows({
      key: source,
      control: {
        putRejoin: recovery.record,
        putOperations: [accepted],
        putOutcomes: [owed],
        putWelcomes: [welcome],
        putSettledRejoins: [settled],
        recoveryEpochFloor: Number(handle.epoch),
        cursor: {
          position: asLogPosition('source-gap'),
          epoch: Number(handle.epoch),
          incomplete: true,
        },
      },
    })
    const candidate = await restoreGroup({
      state: recovery.candidate.state,
      credential: handle.credential,
      ledgerEntries: [],
      options: fixture.environment.options,
    })
    expect(await candidate.isLedgerComplete()).toBe(false)
    await fixture.registry.switchIncarnation(candidate, {
      source: await fixture.registry.recoverySource(groupID),
      rejoinID: recovery.record.id,
      proof: recovery.proof,
      write: {
        mutationID: recovery.record.switchMutationID as string,
        source: { rejoinID: recovery.record.id },
        destination: {
          control: {
            cursor: { position: recovery.proof.position, epoch: recovery.record.epochAfter },
          },
        },
      },
    })
    fixture = await fixture.reopen()
    const continuationPort = port(fixture)
    const continuation = await continuationPort.loadRecoveryContinuation(destination)
    expect(continuation?.record).toEqual({
      ...recovery.record,
      stage: 'adopted',
      destinationKey: destination,
    })
    if (continuation === null) throw new Error('Missing captured continuation')
    const access = await fixture.registry.access(groupID)
    expect(await access.read((handle) => handle.isLedgerComplete())).toBe(false)
    // Bootstrap verifies the authenticated head before any fold or commit judgement.
    await access.mutate(async (handle, persist) => {
      await handle.bootstrapLedger(responder.handle.ledgerTokens, { persist })
    })
    expect(await access.read((handle) => handle.isLedgerComplete())).toBe(true)
    const before = await fixture.device.groups.ports(destination).control.load()
    await continuationPort.finishRecoveryContinuation({
      continuation,
      ledger: await access.read((handle) => handle.ledgerTokens),
      mutationID: 'captured-finish',
    })
    const completed = await fixture.device.groups.ports(source).control.load()
    expect(completed.rejoin).toBeNull()
    expect(completed.operations).toEqual([])
    expect(completed.outcomes).toEqual([
      owed,
      { id: 'accepted', opID: 'accepted', kind: 'unknown', at: expect.any(Number) },
      {
        id: recovery.record.id,
        opID: null,
        kind: 'reenact',
        tokens: [missing],
        at: expect.any(Number),
      },
    ])
    expect(completed.settledRejoins).toEqual([settled])
    expect(completed.recoveryEpochFloor).toBe(Number(handle.epoch))
    expect(completed.welcomes).toEqual([welcome])
    expect(completed.cursor?.incomplete).toBe(true)
    expect(await fixture.device.groups.ports(destination).control.load()).toEqual(before)
    expect(await continuationPort.loadRecoveryContinuation(destination)).toBeNull()
  } finally {
    await fixture.close()
  }
})
