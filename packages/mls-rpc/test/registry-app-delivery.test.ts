import { encodeEventFrame } from '@kumiai/broadcast'
import {
  APP_TOPIC_LABEL,
  createGroupPeer,
  encodeAppAAD,
  frameID,
  type GroupProcedureHandlers,
  type LogHub,
  protocolTopic,
  settleControlSlot,
} from '@kumiai/rpc'
import { expect, onTestFinished, test, vi } from 'vitest'

import { createControlAdoptionPort } from '../src/control-adoption.js'
import * as api from '../src/index.js'
import { createRegistryHandleAccess } from '../src/registry-handle-access.js'
import { restoreHost } from './fixtures/registry.js'
import { createRegistryCryptoGroup } from './fixtures/registry-crypto.js'

const chat = {
  'chat/posted': { type: 'event', retain: 'log', data: { type: 'object' } },
} as const
type Handler = GroupProcedureHandlers<typeof chat>['chat/posted']
type Delivery = Parameters<Handler>[0]
const { DurableFakeHub } = (await import(
  new URL('../../rpc/test/fixtures/durable-fake-hub.ts', import.meta.url).href
)) as { DurableFakeHub: new () => LogHub & { redeliver(did: string): void } }

async function setup(mode: 'real-mls' | 'double', name: string) {
  const group = await createRegistryCryptoGroup(mode, name, 2)
  const hub = new DurableFakeHub()
  const owners: Array<api.RegistryPeer> = []
  const topicID = protocolTopic(
    await group.sender.handle.exportSecret(APP_TOPIC_LABEL, new Uint8Array(), 32),
    group.access().epoch(),
    'chat',
  )
  onTestFinished(async () => {
    for (const owner of owners) {
      owner.dispose()
      await owner.drained()
    }
    await group.close()
  })
  const start = async (handler: Handler) => {
    const f = group.fixture()
    const crypto = api.createGroupCrypto({ access: await f.registry.access(group.key.groupID) })
    const owner = await api.createRegistryPeer({
      registry: f.registry,
      key: group.key,
      recovery: f.environment,
      target: { targetID: 'app-hub', topicID: 'app-commits' },
      continuation: api.createRecoveryContinuationPort({
        registry: f.registry,
        persistence: f.device.groups,
      }),
      createMLS: (key, _handoff, options) =>
        api.createRegistryGroupMLS({
          registry: f.registry,
          key,
          recovery: f.environment,
          identity: f.identity,
          entrySlot: api.createLedgerEntrySlot(),
          ...options,
        }),
      createPeer: async (key, options) => {
        const ports = f.device.groups.ports(key)
        return createGroupPeer({
          ...options,
          hub,
          crypto,
          control: ports.control,
          anchorStore: ports.anchor,
          appCursorStore: ports.cursor,
          appOutbox: ports.outbox,
          appOutboxLimit: 16,
          localDID: f.identity.id,
          protocols: { chat },
          handlers: { chat: { 'chat/posted': handler } },
          validation: api.createControlValidationPort({
            identity: f.identity,
            options: f.environment.options,
            restoreCandidate: (bytes) => restoreHost(f, bytes),
          }),
          readEvidence: () => f.device.groups.readEvidence(key),
          prepareBuild: async () => {
            throw new Error('Unexpected control build')
          },
          adopt: async () => {
            throw new Error('Unexpected peer adoption')
          },
          deliverWelcome: async () => {},
        })
      },
    })
    owners.push(owner)
    await owner.ready
    const peer = owner.peer()
    if (peer === null) throw new Error('Missing registry peer')
    await peer.protocol('chat').to(group.sender.identity.id)
    return { owner, peer, crypto }
  }
  const seal = (plaintext = encodeEventFrame('chat/posted', { text: 'hello' })) =>
    group.sender.handle.encrypt(plaintext, { aad: encodeAppAAD({ topicID, intent: 'log' }) })
  const publish = (payload: Uint8Array) =>
    hub.publish({ topicID, payload, senderDID: group.sender.identity.id, retain: 'log' })
  const cursor = () => group.fixture().device.groups.ports(group.key).cursor.load(topicID)
  return { group, hub, topicID, start, seal, publish, cursor }
}

function rpcFrame(delivery: Delivery) {
  const frame = delivery.frame
  if (frame === undefined) throw new Error('Missing durable frame')
  const { id, topicID, protocol, segment, position } = frame
  return { id, topicID, protocol, segment, position }
}

function senderDID(delivery: Delivery) {
  const payload = delivery.message.payload
  if (!('iss' in payload)) throw new Error('Missing authenticated sender')
  return payload.iss
}

for (const mode of ['real-mls', 'double'] as const) {
  test(`registry peer delivers a durable app frame / ${mode}`, async () => {
    const f = await setup(mode, 'durable-delivery')
    const handler = vi.fn<Handler>()
    const running = await f.start(handler)
    const payload = await f.seal()
    const { sequenceID } = await f.publish(payload)
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
    await vi.waitFor(async () => expect(await running.crypto.pending.list()).toEqual([]))
    await vi.waitFor(async () => expect(await f.cursor()).toBe(sequenceID))
    const delivery = handler.mock.calls[0]?.[0]
    expect(delivery?.data).toEqual({ text: 'hello' })
    if (delivery === undefined) throw new Error('Missing delivery')
    expect(senderDID(delivery)).toBe(f.group.sender.identity.id)
    expect(rpcFrame(delivery)).toEqual({
      id: frameID(f.topicID, payload),
      topicID: f.topicID,
      protocol: 'chat',
      segment: f.group.access().epoch(),
      position: sequenceID,
    })
    f.hub.redeliver(f.group.fixture().identity.id)
    await running.peer.replay()
    running.owner.dispose()
    await running.owner.drained()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  test(`opened frame redelivers after restart before completion / ${mode}`, async () => {
    const f = await setup(mode, 'restart-delivery')
    const firstGate = Promise.withResolvers<void>()
    const secondGate = Promise.withResolvers<void>()
    const firstHandler = vi.fn<Handler>(async () => firstGate.promise)
    const secondHandler = vi.fn<Handler>(async () => secondGate.promise)
    try {
      const first = await f.start(firstHandler)
      const { sequenceID } = await f.publish(await f.seal())
      await vi.waitFor(() => expect(firstHandler).toHaveBeenCalledTimes(1))
      const disposing = first.peer.dispose()
      // dispose closes app delivery synchronously, before the blocked handler settles.
      await vi.waitFor(async () => {
        await expect(first.peer.protocol('chat').to(f.group.sender.identity.id)).rejects.toThrow(
          'closed',
        )
      })
      firstGate.resolve()
      await disposing
      await first.peer.drained()
      const pending = await first.crypto.pending.list()
      expect(pending).toHaveLength(1)
      expect(pending[0]?.frame.position).toBe(sequenceID)
      expect(await f.cursor()).toBeNull()
      first.owner.dispose()
      await first.owner.drained()
      await f.group.reopen()
      const second = await f.start(secondHandler)
      await vi.waitFor(() => expect(secondHandler).toHaveBeenCalledTimes(1))
      const before = firstHandler.mock.calls[0]?.[0]
      const after = secondHandler.mock.calls[0]?.[0]
      if (before === undefined || after === undefined) throw new Error('Missing deliveries')
      expect(after.data).toEqual(before.data)
      expect(senderDID(before)).toBe(f.group.sender.identity.id)
      expect(senderDID(after)).toBe(senderDID(before))
      expect(rpcFrame(after)).toEqual(rpcFrame(before))
      expect(await second.crypto.pending.list()).toEqual(pending)
      expect(await f.cursor()).toBeNull()
      secondGate.resolve()
      await vi.waitFor(async () => expect(await second.crypto.pending.list()).toEqual([]))
      await vi.waitFor(async () => expect(await f.cursor()).toBe(sequenceID))
      expect(firstHandler).toHaveBeenCalledTimes(1)
      expect(secondHandler).toHaveBeenCalledTimes(1)
    } finally {
      firstGate.resolve()
      secondGate.resolve()
    }
  })

  test(`malformed authenticated plaintext never reaches a handler and the cursor passes it / ${mode}`, async () => {
    const f = await setup(mode, 'malformed-delivery')
    const handler = vi.fn<Handler>()
    const running = await f.start(handler)
    const malformed = await f.publish(await f.seal(new TextEncoder().encode('{')))
    await vi.waitFor(async () => expect(await f.cursor()).toBe(malformed.sequenceID))
    expect(handler).not.toHaveBeenCalled()
    expect(await running.crypto.pending.list()).toEqual([])
    const valid = await f.publish(await f.seal())
    await vi.waitFor(async () => expect(await f.cursor()).toBe(valid.sequenceID))
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]?.[0].data).toEqual({ text: 'hello' })
  })

  test(`departing-epoch frame delivers after the commit applies / ${mode}`, async () => {
    const f = await setup(mode, 'departing-delivery')
    const epochs: Array<number> = []
    const running = await f.start(async () => {
      epochs.push(f.group.access().epoch())
    })
    const epoch = f.group.access().epoch()
    const payload = await f.seal()
    const adoption = await f.group.fixture().acceptedOrdinary(f.group.access())
    expect(
      await f.group.access().adopt(adoption.candidate, adoption.expected, adoption.write),
    ).toBe('installed')
    expect(f.group.access().epoch()).toBe(epoch + 1)
    await running.peer.resync()
    expect(epochs).toEqual([])
    const { sequenceID } = await f.publish(payload)
    await vi.waitFor(() => expect(epochs).toEqual([epoch + 1]))
    await vi.waitFor(async () => expect(await f.cursor()).toBe(sequenceID))
    expect(await running.crypto.pending.list()).toEqual([])
    running.owner.dispose()
    await running.owner.drained()
    expect(epochs).toEqual([epoch + 1])
  })

  test(`app metadata and receipt between evidence capture and adoption keep the own commit / ${mode}`, async () => {
    const f = await setup(mode, 'app-adoption')
    const fixture = f.group.fixture()
    const registryAccess = f.group.access()
    const crypto = f.group.receiver()
    const access = createRegistryHandleAccess({ access: registryAccess })
    const control = fixture.device.groups.ports(f.group.key).control
    await fixture.acceptedOrdinary(registryAccess)
    const epoch = registryAccess.epoch()
    const adoption = createControlAdoptionPort({
      access,
      control,
      restoreCandidate: (bytes) => restoreHost(fixture, bytes),
    })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const replace = access.replace.bind(access)
    vi.spyOn(access, 'replace').mockImplementation(async (...args) => {
      entered.resolve()
      await release.promise
      return replace(...args)
    })
    const adopt = vi.spyOn(adoption, 'adopt')
    const settled = settleControlSlot({
      control,
      adoption,
      search: {
        searchLog: async () => {
          const proof = (await control.load()).commitOnceAcceptance
          if (proof === null) throw new Error('Missing accepted own commit')
          return { kind: 'first-valid', proof }
        },
      },
      readEvidence: () => fixture.device.groups.readEvidence(f.group.key),
      safetyHold: () => null,
      haltFork: async () => {
        throw new Error('Unexpected fork')
      },
      now: Date.now,
      newID: () => globalThis.crypto.randomUUID(),
      emit: () => {},
    })
    try {
      await entered.promise
      const version = (await fixture.device.groups.readEvidence(f.group.key)).source.stateVersion
      const payload = await f.seal()
      const frame = {
        id: frameID(f.topicID, payload),
        topicID: f.topicID,
        protocol: 'chat',
        segment: epoch,
        position: '000000000001',
      }
      await crypto.unwrap(payload, {
        frame,
        expectedAAD: encodeAppAAD({ topicID: f.topicID, intent: 'log' }),
      })
      expect((await fixture.device.groups.readEvidence(f.group.key)).source.stateVersion).toBe(
        version + 1,
      )
      expect(await crypto.pending.list()).toHaveLength(1)
      await crypto.pending.complete(frame.id)
      await fixture.device.groups.ports(f.group.key).cursor.save(f.topicID, frame.position)
      release.resolve()
      const result = await settled
      expect(await adopt.mock.results[0]?.value).toBe('installed')
      expect(result).toBe('landed')
      expect((await control.load()).controlHold).toBeNull()
      expect(registryAccess.epoch()).toBe(epoch + 1)
      expect(await crypto.pending.list()).toEqual([])
      expect(await f.cursor()).toBe(frame.position)
    } finally {
      release.resolve()
      await settled
      vi.restoreAllMocks()
    }
  })
}
