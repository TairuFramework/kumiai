import {
  type CheckpointRecord,
  createGroupPeer,
  decodeHandshakeFrame,
  encodeHandshakeFrame,
  encodeRecoveryRequest,
  type GroupKey,
  HANDSHAKE_KIND,
  type LogHub,
  type LogPosition,
  type MailboxHub,
  rendezvousTopic,
  type SuccessorTombstone,
} from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import { entryCapability } from '../src/entry-capability.js'
import * as api from '../src/index.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import {
  createNotMemberFixture,
  createRegistryFixture,
  type RegistryFixture,
  registryFixtureMutateControl,
  registryFixtureSafetyParams,
} from './fixtures/registry.js'

const { FakeHub } = (await import(
  new URL('../../rpc/test/fixtures/fake-hub.ts', import.meta.url).href
)) as {
  FakeHub: new () => LogHub &
    MailboxHub & { published: Array<{ senderDID: string; topicID: string; payload: Uint8Array }> }
}
type FakeHub = InstanceType<typeof FakeHub>

const key = { groupID: 'successor-source', incarnation: 1 }
const freshUse = (ref: string) => ({ sourceID: 'source', ref, kind: 'ordinary' as const })

async function records(
  fixture: RegistryFixture,
  groupID: string,
): Promise<Array<CheckpointRecord>> {
  const capability = entryCapability(fixture.device.groups)
  if (capability === null) throw new Error('Missing entry capability')
  return capability.read(groupID, (reads) => reads.checkpoints())
}
async function tombstones(fixture: RegistryFixture, groupID: string) {
  return (await records(fixture, groupID)).flatMap((row) =>
    row.kind === 'successor' ? [row.value] : [],
  )
}
async function admit(fixture: RegistryFixture, groupID: string): Promise<GroupKey> {
  return fixture.registry.seed(await fixture.makeHandle(0, groupID), { packageUse: null })
}

// Shape checks read transport methods; only calling one is a network action.
function watchedHub() {
  const calls = vi.fn()
  return {
    calls,
    hub: new Proxy({} as LogHub & MailboxHub, {
      get(_target, property) {
        if (['subscribe', 'receive', 'publish', 'fetchTopic'].includes(property as string))
          return () => {
            calls(property)
            throw new Error('Unexpected network action')
          }
        calls(property)
        throw new Error('Unexpected network action')
      },
    }),
  }
}

async function stubPeer(
  fixture: RegistryFixture,
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
  await owner.ready.catch(() => {})
  return { owner, created }
}

for (const mode of ['real-mls', 'double'] as const) {
  for (const context of ['supplied', 'absent'] as const) {
    test(`successor tombstone records its exact retirement / ${mode} / ${context}`, async () => {
      const fixture = await createRegistryFixture({
        mode,
        groupID: key.groupID,
        setup: 'seeded',
        ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
      })
      try {
        const successorKey = await admit(fixture, 'admitted-successor')
        const successorStateBefore = await fixture.device.groups.loadState(successorKey)
        const before = Date.now()
        expect(
          await fixture.safety().recover(key, { mode: 'successor', successor: successorKey }),
        ).toEqual(successorKey)
        const [sourceTombstone, ...others] = await tombstones(fixture, key.groupID)
        expect(others).toEqual([])
        if (sourceTombstone === undefined) throw new Error('Missing successor tombstone')
        const status = await fixture.safety().status(key)
        expect(sourceTombstone).toEqual({
          kind: 'successor-tombstone',
          id: sourceTombstone.id,
          source: key,
          successor: successorKey,
          authorisationID: status.manualRecovery?.id ?? 'missing',
          retiredAt: sourceTombstone.retiredAt,
          clearedAt: null,
        } satisfies SuccessorTombstone)
        expect(sourceTombstone.successor).toEqual(successorKey)
        expect(sourceTombstone.retiredAt).toBeGreaterThanOrEqual(before)
        expect(
          await fixture.manualRecovery().readManualRecovery(sourceTombstone.authorisationID),
        ).toMatchObject({
          stage: 'completed',
          destination: successorKey,
          choice: { mode: 'successor', successor: successorKey },
        })
        const successorStateAfterRetirement = await fixture.device.groups.loadState(successorKey)
        expect(successorStateAfterRetirement).toEqual(successorStateBefore)
        expect(await tombstones(fixture, successorKey.groupID)).toEqual([])
        await fixture.safety().clearTombstone(key.groupID)
        const [cleared] = await tombstones(fixture, key.groupID)
        expect(cleared).toEqual({ ...sourceTombstone, clearedAt: expect.any(Number) })
        expect(cleared?.clearedAt).toBeGreaterThanOrEqual(sourceTombstone.retiredAt)
        await expect(fixture.safety().clearTombstone('')).rejects.toBeInstanceOf(TypeError)
      } finally {
        await fixture.close()
      }
    })

    test(`successor removed while the source drains refuses retirement / ${mode} / ${context}`, async () => {
      const fixture = await createRegistryFixture({
        mode,
        groupID: key.groupID,
        setup: 'seeded',
        ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
      })
      try {
        const successorKey = await admit(fixture, 'admitted-successor')
        const access = await fixture.registry.access(key.groupID)
        let removed = false
        access.onRetire(async () => {
          if (removed) return
          removed = true
          await fixture.registry.delete(successorKey)
        })
        await expect(
          fixture.safety().recover(key, { mode: 'successor', successor: successorKey }),
        ).rejects.toBeInstanceOf(api.ManualRecoveryUnavailableError)
        expect(removed).toBe(true)
        expect(await fixture.device.groups.load(key.groupID)).toMatchObject({
          activeIncarnation: key.incarnation,
        })
        expect(await tombstones(fixture, key.groupID)).toEqual([])
        expect((await fixture.registry.access(key.groupID)).admission().admissible).toBe(true)
      } finally {
        await fixture.close()
      }
    })

    test(`failed successor retirement keeps source and halt; restart resumes only that choice / ${mode} / ${context}`, async () => {
      let fixture = await createRegistryFixture({
        mode,
        groupID: key.groupID,
        setup: 'seeded',
        ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
      })
      try {
        const successorKey = await admit(fixture, 'admitted-successor')
        const otherKey = await admit(fixture, 'other-successor')
        // The raw mutator rewrites an existing sealed control row only.
        await fixture.installRows({ key, control: {} })
        await registryFixtureMutateControl(fixture, key, (snapshot) => ({
          ...snapshot,
          forkHalt: {
            eventID: 'legacy-halt',
            detectedAt: 1,
            evidence: { kind: 'unexplained-own-commit', epoch: 0, position: 'p', digest: 'd' },
          },
        }))
        const access = await fixture.registry.access(key.groupID)
        let armed = false
        access.onRetire(async () => {
          if (armed) return
          armed = true
          fixture.armNextWorkFault('before-commit')
        })
        const lifetime = await fixture.device.groups.load(key.groupID)
        const control = await fixture.device.groups.ports(key).control.load()
        const state = await fixture.device.groups.loadState(key)
        await expect(
          fixture.safety().recover(key, { mode: 'successor', successor: successorKey }),
        ).rejects.toThrow()
        expect(armed).toBe(true)
        // Authorisation advances the revision; the source stays the active incarnation.
        expect(await fixture.device.groups.load(key.groupID)).toMatchObject({
          activeIncarnation: lifetime?.activeIncarnation,
          latestIncarnation: lifetime?.latestIncarnation,
        })
        expect(await fixture.device.groups.ports(key).control.load()).toEqual(control)
        expect(await fixture.device.groups.loadState(key)).toEqual(state)
        expect(await tombstones(fixture, key.groupID)).toEqual([])
        expect((await fixture.safety().status(key)).manualRecovery).toMatchObject({
          kind: 'pending',
        })
        fixture = await fixture.reopen()
        await expect(
          fixture.safety().recover(key, { mode: 'successor', successor: otherKey }),
        ).rejects.toThrow()
        expect(
          await fixture.safety().recover(key, { mode: 'successor', successor: successorKey }),
        ).toEqual(successorKey)
        expect(await tombstones(fixture, key.groupID)).toMatchObject([
          { successor: successorKey, clearedAt: null },
        ])
        expect((await fixture.device.groups.ports(key).control.load()).forkHalt).toEqual(
          control.forkHalt,
        )
      } finally {
        await fixture.close()
      }
    })
  }
}

test('pending successor choice supersedes resync and leaves the source peer to the app', async () => {
  let fixture = await createRegistryFixture({
    mode: 'real-mls',
    groupID: key.groupID,
    setup: 'seeded',
  })
  let active: Awaited<ReturnType<typeof stubPeer>> | undefined
  try {
    const successorKey = await admit(fixture, 'admitted-successor')
    await fixture.manualRecovery().authoriseManualRecovery(key, {
      mode: 'resync',
      targetID: 'superseded-hub',
      commitTopicID: 'superseded-commits',
      allowOpenFork: false,
    })
    await fixture.manualRecovery().authoriseManualRecovery(key, {
      mode: 'successor',
      successor: successorKey,
    })
    fixture = await fixture.reopen()
    const resolver = vi.fn(async (): Promise<api.RecoveryTarget> => {
      throw new Error('A successor choice resolves no transport')
    })
    active = await stubPeer(fixture, resolver)
    expect(active.owner.status().kind).not.toBe('failed')
    expect(active.created).toHaveLength(1)
    expect(active.created[0]?.manualRecovery).toBeUndefined()
    expect(resolver).not.toHaveBeenCalled()
    expect(
      await fixture.safety().recover(key, { mode: 'successor', successor: successorKey }),
    ).toEqual(successorKey)
    // Draining the source retires its live peer before the tombstone commits.
    await vi.waitFor(() => expect(active?.owner.peer()).toBeNull())
  } finally {
    active?.owner.dispose()
    await active?.owner.drained().catch(() => {})
    await fixture.close()
  }
})

test('move restart and successor are app controlled', async () => {
  let fixture = await createRegistryFixture({
    mode: 'real-mls',
    groupID: key.groupID,
    setup: 'seeded',
  })
  const destination = watchedHub()
  const moved = { targetID: 'destination-hub', commitTopicID: `moved/${key.groupID}` }
  let active: Awaited<ReturnType<typeof stubPeer>> | undefined
  try {
    const state = await fixture.device.groups.loadState(key)
    if (state === null || state.deleted) throw new Error('Missing seeded state')
    await fixture.installRows({ key, control: {} })
    await registryFixtureMutateControl(fixture, key, (snapshot) => ({
      ...snapshot,
      cursor: { position: '0000000042' as LogPosition, epoch: state.epoch },
    }))
    active = await stubPeer(fixture, async () => {
      throw new Error('Live binding must be used')
    })
    const safety = api.createGroupSafety(await registryFixtureSafetyParams(fixture))
    expect(
      await safety.recover(key, {
        mode: 'resync',
        target: { ...moved, hub: destination.hub },
      }),
    ).toEqual(key)
    active.owner.dispose()
    await active.owner.drained()
    active = undefined
    fixture = await fixture.reopen()
    // Restart resumes the moved routing only; it never retires or tombstones anything.
    active = await stubPeer(fixture, async (id) => ({
      id,
      hub: destination.hub,
      commitTopicID: moved.commitTopicID,
    }))
    expect(active.created[0]?.hub === destination.hub).toBe(true)
    expect(await tombstones(fixture, key.groupID)).toEqual([])
    expect(await fixture.device.groups.load(key.groupID)).toMatchObject({
      activeIncarnation: key.incarnation,
    })
    const successorKey = await admit(fixture, 'admitted-successor')
    expect(await tombstones(fixture, key.groupID)).toEqual([])
    expect(await fixture.device.groups.load(key.groupID)).toMatchObject({
      activeIncarnation: key.incarnation,
    })
    expect(
      await fixture.safety().recover(key, { mode: 'successor', successor: successorKey }),
    ).toEqual(successorKey)
    active.owner.dispose()
    await active.owner.drained().catch(() => {})
    active = undefined
    fixture = await fixture.reopen()
    const [sourceTombstone] = await tombstones(fixture, key.groupID)
    expect(sourceTombstone).toMatchObject({ successor: successorKey, clearedAt: null })
    await expect(
      fixture.registry.seed(await fixture.makeHandle(2, key.groupID), {
        replace: true,
        packageUse: freshUse('after-restart'),
      }),
    ).rejects.toBeInstanceOf(api.SeedAdmissionRefusedError)
    expect((await tombstones(fixture, key.groupID))[0]?.clearedAt).toBeNull()
    await fixture.safety().clearTombstone(key.groupID)
    expect((await tombstones(fixture, key.groupID))[0]?.clearedAt).toEqual(expect.any(Number))
    expect(destination.calls).not.toHaveBeenCalled()
  } finally {
    active?.owner.dispose()
    await active?.owner.drained().catch(() => {})
    await fixture.close()
  }
})

async function heldPeer(
  fixture: RegistryFixture,
  sourceKey: GroupKey,
  hub: FakeHub,
  target: { targetID: string; topicID: string },
) {
  return api.createRegistryPeer({
    registry: fixture.registry,
    key: sourceKey,
    recovery: fixture.environment,
    target,
    resolveTarget: async (id) => ({ id, hub, commitTopicID: target.topicID }),
    continuation: api.createRecoveryContinuationPort({
      registry: fixture.registry,
      persistence: fixture.device.groups,
    }),
    createMLS: (current, _handoff, options) =>
      api.createRegistryGroupMLS({
        registry: fixture.registry,
        key: current,
        manualRecovery: options.manualRecovery,
        recovery: fixture.environment,
        target: options.target,
        identity: fixture.identity,
        entrySlot: api.createLedgerEntrySlot(),
      }),
    createPeer: async (current, options) => {
      const access = await fixture.registry.access(current.groupID)
      const crypto = api.createGroupCrypto({
        access: {
          ...api.createRegistryHandleAccess({ access }),
          open: async () => {
            throw new Error('No application opens expected')
          },
        },
      })
      const ports = fixture.device.groups.ports(current)
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
        recovery: { timeoutMs: 1000, deadlineMs: 8000, getDelayMs: () => 0 },
        readEvidence: () => fixture.device.groups.readEvidence(current),
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
}

test('all devices legacy halted exit through successor', async () => {
  const fixture = await createNotMemberFixture()
  const hub = new FakeHub()
  const target = { targetID: 'selected', topicID: 'held-commits' }
  const devices = [
    { device: fixture.local(), key: fixture.key, requester: fixture.remoteMLS },
    { device: fixture.remote, key: fixture.remoteKey, requester: fixture.mls() },
  ]
  const owners: Array<api.RegistryPeer> = []
  const kinds = (senderDID: string, kind: number) =>
    hub.published.filter((message) => {
      if (message.senderDID !== senderDID) return false
      try {
        return decodeHandshakeFrame(message.payload).kind === kind
      } catch {
        return false
      }
    }).length
  try {
    for (const { device, key: sourceKey } of devices) {
      // Legacy halts carry no producer: only manual rejoin or successor retirement exits them.
      await registryFixtureMutateControl(device, sourceKey, (snapshot) => ({
        ...snapshot,
        forkHalt: {
          eventID: `legacy-${device.identity.id}`,
          detectedAt: 1,
          evidence: { kind: 'unexplained-own-commit', epoch: 0, position: 'p', digest: 'd' },
        },
      }))
      await device.manualRecovery().authoriseManualRecovery(sourceKey, {
        mode: 'resync',
        targetID: target.targetID,
        commitTopicID: target.topicID,
        allowOpenFork: false,
      })
      const owner = await heldPeer(device, sourceKey, hub, target)
      owners.push(owner)
      await owner.ready
    }
    for (const [index, { device, requester }] of devices.entries()) {
      const other = devices[1 - index]
      if (other === undefined) throw new Error('Missing peer device')
      await vi.waitFor(() =>
        expect(kinds(device.identity.id, HANDSHAKE_KIND.recoveryRequest)).toBeGreaterThan(0),
      )
      const requestID = crypto.randomUUID()
      const request = await requester.createRecoveryRequest(requestID)
      await hub.publish({
        senderDID: other.device.identity.id,
        topicID: rendezvousTopic(await requester.exportRecoverySecret()),
        payload: encodeHandshakeFrame(
          HANDSHAKE_KIND.recoveryRequest,
          encodeRecoveryRequest(requestID, request.request),
        ),
      })
    }
    for (const { device } of devices) {
      const count = kinds(device.identity.id, HANDSHAKE_KIND.recoveryRequest)
      await vi.waitFor(
        () =>
          expect(kinds(device.identity.id, HANDSHAKE_KIND.recoveryRequest)).toBeGreaterThan(count),
        { timeout: 5000 },
      )
    }
    for (const { device, key: sourceKey } of devices) {
      expect(kinds(device.identity.id, HANDSHAKE_KIND.recoveryReply)).toBe(0)
      expect((await device.safety().status(sourceKey)).manualRecovery).toMatchObject({
        kind: 'pending',
      })
    }
    for (const [index, owner] of owners.entries())
      expect(owner.status(), `device ${index} resync stays pending`).toMatchObject({
        kind: 'pending',
      })
    for (const { device, key: sourceKey } of devices) {
      const successorKey = await admit(device, `successor-${sourceKey.groupID}`)
      const successorBefore = await device.device.groups.loadState(successorKey)
      expect(
        await device.safety().recover(sourceKey, { mode: 'successor', successor: successorKey }),
      ).toEqual(successorKey)
      expect(await device.device.groups.loadState(successorKey)).toEqual(successorBefore)
      expect(await tombstones(device, sourceKey.groupID)).toMatchObject([
        { source: sourceKey, successor: successorKey, clearedAt: null },
      ])
      expect((await device.device.groups.ports(sourceKey).control.load()).forkHalt).not.toBeNull()
    }
    const published = hub.published.length
    await new Promise((resolve) => setTimeout(resolve, 200))
    // Retired sources publish nothing more, and no held device ever answered.
    expect(
      hub.published
        .slice(published)
        .filter((message) =>
          devices.some(({ device }) => device.identity.id === message.senderDID),
        ),
    ).toEqual([])
    for (const { device } of devices)
      expect(kinds(device.identity.id, HANDSHAKE_KIND.recoveryReply)).toBe(0)
  } finally {
    for (const owner of owners) owner.dispose()
    for (const owner of owners) await owner.drained().catch(() => {})
    await fixture.close()
  }
}, 60000)
