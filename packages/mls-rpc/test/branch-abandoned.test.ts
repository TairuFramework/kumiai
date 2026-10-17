import { randomIdentity } from '@kokuin/token'
import {
  commitInvite,
  commitKeyRotation,
  createInvite,
  createKeyPackageBundle,
  decodeEpochCheckpoint,
  decodeEpochRosterFact,
  encodeClientState,
  type GroupHandle,
  ledgerEntryDigest,
  removeMember,
  restoreGroup,
} from '@kumiai/mls'
import type { CheckpointRecord } from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import {
  branchAbandonmentPreparer,
  incrementOthersSeen,
  recordOwnBranchMessage,
} from '../src/branch-history.js'
import { createCheckpointService } from '../src/checkpoint.js'
import { entryCapability } from '../src/entry-capability.js'
import { registryRecoveryCoordinator } from '../src/registry/recovery-coordinator.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { createForkRecoveryRealFixture } from './fixtures/captured-recovery.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createRealGroup } from './fixtures/real-group.js'
import {
  createRegistryFixture,
  registryFixtureCapturedRecovery,
  registryFixtureRemoveBranchCoverage,
} from './fixtures/registry.js'
import { nextChange } from './fixtures/storage-seed.js'

for (const mode of ['real-mls', 'double'] as const) {
  for (const ownership of ['supplied', 'absent'] as const) {
    describe(`branch abandonment ${mode} / ownership ${ownership}`, () => {
      async function setup() {
        const groupID = `abandoned-${mode}-${ownership}`
        const fixture = await createRegistryFixture({
          groupID,
          mode,
          setup: 'seeded',
          ownershipContext:
            ownership === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        })
        const key = { groupID, incarnation: 1 }
        const recovery = await fixture.confirmedRecovery(key, { confirm: true, format: 'legacy' })
        const params = {
          source: recovery.source,
          rejoinID: recovery.record.id,
          proof: recovery.proof,
          write: {
            mutationID: crypto.randomUUID(),
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
        }
        return {
          fixture,
          key,
          recovery,
          params,
          run: () => fixture.registry.switchIncarnation(recovery.candidate, params),
        }
      }

      test('preparation requires a confirmed record and the exact next destination', async () => {
        const h = await setup()
        try {
          const prepare = registryRecoveryCoordinator(h.fixture.registry).prepareBranchAbandonment
          for (const destination of [
            { ...h.key, incarnation: 3 },
            { groupID: 'foreign', incarnation: 2 },
          ])
            await expect(
              prepare({ source: h.key, destination, mutationID: h.params.write.mutationID }),
            ).rejects.toThrow('established switch')
          await h.fixture.installRows({
            key: h.key,
            control: { putRejoin: { ...h.recovery.record, stage: 'published' } },
          })
          await expect(
            prepare({
              source: h.key,
              destination: { ...h.key, incarnation: 2 },
              mutationID: h.params.write.mutationID,
            }),
          ).rejects.toThrow('established switch')
          expect(await h.fixture.safety().events(h.key)).toEqual([])
        } finally {
          await h.fixture.close()
        }
      })

      test('partial journal never claims exact historical totals', async () => {
        const h = await setup()
        try {
          await h.run()
          const event = (await h.fixture.safety().events(h.key)).find(
            (row) => row.kind === 'branch-abandoned',
          )
          expect(event).toMatchObject({
            epochs: 'unknown',
            ownMessages: [],
            othersSeen: 0,
            coverage: {
              ancestry: { kind: 'partial', reasons: ['unknown-ancestry'] },
              ephemeral: { kind: 'partial', reasons: ['ephemeral-uncovered'] },
              othersSeen: { kind: 'partial' },
              membership: { kind: 'partial' },
            },
          })
        } finally {
          await h.fixture.close()
        }
      })

      test.each(['commit', 'rollback'] as const)(
        'abandonment and destination install share proof: %s',
        async (outcome) => {
          const h = await setup()
          try {
            const fault = h.fixture.armWorkFault(h.params.write.mutationID, 'pending')
            const result = h.run().then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            )
            await Promise.race([
              fault.rejected,
              result.then((value) => {
                if ('error' in value) throw value.error
              }),
            ])
            // Proof-gated reads queue until the provider resolves its ambiguous outcome.
            const eventsBeforeProof: Array<unknown> = []
            const read = h.fixture
              .safety()
              .events(h.key)
              .then((events) => {
                eventsBeforeProof.push(...events)
                return events
              })
            await new Promise((resolve) => setTimeout(resolve, 0))
            expect(eventsBeforeProof).toEqual([])
            await fault.finish(outcome)
            const settled = await result
            await read
            if (outcome === 'rollback') {
              expect(settled).toHaveProperty('error')
              expect(await h.fixture.safety().events(h.key)).toEqual([])
              await h.run()
            } else expect(settled).toEqual({ value: { ...h.key, incarnation: 2 } })
            const events = await h.fixture.safety().events(h.key)
            expect(events.filter((row) => row.kind === 'branch-abandoned')).toHaveLength(1)
            const cold = await h.fixture.reopen()
            expect(await cold.safety().events(h.key)).toEqual(events)
            await cold.registry.switchIncarnation(h.recovery.candidate, h.params)
            expect(await cold.safety().events(h.key)).toEqual(events)
            const event = events[0]
            if (event === undefined) throw new Error('Missing report')
            await cold.safety().ackEvent(h.key, event.id)
            expect(await cold.safety().events(h.key)).toEqual([])
            await cold.close()
          } finally {
            await h.fixture.close()
          }
        },
      )
    })
  }
}

test.each(['commit', 'rollback'] as const)(
  'earlier notice links later v2 divergence and closes with switch proof: %s',
  async (outcome) => {
    const f = await createForkRecoveryRealFixture(true)
    try {
      const source = f.key
      await f.reply(20, 'other', true)
      const responder = await (await f.remote().registry.access(source.groupID)).read(
        (handle) => handle,
      )
      const groups = f.local().device.groups
      const records = await f.service().readRecords()
      const original = records.find((row) => row.kind === 'notice' && row.id === f.noticeID)
      if (original?.kind !== 'notice') throw new Error('Missing notice')
      expect(original.notice.splitEpoch).toBe(10)
      await groups.transition(
        await nextChange(groups, source.groupID, crypto.randomUUID()),
        async (stores) => {
          for (const epoch of [10, 20]) {
            const row = records.find((row) => row.kind === 'fact' && row.epoch === epoch)
            if (row?.kind !== 'fact') throw new Error('Missing source fact')
            const fact = decodeEpochRosterFact(row.canonical)
            await recordOwnBranchMessage(stores, {
              key: source,
              message: { id: `own-${epoch}`, epoch, authHash: fact.authHash },
            })
            await incrementOthersSeen(stores, { key: source, epoch, authHash: fact.authHash })
          }
        },
      )
      const recovery = await registryFixtureCapturedRecovery(f.local(), source, {
        confirm: true,
        responder: { identity: f.responderIdentity, group: responder },
      })
      const params = {
        source: recovery.source,
        rejoinID: recovery.record.id,
        proof: recovery.proof,
        write: {
          mutationID: recovery.record.switchMutationID ?? crypto.randomUUID(),
          source: { rejoinID: recovery.record.id },
          destination: {
            control: {
              cursor: { position: recovery.proof.position, epoch: recovery.record.epochAfter },
            },
          },
        },
      }
      const run = () => f.local().registry.switchIncarnation(recovery.candidate, params)
      const fault = f.local().armWorkFault(params.write.mutationID, 'pending')
      const switching = run().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      await Promise.race([
        fault.rejected,
        switching.then((result) => {
          if ('error' in result) throw result.error
        }),
      ])
      const eventsBeforeProof: Array<unknown> = []
      const read = f
        .local()
        .safety()
        .events(source)
        .then((events) => {
          eventsBeforeProof.push(...events)
        })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(eventsBeforeProof).toEqual([])
      await fault.finish(outcome)
      const settled = await switching
      await read
      if (outcome === 'rollback') {
        expect(settled).toHaveProperty('error')
        expect(await f.local().safety().events(source)).toEqual([])
        expect(
          (await f.service().forkNotices(source.groupID)).find((row) => row.id === f.noticeID),
        ).toMatchObject({ closedAt: null })
        params.source = await f.local().registry.recoverySource(source.groupID)
        await run()
      } else expect(settled).toEqual({ value: { ...source, incarnation: 2 } })
      const events = await f.local().safety().events(source)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        kind: 'branch-abandoned',
        noticeID: f.noticeID,
        epochs: 'unknown',
        ownMessages: [{ id: 'own-20' }],
        othersSeen: 1,
        membersAdded: [],
        membersRemoved: [],
        coverage: { ancestry: { kind: 'partial', reasons: ['unknown-ancestry'] } },
      })
      const notice = (await f.service().forkNotices(source.groupID)).find(
        (row) => row.id === f.noticeID,
      )
      expect(notice?.closedAt).toEqual(expect.any(Number))
      const cold = await f.local().reopen()
      try {
        expect(await cold.safety().events(source)).toEqual(events)
        await cold.registry.switchIncarnation(recovery.candidate, params)
        expect(await cold.safety().events(source)).toEqual(events)
        const service = createCheckpointService({
          registry: cold.registry,
          key: { ...source, incarnation: 2 },
          identity: cold.identity,
        })
        expect(
          (await service.forkNotices(source.groupID)).find((row) => row.id === f.noticeID),
        ).toEqual(notice)
      } finally {
        await cold.close()
      }
    } finally {
      await f.close()
    }
  },
)

test('applicable notices use earliest detection then smaller ID and match the abandoned branch', async () => {
  const f = await createForkRecoveryRealFixture(true)
  try {
    const source = f.key
    await f.reply(20)
    const responder = await (await f.remote().registry.access(source.groupID)).read(
      (handle) => handle,
    )
    const remoteService = createCheckpointService({
      registry: f.remote().registry,
      key: source,
      identity: f.responderIdentity,
    })
    await registryFixtureCapturedRecovery(f.local(), source, {
      confirm: true,
      responder: { identity: f.responderIdentity, group: responder },
      lineage: await remoteService.exportCheckpoints(source),
    })
    const records = await f.service().readRecords()
    const original = records.find((row) => row.kind === 'notice' && row.id === f.noticeID)
    const tip = records.find((row) => row.kind === 'fact' && row.epoch === 20)
    if (original?.kind !== 'notice' || tip?.kind !== 'fact') throw new Error('Missing history')
    type Notice = Extract<CheckpointRecord, { kind: 'notice' }>
    const notice = (
      id: string,
      detectedAt: number,
      change: Partial<Notice['notice']> = {},
    ): Notice => ({
      ...structuredClone(original),
      id,
      notice: { ...structuredClone(original.notice), id, detectedAt, ...change },
    })
    const earliest = notice('notice-Z', 10)
    const smaller = notice('notice-A', 10)
    const cases: Array<{ notices: Array<Notice>; want: string | null }> = [
      { notices: [notice('notice-A-new', 20), earliest], want: 'notice-Z' },
      { notices: [earliest, smaller], want: 'notice-A' },
      { notices: [smaller, earliest], want: 'notice-A' },
      { notices: [notice('notice-before', 10, { splitEpoch: 9 })], want: 'notice-before' },
      {
        notices: [
          notice('notice-later', 10, {
            splitEpoch: 20,
            deviceAuthHash: decodeEpochRosterFact(tip.canonical).authHash,
          }),
        ],
        want: 'notice-later',
      },
      { notices: [notice('notice-unrelated', 1, { splitEpoch: 20 })], want: null },
      { notices: [notice('notice-closed', 1, { closedAt: 2 })], want: null },
      {
        notices: [{ ...notice('notice-foreign', 1), key: { ...source, groupID: 'foreign' } }],
        want: null,
      },
      {
        notices: [{ ...notice('notice-other-incarnation', 1), key: { ...source, incarnation: 2 } }],
        want: null,
      },
    ]
    const entry = entryCapability(f.local().device.groups)
    if (entry === null) throw new Error('Missing entry')
    for (const { notices, want } of cases) {
      const event = await entry.read(source.groupID, (reads) =>
        branchAbandonmentPreparer({
          ...reads,
          checkpoints: async () => [...records.filter((row) => row.kind !== 'notice'), ...notices],
        })({ source, destination: { ...source, incarnation: 2 }, mutationID: crypto.randomUUID() }),
      )
      expect(event?.noticeID, JSON.stringify(notices.map((row) => row.id))).toBe(want)
      expect(event?.epochs).toEqual({ from: 10, through: 20 })
    }
  } finally {
    await f.close()
  }
})

for (const scenario of ['complete', 'missing-link', 'pre-upgrade'] as const) {
  const holes = scenario === 'missing-link' ? [15] : []
  test(
    scenario === 'pre-upgrade'
      ? 'pre-upgrade journal reports only known observations with partial totals'
      : holes.length === 0
        ? 'hub heal reports branch only messages; resend output contains only own IDs'
        : 'missing ancestry still switches with partial abandonment',
    async () => {
      const f = await createForkRecoveryRealFixture(true, { holes })
      try {
        const source = f.key
        await f.setOrdinaryFloor(20)
        if (scenario === 'pre-upgrade') await registryFixtureRemoveBranchCoverage(f.local(), source)
        const entry = entryCapability(f.local().device.groups)
        if (entry === null) throw new Error('Missing entry')
        const records = await f.service().readRecords()
        const row = records.find((row) => row.kind === 'fact' && row.epoch === 20)
        if (row?.kind !== 'fact') throw new Error('Missing source fact')
        const fact = decodeEpochRosterFact(row.canonical)
        await f
          .local()
          .device.groups.transition(
            await nextChange(f.local().device.groups, source.groupID, crypto.randomUUID()),
            async (stores) => {
              await recordOwnBranchMessage(stores, {
                key: source,
                message: { id: 'own-only', epoch: 20, authHash: fact.authHash },
              })
              await incrementOthersSeen(stores, { key: source, epoch: 20, authHash: fact.authHash })
              await incrementOthersSeen(stores, { key: source, epoch: 20, authHash: fact.authHash })
            },
          )
        const capture = await f.reply()
        const authority = await f
          .requester()
          .capturedRecovery?.authoriseForkRecovery?.(capture, f.noticeID)
        if (authority == null) throw new Error('Missing authority')
        const y = await f.build(authority, capture)
        if (y === null) throw new Error('Missing Y')
        expect(await f.local().safety().events(source)).toEqual([])
        const result = await f.installY(y)
        expect(result.destination).toEqual({ ...source, incarnation: 2 })
        expect(result.ordinaryFloor).toBe(20)
        expect((await f.local().device.groups.ports(source).control.load()).rejoin).toMatchObject({
          stage: 'adopted',
        })
        expect(
          (await f.local().device.groups.ports(result.destination).control.load()).cursor,
        ).toEqual({ epoch: 13, position: 'repair-position' })
        expect(result.applied).toMatchObject({ applied: true, advanced: true, epochAfter: 13 })
        const event = (await f.local().safety().events(source)).find(
          (row) => row.kind === 'branch-abandoned',
        )
        expect(event).toMatchObject({ noticeID: f.noticeID, membersAdded: [], membersRemoved: [] })
        if (event?.kind !== 'branch-abandoned') throw new Error('Missing abandonment')
        if (holes.length === 0) {
          expect(event.epochs).toEqual({ from: 10, through: 20 })
          expect(event.ownMessages.map(({ id }) => id)).toEqual(['own-only'])
          expect(event.othersSeen).toBe(2)
          if (scenario === 'pre-upgrade') {
            expect(event.coverage.ownMessages).toEqual({
              kind: 'partial',
              reasons: ['pre-journal-history'],
            })
            expect(event.coverage.othersSeen).toEqual({
              kind: 'partial',
              reasons: ['pre-journal-history'],
            })
          }
        } else {
          expect(event.epochs).toBe('unknown')
          expect(event.coverage.ancestry).toEqual({
            kind: 'partial',
            reasons: ['unknown-ancestry'],
          })
        }
        expect(event.coverage.ephemeral).toEqual({
          kind: 'partial',
          reasons: ['ephemeral-uncovered'],
        })
        expect(
          (await f.service().forkNotices(source.groupID)).find((row) => row.id === f.noticeID)
            ?.closedAt,
        ).not.toBeNull()
      } finally {
        await f.close()
      }
    },
  )
}

test.each([false, true])(
  'ordinary descendant resync has no abandonment / ahead %s',
  async (ahead) => {
    const real = await createRealGroup(1, 'descendant-abandonment')
    const member = real.members[0]
    if (member === undefined) throw new Error('Missing requester')
    const fixture = await createRegistryFixture({
      mode: 'real-mls',
      setup: 'empty',
      groupID: member.handle.groupID,
      identity: member.identity,
      options: { resolveLedgerEntries: real.resolveLedgerEntries },
    })
    const remote = await createRegistryFixture({
      mode: 'real-mls',
      setup: 'empty',
      groupID: member.handle.groupID,
      identity: real.committer.identity,
      options: fixture.environment.options,
    })
    try {
      const key = await fixture.registry.seed(
        await restoreGroup({
          state: member.handle.state,
          credential: member.handle.credential,
          ledgerEntries: member.handle.ledgerTokens,
          options: fixture.environment.options,
        }),
        { packageUse: { sourceID: 'descendant', ref: 'member', kind: 'ordinary' } },
      )
      let responder = await restoreGroup({
        state: structuredClone(real.committer.handle.state),
        credential: real.committer.handle.credential,
        ledgerEntries: real.committer.handle.ledgerTokens,
        options: remote.environment.options,
      })
      const remoteKey = await remote.registry.seed(responder, {
        packageUse: { sourceID: 'descendant', ref: 'responder', kind: 'ordinary' },
      })
      if (ahead) {
        responder = (await commitKeyRotation(responder)).newGroup
        const previous = await remote.device.groups.loadState(remoteKey)
        if (previous === null || previous.deleted) throw new Error('Missing responder')
        await remote.installRows({
          key: remoteKey,
          state: {
            ...previous,
            version: previous.version + 1,
            state: encodeClientState(responder.state),
            ledger: responder.ledgerTokens,
            epoch: Number(responder.epoch),
            epochAuthenticator: responder.state.keySchedule.epochAuthenticator,
          },
          trust: recoveryTrustFor(
            responder,
            remoteKey,
            await remote.device.groups.loadTrust(remoteKey.groupID),
          ),
        })
      }
      const service = createCheckpointService({
        registry: remote.registry,
        key: remoteKey,
        identity: remote.identity,
      })
      for (const row of await service.readRecords())
        if (row.kind === 'fact') await service.signInstalled(row.id)
      const lineage = (await service.exportCheckpoints(remoteKey)).sort(
        (a, b) => decodeEpochCheckpoint(a).body.epoch - decodeEpochCheckpoint(b).body.epoch,
      )
      const recovery = await registryFixtureCapturedRecovery(fixture, key, {
        confirm: true,
        responder: { identity: real.committer.identity, group: responder },
        lineage: ahead ? lineage : undefined,
      })
      await fixture.registry.switchIncarnation(recovery.candidate, {
        source: recovery.source,
        rejoinID: recovery.record.id,
        proof: recovery.proof,
        write: {
          mutationID: recovery.record.switchMutationID ?? 'descendant-switch',
          source: { rejoinID: recovery.record.id },
          destination: {
            control: {
              cursor: { position: recovery.proof.position, epoch: recovery.record.epochAfter },
            },
          },
        },
      })
      expect(await fixture.safety().events(key)).toEqual([])
      expect(await fixture.device.groups.loadState({ ...key, incarnation: 2 })).toMatchObject({
        epoch: Number(member.handle.epoch) + (ahead ? 2 : 1),
      })
    } finally {
      await fixture.close()
      await remote.close()
    }
  },
)

test('retention bounds unacknowledged resend metadata and worker updates cannot forge reports', async () => {
  const f = await createForkRecoveryRealFixture(true)
  try {
    const source = f.key
    const capture = await f.reply()
    const authority = await f
      .requester()
      .capturedRecovery?.authoriseForkRecovery?.(capture, f.noticeID)
    if (authority == null) throw new Error('Missing authority')
    const y = await f.build(authority, capture)
    if (y === null) throw new Error('Missing Y')
    const installed = await f.installY(y)
    const worker = createCheckpointService({
      registry: f.local().registry,
      key: installed.destination,
      identity: f.local().identity,
    })
    const records = await f.service().readRecords()
    const report = records.find((row) => row.kind === 'branch-abandonment')
    if (report?.kind !== 'branch-abandonment') throw new Error('Missing report')
    await expect(worker.updateRecords({ put: [report] })).rejects.toThrow('authority')
    await expect(worker.updateRecords({ remove: [report.id] })).rejects.toThrow('authority')
    const groups = f.local().device.groups
    await expect(
      groups.transition(await nextChange(groups, source.groupID, crypto.randomUUID()), (stores) =>
        stores.checkpoints.put({ ...report, event: { ...report.event, othersSeen: 9000 } }),
      ),
    ).rejects.toThrow('authority')
    await groups.transition(
      await nextChange(groups, source.groupID, crypto.randomUUID()),
      (stores) =>
        stores
          .incarnation(source.incarnation)
          .meta.putEvents([{ ...report.event, id: 'forged-report' }]),
    )
    expect(
      (await f.local().safety().events(source)).filter(
        (event) => event.kind === 'branch-abandoned',
      ),
    ).toHaveLength(1)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 604800000)
    try {
      const event = (await f.local().safety().events(source)).find(
        (row) => row.kind === 'branch-abandoned',
      )
      expect(event).toMatchObject({
        epochs: 'unknown',
        ownMessages: [],
        othersSeen: 0,
        membersAdded: [],
        membersRemoved: [],
        coverage: { ownMessages: { kind: 'partial', reasons: ['retention-gap'] } },
      })
      await f.local().safety().ackEvent(source, report.id)
      clock.mockReturnValue(Date.now() + 604800000)
      await groups.transition(
        await nextChange(groups, source.groupID, crypto.randomUUID()),
        async () => {},
      )
      expect((await worker.readRecords()).find((row) => row.id === report.id)).toBeUndefined()
    } finally {
      clock.mockRestore()
    }
  } finally {
    await f.close()
  }
})

test.each(['valid', 'invalid-signature', 'shared-addition', 'remote-removal'] as const)(
  'authenticated membership delta and resend output exclude common history and other senders / lineage %s',
  async (lineageKind) => {
    const real = await createRealGroup(2, 'abandoned-membership')
    const requester = real.members[0]
    const removed = real.members[1]
    if (requester === undefined || removed === undefined) throw new Error('Missing members')
    const local = await createRegistryFixture({
      groupID: requester.handle.groupID,
      mode: 'real-mls',
      setup: 'empty',
      identity: requester.identity,
      options: { resolveLedgerEntries: real.resolveLedgerEntries },
    })
    const remote = await createRegistryFixture({
      groupID: requester.handle.groupID,
      mode: 'real-mls',
      setup: 'empty',
      identity: real.committer.identity,
      options: { resolveLedgerEntries: real.resolveLedgerEntries },
    })
    try {
      const clone = (handle: GroupHandle) =>
        restoreGroup({
          state: structuredClone(handle.state),
          credential: handle.credential,
          ledgerEntries: handle.ledgerTokens,
          options: local.environment.options,
        })
      let losing = await clone(real.committer.handle)
      let continuing = await clone(real.committer.handle)
      const current = await clone(requester.handle)
      const key = await local.registry.seed(current, {
        packageUse: { sourceID: 'branch', ref: 'source', kind: 'ordinary' },
      })
      const remoteKey = await remote.registry.seed(continuing, {
        packageUse: { sourceID: 'branch', ref: 'remote', kind: 'ordinary' },
      })
      async function install(fixture: typeof local, handle: GroupHandle) {
        const state = await fixture.device.groups.loadState(key)
        if (state === null || state.deleted) throw new Error('Missing source')
        await fixture.installRows({
          key,
          state: {
            ...state,
            version: state.version + 1,
            state: encodeClientState(handle.state),
            ledger: handle.ledgerTokens,
            epoch: Number(handle.epoch),
            epochAuthenticator: handle.state.keySchedule.epochAuthenticator,
          },
          trust: recoveryTrustFor(handle, key, await fixture.device.groups.loadTrust(key.groupID)),
        })
      }
      async function journal(id: string, count: number) {
        const entry = entryCapability(local.device.groups)
        if (entry === null) throw new Error('Missing entry')
        const row = (await entry.read(key.groupID, (reads) => reads.checkpoints())).find(
          (row) => row.kind === 'fact' && row.epoch === Number(current.epoch),
        )
        if (row?.kind !== 'fact') throw new Error('Missing fact')
        const fact = decodeEpochRosterFact(row.canonical)
        await local.device.groups.transition(
          await nextChange(local.device.groups, key.groupID, crypto.randomUUID()),
          async (stores) => {
            await recordOwnBranchMessage(stores, {
              key,
              message: { id, epoch: fact.epoch, authHash: fact.authHash },
            })
            for (let i = 0; i < count; i++)
              await incrementOthersSeen(stores, { key, epoch: fact.epoch, authHash: fact.authHash })
          },
        )
      }
      await journal('common-own', 5)
      const addedIdentity = randomIdentity()
      const bundle = await createKeyPackageBundle(addedIdentity)
      const { invite } = await createInvite({
        group: losing,
        identity: real.committer.identity,
        recipientDID: addedIdentity.id,
        permission: 'member',
      })
      for (const token of invite.ledgerEntries) real.bodies.set(ledgerEntryDigest(token), token)
      const added = await commitInvite(losing, bundle.publicPackage, invite)
      losing = added.newGroup
      await current.processMessage(added.commitMessage)
      await install(local, current)
      await journal('branch-own-3', 1)
      const leafIndex = losing.findMemberLeafIndex(
        lineageKind === 'remote-removal' ? addedIdentity.id : removed.identity.id,
      )
      if (leafIndex === undefined) throw new Error('Missing removed leaf')
      const removal = await removeMember(losing, leafIndex)
      losing = removal.newGroup
      await current.processMessage(removal.commitMessage)
      await install(local, current)
      await journal('branch-own-4', 2)
      if (lineageKind === 'shared-addition') {
        continuing = (await commitInvite(continuing, bundle.publicPackage, invite)).newGroup
        await install(remote, continuing)
      }
      while (Number(continuing.epoch) < 4) {
        if (lineageKind === 'remote-removal' && Number(continuing.epoch) === 3) {
          const leaf = continuing.findMemberLeafIndex(removed.identity.id)
          if (leaf === undefined) throw new Error('Missing continuing removal')
          continuing = (await removeMember(continuing, leaf)).newGroup
        } else continuing = (await commitKeyRotation(continuing)).newGroup
        await install(remote, continuing)
      }
      const service = createCheckpointService({
        registry: remote.registry,
        key: remoteKey,
        identity: real.committer.identity,
      })
      for (const row of await service.readRecords())
        if (row.kind === 'fact') await service.signInstalled(row.id)
      const lineage = (await service.exportCheckpoints(remoteKey)).sort(
        (a, b) => decodeEpochCheckpoint(a).body.epoch - decodeEpochCheckpoint(b).body.epoch,
      )
      if (lineageKind === 'invalid-signature') {
        const first = lineage[0]
        if (first === undefined) throw new Error('Missing lineage')
        first[first.length - 1] = (first[first.length - 1] ?? 0) ^ 1
      }
      const recovery = await registryFixtureCapturedRecovery(local, key, {
        confirm: true,
        responder: { identity: real.committer.identity, group: continuing },
        lineage,
      })
      await local.registry.switchIncarnation(recovery.candidate, {
        source: recovery.source,
        rejoinID: recovery.record.id,
        proof: recovery.proof,
        write: {
          mutationID: recovery.record.switchMutationID ?? 'membership-switch',
          source: { rejoinID: recovery.record.id },
          destination: {
            control: {
              cursor: { position: recovery.proof.position, epoch: recovery.record.epochAfter },
            },
          },
        },
      })
      const event = (await local.safety().events(key)).find(
        (row) => row.kind === 'branch-abandoned',
      )
      if (lineageKind === 'invalid-signature') {
        expect(event).toMatchObject({
          epochs: 'unknown',
          othersSeen: 2,
          membersAdded: [],
          membersRemoved: [],
          coverage: { ancestry: { kind: 'partial', reasons: ['unknown-ancestry'] } },
        })
        if (event?.kind !== 'branch-abandoned') throw new Error('Missing report')
        expect(event.ownMessages.map(({ id }) => id)).toEqual(['branch-own-4'])
        return
      }
      expect(event).toMatchObject({
        noticeID: null,
        epochs: { from: 3, through: 4 },
        othersSeen: 3,
        membersAdded:
          lineageKind === 'shared-addition' || lineageKind === 'remote-removal'
            ? []
            : [addedIdentity.id],
        membersRemoved: lineageKind === 'remote-removal' ? [] : [removed.identity.id],
        coverage: {
          ancestry: { kind: 'complete' },
          ownMessages: { kind: 'complete' },
          othersSeen: { kind: 'complete' },
          membership: { kind: 'complete' },
        },
      })
      if (event?.kind !== 'branch-abandoned') throw new Error('Missing report')
      expect(event.ownMessages.map(({ id }) => id)).toEqual(['branch-own-3', 'branch-own-4'])
      expect(Object.keys(event.ownMessages[0] ?? {}).sort()).toEqual(['authHash', 'epoch', 'id'])
    } finally {
      await local.close()
      await remote.close()
    }
  },
)
