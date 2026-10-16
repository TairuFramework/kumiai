import {
  asLogPosition,
  type LogHub,
  type LogPosition,
  type MailboxHub,
  type ManualRecoveryRecord,
  type ManualRecoveryStatus,
  type PersistedManualRecovery,
} from '@kumiai/rpc'
import {
  type ConformanceManualRecoveryRecord,
  type ConformanceManualRecoveryStatus,
  type ConformancePersistedManualRecovery,
  testManualRecoveryConformance,
} from '@kumiai/rpc-conformance'
import { expect, expectTypeOf, test } from 'vitest'

import { entryCapability } from '../src/entry-capability.js'
import { createManualRecoveryStore } from '../src/manual-recovery.js'
import { recoveryCompletionContexts } from '../src/recovery-completion-context.js'
import { createForkRecoveryRealFixture } from './fixtures/captured-recovery.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createRegistryFixture, registryFixtureMutateControl } from './fixtures/registry.js'

expectTypeOf<ManualRecoveryRecord>().toEqualTypeOf<ConformanceManualRecoveryRecord<LogPosition>>()
expectTypeOf<ManualRecoveryStatus>().toEqualTypeOf<ConformanceManualRecoveryStatus>()
expectTypeOf<PersistedManualRecovery>().toEqualTypeOf<ConformancePersistedManualRecovery>()

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
    })
  }
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
  const hub = new Proxy({} as LogHub & MailboxHub, {
    get() {
      throw new Error('Storage must not call hub methods')
    },
  })
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

test('manual overlay rejects fork floor authority even with matching ordinary intent', async () => {
  const fixture = await createForkRecoveryRealFixture(true)
  try {
    const storage = fixture.local().manualRecovery()
    const saved = await storage.authoriseManualRecovery(fixture.key, {
      mode: 'resync',
      targetID: fixture.target.targetID,
      commitTopicID: fixture.target.topicID,
      allowOpenFork: false,
    })
    const reply = await fixture.reply()
    const authority = await fixture
      .requester()
      .capturedRecovery?.authoriseForkRecovery?.(reply, fixture.noticeID)
    if (authority == null) throw new Error('Missing real fork authority')
    const y = await fixture.build(authority, reply)
    if (y === null) throw new Error('Missing real fork candidate')
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
