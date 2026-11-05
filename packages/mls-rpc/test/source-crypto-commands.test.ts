import { decodeClientState, encodeClientState, GroupHandle, restoreGroup } from '@kumiai/mls'
import {
  asLogPosition,
  bindAppCompletionCoverage,
  controlBatch,
  createOpenedAppHandler,
  digestAppliedCommit,
  encodeAppAAD,
  frameID,
  PeerRemovedError,
} from '@kumiai/rpc'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createGroupCrypto } from '../src/crypto.js'
import { deviceEntryCapability } from '../src/device-entry-capability.js'
import { entryCapability } from '../src/entry-capability.js'
import { createHandlerCompletion } from '../src/handler-completion.js'
import { createLedgerEntrySlot } from '../src/mls.js'
import {
  DisplacedGroupHandleError,
  GroupStateConflictError,
  ReentrantOwnershipError,
} from '../src/persistence-errors.js'
import { registryReceiveSlots } from '../src/registry/live-receive.js'
import type { SourceCryptoBodies } from '../src/registry/source-crypto-commands.js'
import * as sourceCryptoCommands from '../src/registry/source-crypto-commands.js'
import { registrySourceExecutor } from '../src/registry/source-executor.js'
import { createRegistryGroupMLS } from '../src/registry-group-mls.js'
import { deferred } from '../src/runtime.js'
import {
  drainRegistryMaintenance,
  dropRegistryOwner,
  gateRegistryMaintenance,
  registryLeaseSnapshot,
} from '../src/testing.js'
import { orderedCoverage } from './fixtures/handler-completion.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import {
  createGatedRegistryFixture,
  registryFixtureObserveRestoredControl,
  registryFixtureSourceDiagnostics,
} from './fixtures/registry.js'
import { createRegistryCryptoGroup } from './fixtures/registry-crypto.js'
import { flushReady, freshWarmSourceFixture } from './fixtures/source-executor.js'
import { writeSideRow } from './fixtures/storage-persistence.js'

const bytes = new Uint8Array([1, 2, 3])
const opts = { aad: new Uint8Array(), intent: 'ephemeral' as const }
afterEach(() => vi.restoreAllMocks())

async function fixture(mode: 'real-mls' | 'double' = 'real-mls', context = false) {
  const group = await createRegistryCryptoGroup(mode, crypto.randomUUID(), 2, {
    backgroundMaintenance: 'gated',
    ...(context ? { ownershipContext: createAsyncLocalOwnershipContext() } : {}),
  })
  await drainRegistryMaintenance(group.access())
  return group
}
async function removal(
  group: Awaited<ReturnType<typeof fixture>>,
  removed: number | null = 0,
  batched = true,
) {
  const f = group.fixture()
  const mls = await createRegistryGroupMLS({
    registry: f.registry,
    key: group.key,
    recovery: f.environment,
    identity: f.identity,
    entrySlot: createLedgerEntrySlot(),
    target: { targetID: 'hub', topicID: 'removal' },
  })
  const sourceEpoch = await mls.readEpoch()
  const batch = controlBatch(mls)
  if (batch === undefined) throw new Error('Missing control batch')
  const commit = await group.prepareCommit(removed ?? undefined)
  if (!batched)
    return () =>
      mls
        .processCommit(commit, {
          adoption: (staged) => ({
            mutationID: crypto.randomUUID(),
            changes: {
              commitOnce: null,
              cursor: { position: asLogPosition('01'), epoch: staged.epochAfter },
              putApplied: [
                {
                  epoch: sourceEpoch,
                  digest: digestAppliedCommit(commit),
                  payloadDigest: 'removal',
                  sequenceID: asLogPosition('01'),
                  opID: null,
                  removed: staged.removed,
                },
              ],
            },
          }),
        })
        .then(() => undefined)
  return () =>
    batch
      .run({
        source: 'removal',
        prepare: async (scope) => {
          const epoch = await scope.readEpoch()
          return scope.prepareCommit(commit, {
            adoption: (staged) => ({
              mutationID: crypto.randomUUID(),
              changes: {
                commitOnce: null,
                cursor: { position: asLogPosition('01'), epoch: staged.epochAfter },
                putApplied: [
                  {
                    epoch,
                    digest: digestAppliedCommit(commit),
                    payloadDigest: 'removal',
                    sequenceID: asLogPosition('01'),
                    opID: null,
                    removed: staged.removed,
                  },
                ],
              },
            }),
          })
        },
      })
      .then(() => undefined)
}
function pauseMethod(method: 'encryptApplication' | 'readSenderData' | 'exportSecret') {
  const entered = deferred<void>()
  const release = deferred<void>()
  const original = GroupHandle.prototype[method]
  let armed = true
  const spy = vi.spyOn(GroupHandle.prototype, method)
  spy.mockImplementation(async function (this: GroupHandle, ...args: Array<unknown>) {
    if (armed) {
      armed = false
      entered.resolve()
      await release.promise
    }
    return await Reflect.apply(original, this, args)
  })
  return { entered: entered.promise, release: () => release.resolve() }
}

describe('managed crypto commands', () => {
  test.each(['seal', 'receive'] as const)(
    'warm seal and receive exclude removal across nested crypto (%s)',
    async (operation) => {
      const group = await fixture()
      const ciphertext = await group.sender.handle.encrypt(bytes)
      const remove = await removal(group, 0, false)
      const entry = entryCapability(group.fixture().device.groups)
      if (entry === null) throw new Error('Missing entry')
      let competingReads = 0
      const read = entry.read.bind(entry)
      vi.spyOn(entry, 'read').mockImplementation((id, fn) =>
        read(id, async (reads) => {
          competingReads++
          return fn(reads)
        }),
      )
      const entered = deferred<void>()
      const released = deferred<void>()
      let armed = true
      const instrument = (handle: GroupHandle) => {
        const suite = handle.context.cipherSuite
        handle.context.cipherSuite = {
          ...suite,
          kdf: {
            ...suite.kdf,
            async expand(...args) {
              if (armed) {
                armed = false
                entered.resolve()
                await released.promise
              }
              return suite.kdf.expand(...args)
            },
          },
        }
      }
      if (operation === 'seal') {
        const lease = registryLeaseSnapshot(group.access())
        if (lease === null) throw new Error('Missing sender')
        instrument(lease.copy)
      } else registryFixtureObserveRestoredControl(group.fixture(), instrument)
      const pause = { entered: entered.promise, release: () => released.resolve() }
      const work =
        operation === 'seal'
          ? group.access().seal(bytes, opts)
          : group.access().receive([{ ciphertext, expectedAAD: opts.aad }])
      let removed = false
      let removalWork: Promise<void> | undefined
      let outcomes: Array<PromiseSettledResult<unknown>> = []
      try {
        await pause.entered
        removalWork = remove().then(() => {
          removed = true
        })
        void removalWork.catch(() => {})
        await flushReady()
        expect(competingReads, 'competing private reads must wait for G').toBe(0)
        expect(removed, 'removal must wait for the complete source operation').toBe(false)
      } finally {
        pause.release()
        outcomes = await Promise.allSettled([work, removalWork])
        await group.close()
      }
      expect(outcomes.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
    },
  )

  test.each([false, true])('ephemeral chunks stay memory only (context=%s)', async (context) => {
    const group = await fixture('real-mls', context)
    try {
      const entry = entryCapability(group.fixture().device.groups)
      if (entry === null) throw new Error('Missing entry')
      const reads = vi.spyOn(entry, 'read')
      const runs = vi.spyOn(entry, 'run')
      const commands = vi.spyOn(entry, 'command')
      const ciphertext = await group.sender.handle.encrypt(bytes)
      await group.access().seal(bytes, opts)
      await group.access().receive([{ ciphertext, expectedAAD: opts.aad }])
      expect(commands, 'warm crypto must enter the shared owner').toHaveBeenCalledTimes(2)
      expect(reads).not.toHaveBeenCalled()
      expect(runs).not.toHaveBeenCalled()
      for (let generation = 1; generation < 16; generation++) await group.access().seal(bytes, opts)
      await expect(group.access().seal(bytes, opts)).rejects.toMatchObject({ reason: 'exhausted' })
      expect(reads).not.toHaveBeenCalled()
      expect(runs).not.toHaveBeenCalled()
      dropRegistryOwner(group.access())
      const cold = await group.fixture().registry.access(group.key.groupID)
      const beforeCold = registryFixtureSourceDiagnostics(group.fixture()).transactionCount()
      await expect(cold.seal(bytes, opts)).rejects.toMatchObject({ reason: 'cold' })
      expect(registryFixtureSourceDiagnostics(group.fixture()).transactionCount()).toBe(beforeCold)
      const slot = registryReceiveSlots.get(cold)
      if (slot === undefined) throw new Error('Missing cold receive slot')
      slot.base = null
      slot.receive = null
      const coldCiphertext = await group.sender.handle.encrypt(bytes)
      await expect(
        cold.receive([{ ciphertext: coldCiphertext, expectedAAD: opts.aad }]),
        'cold receive must reject without inline refresh or retry',
      ).rejects.toMatchObject({ reason: 'cold' })
      expect(registryFixtureSourceDiagnostics(group.fixture()).transactionCount()).toBe(beforeCold)
      gateRegistryMaintenance(group.fixture().registry).release()
      await drainRegistryMaintenance(cold)
      expect(
        await cold.receive([{ ciphertext: coldCiphertext, expectedAAD: opts.aad }]),
      ).toMatchObject([{ kind: 'opened', payload: bytes }])
    } finally {
      await group.close()
    }
  })

  test.each([false, true])(
    'synchronous crypto callback refuses nested seal (context=%s)',
    async (context) => {
      const group = await fixture('real-mls', context)
      const lease = registryLeaseSnapshot(group.access())
      if (lease === null) throw new Error('Missing sender lease')
      const suite = lease.copy.context.cipherSuite
      let nested: Promise<unknown> | undefined
      lease.copy.context.cipherSuite = {
        ...suite,
        kdf: {
          ...suite.kdf,
          expand(...args) {
            if (nested === undefined) {
              try {
                nested = group
                  .access()
                  .seal(bytes, opts)
                  .catch((error: unknown) => error)
              } catch (error) {
                nested = Promise.resolve(error)
              }
            }
            return suite.kdf.expand(...args)
          },
        },
      }
      try {
        await group.access().seal(bytes, opts)
        expect(
          nested,
          'the synchronous primitive callback must attempt a nested seal',
        ).toBeDefined()
        expect(
          await nested,
          'nested seal must refuse before losing the callback marker',
        ).toBeInstanceOf(ReentrantOwnershipError)
      } finally {
        await group.close()
      }
    },
  )

  test.each([false, true])(
    'warmed seal refuses device-root dependency (context=%s)',
    async (context) => {
      const group = await fixture('real-mls', context)
      const lease = registryLeaseSnapshot(group.access())
      const device = deviceEntryCapability(group.fixture().device)
      if (lease === null || device === null) throw new Error('Missing owned fixture')
      const suite = lease.copy.context.cipherSuite
      const roots: Array<Promise<unknown>> = []
      lease.copy.context.cipherSuite = {
        ...suite,
        kdf: {
          ...suite.kdf,
          expand(...args) {
            if (roots.length === 0)
              roots.push(
                group
                  .fixture()
                  .device.load()
                  .catch((error: unknown) => error),
              )
            return suite.kdf.expand(...args)
          },
        },
      }
      const pause = pauseMethod('encryptApplication')
      const sealing = group.access().seal(bytes, opts)
      let combined: Promise<void> | undefined
      try {
        await pause.entered
        let installed = false
        combined = device
          .runCombined(
            { groupID: group.key.groupID, mutationID: crypto.randomUUID() },
            async (reads) => ({
              expected: await reads.group.lifetime(),
              expectedDeviceRevision: (await reads.device()).revision,
              value: undefined,
            }),
            async () => {},
          )
          .then(() => {
            installed = true
          })
        await flushReady()
        expect(installed, 'Combined holds D while waiting for the command to release G').toBe(false)
        pause.release()
        await sealing
        await combined
        expect(roots).toHaveLength(1)
        expect(await roots[0]).toBeInstanceOf(ReentrantOwnershipError)
      } finally {
        pause.release()
        await Promise.allSettled([sealing, combined])
        await group.close()
      }
    },
  )

  test.each([false, true])(
    'cold handoff restore refuses callback roots (context=%s)',
    async (context) => {
      const f = await createGatedRegistryFixture({
        mode: 'real-mls',
        setup: 'empty',
        groupID: crypto.randomUUID(),
        ...(context ? { ownershipContext: createAsyncLocalOwnershipContext() } : {}),
      })
      try {
        const key = await f.registry.seed(await f.makeHandle(0), { packageUse: null })
        const roots: Array<Promise<unknown>> = []
        f.overrideRestore(async (record) => {
          roots.push(f.device.load().catch((error: unknown) => error))
          const state = decodeClientState(record.state)
          if (state === undefined) throw new Error('Missing handoff state')
          return restoreGroup({
            state,
            credential: record.credential,
            ledgerEntries: record.ledger,
            options: f.environment.options,
          })
        })
        await f.registry.access(key.groupID)
        expect(
          roots.length,
          'cold load and handoff each restore under the same attempt',
        ).toBeGreaterThanOrEqual(2)
        for (const root of roots) expect(await root).toBeInstanceOf(ReentrantOwnershipError)
      } finally {
        await f.close()
      }
    },
  )

  test('managed entry crypto contains derived keys and suites', async () => {
    const group = await fixture()
    try {
      const crypto = createGroupCrypto({ access: group.access() })
      const rawReads = vi.spyOn(group.access(), 'read')
      const sealed = await crypto.sealEntries(bytes)
      expect(await crypto.openEntries(sealed.sealed)).toEqual(bytes)
      expect(await crypto.exportSecret('host-owned')).toMatchObject({
        secret: expect.any(Uint8Array),
      })
      expect(rawReads, 'managed entry crypto must use commands').not.toHaveBeenCalled()
      expect(Object.keys(sealed).sort()).toEqual(['epoch', 'sealed'])
    } finally {
      await group.close()
    }
  })

  test.each(['terminal', 'superseded', 'restore'] as const)(
    'managed export succeeds live and refuses new exports after closure (%s)',
    async (closure) => {
      const group = await fixture()
      try {
        const crypto = createGroupCrypto({ access: group.access() })
        const exports = vi.spyOn(GroupHandle.prototype, 'exportSecret')
        const saved = await crypto.exportSecret('host-owned')
        const returned = saved.secret.slice()
        expect(exports).toHaveBeenCalled()
        if (closure === 'terminal') await (await removal(group))()
        else if (closure === 'superseded')
          registrySourceExecutor(group.fixture().registry).control.invalidate(
            group.key,
            new DisplacedGroupHandleError('Superseded'),
          )
        else {
          const entry = entryCapability(group.fixture().device.groups)
          if (entry === null) throw new Error('Missing entry')
          const mutationID = globalThis.crypto.randomUUID()
          await entry.run(
            { groupID: group.key.groupID, mutationID },
            async (reads) => ({ expected: await reads.lifetime(), value: undefined }),
            async (stores) => {
              const lifetime = await stores.lifetime.load()
              if (lifetime === null) throw new Error('Missing lifetime')
              await stores.lifetime.save({
                ...lifetime,
                revision: lifetime.revision + 1,
                mutationID,
                restorePending: true,
              })
            },
          )
        }
        exports.mockClear()
        await expect(async () => crypto.exportSecret('host-owned')).rejects.toMatchObject(
          closure === 'terminal'
            ? { name: 'PeerRemovedError' }
            : closure === 'superseded'
              ? { name: 'DisplacedGroupHandleError' }
              : { name: 'GroupUnavailableError', reason: 'restore-pending' },
        )
        expect(exports).not.toHaveBeenCalled()
        expect(saved.secret).toEqual(returned)
      } finally {
        await group.close()
      }
    },
  )

  test('cached clones require fresh command admission and gain no lease', async () => {
    const group = await fixture()
    try {
      const source = registrySourceExecutor(group.fixture().registry)
      const binding = await source.control.admit(group.key, 'source')
      const clone = registryLeaseSnapshot(group.access())?.copy.clone()
      expect(clone).toBeDefined()
      await expect(clone?.encrypt(bytes)).rejects.toMatchObject({
        name: 'ApplicationSendRefusedError',
      })
      source.control.invalidate(group.key, new DisplacedGroupHandleError('Superseded'))
      const fresh = await source.control.admit(group.key, 'source')
      expect(
        (
          await source.executor.execute({
            binding: fresh,
            command: 'crypto.export',
            input: { label: 'fresh', length: 32 },
          })
        ).value.secret,
      ).toHaveLength(32)
      for (const command of ['crypto.export', 'app.seal', 'crypto.openEntries'] as const) {
        const input =
          command === 'app.seal'
            ? { plaintext: bytes, ...opts }
            : command === 'crypto.export'
              ? { label: 'host-owned', length: 32 }
              : bytes
        await expect(source.executor.execute({ binding, command, input })).rejects.toBeInstanceOf(
          DisplacedGroupHandleError,
        )
      }
      expect(registryLeaseSnapshot(group.access())?.own).toBe(0)
    } finally {
      await group.close()
    }
  })
  test.each(
    (['real-mls', 'double'] as const).flatMap((mode) =>
      [false, true].flatMap((context) =>
        (['seal', 'receive'] as const).map((operation) => ({ mode, context, operation })),
      ),
    ),
  )(
    'fail-stop revokes suspended memory-command authority ($mode, context=$context, $operation)',
    async ({ mode, context, operation }) => {
      const group = await fixture(mode, context)
      const f = group.fixture()
      const entry = entryCapability(f.device.groups)
      if (entry === null) throw new Error('Missing entry')
      let primitiveCalls = 0
      let pause = false
      const entered = deferred<void>()
      const release = deferred<void>()
      const calls = () => primitiveCalls++
      registryFixtureObserveRestoredControl(f, (handle) => {
        if (mode === 'real-mls') {
          const suite = handle.context.cipherSuite
          handle.context.cipherSuite = {
            ...suite,
            kdf: {
              ...suite.kdf,
              async expand(...args) {
                calls()
                if (pause) {
                  pause = false
                  entered.resolve()
                  await release.promise
                }
                return suite.kdf.expand(...args)
              },
            },
          }
        } else {
          const encrypt = handle.encryptApplication.bind(handle)
          handle.encryptApplication = async (...args) => {
            calls()
            const result = await encrypt(...args)
            if (pause) {
              pause = false
              entered.resolve()
              await release.promise
            }
            return result
          }
          const sender = handle.readSenderData.bind(handle)
          handle.readSenderData = async (...args) => {
            calls()
            const result = await sender(...args)
            if (pause) {
              pause = false
              entered.resolve()
              await release.promise
            }
            return result
          }
          const decrypt = handle.decrypt.bind(handle)
          handle.decrypt = (...args) => {
            calls()
            return decrypt(...args)
          }
        }
      })
      const ciphertexts = await Promise.all([0, 1].map(() => group.sender.handle.encrypt(bytes)))
      const run = (index: number) => {
        const ciphertext = ciphertexts[index]
        if (ciphertext === undefined) throw new Error('Missing calibrated ciphertext')
        return operation === 'seal'
          ? group.access().seal(bytes, opts)
          : group.access().receive([{ ciphertext, expectedAAD: opts.aad }])
      }
      if (operation === 'seal') {
        const lease = registryLeaseSnapshot(group.access())
        if (lease === null) throw new Error('Missing lease')
        const observe =
          mode === 'real-mls'
            ? lease.copy.context.cipherSuite.kdf.expand.bind(lease.copy.context.cipherSuite.kdf)
            : undefined
        if (observe !== undefined) {
          const suite = lease.copy.context.cipherSuite
          lease.copy.context.cipherSuite = {
            ...suite,
            kdf: {
              ...suite.kdf,
              async expand(...args) {
                calls()
                if (pause) {
                  pause = false
                  entered.resolve()
                  await release.promise
                }
                return observe(...args)
              },
            },
          }
        } else {
          const encrypt = lease.copy.encryptApplication.bind(lease.copy)
          lease.copy.encryptApplication = async (...args) => {
            calls()
            const result = await encrypt(...args)
            if (pause) {
              pause = false
              entered.resolve()
              await release.promise
            }
            return result
          }
        }
      }
      await run(0)
      expect(primitiveCalls, 'live calibration reaches private primitives').toBeGreaterThan(0)
      const beforeTransactions = registryFixtureSourceDiagnostics(f).transactionCount()
      const leaseBefore = registryLeaseSnapshot(group.access())
      pause = true
      const active = run(1).catch((error: unknown) => error)
      let queued: Promise<unknown> | undefined
      try {
        await entered.promise
        const atPause = primitiveCalls
        const receiveSlot = registryReceiveSlots.get(group.access())
        const handleAtPause = operation === 'seal' ? leaseBefore?.copy : receiveSlot?.receive
        if (handleAtPause === null || handleAtPause === undefined)
          throw new Error('Missing paused private handle')
        const progressAtPause = encodeClientState(handleAtPause.state)
        const consumedAtPause = structuredClone(receiveSlot?.consumed)
        queued = run(1).catch((error: unknown) => error)
        const conflict = new GroupStateConflictError('External owner marker conflict')
        registryFixtureSourceDiagnostics(f).failStop(conflict)
        await flushReady()
        expect(await active).toBe(conflict)
        expect(await queued).toBe(conflict)
        expect(primitiveCalls).toBe(atPause)
        release.resolve()
        await flushReady()
        expect(primitiveCalls, 'resumed work must initiate no later primitive').toBe(atPause)
        expect(registryLeaseSnapshot(group.access())).toBeNull()
        expect(
          encodeClientState(handleAtPause.state),
          'revoked primitives install no late ratchet progress',
        ).toEqual(progressAtPause)
        expect(receiveSlot?.consumed).toEqual(consumedAtPause)
        if (operation === 'receive') expect(receiveSlot?.receive).toBeNull()
        expect(leaseBefore?.copy.state).toBeDefined()
        expect(
          registryFixtureSourceDiagnostics(f).transactionCount() - beforeTransactions,
          'warm commands open no transaction',
        ).toBe(0)
      } finally {
        release.resolve()
        await active
        await queued
        await group.close().catch(() => {})
      }
    },
  )

  test.each([false, true])(
    'warmed commands service control and another lane within three batches (context=%s)',
    async (context) => {
      const group = await fixture('real-mls', context)
      const adopt = await removal(group, null)
      const ciphertext = await group.sender.handle.encrypt(bytes)
      const order: Array<string> = []
      const pause = pauseMethod('encryptApplication')
      const active = group
        .access()
        .seal(bytes, opts)
        .then(() => order.push('A1'))
      let backlog: Array<Promise<unknown>> = []
      try {
        await pause.entered
        backlog = Array.from({ length: 4 }, () =>
          group
            .access()
            .seal(bytes, opts)
            .then(
              () => order.push('A'),
              () => order.push('A'),
            ),
        )
        await flushReady()
        const lane = group
          .access()
          .receive([{ ciphertext, expectedAAD: opts.aad }])
          .then(() => order.push('B'))
        const control = adopt().then(() => order.push('control'))
        await flushReady()
        expect(order).toEqual([])
        pause.release()
        await Promise.all([active, lane, control, ...backlog])
        expect(order.slice(0, 3)).toEqual(['A1', 'control', 'B'])
      } finally {
        pause.release()
        await Promise.allSettled([active, ...backlog])
        await group.close()
      }
    },
  )

  test.each([false, true])(
    'ready saved completion precedes the next burst command batch (context=%s)',
    async (context) => {
      const group = await fixture('real-mls', context)
      const aad = encodeAppAAD({ topicID: 'saved', intent: 'log' })
      const { encodeEventFrame } = await import('@kumiai/broadcast')
      const ciphertext = await group.sender.handle.encrypt(encodeEventFrame('posted', {}), { aad })
      const frame = {
        ...group.key,
        id: frameID('saved', ciphertext),
        topicID: 'saved',
        protocol: 'chat',
        segment: group.access().epoch(),
        position: '01',
      }
      await group.receiver().unwrap(ciphertext, { expectedAAD: aad, frame })
      const saved = await group.access().pending.list()
      const completion = createHandlerCompletion({
        persistence: group.fixture().device.groups,
        key: group.key,
      })
      const coverage = orderedCoverage(saved)
      bindAppCompletionCoverage(completion, coverage.source)
      const order: Array<string> = []
      const pause = pauseMethod('encryptApplication')
      const active = group
        .access()
        .seal(bytes, opts)
        .then(() => order.push('A1'))
      let backlog: Array<Promise<unknown>> = []
      try {
        await pause.entered
        backlog = Array.from({ length: 3 }, () =>
          group
            .access()
            .seal(bytes, opts)
            .then(() => order.push('A')),
        )
        await flushReady()
        const completing = completion
          .transact(
            saved.map((row) => row.frame.id),
            async (tx, rows) => {
              expect(rows).toHaveLength(1)
              await writeSideRow(tx, 'saved-effect', new Uint8Array([1]))
            },
          )
          .then(() => order.push('completion'))
        await flushReady()
        pause.release()
        await Promise.all([active, completing, ...backlog])
        expect(order.slice(0, 2)).toEqual(['A1', 'completion'])
        expect(await group.access().pending.list()).toEqual([])
        const entry = entryCapability(group.fixture().device.groups)
        if (entry === null) throw new Error('Missing entry')
        expect(await entry.read(group.key.groupID, (reads) => reads.appCursor(1, 'saved'))).toBe(
          '01',
        )
        expect((await group.fixture().inspectRows())['host-side']?.get('saved-effect')).toEqual(
          new Uint8Array([1]),
        )
      } finally {
        pause.release()
        await Promise.allSettled([active, ...backlog])
        await group.close()
      }
    },
  )

  describe.each([false, true])('queued entry binding (context=%s)', (context) => {
    test.each(['app.publicationSnapshot', 'app.open'] as const)(
      '%s refuses supersession inside the owner before private reads',
      async (command) => {
        const group = await fixture('real-mls', context)
        const source = registrySourceExecutor(group.fixture().registry)
        const binding = await source.control.admit(group.key, 'source')
        const entry = entryCapability(group.fixture().device.groups)
        if (entry === null) throw new Error('Missing entry')
        const aad = encodeAppAAD({ topicID: 'queued-open', intent: 'log' })
        const ciphertext = await group.sender.handle.encrypt(bytes, { aad })
        const input =
          command === 'app.publicationSnapshot'
            ? 'chat'
            : [
                {
                  ciphertext,
                  expectedAAD: aad,
                  frame: {
                    ...group.key,
                    id: frameID('queued-open', ciphertext),
                    topicID: 'queued-open',
                    protocol: 'chat',
                    segment: group.access().epoch(),
                    position: '01',
                  },
                },
              ]
        const entered = deferred<void>()
        const release = deferred<void>()
        const queued = deferred<void>()
        let stateReads = 0
        const read = entry.read.bind(entry)
        vi.spyOn(entry, 'read').mockImplementation((id, fn) => {
          queued.resolve()
          return read(id, (reads) => {
            const state = reads.state.bind(reads)
            vi.spyOn(reads, 'state').mockImplementation((n) => {
              stateReads++
              return state(n)
            })
            return fn(reads)
          })
        })
        const run = entry.run.bind(entry)
        vi.spyOn(entry, 'run').mockImplementation((request, prepare, work, effects) => {
          queued.resolve()
          return run(
            request,
            (reads, closing) => {
              const state = reads.state.bind(reads)
              vi.spyOn(reads, 'state').mockImplementation((n) => {
                stateReads++
                return state(n)
              })
              return prepare(reads, closing)
            },
            work,
            effects,
          )
        })
        const holding = entry.command(group.key.groupID, async () => {
          entered.resolve()
          await release.promise
        })
        let result: Promise<unknown> | undefined
        try {
          await entered.promise
          result = source.executor
            .execute({ binding, command, input })
            .catch((error: unknown) => error)
          await queued.promise
          // Keep readable non-terminal metadata: rollback cannot revive this originating binding.
          source.control.invalidate(
            group.key,
            new DisplacedGroupHandleError('Superseded while queued'),
          )
          release.resolve()
          const outcome = await result
          expect(stateReads, 'superseded entry must refuse before reads.state()').toBe(0)
          expect(outcome).toBeInstanceOf(DisplacedGroupHandleError)
        } finally {
          release.resolve()
          await Promise.allSettled([holding, result])
          await group.close()
        }
      },
    )
  })

  test('cold and ownerless paths admit before private reads', async () => {
    const group = await fixture()
    try {
      await (await removal(group))()
      await expect(
        group.fixture().restoreCommittedSender(group.key.groupID),
      ).rejects.toBeInstanceOf(PeerRemovedError)
      const f = await group.fixture().reopen()
      try {
        await f.corruptState(group.key, 'unreadable')
        const reads = entryCapability(f.device.groups)
        if (reads === null) throw new Error('Missing entry')
        const before = f.restores()
        await expect(f.registry.access(group.key.groupID)).rejects.toBeInstanceOf(PeerRemovedError)
        expect(f.restores()).toBe(before)
      } finally {
        await f.close()
      }
    } finally {
      await group.close()
    }
  })

  test.each([false, true])(
    'first warmed command waits for scope startup persistence (context=%s)',
    async (context) => {
      let bodies: SourceCryptoBodies | undefined
      const register = sourceCryptoCommands.registerSourceCrypto
      const capture = vi
        .spyOn(sourceCryptoCommands, 'registerSourceCrypto')
        .mockImplementation((coordinator, key, registered) => {
          bodies = registered
          register(coordinator, key, registered)
        })
      const group = await fixture('real-mls', context)
      capture.mockRestore()
      if (bodies === undefined) throw new Error('Missing warmed crypto bodies')
      const f = await freshWarmSourceFixture({
        warm: group.fixture(),
        key: group.key,
        bodies,
        ...(context ? { ownershipContext: createAsyncLocalOwnershipContext() } : {}),
      })
      const ciphertext = await group.sender.handle.encrypt(bytes)
      const encrypt = vi.spyOn(GroupHandle.prototype, 'encryptApplication')
      const senderData = vi.spyOn(GroupHandle.prototype, 'readSenderData')
      const decrypt = vi.spyOn(GroupHandle.prototype, 'decrypt')
      const beforeRestores = group.fixture().restores()
      // Both adapters exist before this scope has admitted any persistence entry.
      const seal = () => f.adapters.execute('app.seal', { plaintext: bytes, ...opts })
      const receive = () =>
        f.adapters.execute('app.receive', [{ ciphertext, expectedAAD: opts.aad }])
      let sealing: Promise<unknown> | undefined
      let receiving: Promise<unknown> | undefined
      let startup: Promise<unknown> | undefined
      let pause: ReturnType<typeof f.storage.pauseBarrier> | undefined
      try {
        // Exercise the command's startup guard directly; removing it must reach a protected primitive.
        await expect(seal()).rejects.toThrow('startup')
        await expect(receive()).rejects.toThrow('startup')
        expect(encrypt).not.toHaveBeenCalled()
        expect(senderData).not.toHaveBeenCalled()
        expect(decrypt).not.toHaveBeenCalled()
        pause = f.storage.pauseBarrier()
        startup = f.entry.read(group.key.groupID, async () => {})
        await pause.started
        let sealSettled = false
        let receiveSettled = false
        sealing = seal().finally(() => {
          sealSettled = true
        })
        receiving = receive().finally(() => {
          receiveSettled = true
        })
        void sealing.catch(() => {})
        void receiving.catch(() => {})
        await flushReady()
        expect(sealSettled, 'precreated warm seal waits for startup').toBe(false)
        expect(receiveSettled, 'precreated warm receive waits for startup').toBe(false)
        expect(encrypt, 'no seal primitive before barrier and marker').not.toHaveBeenCalled()
        expect(
          senderData,
          'no sender-data primitive before barrier and marker',
        ).not.toHaveBeenCalled()
        expect(decrypt, 'no decrypt primitive before barrier and marker').not.toHaveBeenCalled()
        expect(group.fixture().restores() - beforeRestores).toBe(0)
        pause.release()
        await startup
        const [sealed, received] = await Promise.all([sealing, receiving])
        expect(sealed).toMatchObject({ ciphertext: expect.any(Uint8Array) })
        expect(received).toMatchObject([{ kind: 'opened', payload: bytes }])
        expect(encrypt).toHaveBeenCalledTimes(1)
        expect(senderData).toHaveBeenCalledTimes(1)
        expect(decrypt).toHaveBeenCalledTimes(1)
        const next = await group.sender.handle.encrypt(bytes)
        const transactions = f.storage.transactionCount()
        await seal()
        await f.adapters.execute('app.receive', [{ ciphertext: next, expectedAAD: opts.aad }])
        expect(f.storage.transactionCount() - transactions).toBe(0)
      } finally {
        pause?.release()
        await Promise.allSettled([startup, sealing, receiving])
        await f.storage.close()
        await group.close()
      }
    },
  )

  test('cancelled seals burn generations without installing late progress', async () => {
    const group = await fixture()
    const source = registrySourceExecutor(group.fixture().registry)
    const binding = await source.control.admit(group.key, 'source')
    const before = registryLeaseSnapshot(group.access())
    if (before === null) throw new Error('Missing lease')
    const pause = pauseMethod('encryptApplication')
    const abort = new AbortController()
    const stale = source.executor
      .execute({
        binding,
        command: 'app.seal',
        input: { plaintext: bytes, ...opts },
        signal: abort.signal,
      })
      .catch((error: unknown) => error)
    try {
      await pause.entered
      abort.abort(new Error('Cancelled seal'))
      await stale
      expect(
        group.fixture().registry.effectiveNext(group.key),
        'allocated range is burned before the suspended primitive settles',
      ).toBeGreaterThanOrEqual(before.limit)
      gateRegistryMaintenance(group.fixture().registry).release()
      await drainRegistryMaintenance(group.access())
      const fresh = await group.access().seal(bytes, opts)
      expect(fresh.generation).toBeGreaterThanOrEqual(before.limit)
      const progress = registryLeaseSnapshot(group.access())?.own
      pause.release()
      await flushReady()
      expect(registryLeaseSnapshot(group.access())?.own).toBe(progress)
    } finally {
      pause.release()
      await stale
      await group.close()
    }
  })

  test.each([false, true])(
    'saved pending replay does not call source commands (context=%s)',
    async (context) => {
      const group = await fixture('real-mls', context)
      try {
        const { encodeEventFrame } = await import('@kumiai/broadcast')
        const aad = encodeAppAAD({ topicID: 'saved-terminal', intent: 'log' })
        const ciphertext = await group.sender.handle.encrypt(
          encodeEventFrame('posted', { saved: true }),
          { aad },
        )
        const frame = {
          ...group.key,
          id: frameID('saved-terminal', ciphertext),
          topicID: 'saved-terminal',
          protocol: 'chat',
          segment: group.access().epoch(),
          position: '01',
        }
        await group.receiver().unwrap(ciphertext, { expectedAAD: aad, frame })
        const completion = createHandlerCompletion({
          persistence: group.fixture().device.groups,
          key: group.key,
        })
        await (await removal(group))()
        const source = registrySourceExecutor(group.fixture().registry)
        const commands = vi.spyOn(source.executor, 'execute')
        const before = group.fixture().restores()
        const records = await group.access().pending.list()
        expect(records).toHaveLength(1)
        const handle = vi.fn(async ({ tx, data }) => {
          expect(data).toEqual({ saved: true })
          await writeSideRow(tx, 'terminal-completion', new Uint8Array([1]))
        })
        const handler = createOpenedAppHandler({
          localDID: group.fixture().identity.id,
          protocols: { chat: { posted: { type: 'event', retain: 'log' } } },
          completion,
          openedDeliveryContext: createAsyncLocalOwnershipContext(),
          handlers: { chat: { posted: { mode: 'transactional', handle } } },
        })
        const record = records[0]
        if (record === undefined) throw new Error('Missing saved plaintext')
        await handler.deliver(record)
        expect(handle).toHaveBeenCalledOnce()
        expect(await group.access().pending.list()).toEqual([])
        expect(commands).not.toHaveBeenCalled()
        expect(group.fixture().restores()).toBe(before)
      } finally {
        await group.close()
      }
    },
  )

  test('managed entry labels remain local to their originating crypto adapter', async () => {
    const group = await fixture()
    try {
      const first = createGroupCrypto({ access: group.access(), entryLabel: 'entry-one' })
      const second = createGroupCrypto({ access: group.access(), entryLabel: 'entry-two' })
      const sealed = await first.sealEntries(bytes)
      expect(await first.openEntries(sealed.sealed)).toEqual(bytes)
      await expect(second.openEntries(sealed.sealed)).rejects.toThrow()
      expect(() => first.exportSecret('entry-one')).toThrow('reserved')
      expect(await second.exportSecret('entry-one')).toMatchObject({
        secret: expect.any(Uint8Array),
      })
    } finally {
      await group.close()
    }
  })
})
