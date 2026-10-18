import { encodeEventFrame } from '@kumiai/broadcast'
import {
  APP_TOPIC_LABEL,
  type CheckpointRecord,
  type ControlSnapshot,
  canMoveCurrent,
  createGroupPeer,
  encodeAppAAD,
  type GroupKey,
  type LogHub,
  type LogPosition,
  type MailboxHub,
  protocolTopic,
} from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import { entryCapability } from '../src/entry-capability.js'
import * as api from '../src/index.js'
import { encodeStoredValue } from '../src/persistence-codec.js'
import { registrySafety } from '../src/registry/safety.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import {
  createNotMemberFixture,
  createRegistryFixture,
  registryFixtureMutateControl,
  registryFixtureSafetyParams,
} from './fixtures/registry.js'
import { createRegistryCryptoGroup } from './fixtures/registry-crypto.js'

const key = { groupID: 'hub-migration', incarnation: 1 }
const binding = { targetID: 'registry-recovery-hub', commitTopicID: `commits/${key.groupID}` }

const hubMethods = ['subscribe', 'receive', 'publish', 'fetchTopic'] as const

function watchedHub() {
  const calls = vi.fn()
  const methods = new Map<PropertyKey, () => never>(
    hubMethods.map((name) => [
      name,
      () => {
        calls(name)
        throw new Error('Unexpected network action')
      },
    ]),
  )
  return {
    calls,
    hub: new Proxy({} as LogHub & MailboxHub, {
      get(_target, property) {
        // Shape checks may read a transport method; only calling it is network use.
        const method = methods.get(property)
        if (method !== undefined) return method
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
  test(`moved current device receives app frames from a fresh hub over registry crypto / ${mode}`, async () => {
    const group = await createRegistryCryptoGroup(mode, 'moved-current-app', 2)
    const fixture = group.fixture()
    const key = group.key
    const { DurableFakeHub } = (await import(
      new URL('../../rpc/test/fixtures/durable-fake-hub.ts', import.meta.url).href
    )) as { DurableFakeHub: new () => LogHub }
    const original = new DurableFakeHub()
    const destination = new DurableFakeHub()
    const seen: Array<unknown> = []
    const created: Array<api.RegistryPeerOptions> = []
    const cryptos: Array<ReturnType<typeof group.receiver>> = []
    const chat = {
      'chat/posted': { type: 'event', retain: 'log', data: { type: 'object' } },
    } as const
    const topicID = protocolTopic(
      await group.sender.handle.exportSecret(APP_TOPIC_LABEL, new Uint8Array(), 32),
      group.access().epoch(),
      'chat',
    )
    let owner: api.RegistryPeer | undefined
    try {
      owner = await api.createRegistryPeer({
        registry: fixture.registry,
        key,
        recovery: fixture.environment,
        target: { targetID: 'original-hub', topicID: 'original-commits' },
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
          const crypto = api.createGroupCrypto({
            access: await fixture.registry.access(current.groupID),
          })
          cryptos.push(crypto)
          const ports = fixture.device.groups.ports(current)
          return createGroupPeer({
            ...options,
            hub: options.hub ?? original,
            crypto,
            control: ports.control,
            anchorStore: ports.anchor,
            appCursorStore: ports.cursor,
            appOutbox: ports.outbox,
            appOutboxLimit: 16,
            localDID: fixture.identity.id,
            protocols: { chat },
            handlers: {
              chat: {
                'chat/posted': ({ data, message, frame }) => {
                  expect(message.payload).toMatchObject({ iss: group.sender.identity.id })
                  expect(frame?.topicID).toBe(topicID)
                  seen.push(data)
                },
              },
            },
            validation: {
              restoreValidation: async () => {
                throw new Error('Unexpected control validation')
              },
            },
            readEvidence: () => fixture.device.groups.readEvidence(current),
            prepareBuild: async () => {
              throw new Error('Unexpected control build')
            },
            adopt: async () => {
              throw new Error('Unexpected adoption')
            },
            deliverWelcome: async () => {},
          })
        },
      })
      await owner.ready
      const publish = async (hub: LogHub, text: string) =>
        hub.publish({
          topicID,
          senderDID: group.sender.identity.id,
          payload: await group.sender.handle.encrypt(encodeEventFrame('chat/posted', { text }), {
            aad: encodeAppAAD({ topicID, intent: 'log' }),
          }),
          retain: 'log',
        })
      const first = await publish(original, 'before move')
      const ports = fixture.device.groups.ports(key)
      await vi.waitFor(async () => expect(await ports.cursor.load(topicID)).toBe(first.sequenceID))
      expect(seen).toEqual([{ text: 'before move' }])
      const safety = api.createGroupSafety(await registryFixtureSafetyParams(fixture))
      const epoch = group.access().epoch()
      expect(
        await safety.recover(key, {
          mode: 'resync',
          target: { ...movedBinding, hub: destination },
        }),
      ).toEqual(key)
      expect(created).toHaveLength(2)
      expect(created[1]?.hub).toBe(destination)
      expect(await ports.cursor.load(topicID)).toBeNull()
      expect(group.access().epoch()).toBe(epoch)
      const second = await publish(destination, 'after move')
      expect(second.sequenceID).toBe(first.sequenceID)
      await vi.waitFor(() =>
        expect(seen).toEqual([{ text: 'before move' }, { text: 'after move' }]),
      )
      await vi.waitFor(async () => expect(await ports.cursor.load(topicID)).toBe(second.sequenceID))
      expect(await cryptos[1]?.pending.list()).toEqual([])
      owner.dispose()
      await owner.drained()
      expect(seen).toHaveLength(2)
    } finally {
      owner?.dispose()
      await owner?.drained()
      await group.close()
    }
  })

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
        // A known-behind device keeps the attempt pending instead of moving current.
        await mutateControl(fixture, (snapshot) => ({
          ...snapshot,
          strand: { reason: 'retention-gap' },
        }))
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

    for (const mismatch of ['id', 'topic', 'hub undefined', 'hub without fetchTopic'] as const) {
      const title =
        mismatch === 'id'
          ? 'resolver cannot substitute saved target or topic'
          : mismatch === 'topic'
            ? 'restored host handle resumes identical move'
            : 'resolver hub without transport pauses saved choice'
      test(`${title} / ${mismatch} / ${mode} / ${context}`, async () => {
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
            // A JS host can return any hub; only a complete transport may reach a peer factory.
            hub: (restored || !mismatch.startsWith('hub')
              ? alternate.hub
              : mismatch === 'hub undefined'
                ? undefined
                : partialHub('fetchTopic')) as LogHub & MailboxHub,
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

function partialHub(omit: (typeof hubMethods)[number]): unknown {
  return Object.fromEntries(
    hubMethods.filter((name) => name !== omit).map((name) => [name, () => {}]),
  )
}

// TypeScript cannot express these targets; a JS caller can.
const invalidTargets: Array<[string, Record<string, unknown>]> = [
  ['hub undefined', { ...binding, hub: undefined }],
  ['hub missing', { ...binding }],
  ['hub null', { ...binding, hub: null }],
  ['hub string', { ...binding, hub: 'registry-recovery-hub' }],
  ['hub function', { ...binding, hub: () => {} }],
  ['hub empty object', { ...binding, hub: {} }],
  ...hubMethods.map((name): [string, Record<string, unknown>] => [
    `hub without ${name}`,
    { ...binding, hub: partialHub(name) },
  ]),
  ['empty targetID', { ...binding, targetID: '', hub: watchedHub().hub }],
  ['non-string targetID', { ...binding, targetID: 7, hub: watchedHub().hub }],
  ['empty commitTopicID', { ...binding, commitTopicID: '', hub: watchedHub().hub }],
  ['non-string commitTopicID', { ...binding, commitTopicID: null, hub: watchedHub().hub }],
]

for (const mode of ['real-mls', 'double'] as const) {
  for (const context of ['supplied', 'absent'] as const) {
    test(`invalid call time target is refused before authority / ${mode} / ${context}`, async () => {
      const fixture = await createRegistryFixture({
        mode,
        groupID: key.groupID,
        setup: 'seeded',
        ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
      })
      const resolver = vi.fn(async (): Promise<api.RecoveryTarget> => {
        throw new Error('Resolver must not run for a call time target')
      })
      const active = await start(fixture, resolver)
      try {
        const safety = api.createGroupSafety({
          ...(await registryFixtureSafetyParams(fixture)),
          resolveTarget: resolver,
        })
        const before = await fixture.device.groups.ports(key).control.load()
        for (const [label, target] of invalidTargets) {
          const choice = {
            mode: 'resync',
            target,
            allowOpenFork: true,
          } as unknown as api.ManualRecovery
          await expect(safety.recover(key, choice), label).rejects.toThrow(
            new TypeError('Invalid manual recovery choice'),
          )
          expect((await safety.status(key)).manualRecovery, label).toBeNull()
        }
        expect(resolver).not.toHaveBeenCalled()
        expect(active.created).toHaveLength(1)
        expect(await fixture.device.groups.ports(key).control.load()).toEqual(before)
      } finally {
        active.owner.dispose()
        await active.owner.drained()
        await fixture.close()
      }
    })
  }
}

type Fixture = Awaited<ReturnType<typeof createRegistryFixture>>
const movedBinding = { targetID: 'destination-hub', commitTopicID: `moved/${key.groupID}` }
const freshControl: ControlSnapshot = {
  commitOnce: null,
  commitOnceAcceptance: null,
  controlHold: null,
  forkHalt: null,
  recoveryUnavailable: null,
  strand: null,
  operations: [],
  forkRecoveryAttempt: null,
  rejoin: null,
  recoveryEpochFloor: null,
  settledRejoins: [],
  outcomes: [],
  welcomes: [],
  applied: [],
  responses: [],
  cursor: null,
}
const readyInputs: Parameters<typeof canMoveCurrent>[0] = {
  control: freshControl,
  activity: { pending: 0 },
  stateReadable: true,
  stateEpoch: 3,
  ledgerComplete: true,
  walkComplete: true,
  outboxUnresolved: false,
  settlementUnresolved: false,
  hardHold: null,
  condition: null,
  openForkNotice: false,
  activeRejoin: false,
  allowOpenFork: false,
}
const blockedInputs: Array<[string, Partial<Parameters<typeof canMoveCurrent>[0]>]> = [
  ['pending owner work', { activity: { pending: 1 } }],
  ['unreadable state', { stateReadable: false }],
  ['incomplete ledger', { ledgerComplete: false }],
  ['incomplete walk', { walkComplete: false }],
  ['epoch floor above state', { control: { ...freshControl, recoveryEpochFloor: 4 } }],
  [
    'epoch floor with unknown state epoch',
    { stateEpoch: null, control: { ...freshControl, recoveryEpochFloor: 0 } },
  ],
  ['unresolved outbox', { outboxUnresolved: true }],
  ['unresolved settlement', { settlementUnresolved: true }],
  ['fork hold', { hardHold: 'fork-halted' }],
  ['spent hold', { hardHold: 'spent-set-corrupt' }],
  ['unavailable hold', { hardHold: 'recovery-unavailable' }],
  ['not-member', { condition: 'not-member' }],
  ['spent condition', { condition: 'spent-set-corrupt' }],
  ['active rejoin', { activeRejoin: true }],
  [
    'commit slot',
    { control: { ...freshControl, commitOnce: {} as ControlSnapshot['commitOnce'] } },
  ],
  [
    'unsettled acceptance',
    {
      control: {
        ...freshControl,
        commitOnceAcceptance: {} as ControlSnapshot['commitOnceAcceptance'],
      },
    },
  ],
  [
    'acceptance unknown',
    { control: { ...freshControl, controlHold: { reason: 'acceptance-unknown', position: null } } },
  ],
  [
    'unsupported version',
    {
      control: { ...freshControl, controlHold: { reason: 'unsupported-version', position: null } },
    },
  ],
  [
    'saved halt',
    { control: { ...freshControl, forkHalt: {} as NonNullable<ControlSnapshot['forkHalt']> } },
  ],
  [
    'saved unavailable',
    {
      control: {
        ...freshControl,
        recoveryUnavailable: {} as NonNullable<ControlSnapshot['recoveryUnavailable']>,
      },
    },
  ],
  ['strand', { control: { ...freshControl, strand: { reason: 'retention-gap' } } }],
  [
    'operation',
    { control: { ...freshControl, operations: [{} as ControlSnapshot['operations'][0]] } },
  ],
  [
    'fork intent',
    {
      control: {
        ...freshControl,
        forkRecoveryAttempt: {} as NonNullable<ControlSnapshot['forkRecoveryAttempt']>,
      },
    },
  ],
  ['ordinary X', { control: { ...freshControl, rejoin: {} as ControlSnapshot['rejoin'] } }],
  ['welcome', { control: { ...freshControl, welcomes: [{} as ControlSnapshot['welcomes'][0]] } }],
  [
    'stranded cursor',
    {
      control: {
        ...freshControl,
        cursor: { position: 'p' as LogPosition, epoch: 0, stranded: true },
      },
    },
  ],
  [
    'incomplete cursor',
    {
      control: {
        ...freshControl,
        cursor: { position: 'p' as LogPosition, epoch: 0, incomplete: true },
      },
    },
  ],
]

test('current move predicate requires every freshness and safety input', () => {
  expect(canMoveCurrent(readyInputs)).toBe(true)
  expect(
    canMoveCurrent({ ...readyInputs, control: { ...freshControl, recoveryEpochFloor: 3 } }),
  ).toBe(true)
  expect(canMoveCurrent({ ...readyInputs, openForkNotice: true })).toBe(false)
  for (const [label, change] of blockedInputs)
    expect(canMoveCurrent({ ...readyInputs, ...change }), label).toBe(false)
})

test('allow open fork overrides only notice exclusion / predicate', () => {
  const override = { ...readyInputs, openForkNotice: true, allowOpenFork: true }
  expect(canMoveCurrent(override)).toBe(true)
  for (const [label, change] of blockedInputs)
    expect(canMoveCurrent({ ...override, ...change }), label).toBe(false)
})

async function putOpenNotice(fixture: Fixture, owner: GroupKey = key): Promise<void> {
  const entry = entryCapability(fixture.device.groups)
  if (entry === null) throw new Error('Missing entry capability')
  const row: CheckpointRecord = {
    kind: 'notice',
    id: 'open-notice',
    key: owner,
    notice: {
      id: 'open-notice',
      groupID: owner.groupID,
      splitEpoch: 0,
      branches: [],
      deviceAuthHash: 'local',
      detectedAt: 1,
      lastEvidenceAt: 1,
      atRisk: [],
      revision: 1,
      acknowledgedRevision: 0,
      acknowledgedAt: null,
      coverage: {
        evidence: { kind: 'complete' },
        ownMessages: { kind: 'complete' },
        ephemeral: { kind: 'complete' },
      },
      closedAt: null,
      equivocations: [],
    },
  }
  await entry.run(
    { groupID: owner.groupID, mutationID: crypto.randomUUID() },
    async (reads) => ({ expected: await reads.lifetime(), value: null }),
    async (stores) => {
      await stores.checkpoints.put(row)
    },
  )
}

async function mutateControl(
  fixture: Fixture,
  change: (snapshot: ControlSnapshot) => ControlSnapshot,
): Promise<void> {
  // The raw mutator rewrites an existing sealed control row only.
  await fixture.installRows({ key, control: {} })
  await registryFixtureMutateControl(fixture, key, change)
}

function forkHalt(producer?: 'app-report' | 'internal') {
  return (fixture: Fixture) =>
    mutateControl(fixture, (snapshot) => ({
      ...snapshot,
      forkHalt: {
        eventID: `halt-${producer ?? 'legacy'}`,
        detectedAt: 1,
        ...(producer === undefined ? {} : { producer }),
        evidence: { kind: 'unexplained-own-commit', epoch: 0, position: 'fork', digest: 'fork' },
      },
    }))
}

function mutate(change: (snapshot: ControlSnapshot) => Partial<ControlSnapshot>) {
  return (fixture: Fixture) =>
    mutateControl(fixture, (snapshot) => ({
      ...snapshot,
      ...change(snapshot),
    }))
}

const movementRefusals: Array<[string, (fixture: Fixture) => Promise<void>]> = [
  [
    'app-report halt',
    (fixture) =>
      fixture.safety().reportFork(key, {
        kind: 'digest-divergence',
        epoch: 0,
        position: 'fork',
        localDigest: 'ours',
        remoteDigest: 'theirs',
      }),
  ],
  ['internal halt', forkHalt('internal')],
  ['legacy halt', forkHalt()],
  [
    'internal latch',
    async (fixture) => {
      registrySafety(fixture.registry)?.latch(key, 'fork-halted')
    },
  ],
  [
    'spent-set-corrupt latch',
    async (fixture) => {
      registrySafety(fixture.registry)?.latch(key, 'spent-set-corrupt')
    },
  ],
  [
    'unsupported version hold',
    mutate(() => ({ controlHold: { reason: 'unsupported-version', position: null } })),
  ],
  [
    'recovery-unavailable',
    mutate(() => ({
      recoveryUnavailable: {
        ...key,
        id: JSON.stringify(['group:recovery-unavailable', key.groupID, key.incarnation]),
        kind: 'group:recovery-unavailable',
        reason: 'trust-unreadable',
      },
    })),
  ],
  ['open notice', (fixture) => putOpenNotice(fixture)],
  [
    'ordinary X',
    async (fixture) => {
      const candidate = await fixture.confirmedRecovery(key, { confirm: false })
      if (!('format' in candidate.record)) throw new Error('Captured candidate required')
      await fixture.installRows({ key, control: { putRejoin: candidate.record } })
    },
  ],
  [
    'pending fork recovery intent',
    mutate(() => ({
      forkRecoveryAttempt: {
        id: 'fork-intent',
        source: key,
        forkRecovery: {
          attemptID: 'fork-intent',
          noticeID: 'open-notice',
          splitEpoch: 0,
          otherAuthHash: 'other',
          responderKeyHash: 'responder',
          source: key,
          evidence: new Uint8Array([1]),
        },
      },
    })),
  ],
  ['retention strand', mutate(() => ({ strand: { reason: 'retention-gap' } }))],
  [
    'stranded cursor',
    mutate(() => ({ cursor: { position: '0001' as LogPosition, epoch: 0, stranded: true } })),
  ],
  [
    'acceptance unknown',
    mutate(() => ({ controlHold: { reason: 'acceptance-unknown', position: null } })),
  ],
  ['cursor epoch lag', mutate(() => ({ cursor: { position: '0001' as LogPosition, epoch: 1 } }))],
  [
    'unresolved app settlement',
    (fixture) =>
      fixture.installRows({
        key,
        outbox: [
          {
            seq: 0,
            protocol: 'chat',
            prc: 'send',
            data: new Uint8Array([1]),
            lastAttempt: null,
            status: 'accepted',
          },
        ],
        settlements: [
          {
            seq: 0,
            value: {
              sequenceID: '0001',
              attemptID: 'published-attempt',
              topicID: 'app-topic',
              outcome: 'published',
            },
          },
        ],
      }),
  ],
  [
    'unresolved outbox',
    (fixture) =>
      fixture.installRows({
        key,
        outbox: [
          {
            seq: 0,
            protocol: 'chat',
            prc: 'send',
            data: new Uint8Array([1]),
            lastAttempt: {
              incarnation: key.incarnation,
              epoch: 0,
              floor: null,
              attempts: 1,
              publishID: 'unresolved-publish',
              segment: 0,
              topicID: 'app-topic',
            },
            status: 'accepted',
          },
        ],
      }),
  ],
]

async function movement(
  fixture: Fixture,
  choice: { allowOpenFork: boolean },
  hub: LogHub & MailboxHub = watchedHub().hub,
) {
  const saved = await fixture.manualRecovery().authoriseManualRecovery(key, {
    mode: 'resync',
    ...movedBinding,
    ...choice,
  })
  const resolver = vi.fn(async (id: string) => ({
    id,
    hub,
    commitTopicID: movedBinding.commitTopicID,
  }))
  const active = await start(fixture, resolver)
  await vi.waitFor(() =>
    expect(
      active.created.length > 0 ||
        active.owner.status().kind === 'failed' ||
        active.owner.status().kind === 'spent-set-corrupt',
    ).toBe(true),
  )
  return { saved, active, resolver }
}

function expectRejoinOnly(created: Array<api.RegistryPeerOptions>, id: string): void {
  expect(created.length).toBeGreaterThan(0)
  for (const options of created)
    expect(options).toMatchObject({
      recoveryOnly: true,
      manualRecovery: { authorisationID: id, source: key },
    })
}

for (const [label, apply] of movementRefusals) {
  test(`current move refuses every hold condition notice and active rejoin / ${label}`, async () => {
    const fixture = await createRegistryFixture({
      mode: 'double',
      groupID: key.groupID,
      setup: 'seeded',
    })
    let active: Awaited<ReturnType<typeof start>> | undefined
    try {
      await apply(fixture)
      const before = await fixture.device.groups.ports(key).control.load()
      const started = await movement(fixture, { allowOpenFork: false })
      active = started.active
      expect(active.owner.installedKey()).toEqual(key)
      expect((await fixture.manualRecovery().readManualRecovery(started.saved.id))?.stage).toBe(
        'authorised',
      )
      if (label === 'spent-set-corrupt latch') {
        expect(active.owner.status()).toMatchObject({
          kind: 'spent-set-corrupt',
          eventID: expect.any(String),
        })
        expect(active.created).toEqual([])
        expect(active.owner.peer()).toBeNull()
        expect(await fixture.manualRecovery().readManualRecovery(started.saved.id)).toEqual(
          started.saved,
        )
      } else expectRejoinOnly(active.created, started.saved.id)
      expect((await fixture.device.groups.ports(key).control.load()).cursor).toEqual(before.cursor)
    } finally {
      active?.owner.dispose()
      await active?.owner.drained().catch(() => {})
      await fixture.close()
    }
  })
}

test('current move refuses every hold condition notice and active rejoin / not-member', async () => {
  const diagnosed = await createNotMemberFixture()
  let active: Awaited<ReturnType<typeof start>> | undefined
  try {
    await diagnosed.diagnose(await diagnosed.proof())
    const local = diagnosed.local()
    expect((await local.safety().status(diagnosed.key)).condition).toBe('not-member')
    const saved = await local.manualRecovery().authoriseManualRecovery(diagnosed.key, {
      mode: 'resync',
      ...movedBinding,
      allowOpenFork: true,
    })
    const created: Array<api.RegistryPeerOptions> = []
    const owner = await api.createRegistryPeer({
      registry: local.registry,
      key: diagnosed.key,
      target: { targetID: 'original-hub', topicID: 'original-commits' },
      recovery: local.environment,
      resolveTarget: async (id) => ({
        id,
        hub: watchedHub().hub,
        commitTopicID: movedBinding.commitTopicID,
      }),
      continuation: api.createRecoveryContinuationPort({
        registry: local.registry,
        persistence: local.device.groups,
      }),
      createMLS: (current, _handoff, options) =>
        api.createRegistryGroupMLS({
          registry: local.registry,
          key: current,
          recovery: local.environment,
          identity: local.identity,
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
    active = { owner, created }
    await owner.ready
    await vi.waitFor(() => expect(created.length).toBeGreaterThan(0))
    expect(created[0]).toMatchObject({
      recoveryOnly: true,
      manualRecovery: { authorisationID: saved.id, source: diagnosed.key },
    })
    expect((await local.manualRecovery().readManualRecovery(saved.id))?.stage).toBe('authorised')
  } finally {
    active?.owner.dispose()
    await active?.owner.drained().catch(() => {})
    await diagnosed.close()
  }
})

for (const [label, apply] of [
  ['legacy halt', forkHalt()],
  ['internal latch', movementRefusals[3]?.[1]],
  ['ordinary X', movementRefusals[8]?.[1]],
  ['retention strand', movementRefusals[10]?.[1]],
] as Array<[string, (fixture: Fixture) => Promise<void>]>) {
  test(`allow open fork overrides only notice exclusion / ${label}`, async () => {
    const fixture = await createRegistryFixture({
      mode: 'double',
      groupID: key.groupID,
      setup: 'seeded',
    })
    let active: Awaited<ReturnType<typeof start>> | undefined
    try {
      await putOpenNotice(fixture)
      await apply(fixture)
      const started = await movement(fixture, { allowOpenFork: true })
      active = started.active
      expectRejoinOnly(active.created, started.saved.id)
      expect((await fixture.manualRecovery().readManualRecovery(started.saved.id))?.stage).toBe(
        'authorised',
      )
    } finally {
      active?.owner.dispose()
      await active?.owner.drained().catch(() => {})
      await fixture.close()
    }
  })
}

test('allow open fork overrides only notice exclusion / notice alone', async () => {
  const fixture = await createRegistryFixture({
    mode: 'double',
    groupID: key.groupID,
    setup: 'seeded',
  })
  let active: Awaited<ReturnType<typeof start>> | undefined
  try {
    await putOpenNotice(fixture)
    const started = await movement(fixture, { allowOpenFork: true })
    active = started.active
    await vi.waitFor(async () =>
      expect((await fixture.manualRecovery().readManualRecovery(started.saved.id))?.stage).toBe(
        'completed',
      ),
    )
    expect(active.created[0]?.manualRecovery).toBeUndefined()
    expect(active.created[0]?.recoveryOnly).toBe(false)
  } finally {
    active?.owner.dispose()
    await active?.owner.drained()
    await fixture.close()
  }
})

for (const mode of ['real-mls', 'double'] as const) {
  for (const offset of [1, 0] as const) {
    test(`current move ${offset === 1 ? 'refuses known lag floor above' : 'allows floor at'} state epoch / ${mode}`, async () => {
      const fixture = await createRegistryFixture({ mode, groupID: key.groupID, setup: 'seeded' })
      let active: Awaited<ReturnType<typeof start>> | undefined
      try {
        const state = await fixture.device.groups.loadState(key)
        if (state === null || state.deleted) throw new Error('Missing seeded state')
        // An authenticated floor without any strand or rejoin: the device knows the group moved on.
        await mutate(() => ({ recoveryEpochFloor: state.epoch + offset }))(fixture)
        const before = await fixture.device.groups.ports(key).control.load()
        expect(before).toMatchObject({ strand: null, rejoin: null, cursor: null })
        const started = await movement(fixture, { allowOpenFork: false })
        active = started.active
        if (offset === 1) {
          expect((await fixture.manualRecovery().readManualRecovery(started.saved.id))?.stage).toBe(
            'authorised',
          )
          expectRejoinOnly(active.created, started.saved.id)
          expect((await fixture.device.groups.ports(key).control.load()).recoveryEpochFloor).toBe(
            state.epoch + 1,
          )
        } else {
          await vi.waitFor(async () =>
            expect(
              (await fixture.manualRecovery().readManualRecovery(started.saved.id))?.stage,
            ).toBe('completed'),
          )
          expect(active.created[0]?.manualRecovery).toBeUndefined()
          expect(active.created[0]?.recoveryOnly).toBe(false)
        }
      } finally {
        active?.owner.dispose()
        await active?.owner.drained().catch(() => {})
        await fixture.close()
      }
    })
  }
}

for (const mode of ['real-mls', 'double'] as const) {
  for (const context of ['supplied', 'absent'] as const) {
    test(`current device moves without rejoin / ${mode} / ${context}`, async () => {
      const fixture = await createRegistryFixture({
        mode,
        groupID: key.groupID,
        setup: 'seeded',
        ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
      })
      const destination = watchedHub()
      const original = watchedHub()
      let active: Awaited<ReturnType<typeof start>> | undefined
      try {
        const state = await fixture.device.groups.loadState(key)
        if (state === null || state.deleted) throw new Error('Missing seeded state')
        await mutateControl(fixture, (snapshot) => ({
          ...snapshot,
          cursor: { position: '0000000042' as LogPosition, epoch: state.epoch },
        }))
        const safety = api.createGroupSafety(await registryFixtureSafetyParams(fixture))
        const keyBefore = { ...key }
        const authenticatorBefore = await safety.epochAuthenticator(key)
        active = await start(fixture, async () => {
          throw new Error('Live binding must be used')
        })
        expect(active.created).toHaveLength(1)
        // Ordinary startup may persist state bookkeeping; the move itself must not.
        const stateBefore = await fixture.device.groups.loadState(key)
        const moved = await safety.recover(key, {
          mode: 'resync',
          target: { ...movedBinding, hub: destination.hub },
        })
        const keyAfterCurrentMove = moved
        expect(keyAfterCurrentMove).toEqual(keyBefore)
        const authenticatorAfterCurrentMove = await safety.epochAuthenticator(key)
        expect(authenticatorAfterCurrentMove).toEqual(authenticatorBefore)
        const stateAfter = await fixture.device.groups.loadState(key)
        if (
          stateBefore === null ||
          stateBefore.deleted ||
          stateAfter === null ||
          stateAfter.deleted
        )
          throw new Error('Missing moved state')
        // Same MLS bytes: epoch secrets and every ratchet generation stay untouched.
        expect(stateAfter.state).toEqual(stateBefore.state)
        expect(stateAfter.epoch).toBe(stateBefore.epoch)
        expect(stateAfter.senderHWM).toBe(stateBefore.senderHWM)
        expect(active.owner.installedKey()).toEqual(key)
        expect(active.created).toHaveLength(2)
        expect(active.created[1]).toMatchObject({
          recoveryOnly: false,
          target: { targetID: movedBinding.targetID, topicID: movedBinding.commitTopicID },
          recoveryTarget: { targetID: movedBinding.targetID, topicID: movedBinding.commitTopicID },
        })
        expect(active.created[1]?.manualRecovery).toBeUndefined()
        expect(active.created[1]?.control).toBeUndefined()
        expect(active.created[1]?.hub === destination.hub).toBe(true)
        const control = await fixture.device.groups.ports(key).control.load()
        expect(control.cursor).toEqual({ position: null, epoch: state.epoch })
        const status = await safety.status(key)
        expect(status.hold).toBeNull()
        expect(status.manualRecovery?.kind).toBe('completed')
        const saved = await fixture
          .manualRecovery()
          .readManualRecovery(status.manualRecovery?.id ?? '')
        expect(saved).toMatchObject({ stage: 'completed', destination: key, attempt: null })
        expect(destination.calls).not.toHaveBeenCalled()
        expect(original.calls).not.toHaveBeenCalled()
      } finally {
        active?.owner.dispose()
        await active?.owner.drained()
        await fixture.close()
      }
    })
  }
}

test('restart mid move contacts only saved destination', async () => {
  let fixture = await createRegistryFixture({
    mode: 'real-mls',
    groupID: key.groupID,
    setup: 'seeded',
  })
  const old = watchedHub()
  const destination = watchedHub()
  let active: Awaited<ReturnType<typeof start>> | undefined
  try {
    const saved = await fixture.manualRecovery().authoriseManualRecovery(key, {
      mode: 'resync',
      ...movedBinding,
      allowOpenFork: false,
    })
    fixture = await fixture.reopen()
    const resolver = vi.fn(async (id: string) => ({
      id,
      hub: destination.hub,
      commitTopicID: movedBinding.commitTopicID,
    }))
    const startOn = async () => {
      const created: Array<api.RegistryPeerOptions> = []
      const owner = await api.createRegistryPeer({
        registry: fixture.registry,
        key,
        target: { targetID: 'original-hub', topicID: 'original-commits' },
        recovery: fixture.environment,
        resolveTarget: resolver,
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
          // A host falls back to its old hub only when no destination is supplied.
          if (options.hub === undefined) void old.hub.publish
          return { dispose: async () => {}, drained: async () => {} } as unknown as NonNullable<
            ReturnType<api.RegistryPeer['peer']>
          >
        },
      })
      await owner.ready.catch(() => {})
      return { owner, created }
    }
    active = await startOn()
    expect(active.created).toHaveLength(1)
    expect(active.created[0]?.hub === destination.hub).toBe(true)
    expect(await fixture.manualRecovery().readManualRecovery(saved.id)).toMatchObject({
      stage: 'completed',
      destination: key,
    })
    active.owner.dispose()
    await active.owner.drained()
    fixture = await fixture.reopen()
    active = await startOn()
    expect(active.created).toHaveLength(1)
    expect(active.created[0]?.hub === destination.hub).toBe(true)
    expect(active.created[0]?.manualRecovery).toBeUndefined()
    const oldHubCallsAfterRestart = old.calls.mock.calls.length
    expect(oldHubCallsAfterRestart).toBe(0)
    expect(resolver.mock.calls.every(([id]) => id === movedBinding.targetID)).toBe(true)
  } finally {
    active?.owner.dispose()
    await active?.owner.drained()
    await fixture.close()
  }
})

test('destination mismatch preserves saved work', async () => {
  let fixture = await createRegistryFixture({
    mode: 'real-mls',
    groupID: key.groupID,
    setup: 'seeded',
  })
  let active: Awaited<ReturnType<typeof start>> | undefined
  try {
    const candidate = await fixture.confirmedRecovery(key, { confirm: false })
    if (!('format' in candidate.record)) throw new Error('Captured candidate required')
    const saved = await fixture.manualRecovery().authoriseManualRecovery(key, {
      mode: 'resync',
      ...binding,
      allowOpenFork: false,
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
            trigger: 'manual',
            authorisationID: saved.id,
          },
        },
        'exact-saved-work',
      )
    const before = await fixture.manualRecovery().readManualRecovery(saved.id)
    const control = await fixture.device.groups.ports(key).control.load()
    fixture = await fixture.reopen()
    const alternate = watchedHub()
    active = await start(fixture, async (id) => ({
      id,
      hub: alternate.hub,
      commitTopicID: binding.commitTopicID,
    }))
    await vi.waitFor(() => expect(active?.created).toHaveLength(1))
    // A saved candidate retries exactly; it is never discarded for a current move.
    expectRejoinOnly(active.created, saved.id)
    const after = await fixture.manualRecovery().readManualRecovery(saved.id)
    expect(after?.stage).toBe('authorised')
    expect(encodeStoredValue(after?.attempt)).toEqual(encodeStoredValue(before?.attempt))
    expect(await fixture.device.groups.ports(key).control.load()).toEqual(control)
    expect(alternate.calls).not.toHaveBeenCalled()
  } finally {
    active?.owner.dispose()
    await active?.owner.drained()
    await fixture.close()
  }
})

for (const mode of ['real-mls', 'double'] as const) {
  test(`current move refuses every hold condition notice and active rejoin / pending owner work / ${mode}`, async () => {
    const fixture = await createRegistryFixture({ mode, groupID: key.groupID, setup: 'seeded' })
    try {
      const entry = entryCapability(fixture.device.groups)
      if (entry === null) throw new Error('Missing entry capability')
      const store = fixture.manualRecovery()
      const saved = await store.authoriseManualRecovery(key, {
        mode: 'resync',
        ...movedBinding,
        allowOpenFork: false,
      })
      const access = await fixture.registry.access(key.groupID)
      const runtime = { stateVersion: access.stateVersion(), ledgerComplete: true }
      const reached = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<void>()
      fixture.onPhase('work', async () => {
        reached.resolve()
        await gate.promise
      })
      const moving = store.moveCurrent(saved.id, runtime)
      await reached.promise
      // Owner work queued behind the decision could still publish from or advance this state.
      const queued = entry.run(
        { groupID: key.groupID, mutationID: crypto.randomUUID() },
        async (reads) => ({ expected: await reads.lifetime(), value: null }),
        async () => {},
      )
      gate.resolve()
      expect(await moving).toBe(false)
      await queued
      expect(await store.readManualRecovery(saved.id)).toEqual(saved)
      expect(await store.moveCurrent(saved.id, runtime)).toBe(true)
    } finally {
      await fixture.close()
    }
  })
}

for (const mode of ['real-mls', 'double'] as const) {
  test(`manual resync start finding spent corruption rejects recover / ${mode}`, async () => {
    const fixture = await createRegistryFixture({ mode, groupID: key.groupID, setup: 'seeded' })
    const { hub } = watchedHub()
    let active: Awaited<ReturnType<typeof start>> | undefined
    try {
      // Behind, so the authorised resync cannot move current and reaches start().
      await mutateControl(fixture, (snapshot) => ({
        ...snapshot,
        strand: { reason: 'retention-gap' },
      }))
      active = await start(fixture, async () => {
        throw new Error('Resolver unused')
      })
      await fixture.corruptTrust(key.groupID, 'missing-spent')
      const safety = api.createGroupSafety(await registryFixtureSafetyParams(fixture))
      const running = safety.recover(key, { mode: 'resync', target: { ...binding, hub } })
      const settled = await Promise.race([
        running.then(
          () => 'resolved',
          (error: unknown) => error,
        ),
        new Promise((resolve) => setTimeout(() => resolve('unsettled'), 5_000)),
      ])
      expect(settled).toBeInstanceOf(api.SpentSetCorruptError)
      expect(await fixture.safety().status(key)).toMatchObject({
        condition: 'spent-set-corrupt',
      })
    } finally {
      active?.owner.dispose()
      await active?.owner.drained().catch(() => {})
      await fixture.close()
    }
  })
}

/** Serves every checkpoint listing to the owner in the given order; the port defines none. */
function orderListings(fixture: Fixture, order: 'insertion' | 'reversed') {
  const entry = registrySafety(fixture.registry)?.entry
  if (entry === undefined) throw new Error('Missing registry capability')
  const read = entry.read.bind(entry)
  return vi.spyOn(entry, 'read').mockImplementation((groupID, fn) =>
    read(groupID, (reads) =>
      fn(
        new Proxy(reads, {
          get(target, property) {
            if (property === 'checkpoints')
              return async () => {
                const rows = await target.checkpoints()
                return order === 'reversed' ? rows.reverse() : rows
              }
            const value = Reflect.get(target, property)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }),
      ),
    ),
  )
}

async function completeMove(
  fixture: Fixture,
  binding: { targetID: string; commitTopicID: string },
) {
  const store = fixture.manualRecovery()
  const saved = await store.authoriseManualRecovery(key, {
    mode: 'resync',
    ...binding,
    allowOpenFork: false,
  })
  const access = await fixture.registry.access(key.groupID)
  const runtime = { stateVersion: access.stateVersion(), ledgerComplete: true }
  if (!(await store.moveCurrent(saved.id, runtime))) throw new Error('Move did not complete')
  return saved
}

for (const mode of ['real-mls', 'double'] as const) {
  for (const order of ['insertion', 'reversed'] as const) {
    test(`restart resumes the authorised resync over a completed move / ${mode} / ${order}`, async () => {
      const fixture = await createRegistryFixture({ mode, groupID: key.groupID, setup: 'seeded' })
      const hub = watchedHub().hub
      let active: Awaited<ReturnType<typeof start>> | undefined
      try {
        await completeMove(fixture, movedBinding)
        // Behind after the move, so the second choice must rejoin and stays pending.
        await mutateControl(fixture, (snapshot) => ({
          ...snapshot,
          strand: { reason: 'retention-gap' },
        }))
        const pending = await fixture.manualRecovery().authoriseManualRecovery(key, {
          mode: 'resync',
          targetID: 'second-hub',
          commitTopicID: 'second-commits',
          allowOpenFork: false,
        })
        orderListings(fixture, order)
        active = await start(fixture, async (id) => ({
          id,
          hub,
          commitTopicID: id === 'second-hub' ? 'second-commits' : movedBinding.commitTopicID,
        }))
        expect(active.owner.status().kind).not.toBe('failed')
        expect(active.created[0]?.manualRecovery).toEqual({
          authorisationID: pending.id,
          source: key,
        })
        expect(active.created[0]?.target).toEqual({
          targetID: 'second-hub',
          topicID: 'second-commits',
        })
      } finally {
        vi.restoreAllMocks()
        active?.owner.dispose()
        await active?.owner.drained().catch(() => {})
        await fixture.close()
      }
    })

    test(`restart routes to the newest completed move / ${mode} / ${order}`, async () => {
      const fixture = await createRegistryFixture({ mode, groupID: key.groupID, setup: 'seeded' })
      const hub = watchedHub().hub
      let active: Awaited<ReturnType<typeof start>> | undefined
      try {
        await completeMove(fixture, movedBinding)
        await completeMove(fixture, { targetID: 'newest-hub', commitTopicID: 'newest-commits' })
        orderListings(fixture, order)
        active = await start(fixture, async (id) => ({
          id,
          hub,
          commitTopicID: id === 'newest-hub' ? 'newest-commits' : movedBinding.commitTopicID,
        }))
        expect(active.created[0]?.target).toEqual({
          targetID: 'newest-hub',
          topicID: 'newest-commits',
        })
      } finally {
        vi.restoreAllMocks()
        active?.owner.dispose()
        await active?.owner.drained().catch(() => {})
        await fixture.close()
      }
    })
  }
}

// Loaded by URL: rpc's fake peer harness is not a published export.
const rpcFixture = (name: string) =>
  import(new URL(`../../rpc/test/fixtures/${name}.ts`, import.meta.url).href)

/** A frame published on a fresh destination hub while the moved device is away, then its drain. */
async function deliveredAfterMove(fixture: Fixture): Promise<Array<unknown>> {
  const { DurableFakeHub } = await rpcFixture('durable-fake-hub')
  const { makeMLSPeer } = await rpcFixture('peer')
  const hub = new DurableFakeHub()
  const recoverySecret = new Uint8Array(32).fill(0x91)
  const seen: Array<unknown> = []
  const handlers = { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) }
  const ports = fixture.device.groups.ports(key)
  // The device's own durable app positions, exactly as a host wires them.
  const appCursorStore = {
    load: (topicID: string) => ports.cursor.load(topicID),
    save: (topicID: string, position: string) => ports.cursor.save(topicID, position),
    stored: () => null,
    history: () => [],
  }
  const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
  const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, handlers, appCursorStore })
  await new Promise((resolve) => setTimeout(resolve, 50))
  await bob.peer.dispose()
  hub.detach('bob')
  await alice.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'on the new hub' } })
  await new Promise((resolve) => setTimeout(resolve, 50))
  const back = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: bob, handlers })
  hub.reattach('bob')
  await new Promise((resolve) => setTimeout(resolve, 100))
  await alice.peer.dispose()
  await back.peer.dispose()
  return seen
}

for (const mode of ['real-mls', 'double'] as const) {
  for (const path of ['live', 'restart mid move'] as const) {
    test(`moved current device receives app frames from a fresh hub / ${mode} / ${path}`, async () => {
      let fixture = await createRegistryFixture({ mode, groupID: key.groupID, setup: 'seeded' })
      const destination = watchedHub()
      let active: Awaited<ReturnType<typeof start>> | undefined
      try {
        const { fakeEpochSecret } = await rpcFixture('fake-crypto')
        const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')
        // The old hub's position, far above anything a fresh hub has minted.
        await fixture.device.groups.ports(key).cursor.save(topicID, '000000099999')
        if (path === 'live') {
          active = await start(fixture, async () => {
            throw new Error('Live binding must be used')
          })
          const safety = api.createGroupSafety(await registryFixtureSafetyParams(fixture))
          expect(
            await safety.recover(key, {
              mode: 'resync',
              target: { ...movedBinding, hub: destination.hub },
            }),
          ).toEqual(key)
        } else {
          const saved = await fixture.manualRecovery().authoriseManualRecovery(key, {
            mode: 'resync',
            ...movedBinding,
            allowOpenFork: false,
          })
          fixture = await fixture.reopen()
          active = await start(fixture, async (id) => ({
            id,
            hub: destination.hub,
            commitTopicID: movedBinding.commitTopicID,
          }))
          expect(await fixture.manualRecovery().readManualRecovery(saved.id)).toMatchObject({
            stage: 'completed',
            destination: key,
          })
        }
        active.owner.dispose()
        await active.owner.drained()
        active = undefined
        expect(await deliveredAfterMove(fixture)).toEqual([{ text: 'on the new hub' }])
      } finally {
        active?.owner.dispose()
        await active?.owner.drained().catch(() => {})
        await fixture.close()
      }
    })
  }
}
