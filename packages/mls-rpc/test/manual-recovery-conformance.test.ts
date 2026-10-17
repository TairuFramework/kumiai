import {
  commitKeyRotation,
  decodeClientState,
  encodeClientState,
  restoreGroup,
  sealRecoveryVerdict,
} from '@kumiai/mls'
import {
  asLogPosition,
  type CheckpointRecord,
  checkpointTopic,
  createGroupPeer,
  decodeHandshakeFrame,
  encodeHandshakeFrame,
  encodeRecoveryRequest,
  type GroupCrypto,
  type GroupKey,
  type GroupMLS,
  GroupSafetyHeldError,
  HANDSHAKE_KIND,
  type LogHub,
  type LogPosition,
  type MailboxHub,
  type ManualRecoveryRecord,
  type ManualRecoveryStatus,
  type PersistedManualRecovery,
  rendezvousTopic,
  type SuccessorTombstone,
} from '@kumiai/rpc'
import {
  type ConformanceCheckpointRecord,
  type ConformanceManualRecoveryRecord,
  type ConformanceManualRecoveryStatus,
  type ConformancePersistedManualRecovery,
  type ConformanceSuccessorTombstone,
  testManualRecoveryConformance,
} from '@kumiai/rpc-conformance'
import { expect, expectTypeOf, test, vi } from 'vitest'

import { entryCapability } from '../src/entry-capability.js'
import * as api from '../src/index.js'
import { createManualRecoveryStore } from '../src/manual-recovery.js'
import { decodeCapturedRecoveryCandidate } from '../src/recovery-codec.js'
import { recoveryCompletionContexts } from '../src/recovery-completion-context.js'
import { registryRecoveryCoordinator } from '../src/registry/recovery-coordinator.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { deferred } from '../src/runtime.js'
import { capturedRecord, createForkRecoveryRealFixture } from './fixtures/captured-recovery.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import {
  createNotMemberFixture,
  createRegistryFixture,
  type RegistryFixture,
  registryFixtureMutateControl,
  registryFixtureSafetyParams,
} from './fixtures/registry.js'

expectTypeOf<ManualRecoveryRecord>().toEqualTypeOf<ConformanceManualRecoveryRecord<LogPosition>>()
expectTypeOf<ManualRecoveryStatus>().toEqualTypeOf<ConformanceManualRecoveryStatus>()
expectTypeOf<PersistedManualRecovery>().toEqualTypeOf<ConformancePersistedManualRecovery>()
expectTypeOf<SuccessorTombstone>().toEqualTypeOf<ConformanceSuccessorTombstone>()
expectTypeOf<Extract<CheckpointRecord, { kind: 'successor' }>>().toEqualTypeOf<
  Extract<ConformanceCheckpointRecord, { kind: 'successor' }>
>()

for (const mode of ['real-mls', 'double'] as const) {
  for (const context of ['supplied', 'absent'] as const) {
    testManualRecoveryConformance({
      label: `${mode} / ownership context ${context}`,
      createFixture: () =>
        createRegistryFixture({
          mode,
          groupID: 'manual-recovery',
          setup: 'seeded',
          ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        }),
      callTime: {
        hub: contractHub,
        safety: async (fixture, resolveTarget) =>
          api.createGroupSafety({
            ...(await registryFixtureSafetyParams(fixture as unknown as RegistryFixture)),
            resolveTarget,
          }),
        manualRecovery: (fixture, resolveTarget) => {
          const local = fixture as unknown as RegistryFixture
          return createManualRecoveryStore({
            registry: local.registry,
            persistence: local.device.groups,
            key: { groupID: 'manual-recovery', incarnation: 1 },
            resolveTarget,
          })
        },
      },
    })
  }
}

// Shape checks read transport methods; only calling one is a network action.
function refusingHub(message: string): LogHub & MailboxHub {
  const refuse = () => {
    throw new Error(message)
  }
  return new Proxy({} as LogHub & MailboxHub, {
    get(_target, property) {
      if (['subscribe', 'receive', 'publish', 'fetchTopic'].includes(property as string))
        return refuse
      throw new Error(message)
    },
  })
}

// The contract only binds hubs; calling one is a network action it must never take.
function contractHub(): LogHub & MailboxHub {
  const refuse = () => {
    throw new Error('Unexpected network action')
  }
  return { subscribe: refuse, receive: refuse, publish: refuse, fetchTopic: refuse }
}

for (const ownership of ['supplied', 'absent'] as const) {
  test(`manual recovery abandons pending fork recovery intent / ${ownership}`, async () => {
    const fixture = await createForkRecoveryRealFixture(true, { ownership })
    try {
      await fixture.saveX('built')
      const reply = await fixture.reply()
      const authority = await fixture
        .requester()
        .capturedRecovery?.authoriseForkRecovery?.(reply, fixture.noticeID)
      if (authority == null) throw new Error('Missing fork authorisation')
      await registryFixtureMutateControl(fixture.local(), fixture.key, (snapshot) => ({
        ...snapshot,
        responses: [
          ...snapshot.responses,
          {
            kind: 'refused',
            position: asLogPosition('legacy-negative'),
            epoch: 0,
            digest: 'legacy-digest',
          },
        ],
      }))
      const before = await fixture.snapshot()
      expect(before.forkRecoveryAttempt?.id).toBe(authority.attemptID)
      const manual = fixture.local().manualRecovery()
      fixture.local().armNextWorkFault('before-commit')
      await expect(
        manual.authoriseManualRecovery(fixture.key, {
          mode: 'resync',
          targetID: 'manual-target',
          commitTopicID: 'manual-topic',
          allowOpenFork: false,
        }),
      ).rejects.toThrow()
      expect(await fixture.snapshot()).toEqual(before)
      const saved = await manual.authoriseManualRecovery(fixture.key, {
        mode: 'resync',
        targetID: 'manual-target',
        commitTopicID: 'manual-topic',
        allowOpenFork: false,
      })
      expect(await fixture.snapshot()).toEqual({ ...before, forkRecoveryAttempt: null })
      expect(saved.abandonedForkRecovery).toBe(authority.attemptID)
      expect(await manual.readManualRecovery(saved.id)).toEqual(saved)
      expect((await manual.manualRecoveryControl(saved.id).load()).settledRejoins).toEqual(
        before.settledRejoins,
      )
    } finally {
      await fixture.close()
    }
  })
}

test('manual floor authority cannot cross provider coordinators', async () => {
  const first = await createRegistryFixture({
    mode: 'double',
    groupID: 'manual-recovery',
    setup: 'seeded',
  })
  const second = await createRegistryFixture({
    mode: 'double',
    groupID: 'manual-recovery',
    setup: 'seeded',
  })
  try {
    expect(() =>
      createManualRecoveryStore({
        registry: first.registry,
        persistence: second.device.groups,
        key: { groupID: 'manual-recovery', incarnation: 1 },
      }),
    ).toThrow('same coordinator')
  } finally {
    await first.close()
    await second.close()
  }
})

test('saved pause projects visibly and clears without replacing authorisation', async () => {
  let fixture = await createRegistryFixture({
    mode: 'double',
    groupID: 'manual-recovery',
    setup: 'seeded',
  })
  const key = { groupID: 'manual-recovery', incarnation: 1 }
  const hub = refusingHub('Storage must not call hub methods')
  let resolved: { id: string; commitTopicID: string; hub: LogHub & MailboxHub } | null = null
  const create = () =>
    createManualRecoveryStore({
      registry: fixture.registry,
      persistence: fixture.device.groups,
      key,
      resolveTarget: async () => {
        if (resolved === null) throw new Error('Host binding unavailable')
        return resolved
      },
    })
  try {
    let storage = create()
    const saved = await storage.authoriseManualRecovery(key, {
      mode: 'resync',
      targetID: 'selected',
      commitTopicID: 'commits',
      allowOpenFork: false,
    })
    expect(await storage.resolveManualRecoveryTarget(saved.id)).toBeNull()
    expect(await fixture.safety().status(key)).toMatchObject({
      manualRecovery: { id: saved.id, kind: 'paused', reason: 'target-unresolved' },
    })
    const paused = await storage.readManualRecovery(saved.id)
    fixture = await fixture.reopen()
    storage = create()
    expect(await storage.readManualRecovery(saved.id)).toEqual(paused)
    for (const target of [
      { id: 'other', commitTopicID: 'commits', hub },
      { id: 'selected', commitTopicID: 'other-commits', hub },
    ]) {
      resolved = target
      expect(await storage.resolveManualRecoveryTarget(saved.id)).toBeNull()
      expect(await storage.readManualRecovery(saved.id)).toEqual(paused)
    }
    resolved = { id: 'selected', commitTopicID: 'commits', hub }
    expect(await storage.resolveManualRecoveryTarget(saved.id)).toBe(resolved)
    expect(await storage.readManualRecovery(saved.id)).toMatchObject({
      ...saved,
      mutationID: expect.any(String),
    })
    expect(await fixture.safety().status(key)).toMatchObject({
      manualRecovery: { id: saved.id, kind: 'pending', reason: null },
    })
  } finally {
    await fixture.close()
  }
})

for (const context of ['supplied', 'absent'] as const) {
  test(`successful deferred resolution clears an interleaved pause / ${context}`, async () => {
    const fixture = await createRegistryFixture({
      mode: 'double',
      groupID: 'manual-recovery',
      setup: 'seeded',
      ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
    })
    const key = { groupID: 'manual-recovery', incarnation: 1 }
    const hub = refusingHub('Storage must not call hub methods')
    const target = { id: 'selected', commitTopicID: 'commits', hub }
    const started = deferred<void>()
    const released = deferred<void>()
    let calls = 0
    const storage = createManualRecoveryStore({
      registry: fixture.registry,
      persistence: fixture.device.groups,
      key,
      resolveTarget: async () => {
        if (++calls !== 1) throw new Error('Host binding unavailable')
        started.resolve()
        await released.promise
        return target
      },
    })
    try {
      const saved = await storage.authoriseManualRecovery(key, {
        mode: 'resync',
        targetID: 'selected',
        commitTopicID: 'commits',
        allowOpenFork: false,
      })
      const resolving = storage.resolveManualRecoveryTarget(saved.id)
      await started.promise
      expect(await storage.resolveManualRecoveryTarget(saved.id)).toBeNull()
      expect(await fixture.safety().status(key)).toMatchObject({
        manualRecovery: { id: saved.id, kind: 'paused', reason: 'target-unresolved' },
      })
      released.resolve()
      expect(await resolving).toBe(target)
      expect(await storage.readManualRecovery(saved.id)).toEqual({
        ...saved,
        mutationID: expect.any(String),
      })
      expect(await fixture.safety().status(key)).toMatchObject({
        manualRecovery: { id: saved.id, kind: 'pending', reason: null },
      })
      const reopened = await fixture.reopen()
      try {
        expect(await reopened.safety().status(key)).toMatchObject({
          manualRecovery: { id: saved.id, kind: 'pending', reason: null },
        })
      } finally {
        await reopened.close()
      }
    } finally {
      released.resolve()
      await fixture.close()
    }
  })
}

test('manual overlay rejects fork floor authority even with matching ordinary intent', async () => {
  const fixture = await createForkRecoveryRealFixture(true)
  try {
    const storage = fixture.local().manualRecovery()
    const reply = await fixture.reply()
    const authority = await fixture
      .requester()
      .capturedRecovery?.authoriseForkRecovery?.(reply, fixture.noticeID)
    if (authority == null) throw new Error('Missing real fork authority')
    const y = await fixture.build(authority, reply)
    if (y === null) throw new Error('Missing real fork candidate')
    const intent = (await fixture.snapshot()).forkRecoveryAttempt
    const saved = await storage.authoriseManualRecovery(fixture.key, {
      mode: 'resync',
      targetID: fixture.target.targetID,
      commitTopicID: fixture.target.topicID,
      allowOpenFork: false,
    })
    // Restore a forbidden late intent to exercise the overlay's independent fence.
    await registryFixtureMutateControl(fixture.local(), fixture.key, (snapshot) => ({
      ...snapshot,
      forkRecoveryAttempt: intent,
    }))
    const before = await fixture.snapshot()
    await expect(
      storage.manualRecoveryControl(saved.id).apply(
        {
          putRejoin: { ...y.record, trigger: 'manual', authorisationID: saved.id },
        },
        'crossed-fork-authority',
      ),
    ).rejects.toThrow()
    expect(await fixture.snapshot()).toEqual(before)
    expect((await storage.readManualRecovery(saved.id))?.attempt).toBeNull()
  } finally {
    await fixture.close()
  }
})

test('private fork intent abandonment refuses every unrelated change', async () => {
  const fixture = await createRegistryFixture({
    mode: 'double',
    groupID: 'manual-recovery',
    setup: 'seeded',
  })
  const key = { groupID: 'manual-recovery', incarnation: 1 }
  try {
    const entry = entryCapability(fixture.device.groups)
    if (entry === null) throw new Error('Missing coordinator')
    for (const invalid of ['other-change', 'missing-intent'] as const) {
      const mutationID = crypto.randomUUID()
      const changes = invalid === 'other-change' ? { recoveryEpochFloor: 0 } : {}
      await expect(
        entry.run(
          { groupID: key.groupID, mutationID },
          async (reads) => ({ expected: await reads.lifetime(), value: null }),
          async (stores) => {
            recoveryCompletionContexts.set(stores.tx, {
              key,
              changes,
              abandonForkRecovery: true,
              ...(invalid === 'other-change' ? { forkRecovery: { attempt: null } } : {}),
            })
            try {
              await stores.incarnation(key.incarnation).control.apply(changes, mutationID)
            } finally {
              recoveryCompletionContexts.delete(stores.tx)
            }
          },
        ),
      ).rejects.toThrow('no other changes')
    }
  } finally {
    await fixture.close()
  }
})

for (const mode of ['real-mls', 'double'] as const) {
  for (const context of ['supplied', 'absent'] as const) {
    test(`manual continuation survives source retirement / ${mode} / ${context}`, async () => {
      let fixture = await createRegistryFixture({
        mode,
        groupID: 'manual-recovery',
        setup: 'seeded',
        ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
      })
      const key = { groupID: 'manual-recovery', incarnation: 1 }
      try {
        const recovery = await fixture.confirmedRecovery(key, { confirm: true })
        if (!('format' in recovery.record)) throw new Error('Captured recovery required')
        const storage = fixture.manualRecovery()
        const saved = await storage.authoriseManualRecovery(key, {
          mode: 'resync',
          targetID: recovery.record.target.targetID,
          commitTopicID: recovery.record.target.topicID,
          allowOpenFork: false,
        })
        await storage.manualRecoveryControl(saved.id).apply(
          {
            putRejoin: {
              ...recovery.record,
              trigger: 'manual',
              authorisationID: saved.id,
            },
          },
          'save-confirmed-manual',
        )
        const installedKey = await fixture.registry.switchIncarnation(recovery.candidate, {
          source: await fixture.registry.recoverySource(key.groupID),
          rejoinID: recovery.record.id,
          proof: recovery.proof,
          write: {
            mutationID: recovery.record.switchMutationID as string,
            source: { rejoinID: recovery.record.id, authorisationID: saved.id },
            destination: {
              control: {
                cursor: { position: recovery.proof.position, epoch: recovery.record.epochAfter },
              },
            },
          },
        })
        const before = await fixture.device.groups.ports(key).control.load()
        await expect(
          storage
            .manualRecoveryControl(saved.id)
            .apply({ recoveryEpochFloor: 999 }, 'retired-manual-write'),
        ).rejects.toThrow()
        fixture = await fixture.reopen()
        const hub = new FakeHub()
        const restarted = await manualOwner(fixture, async (id) => ({
          id,
          hub,
          commitTopicID:
            saved.choice.mode === 'resync' ? saved.choice.commitTopicID : 'unavailable',
        }))
        try {
          await restarted.owner.ready
          expect(restarted.created[0]?.hub).toBe(hub)
          expect(restarted.created[0]?.target).toEqual(
            recovery.record.target && {
              targetID: recovery.record.target.targetID,
              topicID: recovery.record.target.topicID,
            },
          )
        } finally {
          restarted.owner.dispose()
          await restarted.owner.drained()
        }
        const destinationRestart = await manualOwner(
          fixture,
          async (id) => ({
            id,
            hub,
            commitTopicID:
              saved.choice.mode === 'resync' ? saved.choice.commitTopicID : 'unavailable',
          }),
          installedKey,
        )
        try {
          await destinationRestart.owner.ready
          expect(destinationRestart.created[0]?.hub).toBe(hub)
          expect(destinationRestart.created[0]?.target).toEqual(restarted.created[0]?.target)
        } finally {
          destinationRestart.owner.dispose()
          await destinationRestart.owner.drained()
        }
        const continuations = api.createRecoveryContinuationPort({
          registry: fixture.registry,
          persistence: fixture.device.groups,
        })
        const continuation = await continuations.loadRecoveryContinuation(installedKey)
        expect(continuation?.record).toMatchObject({
          trigger: 'manual',
          authorisationID: saved.id,
          stage: 'adopted',
        })
        if (continuation === null) throw new Error('Missing manual continuation')
        await continuations.finishRecoveryContinuation({
          continuation,
          ledger: recovery.candidate.ledgerTokens,
          mutationID: 'complete-manual',
        })
        expect(await continuations.loadRecoveryContinuation(installedKey)).toBeNull()
        const completedRestart = await manualOwner(
          fixture,
          async (id) => ({
            id,
            hub,
            commitTopicID:
              saved.choice.mode === 'resync' ? saved.choice.commitTopicID : 'unavailable',
          }),
          installedKey,
        )
        try {
          await completedRestart.owner.ready
          expect(completedRestart.created[0]?.hub).toBe(hub)
          expect(completedRestart.owner.installedKey()).toEqual(installedKey)
        } finally {
          completedRestart.owner.dispose()
          await completedRestart.owner.drained()
        }

        const completedSourceRestart = await manualOwner(
          fixture,
          async (id) => ({
            id,
            hub,
            commitTopicID:
              saved.choice.mode === 'resync' ? saved.choice.commitTopicID : 'unavailable',
          }),
          key,
        )
        try {
          await completedSourceRestart.owner.ready
          expect(completedSourceRestart.created[0]?.hub).toBe(hub)
          expect(completedSourceRestart.owner.installedKey()).toEqual(installedKey)
        } finally {
          completedSourceRestart.owner.dispose()
          await completedSourceRestart.owner.drained()
        }
        expect((await fixture.device.groups.ports(key).control.load()).rejoin).toEqual(
          before.rejoin,
        )
        expect(await fixture.manualRecovery().readManualRecovery(saved.id)).toMatchObject({
          stage: 'completed',
          destination: installedKey,
        })
      } finally {
        await fixture.close()
      }
    })
  }
}

async function manualOwner(
  fixture: Awaited<ReturnType<typeof createRegistryFixture>>,
  resolveTarget: (id: string) => Promise<api.RecoveryTarget>,
  key = { groupID: 'manual-recovery', incarnation: 1 },
  target = { targetID: 'ordinary-hub', topicID: 'ordinary-commits' },
) {
  const created: Array<api.RegistryPeerOptions> = []
  const owner = await api.createRegistryPeer({
    registry: fixture.registry,
    key,
    recovery: fixture.environment,
    target,
    resolveTarget,
    continuation: api.createRecoveryContinuationPort({
      registry: fixture.registry,
      persistence: fixture.device.groups,
    }),
    createMLS: (key, _handoff, options) =>
      api.createRegistryGroupMLS({
        manualRecovery: options.manualRecovery,
        registry: fixture.registry,
        key,
        recovery: fixture.environment,
        identity: fixture.identity,
        entrySlot: api.createLedgerEntrySlot(),
        target: options.target,
      }),
    createPeer: async (_key, options) => {
      created.push(options)
      return {
        dispose: async () => {},
        drained: async () => {},
      } as unknown as NonNullable<ReturnType<api.RegistryPeer['peer']>>
    },
  })
  return { owner, created }
}

test('unresolved registered target pauses visibly', async () => {
  const fixture = await createRegistryFixture({
    mode: 'real-mls',
    groupID: 'manual-recovery',
    setup: 'seeded',
  })
  const key = { groupID: 'manual-recovery', incarnation: 1 }
  const saved = await fixture.manualRecovery().authoriseManualRecovery(key, {
    mode: 'resync',
    targetID: 'selected',
    commitTopicID: 'selected-commits',
    allowOpenFork: true,
  })
  const resolver = vi.fn(async (_id: string) => {
    throw new Error('Unavailable target')
  })
  const { owner, created } = await manualOwner(fixture, resolver)
  try {
    await owner.ready
    await vi.waitFor(() =>
      expect(owner.status()).toMatchObject({
        kind: 'pending',
        reason: 'target-unresolved',
        authorisationID: saved.id,
      }),
    )
    expect(created).toEqual([])
    expect(resolver.mock.calls.every((call) => call[0] === 'selected')).toBe(true)
    expect((await fixture.safety().status(key)).manualRecovery).toMatchObject({
      id: saved.id,
      kind: 'paused',
    })
  } finally {
    owner.dispose()
    await owner.drained()
    await fixture.close()
  }
})

test('restart resumes only authorised target', async () => {
  let fixture = await createRegistryFixture({
    mode: 'real-mls',
    groupID: 'manual-recovery',
    setup: 'seeded',
  })
  const key = { groupID: 'manual-recovery', incarnation: 1 }
  const saved = await fixture.manualRecovery().authoriseManualRecovery(key, {
    mode: 'resync',
    targetID: 'selected',
    commitTopicID: 'selected-commits',
    allowOpenFork: false,
  })
  fixture = await fixture.reopen()
  const hub = new Proxy({} as LogHub & MailboxHub, {
    get() {
      throw new Error('Substituted target contacted')
    },
  })
  const resolver = vi.fn(async (_id: string) => ({
    id: 'selected',
    commitTopicID: 'substituted',
    hub,
  }))
  const { owner, created } = await manualOwner(fixture, resolver)
  try {
    await owner.ready
    await vi.waitFor(() =>
      expect(owner.status()).toMatchObject({
        reason: 'target-unresolved',
        authorisationID: saved.id,
      }),
    )
    expect(created).toEqual([])
    expect(await fixture.manualRecovery().readManualRecovery(saved.id)).toMatchObject({
      choice: saved.choice,
      attempt: null,
    })
  } finally {
    owner.dispose()
    await owner.drained()
    await fixture.close()
  }
})

const { FakeHub } = (await import(
  new URL('../../rpc/test/fixtures/fake-hub.ts', import.meta.url).href
)) as {
  FakeHub: new () => LogHub &
    MailboxHub & { published: Array<{ senderDID: string; topicID: string; payload: Uint8Array }> }
}

async function liveManualPeer(
  fixture: Awaited<ReturnType<typeof createRegistryFixture>>,
  key: GroupKey,
  hub: LogHub & MailboxHub,
  target: { targetID: string; topicID: string },
  recovery = { timeoutMs: 1000, deadlineMs: 8000, getDelayMs: () => 0 },
  onMLS: (mls: GroupMLS) => void = () => {},
) {
  const cryptos: Array<GroupCrypto> = []
  const events: Array<unknown> = []
  const owner = await api.createRegistryPeer({
    registry: fixture.registry,
    key,
    recovery: fixture.environment,
    target,
    onRecovery: (event) => {
      events.push({
        phase: event.phase,
        at: Date.now(),
        ...(event.phase === 'failed'
          ? { reason: event.reason, error: String(event.error), pendingReason: event.pendingReason }
          : {}),
      })
    },
    resolveTarget: async (id) => ({ id, hub, commitTopicID: target.topicID }),
    continuation: api.createRecoveryContinuationPort({
      registry: fixture.registry,
      persistence: fixture.device.groups,
    }),
    createMLS: async (key, _handoff, options) => {
      const mls = await api.createRegistryGroupMLS({
        registry: fixture.registry,
        key,
        manualRecovery: options.manualRecovery,
        recovery: fixture.environment,
        target: options.target,
        identity: fixture.identity,
        entrySlot: api.createLedgerEntrySlot(),
      })
      onMLS(mls)
      return mls
    },
    createPeer: async (key, options) => {
      const access = await fixture.registry.access(key.groupID)
      const crypto = api.createGroupCrypto({
        access: {
          ...api.createRegistryHandleAccess({ access }),
          open: async () => {
            throw new Error('No application opens expected')
          },
        },
      })
      cryptos.push(crypto)
      const ports = fixture.device.groups.ports(key)
      return createGroupPeer({
        hub,
        crypto,
        recoveryTarget: target,
        ...options,
        control: options.control ?? ports.control,
        anchorStore: ports.anchor,
        appCursorStore: ports.cursor,
        appOutbox: ports.outbox,
        appOutboxLimit: 16,
        localDID: fixture.identity.id,
        protocols: {},
        handlers: {},
        recovery,
        readEvidence: () => fixture.device.groups.readEvidence(key),
        validation: api.createControlValidationPort({
          identity: fixture.identity,
          options: fixture.environment.options,
          restoreCandidate: async () => {
            throw new Error('No ordinary candidate expected')
          },
        }),
        prepareBuild: async () => {
          throw new Error('No ordinary builds expected')
        },
        adopt: async () => {
          throw new Error('No ordinary adoption expected')
        },
        deliverWelcome: async () => {},
      })
    },
  })
  return { owner, cryptos, events }
}

for (const producer of ['app-report', 'internal', 'legacy'] as const) {
  test(`successful rejoin leaves source holds in history / ${producer}`, async () => {
    const fixture = await createForkRecoveryRealFixture(true)
    const local = fixture.local()
    const key = fixture.key
    const hub = new FakeHub()
    const owners: Array<api.RegistryPeer> = []
    try {
      await fixture.saveX('confirmed')
      await fixture.seedEarlierSettlement()
      await registryFixtureMutateControl(local, key, (snapshot) => ({
        ...snapshot,
        forkHalt: {
          eventID: 'source-halt',
          detectedAt: 1,
          ...(producer === 'legacy' ? {} : { producer }),
          evidence: { kind: 'unexplained-own-commit', epoch: 20, position: 'fork', digest: 'fork' },
        },
      }))
      const before = await fixture.snapshot()
      const storage = local.manualRecovery()
      const saved = await storage.authoriseManualRecovery(key, {
        mode: 'resync',
        targetID: fixture.target.targetID,
        commitTopicID: fixture.target.topicID,
        allowOpenFork: false,
      })
      const requester = await liveManualPeer(local, key, hub, fixture.target)
      owners.push(requester.owner)
      await requester.owner.ready
      const sourcePeer = requester.owner.peer()
      if (sourcePeer === null) throw new Error('Missing manual requester')
      await expect(
        sourcePeer.commit({
          id: 'ordinary-during-manual',
          kind: 'rotation',
          revokes: false,
          body: new Uint8Array(),
        }),
      ).rejects.toBeInstanceOf(GroupSafetyHeldError)
      const crypto = requester.cryptos[0]
      if (crypto === undefined) throw new Error('Missing source crypto')
      await expect(crypto.wrap(new Uint8Array([1]))).rejects.toBeInstanceOf(GroupSafetyHeldError)
      await expect(crypto.unwrap(new Uint8Array([1]))).rejects.toBeInstanceOf(GroupSafetyHeldError)
      const result = requester.owner.runManualRecovery(saved)
      void result.catch(() => {})
      const remote = await liveManualPeer(
        fixture.remote(),
        { ...key, incarnation: 1 },
        hub,
        fixture.target,
      )
      owners.push(remote.owner)
      await remote.owner.ready
      await vi.waitFor(
        async () => {
          const diagnostics = {
            status: requester.owner.status(),
            stage: (await storage.readManualRecovery(saved.id))?.attempt?.stage,
            events: requester.events,
            remote: remote.events,
            messages: hub.published.map((m) => ({
              own: m.senderDID === local.identity.id,
              kind: (() => {
                try {
                  return decodeHandshakeFrame(m.payload).kind
                } catch {
                  return 'checkpoint'
                }
              })(),
            })),
          }
          expect(requester.owner.installedKey().incarnation, JSON.stringify(diagnostics)).toBe(2)
        },
        { timeout: 12000 },
      )
      expect(await result).toEqual({ ...key, incarnation: 2 })
      expect((await fixture.snapshot()).forkHalt).toEqual(before.forkHalt)
      expect((await fixture.snapshot()).rejoin).toEqual(before.rejoin)
      expect((await fixture.snapshot()).settledRejoins).toEqual(before.settledRejoins)
      expect((await local.safety().status({ ...key, incarnation: 2 })).hold).toBeNull()
      expect(await storage.readManualRecovery(saved.id)).toMatchObject({
        stage: 'completed',
        destination: { ...key, incarnation: 2 },
      })
    } finally {
      for (const owner of owners) owner.dispose()
      await Promise.all(owners.map((owner) => owner.drained()))
      await fixture.close()
    }
  })
}

test('manual confirmation rechecks durable authority after signing', async () => {
  const fixture = await createForkRecoveryRealFixture(true)
  const local = fixture.local()
  const key = fixture.key
  const hub = new FakeHub()
  const signing = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const owners: Array<api.RegistryPeer> = []
  try {
    await fixture.saveX('confirmed')
    await local.safety().reportFork(key, {
      kind: 'digest-divergence',
      epoch: 10,
      position: 'reported',
      localDigest: 'ours',
      remoteDigest: 'theirs',
    })
    const storage = local.manualRecovery()
    const saved = await storage.authoriseManualRecovery(key, {
      mode: 'resync',
      targetID: fixture.target.targetID,
      commitTopicID: fixture.target.topicID,
      allowOpenFork: false,
    })
    const requester = await liveManualPeer(
      local,
      key,
      hub,
      fixture.target,
      { timeoutMs: 1000, deadlineMs: 8000, getDelayMs: () => 0 },
      (mls) => {
        const sign = mls.signRecoveryConfirmation.bind(mls)
        vi.spyOn(mls, 'signRecoveryConfirmation').mockImplementation(async (request) => {
          const signature = await sign(request)
          signing.resolve()
          await release.promise
          return signature
        })
      },
    )
    owners.push(requester.owner)
    await requester.owner.ready
    const remote = await liveManualPeer(fixture.remote(), key, hub, fixture.target)
    owners.push(remote.owner)
    await remote.owner.ready
    await signing.promise
    const sourceBefore = await fixture.snapshot()
    const attemptBefore = await storage.readManualRecovery(saved.id)
    expect(attemptBefore?.attempt?.stage).toBe('published')
    const unavailable = createManualRecoveryStore({
      registry: local.registry,
      persistence: local.device.groups,
      key,
      resolveTarget: async () => {
        throw new Error('Target unavailable')
      },
    })
    expect(await unavailable.resolveManualRecoveryTarget(saved.id)).toBeNull()
    const paused = await storage.readManualRecovery(saved.id)
    expect(paused).toMatchObject({ stage: 'authorised', pauseReason: 'target-unresolved' })
    const stateBefore = await local.registry.recoverySource(key.groupID)
    const eventCount = requester.events.length
    release.resolve()
    await vi.waitFor(() =>
      expect(requester.events.slice(eventCount)).toContainEqual(
        expect.objectContaining({ phase: 'failed' }),
      ),
    )
    expect(
      hub.published.filter((message) => {
        try {
          return (
            decodeHandshakeFrame(message.payload).kind === HANDSHAKE_KIND.recoveryConfirmRequest
          )
        } catch {
          return false
        }
      }),
    ).toHaveLength(0)
    expect(await storage.readManualRecovery(saved.id)).toEqual(paused)
    expect(await fixture.snapshot()).toEqual(sourceBefore)
    expect(await local.registry.recoverySource(key.groupID)).toEqual(stateBefore)
  } finally {
    release.resolve()
    for (const owner of owners) owner.dispose()
    await Promise.all(owners.map((owner) => owner.drained()))
    await fixture.close()
    vi.restoreAllMocks()
  }
})

test('manual authorisation precedes every network action', async () => {
  const fixture = await createRegistryFixture({
    mode: 'real-mls',
    groupID: 'manual-recovery',
    setup: 'seeded',
  })
  const key = { groupID: 'manual-recovery', incarnation: 1 }
  const hub = new FakeHub()
  const { owner, created } = await manualOwner(fixture, async (id) => ({
    id,
    hub,
    commitTopicID: 'selected-commits',
  }))
  try {
    await owner.ready
    const safety = api.createGroupSafety({
      registry: fixture.registry,
      persistence: fixture.device.groups,
      mls: await api.createRegistryGroupMLS({
        registry: fixture.registry,
        key,
        identity: fixture.identity,
        recovery: fixture.environment,
        target: { targetID: 'selected', topicID: 'selected-commits' },
        entrySlot: api.createLedgerEntrySlot(),
      }),
      resolveTarget: async (id) => ({ id, hub, commitTopicID: 'selected-commits' }),
    })
    const before = created.length
    const fault = fixture.armNextWorkFault('pending')
    const attempt = safety
      .recover(key, { mode: 'resync', targetID: 'selected' })
      .catch((error: unknown) => error)
    await fault.rejected
    expect(created).toHaveLength(before)
    expect(hub.published).toEqual([])
    await fault.finish('rollback')
    expect(await attempt).toBeInstanceOf(Error)
    expect((await safety.status(key)).manualRecovery).toBeNull()
  } finally {
    owner.dispose()
    await owner.drained()
    await fixture.close()
  }
})

test('unresolved manual recovery remains visible while not-member is set', async () => {
  const fixture = await createNotMemberFixture()
  let owner: api.RegistryPeer | undefined
  try {
    await fixture.diagnose(await fixture.proof())
    const local = fixture.local()
    const saved = await local.manualRecovery().authoriseManualRecovery(fixture.key, {
      mode: 'resync',
      targetID: 'selected',
      commitTopicID: 'selected-commits',
      allowOpenFork: false,
    })
    owner = (
      await manualOwner(
        local,
        async () => {
          throw new Error('Unavailable')
        },
        fixture.key,
      )
    ).owner
    await owner.ready
    await vi.waitFor(() =>
      expect(owner?.status()).toMatchObject({
        kind: 'not-member',
        pendingReason: 'target-unresolved',
        authorisationID: saved.id,
      }),
    )
    expect(await local.safety().status(fixture.key)).toMatchObject({
      condition: 'not-member',
      manualRecovery: { kind: 'paused', id: saved.id },
    })
  } finally {
    owner?.dispose()
    await owner?.drained()
    await fixture.close()
  }
})

for (const expiry of ['age', 'restart', 'count'] as const) {
  test(
    `heal after evidence expiry stays target-behind; manual resync exits / ${expiry}`,
    async () => {
      const fixture = await createForkRecoveryRealFixture(true)
      const hub = new FakeHub()
      const owners: Array<api.RegistryPeer> = []
      try {
        await fixture.saveX('built')
        await fixture.seedEarlierSettlement()
        if (expiry === 'count') {
          const local = fixture.local()
          const key = fixture.key
          const initial = await local.device.groups.loadState(key)
          if (initial === null || initial.deleted || initial.state === null)
            throw new Error('Missing advanced source')
          const client = decodeClientState(initial.state)
          if (client === undefined) throw new Error('Missing source state')
          let handle = await restoreGroup({
            state: client,
            credential: initial.credential,
            ledgerEntries: initial.ledger,
            options: local.environment.options,
          })
          for (let installation = 13; installation <= 257; installation++) {
            handle = (await commitKeyRotation(handle)).newGroup
            const current = await local.device.groups.loadState(key)
            if (current === null || current.deleted) throw new Error('Missing installation')
            await local.installRows({
              key,
              state: {
                ...current,
                version: current.version + 1,
                state: encodeClientState(handle.state),
                epoch: Number(handle.epoch),
                epochAuthenticator: handle.state.keySchedule.epochAuthenticator,
              },
              trust: recoveryTrustFor(
                handle,
                key,
                await local.device.groups.loadTrust(key.groupID),
              ),
            })
          }
        } else await fixture.expireEvidence()
        if (expiry === 'restart') await fixture.restart()
        const local = fixture.local()
        const key = fixture.key
        const before = await fixture.snapshot()
        expect(before.recoveryEpochFloor).toBe(20)
        expect(before.rejoin?.epochAfter).toBe(21)
        expect(await fixture.service().checkpointFact(key, expiry === 'count' ? 9 : 10)).toBeNull()
        const expiredCapture = await fixture.reply()
        expect(
          await fixture
            .requester()
            .capturedRecovery?.authoriseForkRecovery?.(expiredCapture, fixture.noticeID),
        ).toBeNull()
        const withheldCheckpoint =
          expiry === 'count'
            ? checkpointTopic(await fixture.requester().exportRecoverySecret())
            : null
        if (withheldCheckpoint !== null) {
          const publish = hub.publish.bind(hub)
          // Retained later epochs could establish fresh authority if their checkpoints arrive.
          hub.publish = async (params) => {
            if (params.topicID === withheldCheckpoint)
              throw new Error('Checkpoint delivery withheld')
            return await publish(params)
          }
        }
        const timing =
          expiry === 'count'
            ? { timeoutMs: 10000, deadlineMs: 90000, getDelayMs: () => 0 }
            : undefined
        const remote = await liveManualPeer(
          fixture.remote(),
          { ...key, incarnation: 1 },
          hub,
          fixture.target,
        )
        owners.push(remote.owner)
        await remote.owner.ready
        const requester = await liveManualPeer(local, key, hub, fixture.target, timing)
        owners.push(requester.owner)
        await requester.owner.ready
        await vi.waitFor(
          () =>
            expect(
              requester.owner.status(),
              JSON.stringify({
                requester: requester.events,
                remote: remote.events,
                remoteStatus: remote.owner.status(),
                remoteKey: remote.owner.installedKey(),
              }),
            ).toMatchObject({
              kind: 'pending',
              reason: 'target-behind',
            }),
          { timeout: expiry === 'count' ? 90000 : 12000 },
        )
        expect(await fixture.snapshot()).toEqual(before)
        const requestsBefore = requester.events.filter(
          (event) => (event as { phase?: string }).phase === 'started',
        ).length
        await vi.waitFor(
          () =>
            expect(
              requester.events.filter((event) => (event as { phase?: string }).phase === 'started')
                .length,
            ).toBeGreaterThan(requestsBefore),
          { timeout: expiry === 'count' ? 90000 : 6000 },
        )
        expect(await fixture.snapshot()).toEqual(before)
        const safety = api.createGroupSafety({
          registry: local.registry,
          persistence: local.device.groups,
          mls: fixture.requester(),
          resolveTarget: async (id) => ({ id, hub, commitTopicID: fixture.target.topicID }),
        })
        const installing = safety.recover(key, {
          mode: 'resync',
          targetID: fixture.target.targetID,
        })
        void installing.catch(() => {})
        await vi.waitFor(
          () =>
            expect(
              requester.owner.installedKey().incarnation,
              JSON.stringify({
                requester: requester.events,
                status: requester.owner.status(),
                remote: remote.events,
                remoteStatus: remote.owner.status(),
                remoteKey: remote.owner.installedKey(),
              }),
            ).toBe(2),
          { timeout: expiry === 'count' ? 90000 : 12000 },
        )
        expect(await installing).not.toEqual(key)
        const retired = await fixture.snapshot()
        expect(retired.rejoin).toEqual(before.rejoin)
        expect(retired.recoveryEpochFloor).toBe(20)
        expect(retired.settledRejoins).toEqual(before.settledRejoins)
        expect((await local.safety().status(key)).manualRecovery?.kind).toBe('completed')
        if (withheldCheckpoint !== null)
          expect(hub.published.some((row) => row.topicID === withheldCheckpoint)).toBe(false)
      } finally {
        for (const owner of owners) owner.dispose()
        await Promise.all(owners.map((owner) => owner.drained()))
        await fixture.close()
      }
    },
    expiry === 'count' ? 360000 : 30000,
  )
}

test('manual switch proof fences destination peers and resolves the saved switch ID', async () => {
  const fixture = await createRegistryFixture({
    mode: 'real-mls',
    groupID: 'manual-recovery',
    setup: 'seeded',
  })
  const key = { groupID: 'manual-recovery', incarnation: 1 }
  let owner: api.RegistryPeer | undefined
  try {
    const recovery = await fixture.confirmedRecovery(key, { confirm: true })
    if (!('format' in recovery.record) || recovery.record.switchMutationID === null)
      throw new Error('Missing captured switch')
    const saved = await fixture.manualRecovery().authoriseManualRecovery(key, {
      mode: 'resync',
      targetID: recovery.record.target.targetID,
      commitTopicID: recovery.record.target.topicID,
      allowOpenFork: false,
    })
    await fixture
      .manualRecovery()
      .manualRecoveryControl(saved.id)
      .apply(
        {
          putRejoin: {
            ...recovery.record,
            trigger: 'manual',
            authorisationID: saved.id,
          },
        },
        'saved-manual-switch',
      )
    const sourceBefore = await fixture.device.groups.ports(key).control.load()
    const topicID = recovery.record.target.topicID
    const fault = fixture.armWorkFault(recovery.record.switchMutationID, 'pending')
    const hub = refusingHub('Confirmed switch requires no network')
    const started = await manualOwner(fixture, async (id) => ({ id, hub, commitTopicID: topicID }))
    owner = started.owner
    await fault.rejected
    expect(started.created).toHaveLength(0)
    expect(owner.installedKey()).toEqual(key)
    await fault.finish('commit')
    await owner.ready
    expect(owner.installedKey()).toEqual({ ...key, incarnation: 2 })
    expect(started.created).toHaveLength(1)
    expect(await fixture.device.groups.ports(key).control.load()).toMatchObject({
      rejoin: sourceBefore.rejoin,
    })
    expect(await owner.runManualRecovery(saved)).toEqual({ ...key, incarnation: 2 })
  } finally {
    owner?.dispose()
    await owner?.drained()
    await fixture.close()
  }
})

for (const lane of ['ordinary', 'roster'] as const) {
  test(`all held responders stay silent / ${lane}`, async () => {
    const fixture = await createNotMemberFixture()
    const source = lane === 'ordinary' ? fixture.local() : fixture.remote
    const requester = lane === 'ordinary' ? fixture.remoteMLS : fixture.mls()
    const requesterDID =
      lane === 'ordinary' ? fixture.remote.identity.id : fixture.local().identity.id
    const key = lane === 'ordinary' ? fixture.key : fixture.remoteKey
    const hub = new FakeHub()
    let owner: api.RegistryPeer | undefined
    try {
      await source.safety().reportFork(key, {
        kind: 'digest-divergence',
        epoch: 0,
        position: 'reported',
        localDigest: 'ours',
        remoteDigest: 'theirs',
      })
      await source.manualRecovery().authoriseManualRecovery(key, {
        mode: 'resync',
        targetID: 'selected',
        commitTopicID: 'held-commits',
        allowOpenFork: false,
      })
      owner = (
        await liveManualPeer(source, key, hub, { targetID: 'selected', topicID: 'held-commits' })
      ).owner
      await owner.ready
      const ownRequests = () =>
        hub.published.filter((message) => {
          if (message.senderDID !== source.identity.id) return false
          try {
            return decodeHandshakeFrame(message.payload).kind === HANDSHAKE_KIND.recoveryRequest
          } catch {
            return false
          }
        }).length
      await vi.waitFor(() => expect(ownRequests()).toBeGreaterThan(0))
      const count = ownRequests()
      const requestID = crypto.randomUUID()
      const request = await requester.createRecoveryRequest(requestID)
      await hub.publish({
        senderDID: requesterDID,
        topicID: rendezvousTopic(await requester.exportRecoverySecret()),
        payload: encodeHandshakeFrame(
          HANDSHAKE_KIND.recoveryRequest,
          encodeRecoveryRequest(requestID, request.request),
        ),
      })
      await vi.waitFor(() => expect(ownRequests()).toBeGreaterThan(count), { timeout: 5000 })
      expect(
        hub.published.filter((message) => {
          if (message.senderDID !== source.identity.id) return false
          try {
            return decodeHandshakeFrame(message.payload).kind === HANDSHAKE_KIND.recoveryReply
          } catch {
            return false
          }
        }),
      ).toEqual([])
    } finally {
      owner?.dispose()
      await owner?.drained()
      await fixture.close()
    }
  })
}

test('manual executor stays bound to its group when registries own multiple peers', async () => {
  const fixture = await createRegistryFixture({
    mode: 'real-mls',
    groupID: 'manual-recovery',
    setup: 'seeded',
  })
  const key = { groupID: 'manual-recovery', incarnation: 1 }
  const owners: Array<api.RegistryPeer> = []
  try {
    const otherKey = await fixture.registry.seed(
      await fixture.makeHandle(0, 'second-manual-group'),
      { packageUse: null },
    )
    const selected = vi.fn(async (_id: string) => {
      throw new Error('Selected binding unavailable')
    })
    const other = vi.fn(async (_id: string) => {
      throw new Error('Other group binding unavailable')
    })
    const first = await manualOwner(fixture, selected)
    owners.push(first.owner)
    await first.owner.ready
    const second = await manualOwner(fixture, other, otherKey)
    owners.push(second.owner)
    await second.owner.ready
    const saved = await fixture.manualRecovery().authoriseManualRecovery(key, {
      mode: 'resync',
      targetID: 'selected',
      commitTopicID: 'selected-topic',
      allowOpenFork: false,
    })
    void first.owner.runManualRecovery(saved).catch(() => {})
    await vi.waitFor(() => expect(selected).toHaveBeenCalledWith('selected'))
    expect(other).not.toHaveBeenCalled()
    expect(second.owner.installedKey()).toEqual(otherKey)
  } finally {
    for (const owner of owners) owner.dispose()
    await Promise.all(owners.map((owner) => owner.drained()))
    await fixture.close()
  }
})

test('authenticated refusal preserves manual source and halt', async () => {
  const fixture = await createForkRecoveryRealFixture(true)
  const local = fixture.local()
  const key = fixture.key
  try {
    await fixture.saveX('built')
    const saved = await local.manualRecovery().authoriseManualRecovery(key, {
      mode: 'resync',
      targetID: fixture.target.targetID,
      commitTopicID: fixture.target.topicID,
      allowOpenFork: false,
    })
    const mls = await api.createRegistryGroupMLS({
      registry: local.registry,
      key,
      recovery: local.environment,
      identity: local.identity,
      entrySlot: api.createLedgerEntrySlot(),
      target: fixture.target,
      manualRecovery: { source: key, authorisationID: saved.id },
    })
    const reply = await fixture.reply()
    const pending = await mls.capturedRecovery?.applyRecovery(
      reply.sealed,
      reply.requestID,
      reply.requestKey,
    )
    if (pending == null || 'renewalRequired' in pending) throw new Error('Missing manual candidate')
    const position = asLogPosition('refused-position')
    const built = capturedRecord(pending, reply.request, reply.requestKey, reply.requestID)
    await pending.confirmationKey(position, built.digest)
    const responder = await (await fixture.remote().registry.access(key.groupID)).read(
      async (group) => {
        const state = decodeClientState(encodeClientState(group.state))
        if (state === undefined) throw new Error('Missing responder state')
        return restoreGroup({
          state,
          credential: group.credential,
          ledgerEntries: group.ledgerTokens,
          options: fixture.remote().environment.options,
        })
      },
    )
    await responder.processMessage(pending.commit)
    const verdict = await sealRecoveryVerdict({
      group: responder,
      identity: fixture.responderIdentity,
      request: new TextDecoder().decode(reply.request),
      verdict: {
        groupID: key.groupID,
        requestID: reply.requestID,
        position,
        commitDigest: built.digest,
        verdict: 'refused',
        reason: 'policy',
        refusalAuthority: 'authenticated-commit',
      },
    })
    expect(await mls.openRecoveryVerdict(verdict, reply.requestID, reply.requestKey)).toMatchObject(
      { verdict: { verdict: 'refused', reason: 'policy' } },
    )
    const record = {
      ...built,
      stage: 'confirmed' as const,
      position,
      verdict,
      candidate: pending.serialize(),
      trigger: 'manual' as const,
      authorisationID: saved.id,
      switchMutationID: crypto.randomUUID(),
    }
    await local
      .manualRecovery()
      .manualRecoveryControl(saved.id)
      .apply({ putRejoin: record }, 'save-refused-confirmation')
    await local.safety().reportFork(key, {
      kind: 'digest-divergence',
      epoch: 10,
      position: 'reported',
      localDigest: 'ours',
      remoteDigest: 'theirs',
    })
    const snapshot = decodeCapturedRecoveryCandidate(record.candidate, record.requestKey)
    const candidate = await restoreGroup({
      state: snapshot.state,
      credential: snapshot.source.trust.credential,
      ledgerEntries: snapshot.replyLedger,
      options: local.environment.options,
    })
    const before = await local.inspectRows()
    await expect(
      local.registry.switchIncarnation(candidate, {
        source: await local.registry.recoverySource(key.groupID),
        rejoinID: record.id,
        proof: { ...record.target, position, payloadDigest: record.payloadDigest, verdict },
        write: {
          mutationID: record.switchMutationID,
          source: { rejoinID: record.id, authorisationID: saved.id },
          destination: { control: { cursor: { position, epoch: record.epochAfter } } },
        },
      }),
    ).rejects.toMatchObject({ name: 'RegistryResyncRefusedError', reason: 'unaccepted' })
    expect(await local.inspectRows()).toEqual(before)
  } finally {
    await fixture.close()
  }
})

test('manual adapter rechecks its saved floor on apply and restore', async () => {
  const fixture = await createForkRecoveryRealFixture(true)
  const local = fixture.local()
  const key = fixture.key
  try {
    const saved = await local.manualRecovery().authoriseManualRecovery(key, {
      mode: 'resync',
      targetID: fixture.target.targetID,
      commitTopicID: fixture.target.topicID,
      allowOpenFork: false,
    })
    const mls = await api.createRegistryGroupMLS({
      registry: local.registry,
      key,
      target: fixture.target,
      identity: local.identity,
      recovery: local.environment,
      entrySlot: api.createLedgerEntrySlot(),
      manualRecovery: { source: key, authorisationID: saved.id },
    })
    const reply = await fixture.reply()
    const pending = await mls.capturedRecovery?.applyRecovery(
      reply.sealed,
      reply.requestID,
      reply.requestKey,
    )
    if (pending == null || 'renewalRequired' in pending) throw new Error('Missing manual candidate')
    const record = {
      ...capturedRecord(pending, reply.request, reply.requestKey, reply.requestID),
      trigger: 'manual' as const,
      authorisationID: saved.id,
    }
    await local
      .manualRecovery()
      .manualRecoveryControl(saved.id)
      .apply({ putRejoin: record, recoveryEpochFloor: 13 }, 'advanced-manual-floor')
    const next = await fixture.reply()
    await expect(
      mls.capturedRecovery?.applyRecovery(next.sealed, next.requestID, next.requestKey),
    ).rejects.toMatchObject({ name: 'RecoveryTargetBehindError' })
    await expect(
      mls.capturedRecovery?.restoreRecovery(record.candidate, record.requestKey),
    ).rejects.toMatchObject({ name: 'RecoveryTargetBehindError' })
    expect((await local.manualRecovery().readManualRecovery(saved.id))?.attempt).toEqual(record)
  } finally {
    await fixture.close()
  }
})

test('manual MLS construction requires its committed source and selected target', async () => {
  const fixture = await createRegistryFixture({
    mode: 'real-mls',
    groupID: 'manual-recovery',
    setup: 'seeded',
  })
  const key = { groupID: 'manual-recovery', incarnation: 1 }
  try {
    const saved = await fixture.manualRecovery().authoriseManualRecovery(key, {
      mode: 'resync',
      targetID: 'selected',
      commitTopicID: 'selected-topic',
      allowOpenFork: false,
    })
    for (const invalid of [
      {
        manualRecovery: { source: { ...key, incarnation: 2 }, authorisationID: saved.id },
        target: { targetID: 'selected', topicID: 'selected-topic' },
      },
      {
        manualRecovery: { source: key, authorisationID: 'uncommitted' },
        target: { targetID: 'selected', topicID: 'selected-topic' },
      },
      {
        manualRecovery: { source: key, authorisationID: saved.id },
        target: { targetID: 'other', topicID: 'selected-topic' },
      },
      {
        manualRecovery: { source: key, authorisationID: saved.id },
        target: { targetID: 'selected', topicID: 'other-topic' },
      },
    ]) {
      await expect(
        api.createRegistryGroupMLS({
          registry: fixture.registry,
          key,
          identity: fixture.identity,
          recovery: fixture.environment,
          entrySlot: api.createLedgerEntrySlot(),
          ...invalid,
        }),
      ).rejects.toThrow()
    }
    expect((await fixture.manualRecovery().readManualRecovery(saved.id))?.attempt).toBeNull()
  } finally {
    await fixture.close()
  }
})

test('older authenticated capture stays target-behind when saved source has advanced', async () => {
  const fixture = await createForkRecoveryRealFixture(true)
  const local = fixture.local()
  const key = fixture.key
  try {
    await fixture.saveX('built')
    const before = await fixture.snapshot()
    const record = before.rejoin
    if (record === null || !('format' in record)) throw new Error('Missing saved X')
    const current = await local.device.groups.loadState(key)
    if (current === null || current.deleted || current.state === null)
      throw new Error('Missing source')
    const state = decodeClientState(current.state)
    if (state === undefined) throw new Error('Missing MLS state')
    const handle = await restoreGroup({
      state,
      credential: current.credential,
      ledgerEntries: current.ledger,
      options: local.environment.options,
    })
    const next = (await commitKeyRotation(handle)).newGroup
    await local.installRows({
      key,
      state: {
        ...current,
        version: current.version + 1,
        epoch: Number(next.epoch),
        epochAuthenticator: next.state.keySchedule.epochAuthenticator,
        state: encodeClientState(next.state),
      },
      trust: recoveryTrustFor(next, key, await local.device.groups.loadTrust(key.groupID)),
    })
    const reply = await fixture.reply()
    await expect(
      fixture.requester().capturedRecovery?.reconcileCapture(record, reply),
    ).resolves.toEqual({ kind: 'retry', reason: 'target-behind' })
    expect(await fixture.snapshot()).toEqual(before)
  } finally {
    await fixture.close()
  }
})

test('manual policy refusal rejects the caller without changing ordinary work', async () => {
  const fixture = await createRegistryFixture({
    mode: 'real-mls',
    groupID: 'manual-recovery',
    setup: 'seeded',
  })
  const key = { groupID: 'manual-recovery', incarnation: 1 }
  const started = await manualOwner(fixture, async () => {
    throw new Error('Refused recovery must not resolve transport')
  })
  try {
    await started.owner.ready
    const recovery = await fixture.confirmedRecovery(key)
    if (!('format' in recovery.record)) throw new Error('Missing captured candidate')
    const saved = await fixture.manualRecovery().authoriseManualRecovery(key, {
      mode: 'resync',
      targetID: recovery.record.target.targetID,
      commitTopicID: recovery.record.target.topicID,
      allowOpenFork: false,
    })
    await fixture
      .manualRecovery()
      .manualRecoveryControl(saved.id)
      .apply(
        {
          putRejoin: {
            ...recovery.record,
            trigger: 'manual',
            authorisationID: saved.id,
            stage: 'refused',
            refusal: 'policy',
          },
        },
        'save-manual-refusal',
      )
    const before = await fixture.device.groups.ports(key).control.load()
    await expect(started.owner.runManualRecovery(saved)).rejects.toMatchObject({
      name: 'RegistryResyncRefusedError',
      reason: 'unaccepted',
    })
    expect(await fixture.device.groups.ports(key).control.load()).toEqual(before)
    expect(started.created).toHaveLength(1)
  } finally {
    started.owner.dispose()
    await started.owner.drained()
    await fixture.close()
  }
})

test('hard control held MLS responders refuse public group captures', async () => {
  const fixture = await createForkRecoveryRealFixture(true)
  try {
    const remote = fixture.remote()
    const responder = await api.createRegistryGroupMLS({
      registry: remote.registry,
      key: fixture.key,
      target: fixture.target,
      identity: remote.identity,
      recovery: remote.environment,
      entrySlot: api.createLedgerEntrySlot(),
    })
    const held = await responder.createRecoveryRequest('ordinary-held-request')
    await expect(
      fixture.requester().capturedRecovery?.sealGroupInfo(held.request, null),
    ).resolves.toBeInstanceOf(Uint8Array)
    await fixture.local().installRows({
      key: fixture.key,
      control: { controlHold: { reason: 'unsupported-version', position: null } },
    })
    await expect(
      fixture.requester().capturedRecovery?.sealGroupInfo(held.request, null),
    ).rejects.toThrow()
  } finally {
    await fixture.close()
  }
})

test('hard control held MLS responders refuse former-member rosters', async () => {
  const fixture = await createNotMemberFixture()
  try {
    const request = await fixture.proof()
    await expect(
      fixture.remoteMLS.capturedRecovery?.sealRosterAbsence?.(request.request, null),
    ).resolves.toBeInstanceOf(Uint8Array)
    await fixture.remote.installRows({
      key: fixture.remoteKey,
      control: { controlHold: { reason: 'unsupported-version', position: null } },
    })
    await expect(
      fixture.remoteMLS.capturedRecovery?.sealRosterAbsence?.(request.request, null),
    ).resolves.toBeNull()
  } finally {
    await fixture.close()
  }
})

test('saved manual authority fences late automatic fork authorisation', async () => {
  const fixture = await createForkRecoveryRealFixture(true)
  try {
    await fixture.saveX('built')
    const reply = await fixture.reply()
    await fixture.local().manualRecovery().authoriseManualRecovery(fixture.key, {
      mode: 'resync',
      targetID: fixture.target.targetID,
      commitTopicID: fixture.target.topicID,
      allowOpenFork: false,
    })
    const before = await fixture.snapshot()
    expect(
      await fixture.requester().capturedRecovery?.authoriseForkRecovery?.(reply, fixture.noticeID),
    ).toBeNull()
    expect(await fixture.snapshot()).toEqual(before)
  } finally {
    await fixture.close()
  }
})

test('saved manual authority fences late ordinary switches', async () => {
  const fixture = await createRegistryFixture({
    mode: 'real-mls',
    groupID: 'manual-recovery',
    setup: 'seeded',
  })
  const key = { groupID: 'manual-recovery', incarnation: 1 }
  try {
    const recovery = await fixture.confirmedRecovery(key, { confirm: true })
    if (!('format' in recovery.record) || recovery.record.switchMutationID === null)
      throw new Error('Missing ordinary X')
    await fixture.manualRecovery().authoriseManualRecovery(key, {
      mode: 'resync',
      targetID: 'selected',
      commitTopicID: 'selected-topic',
      allowOpenFork: false,
    })
    const before = await fixture.inspectRows()
    await expect(
      fixture.registry.switchIncarnation(recovery.candidate, {
        source: await fixture.registry.recoverySource(key.groupID),
        rejoinID: recovery.record.id,
        proof: recovery.proof,
        write: {
          mutationID: recovery.record.switchMutationID,
          source: { rejoinID: recovery.record.id },
          destination: {
            control: {
              cursor: { position: recovery.proof.position, epoch: recovery.record.epochAfter },
            },
          },
        },
      }),
    ).rejects.toThrow()
    expect(await fixture.inspectRows()).toEqual(before)
  } finally {
    await fixture.close()
  }
})

test.each(['startup', 'handoff'] as const)(
  'a late ordinary switch failure cannot cancel authorised manual recovery / %s',
  async (phase) => {
    const fixture = await createRegistryFixture({
      mode: 'real-mls',
      groupID: 'manual-recovery',
      setup: 'seeded',
    })
    const key = { groupID: 'manual-recovery', incarnation: 1 }
    const entered = deferred<void>()
    const release = deferred<void>()
    let owner: api.RegistryPeer | undefined
    let restore = () => {}
    try {
      const ordinary = await fixture.confirmedRecovery(key, { confirm: phase === 'startup' })
      const candidate = await fixture.confirmedRecovery(key)
      if (!('format' in ordinary.record) || !('format' in candidate.record))
        throw new Error('Missing captured work')
      const ordinaryID = ordinary.record.id
      const coordinator = registryRecoveryCoordinator(fixture.registry)
      const resolve = coordinator.resolveRecoverySwitch.bind(coordinator)
      const spy = vi
        .spyOn(coordinator, 'resolveRecoverySwitch')
        .mockImplementation(async (record) => {
          if (record.id === ordinaryID) {
            entered.resolve()
            await release.promise
          }
          return await resolve(record)
        })
      restore = () => spy.mockRestore()
      const hub = new FakeHub()
      const topicID = candidate.record.target.topicID
      const started = await manualOwner(
        fixture,
        async (id) => ({ id, hub, commitTopicID: topicID }),
        key,
        { targetID: ordinary.record.target.targetID, topicID: ordinary.record.target.topicID },
      )
      owner = started.owner
      if (phase === 'handoff') {
        await owner.ready
        await fixture.installRows({ key, control: { putRejoin: ordinary.record } })
        started.created[0]?.onConfirmedRecovery({
          record: ordinary.record,
          completion: Promise.resolve(),
        })
      }
      await entered.promise
      const saved = await fixture.manualRecovery().authoriseManualRecovery(key, {
        mode: 'resync',
        targetID: candidate.record.target.targetID,
        commitTopicID: topicID,
        allowOpenFork: false,
      })
      await fixture
        .manualRecovery()
        .manualRecoveryControl(saved.id)
        .apply(
          { putRejoin: { ...candidate.record, trigger: 'manual', authorisationID: saved.id } },
          'save-selected-manual',
        )
      const running = owner.runManualRecovery(saved)
      void running.catch(() => {})
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      release.resolve()
      await expect(running).resolves.toEqual({ ...key, incarnation: 2 })
      expect(owner.installedKey()).toEqual({ ...key, incarnation: 2 })
      expect((await fixture.device.groups.ports(key).control.load()).rejoin).toEqual(
        ordinary.record,
      )
      expect(hub.published).toEqual([])
    } finally {
      release.resolve()
      restore()
      owner?.dispose()
      await owner?.drained()
      await fixture.close()
    }
  },
)

test('saved manual authority fences late ordinary switch ID assignment', async () => {
  const fixture = await createRegistryFixture({
    mode: 'real-mls',
    groupID: 'manual-recovery',
    setup: 'seeded',
  })
  const key = { groupID: 'manual-recovery', incarnation: 1 }
  try {
    const recovery = await fixture.confirmedRecovery(key)
    if (!('format' in recovery.record)) throw new Error('Missing ordinary X')
    const record = { ...recovery.record, switchMutationID: null }
    await fixture.installRows({ key, control: { putRejoin: record } })
    await fixture.manualRecovery().authoriseManualRecovery(key, {
      mode: 'resync',
      targetID: 'selected',
      commitTopicID: 'selected-topic',
      allowOpenFork: false,
    })
    const before = await fixture.device.groups.ports(key).control.load()
    await expect(
      registryRecoveryCoordinator(fixture.registry).assignSwitchID(record),
    ).rejects.toThrow()
    expect(await fixture.device.groups.ports(key).control.load()).toEqual(before)
  } finally {
    await fixture.close()
  }
})

test('manual refusal notification reaches the active caller', async () => {
  const fixture = await createForkRecoveryRealFixture(true)
  const local = fixture.local()
  const key = fixture.key
  let owner: api.RegistryPeer | undefined
  try {
    const storage = local.manualRecovery()
    const saved = await storage.authoriseManualRecovery(key, {
      mode: 'resync',
      targetID: fixture.target.targetID,
      commitTopicID: fixture.target.topicID,
      allowOpenFork: false,
    })
    const mls = await api.createRegistryGroupMLS({
      registry: local.registry,
      key,
      target: fixture.target,
      identity: local.identity,
      recovery: local.environment,
      entrySlot: api.createLedgerEntrySlot(),
      manualRecovery: { source: key, authorisationID: saved.id },
    })
    const reply = await fixture.reply()
    const pending = await mls.capturedRecovery?.applyRecovery(
      reply.sealed,
      reply.requestID,
      reply.requestKey,
    )
    if (pending == null || 'renewalRequired' in pending) throw new Error('Missing manual candidate')
    const record = {
      ...capturedRecord(pending, reply.request, reply.requestKey, reply.requestID),
      trigger: 'manual' as const,
      authorisationID: saved.id,
    }
    await storage
      .manualRecoveryControl(saved.id)
      .apply({ putRejoin: record }, 'save-manual-notification')
    const hub = new FakeHub()
    const started = await manualOwner(
      local,
      async (id) => ({ id, hub, commitTopicID: fixture.target.topicID }),
      key,
      fixture.target,
    )
    owner = started.owner
    await owner.ready
    const prior = started.created.length
    const running = owner.runManualRecovery(saved)
    void running.catch(() => {})
    await vi.waitFor(() => expect(started.created.length).toBeGreaterThan(prior))
    const before = await fixture.snapshot()
    await storage
      .manualRecoveryControl(saved.id)
      .apply(
        { putRejoin: { ...record, stage: 'refused', refusal: 'policy' } },
        'manual-notification-refused',
      )
    await started.created.at(-1)?.onRecovery?.({
      groupID: fixture.target.topicID,
      attemptID: record.id,
      trigger: 'consumer',
      phase: 'failed',
      reason: 'refused',
      refusal: 'policy',
    })
    await expect(running).rejects.toMatchObject({
      name: 'RegistryResyncRefusedError',
      reason: 'unaccepted',
    })
    expect(await fixture.snapshot()).toEqual(before)
  } finally {
    owner?.dispose()
    await owner?.drained()
    await fixture.close()
  }
})

test('registered manual recovery snapshots its choice before resolving transport', async () => {
  const fixture = await createRegistryFixture({
    mode: 'real-mls',
    groupID: 'manual-recovery',
    setup: 'seeded',
  })
  const key = { groupID: 'manual-recovery', incarnation: 1 }
  const source = { ...key }
  const entered = deferred<void>()
  const release = deferred<void>()
  try {
    const hub = new FakeHub()
    const safety = api.createGroupSafety({
      registry: fixture.registry,
      persistence: fixture.device.groups,
      mls: await api.createRegistryGroupMLS({
        registry: fixture.registry,
        key,
        target: { targetID: 'selected', topicID: 'selected-topic' },
        identity: fixture.identity,
        recovery: fixture.environment,
        entrySlot: api.createLedgerEntrySlot(),
      }),
      resolveTarget: async () => {
        entered.resolve()
        await release.promise
        return { id: 'selected', commitTopicID: 'selected-topic', hub }
      },
    })
    const choice = { mode: 'resync' as const, targetID: 'selected', allowOpenFork: false }
    const running = safety.recover(key, choice)
    void running.catch(() => {})
    await entered.promise
    key.incarnation = 2
    choice.targetID = 'substituted'
    choice.allowOpenFork = true
    release.resolve()
    await expect(running).rejects.toThrow('Registered recovery peer required')
    const status = (await safety.status(source)).manualRecovery
    if (status === null) throw new Error('Missing saved authority')
    const saved = await fixture.manualRecovery().readManualRecovery(status.id)
    expect(saved?.source).toEqual(source)
    expect(saved?.choice).toEqual({
      mode: 'resync',
      targetID: 'selected',
      commitTopicID: 'selected-topic',
      allowOpenFork: false,
    })
    expect(hub.published).toEqual([])
  } finally {
    release.resolve()
    await fixture.close()
  }
})

test('manual executor requires the exact saved choice', async () => {
  const fixture = await createRegistryFixture({
    mode: 'real-mls',
    groupID: 'manual-recovery',
    setup: 'seeded',
  })
  const key = { groupID: 'manual-recovery', incarnation: 1 }
  try {
    const saved = await fixture.manualRecovery().authoriseManualRecovery(key, {
      mode: 'resync',
      targetID: 'selected',
      commitTopicID: 'selected-topic',
      allowOpenFork: false,
    })
    if (saved.choice.mode !== 'resync') throw new Error('Missing selected target')
    const before = await fixture.inspectRows()
    await expect(
      registryRecoveryCoordinator(fixture.registry).runManual({
        ...saved,
        choice: { ...saved.choice, targetID: 'substituted' },
      }),
    ).rejects.toThrow('Manual authorisation moved')
    expect(await fixture.inspectRows()).toEqual(before)
  } finally {
    await fixture.close()
  }
})
