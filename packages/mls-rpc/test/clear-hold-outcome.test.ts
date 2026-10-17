import { randomIdentity } from '@kokuin/token'
import {
  APP_TOPIC_LABEL,
  createGroupPeer,
  encodeAppAAD,
  type GroupCrypto,
  type LogHub,
  type PendingAppFrame,
  protocolTopic,
} from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import { createControlValidationPort } from '../src/control-validation.js'
import { createLedgerEntrySlot } from '../src/mls.js'
import { StorageOutcomeUnknownError } from '../src/persistence-errors.js'
import { registrySafety } from '../src/registry/safety.js'
import { createRegistryGroupMLS } from '../src/registry-group-mls.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createRegistryFixture } from './fixtures/registry.js'

const { FakeHub } = (await import(
  new URL('../../rpc/test/fixtures/fake-hub.ts', import.meta.url).href
)) as { FakeHub: new () => LogHub }
const { createFakeCrypto } = (await import(
  new URL('../../rpc/test/fixtures/fake-crypto.ts', import.meta.url).href
)) as {
  createFakeCrypto(params: {
    epoch: number
    localDID: string
    pending?: {
      persistOpened(state: Uint8Array, record: PendingAppFrame): Promise<void>
      list(): Promise<Array<PendingAppFrame>>
      complete(id: string): Promise<void>
    }
  }): GroupCrypto
}
const { encodeEventFrame } = (await import(
  new URL('../../broadcast/src/event-frame.ts', import.meta.url).href
)) as { encodeEventFrame(procedure: string, data: Record<string, unknown>): Uint8Array }

for (const context of ['supplied', 'absent'] as const) {
  describe(`clear outcome / ownership context ${context}`, () => {
    test.each(['uncommitted', 'unreadable'] as const)(
      'ambiguous clear keeps the latch when its lifetime is %s',
      async (outcome) => {
        const key = { groupID: `clear-outcome-${context}-${outcome}`, incarnation: 1 }
        const f = await createRegistryFixture({
          mode: 'real-mls',
          setup: 'seeded',
          groupID: key.groupID,
          ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        })
        try {
          const capability = registrySafety(f.registry)
          if (capability === null) throw new Error('Missing safety capability')
          await f.safety().reportFork(key, {
            kind: 'unexplained-own-commit',
            epoch: 0,
            position: '1',
            digest: 'app-observation',
          })
          if (outcome === 'uncommitted') f.armNextWorkFault('before-commit')
          else {
            f.armNextWorkFault('commit-then-reject')
            const run = capability.entry.run.bind(capability.entry)
            const failure = new StorageOutcomeUnknownError('Clear outcome unavailable to caller')
            vi.spyOn(capability.entry, 'run').mockImplementationOnce(async (...args) => {
              await run(...args)
              vi.spyOn(capability.entry, 'read').mockRejectedValueOnce(new Error('Read failed'))
              throw failure
            })
          }
          await expect(f.safety().clearHold(key)).rejects.toThrow()
          expect(capability.held(key)).toBe('fork-halted')
          expect((await f.device.groups.ports(key).control.load()).forkHalt === null).toBe(
            outcome === 'unreadable',
          )
        } finally {
          vi.restoreAllMocks()
          await f.close()
        }
      },
    )

    test('ambiguous clear commit still releases the app-hold latch', async () => {
      const key = { groupID: `clear-outcome-${context}`, incarnation: 1 }
      const f = await createRegistryFixture({
        mode: 'real-mls',
        setup: 'seeded',
        groupID: key.groupID,
        ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
      })
      let peer: ReturnType<typeof createGroupPeer> | undefined
      try {
        const capability = registrySafety(f.registry)
        if (capability === null) throw new Error('Missing safety capability')
        const mls = await createRegistryGroupMLS({
          registry: f.registry,
          key,
          recovery: f.environment,
          target: { targetID: 'hub', topicID: 'commits' },
          identity: f.identity,
          entrySlot: createLedgerEntrySlot(),
        })
        const epoch = (await f.registry.access(key.groupID)).epoch()
        const pending = new Map<string, PendingAppFrame>()
        const reader = createFakeCrypto({
          epoch,
          localDID: f.identity.id,
          pending: {
            persistOpened: async (_state, record) => {
              pending.set(record.frame.id, record)
            },
            list: async () => [...pending.values()],
            complete: async (id) => {
              pending.delete(id)
            },
          },
        })
        const sender = createFakeCrypto({ epoch, localDID: randomIdentity().id })
        const hub = new FakeHub()
        const delivered: Array<unknown> = []
        const ports = f.device.groups.ports(key)
        const unexpected = () => {
          throw new Error('No control work expected')
        }
        peer = createGroupPeer({
          hub,
          crypto: reader,
          localDID: f.identity.id,
          protocols: {
            chat: { posted: { type: 'event', retain: 'log', data: { type: 'object' } } },
          },
          handlers: {
            chat: {
              posted: ({ data }) => {
                delivered.push(data)
              },
            },
          },
          mls,
          control: ports.control,
          anchorStore: ports.anchor,
          appCursorStore: ports.cursor,
          appOutbox: ports.outbox,
          appOutboxLimit: 16,
          validation: createControlValidationPort({
            identity: f.identity,
            options: f.environment.options,
            restoreCandidate: unexpected,
          }),
          prepareBuild: unexpected,
          adopt: unexpected,
          deliverWelcome: unexpected,
          readEvidence: () => f.device.groups.readEvidence(key),
        })
        await peer.replay()
        await f.safety().reportFork(key, {
          kind: 'unexplained-own-commit',
          epoch,
          position: '1',
          digest: 'app-observation',
        })
        const { secret } = await reader.exportSecret(APP_TOPIC_LABEL)
        const topicID = protocolTopic(secret, epoch, 'chat')
        await hub.publish({
          topicID,
          senderDID: randomIdentity().id,
          payload: await sender.wrap(encodeEventFrame('posted', { text: 'held' }), {
            aad: encodeAppAAD({ topicID, intent: 'log' }),
          }),
          retain: 'log',
        })
        await peer.replay()
        expect(delivered).toEqual([])
        expect(capability.held(key)).toBe('fork-halted')
        f.armNextWorkFault('commit-then-reject')
        const run = capability.entry.run.bind(capability.entry)
        const failure = new StorageOutcomeUnknownError('Clear outcome unavailable to caller')
        vi.spyOn(capability.entry, 'run').mockImplementationOnce(async (...args) => {
          await run(...args)
          throw failure
        })
        await expect(f.safety().clearHold(key)).rejects.toBe(failure)
        expect((await ports.control.load()).forkHalt).toBeNull()
        expect(capability.held(key)).toBeNull()
        await peer.replay()
        await vi.waitFor(() => expect(delivered).toEqual([{ text: 'held' }]))
      } finally {
        vi.restoreAllMocks()
        await peer?.dispose()
        await peer?.drained()
        await f.close()
      }
    })
  })
}
