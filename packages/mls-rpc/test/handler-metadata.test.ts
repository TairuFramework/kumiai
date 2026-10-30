import type { LogHub } from '@kumiai/rpc'
import { createGroupPeer } from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import { createRegistryAppPublication } from '../src/app-publication.js'
import { entryCapability } from '../src/entry-capability.js'
import { createHandlerCompletion } from '../src/handler-completion.js'
import { createLedgerEntrySlot } from '../src/mls.js'
import { createRegistryGroupMLS } from '../src/registry-group-mls.js'
import { openedDeliveryContext } from './fixtures/ownership-context.js'
import { createTestCompletion } from './fixtures/real-group.js'
import { createRegistryCryptoGroup } from './fixtures/registry-crypto.js'

const { FakeHub } = (await import(
  new URL('../../rpc/test/fixtures/fake-hub.ts', import.meta.url).href
)) as { FakeHub: new () => LogHub }
const protocol = {
  changed: { type: 'event', data: { type: 'object' } },
  ping: { type: 'request', param: { type: 'object' }, result: { type: 'number' } },
  stream: { type: 'stream', receive: { type: 'number' }, result: { type: 'number' } },
  channel: {
    type: 'channel',
    send: { type: 'number' },
    receive: { type: 'number' },
    result: { type: 'number' },
  },
} as const

for (const mode of ['real-mls', 'double'] as const) {
  test(`metadata-only ephemeral delivery persists nothing, ${mode}`, async () => {
    const group = await createRegistryCryptoGroup(mode, 'handler-metadata', 2)
    const fixture = group.fixture()
    const remote = group.members[1]
    if (remote === undefined) throw new Error('Missing sender')
    const access = group.access()
    const ports = fixture.device.groups.ports(group.key)
    const completion = createHandlerCompletion({
      persistence: fixture.device.groups,
      key: group.key,
    })
    const seen: Array<string> = []
    const check = (kind: string, context: unknown) => {
      expect(context).toMatchObject({
        epoch: access.epoch(),
        incarnation: group.key.incarnation,
        message: { payload: { iss: remote.did } },
      })
      for (const field of ['frame', 'idempotencyKey', 'tx'])
        expect(context).not.toHaveProperty(field)
      seen.push(kind)
    }
    const hub = new FakeHub()
    const localCrypto = group.receiver()
    const local = createGroupPeer({
      completion,
      openedDeliveryContext,
      hub,
      crypto: localCrypto,
      localDID: fixture.identity.id,
      protocols: { app: protocol },
      handlers: {
        app: {
          changed: (context) => {
            check('event', context)
          },
          ping: (context) => {
            check('request', context)
            return 42
          },
          stream: async (context) => {
            check('stream', context)
            const writer = context.writable.getWriter()
            await writer.write(1)
            await writer.close()
            return 1
          },
          channel: async (context) => {
            check('channel', context)
            const reader = context.readable.getReader()
            const { value } = await reader.read()
            reader.releaseLock()
            const writer = context.writable.getWriter()
            if (value !== undefined) await writer.write(value)
            await writer.close()
            return 2
          },
        },
      },
      mls: await createRegistryGroupMLS({
        registry: fixture.registry,
        key: group.key,
        recovery: fixture.environment,
        target: { targetID: 'metadata-hub', topicID: 'metadata-commits' },
        identity: fixture.identity,
        entrySlot: createLedgerEntrySlot(),
      }),
      control: ports.control,
      anchorStore: ports.anchor,
      appCursorStore: ports.cursor,
      appOutbox: ports.outbox,
      appPublication: createRegistryAppPublication(access),
      appOutboxLimit: 16,
      prepareBuild: async () => {
        throw new Error('Unexpected control work')
      },
      validation: {
        restoreValidation: async () => {
          throw new Error('Unexpected validation')
        },
      },
      readEvidence: () => fixture.device.groups.readEvidence(group.key),
      adopt: async () => {
        throw new Error('Unexpected adoption')
      },
      deliverWelcome: async () => {},
    })
    const sender = createGroupPeer({
      completion: createTestCompletion(group.key),
      hub,
      crypto: remote.crypto,
      localDID: remote.did,
      protocols: { app: protocol },
      handlers: { app: {} as never },
    })
    try {
      const client = await sender.protocol('app').to(fixture.identity.id)
      await local.protocol('app').to(remote.did)
      expect(await client.request('ping', { param: {} })).toBe(42)
      seen.length = 0
      const before = await fixture.inspectRows()
      const capability = entryCapability(fixture.device.groups)
      if (capability === null) throw new Error('Missing entry capability')
      const transitions = vi.spyOn(capability, 'run')
      const complete = vi.spyOn(completion, 'complete')
      const transact = vi.spyOn(completion, 'transact')
      const pending = vi.spyOn(
        localCrypto.pending as NonNullable<typeof localCrypto.pending>,
        'complete',
      )
      const cursor = vi.spyOn(ports.cursor, 'save')
      const outbox = vi.spyOn(ports.outbox, 'put')
      await sender.protocol('app').dispatch('changed', { data: {} })
      expect(await sender.protocol('app').request('ping', { param: {}, timeoutMs: 1000 })).toBe(42)
      expect(await client.request('ping', { param: {} })).toBe(42)
      const stream = client.createStream('stream')
      const streamed: Array<number> = []
      for await (const value of stream.readable) streamed.push(value)
      expect(streamed).toEqual([1])
      expect(await stream).toBe(1)
      const channel = client.createChannel('channel')
      await channel.send(2)
      const replies: Array<number> = []
      for await (const value of channel.readable) replies.push(value)
      expect(replies).toEqual([2])
      expect(await channel).toBe(2)
      await vi.waitFor(() => expect(seen).toHaveLength(5))
      expect(seen).toEqual(['event', 'request', 'request', 'stream', 'channel'])
      for (const call of [transitions, complete, transact, pending, cursor, outbox])
        expect(call).not.toHaveBeenCalled()
      expect(await fixture.inspectRows()).toEqual(before)
    } finally {
      await sender.dispose()
      await local.dispose()
      await local.drained()
      await group.close()
    }
  })
}
