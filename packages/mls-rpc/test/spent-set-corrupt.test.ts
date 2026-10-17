import {
  SpentSetCorruptError as RpcSpentSetCorruptError,
  recoveryUnavailableEventID,
} from '@kumiai/rpc'
import { describe, expect, test } from 'vitest'

import { type AccountedGroupObservation, entryCapability } from '../src/entry-capability.js'
import { SpentSetCorruptError } from '../src/index.js'
import { GroupStateUncertainError, StorageOutcomeUnknownError } from '../src/persistence-errors.js'
import { admissionFor } from '../src/registry/cold.js'
import { accountedRuntime } from '../src/registry/runtime-facts.js'
import { registrySafety } from '../src/registry/safety.js'
import { groupCondition } from '../src/safety-conditions.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import {
  createNotMemberFixture,
  createRegistryFixture,
  type RegistryFixture,
  registryFixtureTrustReads,
} from './fixtures/registry.js'

for (const mode of ['real-mls', 'double'] as const) {
  for (const context of ['supplied', 'absent'] as const) {
    describe(`spent corruption / ${mode} / ownership context ${context}`, () => {
      const groupID = `spent-corruption-${mode}-${context}`
      const key = { groupID, incarnation: 1 }
      async function run(fn: (fixture: RegistryFixture) => Promise<void>) {
        const fixture = await createRegistryFixture({
          mode,
          setup: 'seeded',
          groupID,
          ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        })
        try {
          await fn(fixture)
        } finally {
          await fixture.close()
        }
      }
      async function assertCorrupt(f: RegistryFixture) {
        expect(await f.safety().status(key)).toMatchObject({
          hold: 'spent-set-corrupt',
          condition: 'spent-set-corrupt',
          evidence: null,
        })
        const events = (await f.safety().events(key)).filter((e) => e.kind === 'spent-set-corrupt')
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({ ...key, id: expect.any(String), evidence: null })
        expect((await f.device.groups.ports(key).control.load()).recoveryUnavailable).toBeNull()
        const event = events[0]
        if (event === undefined) throw new Error('Missing corruption event')
        return event
      }
      test('condition precedence preserves all evidence', async () => {
        const f = await createNotMemberFixture({
          mode,
          ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        })
        let reopened: RegistryFixture | undefined
        try {
          const local = f.local()
          const safety = local.safety()
          const access = await local.registry.access(f.key.groupID)
          const originalAdmission = access.admission()
          expect(await safety.status(f.key)).toMatchObject({ hold: null, condition: null })
          await f.diagnose(await f.proof())
          const notMember = await safety.status(f.key)
          expect(notMember).toMatchObject({ hold: null, condition: 'not-member' })
          expect(access.admission()).toEqual(originalAdmission)
          await local.installRows({
            key: f.key,
            control: {
              recoveryUnavailable: {
                ...f.key,
                id: recoveryUnavailableEventID(f.key),
                kind: 'group:recovery-unavailable',
                reason: 'trust-unreadable',
              },
            },
          })
          expect(await safety.status(f.key)).toMatchObject({
            hold: 'recovery-unavailable',
            condition: 'not-member',
            evidence: notMember.evidence,
          })
          expect(access.admission()).toMatchObject({ reason: 'recovery-unavailable' })
          // App-report provenance is captured before the spent envelope is damaged.
          const identity = await safety.epochAuthenticator(f.key)
          if (identity === null) throw new Error('Missing identity')
          const remote = identity.authenticator.slice()
          remote[0] = (remote[0] ?? 0) ^ 1
          await safety.reportFork(f.key, {
            kind: 'epoch-authenticator',
            epoch: identity.epoch,
            local: identity.authenticator,
            remote,
          })
          await local.corruptTrust(f.key.groupID, 'empty-spent')
          await expect(local.registry.recoverySource(f.key.groupID)).rejects.toMatchObject({
            name: 'SpentSetCorruptError',
          })
          expect(await safety.status(f.key)).toMatchObject({
            hold: 'fork-halted',
            condition: 'spent-set-corrupt',
          })
          expect(access.admission()).toMatchObject({ reason: 'fork-halted' })
          const records = await f.service().readRecords()
          expect(
            records
              .filter((row) => row.kind === 'condition' && row.active)
              .map((row) => (row.kind === 'condition' ? row.event.kind : null)),
          ).toEqual(expect.arrayContaining(['not-member', 'spent-set-corrupt']))
          expect(
            (await local.device.groups.ports(f.key).control.load()).recoveryUnavailable,
          ).not.toBeNull()
          expect(
            groupCondition(
              records.map((row) =>
                row.kind === 'condition' && row.event.kind === 'spent-set-corrupt'
                  ? { ...row, event: { ...row.event, detectedAt: 0 } }
                  : row,
              ),
              f.key,
            ).condition,
          ).toBe('spent-set-corrupt')
          await safety.clearHold(f.key)
          expect(await safety.status(f.key)).toMatchObject({
            hold: 'spent-set-corrupt',
            condition: 'spent-set-corrupt',
          })
          expect(access.admission()).toMatchObject({ reason: 'spent-set-corrupt' })
          reopened = await local.reopen()
          expect(await reopened.safety().status(f.key)).toMatchObject({
            hold: 'spent-set-corrupt',
            condition: 'spent-set-corrupt',
          })
          const capability = entryCapability(reopened.device.groups)
          if (capability === null) throw new Error('Missing capability')
          const retained = await capability.read(f.key.groupID, (reads) => reads.checkpoints())
          expect(retained.filter((row) => row.kind === 'condition' && row.active)).toEqual(
            records.filter((row) => row.kind === 'condition' && row.active),
          )
          expect(
            (await reopened.device.groups.ports(f.key).control.load()).recoveryUnavailable,
          ).not.toBeNull()
        } finally {
          await reopened?.close()
          await f.close()
        }
      })
      test('decrypted trust with missing spent set reports spent corruption', () =>
        run(async (f) => {
          await f.corruptTrust(groupID, 'missing-spent')
          await expect(f.registry.recoverySource(groupID)).rejects.toBeInstanceOf(
            SpentSetCorruptError,
          )
          const event = await assertCorrupt(f)
          const reopened = await f.reopen()
          try {
            await expect(reopened.registry.access(groupID)).rejects.toMatchObject({
              name: 'SpentSetCorruptError',
            })
            expect(await assertCorrupt(reopened)).toEqual(event)
          } finally {
            await reopened.close()
          }
        }))
      test('seeded corruption throws the documented rpc error class with its key', () =>
        run(async (f) => {
          await f.corruptTrust(groupID, 'missing-spent')
          const error = await f.registry.recoverySource(groupID).then(
            () => null,
            (cause: unknown) => cause,
          )
          expect(error).toBeInstanceOf(RpcSpentSetCorruptError)
          expect(SpentSetCorruptError).toBe(RpcSpentSetCorruptError)
          expect((error as RpcSpentSetCorruptError).key).toEqual(key)
        }))
      test.each(['empty-spent', 'malformed-spent'] as const)(
        'empty or malformed set never becomes empty baseline: %s',
        (damage) =>
          run(async (f) => {
            await f.corruptTrust(groupID, damage)
            const fresh = await f.makeHandle(2)
            await expect(
              f.registry.seed(fresh, {
                replace: true,
                packageUse: { sourceID: 'source', ref: 'fresh', kind: 'ordinary' },
              }),
            ).rejects.toMatchObject({ name: 'SpentSetCorruptError' })
            await assertCorrupt(f)
            await expect(f.registry.access(groupID)).rejects.toMatchObject({
              name: 'SpentSetCorruptError',
            })
            expect((await f.device.groups.load(groupID))?.activeIncarnation).toBe(1)
          }),
      )
      test('readable projections cannot hide a persisted spent condition', () =>
        run(async (f) => {
          const access = await f.registry.access(groupID)
          const capability = entryCapability(f.device.groups)
          if (capability === null) throw new Error('Missing capability')
          const observations: Array<AccountedGroupObservation> = []
          const unsubscribe = capability.observe(groupID, (observation) => {
            observations.push(observation)
          })
          try {
            await capability.run(
              { groupID, mutationID: crypto.randomUUID() },
              async (reads) => ({ expected: await reads.lifetime(), value: null }),
              async () => {},
            )
          } finally {
            unsubscribe()
          }
          const observation = observations.at(-1)
          const snapshot = access.runtime.snapshot()
          const record = await f.device.groups.loadState(key)
          const trust = await f.device.groups.loadTrust(groupID)
          const control = await f.device.groups.ports(key).control.load()
          if (
            observation === undefined ||
            snapshot === null ||
            record === null ||
            record.deleted ||
            record.state === null ||
            trust === null
          )
            throw new Error('Missing readable projection')
          expect(
            accountedRuntime({
              observation: { ...observation, condition: 'spent-set-corrupt' },
              groupID,
              ownerDID: f.identity.id,
              previous: null,
            })?.admission,
          ).toMatchObject({ admissible: false, reason: 'spent-set-corrupt' })
          expect(
            admissionFor(
              {
                key,
                record: { ...record, state: record.state },
                trust,
                snapshot: { ...snapshot, condition: 'spent-set-corrupt' },
                ownMember: true,
                lapsed: false,
              },
              control,
            ),
          ).toMatchObject({ admissible: false, reason: 'spent-set-corrupt' })
        }))
      test('healthy committed mutations start no diagnostic trust read', () =>
        run(async (f) => {
          await f.registry.access(groupID)
          const capability = entryCapability(f.device.groups)
          if (capability === null) throw new Error('Missing capability')
          const mutate = () =>
            capability.run(
              { groupID, mutationID: crypto.randomUUID() },
              async (reads) => ({ expected: await reads.lifetime(), value: null }),
              async () => {},
            )
          // Owner reads are queued, so a later read drains any diagnosis the commit started.
          const drain = () => capability.read(groupID, async () => {})
          await mutate()
          await drain()
          const before = registryFixtureTrustReads(f)
          for (let index = 0; index < 3; index++) await mutate()
          await drain()
          expect(registryFixtureTrustReads(f)).toBe(before)
          expect(await f.safety().status(key)).toMatchObject({ hold: null, condition: null })
        }))
      test('failed condition persistence preserves the spent corruption error and latch', () =>
        run(async (f) => {
          await f.corruptTrust(groupID, 'empty-spent')
          f.armNextWorkFault('before-commit')
          await expect(f.registry.recoverySource(groupID)).rejects.toMatchObject({
            name: 'SpentSetCorruptError',
          })
          expect(registrySafety(f.registry)?.held(key)).toBe('spent-set-corrupt')
          await expect(f.registry.access(groupID)).rejects.toMatchObject({
            name: 'SpentSetCorruptError',
          })
          await assertCorrupt(f)
        }))
      test('latched hard hold outranks durable spent corruption', () =>
        run(async (f) => {
          await f.corruptTrust(groupID, 'empty-spent')
          await expect(f.registry.access(groupID)).rejects.toMatchObject({
            name: 'SpentSetCorruptError',
          })
          registrySafety(f.registry)?.latch(key, 'fork-halted')
          expect(await f.safety().status(key)).toMatchObject({
            hold: 'fork-halted',
            condition: 'spent-set-corrupt',
          })
        }))
      test('status diagnoses surviving spent data without prior access', () =>
        run(async (f) => {
          await f.corruptTrust(groupID, 'empty-spent')
          expect(await f.safety().status(key)).toMatchObject({
            hold: 'spent-set-corrupt',
            condition: 'spent-set-corrupt',
          })
          await assertCorrupt(f)
        }))
      test('unreadable combined envelope stays recovery unavailable', () =>
        run(async (f) => {
          await f.corruptTrust(groupID)
          await expect(f.registry.access(groupID)).rejects.toMatchObject({
            reason: 'recovery-unavailable',
          })
          expect(await f.safety().status(key)).toEqual({
            hold: 'recovery-unavailable',
            condition: null,
            evidence: null,
            manualRecovery: null,
          })
        }))
      test('clearHold and event ack cannot repair corruption', () =>
        run(async (f) => {
          const identity = await f.safety().epochAuthenticator(key)
          if (identity === null) throw new Error('Missing identity')
          const remote = identity.authenticator.slice()
          remote[0] = (remote[0] ?? 0) ^ 1
          await f.safety().reportFork(key, {
            kind: 'epoch-authenticator',
            epoch: identity.epoch,
            local: identity.authenticator,
            remote,
          })
          await f.corruptTrust(groupID, 'empty-spent')
          await expect(f.registry.access(groupID)).rejects.toMatchObject({
            name: 'SpentSetCorruptError',
          })
          expect(await f.safety().status(key)).toMatchObject({
            hold: 'fork-halted',
            condition: 'spent-set-corrupt',
          })
          const event = (await f.safety().events(key)).find((e) => e.kind === 'spent-set-corrupt')
          if (event === undefined) throw new Error('Missing corruption event')
          await f.safety().ackEvent(key, event.id)
          await f.safety().clearHold(key)
          expect(await f.safety().status(key)).toMatchObject({
            hold: 'spent-set-corrupt',
            condition: 'spent-set-corrupt',
          })
          await expect(
            f.safety().reportFork(key, {
              kind: 'unexplained-own-commit',
              epoch: 0,
              position: '1',
              digest: 'remote',
            }),
          ).rejects.toMatchObject({ name: 'GroupSafetyHeldError', reason: 'spent-set-corrupt' })
        }))
      test.each([
        new Error('Transient provider error'),
        new GroupStateUncertainError('Storage uncertain'),
        new StorageOutcomeUnknownError('Storage outcome unknown'),
      ])('transient provider error is not corruption: %s', (error) =>
        run(async (f) => {
          f.failTrustReads(error)
          await expect(f.registry.access(groupID)).rejects.toBe(error)
          f.failTrustReads(null)
          expect(await f.safety().status(key)).toEqual({
            hold: null,
            condition: null,
            evidence: null,
            manualRecovery: null,
          })
          expect(await f.safety().events(key)).toEqual([])
        }),
      )
      test.each(['empty-spent', 'malformed-spent'] as const)(
        'warm observation persists spent corruption across restart: %s',
        (damage) =>
          run(async (f) => {
            const access = await f.registry.access(groupID)
            await access.read(() => {})
            expect(access.runtime.snapshot()).not.toBeNull()
            await f.corruptTrust(groupID, damage)
            const capability = entryCapability(f.device.groups)
            if (capability === null) throw new Error('Missing capability')
            await capability.run(
              { groupID, mutationID: crypto.randomUUID() },
              async (reads) => ({ expected: await reads.lifetime(), value: null }),
              async () => {},
            )
            await expect
              .poll(() =>
                capability.read(groupID, async (reads) =>
                  (await reads.checkpoints()).filter(
                    (row) => row.kind === 'condition' && row.event.kind === 'spent-set-corrupt',
                  ),
                ),
              )
              .toHaveLength(1)
            expect(access.admission()).toMatchObject({
              admissible: false,
              reason: 'spent-set-corrupt',
            })
            expect(registrySafety(f.registry)?.held(key)).toBe('spent-set-corrupt')
            const event = await assertCorrupt(f)
            const reopened = await f.reopen()
            try {
              expect(await assertCorrupt(reopened)).toEqual(event)
            } finally {
              await reopened.close()
            }
          }),
      )
    })
  }
}

test('total key and database loss permits fresh same group invite', async () => {
  const { randomIdentity } = await import('@kokuin/token')
  const { createGroup, createKeyPackageBundle, createInvite, commitInvite, processWelcome } =
    await import('@kumiai/mls')
  const author = randomIdentity()
  const identity = randomIdentity()
  const groupID = 'total-loss-fresh-invite'
  const options = {
    keyRetention: { retainKeysForGenerations: 1000, maximumForwardRatchetSteps: 1000 },
  }
  const base = (await createGroup(author, groupID, options)).group
  const { invite } = await createInvite({
    group: base,
    identity: author,
    recipientDID: identity.id,
    permission: 'member',
  })
  const oldBundle = await createKeyPackageBundle(identity, options)
  const old = await commitInvite(base, oldBundle.publicPackage, invite)
  const joined = (
    await processWelcome({
      identity,
      invite,
      welcome: old.welcomeMessage,
      keyPackageBundle: oldBundle,
      ratchetTree: old.newGroup.state.ratchetTree,
      options,
    })
  ).group
  const previous = await createRegistryFixture({
    mode: 'real-mls',
    setup: 'empty',
    groupID,
    identity,
    options,
  })
  try {
    await previous.registry.seed(joined, {
      packageUse: { sourceID: 'old', ref: 'old-package', kind: 'ordinary' },
    })
  } finally {
    await previous.close()
  }
  // Only the signing identity survives. Package keys and all persistence are new.
  const freshBundle = await createKeyPackageBundle(identity, options)
  await expect(
    processWelcome({
      identity,
      invite,
      welcome: old.welcomeMessage,
      keyPackageBundle: freshBundle,
      ratchetTree: old.newGroup.state.ratchetTree,
      options,
    }),
  ).rejects.toThrow()
  const fresh = await commitInvite(base, freshBundle.publicPackage, invite)
  const rejoined = (
    await processWelcome({
      identity,
      invite,
      welcome: fresh.welcomeMessage,
      keyPackageBundle: freshBundle,
      ratchetTree: fresh.newGroup.state.ratchetTree,
      options,
    })
  ).group
  const next = await createRegistryFixture({
    mode: 'real-mls',
    setup: 'empty',
    groupID,
    identity,
    options,
  })
  try {
    expect(
      await next.registry.seed(rejoined, {
        packageUse: { sourceID: 'fresh', ref: 'fresh-package', kind: 'ordinary' },
      }),
    ).toEqual({ groupID, incarnation: 1 })
    expect((await next.registry.access(groupID)).admission().admissible).toBe(true)
  } finally {
    await next.close()
  }
})
