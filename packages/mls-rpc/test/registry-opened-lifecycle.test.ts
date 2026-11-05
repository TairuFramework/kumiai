import { randomIdentity } from '@kokuin/token'
import { encodeEventFrame } from '@kumiai/broadcast'
import {
  APP_TOPIC_LABEL,
  asLogPosition,
  commitTopic,
  controlBatch,
  createOpenedAppHandler,
  digestAppliedCommit,
  encodeAppAAD,
  encodeCommitFrame,
  encodeHandshakeFrame,
  encodeLedgerReply,
  encodeLedgerRequest,
  encodeRecoveryConfirmRequest,
  encodeRecoveryReply,
  encodeRecoveryRequest,
  encodeRecoveryVerdict,
  frameID,
  type GroupPeerParams,
  type GroupProtocolDefinition,
  HANDSHAKE_KIND,
  OpenedDeliveryReentryError,
  openedDeliveryBinding,
  PeerRemovedError,
  protocolTopic,
  rendezvousTopic,
  runOpenedDelivery,
} from '@kumiai/rpc'
import { decode, encode, mlsMessageDecoder, mlsMessageEncoder, wireformats } from 'ts-mls'
import { describe, expect, test, vi } from 'vitest'

import type * as AppLaneModule from '../../rpc/lib/app-lane.js'
import type * as BufferedControlModule from '../../rpc/lib/buffered-control.js'
import type * as HostBoundaryModule from '../../rpc/lib/host-boundary.js'
import type * as HubMuxModule from '../../rpc/lib/hub-mux.js'
import {
  autoRotationRequest,
  buildKeyRotation as controlBuildRotation,
} from '../src/auto-rotation.js'
import * as checkpoint from '../src/checkpoint.js'
import * as controlBuild from '../src/control-build.js'
import * as entryCrypto from '../src/crypto.js'
import { entryCapability } from '../src/entry-capability.js'
import { createHandlerCompletion } from '../src/handler-completion.js'
import type { MemoryTransaction } from '../src/persistence-types.js'
import * as coldModule from '../src/registry/cold.js'
import * as liveSendModule from '../src/registry/live-send.js'
import { deleteIncarnations, retireIncarnation } from '../src/registry/retired.js'
import { registryRetirement } from '../src/registry/retirement.js'
import { registrySafety } from '../src/registry/safety.js'
import { createRegistryGroupMLS } from '../src/registry-group-mls.js'
import { retireToSuccessor } from '../src/successor.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { buildRealCommit, createRealGroup } from './fixtures/real-group.js'
import {
  createRegistryFixture,
  type PendingFault,
  registryFixtureObserveDecrypts,
  registryFixtureObserveRestoredControl,
  registryFixtureObserveStagedDecrypts,
} from './fixtures/registry.js'
import { startLeaseRotationPeer } from './fixtures/registry-lease-rotation.js'
import { registryHandle } from './fixtures/registry-welcome.js'
import { memoryModel } from './fixtures/sealed-memory-mls.js'
import { writeSideRow } from './fixtures/storage-persistence.js'

for (const mode of ['real-mls', 'double'] as const) {
  for (const supplied of [true, false]) {
    describe(`opened lifecycle (${mode}, ownership context ${supplied})`, () => {
      async function setup(coldDelivery = true) {
        const context = createAsyncLocalOwnershipContext()
        const groupID = crypto.randomUUID()
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const delivered: Array<string> = []
        const fixture = await createRegistryFixture({
          mode,
          groupID,
          setup: 'seeded',
          backgroundMaintenance: 'gated',
          openedDeliveryContext: context,
          ownershipContext: supplied ? createAsyncLocalOwnershipContext() : undefined,
          deliverOpened: !coldDelivery
            ? undefined
            : async (record) => {
                delivered.push(record.frame.id)
                entered.resolve()
                await release.promise
              },
        })
        const key = { groupID, incarnation: 1 }
        const capability = entryCapability(fixture.device.groups)
        if (capability === null) throw new Error('Missing capability')
        const record = (id: string) => ({
          frame: {
            ...key,
            id,
            protocol: 'chat',
            procedure: 'posted',
            topicID: 'old-topic',
            segment: 0,
            position: '2',
          },
          payload: encodeEventFrame('posted', { text: id }),
          senderDID: randomIdentity().id,
          epoch: 0,
          idempotencyKey: id,
        })
        const plant = async (id: string) =>
          capability.run(
            { groupID, mutationID: crypto.randomUUID() },
            async (reads) => ({ expected: await reads.lifetime(), value: null }),
            async (stores) => {
              await stores.incarnation(1).pending.put([record(id)])
            },
          )
        const pending = () => capability.read(groupID, (reads) => reads.pendingFrames(1))
        return { fixture, key, capability, context, entered, release, delivered, plant, pending }
      }

      test.each(['retirement', 'deletion', 'clearTransport'] as const)(
        'each erasure primitive independently refuses pending rows: %s',
        async (primitive) => {
          const env = await setup()
          try {
            await env.plant('retained')
            const before = await env.fixture.inspectRows()
            let clears = 0
            const work = () => {
              const mutationID = crypto.randomUUID()
              return env.capability.run(
                { groupID: env.key.groupID, mutationID },
                async (reads) => ({ expected: await reads.lifetime(), value: null }),
                async (stores) => {
                  const original = stores.incarnation
                  stores.incarnation = (incarnation) => {
                    const rows = original(incarnation)
                    return {
                      ...rows,
                      clearTransport: async () => {
                        clears++
                        await rows.clearTransport()
                      },
                    }
                  }
                  if (primitive === 'retirement') {
                    await retireIncarnation(stores, {
                      source: env.key,
                      nextIncarnation: null,
                      mutationID,
                      at: 12,
                    })
                    const lifetime = await stores.lifetime.load()
                    if (lifetime === null) throw new Error('Missing lifetime')
                    await stores.lifetime.save({
                      ...lifetime,
                      activeIncarnation: null,
                      revision: lifetime.revision + 1,
                      mutationID,
                    })
                  } else if (primitive === 'deletion')
                    await deleteIncarnations(stores, env.key, mutationID)
                  else await stores.incarnation(1).clearTransport()
                },
              )
            }
            const refusal = await work().then(
              () => null,
              (error: unknown) => error,
            )
            expect.soft(refusal).toMatchObject({
              name:
                primitive === 'clearTransport'
                  ? 'GroupStateConflictError'
                  : 'GroupControlUnsettledError',
              message:
                primitive === 'retirement'
                  ? 'Opened application records prevent retirement'
                  : primitive === 'deletion'
                    ? 'Opened application records prevent deletion'
                    : 'Pending application records prevent transport clearing',
            })
            if (primitive === 'deletion') expect.soft(clears).toBe(0)
            expect(await env.fixture.inspectRows()).toEqual(before)
            await env.capability.run(
              { groupID: env.key.groupID, mutationID: crypto.randomUUID() },
              async (reads) => ({ expected: await reads.lifetime(), value: null }),
              async (stores) => {
                await stores.incarnation(1).pending.complete(['retained'])
              },
            )
            await expect(work()).resolves.toBeUndefined()
          } finally {
            env.release.resolve()
            await env.fixture.close()
          }
        },
      )

      async function lifecycle(
        env: Awaited<ReturnType<typeof setup>>,
        kind: 'delete' | 'Welcome-readmission' | 'resync' | 'successor',
      ) {
        let begin: () => Promise<unknown>
        if (kind === 'delete') begin = () => env.fixture.registry.delete(env.key)
        else if (kind === 'Welcome-readmission') {
          const candidate = await env.fixture.makeHandle(2)
          begin = async () =>
            env.fixture.registry.seed(candidate, {
              replace: true,
              packageUse: await env.fixture.packageUse(),
            })
        } else if (kind === 'resync') {
          const recovery = await env.fixture.confirmedRecovery(env.key, {
            confirm: true,
            format: 'legacy',
          })
          begin = async () =>
            env.fixture.registry.switchIncarnation(recovery.candidate, {
              source: await env.fixture.registry.recoverySource(env.key.groupID),
              rejoinID: recovery.record.id,
              proof: recovery.proof,
              write: {
                mutationID: crypto.randomUUID(),
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
        } else {
          const successor = await env.fixture.registry.seed(
            await env.fixture.makeHandle(0, `${env.key.groupID}-successor`),
            { packageUse: null },
          )
          begin = () =>
            retireToSuccessor({
              registry: env.fixture.registry,
              persistence: env.fixture.device.groups,
              source: env.key,
              successor,
            })
        }
        return begin
      }

      test.each(['resync', 'delete', 'successor'] as const)(
        'transactional handoff commits once before retirement clears (%s)',
        async (kind) => {
          const env = await setup(false)
          const release = Promise.withResolvers<void>()
          const entered = Promise.withResolvers<void>()
          const faultReady = Promise.withResolvers<PendingFault>()
          const run = env.capability.run.bind(env.capability)
          const completion = createHandlerCompletion({
            persistence: env.fixture.device.groups,
            key: env.key,
          })
          const original = completion.transact.bind(completion)
          let arm = false
          const transact = vi.spyOn(completion, 'transact').mockImplementation((ids, handle) => {
            arm = true
            return original(ids, handle)
          })
          env.capability.run = (request, prepare, work, effects) => {
            if (arm && effects !== undefined && request.mutationID !== null) {
              arm = false
              faultReady.resolve(env.fixture.armWorkFault(request.mutationID, 'pending'))
            }
            return run(request, prepare, work, effects)
          }
          let running: Awaited<ReturnType<typeof startLeaseRotationPeer>> | undefined
          let work: Promise<unknown> | undefined
          let fault: PendingFault | undefined
          let calls = 0
          let commits = 0
          let settled = false
          try {
            running = await startLeaseRotationPeer({
              mode,
              fixture: env.fixture,
              key: env.key,
              outbox: env.fixture.device.groups.ports(env.key).outbox,
              handler: {
                mode: 'transactional',
                handle: async ({ tx }) => {
                  calls++
                  tx.onCommit(() => commits++)
                  await writeSideRow(tx, 'atomic', new Uint8Array([calls]))
                  entered.resolve()
                  await release.promise
                },
              },
            })
            await running.owner.ready
            const begin = await lifecycle(env, kind)
            await env.plant('atomic')
            const peer = running.owner.peer()
            if (peer === null) throw new Error('Missing peer')
            const liveDrain = peer.drainOpened()
            void liveDrain.catch(() => {})
            await entered.promise
            work = begin()
              .catch((error: unknown) => {
                if (!(error instanceof Error) || error.name !== 'RegistrySourceMovedError')
                  throw error
                return begin()
              })
              .then(() => {
                settled = true
              })
            void work.catch(() => {})
            release.resolve()
            fault = await faultReady.promise
            await fault.rejected
            expect(settled).toBe(false)
            expect(calls).toBe(1)
            expect(commits).toBe(0)
            expect((await env.fixture.inspectRows())['host-side']?.get('atomic') ?? null).toBeNull()
            expect((await env.fixture.inspectRows()).pending?.size).toBe(1)
            await fault.finish('commit')
            await work
            await liveDrain
            expect({ calls, commits }).toEqual({ calls: 1, commits: 1 })
            expect(transact).toHaveBeenCalledOnce()
            expect(env.delivered).toEqual([])
            expect(await env.pending()).toEqual([])
            running.owner.dispose()
            await running.owner.drained()
            env.capability.run = run
            const reopened = await env.fixture.reopen()
            try {
              expect((await reopened.inspectRows())['host-side']?.get('atomic') ?? null).toEqual(
                new Uint8Array([1]),
              )
            } finally {
              await reopened.close()
            }
          } finally {
            release.resolve()
            await fault?.finish('commit')
            await work?.catch(() => {})
            env.capability.run = run
            transact.mockRestore()
            running?.owner.dispose()
            await running?.owner.drained()
            await env.fixture.close()
          }
        },
      )

      test.each(
        (['at-least-once', 'transactional'] as const)
          .flatMap((policy) =>
            [true, false].map((restart) => ({ policy, restart, interruption: 'idle' })),
          )
          .concat(
            (['at-least-once', 'transactional'] as const).flatMap((policy) =>
              [
                'builder-continuation',
                'builder-safety-pending',
                'builder-source-pending',
                'builder-build-pending',
                'builder-candidate-pending',
                'crypto-access-pending',
                'receive-between-frames',
                'mls-creation-pending',
                'captured-restore-pending',
                'captured-registry-restore-pending',
              ].map((interruption) => ({ policy, restart: false, interruption })),
            ),
          )
          .concat(
            [
              'replay-only',
              'separate-route',
              'preparation-timer',
              'control-continuation',
              'startup-continuation',
              'ledger-request',
              'ledger-timer',
              'ledger-continuation',
              'ledger-seal-continuation',
              'inbound-and-timers',
              'fetch-pending',
              'fetch-failure',
              'fetch-backoff',
              'prepare-failure',
              'ahead',
            ].map((interruption) => ({
              policy: 'at-least-once' as const,
              restart: false,
              interruption,
            })),
          ),
      )(
        'terminal self-removal drains saved plaintext without crypto or network ($policy, restart $restart, $interruption)',
        async ({ policy, restart, interruption }) => {
          const separate = [
            'separate-route',
            'preparation-timer',
            'control-continuation',
            'builder-continuation',
            'builder-safety-pending',
            'builder-source-pending',
            'builder-build-pending',
            'builder-candidate-pending',
            'crypto-access-pending',
            'receive-between-frames',
            'mls-creation-pending',
            'captured-restore-pending',
            'captured-registry-restore-pending',
            'startup-continuation',
            'ledger-request',
            'ledger-timer',
            'ledger-continuation',
            'ledger-seal-continuation',
            'inbound-and-timers',
          ].includes(interruption)
          const interrupted = !['idle', 'replay-only'].includes(interruption) && !separate
          const context = createAsyncLocalOwnershipContext()
          const groupID = crypto.randomUUID()
          const group = await createRealGroup(1, groupID)
          const local = group.members[0]
          if (local === undefined) throw new Error('Missing receiver')
          const key = { groupID, incarnation: 1 }
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          let failing = true
          let calls = 0
          const dispatcher = vi.fn()
          const handle = async (event: { epoch: number; tx?: MemoryTransaction }) => {
            calls++
            dispatcher(event)
            entered.resolve()
            await release.promise
            if (event.tx === undefined)
              expect(await fixture.device.groups.loadState(key)).toMatchObject({ terminal: true })
            if (failing) throw new Error('Handler remains blocked')
            if (event.tx !== undefined)
              await writeSideRow(event.tx, 'terminal', new Uint8Array([1]))
          }
          let fixture: Awaited<ReturnType<typeof createRegistryFixture>>
          fixture = await createRegistryFixture({
            mode,
            groupID,
            identity: local.identity,
            setup: 'empty',
            backgroundMaintenance: 'gated',
            options: { resolveLedgerEntries: local.slot.resolve },
            ownershipContext: supplied ? createAsyncLocalOwnershipContext() : undefined,
            openedDeliveryContext: context,
            openedHandler: !restart
              ? undefined
              : (binding) => {
                  const handler = createOpenedAppHandler({
                    ...binding,
                    localDID: fixture.identity.id,
                    protocols: {
                      chat: { posted: { type: 'event', retain: 'log', data: { type: 'object' } } },
                    },
                    handlers: {
                      chat: {
                        posted: {
                          mode: policy,
                          handle,
                        },
                      },
                    },
                  })
                  return handler
                },
          })
          const completions = [0, 1].map(() => ({
            entered: Promise.withResolvers<void>(),
            release: Promise.withResolvers<void>(),
          }))
          let completionIndex = 0
          const holdCompletion = async () => {
            const completion = completions[completionIndex++]
            if (completion === undefined) throw new Error('Unexpected completion')
            completion.entered.resolve()
            await completion.release.promise
          }
          let running: Awaited<ReturnType<typeof startLeaseRotationPeer>> | undefined
          let restoreCompletion: (() => void) | undefined
          const releaseControl = Promise.withResolvers<void>()
          const startupEntered = Promise.withResolvers<void>()
          const releaseFetch = Promise.withResolvers<void>()
          const releaseLedger = Promise.withResolvers<void>()
          const builderEntered = Promise.withResolvers<void>()
          const releaseBuilder = Promise.withResolvers<void>()
          const builderFinished = Promise.withResolvers<void>()
          const builderSeal = vi.fn()
          const builderRestore = vi.fn()
          const builderHost = vi.fn()
          let builderKey: Uint8Array | undefined
          let builderError: unknown
          let queuedCrypto: Promise<unknown> | undefined
          const senderReads = vi.fn()
          const receiveDecrypt = vi.fn()
          const captureLive = vi.spyOn(liveSendModule, 'createLiveSend')
          const captureCold = vi.spyOn(coldModule, 'loadValidatedGroup')
          const rawSeal = vi.spyOn(entryCrypto, 'sealEntries')
          let sealing = false
          const createBuild = controlBuild.createControlBuildPort
          const captureBuild = vi
            .spyOn(controlBuild, 'createControlBuildPort')
            .mockImplementation((params) => {
              const pause = async () => {
                builderEntered.resolve()
                await releaseBuilder.promise
              }
              const read = params.access.readControl.bind(params.access)
              const restoreSource = params.restoreSource
              const build =
                (host: typeof params.build): typeof params.build =>
                async (...args) => {
                  builderHost()
                  const result = await host(...args)
                  if (interruption === 'builder-candidate-pending') await pause()
                  return result
                }
              return createBuild({
                ...params,
                access: {
                  ...params.access,
                  readControl: async (fn) => {
                    const result = await read(fn)
                    if (
                      typeof result === 'object' &&
                      result !== null &&
                      'key' in result &&
                      result.key instanceof Uint8Array
                    )
                      builderKey = result.key
                    if (
                      (interruption === 'builder-safety-pending' && sealing) ||
                      (interruption === 'builder-source-pending' &&
                        typeof result === 'object' &&
                        result !== null &&
                        'kind' in result &&
                        result.kind === 'captured')
                    )
                      await pause()
                    return result
                  },
                },
                build: build(params.build),
                rotate: build(params.rotate ?? controlBuildRotation),
                restoreCandidate: (...args) => {
                  builderRestore()
                  return params.restoreCandidate(...args)
                },
                restoreSource:
                  restoreSource === undefined
                    ? undefined
                    : async (...args) => {
                        builderRestore()
                        const result = await restoreSource(...args)
                        if (interruption === 'builder-build-pending') await pause()
                        return result
                      },
              })
            })
          let localMux: HubMuxModule.HubMux | undefined
          const inbound = new Map<string, Parameters<HubMuxModule.HubMux['onInbound']>[1]>()
          const muxModule = (await import(
            new URL('../../rpc/lib/hub-mux.js', import.meta.url).href
          )) as typeof HubMuxModule
          const createMux = muxModule.createHubMux
          const captureMux = vi.spyOn(muxModule, 'createHubMux').mockImplementation((params) => {
            localMux = createMux(params)
            const register = localMux.onInbound.bind(localMux)
            localMux.onInbound = (...args) => {
              inbound.set(args[0], args[1])
              return register(...args)
            }
            return localMux
          })
          let ledgerRequest: (() => Promise<unknown>) | undefined
          let removalReplay: Promise<unknown> | undefined
          let restoreNetwork: (() => void) | undefined
          let restoreTimers: (() => void) | undefined
          const retryTimers: Array<ReturnType<typeof setTimeout>> = []
          let cancelledRetries: (() => boolean) | undefined
          let offered: ReturnType<typeof vi.fn> | undefined
          const intakeModule = (await import(
            new URL('../../rpc/lib/buffered-control.js', import.meta.url).href
          )) as typeof BufferedControlModule
          let intake: BufferedControlModule.BufferedControlIntake | undefined
          const createIntake = intakeModule.createBufferedControlIntake
          const capture = vi
            .spyOn(intakeModule, 'createBufferedControlIntake')
            .mockImplementation((params) => {
              intake = createIntake(params)
              return intake
            })
          const hostModule = (await import(
            new URL('../../rpc/lib/host-boundary.js', import.meta.url).href
          )) as typeof HostBoundaryModule
          const wrapHost = hostModule.wrapPeerHost
          let peerParams: GroupPeerParams<Record<string, GroupProtocolDefinition>> | undefined
          const captureHost = vi
            .spyOn(hostModule, 'wrapPeerHost')
            .mockImplementation((boundary, input) => {
              let hostInput = input
              if (interruption.startsWith('builder-')) {
                const buildInput = input as GroupPeerParams<Record<string, GroupProtocolDefinition>>
                const prepare = buildInput.prepareBuild
                if (prepare === undefined) throw new Error('Missing builder')
                const heldBuild: typeof prepare = async (op, frame) => {
                  try {
                    return await prepare(op, async (built, seal) => {
                      if (interruption === 'builder-continuation') {
                        builderEntered.resolve()
                        await releaseBuilder.promise
                      }
                      return frame(built, async (...args) => {
                        builderSeal()
                        sealing = true
                        try {
                          return await seal(...args)
                        } finally {
                          sealing = false
                        }
                      })
                    })
                  } catch (error) {
                    builderError = error
                    throw error
                  } finally {
                    builderFinished.resolve()
                  }
                }
                hostInput = {
                  ...buildInput,
                  prepareBuild: heldBuild,
                }
              }
              const params = wrapHost(boundary, hostInput)
              peerParams = params as typeof peerParams
              if (
                interruption === 'startup-continuation' &&
                peerParams?.anchorStore !== undefined
              ) {
                const store = peerParams.anchorStore
                vi.spyOn(store, 'load').mockResolvedValueOnce(null)
                vi.spyOn(store, 'save').mockImplementationOnce(async () => {
                  startupEntered.resolve()
                  throw new Error('Retry anchor save')
                })
              }
              return params
            })
          const laneModule = (await import(
            new URL('../../rpc/lib/app-lane.js', import.meta.url).href
          )) as typeof AppLaneModule
          let lane: Pick<AppLaneModule.AppLaneParams, 'crypto' | 'batch'> | undefined
          const createLane = laneModule.createAppLane
          const captureLane = vi.spyOn(laneModule, 'createAppLane').mockImplementation((params) => {
            lane = params
            return createLane(params)
          })
          const stop = new AbortController()
          let work: Promise<void> | undefined
          try {
            const options = fixture.environment.options ?? {}
            await fixture.registry.seed(
              await registryHandle({ mode, handle: local.handle, options }),
              {
                packageUse: await fixture.packageUse(),
              },
            )
            const sender = await registryHandle({
              mode,
              handle: group.committer.handle,
              options: {
                ...options,
                resolveLedgerEntries: group.committer.slot.resolve,
              },
            })
            if (!restart && interruption !== 'startup-continuation') {
              running = await startLeaseRotationPeer({
                mode,
                fixture,
                key,
                outbox: fixture.device.groups.ports(key).outbox,
                openedDeliveryContext: context,
                handler: { mode: policy, handle },
                freezeHub: interruption === 'inbound-and-timers',
                recovery: { getDelayMs: () => 20 },
              })
              await running.owner.ready
              await running.owner.peer()?.replay()
              if (intake === undefined) throw new Error('Missing control intake')
              offered = vi.spyOn(intake, 'offer')
            }
            capture.mockRestore()
            const openedAccess = await fixture.registry.access(groupID)
            const expectedAAD = encodeAppAAD({ topicID: 'chat', intent: 'log' })
            const inputs = []
            for (const position of ['2', '3']) {
              const ciphertext = await sender.encrypt(
                encodeEventFrame('posted', { text: `terminal-${position}` }),
                { aad: expectedAAD },
              )
              inputs.push({
                frame: {
                  ...key,
                  id: frameID('chat', ciphertext),
                  protocol: 'chat',
                  topicID: 'chat',
                  segment: openedAccess.epoch(),
                  position,
                },
                ciphertext,
                expectedAAD,
              })
            }
            expect(await openedAccess.openBatch(inputs)).toMatchObject([
              { kind: 'opened' },
              { kind: 'opened' },
            ])
            const pending = await openedAccess.pending.list()
            const savedPending = pending[0]
            if (savedPending === undefined) throw new Error('Missing opened record')
            const newCiphertext = await sender.encrypt(
              encodeEventFrame('posted', { text: 'must-not-open' }),
              { aad: expectedAAD },
            )
            const mls = await createRegistryGroupMLS({
              registry: fixture.registry,
              key,
              recovery: fixture.environment,
              identity: fixture.identity,
              entrySlot: local.slot,
              target: { targetID: 'terminal-hub', topicID: 'terminal-commits' },
            })
            const route = controlBatch(mls)
            if (route === undefined) throw new Error('Missing control route')
            const commit =
              mode === 'real-mls'
                ? await buildRealCommit(group, { removes: 0 })
                : memoryModel(sender).buildCommit([], { removes: [local.identity.id] })
            const recoverySecret = await mls.exportRecoverySecret()
            const topicID = commitTopic(recoverySecret)
            const rendezvous = rendezvousTopic(recoverySecret)
            const liveAnchor = await peerParams?.crypto.exportSecret(APP_TOPIC_LABEL)
            const appCiphertext =
              liveAnchor === undefined
                ? undefined
                : await sender.encrypt(encodeEventFrame('posted', { text: 'must-not-open-live' }), {
                    aad: encodeAppAAD({
                      topicID: protocolTopic(liveAnchor.secret, liveAnchor.epoch, 'chat'),
                      intent: 'log',
                    }),
                  })
            const deliver = (topic: string, payload: Uint8Array) => {
              const listener = inbound.get(topic)
              if (listener === undefined) throw new Error('Missing inbound listener')
              const ack = vi.fn()
              listener(
                {
                  topicID: topic,
                  senderDID: group.committer.identity.id,
                  sequenceID: '000000000001',
                  payload,
                },
                ack,
              )
              expect(ack).toHaveBeenCalledOnce()
            }
            const remotePublish = running?.hub.publish.bind(running.hub)
            const wake = async () => {
              if (interruption === 'replay-only') return
              await remotePublish?.({
                topicID,
                senderDID: group.committer.identity.id,
                payload: new Uint8Array([255]),
                retain: 'log',
              })
            }
            const position = asLogPosition('0001')
            if (interruption === 'startup-continuation') {
              vi.useFakeTimers()
              running = await startLeaseRotationPeer({
                mode,
                fixture,
                key,
                outbox: fixture.device.groups.ports(key).outbox,
                openedDeliveryContext: context,
                handler: { mode: policy, handle },
                recovery: { getDelayMs: () => 20 },
              })
              await startupEntered.promise
              for (let turn = 0; turn < 100; turn++) await Promise.resolve()
              expect(vi.getTimerCount()).toBeGreaterThan(0)
            }
            ledgerRequest = async () =>
              remotePublish?.({
                topicID: rendezvous,
                senderDID: group.committer.identity.id,
                payload: encodeHandshakeFrame(
                  HANDSHAKE_KIND.ledgerRequest,
                  encodeLedgerRequest('terminal-ledger', new Uint8Array([1])),
                ),
              })
            if (running !== undefined && separate) {
              if (!vi.isFakeTimers()) vi.useFakeTimers()
              if (
                interruption === 'captured-restore-pending' ||
                interruption === 'captured-registry-restore-pending'
              ) {
                const supplied =
                  interruption === 'captured-registry-restore-pending'
                    ? captureCold.mock.calls.find(([, groupID]) => groupID === key.groupID)?.[3]
                        .restore
                    : captureLive.mock.calls.find(
                        ([params]) =>
                          params.owner.key.groupID === key.groupID &&
                          params.owner.key.incarnation === key.incarnation,
                      )?.[0].environment.restore
                const record = await fixture.device.groups.loadState(key)
                if (
                  supplied === undefined ||
                  record === null ||
                  record.deleted ||
                  record.state === null
                )
                  throw new Error('Missing supplied restorer')
                const source = { ...record, state: record.state }
                queuedCrypto = releaseBuilder.promise
                  .then(() => supplied(source))
                  .catch((error: unknown) => error)
              }
              if (interruption === 'mls-creation-pending') {
                const access = fixture.registry.access.bind(fixture.registry)
                vi.spyOn(fixture.registry, 'access').mockImplementationOnce(async (...args) => {
                  builderEntered.resolve()
                  await releaseBuilder.promise
                  return access(...args)
                })
                queuedCrypto = createRegistryGroupMLS({
                  registry: fixture.registry,
                  key,
                  recovery: fixture.environment,
                  identity: fixture.identity,
                  entrySlot: local.slot,
                  target: { targetID: 'terminal-hub', topicID: 'terminal-commits' },
                })
                  .then((port) => port.readEpoch())
                  .catch((error: unknown) => error)
                expect(
                  await Promise.race([
                    builderEntered.promise.then(() => true),
                    queuedCrypto.then(() => false),
                  ]),
                ).toBe(true)
              }
              if (interruption === 'receive-between-frames') {
                registryFixtureObserveRestoredControl(fixture, (handle) => {
                  const read = handle.readSenderData.bind(handle)
                  const decrypt = handle.decrypt.bind(handle)
                  handle.readSenderData = (...args) => {
                    senderReads()
                    return read(...args)
                  }
                  handle.decrypt = async (...args) => {
                    receiveDecrypt()
                    const result = await decrypt(...args)
                    builderEntered.resolve()
                    await releaseBuilder.promise
                    return result
                  }
                })
                const frames = await Promise.all(
                  [1, 2].map(async (value) => ({
                    ciphertext: await sender.encrypt(new Uint8Array([value]), {
                      aad: new Uint8Array(),
                    }),
                    expectedAAD: new Uint8Array(),
                  })),
                )
                queuedCrypto = openedAccess.receive(frames).catch((error: unknown) => error)
                expect(
                  await Promise.race([
                    builderEntered.promise.then(() => true),
                    queuedCrypto.then(() => false),
                  ]),
                ).toBe(true)
              }
              if (interruption === 'crypto-access-pending') {
                const read = openedAccess.read.bind(openedAccess)
                vi.spyOn(openedAccess, 'read').mockImplementationOnce(async (fn) => {
                  builderEntered.resolve()
                  await releaseBuilder.promise
                  return read(fn)
                })
                if (peerParams === undefined) throw new Error('Missing peer crypto')
                const peerCrypto = peerParams.crypto
                queuedCrypto = Promise.resolve()
                  .then(() => peerCrypto.sealEntries(new Uint8Array([1])))
                  .catch((error: unknown) => error)
                await builderEntered.promise
              }
              if (interruption.startsWith('builder-')) {
                const identity = (await fixture.device.groups.readEvidence(key)).source.identity
                if (identity === null) throw new Error('Missing build source')
                await fixture.device.groups.ports(key).control.apply(
                  {
                    putOperations: [
                      {
                        ...autoRotationRequest(identity),
                        stage: 'intent',
                        seq: 1,
                        enqueuedAt: Date.now(),
                        deadline: Date.now() + 30_000,
                      },
                    ],
                  },
                  crypto.randomUUID(),
                )
                await running.owner.peer()?.replay()
                await vi.advanceTimersByTimeAsync(0)
                await builderEntered.promise
              }
              if (interruption === 'control-continuation') {
                const binding = controlBatch(running.mls())
                if (binding === undefined) throw new Error('Missing control binding')
                const run = binding.run.bind(binding)
                const queued = Promise.withResolvers<void>()
                vi.spyOn(binding, 'run').mockImplementation(async (work) => {
                  queued.resolve()
                  await releaseControl.promise
                  return await run(work)
                })
                await remotePublish?.({
                  topicID,
                  senderDID: group.committer.identity.id,
                  payload: new Uint8Array([255]),
                  retain: 'log',
                })
                removalReplay = running.owner.peer()?.replay()
                await queued.promise
              }
              if (interruption === 'preparation-timer') {
                if (intake === undefined) throw new Error('Missing intake')
                const binding = controlBatch(running.mls())
                if (binding === undefined) throw new Error('Missing control binding')
                vi.spyOn(binding, 'run').mockRejectedValueOnce(new Error('Retry preparation'))
                await remotePublish?.({
                  topicID,
                  senderDID: group.committer.identity.id,
                  payload: new Uint8Array([255]),
                  retain: 'log',
                })
                await running.owner.peer()?.replay()
                expect(vi.getTimerCount()).toBeGreaterThan(0)
              }
              if (
                interruption === 'ledger-timer' ||
                interruption === 'ledger-continuation' ||
                interruption === 'ledger-seal-continuation'
              ) {
                if (
                  interruption === 'ledger-continuation' ||
                  interruption === 'ledger-seal-continuation'
                ) {
                  const checked = Promise.withResolvers<void>()
                  const liveMLS = peerParams?.mls
                  if (liveMLS === undefined) throw new Error('Missing live MLS')
                  if (interruption === 'ledger-seal-continuation') {
                    vi.spyOn(liveMLS, 'isLedgerComplete').mockResolvedValueOnce(true)
                    vi.spyOn(liveMLS, 'sealLedger').mockImplementationOnce(async () => {
                      checked.resolve()
                      await releaseLedger.promise
                      return new Uint8Array([1])
                    })
                  } else
                    vi.spyOn(liveMLS, 'isLedgerComplete').mockImplementationOnce(async () => {
                      checked.resolve()
                      await releaseLedger.promise
                      return true
                    })
                  await ledgerRequest()
                  await vi.advanceTimersByTimeAsync(300)
                  expect(liveMLS.isLedgerComplete).toHaveBeenCalled()
                  if (interruption === 'ledger-seal-continuation')
                    expect(liveMLS.sealLedger).toHaveBeenCalled()
                  await checked.promise
                } else {
                  await ledgerRequest()
                  for (let turn = 0; turn < 100; turn++) await Promise.resolve()
                }
              }
            }
            if (running !== undefined && !separate) {
              if (interrupted) vi.useFakeTimers()
              if (interrupted) {
                const schedule = globalThis.setTimeout
                const clear = globalThis.clearTimeout
                const cleared: Array<unknown> = []
                // Later restoreAllMocks must not reinstall this fake clock.
                globalThis.setTimeout = new Proxy(schedule, {
                  apply(target, receiver: unknown, args: Array<unknown>) {
                    const handle = Reflect.apply(target, receiver, args) as ReturnType<
                      typeof setTimeout
                    >
                    const delay = args[1]
                    if (typeof delay === 'number' && delay >= 1000 && delay <= 60_000)
                      retryTimers.push(handle)
                    return handle
                  },
                })
                globalThis.clearTimeout = new Proxy(clear, {
                  apply(target, receiver: unknown, args: Array<unknown>) {
                    cleared.push(args[0])
                    return Reflect.apply(target, receiver, args)
                  },
                })
                cancelledRetries = () => retryTimers.every((timer) => cleared.includes(timer))
                restoreTimers = () => {
                  globalThis.setTimeout = schedule
                  globalThis.clearTimeout = clear
                }
              }
              if (interruption === 'ahead') {
                let ahead: Uint8Array
                if (mode === 'double') {
                  const parsed: unknown = JSON.parse(new TextDecoder().decode(commit))
                  if (parsed === null || typeof parsed !== 'object')
                    throw new Error('Missing model commit')
                  ahead = new TextEncoder().encode(JSON.stringify({ ...parsed, epoch: 99 }))
                } else {
                  const parsed = decode(mlsMessageDecoder, commit)
                  if (parsed?.wireformat !== wireformats.mls_private_message)
                    throw new Error('Missing private commit')
                  parsed.privateMessage.epoch += 3n
                  ahead = encode(mlsMessageEncoder, parsed)
                }
                await remotePublish?.({
                  topicID,
                  senderDID: group.committer.identity.id,
                  payload: encodeHandshakeFrame(
                    HANDSHAKE_KIND.commit,
                    encodeCommitFrame(ahead, new Uint8Array()),
                  ),
                  retain: 'log',
                })
                await running.owner.peer()?.replay()
                expect(
                  (await fixture.device.groups.ports(key).control.load()).cursor?.incomplete,
                ).toBe(true)
                expect(vi.getTimerCount()).toBeGreaterThan(0)
                const fetch = running.hub.fetchTopic.bind(running.hub)
                const network = vi
                  .spyOn(running.hub, 'fetchTopic')
                  .mockImplementation(async (request) => ({
                    ...(await fetch(request)),
                    gap: request.topicID === topicID,
                  }))
                restoreNetwork = () => network.mockRestore()
              } else if (interruption === 'prepare-failure') {
                if (intake === undefined) throw new Error('Missing control intake')
                vi.spyOn(intake, 'consumed').mockImplementationOnce(() => {
                  throw new Error('Late control notification failed')
                })
              } else if (interrupted) {
                const binding = controlBatch(running.mls())
                if (binding === undefined) throw new Error('Missing live control binding')
                const run = binding.run.bind(binding)
                binding.run = async (input) => {
                  await releaseControl.promise
                  return await run(input)
                }
                const fetch = running.hub.fetchTopic.bind(running.hub)
                const network = vi.spyOn(running.hub, 'fetchTopic')
                restoreNetwork = () => network.mockRestore()
                let first = true
                const fetching = Promise.withResolvers<void>()
                network.mockImplementation(async (request) => {
                  if (request.topicID !== topicID) return await fetch(request)
                  if (first) {
                    first = false
                    const page = await fetch(request)
                    const removal = page.messages[0]
                    if (removal === undefined) throw new Error('Missing removal frame')
                    return {
                      ...page,
                      messages: [
                        removal,
                        ...Array.from({ length: 99 }, (_, index) => ({
                          ...removal,
                          sequenceID: String(Number(removal.sequenceID) + index + 1).padStart(
                            12,
                            '0',
                          ),
                          payload: new Uint8Array([255]),
                        })),
                      ],
                      head: '000000000200',
                    }
                  }
                  fetching.resolve()
                  if (interruption !== 'fetch-backoff') await releaseFetch.promise
                  if (interruption !== 'fetch-pending') throw new Error('Interrupted control fetch')
                  return {
                    messages: [
                      {
                        topicID,
                        senderDID: group.committer.identity.id,
                        sequenceID: '000000000101',
                        payload: new Uint8Array([255]),
                      },
                    ],
                    head: '000000000101',
                    oldest: '000000000001',
                    gap: false,
                  }
                })
                removalReplay = fetching.promise
              }
              await remotePublish?.({
                topicID,
                senderDID: group.committer.identity.id,
                payload: encodeHandshakeFrame(
                  HANDSHAKE_KIND.commit,
                  encodeCommitFrame(commit, new Uint8Array()),
                ),
                retain: 'log',
              })
              if (removalReplay !== undefined) {
                await removalReplay
                // Let the failed fetch arm its retry before the removal entry commits.
                for (let turn = 0; turn < 100; turn++) await Promise.resolve()
                if (interruption === 'fetch-backoff') expect(vi.getTimerCount()).toBeGreaterThan(0)
                releaseControl.resolve()
              } else await running.owner.peer()?.replay()
              await vi.waitFor(async () => {
                expect(await fixture.device.groups.loadState(key)).toMatchObject({ terminal: true })
              })
              offered?.mockClear()
              releaseFetch.resolve()
              for (let turn = 0; turn < 200; turn++) await Promise.resolve()
              if (interruption === 'ahead')
                expect(
                  (await fixture.device.groups.ports(key).control.load()).cursor?.incomplete,
                ).toBe(true)
              if (interruption === 'ahead' || interruption === 'fetch-backoff')
                expect(retryTimers.length).toBeGreaterThan(0)
              expect(cancelledRetries?.() ?? true).toBe(true)
              restoreTimers?.()
              restoreTimers = undefined
              expect(offered).not.toHaveBeenCalled()
              restoreNetwork?.()
            } else {
              const operations = (await fixture.device.groups.ports(key).control.load()).operations
              const result = await route.run({
                source: 'terminal-removal',
                prepare: async (scope) => {
                  const epoch = await scope.readEpoch()
                  return scope.prepareCommit(commit, {
                    adoption: (staged) => ({
                      mutationID: crypto.randomUUID(),
                      changes: {
                        commitOnce: null,
                        deleteOperations: operations.map((op) => op.id),
                        putOutcomes: operations.map((op) => ({
                          id: op.id,
                          opID: op.id,
                          at: Date.now(),
                          kind: 'unknown',
                        })),
                        cursor: { position, epoch: staged.epochAfter },
                        putApplied: [
                          {
                            epoch,
                            digest: digestAppliedCommit(commit),
                            payloadDigest: 'terminal-removal',
                            sequenceID: position,
                            opID: null,
                            removed: staged.removed,
                          },
                        ],
                      },
                    }),
                  })
                },
              })
              expect(result.value).toMatchObject({ applied: true })
            }
            const fetch = running === undefined ? vi.fn() : vi.spyOn(running.hub, 'fetchTopic')
            const publish = running === undefined ? vi.fn() : vi.spyOn(running.hub, 'publish')
            rawSeal.mockClear()
            builderRestore.mockClear()
            builderHost.mockClear()
            senderReads.mockClear()
            receiveDecrypt.mockClear()
            expect(await fixture.device.groups.loadState(key)).toMatchObject({ terminal: true })
            expect(await openedAccess.pending.list()).toEqual(pending)
            expect(calls).toBe(0)
            const decrypt = vi.fn()
            registryFixtureObserveDecrypts(fixture, decrypt)
            registryFixtureObserveStagedDecrypts(fixture, decrypt)
            const refused = await openedAccess
              .openBatch([
                {
                  frame: {
                    ...savedPending.frame,
                    id: frameID('chat', newCiphertext),
                    position: '4',
                  },
                  ciphertext: newCiphertext,
                  expectedAAD,
                },
              ])
              .then(
                () => null,
                (error: unknown) => error,
              )
            expect(decrypt).not.toHaveBeenCalled()
            expect(refused).toMatchObject({ name: 'GroupUnavailableError' })
            expect(await openedAccess.pending.list()).toEqual(pending)
            const open = vi.spyOn(openedAccess, 'openBatch')
            if (restart) fixture = await fixture.reopen()
            const capability = entryCapability(fixture.device.groups)
            if (capability === null) throw new Error('Missing entry capability')
            capability.failureSignal = AbortSignal.any([
              stop.signal,
              ...(capability.failureSignal === undefined ? [] : [capability.failureSignal]),
            ])
            const completion = createHandlerCompletion({ persistence: fixture.device.groups, key })
            if (policy === 'at-least-once') {
              const complete = completion.complete.bind(completion)
              const spy = vi.spyOn(completion, 'complete').mockImplementation(async (ids) => {
                await complete(ids)
                await holdCompletion()
              })
              restoreCompletion = () => spy.mockRestore()
            } else {
              const transact = completion.transact.bind(completion)
              const spy = vi
                .spyOn(completion, 'transact')
                .mockImplementation(async (ids, handle) => {
                  await transact(ids, handle)
                  await holdCompletion()
                })
              restoreCompletion = () => spy.mockRestore()
            }
            const restores = fixture.restores()
            const access = vi.spyOn(fixture.registry, 'access').mockClear()
            const receive = vi.fn()
            fixture.overrideRestore(async () => {
              receive()
              throw new PeerRemovedError('Terminal drain attempted crypto')
            })
            const blocks: Array<unknown> = []
            const safety = registrySafety(fixture.registry)
            if (safety === null) throw new Error('Missing safety port')
            const unsubscribe = safety.onSwitchBlocked(key, (block) => blocks.push(block))
            if (running !== undefined) {
              if (interruption === 'startup-continuation') {
                releaseControl.resolve()
                await vi.advanceTimersByTimeAsync(100)
                await expect(running.owner.ready).resolves.toBeUndefined()
              }
              const selection = intake === undefined ? undefined : vi.spyOn(intake, 'next')
              if (interruption === 'ledger-request' || interruption === 'inbound-and-timers') {
                const schedule = globalThis.setTimeout
                let responders = 0
                globalThis.setTimeout = new Proxy(schedule, {
                  apply(target, receiver: unknown, args: Array<unknown>) {
                    if (args[1] === 20) responders++
                    return Reflect.apply(target, receiver, args)
                  },
                })
                try {
                  deliver(
                    rendezvous,
                    encodeHandshakeFrame(
                      HANDSHAKE_KIND.ledgerRequest,
                      encodeLedgerRequest('terminal-ledger', new Uint8Array([1])),
                    ),
                  )
                  for (let turn = 0; turn < 100; turn++) await Promise.resolve()
                  expect(responders).toBe(0)
                } finally {
                  globalThis.setTimeout = schedule
                }
              }
              if (peerParams?.mls === undefined || localMux === undefined)
                throw new Error('Missing peer boundaries')
              const ledgerCheck = vi.spyOn(peerParams.mls, 'isLedgerComplete')
              const ledgerSeal = vi.spyOn(peerParams.mls, 'sealLedger')
              const localPublish = vi.spyOn(localMux, 'publish')
              ledgerCheck.mockClear()
              ledgerSeal.mockClear()
              releaseLedger.resolve()
              if (
                [
                  'crypto-access-pending',
                  'receive-between-frames',
                  'mls-creation-pending',
                  'captured-restore-pending',
                  'captured-registry-restore-pending',
                ].includes(interruption)
              ) {
                releaseBuilder.resolve()
                const result = await queuedCrypto
                expect(senderReads).not.toHaveBeenCalled()
                expect(receiveDecrypt).not.toHaveBeenCalled()
                expect(fixture.restores()).toBe(restores)
                expect(rawSeal).not.toHaveBeenCalled()
                expect(result).toMatchObject(
                  interruption !== 'receive-between-frames'
                    ? { name: 'PeerRemovedError' }
                    : [
                        { kind: 'opened' },
                        { kind: 'refused', error: { name: 'GroupUnavailableError' } },
                      ],
                )
              }
              if (interruption.startsWith('builder-')) {
                releaseBuilder.resolve()
                await builderFinished.promise
                if (interruption === 'builder-continuation')
                  expect(builderSeal).not.toHaveBeenCalled()
                expect(rawSeal).not.toHaveBeenCalled()
                expect(builderHost).not.toHaveBeenCalled()
                expect(builderRestore).not.toHaveBeenCalled()
                expect(builderError).toMatchObject({ name: 'PeerRemovedError' })
                expect(builderKey).toEqual(new Uint8Array(32))
              }
              if (interruption === 'control-continuation') {
                releaseControl.resolve()
                await expect(removalReplay).resolves.toEqual({})
              }
              if (interruption === 'inbound-and-timers') {
                if (peerParams === undefined) throw new Error('Missing peer ports')
                const refusals: Array<{ name: string; error: unknown }> = []
                const refuse = async (port: object, name: string, args: Array<unknown> = []) => {
                  const result = await Promise.resolve()
                    .then(() => Reflect.apply(Reflect.get(port, name), port, args))
                    .then(
                      () => null,
                      (error: unknown) => error,
                    )
                  refusals.push({ name, error: result })
                }
                for (const [port, allowed] of [
                  [peerParams.crypto, ['epoch', 'frameEpoch', 'frameAAD']],
                  [
                    peerParams.mls,
                    ['sendAdmission', 'isLedgerComplete', 'onSafetyHold', 'onSafetyChanged'],
                  ],
                  [peerParams.mls?.capturedRecovery, []],
                  [peerParams.validation, []],
                ] as const) {
                  if (port === undefined) continue
                  for (const name of Object.keys(port))
                    if (
                      typeof Reflect.get(port, name) === 'function' &&
                      !(allowed as ReadonlyArray<string>).includes(name)
                    )
                      await refuse(port, name)
                }
                if (lane?.batch === undefined) throw new Error('Missing app batch')
                await refuse(lane.batch, 'openReady')
                await refuse(peerParams, 'prepareBuild')
                await refuse(peerParams, 'adopt')
                if (peerParams.appPublication !== undefined)
                  await refuse(peerParams.appPublication, 'prepare')
                await refuse(peerParams.hub, 'fetchTopic', [
                  { subscriberDID: local.identity.id, topicID },
                ])
                await refuse(peerParams.hub, 'publish', [
                  { senderDID: local.identity.id, topicID, payload: new Uint8Array([1]) },
                ])
                expect(refusals).toEqual(
                  refusals.map(({ name }: { name: string }) => ({
                    name,
                    error: expect.objectContaining({ name: 'PeerRemovedError' }),
                  })),
                )
                await expect(peerParams.mls?.isLedgerComplete()).resolves.toBe(false)
                for (const payload of [
                  encodeHandshakeFrame(
                    HANDSHAKE_KIND.recoveryConfirmRequest,
                    encodeRecoveryConfirmRequest({
                      requestID: 'terminal-confirm',
                      request: new Uint8Array([1]),
                      position,
                      commitDigest: digestAppliedCommit(commit),
                      commit,
                      signature: new Uint8Array([1]),
                    }),
                  ),
                  encodeHandshakeFrame(
                    HANDSHAKE_KIND.recoveryVerdict,
                    encodeRecoveryVerdict('terminal-confirm', new Uint8Array([1])),
                  ),
                  encodeHandshakeFrame(
                    HANDSHAKE_KIND.recoveryRequest,
                    encodeRecoveryRequest('terminal-recovery', new Uint8Array([1])),
                  ),
                  encodeHandshakeFrame(
                    HANDSHAKE_KIND.ledgerReply,
                    encodeLedgerReply('terminal-ledger', new Uint8Array([1])),
                  ),
                  encodeHandshakeFrame(
                    HANDSHAKE_KIND.recoveryReply,
                    encodeRecoveryReply('terminal-recovery', new Uint8Array([1])),
                  ),
                ])
                  deliver(rendezvous, payload)
                deliver(
                  topicID,
                  encodeHandshakeFrame(
                    HANDSHAKE_KIND.commit,
                    encodeCommitFrame(commit, new Uint8Array()),
                  ),
                )
                const peer = running.owner.peer()
                if (peer == null || liveAnchor === undefined || appCiphertext === undefined)
                  throw new Error('Missing live peer')
                await remotePublish?.({
                  topicID: protocolTopic(liveAnchor.secret, liveAnchor.epoch, 'chat'),
                  senderDID: group.committer.identity.id,
                  payload: appCiphertext,
                  retain: 'log',
                })
                await expect(peer.resync()).rejects.toMatchObject({ name: 'PeerRemovedError' })
                await expect(peer.recover()).rejects.toMatchObject({ name: 'PeerRemovedError' })
                await expect(
                  peer.enqueue({
                    id: 'terminal-operation',
                    kind: 'rotation',
                    revokes: false,
                    body: new Uint8Array(),
                  }),
                ).rejects.toMatchObject({ name: 'PeerRemovedError' })
                const chat = peer.protocol('chat')
                await expect(chat.to(group.committer.identity.id)).rejects.toMatchObject({
                  name: 'PeerRemovedError',
                })
                await refuse(chat, 'request', ['posted'])
                await refuse(chat, 'gather', ['posted'])
                expect(refusals.slice(-2)).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({
                      name: 'request',
                      error: expect.objectContaining({ name: 'PeerRemovedError' }),
                    }),
                    expect.objectContaining({
                      name: 'gather',
                      error: expect.objectContaining({ name: 'PeerRemovedError' }),
                    }),
                  ]),
                )
                await peer.retryAppDelivery()
                peer.reauthorize()
              }
              if (separate) await expect(vi.advanceTimersByTimeAsync(2000)).resolves.toBeDefined()
              if (selection !== undefined) expect(selection).not.toHaveBeenCalled()
              if (interruption.startsWith('ledger-')) {
                expect(ledgerCheck).not.toHaveBeenCalled()
                expect(ledgerSeal).not.toHaveBeenCalled()
                expect(localPublish).not.toHaveBeenCalled()
              }
              ledgerCheck.mockRestore()
              ledgerSeal.mockRestore()
              localPublish.mockRestore()
              expect(receive).not.toHaveBeenCalled()
              expect(fetch).not.toHaveBeenCalled()
              expect(publish).not.toHaveBeenCalled()
              const read = vi.spyOn(capability, 'read')
              await expect(running.owner.peer()?.replay()).resolves.toEqual({})
              if (interruption !== 'startup-continuation') expect(read).not.toHaveBeenCalled()
              expect(fetch).not.toHaveBeenCalled()
              read.mockRestore()
              await wake()
              expect(fetch).not.toHaveBeenCalled()
            }
            if (interruption === 'startup-continuation') {
              await vi.advanceTimersByTimeAsync(0)
              for (let turn = 0; turn < 100; turn++) await Promise.resolve()
              expect(calls).toBeGreaterThan(0)
            }
            let settled = false
            work = fixture.registry.delete(key).then(() => {
              settled = true
            })
            void work.catch(() => {})
            await Promise.race([entered.promise, work])
            expect(settled).toBe(false)
            if (!vi.isFakeTimers()) vi.useFakeTimers()
            await running?.owner.peer()?.replay()
            await wake()
            await vi.advanceTimersByTimeAsync(1000)
            expect(fetch).not.toHaveBeenCalled()
            expect(decrypt).not.toHaveBeenCalled()
            expect(publish).not.toHaveBeenCalled()
            release.resolve()
            await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2))
            await running?.owner.peer()?.replay()
            await wake()
            running?.owner.peer()?.retryAppDelivery()
            await vi.advanceTimersByTimeAsync(60_000)
            expect(settled).toBe(false)
            expect((await fixture.inspectRows()).pending?.size).toBe(2)
            expect(await fixture.device.groups.loadState(key)).toMatchObject({ terminal: true })
            expect(blocks).toContainEqual({ key, reason: 'opened-records', pending: 2 })
            expect((await fixture.inspectRows())['host-side']?.get('terminal') ?? null).toBeNull()
            expect(open).not.toHaveBeenCalled()
            expect(receive).not.toHaveBeenCalled()
            expect(access).not.toHaveBeenCalled()
            expect(fetch).not.toHaveBeenCalled()
            expect(publish).not.toHaveBeenCalled()
            expect(fixture.restores()).toBe(restores)
            failing = false
            await vi.advanceTimersByTimeAsync(15_000)
            for (const [index, completion] of completions.entries()) {
              await Promise.race([completion.entered.promise, work])
              await vi.advanceTimersByTimeAsync(200)
              expect(settled).toBe(false)
              expect((await fixture.inspectRows()).pending?.size ?? 0).toBe(1 - index)
              expect((await fixture.device.groups.load(groupID))?.activeIncarnation).toBe(1)
              expect(await fixture.device.groups.loadState(key)).toMatchObject({ terminal: true })
              completion.release.resolve()
            }
            vi.useRealTimers()
            await work
            unsubscribe()
            expect((await fixture.device.groups.load(groupID))?.activeIncarnation).toBeNull()
            expect(mls.sendAdmission()).toMatchObject({ admissible: false, reason: 'terminal' })
            expect((await fixture.inspectRows()).pending?.size ?? 0).toBe(0)
            expect(open).not.toHaveBeenCalled()
            expect(receive).not.toHaveBeenCalled()
            expect(access).not.toHaveBeenCalled()
            expect(fetch).not.toHaveBeenCalled()
            expect(publish).not.toHaveBeenCalled()
            if (policy === 'transactional')
              expect((await fixture.inspectRows())['host-side']?.get('terminal') ?? null).toEqual(
                new Uint8Array([1]),
              )
          } finally {
            releaseBuilder.resolve()
            await queuedCrypto
            captureLive.mockRestore()
            captureCold.mockRestore()
            captureBuild.mockRestore()
            rawSeal.mockRestore()
            releaseControl.resolve()
            releaseFetch.resolve()
            releaseLedger.resolve()
            capture.mockRestore()
            captureHost.mockRestore()
            captureLane.mockRestore()
            captureMux.mockRestore()
            restoreTimers?.()
            restoreNetwork?.()
            vi.useRealTimers()
            failing = false
            release.resolve()
            for (const completion of completions) completion.release.resolve()
            stop.abort(new Error('Terminal witness ended'))
            await work?.catch(() => {})
            restoreCompletion?.()
            running?.owner.dispose()
            await running?.owner.drained()
            await fixture.close()
          }
        },
      )

      test.each(['delete', 'Welcome-readmission', 'resync', 'successor'] as const)(
        'every retirement drains pending before transport clearing: %s',
        async (kind) => {
          const env = await setup()
          let work: Promise<unknown> | undefined
          try {
            const begin = await lifecycle(env, kind)
            await env.plant('source-work')
            let settled = false
            work = begin().finally(() => {
              settled = true
            })
            void work.catch(() => {})
            await vi.waitFor(() => expect(env.delivered).toEqual(['source-work']), {
              timeout: 2000,
            })
            expect(settled).toBe(false)
            expect(await env.pending()).toHaveLength(1)
            expect(await env.fixture.device.groups.load(env.key.groupID)).toMatchObject({
              activeIncarnation: 1,
            })
            env.release.resolve()
            await work
            expect(await env.pending()).toEqual([])
            expect(env.delivered).toEqual(['source-work'])
            expect(
              (await env.fixture.device.groups.load(env.key.groupID))?.activeIncarnation,
            ).not.toBe(1)
          } finally {
            env.release.resolve()
            await work?.catch(() => {})
            await env.fixture.close()
          }
        },
      )

      test('fixture recovery installation excludes checkpoint writes after its revision read', async () => {
        const env = await setup(false)
        const blocked = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const admitted = Promise.withResolvers<void>()
        const finished = Promise.withResolvers<void>()
        const groups = env.fixture.device.groups
        const revisions = new Map<string, number>()
        const initialLifetime = await groups.load(env.key.groupID)
        if (initialLifetime === null) throw new Error('Missing fixture lifetime')
        let latestRevision = initialLifetime.revision
        let installing = false
        let checkpointWriting = false
        let held = false
        let capturedRevision: number | undefined
        let fixtureMutationID: string | null | undefined
        let checkpointMutationID: string | null | undefined
        let running: Awaited<ReturnType<typeof startLeaseRotationPeer>> | undefined
        const observe = env.capability.observe(env.key.groupID, (proof) => {
          if (proof.lifetime !== null) {
            latestRevision = proof.lifetime.revision
            revisions.set(proof.mutationID, latestRevision)
            if (
              installing &&
              capturedRevision !== undefined &&
              proof.mutationID !== checkpointMutationID
            )
              fixtureMutationID ??= proof.mutationID
          }
        })
        const create = checkpoint.createRegistryCheckpointService
        const serviceSpy = vi
          .spyOn(checkpoint, 'createRegistryCheckpointService')
          .mockImplementation((registry, key) => {
            const service = create(registry, key)
            const update = service.updateRecords.bind(service)
            service.updateRecords = async (change) => {
              if (held || !change.put?.some((row) => row.kind === 'cursor')) return update(change)
              held = true
              blocked.resolve()
              await release.promise
              checkpointWriting = true
              const work = update(change)
              checkpointWriting = false
              try {
                await work
              } finally {
                finished.resolve()
              }
            }
            return service
          })
        const install = env.fixture.installRows.bind(env.fixture)
        const installSpy = vi.spyOn(env.fixture, 'installRows').mockImplementation(async (rows) => {
          installing = true
          try {
            await install(rows)
          } finally {
            installing = false
          }
        })
        const load = groups.load.bind(groups)
        const loadSpy = vi.spyOn(groups, 'load').mockImplementation(async (groupID) => {
          const lifetime = await load(groupID)
          if (installing && capturedRevision === undefined && lifetime !== null) {
            capturedRevision = lifetime.revision
            release.resolve()
            // A root read has released ownership, so force the competing proof before transition.
            await finished.promise
          }
          return lifetime
        })
        const run = env.capability.run.bind(env.capability)
        const runSpy = vi
          .spyOn(env.capability, 'run')
          .mockImplementation((request, prepare, work, effects) => {
            const result = run(request, prepare, work, effects)
            if (checkpointWriting) {
              checkpointMutationID = request.mutationID
              admitted.resolve()
            }
            return result
          })
        try {
          running = await startLeaseRotationPeer({
            mode,
            fixture: env.fixture,
            key: env.key,
            outbox: groups.ports(env.key).outbox,
          })
          await blocked.promise
          env.fixture.onPhase('work', async () => {
            if (!installing) throw new Error('Expected fixture installation entry')
            // Prepare has captured the last proven revision; ownership excludes competing proofs.
            capturedRevision = latestRevision
            release.resolve()
            await admitted.promise
          })
          const recovery = await env.fixture.confirmedRecovery(env.key, {
            confirm: true,
            format: 'legacy',
          })
          await finished.promise
          if (
            capturedRevision === undefined ||
            fixtureMutationID == null ||
            checkpointMutationID == null
          )
            throw new Error('Missing fixture/checkpoint revision evidence')
          expect(revisions.get(fixtureMutationID)).toBe(capturedRevision + 1)
          expect(revisions.get(checkpointMutationID)).toBe(capturedRevision + 2)
          expect((await groups.ports(env.key).control.load()).rejoin).toEqual(recovery.record)
        } finally {
          release.resolve()
          running?.owner.dispose()
          await running?.owner.drained()
          serviceSpy.mockRestore()
          installSpy.mockRestore()
          loadSpy.mockRestore()
          runSpy.mockRestore()
          observe()
          await env.fixture.close()
        }
      })

      test.each(['resync', 'delete'] as const)(
        'live handler drains unadmitted backlog without registry delivery: %s',
        async (kind) => {
          const env = await setup(false)
          const release = Promise.withResolvers<void>()
          const calls: Array<unknown> = []
          let running: Awaited<ReturnType<typeof startLeaseRotationPeer>> | undefined
          let work: Promise<unknown> | undefined
          let settled = false
          try {
            await env.plant('first')
            await env.plant('second')
            running = await startLeaseRotationPeer({
              mode,
              fixture: env.fixture,
              key: env.key,
              outbox: env.fixture.device.groups.ports(env.key).outbox,
              handler: async (event) => {
                calls.push(event.data)
                await release.promise
              },
            })
            await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 2000 })
            expect(calls).toEqual([{ text: 'first' }])
            const begin = await lifecycle(env, kind)
            work = begin().then(() => {
              settled = true
            })
            void work.catch(() => {})
            await vi.waitFor(() => expect(running?.owner.status().kind).toBe('switch-blocked'), {
              timeout: 2000,
            })
            expect(await env.pending()).toHaveLength(2)
            release.resolve()
            await vi.waitFor(() => expect(settled).toBe(true), { timeout: 2000 })
            await work
            expect(calls).toEqual([{ text: 'first' }, { text: 'second' }])
            expect(await env.pending()).toEqual([])
            expect(running.owner.status().kind).not.toBe('switch-blocked')
          } finally {
            release.resolve()
            if (work !== undefined && !settled) {
              await env.capability.run(
                { groupID: env.key.groupID, mutationID: crypto.randomUUID() },
                async (reads) => ({ expected: await reads.lifetime(), value: null }),
                async (stores) => {
                  await stores.incarnation(1).pending.complete(['first', 'second'])
                },
              )
            }
            await work?.catch(() => {})
            running?.owner.dispose()
            await running?.owner.drained()
            await env.fixture.close()
          }
        },
      )

      test.each(['delete', 'Welcome-readmission', 'resync', 'successor'] as const)(
        'new pending work found by lifecycle recheck causes another drain: %s',
        async (kind) => {
          const env = await setup()
          let work: Promise<unknown> | undefined
          try {
            const begin = await lifecycle(env, kind)
            env.release.resolve()
            const retirement = registryRetirement(env.fixture.registry)
            const original = retirement.drainOpened
            let injected = false
            const drain = vi.spyOn(retirement, 'drainOpened').mockImplementation(async (key) => {
              await original(key)
              if (!injected) {
                injected = true
                await env.plant('late-open')
              }
            })
            work = begin()
            await expect(work.then(() => 'completed')).resolves.toBe('completed')
            expect(injected).toBe(true)
            expect(env.delivered).toEqual(['late-open'])
            expect(drain.mock.calls.length).toBeGreaterThanOrEqual(2)
            expect(await env.pending()).toEqual([])
            drain.mockRestore()
          } finally {
            env.release.resolve()
            await work?.catch(() => {})
            await env.fixture.close()
          }
        },
      )

      test('three pending rechecks refuse deletion and release owner creation', async () => {
        const env = await setup()
        try {
          env.release.resolve()
          const retirement = registryRetirement(env.fixture.registry)
          const original = retirement.drainOpened
          let changes = 0
          const drain = vi.spyOn(retirement, 'drainOpened').mockImplementation(async (key) => {
            await original(key)
            changes++
            await env.plant(`late-${changes}`)
          })
          await expect(env.fixture.registry.delete(env.key)).rejects.toMatchObject({
            name: 'GroupControlUnsettledError',
            message: 'Group work changed during three deletion drains',
          })
          expect(changes).toBe(3)
          expect(await env.pending()).toHaveLength(1)
          drain.mockRestore()
          expect((await env.fixture.registry.access(env.key.groupID)).key).toEqual(env.key)
        } finally {
          env.release.resolve()
          await env.fixture.close()
        }
      })

      test('switch revalidates a proven administrative version after publication drainage', async () => {
        const env = await setup()
        try {
          await env.fixture.registry.access(env.key.groupID)
          const outbox = env.fixture.device.groups.ports(env.key).outbox
          await outbox.put({
            seq: 13,
            protocol: 'chat',
            prc: 'posted',
            data: encodeEventFrame('posted', { text: 'certified' }),
            status: 'accepted',
            lastAttempt: {
              incarnation: 1,
              epoch: 0,
              segment: 0,
              floor: null,
              attempts: 1,
              publishID: 'source-attempt',
              topicID: 'source-topic',
            },
          })
          const state = await env.fixture.device.groups.loadState(env.key)
          if (state === null || state.deleted) throw new Error('Missing source')
          expect(
            await outbox.recordSettlement(
              13,
              {
                attemptID: 'source-attempt',
                topicID: 'source-topic',
                sequenceID: '42',
                outcome: 'published',
              },
              {
                identity: {
                  ...env.key,
                  epoch: state.epoch,
                  authenticator: state.epochAuthenticator,
                },
                stateVersion: state.version,
                attemptID: 'source-attempt',
              },
            ),
          ).toEqual({ recorded: true })
          const begin = await lifecycle(env, 'resync')
          await expect(begin()).resolves.toEqual({ ...env.key, incarnation: 2 })
          expect(await outbox.loadSettlement(13)).toBeNull()
          expect(await outbox.events()).toContainEqual(
            expect.objectContaining({
              kind: 'published',
              occurrence: { incarnation: 1, segment: 0, topicID: 'source-topic', position: '42' },
            }),
          )
          expect(env.delivered).toEqual([])
        } finally {
          env.release.resolve()
          await env.fixture.close()
        }
      })

      test('old completion cannot write the new incarnation cursor', async () => {
        const env = await setup()
        try {
          const readmit = await lifecycle(env, 'Welcome-readmission')
          await readmit()
          const key = { ...env.key, incarnation: 2 }
          const record = {
            frame: {
              ...key,
              id: 'active-work',
              protocol: 'chat',
              procedure: 'posted',
              topicID: 'new-topic',
              segment: 2,
              position: '1',
            },
            payload: encodeEventFrame('posted', { text: 'active' }),
            senderDID: randomIdentity().id,
            epoch: 2,
            idempotencyKey: 'active',
          }
          await env.capability.run(
            { groupID: key.groupID, mutationID: crypto.randomUUID() },
            async (reads) => ({ expected: await reads.lifetime(), value: null }),
            async (stores) => {
              await stores.incarnation(2).pending.put([record])
              await stores.incarnation(2).cursor.save('new-topic', '0')
            },
          )
          const before = await env.fixture.inspectRows()
          await createHandlerCompletion({
            persistence: env.fixture.device.groups,
            key: env.key,
          }).complete(['active-work'])
          expect(await env.fixture.inspectRows()).toEqual(before)
          env.release.resolve()
          await expect(env.fixture.registry.delete(env.key)).rejects.toMatchObject({
            name: 'DisplacedGroupHandleError',
          })
          expect(env.delivered).toEqual([])
          expect(await env.fixture.inspectRows()).toEqual(before)
          expect(await env.capability.read(key.groupID, (reads) => reads.pendingFrames(2))).toEqual(
            [record],
          )
        } finally {
          env.release.resolve()
          await env.fixture.close()
        }
      })

      test('terminal reconstruction drains before clearing', async () => {
        const env = await setup()
        let reopened: Awaited<ReturnType<typeof env.fixture.reopen>> | undefined
        let work: Promise<void> | undefined
        try {
          await env.plant('terminal-open')
          const state = await env.fixture.device.groups.loadState(env.key)
          if (state === null || state.deleted) throw new Error('Missing source')
          await env.fixture.installRows({
            key: env.key,
            state: { ...state, version: state.version + 1, terminal: true, state: null },
          })
          const control = await env.fixture.device.groups.ports(env.key).control.load()
          reopened = await env.fixture.reopen()
          const restores = reopened.restores()
          work = reopened.registry.delete(env.key)
          await env.entered.promise
          expect(reopened.restores()).toBe(restores)
          expect(await reopened.device.groups.load(env.key.groupID)).toMatchObject({
            activeIncarnation: 1,
          })
          env.release.resolve()
          await work
          expect(env.delivered).toEqual(['terminal-open'])
          expect(await reopened.device.groups.ports(env.key).control.load()).toEqual(control)
        } finally {
          env.release.resolve()
          await work?.catch(() => {})
          await (reopened ?? env.fixture).close()
        }
      })

      test('delivery can seed a different group without joining its own retirement', async () => {
        const env = await setup()
        try {
          const groupID = `${env.key.groupID}-other`
          const candidate = await env.fixture.makeHandle(0, groupID)
          const source = await env.fixture.device.groups.load(env.key.groupID)
          await runOpenedDelivery(env.context, { key: env.key }, async () => {
            await Promise.resolve()
            expect(await env.fixture.registry.seed(candidate, { packageUse: null })).toEqual({
              groupID,
              incarnation: 1,
            })
          })
          expect(await env.fixture.device.groups.load(env.key.groupID)).toEqual(source)
        } finally {
          env.release.resolve()
          await env.fixture.close()
        }
      })

      test.each(['retire', 'switch', 'readmit', 'delete', 'successor'] as const)(
        'handler lifecycle reentry refuses instead of self-waiting: %s',
        async (kind) => {
          const env = await setup()
          try {
            const candidate = await env.fixture.makeHandle(2)
            const before = await env.fixture.inspectRows()
            const begin = vi.spyOn(registryRetirement(env.fixture.registry), 'beginRetirement')
            let result: unknown
            await runOpenedDelivery(env.context, { key: env.key }, async () => {
              await Promise.resolve()
              try {
                if (kind === 'retire')
                  registryRetirement(env.fixture.registry).beginRetirement(env.key)
                else if (kind === 'delete') await env.fixture.registry.delete(env.key)
                else if (kind === 'readmit')
                  await env.fixture.registry.seed(candidate, { replace: true, packageUse: null })
                else if (kind === 'successor')
                  await retireToSuccessor({
                    registry: env.fixture.registry,
                    persistence: env.fixture.device.groups,
                    source: env.key,
                    successor: { groupID: 'other', incarnation: 1 },
                  })
                else
                  await env.fixture.registry.switchIncarnation(candidate, {
                    source: await env.fixture.registry.recoverySource(env.key.groupID),
                    rejoinID: 'absent',
                    proof: {
                      targetID: 'hub',
                      topicID: 'commits',
                      groupInfoEpoch: 2,
                      captureHead: null,
                      position: asLogPosition('1'),
                      payloadDigest: 'digest',
                      verdict: new Uint8Array(),
                    },
                    write: {
                      mutationID: 'forbidden',
                      source: { rejoinID: 'absent' },
                      destination: {
                        control: { cursor: { position: asLogPosition('1'), epoch: 2 } },
                      },
                    },
                  })
              } catch (error) {
                result = error
              }
            })
            expect(result).toBeInstanceOf(OpenedDeliveryReentryError)
            if (kind === 'delete') expect(begin).not.toHaveBeenCalled()
            expect(await env.fixture.inspectRows()).toEqual(before)
          } finally {
            env.release.resolve()
            await env.fixture.close()
          }
        },
      )

      async function liveRetirement(advance: boolean) {
        const env = await setup()
        const release = Promise.withResolvers<void>()
        const entered = Promise.withResolvers<void>()
        let running: Awaited<ReturnType<typeof startLeaseRotationPeer>> | undefined
        let work: Promise<unknown> | undefined
        try {
          await env.plant('live')
          const access = await env.fixture.registry.access(env.key.groupID)
          const completion = vi.spyOn(access.pending, 'complete')
          const binding = openedDeliveryBinding(access.pending)
          if (binding === undefined) throw new Error('Missing opened binding')
          const attach = binding.attach
          const handedOff = vi.fn()
          binding.attach = (context, source) =>
            attach(context, {
              ...source,
              handoff: () => {
                handedOff()
                return source.handoff()
              },
            })
          let calls = 0
          running = await startLeaseRotationPeer({
            mode,
            fixture: env.fixture,
            key: env.key,
            outbox: env.fixture.device.groups.ports(env.key).outbox,
            handler: async () => {
              calls++
              entered.resolve()
              await release.promise
            },
          })
          await entered.promise
          let settled = false
          if (advance) vi.useFakeTimers()
          const retirement = registryRetirement(env.fixture.registry)
          const begin = retirement.beginRetirement
          const fenced = Promise.withResolvers<void>()
          vi.spyOn(retirement, 'beginRetirement').mockImplementation((key) => {
            const attempt = begin(key)
            fenced.resolve()
            expect(handedOff).toHaveBeenCalledTimes(1)
            return attempt
          })
          if (advance) {
            const attempt = retirement.beginRetirement(env.key)
            work = attempt.drain().then(() => {
              settled = true
              attempt.settle('rolled-back')
            })
          } else {
            work = env.fixture.registry.delete(env.key).then(() => {
              settled = true
            })
          }
          void work.catch(() => {})
          await fenced.promise
          await expect(access.pending.complete('live')).rejects.toMatchObject({
            name: 'RegistryRetiringError',
          })
          expect(settled).toBe(false)
          if (advance) {
            await vi.advanceTimersByTimeAsync(6000)
            expect(settled).toBe(false)
            expect(await env.pending()).toHaveLength(1)
            expect(await env.fixture.device.groups.load(env.key.groupID)).toMatchObject({
              activeIncarnation: 1,
            })
            expect(await env.capability.read(env.key.groupID, (reads) => reads.events(1))).toEqual(
              [],
            )
            expect(running.owner.status()).toEqual({
              kind: 'switch-blocked',
              key: env.key,
              reason: 'opened-records',
              pending: 1,
            })
            vi.useRealTimers()
          }
          completion.mockClear()
          release.resolve()
          await work
          expect(calls).toBe(1)
          expect(completion).not.toHaveBeenCalled()
          expect(env.delivered).toEqual([])
          expect(await env.pending()).toEqual([])
        } finally {
          release.resolve()
          env.release.resolve()
          await work?.catch(() => {})
          vi.restoreAllMocks()
          running?.owner.dispose()
          await running?.owner.drained()
          await env.fixture.close()
          vi.useRealTimers()
        }
      }
      test('retirement hands suspended live delivery to exact-key completion', () =>
        liveRetirement(false))
      test('timeout never erases opened records or certifies retirement', () =>
        liveRetirement(true))
    })
  }
}
