import { commitKeyRotation, decodeClientState, encodeClientState, restoreGroup } from '@kumiai/mls'
import {
  type AdoptionExpected,
  applyChanges,
  asLogPosition,
  type ControlSlot,
  ControlWriteNotCommittedError,
  type GroupCrypto,
  type HostBuilt,
  type Operation,
  StorageOutcomeUnknownError,
} from '@kumiai/rpc'
import { createRuntime } from '@sozai/runtime'
import { expect, test, vi } from 'vitest'

import { simpleHandleAccess } from '../src/access.js'
import { createControlBuildPort, createPersistenceBuildSaver } from '../src/control-build.js'
import { decodeControlJournal, encodeControlJournal } from '../src/control-journal.js'
import { memoryFaults } from '../src/memory-faults.js'
import { createMemoryGroupPersistence } from '../src/memory-group-persistence.js'
import { createIncarnationStores } from '../src/memory-incarnation-stores.js'
import { createMemoryTransaction } from '../src/memory-transaction.js'
import { createOwnerQueues } from '../src/owner-queue.js'
import {
  DisplacedGroupHandleError,
  GroupStateConflictError,
  PersistencePhaseError,
  ReentrantOwnershipError,
} from '../src/persistence-errors.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
import { installSeed, makeStorageSeed, nextChange } from './fixtures/storage-seed.js'
import { createTransactionalStore } from './fixtures/transactional-access.js'

const intent: Operation & { stage: 'intent' } = {
  id: 'operation',
  kind: 'rotation',
  revokes: false,
  body: new Uint8Array(),
  seq: 1,
  enqueuedAt: 1,
  deadline: 30_001,
  stage: 'intent',
}

async function setup() {
  const key = { groupID: 'build', incarnation: 1 }
  const db = createMemoryTransaction({ rows: {} })
  let inTransaction = false
  const atRest = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(67) })
  const groups = createMemoryGroupPersistence({
    owners: createOwnerQueues(),
    db: {
      ...db,
      async transact(scope, work, options) {
        return db.transact(
          scope,
          async (tx) => {
            inTransaction = true
            try {
              return await work(tx)
            } finally {
              inTransaction = false
            }
          },
          options,
        )
      },
    },
    atRest,
    providerID: 'build',
  })
  const seed = await makeStorageSeed({
    id: key.groupID,
    incarnation: 1,
    epoch: 0,
    mode: 'real-mls',
  })
  await installSeed(groups, seed, 'seed')
  if (seed.state.state === null) throw new Error('missing seed state')
  const state = decodeClientState(seed.state.state)
  if (state == null) throw new Error('missing state')
  let handle = await restoreGroup({
    state,
    credential: seed.trust.credential,
    ledgerEntries: seed.state.ledger,
  })
  const control = groups.ports(key).control
  await control.apply({ putOperations: [intent], cursor: { position: null, epoch: 0 } }, 'intent')
  const access = simpleHandleAccess({
    handle: () => handle,
    adopt: () => {},
    stateVersion: async () => {
      const state = await groups.loadState(key)
      if (state === null) throw new Error('missing state row')
      return state.version
    },
  })
  let nestedAccessCalls = 0
  let owned = false
  const read = access.read
  const readControl = access.readControl
  access.read = (fn) => {
    if (owned) {
      nestedAccessCalls++
      throw new Error('nested access')
    }
    return read(fn)
  }
  access.readControl = (fn) => {
    if (owned) {
      nestedAccessCalls++
      throw new Error('nested control access')
    }
    return readControl(async (scope) => {
      owned = true
      try {
        return await fn(scope)
      } finally {
        owned = false
      }
    })
  }
  const cryptoTransactions: Array<boolean> = []
  const runtime = createRuntime()
  const sealRuntime = {
    ...runtime,
    getRandomValues: ((bytes) => {
      cryptoTransactions.push(inTransaction)
      return runtime.getRandomValues(bytes)
    }) as typeof runtime.getRandomValues,
  }
  const saver = createPersistenceBuildSaver({ persistence: groups, key })
  let buildCalls = 0
  let frameCalls = 0
  const build = async (_op: Operation, supplied: typeof handle): Promise<HostBuilt> => {
    expect(inTransaction).toBe(false)
    expect(supplied).toBe(handle)
    buildCalls++
    return {
      commit: new Uint8Array([1, 2]),
      epoch: Number(handle.epoch),
      incarnation: 1,
      authenticatorBefore: handle.state.keySchedule.epochAuthenticator.slice(),
      digest: 'commit',
      bodies: ['body'],
      journal: new Uint8Array([7, 8, 9]),
      welcome: { bytes: new Uint8Array([10]), recipients: ['recipient'] },
    }
  }
  const framed = { payload: new Uint8Array([1, 2, 3]), publishID: 'publish', expectedHead: null }
  const frame = async (_built: HostBuilt, seal: GroupCrypto['sealEntries']) => {
    expect(inTransaction).toBe(false)
    frameCalls++
    const result = await seal(new Uint8Array([4]))
    expect(result.epoch).toBe(0)
    return framed
  }
  const make = (saveBuilt = saver, now = () => 10) =>
    createControlBuildPort({
      access,
      control,
      build,
      saveBuilt,
      now,
      newID: () => crypto.randomUUID(),
      runtime: sealRuntime,
    })
  const source = async (): Promise<AdoptionExpected> =>
    access.readControl(async (scope) => scope.source)
  const slot = async (): Promise<ControlSlot> => ({
    opID: intent.id,
    epoch: 0,
    incarnation: 1,
    authenticatorBefore: handle.state.keySchedule.epochAuthenticator.slice(),
    digest: 'commit',
    payloadDigest: 'full-payload',
    ...framed,
    searchFrom: null,
    bodies: [],
    welcome: null,
    journal: encodeControlJournal({
      version: 1,
      source: await source(),
      checkpoint: null,
      sourceState: encodeClientState(handle.state),
      sourceCredential: handle.credential,
      sourceLedger: handle.ledgerTokens,
      candidate: new Uint8Array([7]),
    }),
  })
  return {
    key,
    db,
    groups,
    atRest,
    seed,
    setHandle: (next: typeof handle) => {
      handle = next
    },
    control,
    access,
    saver,
    make,
    source,
    slot,
    frame,
    framed,
    get handle() {
      return handle
    },
    counts: () => ({ buildCalls, frameCalls }),
    nestedAccessCalls: () => nestedAccessCalls,
    cryptoTransactions,
  }
}

test('raw built-save rejects changed version', async () => {
  const host = await setup()
  const built = await host.slot()
  const expected = await host.source()
  await host.control.apply(
    { putOutcomes: [{ id: 'other', opID: null, at: 3, kind: 'unknown' }] },
    'version',
  )
  const before = host.db.snapshot()
  expect(await host.saver(intent, built, expected, 'stale')).toBe('moved')
  expect(host.db.snapshot()).toEqual(before)
  expect(await host.control.lastMutation()).toBe('version')
})

test('version-only preparation retry refreshes under owned access', async () => {
  const host = await setup()
  let attempts = 0
  let secondExpected: AdoptionExpected | undefined
  let freshVersion: number | undefined
  const prematureOutcomes: Array<unknown> = []
  const publications: Array<Parameters<typeof fetch>> = []
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (...request) => {
    publications.push(request)
    throw new Error('Unexpected publication during preparation')
  })
  const port = host.make(async (op, slot, expected, id) => {
    attempts++
    if (attempts === 1) {
      await host.control.apply({ putOutcomes: [] }, 'bump')
      const state = await host.groups.loadState(host.key)
      if (state === null) throw new Error('Missing refreshed state')
      freshVersion = state.version
    } else secondExpected = expected
    prematureOutcomes.push(...(await host.control.load()).outcomes)
    return host.saver(op, slot, expected, id)
  })
  try {
    expect((await port.prepareBuild(intent, host.frame)).kind).toBe('saved')
    expect(attempts).toBe(2)
    expect(host.counts()).toEqual({ buildCalls: 1, frameCalls: 1 })
    const saved = await host.control.load()
    if (saved.commitOnce === null) throw new Error('missing slot')
    expect(saved.commitOnce?.payload).toEqual(host.framed.payload)
    expect(saved.commitOnce?.publishID).toBe(host.framed.publishID)
    expect(secondExpected?.stateVersion).toBeGreaterThan(
      decodeControlJournal(saved.commitOnce.journal).source.stateVersion,
    )
    prematureOutcomes.push(...saved.outcomes)
    expect(secondExpected?.stateVersion).toBe(freshVersion)
    expect(host.nestedAccessCalls()).toBe(0)
    expect(prematureOutcomes).toEqual([])
    expect(publications).toEqual([])
  } finally {
    network.mockRestore()
  }
})

test.each(['key', 'epoch', 'authenticator', 'checkpoint', 'cursor epoch', 'queue'] as const)(
  'raw built-save rejects a moved guard without access refresh: %s',
  async (move) => {
    const host = await setup()
    const built = await host.slot()
    const source = await host.source()
    if (source.identity === null) throw new Error('Missing identity')
    const expected =
      move === 'key' ? { ...source, key: { ...source.key, groupID: 'other' } } : source
    const transition = host.groups.transition
    host.groups.transition = (change, work) =>
      transition(change, async (stores) =>
        work({
          ...stores,
          incarnation: (incarnation) => {
            const rows = stores.incarnation(incarnation)
            return {
              ...rows,
              state: {
                ...rows.state,
                load: async () => {
                  const state = await rows.state.load()
                  if (state === null || state.deleted) throw new Error('Missing state')
                  if (move === 'epoch') return { ...state, epoch: state.epoch + 1 }
                  if (move === 'authenticator')
                    return { ...state, epochAuthenticator: new Uint8Array([0]) }
                  return state
                },
              },
              control: {
                ...rows.control,
                load: async () => {
                  const snapshot = await rows.control.load()
                  if (move === 'checkpoint')
                    snapshot.cursor = { position: asLogPosition('2'), epoch: 0 }
                  if (move === 'cursor epoch') snapshot.cursor = { position: null, epoch: 1 }
                  if (move === 'queue') snapshot.operations = [{ ...intent, id: 'first', seq: 0 }]
                  return snapshot
                },
              },
            }
          },
        }),
      )
    const before = host.db.snapshot()
    const marker = await host.control.lastMutation()
    expect(await host.saver(intent, built, expected, 'moved')).toBe('moved')
    expect(host.db.snapshot()).toEqual(before)
    expect(await host.control.lastMutation()).toBe(marker)
    expect(host.counts()).toEqual({ buildCalls: 0, frameCalls: 0 })
  },
)

test('preparation framing does not reenter access', async () => {
  const host = await setup()
  const nested = () => {
    throw new Error('nested access')
  }
  const readControl = host.access.readControl
  host.access.readControl = (fn) =>
    readControl(async (scope) => {
      host.access.read = nested
      host.access.readControl = nested
      return fn(scope)
    })
  expect((await host.make().prepareBuild(intent, host.frame)).kind).toBe('saved')
})

test('same-source direct and queued preparation share one slot', async () => {
  const host = await setup()
  const port = host.make()
  expect((await port.prepareBuild(intent, host.frame)).kind).toBe('saved')
  const second = { ...intent, id: 'second', seq: 2 }
  await host.control.apply({ deleteOperations: [intent.id], putOperations: [second] }, 'next')
  const result = await port.prepareBuild(second, host.frame)
  expect(result).toEqual({ kind: 'occupied', operation: second })
  expect(host.counts()).toEqual({ buildCalls: 1, frameCalls: 1 })
})

test('rolled-back save retries prepared bytes without another build', async () => {
  const host = await setup()
  const attempts: Array<ControlSlot> = []
  const port = host.make(async (op, slot, expected, id) => {
    attempts.push(structuredClone(slot))
    if (attempts.length === 1) {
      const transition = host.groups.transition
      host.groups.transition = (change, work) => {
        host.groups.transition = transition
        memoryFaults(host.db).failNext('before-commit')
        return transition(change, work)
      }
    }
    return host.saver(op, slot, expected, id)
  })
  expect((await port.prepareBuild(intent, host.frame)).kind).toBe('saved')
  expect(attempts).toHaveLength(2)
  expect(attempts[1]).toEqual(attempts[0])
  expect(host.counts()).toEqual({ buildCalls: 1, frameCalls: 1 })
})

test('built-save first logical operation write rolls back with slot', async () => {
  const host = await setup()
  const built = await host.slot()
  const expected = await host.source()
  const before = host.db.snapshot()
  memoryFaults(host.db).failNext('after-first-write')
  await expect(host.saver(intent, built, expected, 'rollback')).rejects.toThrow()
  expect(host.db.snapshot()).toEqual(before)
  expect((await host.control.load()).operations).toEqual([intent])
})

test('preparation and framing run outside provider transactions', async () => {
  const host = await setup()
  expect((await host.make().prepareBuild(intent, host.frame)).kind).toBe('saved')
  const slot = (await host.control.load()).commitOnce
  if (slot === null) throw new Error('missing slot')
  expect(host.cryptoTransactions).toEqual([false])
  const journal = decodeControlJournal(slot.journal)
  expect(journal.sourceState).toEqual(encodeClientState(host.handle.state))
  expect(journal.checkpoint).toBe(slot.searchFrom)
  expect(journal.candidate).toEqual(new Uint8Array([7, 8, 9]))
})

test('expired saved intent returns without construction or settlement', async () => {
  const host = await setup()
  expect(
    (await host.make(undefined, () => intent.deadline).prepareBuild(intent, host.frame)).kind,
  ).toBe('expired')
  expect(host.counts()).toEqual({ buildCalls: 0, frameCalls: 0 })
  expect((await host.control.load()).operations).toEqual([intent])
})

async function advance(host: Awaited<ReturnType<typeof setup>>, clear: boolean, raw = false) {
  const rotated = await commitKeyRotation(host.handle)
  const previous = await host.groups.loadState(host.key)
  const trust = await host.groups.loadTrust(host.key.groupID)
  if (previous === null || previous.deleted || trust === null) throw new Error('Missing source')
  const state = {
    ...previous,
    version: previous.version + 1,
    epoch: Number(rotated.newGroup.epoch),
    epochAuthenticator: rotated.newGroup.state.keySchedule.epochAuthenticator.slice(),
    state: encodeClientState(rotated.newGroup.state),
  }
  const change = await nextChange(host.groups, host.key.groupID, crypto.randomUUID())
  await host.groups.transition(change, async (stores) => {
    await stores.incarnation(1).state.save(state)
    await stores.trust.save({
      ...trust,
      installed: { ...host.key, epoch: state.epoch, authenticator: state.epochAuthenticator },
    })
    if (clear) {
      const control = raw
        ? createIncarnationStores({ tx: stores.tx, key: host.key, atRest: host.atRest }).control
        : stores.incarnation(1).control
      await control.apply({ commitOnce: null }, change.mutationID)
    }
  })
  host.setHandle(rotated.newGroup)
}

test('plain transaction-bound apply cannot clear after an earlier advance', async () => {
  const host = await setup()
  expect((await host.make().prepareBuild(intent, host.frame)).kind).toBe('saved')
  const slot = (await host.control.load()).commitOnce
  const before = host.db.snapshot()
  await expect(advance(host, true, true)).rejects.toThrow()
  expect(host.db.snapshot()).toEqual(before)
  await advance(host, false)
  await expect(host.control.apply({ commitOnce: null }, 'plain-clear')).rejects.toThrow()
  expect((await host.control.load()).commitOnce).toEqual(slot)
})

test('owning adoption clears with trust co-written before control', async () => {
  const host = await setup()
  expect((await host.make().prepareBuild(intent, host.frame)).kind).toBe('saved')
  await advance(host, true)
  expect((await host.control.load()).commitOnce).toBeNull()
})

test('owning adoption clears a slot built after the first epoch', async () => {
  const host = await setup()
  await advance(host, false)
  await host.control.apply({ cursor: { position: asLogPosition('1'), epoch: 1 } }, 'later-cursor')
  const built = await host.slot()
  const source = await host.source()
  built.epoch = 1
  built.authenticatorBefore = host.handle.state.keySchedule.epochAuthenticator.slice()
  built.searchFrom = asLogPosition('1')
  built.journal = encodeControlJournal({
    ...decodeControlJournal(built.journal),
    checkpoint: built.searchFrom,
  })
  expect(await host.saver(intent, built, source, 'later-build')).toBe('saved')
  await advance(host, true)
  expect((await host.control.load()).commitOnce).toBeNull()
})

test.each(['putOperations', 'putOutcomes'] as const)(
  'retirement clear cannot carry %s',
  async (field) => {
    const host = await setup()
    expect((await host.make().prepareBuild(intent, host.frame)).kind).toBe('saved')
    const before = host.db.snapshot()
    const change = await nextChange(host.groups, host.key.groupID, 'retire-with-writes')
    await expect(
      host.groups.transition(change, async (stores) => {
        const life = await stores.lifetime.load()
        if (life === null) throw new Error('Missing lifetime')
        await stores.lifetime.save({
          ...life,
          activeIncarnation: null,
          revision: life.revision + 1,
          mutationID: change.mutationID,
        })
        await stores.incarnation(1).control.apply(
          {
            commitOnce: null,
            [field]:
              field === 'putOperations'
                ? [intent]
                : [{ id: 'bad', opID: null, at: 1, kind: 'unknown' }],
          },
          change.mutationID,
        )
      }),
    ).rejects.toMatchObject({ name: 'DisplacedGroupHandleError' })
    expect(host.db.snapshot()).toEqual(before)
  },
)

test('owning retirement releases only its retained slot', async () => {
  const host = await setup()
  expect((await host.make().prepareBuild(intent, host.frame)).kind).toBe('saved')
  const change = await nextChange(host.groups, host.key.groupID, 'retire')
  await host.groups.transition(change, async (stores) => {
    const life = await stores.lifetime.load()
    if (life === null) throw new Error('Missing lifetime')
    await stores.lifetime.save({
      ...life,
      activeIncarnation: null,
      revision: life.revision + 1,
      mutationID: change.mutationID,
    })
    await stores.incarnation(1).control.apply({ commitOnce: null }, change.mutationID)
  })
  await expect(
    host.groups.transition(
      await nextChange(host.groups, host.key.groupID, 'plain-retired'),
      async (stores) => {
        await stores.incarnation(1).control.apply({ commitOnce: null }, 'plain-retired')
      },
    ),
  ).rejects.toMatchObject({ name: 'DisplacedGroupHandleError' })
  expect((await host.control.load()).commitOnce).toBeNull()
})

test('owning retirement releases a slot retained from an earlier epoch', async () => {
  const host = await setup()
  expect((await host.make().prepareBuild(intent, host.frame)).kind).toBe('saved')
  const slot = (await host.control.load()).commitOnce
  if (slot === null) throw new Error('Missing slot')
  await host.control.apply(
    {
      commitOnceAcceptance: {
        source: await host.source(),
        from: slot.searchFrom,
        position: asLogPosition('1'),
        payloadDigest: slot.payloadDigest,
      },
    },
    'accepted',
  )
  await advance(host, false)
  expect((await host.control.load()).commitOnce?.epoch).toBe(0)
  expect((await host.groups.loadState(host.key))?.deleted).toBe(false)
  expect(host.handle.epoch).toBe(1n)
  const before = host.db.snapshot()
  await expect(advance(host, true)).rejects.toMatchObject({ name: 'ControlStoreInvariantError' })
  expect(host.db.snapshot()).toEqual(before)
  const change = await nextChange(host.groups, host.key.groupID, 'retire-older-slot')
  await host.groups.transition(change, async (stores) => {
    const life = await stores.lifetime.load()
    if (life === null) throw new Error('Missing lifetime')
    await stores.lifetime.save({
      ...life,
      activeIncarnation: null,
      revision: life.revision + 1,
      mutationID: change.mutationID,
    })
    await stores.incarnation(1).control.apply({ commitOnce: null }, change.mutationID)
  })
  expect((await host.groups.load(host.key.groupID))?.activeIncarnation).toBeNull()
  expect(await host.groups.loadState(host.key)).toMatchObject({ deleted: true })
  const cleared = await host.control.load()
  expect(cleared.commitOnce).toBeNull()
  expect(cleared.commitOnceAcceptance).toBeNull()
})

test.each([
  { later: false, reopen: false },
  { later: false, reopen: true },
  { later: true, reopen: false },
  { later: true, reopen: true },
])(
  'real-provider absent cursor requires original installation: later=$later reopen=$reopen',
  async ({ later, reopen }) => {
    const host = await setup()
    await host.control.apply({ cursor: null }, 'absent-cursor')
    if (later) await advance(host, false)
    const groups = reopen
      ? createMemoryGroupPersistence({
          db: host.db,
          owners: createOwnerQueues(),
          atRest: host.atRest,
          providerID: 'build',
        })
      : host.groups
    const control = groups.ports(host.key).control
    const source = await host.source()
    const built = await host.slot()
    built.epoch = Number(host.handle.epoch)
    const before = host.db.snapshot()
    const marker = await control.lastMutation()
    expect((await control.load()).cursor).toBeNull()
    expect(
      await createPersistenceBuildSaver({ persistence: groups, key: host.key })(
        intent,
        built,
        source,
        'absent-cursor-build',
      ),
    ).toBe(later ? 'moved' : 'saved')
    if (later) {
      expect(host.db.snapshot()).toEqual(before)
      expect(await control.lastMutation()).toBe(marker)
    } else {
      expect((await control.load()).commitOnce).toEqual(built)
      expect((await control.load()).cursor).toBeNull()
    }
  },
)

test.each([false, true])(
  'transactional build with absent cursor requires retained initial identity: later=%s',
  async (later) => {
    const host = await setup()
    let store = createTransactionalStore(host.handle)
    if (later) {
      const rotated = await commitKeyRotation(host.handle)
      await store.save(
        store.snapshot().revision,
        encodeClientState(rotated.newGroup.state),
        rotated.newGroup.ledgerTokens,
      )
      host.setHandle(rotated.newGroup)
      store = await store.fork()
    }
    await store.control.apply({ putOperations: [intent] }, 'intent')
    const source = { ...(await host.source()), stateVersion: store.snapshot().revision }
    const slot = await host.slot()
    slot.epoch = Number(host.handle.epoch)
    slot.journal = encodeControlJournal({ ...decodeControlJournal(slot.journal), source })
    const before = structuredClone(store.snapshot())
    expect(await store.saveBuilt(intent, slot, source, 'null-build')).toBe(
      later ? 'moved' : 'saved',
    )
    if (later) expect(store.snapshot()).toEqual(before)
  },
)

test.each([
  new DisplacedGroupHandleError('displaced'),
  new ReentrantOwnershipError('reentrant'),
  new PersistencePhaseError('phase'),
  new GroupStateConflictError('conflict'),
  Object.assign(new Error('foreign conflict'), { name: 'GroupStateConflictError' }),
])('ambiguous resolver immediately propagates $name', async (fatal) => {
  const host = await setup()
  const original = host.groups.transition
  let resolves = 0
  host.groups.transition = async (change, work) => {
    await original(change, async (stores) =>
      work({
        ...stores,
        tx: { ...stores.tx, onCommit: () => {}, onRollback: () => {} },
        incarnation: (incarnation) => {
          const rows = stores.incarnation(incarnation)
          return { ...rows, control: { ...rows.control, apply: async () => {} } }
        },
      }),
    )
    throw new StorageOutcomeUnknownError('ambiguous backend')
  }
  host.groups.resolve = async () => {
    resolves++
    if (resolves === 1) throw fatal
    return 'committed'
  }
  const error = await host
    .saver(intent, await host.slot(), await host.source(), 'unknown')
    .catch((error: unknown) => error)
  expect(error).toBe(fatal)
  expect(resolves).toBe(1)
})

test('deterministic reducer rejection surfaces without retry or expiry', async () => {
  const host = await setup()
  let rejection: unknown
  try {
    applyChanges(await host.control.load(), { commitOnce: await host.slot() })
  } catch (error) {
    rejection = error
  }
  expect(rejection).toBeInstanceOf(Error)
  const original = host.groups.transition
  let attempts = 0
  host.groups.transition = (change, work) =>
    original(change, async (stores) => {
      attempts++
      return work({
        ...stores,
        incarnation: (incarnation) => {
          const rows = stores.incarnation(incarnation)
          return {
            ...rows,
            control: {
              ...rows.control,
              apply: async () => {
                throw rejection
              },
            },
          }
        },
      })
    })
  const before = host.db.snapshot()
  let now = 10
  const error = await host
    .make(undefined, () => {
      now += 10_000
      return now
    })
    .prepareBuild(intent, host.frame)
    .catch((error: unknown) => error)
  expect(error).toBe(rejection)
  expect(attempts).toBe(1)
  expect(host.db.snapshot()).toEqual(before)
})

test('save rollback retries have backoff and a finite attempt bound', async () => {
  const host = await setup()
  vi.useFakeTimers()
  try {
    const at: Array<number> = []
    const first = Promise.withResolvers<void>()
    const failure = new ControlWriteNotCommittedError('rollback')
    const preparing = host
      .make(async () => {
        at.push(Date.now())
        first.resolve()
        if (at.length > 8) throw new Error('retry bound exceeded')
        throw failure
      })
      .prepareBuild(intent, host.frame)
      .catch((error: unknown) => error)
    await first.promise
    await vi.runAllTimersAsync()
    expect(await preparing).toBe(failure)
    expect(at).toHaveLength(8)
    expect(at.slice(1).map((time, i) => time - (at[i] ?? time))).toEqual([
      100, 200, 400, 800, 1600, 3200, 6400,
    ])
    expect(host.counts()).toEqual({ buildCalls: 1, frameCalls: 1 })
  } finally {
    vi.useRealTimers()
  }
})

test('malformed journal surfaces before entering a transition', async () => {
  const host = await setup()
  const slot = await host.slot()
  slot.journal = new Uint8Array([0])
  const transition = vi.spyOn(host.groups, 'transition')
  await expect(host.saver(intent, slot, await host.source(), 'malformed')).rejects.toThrow()
  expect(transition).not.toHaveBeenCalled()
})

test('rolled-back storage write retries the same prepared bytes', async () => {
  const host = await setup()
  let attempts = 0
  const prepared: Array<ControlSlot> = []
  const port = host.make(async (op, built, expected, id) => {
    attempts++
    prepared.push(structuredClone(built))
    if (attempts === 1) {
      const transition = host.groups.transition
      host.groups.transition = (change, work) => {
        host.groups.transition = transition
        return transition(change, async (stores) => {
          memoryFaults(host.db).failNext('after-first-write')
          return work(stores)
        })
      }
    }
    return host.saver(op, built, expected, id)
  })
  expect((await port.prepareBuild(intent, host.frame)).kind).toBe('saved')
  expect(attempts).toBe(2)
  expect(prepared[1]).toEqual(prepared[0])
  expect(host.counts()).toEqual({ buildCalls: 1, frameCalls: 1 })
})

test.each(['key', 'epoch', 'authenticator', 'checkpoint', 'cursor epoch', 'queue'] as const)(
  'built-save rejects an identity checkpoint or queue move: %s',
  async (move) => {
    const host = await setup()
    let before: ReturnType<typeof host.db.snapshot> | undefined
    const port = host.make(async (op, slot, captured, id) => {
      let expected = captured
      const identity = captured.identity
      if (identity === null) throw new Error('Missing identity')
      if (move === 'key') expected = { ...expected, key: { ...expected.key, groupID: 'other' } }
      if (move === 'epoch') expected = { ...expected, identity: { ...identity, epoch: 1 } }
      if (move === 'authenticator')
        expected = {
          ...expected,
          identity: { ...identity, authenticator: new Uint8Array([0]) },
        }
      if (move === 'checkpoint')
        await host.control.apply({ cursor: { position: asLogPosition('2'), epoch: 0 } }, 'move')
      if (move === 'cursor epoch')
        await host.control.apply({ cursor: { position: null, epoch: 1 } }, 'move')
      if (move === 'queue')
        await host.control.apply({ putOperations: [{ ...intent, id: 'first', seq: 0 }] }, 'move')
      before = host.db.snapshot()
      return host.saver(op, slot, expected, id)
    })
    expect((await port.prepareBuild(intent, host.frame)).kind).toBe('moved')
    expect(host.db.snapshot()).toEqual(before)
    expect(host.counts()).toEqual({ buildCalls: 1, frameCalls: 1 })
  },
)
