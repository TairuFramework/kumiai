import { createGroupPeer, type LogHub, type MailboxHub } from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import * as api from '../../../packages/mls-rpc/src/index.js'
import { createAsyncLocalOwnershipContext } from '../../../packages/mls-rpc/test/fixtures/ownership-context.js'
import {
  createRegistryFixture,
  type RegistryFixture,
  registryFixtureSafetyParams,
} from '../../../packages/mls-rpc/test/fixtures/registry.js'
import { FakeHub } from '../../../packages/rpc/test/fixtures/fake-hub.js'

const key = { groupID: 'hub-migration-live', incarnation: 1 }
const binding = { targetID: 'registry-recovery-hub', commitTopicID: `commits/${key.groupID}` }

async function start(
  fixture: RegistryFixture,
  resolveTarget: (id: string) => Promise<api.RecoveryTarget>,
) {
  const created: Array<api.RegistryPeerOptions> = []
  const owner = await api.createRegistryPeer({
    registry: fixture.registry,
    key,
    recovery: fixture.environment,
    target: { targetID: 'old-host-handle', topicID: 'old-commits' },
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
    createPeer: async (current, options) => {
      created.push(options)
      const access = await fixture.registry.access(current.groupID)
      const crypto = api.createGroupCrypto({
        access: {
          ...api.createRegistryHandleAccess({ access }),
          open: async () => {
            throw new Error('No app traffic expected')
          },
        },
      })
      const ports = fixture.device.groups.ports(current)
      return createGroupPeer({
        ...options,
        hub: options.hub ?? new FakeHub(),
        crypto,
        control: options.control ?? ports.control,
        anchorStore: ports.anchor,
        appCursorStore: ports.cursor,
        appOutbox: ports.outbox,
        appOutboxLimit: 16,
        localDID: fixture.identity.id,
        protocols: {},
        handlers: {},
        recovery: { timeoutMs: 100, deadlineMs: 500, getDelayMs: () => 100 },
        readEvidence: () => fixture.device.groups.readEvidence(current),
        validation: api.createControlValidationPort({
          identity: fixture.identity,
          options: fixture.environment.options,
          restoreCandidate: async () => {
            throw new Error('No ordinary candidate expected')
          },
        }),
        prepareBuild: async () => {
          throw new Error('No ordinary build expected')
        },
        adopt: async () => {
          throw new Error('No ordinary adoption expected')
        },
        deliverWelcome: async () => {},
      })
    },
  })
  return {
    owner,
    created,
    close: async () => {
      owner.dispose()
      await owner.drained()
    },
  }
}

for (const context of ['supplied', 'absent'] as const) {
  test(`unresolved durable target pauses without fallback / real-mls / ${context}`, async () => {
    let fixture = await createRegistryFixture({
      mode: 'real-mls',
      groupID: key.groupID,
      setup: 'seeded',
      ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
    })
    const original = new FakeHub()
    const unavailable = vi.fn(async (_id: string): Promise<api.RecoveryTarget> => {
      throw new Error('Host offline')
    })
    let active: Awaited<ReturnType<typeof start>> | undefined
    try {
      const candidate = await fixture.confirmedRecovery(key, { confirm: false })
      if (!('format' in candidate.record)) throw new Error('Captured candidate required')
      active = await start(fixture, unavailable)
      await active.owner.ready
      const safety = api.createGroupSafety(await registryFixtureSafetyParams(fixture))
      const running = safety.recover(key, {
        mode: 'resync',
        target: { ...binding, hub: original },
        allowOpenFork: true,
      })
      void running.catch(() => {})
      await vi.waitFor(() => expect(active?.created).toHaveLength(2))
      const status = (await safety.status(key)).manualRecovery
      if (status === null) throw new Error('Missing durable target')
      await active.close()
      await fixture
        .manualRecovery()
        .manualRecoveryControl(status.id)
        .apply(
          {
            putRejoin: { ...candidate.record, trigger: 'manual', authorisationID: status.id },
          },
          'save-confirmed-move',
        )
      const saved = await fixture.manualRecovery().readManualRecovery(status.id)
      if (saved?.choice.mode !== 'resync') throw new Error('Missing resync authority')
      fixture = await fixture.reopen()
      active = await start(fixture, unavailable)
      await active.owner.ready
      expect(active.created).toEqual([])
      expect(active.owner.status()).toMatchObject({
        kind: 'pending',
        reason: 'target-unresolved',
        authorisationID: status.id,
      })
      expect(await fixture.manualRecovery().readManualRecovery(status.id)).toEqual({
        ...saved,
        pauseReason: 'target-unresolved',
        mutationID: expect.any(String),
      })
      expect(active.owner.installedKey()).toEqual(key)
      await active.close()
      const restored = new FakeHub()
      const resolver = vi.fn(async (id: string) => ({
        id,
        hub: restored as LogHub & MailboxHub,
        commitTopicID: binding.commitTopicID,
      }))
      active = await start(fixture, resolver)
      await active.owner.ready
      expect(active.created).toHaveLength(1)
      expect(active.created[0]).toMatchObject({
        hub: restored,
        target: { targetID: binding.targetID, topicID: binding.commitTopicID },
      })
      expect((await fixture.manualRecovery().readManualRecovery(status.id))?.choice).toEqual(
        saved.choice,
      )
      expect(resolver.mock.calls.every(([id]) => id === binding.targetID)).toBe(true)
      expect(active.owner.installedKey()).toEqual({ ...key, incarnation: 2 })
      expect((await fixture.manualRecovery().readManualRecovery(status.id))?.attempt).toMatchObject(
        {
          id: saved.attempt?.id,
          requestKey: saved.attempt?.requestKey,
          payload: saved.attempt?.payload,
          authorisationID: saved.id,
          source: saved.attempt?.source,
        },
      )
      expect((await fixture.manualRecovery().readManualRecovery(status.id))?.stage).toBe(
        'completed',
      )
    } finally {
      await active?.close()
      await fixture.close()
    }
  })
}
