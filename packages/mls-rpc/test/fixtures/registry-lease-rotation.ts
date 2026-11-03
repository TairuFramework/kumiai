import { decodeClientState, type GroupHandle, restoreGroup } from '@kumiai/mls'
import {
  type AppOutbox,
  createGroupPeer,
  decodeAppAAD,
  type GroupMLS,
  type GroupPeerParams,
  type GroupProcedureHandlers,
  type LogHub,
  type OpenedDeliveryContext,
} from '@kumiai/rpc'
import { expect } from 'vitest'

import { decodeAutoRotationCandidate } from '../../src/auto-rotation.js'
import * as api from '../../src/index.js'
import type { GroupKey, MemoryTransaction } from '../../src/persistence-types.js'
import type { createRegistryFixture } from './registry.js'
import {
  buildSealedMemoryOperation,
  restoreMemoryControlHandle,
  restoreMemoryControlSource,
  sealedMemoryValidation,
} from './sealed-memory-mls.js'

export async function startLeaseRotationPeer(params: {
  mode: 'real-mls' | 'double'
  fixture: Awaited<ReturnType<typeof createRegistryFixture>>
  key: GroupKey
  outbox: AppOutbox
  handler?: GroupProcedureHandlers<
    {
      posted: { type: 'event'; retain: 'log'; data: { type: 'object' } }
    },
    MemoryTransaction
  >['posted']
  openedDeliveryContext?: OpenedDeliveryContext
  recovery?: GroupPeerParams<Record<string, never>>['recovery']
  freezeHub?: boolean
}) {
  const { mode, fixture, key } = params
  const { FakeHub } = (await import(
    new URL('../../../rpc/test/fixtures/fake-hub.ts', import.meta.url).href
  )) as {
    FakeHub: new () => LogHub & {
      published: Array<{ topicID: string; payload: Uint8Array }>
    }
  }
  const hub = new FakeHub()
  const wire = params.freezeHub
    ? Object.freeze<LogHub>({
        publish: (...args) => hub.publish(...args),
        fetchTopic: (...args) => hub.fetchTopic(...args),
        subscribe: (...args) => hub.subscribe?.(...args),
        unsubscribe: (...args) => hub.unsubscribe?.(...args),
        receive: (...args) => hub.receive(...args),
      })
    : hub
  const target = { targetID: 'lease-rotation-hub', topicID: 'lease-rotation-commits' }
  let mls: GroupMLS | undefined
  let receiver: GroupHandle | undefined
  const restore = async (bytes: Uint8Array) => {
    const candidate = decodeAutoRotationCandidate(bytes)
    const state = decodeClientState(candidate.state)
    if (state === undefined) throw new Error('Missing rotation candidate state')
    const options = {
      state,
      credential: candidate.credential,
      ledgerEntries: candidate.ledger,
      options: fixture.environment.options,
    }
    const restoreHandle = mode === 'double' ? restoreMemoryControlHandle : restoreGroup
    // Keep an independent receiver before the adopted sender consumes its fresh range.
    receiver = await restoreHandle({ ...options, state: structuredClone(state) })
    return restoreHandle(options)
  }
  const rawAccess = await fixture.registry.access(key.groupID)
  const groupCrypto = api.createGroupCrypto({ access: rawAccess })
  const owner = await api.createRegistryPeer<MemoryTransaction>({
    registry: fixture.registry,
    key,
    recovery: fixture.environment,
    target,
    continuation: api.createRecoveryContinuationPort({
      registry: fixture.registry,
      persistence: fixture.device.groups,
    }),
    createMLS: async (key) => {
      mls = await api.createRegistryGroupMLS({
        registry: fixture.registry,
        key,
        recovery: fixture.environment,
        target,
        identity: fixture.identity,
        entrySlot: api.createLedgerEntrySlot(),
      })
      return mls
    },
    createPeer: async (key, options) => {
      const access = api.createRegistryHandleAccess({ access: rawAccess })
      const ports = fixture.device.groups.ports(key)
      const build = api.createControlBuildPort({
        access,
        control: ports.control,
        build: async () => {
          throw new Error('Automatic rotation reached the host builder')
        },
        rotate: mode === 'double' ? buildSealedMemoryOperation : undefined,
        restoreCandidate: restore,
        restoreSource: async ({ state, credential, ledgerEntries }) => {
          const decoded = decodeClientState(state)
          if (decoded === undefined) throw new Error('Missing rotation source state')
          return (mode === 'double' ? restoreMemoryControlSource : restoreGroup)({
            state: decoded,
            credential,
            ledgerEntries,
            options: fixture.environment.options,
          })
        },
        saveBuilt: api.createPersistenceBuildSaver({ persistence: fixture.device.groups, key }),
        now: Date.now,
        newID: () => crypto.randomUUID(),
      })
      return createGroupPeer({
        ...options,
        openedDeliveryContext: options.openedDeliveryContext ?? params.openedDeliveryContext,
        hub: wire,
        recovery: params.recovery,
        crypto: groupCrypto,
        control: ports.control,
        anchorStore: ports.anchor,
        appCursorStore: ports.cursor,
        appOutbox: params.outbox,
        appPublication: api.createRegistryAppPublication(rawAccess),
        appOutboxLimit: 4,
        localDID: fixture.identity.id,
        protocols: { chat: { posted: { type: 'event', retain: 'log', data: { type: 'object' } } } },
        handlers: { chat: { posted: params.handler ?? (async () => {}) } },
        prepareBuild: build.prepareBuild,
        validation:
          mode === 'double'
            ? sealedMemoryValidation()
            : api.createControlValidationPort({
                identity: fixture.identity,
                options: fixture.environment.options,
                restoreCandidate: restore,
              }),
        readEvidence: () => fixture.device.groups.readEvidence(key),
        adopt: api.createControlAdoptionPort({
          access,
          control: ports.control,
          restoreCandidate: restore,
        }).adopt,
        deliverWelcome: async () => {},
      })
    },
  })
  return {
    owner,
    hub,
    mls: () => {
      if (mls === undefined) throw new Error('Missing peer MLS')
      return mls
    },
    frames() {
      return hub.published.filter((frame) => {
        const aad = groupCrypto.frameAAD(frame.payload)
        return aad !== null && decodeAppAAD(aad)?.intent === 'log'
      })
    },
    async open(frame: { payload: Uint8Array }) {
      if (receiver === undefined) throw new Error('Missing rotated receiver')
      const aad = groupCrypto.frameAAD(frame.payload)
      if (aad === null) throw new Error('Missing application AAD')
      expect(groupCrypto.frameEpoch(frame.payload)).toBe(1)
      expect(decodeAppAAD(aad)).toMatchObject({ intent: 'log' })
      return receiver.decrypt(frame.payload, { expectedAAD: aad })
    },
  }
}
