import type { LogHub, MailboxHub } from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import * as api from '../src/index.js'
import { encodeStoredValue } from '../src/persistence-codec.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createRegistryFixture, registryFixtureSafetyParams } from './fixtures/registry.js'

const key = { groupID: 'hub-migration', incarnation: 1 }
const binding = { targetID: 'registry-recovery-hub', commitTopicID: `commits/${key.groupID}` }

function watchedHub() {
  const calls = vi.fn()
  return {
    calls,
    hub: new Proxy({} as LogHub & MailboxHub, {
      get(_target, property) {
        calls(property)
        throw new Error('Unexpected network action')
      },
    }),
  }
}

async function start(
  fixture: Awaited<ReturnType<typeof createRegistryFixture>>,
  resolveTarget: (id: string) => Promise<api.RecoveryTarget>,
) {
  const created: Array<api.RegistryPeerOptions> = []
  const owner = await api.createRegistryPeer({
    registry: fixture.registry,
    key,
    target: { targetID: 'original-hub', topicID: 'original-commits' },
    recovery: fixture.environment,
    resolveTarget,
    continuation: api.createRecoveryContinuationPort({
      registry: fixture.registry,
      persistence: fixture.device.groups,
    }),
    createMLS: (current, _handoff, options) =>
      api.createRegistryGroupMLS({
        registry: fixture.registry,
        key: current,
        recovery: fixture.environment,
        identity: fixture.identity,
        entrySlot: api.createLedgerEntrySlot(),
        ...options,
      }),
    createPeer: async (_current, options) => {
      created.push(options)
      return { dispose: async () => {}, drained: async () => {} } as unknown as NonNullable<
        ReturnType<api.RegistryPeer['peer']>
      >
    },
  })
  await owner.ready
  return { owner, created }
}

for (const mode of ['real-mls', 'double'] as const) {
  for (const context of ['supplied', 'absent'] as const) {
    test(`unresolvable call time target remains paused / ${mode} / ${context}`, async () => {
      let fixture = await createRegistryFixture({
        mode,
        groupID: key.groupID,
        setup: 'seeded',
        ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
      })
      const { hub, calls } = watchedHub()
      const resolver = vi.fn(async (_id: string): Promise<api.RecoveryTarget> => {
        throw new Error('Host handle unavailable')
      })
      let active: Awaited<ReturnType<typeof start>> | undefined
      try {
        active = await start(fixture, resolver)
        const safety = api.createGroupSafety(await registryFixtureSafetyParams(fixture))
        const running = safety.recover(key, { mode: 'resync', target: { ...binding, hub } })
        void running.catch(() => {})
        await vi.waitFor(async () => {
          await Promise.race([running, Promise.resolve()])
          expect(active?.created).toHaveLength(2)
        })
        expect(resolver).not.toHaveBeenCalled()
        expect(active.created[1]).toMatchObject({
          target: {
            targetID: binding.targetID,
            topicID: binding.commitTopicID,
          },
          recoveryTarget: { targetID: binding.targetID, topicID: binding.commitTopicID },
        })
        expect(active.created[1]?.hub).toBe(hub)
        const status = (await safety.status(key)).manualRecovery
        if (status === null) throw new Error('Missing saved choice')
        const saved = await fixture.manualRecovery().readManualRecovery(status.id)
        expect(saved?.choice).toEqual({ mode: 'resync', ...binding, allowOpenFork: false })
        active.owner.dispose()
        await active.owner.drained()
        fixture = await fixture.reopen()
        active = await start(fixture, resolver)
        expect(active.owner.status()).toMatchObject({
          kind: 'pending',
          reason: 'target-unresolved',
          authorisationID: status.id,
        })
        expect(active.created).toEqual([])
        expect((await fixture.safety().status(key)).manualRecovery).toEqual({
          id: status.id,
          kind: 'paused',
          reason: 'target-unresolved',
        })
        expect(await fixture.manualRecovery().readManualRecovery(status.id)).toEqual({
          ...saved,
          pauseReason: 'target-unresolved',
          mutationID: expect.any(String),
        })
        expect(resolver.mock.calls.every(([id]) => id === binding.targetID)).toBe(true)
        expect(calls).not.toHaveBeenCalled()
      } finally {
        active?.owner.dispose()
        await active?.owner.drained()
        await fixture.close()
      }
    })

    for (const mismatch of ['id', 'topic'] as const) {
      test(`${mismatch === 'id' ? 'resolver cannot substitute saved target or topic' : 'restored host handle resumes identical move'} / ${mismatch} / ${mode} / ${context}`, async () => {
        let fixture = await createRegistryFixture({
          mode,
          groupID: key.groupID,
          setup: 'seeded',
          ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        })
        const alternate = watchedHub()
        let active: Awaited<ReturnType<typeof start>> | undefined
        try {
          const candidate = await fixture.confirmedRecovery(key, { confirm: false })
          if (!('format' in candidate.record)) throw new Error('Captured candidate required')
          await fixture.installRows({
            key,
            control: {
              putSettledRejoins: [
                {
                  kind: 'not-accepted',
                  id: 'earlier-work',
                  epoch: 0,
                  origin: { sourceKey: key, target: candidate.record.target, searchFrom: null },
                  ledgerBefore: candidate.record.ledgerBefore,
                },
              ],
            },
          })
          const saved = await fixture.manualRecovery().authoriseManualRecovery(key, {
            mode: 'resync',
            ...binding,
            allowOpenFork: true,
          })
          expect(saved.settlements).toHaveLength(1)
          expect(saved.settlements[0]?.ledgerBefore).toEqual(
            expect.arrayContaining(candidate.record.ledgerBefore),
          )
          await fixture.safety().reportFork(key, {
            kind: 'digest-divergence',
            epoch: 0,
            position: 'source-fork',
            localDigest: 'ours',
            remoteDigest: 'theirs',
          })
          await fixture
            .manualRecovery()
            .manualRecoveryControl(saved.id)
            .apply(
              {
                putRejoin: {
                  ...candidate.record,
                  stage: 'built',
                  switchMutationID: null,
                  target: { ...candidate.record.target },
                  trigger: 'manual',
                  authorisationID: saved.id,
                },
              },
              'save-exact-work',
            )
          const before = await fixture.manualRecovery().readManualRecovery(saved.id)
          const control = await fixture.device.groups.ports(key).control.load()
          const source = await fixture.registry.recoverySource(key.groupID)
          fixture = await fixture.reopen()
          let restored = false
          const resolve = vi.fn(async (id: string) => ({
            id: restored || mismatch !== 'id' ? id : 'substituted-hub',
            commitTopicID:
              restored || mismatch !== 'topic' ? binding.commitTopicID : 'substituted-topic',
            hub: alternate.hub,
          }))
          const storage = api.createManualRecoveryStore({
            registry: fixture.registry,
            persistence: fixture.device.groups,
            key,
            resolveTarget: resolve,
          })
          expect((await storage.resolveManualRecoveryTarget(saved.id)) === null).toBe(true)
          active = await start(fixture, resolve)
          expect(active.created).toEqual([])
          expect(active.owner.status()).toMatchObject({
            reason: 'target-unresolved',
            authorisationID: saved.id,
          })
          expect(await fixture.device.groups.ports(key).control.load()).toEqual(control)
          expect(await fixture.registry.recoverySource(key.groupID)).toEqual({
            ...source,
            lifetimeRevision: expect.any(Number),
          })
          const paused = await fixture.manualRecovery().readManualRecovery(saved.id)
          expect(paused).toEqual({
            ...before,
            pauseReason: 'target-unresolved',
            mutationID: expect.any(String),
          })
          expect(alternate.calls).not.toHaveBeenCalled()
          restored = true
          await vi.waitFor(() => expect(active?.created).toHaveLength(1), { timeout: 2500 })
          expect(active.created[0]).toMatchObject({
            target: { targetID: binding.targetID, topicID: binding.commitTopicID },
            manualRecovery: { authorisationID: saved.id, source: key },
          })
          expect(active.created[0]?.hub).toBe(alternate.hub)
          const resumed = await fixture.manualRecovery().readManualRecovery(saved.id)
          expect(resumed).toEqual({ ...before, mutationID: expect.any(String) })
          expect(encodeStoredValue(resumed?.attempt)).toEqual(encodeStoredValue(before?.attempt))
          expect(resolve.mock.calls.every(([id]) => id === binding.targetID)).toBe(true)
        } finally {
          active?.owner.dispose()
          await active?.owner.drained()
          await fixture.close()
        }
      })
    }
  }
}

test('call time authority is saved before hub use', async () => {
  const fixture = await createRegistryFixture({
    mode: 'real-mls',
    groupID: key.groupID,
    setup: 'seeded',
  })
  const { hub, calls } = watchedHub()
  const resolver = vi.fn(async (): Promise<api.RecoveryTarget> => {
    throw new Error('Resolver must not replace live hub')
  })
  const active = await start(fixture, resolver)
  try {
    const safety = api.createGroupSafety(await registryFixtureSafetyParams(fixture))
    const choice = { mode: 'resync' as const, target: { ...binding, hub }, allowOpenFork: true }
    const fault = fixture.armNextWorkFault('pending')
    let proof: ReturnType<typeof fixture.holdProof> | undefined
    fixture.onPhase('work', async () => {
      proof = fixture.holdProof(await fault.mutationID)
    })
    const running = safety.recover(key, choice)
    void running.catch(() => {})
    await Promise.race([fault.rejected, running])
    expect(active.created).toHaveLength(1)
    expect(calls).not.toHaveBeenCalled()
    expect(resolver).not.toHaveBeenCalled()
    choice.target.targetID = 'changed'
    choice.target.commitTopicID = 'changed-topic'
    choice.allowOpenFork = false
    if (proof === undefined) throw new Error('Missing proof barrier')
    const finishing = fault.finish('commit')
    await proof.started
    expect(active.created).toHaveLength(1)
    expect(calls).not.toHaveBeenCalled()
    proof.release()
    await finishing
    await vi.waitFor(() => expect(active.created).toHaveLength(2))
    const status = (await safety.status(key)).manualRecovery
    if (status === null) throw new Error('Missing saved authority')
    const saved = await fixture.manualRecovery().readManualRecovery(status.id)
    expect(saved?.choice).toEqual({ mode: 'resync', ...binding, allowOpenFork: true })
    expect(active.created[1]?.hub).toBe(hub)
    expect(calls).not.toHaveBeenCalled()
  } finally {
    active.owner.dispose()
    await active.owner.drained()
    await fixture.close()
  }
})
