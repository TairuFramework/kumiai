import { describe, expect, test } from 'vitest'

import type {
  ConformanceAcceptedRejoinSettlement,
  ConformanceCapturedRejoinRecord,
  ConformanceControlStore,
} from './control-store.js'
import type { ConformanceGroupKey } from './persistence-fixture.js'
import type { ConformanceRegistryFixture, ConformanceRegistryHandle } from './registry-fixture.js'

export type ConformanceCallTimeRecoveryTarget<Hub> = {
  targetID: string
  hub: Hub
  commitTopicID: string
}

export type ConformancePersistedManualRecovery =
  | { mode: 'resync'; targetID: string; commitTopicID: string; allowOpenFork: boolean }
  | { mode: 'successor'; successor: ConformanceGroupKey }
export type ConformanceManualRecoveryRecord<Position extends string = string> = {
  id: string
  source: ConformanceGroupKey
  choice: ConformancePersistedManualRecovery
  stage: 'authorised' | 'completed'
  pauseReason: 'target-unresolved' | null
  destination: ConformanceGroupKey | null
  attempt: ConformanceCapturedRejoinRecord<Position> | null
  epochFloor: number | null
  settlements: Array<ConformanceAcceptedRejoinSettlement<Position>>
  mutationID: string
}
export type ConformanceManualRecoveryStatus = {
  id: string
  kind: 'pending' | 'paused' | 'completed'
  reason: 'target-unresolved' | null
}
export type ConformanceManualRecoveryStore = {
  authoriseManualRecovery(
    key: ConformanceGroupKey,
    choice: ConformancePersistedManualRecovery,
  ): Promise<ConformanceManualRecoveryRecord>
  manualRecoveryControl(id: string): ConformanceControlStore
  readManualRecovery(id: string): Promise<ConformanceManualRecoveryRecord | null>
}

export function testManualRecoveryConformance<THandle extends ConformanceRegistryHandle>(params: {
  label: string
  createFixture(): Promise<ConformanceRegistryFixture<THandle>>
}) {
  describe(`manual recovery storage / ${params.label}`, () => {
    const choice = {
      mode: 'resync' as const,
      targetID: 'selected-hub',
      commitTopicID: 'selected-commits',
      allowOpenFork: true,
    }
    async function run(
      fn: (fixture: ConformanceRegistryFixture<THandle>, key: ConformanceGroupKey) => Promise<void>,
    ) {
      const fixture = await params.createFixture()
      try {
        await fn(fixture, { groupID: 'manual-recovery', incarnation: 1 })
      } finally {
        await fixture.close()
      }
    }
    async function selected(
      fixture: ConformanceRegistryFixture<THandle>,
      key: ConformanceGroupKey,
    ) {
      const recovery = await fixture.confirmedRecovery(key, { confirm: true })
      if (!('format' in recovery.record)) throw new Error('Captured candidate required')
      const saved = await fixture.manualRecovery().authoriseManualRecovery(key, {
        mode: 'resync',
        targetID: recovery.record.target.targetID,
        commitTopicID: recovery.record.target.topicID,
        allowOpenFork: true,
      })
      const overlay = fixture.manualRecovery().manualRecoveryControl(saved.id)
      const record = {
        ...recovery.record,
        id: crypto.randomUUID(),
        switchMutationID: crypto.randomUUID(),
        trigger: 'manual' as const,
        authorisationID: saved.id,
      }
      await overlay.apply({ putRejoin: record }, crypto.randomUUID())
      const write = {
        mutationID: record.switchMutationID as string,
        source: { rejoinID: record.id, authorisationID: saved.id },
        destination: {
          control: { cursor: { position: recovery.proof.position, epoch: record.epochAfter } },
        },
      }
      return { recovery, saved, record, write }
    }
    test('manual attempt crosses strong holds without opening ordinary work', () =>
      run(async (fixture, key) => {
        const selectedRecovery = await selected(fixture, key)
        await fixture.safety().reportFork(key, {
          kind: 'digest-divergence',
          epoch: 0,
          position: 'fork',
          localDigest: 'ours',
          remoteDigest: 'theirs',
        })
        const before = await fixture.device.groups.ports(key).control.load()
        const installedKey = await fixture.registry.switchIncarnation(
          selectedRecovery.recovery.candidate,
          {
            source: await fixture.registry.recoverySource(key.groupID),
            rejoinID: selectedRecovery.record.id,
            proof: selectedRecovery.recovery.proof,
            write: selectedRecovery.write,
          },
        )
        expect(installedKey).toEqual({ ...key, incarnation: 2 })
        expect(await fixture.device.groups.ports(key).control.load()).toMatchObject({
          rejoin: before.rejoin,
          forkHalt: before.forkHalt,
        })
        expect((await fixture.safety().status(installedKey)).hold).toBeNull()
        expect(
          await fixture.manualRecovery().readManualRecovery(selectedRecovery.saved.id),
        ).toMatchObject({
          stage: 'completed',
          destination: installedKey,
          attempt: {
            stage: 'adopted',
            authorisationID: selectedRecovery.saved.id,
            destinationKey: installedKey,
          },
        })
        expect((await fixture.registry.access(key.groupID)).admission().admissible).toBe(true)
      }))
    test('failed manual recovery preserves prior state and halt', () =>
      run(async (fixture, key) => {
        const selectedRecovery = await selected(fixture, key)
        await fixture.safety().reportFork(key, {
          kind: 'digest-divergence',
          epoch: 0,
          position: 'fork',
          localDigest: 'ours',
          remoteDigest: 'theirs',
        })
        const sourceBefore = await fixture.inspectRows()
        for (const write of [
          {
            ...selectedRecovery.write,
            source: { ...selectedRecovery.write.source, authorisationID: 'foreign' },
          },
          { ...selectedRecovery.write, source: { rejoinID: selectedRecovery.record.id } },
        ]) {
          await expect(
            fixture.registry.switchIncarnation(selectedRecovery.recovery.candidate, {
              source: await fixture.registry.recoverySource(key.groupID),
              rejoinID: selectedRecovery.record.id,
              proof: selectedRecovery.recovery.proof,
              write,
            }),
          ).rejects.toThrow()
          expect(await fixture.inspectRows()).toEqual(sourceBefore)
        }
        fixture.armNextWorkFault('before-commit')
        await expect(
          fixture.registry.switchIncarnation(selectedRecovery.recovery.candidate, {
            source: await fixture.registry.recoverySource(key.groupID),
            rejoinID: selectedRecovery.record.id,
            proof: selectedRecovery.recovery.proof,
            write: selectedRecovery.write,
          }),
        ).rejects.toThrow()
        expect(await fixture.inspectRows()).toEqual(sourceBefore)
      }))
    test.each(['trust', 'spent', 'target', 'proof'] as const)(
      'failed manual recovery preserves prior state and halt / %s',
      (failure) =>
        run(async (fixture, key) => {
          const selectedRecovery = await selected(fixture, key)
          await fixture.safety().reportFork(key, {
            kind: 'digest-divergence',
            epoch: 0,
            position: 'fork',
            localDigest: 'ours',
            remoteDigest: 'theirs',
          })
          if (failure === 'trust') await fixture.corruptTrust(key.groupID)
          if (failure === 'spent') {
            const trust = await fixture.device.groups.loadTrust(key.groupID)
            if (trust === null) throw new Error('Missing retained trust')
            await fixture.installRows({
              key,
              trust: {
                ...trust,
                spentEpochAuthenticators: [
                  ...trust.spentEpochAuthenticators,
                  await fixture.authenticator(selectedRecovery.recovery.candidate),
                ],
              },
            })
          }
          const sourceBefore = await fixture.inspectRows()
          const proof =
            failure === 'target'
              ? { ...selectedRecovery.recovery.proof, topicID: 'foreign-topic' }
              : failure === 'proof'
                ? { ...selectedRecovery.recovery.proof, verdict: new Uint8Array([1]) }
                : selectedRecovery.recovery.proof
          await expect(
            fixture.registry.switchIncarnation(selectedRecovery.recovery.candidate, {
              source:
                failure === 'trust'
                  ? selectedRecovery.recovery.source
                  : await fixture.registry.recoverySource(key.groupID),
              rejoinID: selectedRecovery.record.id,
              proof,
              write: selectedRecovery.write,
            }),
          ).rejects.toThrow()
          expect(await fixture.inspectRows()).toEqual(sourceBefore)
        }),
    )
    test('manual retry preserves its own authenticated floor', () =>
      run(async (fixture, key) => {
        const selectedRecovery = await selected(fixture, key)
        await fixture
          .manualRecovery()
          .manualRecoveryControl(selectedRecovery.saved.id)
          .apply({ recoveryEpochFloor: 40 }, 'manual-higher-floor')
        const before = await fixture.inspectRows()
        await expect(
          fixture.registry.switchIncarnation(selectedRecovery.recovery.candidate, {
            source: await fixture.registry.recoverySource(key.groupID),
            rejoinID: selectedRecovery.record.id,
            proof: selectedRecovery.recovery.proof,
            write: selectedRecovery.write,
          }),
        ).rejects.toMatchObject({ name: 'RecoveryTargetBehindError' })
        expect(await fixture.inspectRows()).toEqual(before)
      }))
    test('manual floor override preserves exact accepted work', () =>
      run(async (fixture, key) => {
        const selectedRecovery = await selected(fixture, key)
        await fixture.installRows({
          key,
          control: {
            recoveryEpochFloor: 40,
            putOutcomes: [{ id: 'owed', opID: null, at: 1, kind: 'unknown' }],
            putWelcomes: [
              { opID: 'welcome', welcome: new Uint8Array([3]), recipients: ['member'] },
            ],
          },
        })
        const sourceBefore = await fixture.device.groups.ports(key).control.load()
        const installedKey = await fixture.registry.switchIncarnation(
          selectedRecovery.recovery.candidate,
          {
            source: await fixture.registry.recoverySource(key.groupID),
            rejoinID: selectedRecovery.record.id,
            proof: selectedRecovery.recovery.proof,
            write: selectedRecovery.write,
          },
        )
        expect(installedKey).not.toEqual(key)
        const sourceAfter = await fixture.device.groups.ports(key).control.load()
        expect(sourceAfter.rejoin).toEqual(sourceBefore.rejoin)
        expect(sourceAfter.outcomes).toEqual(sourceBefore.outcomes)
        expect(sourceAfter.welcomes).toEqual(sourceBefore.welcomes)
        expect(sourceAfter.recoveryEpochFloor).toBe(40)
      }))
    test('manual overlay requires committed authorisation', () =>
      run(async (fixture) => {
        const overlay = fixture.manualRecovery().manualRecoveryControl('uncommitted')
        await expect(overlay.load()).rejects.toThrow('authorisation')
        await expect(
          overlay.apply({ recoveryEpochFloor: 1 }, 'uncommitted-write'),
        ).rejects.toThrow()
      }))
    test('manual saved target survives reopen', () =>
      run(async (fixture, key) => {
        const saved = await fixture.manualRecovery().authoriseManualRecovery(key, choice)
        const reopened = await fixture.reopen()
        try {
          expect(await reopened.manualRecovery().readManualRecovery(saved.id)).toEqual(saved)
          expect(saved).toMatchObject({
            source: key,
            choice,
            stage: 'authorised',
            attempt: null,
            pauseReason: null,
          })
          expect(await reopened.safety().status(key)).toMatchObject({
            manualRecovery: { id: saved.id, kind: 'pending', reason: null },
          })
        } finally {
          await reopened.close()
        }
      }))
    test('manual transport binding persists no hub methods', () =>
      run(async (fixture, key) => {
        const saved = await fixture.manualRecovery().authoriseManualRecovery(key, {
          ...choice,
          hub: {
            publish() {
              throw new Error('not called')
            },
          },
          descriptor: { url: 'https://host.invalid' },
        } as ConformancePersistedManualRecovery)
        expect(saved.choice).toEqual(choice)
        expect(Object.keys(saved.choice).sort()).toEqual([
          'allowOpenFork',
          'commitTopicID',
          'mode',
          'targetID',
        ])
        const rows = await fixture.inspectRows()
        expect(
          [...(rows.checkpoints?.values() ?? [])].every((row) => row instanceof Uint8Array),
        ).toBe(true)
        for (const address of rows.checkpoints?.keys() ?? [])
          expect(JSON.parse(address)[1]).toBeNull()
      }))
    test('manual attempt cannot overwrite ordinary X', () =>
      run(async (fixture, key) => {
        const recovery = await fixture.confirmedRecovery(key, { confirm: true })
        if (!('format' in recovery.record)) throw new Error('Expected captured recovery')
        await fixture.installRows({
          key,
          control: {
            putOperations: [
              {
                id: 'ordinary-operation',
                kind: 'rotation',
                revokes: false,
                body: new Uint8Array([1]),
                seq: 1,
                enqueuedAt: 1,
                deadline: 100,
                stage: 'intent',
              },
            ],
            putOutcomes: [{ id: 'owed-outcome', opID: null, at: 1, kind: 'unknown' }],
            putWelcomes: [
              { opID: 'owed-welcome', welcome: new Uint8Array([3]), recipients: ['member'] },
            ],
            strand: { reason: 'ahead' },
          },
        })
        await fixture.safety().reportFork(key, {
          kind: 'digest-divergence',
          epoch: 0,
          position: 'reported-position',
          localDigest: 'local',
          remoteDigest: 'remote',
        })
        const ordinary = await fixture.device.groups.ports(key).control.load()
        const rawControl = (await fixture.inspectRows()).control
        const saved = await fixture.manualRecovery().authoriseManualRecovery(key, choice)
        const overlay = fixture.manualRecovery().manualRecoveryControl(saved.id)
        const candidate = {
          ...recovery.record,
          id: 'manual-candidate',
          trigger: 'manual' as const,
          authorisationID: saved.id,
          target: {
            ...recovery.record.target,
            targetID: choice.targetID,
            topicID: choice.commitTopicID,
          },
        }
        await overlay.apply({ putRejoin: candidate }, 'save-manual')
        expect((await overlay.load()).rejoin).toEqual(candidate)
        candidate.requestKey.fill(0)
        expect(
          (await fixture.manualRecovery().readManualRecovery(saved.id))?.attempt?.requestKey,
        ).not.toEqual(candidate.requestKey)
        const retained = (await overlay.load()).rejoin
        if (retained === null) throw new Error('Missing manual candidate')
        await overlay.apply({ putRejoin: { ...retained, stage: 'published' } }, 'retry-manual')
        fixture.armNextWorkFault('before-commit')
        await expect(overlay.apply({ recoveryEpochFloor: 5 }, 'rollback-manual')).rejects.toThrow()
        expect(await overlay.lastMutation()).toBe('retry-manual')
        expect(await fixture.device.groups.ports(key).control.load()).toEqual(ordinary)
        expect((await overlay.load()).recoveryEpochFloor).toBeNull()
        expect((await fixture.inspectRows()).control).toEqual(rawControl)
        const reopened = await fixture.reopen()
        try {
          const restored = await reopened.manualRecovery().readManualRecovery(saved.id)
          expect(restored?.attempt).toEqual((await overlay.load()).rejoin)
          expect(restored?.attempt?.authorisationID).toBe(saved.id)
        } finally {
          await reopened.close()
        }
      }))
    test('manual floor authority is isolated from ordinary recovery', () =>
      run(async (fixture, key) => {
        const recovery = await fixture.confirmedRecovery(key, { confirm: true })
        if (!('format' in recovery.record)) throw new Error('Expected captured recovery')
        const settlement: ConformanceAcceptedRejoinSettlement = {
          id: 'saved-settlement',
          kind: 'not-accepted',
          epoch: 40,
          origin: {
            sourceKey: key,
            target: recovery.record.target,
            searchFrom: recovery.record.searchFrom,
          },
          ledgerBefore: ['owed-earlier'],
        }
        await fixture.installRows({
          key,
          control: { recoveryEpochFloor: 40, putSettledRejoins: [settlement] },
        })
        const ordinary = await fixture.device.groups.ports(key).control.load()
        const saved = await fixture.manualRecovery().authoriseManualRecovery(key, choice)
        const overlay = fixture.manualRecovery().manualRecoveryControl(saved.id)
        await overlay.apply({ recoveryEpochFloor: 1 }, 'manual-floor')
        expect((await overlay.load()).recoveryEpochFloor).toBe(1)
        expect((await overlay.load()).settledRejoins.flatMap((row) => row.ledgerBefore)).toContain(
          'owed-earlier',
        )
        await overlay.apply({ recoveryEpochFloor: 0 }, 'manual-floor-retry')
        expect((await overlay.load()).recoveryEpochFloor).toBe(1)
        expect(await fixture.device.groups.ports(key).control.load()).toEqual(ordinary)
      }))
    test('manual overlay rejects unrelated writes and unbound candidates', () =>
      run(async (fixture, key) => {
        const recovery = await fixture.confirmedRecovery(key)
        if (!('format' in recovery.record)) throw new Error('Expected captured recovery')
        const saved = await fixture.manualRecovery().authoriseManualRecovery(key, choice)
        const overlay = fixture.manualRecovery().manualRecoveryControl(saved.id)
        for (const changes of [
          { cursor: null },
          { deleteOperations: ['ordinary'] },
          { controlHold: null },
          { putRejoin: recovery.record },
        ]) {
          await expect(overlay.apply(changes, crypto.randomUUID())).rejects.toThrow()
        }
        const candidate = {
          ...recovery.record,
          trigger: 'manual' as const,
          authorisationID: saved.id,
          target: {
            ...recovery.record.target,
            targetID: choice.targetID,
            topicID: choice.commitTopicID,
          },
        }
        for (const invalid of [
          { ...candidate, source: { ...candidate.source, key: { ...key, incarnation: 2 } } },
          { ...candidate, target: { ...candidate.target, topicID: 'other-topic' } },
          { ...candidate, target: { ...candidate.target, targetID: 'other-target' } },
          { ...candidate, trigger: 'automatic' as const },
          {
            ...candidate,
            forkRecovery: {
              attemptID: candidate.id,
              source: key,
              noticeID: 'foreign-notice',
              splitEpoch: 1,
              otherAuthHash: 'foreign-hash',
              responderKeyHash: 'foreign-key',
              evidence: new Uint8Array([1]),
            },
          },
          { ...candidate, authorisationID: 'other-authorisation' },
        ])
          await expect(overlay.apply({ putRejoin: invalid }, crypto.randomUUID())).rejects.toThrow()
        const legacy = await fixture.confirmedRecovery(key, { format: 'legacy' })
        await expect(overlay.apply({ putRejoin: legacy.record }, 'legacy-manual')).rejects.toThrow()
        expect((await overlay.load()).rejoin).toBeNull()
      }))
    test('raw checkpoint writes cannot fabricate or replace manual authority', () =>
      run(async (fixture, key) => {
        const saved = await fixture.manualRecovery().authoriseManualRecovery(key, choice)
        const row = {
          kind: 'manual-recovery' as const,
          id: saved.id,
          key,
          value: { ...saved, epochFloor: 0 },
        }
        const lifetime = await fixture.device.groups.load(key.groupID)
        if (lifetime === null) throw new Error('Missing lifetime')
        const mutationID = crypto.randomUUID()
        await expect(
          fixture.device.groups.transition(
            {
              groupID: key.groupID,
              mutationID,
              expected: { revision: lifetime.revision, activeIncarnation: key.incarnation },
            },
            async (stores) => {
              await stores.checkpoints.put(row)
            },
          ),
        ).rejects.toThrow()
        expect(await fixture.manualRecovery().readManualRecovery(saved.id)).toEqual(saved)
      }))
    test('raw checkpoint removal cannot discard manual authority', () =>
      run(async (fixture, key) => {
        const saved = await fixture.manualRecovery().authoriseManualRecovery(key, choice)
        const lifetime = await fixture.device.groups.load(key.groupID)
        if (lifetime === null) throw new Error('Missing lifetime')
        const mutationID = crypto.randomUUID()
        await expect(
          fixture.device.groups.transition(
            {
              groupID: key.groupID,
              mutationID,
              expected: { revision: lifetime.revision, activeIncarnation: key.incarnation },
            },
            async (stores) => {
              await stores.checkpoints.remove([saved.id])
            },
          ),
        ).rejects.toThrow()
        expect(await fixture.manualRecovery().readManualRecovery(saved.id)).toEqual(saved)
      }))
    test('manual bare deletion preserves obligations across replacement and reopen', () =>
      run(async (fixture, key) => {
        const recovery = await fixture.confirmedRecovery(key, { confirm: true })
        if (!('format' in recovery.record)) throw new Error('Expected captured recovery')
        const saved = await fixture.manualRecovery().authoriseManualRecovery(key, choice)
        const overlay = fixture.manualRecovery().manualRecoveryControl(saved.id)
        const candidate = {
          ...recovery.record,
          id: 'manual-with-obligations',
          trigger: 'manual' as const,
          authorisationID: saved.id,
          target: {
            ...recovery.record.target,
            targetID: choice.targetID,
            topicID: choice.commitTopicID,
          },
          ledgerBefore: ['manual-owed'],
        }
        await overlay.apply({ putRejoin: candidate }, 'save-before-delete')
        const before = await fixture.manualRecovery().readManualRecovery(saved.id)
        for (const putSettledRejoins of [undefined, []]) {
          await expect(
            overlay.apply({ deleteRejoin: true, putSettledRejoins }, 'bare-delete'),
          ).rejects.toThrow()
          expect(await fixture.manualRecovery().readManualRecovery(saved.id)).toEqual(before)
        }
        const reopened = await fixture.reopen()
        try {
          const restored = reopened.manualRecovery().manualRecoveryControl(saved.id)
          expect(await reopened.manualRecovery().readManualRecovery(saved.id)).toEqual(before)
          await restored.apply(
            { putRejoin: { ...candidate, id: 'replacement-manual', ledgerBefore: ['next-owed'] } },
            'replace-after-delete',
          )
          const replaced = await reopened.reopen()
          try {
            const record = await replaced.manualRecovery().readManualRecovery(saved.id)
            expect(record?.attempt).toMatchObject({
              id: 'replacement-manual',
              authorisationID: saved.id,
              ledgerBefore: expect.arrayContaining(['manual-owed', 'next-owed']),
            })
            expect(record?.settlements).toEqual(saved.settlements)
          } finally {
            await replaced.close()
          }
        } finally {
          await reopened.close()
        }
      }))
    test('manual settlements retain all cumulative obligations', () =>
      run(async (fixture, key) => {
        const recovery = await fixture.confirmedRecovery(key, { confirm: true })
        if (!('format' in recovery.record)) throw new Error('Expected captured recovery')
        const saved = await fixture.manualRecovery().authoriseManualRecovery(key, choice)
        const overlay = fixture.manualRecovery().manualRecoveryControl(saved.id)
        const candidate = {
          ...recovery.record,
          trigger: 'manual' as const,
          authorisationID: saved.id,
          target: {
            ...recovery.record.target,
            targetID: choice.targetID,
            topicID: choice.commitTopicID,
          },
          ledgerBefore: ['manual-owed'],
        }
        await overlay.apply({ putRejoin: candidate }, 'save-owed')
        const attempt = (await overlay.load()).rejoin
        expect(attempt?.ledgerBefore).toEqual(
          expect.arrayContaining([...recovery.record.ledgerBefore, 'manual-owed']),
        )
        await overlay.apply(
          { putRejoin: { ...candidate, id: 'next-manual-candidate', ledgerBefore: ['next-owed'] } },
          'replace-owed',
        )
        expect((await overlay.load()).rejoin?.ledgerBefore).toEqual(
          expect.arrayContaining(['manual-owed', 'next-owed', ...recovery.record.ledgerBefore]),
        )
        const settlement: ConformanceAcceptedRejoinSettlement = {
          id: 'next-manual-candidate',
          kind: 'not-accepted',
          epoch: 2,
          origin: { sourceKey: key, target: candidate.target, searchFrom: candidate.searchFrom },
          ledgerBefore: ['new-owed'],
        }
        for (const invalid of [
          { ...settlement, id: 'other-attempt' },
          {
            ...settlement,
            origin: { ...settlement.origin, sourceKey: { ...key, incarnation: 2 } },
          },
          {
            ...settlement,
            origin: {
              ...settlement.origin,
              target: { ...settlement.origin.target, targetID: 'other-target' },
            },
          },
          {
            ...settlement,
            origin: {
              ...settlement.origin,
              target: { ...settlement.origin.target, topicID: 'other-topic' },
            },
          },
          {
            ...settlement,
            origin: {
              ...settlement.origin,
              target: { ...settlement.origin.target, groupInfoEpoch: 700 },
            },
          },
          { ...settlement, origin: { ...settlement.origin, searchFrom: 'different-origin' } },
          { ...settlement, kind: 'superseded-branch' as const },
        ])
          await expect(
            overlay.apply({ putSettledRejoins: [invalid] }, crypto.randomUUID()),
          ).rejects.toThrow()
        await overlay.apply({ deleteRejoin: true, putSettledRejoins: [settlement] }, 'settle-owed')
        expect((await overlay.load()).settledRejoins.flatMap((row) => row.ledgerBefore)).toEqual(
          expect.arrayContaining(['new-owed', 'manual-owed', ...recovery.record.ledgerBefore]),
        )
        await expect(
          overlay.apply(
            {
              putSettledRejoins: [
                {
                  ...settlement,
                  origin: { ...settlement.origin, sourceKey: { ...key, incarnation: 2 } },
                },
              ],
            },
            'foreign-settlement',
          ),
        ).rejects.toThrow()
      }))
    test('pending manual proof exposes neither authorisation nor overlay changes', () =>
      run(async (fixture, key) => {
        const before = (await fixture.inspectRows()).checkpoints
        const fault = fixture.armNextWorkFault('pending')
        const saving = fixture
          .manualRecovery()
          .authoriseManualRecovery(key, choice)
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          )
        await fault.rejected
        expect((await fixture.inspectRows()).checkpoints).toEqual(before)
        await fault.finish('rollback')
        expect(await saving).toHaveProperty('error')
        expect((await fixture.safety().status(key)).manualRecovery).toBeNull()
        const saved = await fixture.manualRecovery().authoriseManualRecovery(key, choice)
        const overlay = fixture.manualRecovery().manualRecoveryControl(saved.id)
        const pending = fixture.armNextWorkFault('pending')
        const writing = overlay.apply({ recoveryEpochFloor: 1 }, 'pending-overlay').then(
          () => ({ done: true }),
          (error: unknown) => ({ error }),
        )
        await pending.rejected
        await pending.finish('rollback')
        expect(await writing).toHaveProperty('error')
        expect((await overlay.load()).recoveryEpochFloor).toBeNull()
      }))
    test('manual authorisation preserves its choice and rejects invalid bindings', () =>
      run(async (fixture, key) => {
        const storage = fixture.manualRecovery()
        await expect(
          storage.authoriseManualRecovery({ ...key, incarnation: 2 }, choice),
        ).rejects.toThrow()
        for (const invalid of [
          { ...choice, targetID: '' },
          { ...choice, commitTopicID: '' },
          { ...choice, allowOpenFork: undefined } as unknown as ConformancePersistedManualRecovery,
          { mode: 'successor' as const, successor: { groupID: '', incarnation: 1 } },
          { mode: 'successor' as const, successor: { groupID: 'successor', incarnation: 0 } },
        ])
          await expect(storage.authoriseManualRecovery(key, invalid)).rejects.toThrow()
        const saved = await storage.authoriseManualRecovery(key, choice)
        expect(await storage.authoriseManualRecovery(key, choice)).toEqual(saved)
        await expect(
          storage.authoriseManualRecovery(key, { ...choice, targetID: 'other' }),
        ).rejects.toThrow()
        expect(await storage.readManualRecovery(saved.id)).toEqual(saved)
      }))
    test('manual successor choice persists without granting a resync overlay', () =>
      run(async (fixture, key) => {
        const successor = { groupID: 'admitted-successor', incarnation: 2 }
        const saved = await fixture
          .manualRecovery()
          .authoriseManualRecovery(key, { mode: 'successor', successor })
        successor.incarnation = 3
        expect(saved.choice).toEqual({
          mode: 'successor',
          successor: { groupID: 'admitted-successor', incarnation: 2 },
        })
        await expect(
          fixture
            .manualRecovery()
            .manualRecoveryControl(saved.id)
            .apply({ recoveryEpochFloor: 0 }, 'successor-floor'),
        ).rejects.toThrow()
        const reopened = await fixture.reopen()
        try {
          expect(await reopened.manualRecovery().readManualRecovery(saved.id)).toEqual(saved)
        } finally {
          await reopened.close()
        }
      }))
    test('manual writes reject inactive sources', () =>
      run(async (fixture, key) => {
        const saved = await fixture.manualRecovery().authoriseManualRecovery(key, choice)
        const overlay = fixture.manualRecovery().manualRecoveryControl(saved.id)
        await fixture.registry.delete(key)
        await expect(overlay.apply({ recoveryEpochFloor: 0 }, 'inactive-floor')).rejects.toThrow()
        await expect(
          fixture.manualRecovery().authoriseManualRecovery(key, choice),
        ).rejects.toThrow()
      }))
    test('manual authorisation rolls back without changing ordinary control', () =>
      run(async (fixture, key) => {
        const before = await fixture.device.groups.ports(key).control.load()
        fixture.armNextWorkFault('before-commit')
        await expect(
          fixture.manualRecovery().authoriseManualRecovery(key, choice),
        ).rejects.toThrow()
        expect(await fixture.device.groups.ports(key).control.load()).toEqual(before)
        expect((await fixture.safety().status(key)).manualRecovery).toBeNull()
      }))
  })
}
