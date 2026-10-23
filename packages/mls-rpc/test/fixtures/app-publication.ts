import { decodeClientState, ownApplicationGeneration } from '@kumiai/mls'
import { APP_TOPIC_LABEL } from '@kumiai/rpc'
import type { AppPublicationFixture } from '@kumiai/rpc-conformance'
import { vi } from 'vitest'

import { createRegistryAppPublication } from '../../src/app-publication.js'
import { entryCapability } from '../../src/entry-capability.js'
import { encodeStoredValue } from '../../src/persistence-codec.js'
import { DisplacedGroupHandleError } from '../../src/persistence-errors.js'
import type { OwnershipContextPort } from '../../src/persistence-types.js'
import { registryLiveSend } from '../../src/registry/live-send.js'
import { createRegistryFixture, type RegistryFixture } from './registry.js'

export async function createAppPublicationFixture(
  mode: 'real-mls' | 'double',
  ownershipContext?: OwnershipContextPort,
): Promise<AppPublicationFixture> {
  const counts = { seals: 0, transactions: 0, publishes: 0, effects: 0 }
  let failEffect = false
  let failAttempt = false
  let fixture = await createRegistryFixture({
    mode,
    setup: 'empty',
    groupID: crypto.randomUUID(),
    backgroundMaintenance: 'gated',
    ownershipContext,
    effects: {
      outbox: async () => {
        counts.effects++
        if (failEffect) {
          failEffect = false
          throw new Error('Injected effect failure')
        }
      },
    },
  })
  const key = await fixture.registry.seed(await fixture.makeHandle(0), { packageUse: null })
  const initialAccess = await fixture.registry.access(key.groupID)
  await fixture.device.groups.ports(key).anchor.save({
    anchor: {
      epoch: 0,
      secret: await initialAccess.read((handle) =>
        handle.exportSecret(APP_TOPIC_LABEL, new Uint8Array(), 32),
      ),
    },
  })
  async function adapt(source: RegistryFixture): Promise<AppPublicationFixture> {
    fixture = source
    const access = await fixture.registry.access(key.groupID)
    const publication =
      access.key.incarnation === key.incarnation
        ? createRegistryAppPublication(access)
        : {
            snapshot: async () => null,
            prepare: async () => {
              throw new DisplacedGroupHandleError('Fixture publication source is retired')
            },
          }
    const outbox = fixture.device.groups.ports(key).outbox
    const live = registryLiveSend.get(access)
    const capability = entryCapability(fixture.device.groups)
    if (live === undefined || capability === null)
      throw new Error('Missing registry instrumentation')
    let prepareGate: {
      entered: ReturnType<typeof Promise.withResolvers<void>>
      released: ReturnType<typeof Promise.withResolvers<void>>
    } | null = null
    counts.seals = 0
    counts.transactions = 0
    counts.publishes = 0
    counts.effects = 0
    const seal = live.prepareSeal.bind(live)
    vi.spyOn(live, 'prepareSeal').mockImplementation(async (...args) => {
      counts.seals++
      return await seal(...args)
    })
    const run = capability.run.bind(capability)
    capability.run = async (request, prepare, work) => {
      counts.transactions++
      const gate = prepareGate
      prepareGate = null
      if (gate !== null) {
        gate.entered.resolve()
        await gate.released.promise
      }
      return await run(request, prepare, async (stores, value) => {
        const incarnation = stores.incarnation.bind(stores)
        stores.incarnation = (number) => {
          const rows = incarnation(number)
          return {
            ...rows,
            outbox: {
              ...rows.outbox,
              put: async (entries) => {
                if (failAttempt) {
                  failAttempt = false
                  throw new Error('Injected attempt failure')
                }
                await rows.outbox.put(entries)
              },
            },
          }
        }
        return await work(stores, value)
      })
    }
    const result: AppPublicationFixture = {
      key,
      publication,
      outbox,
      async state() {
        const record = await fixture.device.groups.loadState(key)
        if (record === null || record.deleted || record.state === null)
          throw new Error('Missing state')
        const decoded = decodeClientState(record.state)
        if (decoded === undefined) throw new Error('Missing MLS state')
        return {
          snapshot: await publication.snapshot('chat'),
          senderHWM: record.senderHWM,
          storedGeneration: ownApplicationGeneration(decoded),
          stateBytes: record.state.slice(),
        }
      },
      async rows() {
        const rows = await fixture.inspectRows()
        return Object.entries(rows).flatMap(([namespace, records]) =>
          [...records].map(([key, value]) => ({ namespace, key, value: encodeStoredValue(value) })),
        )
      },
      gateNext(stage) {
        const entered = Promise.withResolvers<void>()
        const released = Promise.withResolvers<void>()
        // Suspend after source capture, before ownership, so genuine movement can win the queue.
        if (stage === 'prepare') {
          prepareGate = { entered, released }
          return { entered: entered.promise, release: () => released.resolve() }
        }
        const phase =
          stage === 'before-commit' ? 'finalise' : stage === 'after-commit' ? 'account' : stage
        let used = false
        fixture.onPhase(phase, async () => {
          if (used) return
          used = true
          entered.resolve()
          await released.promise
        })
        return { entered: entered.promise, release: () => released.resolve() }
      },
      failNext(stage, outcome) {
        if (stage === 'effect' && outcome === 'rollback') {
          failEffect = true
          return
        }
        if (stage === 'attempt' && outcome === 'rollback') {
          failAttempt = true
          return
        }
        if (stage === 'seal') {
          vi.spyOn(live, 'prepareSeal').mockRejectedValueOnce(new Error('Injected seal failure'))
          return
        }
        if (outcome === 'unknown-rollback') {
          const fault = fixture.armNextWorkFault('pending')
          void fault.rejected.then(() => fault.finish('rollback'))
        } else
          fixture.armNextWorkFault(
            outcome === 'unknown-commit' ? 'commit-then-reject' : 'after-first-write',
          )
      },
      async change(kind) {
        if (kind === 'epoch') {
          const next = await fixture.acceptedOrdinary(access)
          await access.replace(next.candidate, () => next.write)
        } else if (kind === 'incarnation') {
          const recovery = await fixture.confirmedRecovery(key, { confirm: true })
          await fixture.registry.switchIncarnation(recovery.candidate, {
            source: recovery.source,
            rejoinID: recovery.record.id,
            proof: recovery.proof,
            write: {
              mutationID:
                'format' in recovery.record
                  ? (recovery.record.switchMutationID ??
                    (() => {
                      throw new Error('Missing switch mutation')
                    })())
                  : crypto.randomUUID(),
              source: { rejoinID: recovery.record.id },
              destination: {
                control: {
                  cursor: {
                    position: recovery.proof.position,
                    epoch: Number(recovery.candidate.epoch),
                  },
                },
              },
            },
          })
        } else if (kind === 'anchor') {
          const next = await fixture.acceptedOrdinary(access)
          await access.replace(next.candidate, () => next.write)
          await fixture.device.groups.ports(key).anchor.save({
            anchor: {
              epoch: access.epoch(),
              secret: await access.read((handle) =>
                handle.exportSecret(APP_TOPIC_LABEL, new Uint8Array(), 32),
              ),
            },
          })
        } else if (kind === 'version') await access.mutate(async () => {})
        else {
          const entry = (await outbox.list())[0]
          if (entry?.lastAttempt == null) throw new Error('Missing attempt')
          await outbox.put({
            ...entry,
            lastAttempt: {
              ...entry.lastAttempt,
              publishID: crypto.randomUUID(),
              attempts: entry.lastAttempt.attempts + 1,
            },
          })
        }
      },
      counts: () => ({ ...counts }),
      reopen: async () => adapt(await fixture.reopen()),
      close: () => fixture.close(),
    }
    return result
  }
  return await adapt(fixture)
}
