import {
  bindMemoryGroupPorts,
  createMemoryGroupPorts,
  UnchangedGroupResult,
} from './memory-group-ports.js'
import {
  bindMemoryOwner,
  createGroupStateStores,
  createUnlockedGroupStateStores,
  sequenceMemoryCoordinator,
  sequenceMemoryOperation,
  withoutMemoryCoordinator,
} from './memory-group-state.js'
import {
  type ControlRecord,
  copyStoredValue,
  createIncarnationStores,
  createUnlockedIncarnationStores,
  type GroupOwnerMarker,
  groupOwnerKey,
  memoryRecordTable,
  sameStoredValue,
} from './memory-incarnation-stores.js'
import type { OwnerEntry, OwnerQueues } from './owner-queue.js'
import { physicalRecordKey, sealRecord } from './persistence-codec.js'
import {
  DisplacedGroupHandleError,
  GroupStateConflictError,
  GroupStateUncertainError,
  ReentrantOwnershipError,
  StorageOutcomeUnknownError,
} from './persistence-errors.js'
import { assertStateTransition, assertTrustTransition } from './persistence-guards.js'
import type {
  AppStatusEvent,
  AtRestCodec,
  GroupKey,
  GroupLifetime,
  GroupPersistence,
  GroupRecoveryTrust,
  GroupStateRecord,
  GroupStores,
  GroupTransition,
  MemoryDatabase,
  MemoryStoreRows,
  MemoryTransaction,
  OwnershipContextPort,
  TransactionalGroupEffects,
  TransactionHookSettlement,
} from './persistence-types.js'

type Proof = {
  previous: GroupOwnerMarker | null
  revision: number
  settlement?: TransactionHookSettlement
  outcome?: 'committed' | 'rolled-back'
}
type GroupOperation = {
  groupID: string
  key: GroupKey
  active: boolean
  mutationID: string
  check?(stores: GroupStores<MemoryTransaction>): Promise<void>
}

type Binding = { providerID: string; owners: OwnerQueues; proofs: Map<string, Proof> }
const bindings = new WeakMap<MemoryDatabase, Binding>()
const proofKey = (groupID: string, mutationID: string) => JSON.stringify([groupID, mutationID])
const scope = (groupID: string) => ({ groupID, devicePackages: false })

export function memoryGroupOwnerQueues(db: MemoryDatabase): OwnerQueues | undefined {
  return bindings.get(db)?.owners
}

function owner(tx: MemoryTransaction, groupID: string): GroupOwnerMarker | null {
  const value = tx.rows['group-owner']?.get(groupOwnerKey(groupID))
  if (value === undefined || sameStoredValue(value, { mutationID: null, revision: 0 })) return null
  if (
    value === null ||
    typeof value !== 'object' ||
    !('revision' in value) ||
    !('mutationID' in value) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    typeof value.mutationID !== 'string'
  )
    throw new GroupStateConflictError('Unreadable group ownership marker')
  return value as GroupOwnerMarker
}

function snapshot(tx: MemoryTransaction): MemoryStoreRows {
  return Object.fromEntries(
    Object.entries(tx.rows).map(([namespace, rows]) => [namespace, new Map(rows)]),
  )
}

function changedIncarnations(
  before: MemoryStoreRows,
  after: MemoryStoreRows,
  groupID: string,
): Map<number, Set<string>> {
  const result = new Map<number, Set<string>>()
  for (const namespace of [
    'state',
    'control',
    'anchor',
    'pending',
    'poison',
    'cursor',
    'outbox',
    'meta',
  ]) {
    const previous = before[namespace] ?? new Map()
    const next = after[namespace] ?? new Map()
    for (const key of new Set([...previous.keys(), ...next.keys()])) {
      if (sameStoredValue(previous.get(key), next.get(key))) continue
      const address = JSON.parse(key) as [string, number | null, string]
      if (address[0] !== groupID || address[1] === null) continue
      const namespaces = result.get(address[1]) ?? new Set<string>()
      namespaces.add(namespace)
      result.set(address[1], namespaces)
    }
  }
  return result
}

export function createMemoryGroupCoordinator(params: {
  db: MemoryDatabase
  owners: OwnerQueues
  atRest: AtRestCodec
  providerID: string
  effects?: TransactionalGroupEffects<MemoryTransaction>
  ownershipContext?: OwnershipContextPort
}) {
  const { db, owners, atRest, providerID, effects } = params
  if (atRest == null || typeof atRest.seal !== 'function' || typeof atRest.open !== 'function')
    throw new TypeError('Expected callable at-rest seal and open')
  let binding = bindings.get(db)
  if (binding === undefined) {
    binding = { providerID, owners, proofs: new Map() }
    bindings.set(db, binding)
  } else if (binding.providerID !== providerID)
    throw new GroupStateConflictError('Persistence provider mismatch')
  if (binding.owners !== owners)
    throw new GroupStateConflictError('Persistence ownership queue mismatch')
  const proofs = binding.proofs
  const boundTx = (tx: MemoryTransaction, entry?: OwnerEntry): MemoryTransaction => {
    if (entry !== undefined) bindMemoryOwner(tx, entry, owners)
    return {
      ...tx,
      providerID,
      onCommit: entry === undefined ? tx.onCommit : (hook) => entry.onCommit(hook),
      onRollback: entry === undefined ? tx.onRollback : (hook) => entry.onRollback(hook),
    }
  }
  const basicStores = (tx: MemoryTransaction, groupID: string): GroupStores<MemoryTransaction> => {
    const bound = boundTx(tx)
    const states = createGroupStateStores({ tx: bound, groupID, atRest })
    return {
      ...states,
      incarnation: (incarnation) =>
        createIncarnationStores({ tx: bound, key: { groupID, incarnation }, atRest }),
    }
  }
  async function prepare(entry: OwnerEntry, groupID: string): Promise<void> {
    await entry.enter('prepare')
    const key = JSON.stringify(['group', groupID])
    if (!owners.started(key)) {
      await db.completionBarrier(scope(groupID))
      if (owners.failure !== null) throw owners.failure
      try {
        await db.transact(scope(groupID), async (tx) => owner(tx, groupID))
      } catch (error) {
        if (error instanceof GroupStateConflictError) owners.failStop(error)
        throw error
      }
      owners.markStarted(key)
    }
    await entry.enter('work')
  }
  async function readOwned<TValue>(
    entry: OwnerEntry,
    groupID: string,
    work: (stores: GroupStores<MemoryTransaction>) => Promise<TValue>,
  ): Promise<TValue> {
    await prepare(entry, groupID)
    return await db.transact(scope(groupID), async (baseTx) => {
      const tx = boundTx(baseTx, entry)
      try {
        return await work(basicStores(tx, groupID))
      } finally {
        await entry.enter('outcome')
      }
    })
  }
  function read<TValue>(
    groupID: string,
    work: (stores: GroupStores<MemoryTransaction>) => Promise<TValue>,
  ): Promise<TValue> {
    return owners.run('read', { groupID, ownerDID: null }, (entry) =>
      readOwned(entry, groupID, work),
    )
  }
  async function prove(
    groupID: string,
    mutationID: string,
    proof: Proof,
  ): Promise<'committed' | 'rolled-back'> {
    if (owners.failure !== null) throw owners.failure
    await db.completionBarrier(scope(groupID))
    if (owners.failure !== null) throw owners.failure
    let marker: GroupOwnerMarker | null
    try {
      marker = await db.transact(scope(groupID), async (tx) => owner(tx, groupID))
    } catch (error) {
      if (error instanceof GroupStateConflictError) owners.failStop(error)
      throw error
    }
    const outcome =
      marker?.mutationID === mutationID
        ? 'committed'
        : sameStoredValue(marker, proof.previous)
          ? 'rolled-back'
          : undefined
    if (outcome === undefined) {
      const error = new GroupStateConflictError('Group ownership conflict')
      owners.failStop(error)
      throw error
    }
    proof.settlement?.settle(outcome)
    proof.outcome = outcome
    return outcome
  }
  async function resolve(
    groupID: string,
    mutationID: string,
  ): Promise<'committed' | 'rolled-back'> {
    // Root reentrancy also applies when a resolver would otherwise join an active proof.
    if (owners.current() !== undefined)
      return await owners.run('read', { groupID, ownerDID: null }, async () => 'committed' as const)
    if (owners.failure !== null) throw owners.failure
    const pending = owners.joinProof({ groupID }, mutationID)
    if (pending !== null) return await pending
    return await owners.run('read', { groupID, ownerDID: null }, async (entry) => {
      await entry.enter('prepare')
      await db.completionBarrier(scope(groupID))
      if (owners.failure !== null) throw owners.failure
      let marker: GroupOwnerMarker | null
      try {
        marker = await db.transact(scope(groupID), async (tx) => owner(tx, groupID))
      } catch (error) {
        if (error instanceof GroupStateConflictError) owners.failStop(error)
        throw error
      }
      owners.markStarted(JSON.stringify(['group', groupID]))
      await entry.enter('outcome')
      if (marker?.mutationID === mutationID) return 'committed' as const
      throw new GroupStateUncertainError('Group mutation is superseded or unclassifiable')
    })
  }
  async function transitionOwned<TValue>(
    request: GroupTransition | GroupOperation,
    work: (stores: GroupStores<MemoryTransaction>, mutationID: string) => Promise<TValue>,
    entry: OwnerEntry,
    participantTx?: MemoryTransaction,
  ): Promise<TValue> {
    let proof: Proof | undefined
    let id: string | undefined
    let result!: TValue
    try {
      const transact: MemoryDatabase['transact'] =
        participantTx === undefined
          ? (scope, fn, options) => db.transact(scope, fn, options)
          : async (_scope, fn) => await fn(participantTx)
      return await transact(
        scope(request.groupID),
        async (baseTx) => {
          const tx = boundTx(baseTx, entry)
          try {
            const raw = createUnlockedGroupStateStores({
              tx,
              groupID: request.groupID,
              atRest,
            })
            const previous = await entry.sequence(raw.lifetime.load)
            const marker = owner(tx, request.groupID)
            let change: GroupTransition
            if ('key' in request) {
              if (
                previous === null ||
                (request.active && previous.activeIncarnation !== request.key.incarnation)
              )
                throw new DisplacedGroupHandleError('Inactive group incarnation')
              await request.check?.(basicStores(baseTx, request.groupID))
              change = {
                groupID: request.groupID,
                mutationID: request.mutationID,
                expected: {
                  revision: previous.revision,
                  activeIncarnation: previous.activeIncarnation,
                },
              }
            } else change = request
            if (
              change.expected === null
                ? previous !== null || marker !== null
                : previous === null ||
                  previous.revision !== change.expected.revision ||
                  previous.activeIncarnation !== change.expected.activeIncarnation ||
                  marker?.revision !== previous.revision ||
                  marker.mutationID !== previous.mutationID
            )
              throw new GroupStateConflictError('Group lifetime conflict')
            proof = {
              previous: marker,
              revision: (change.expected?.revision ?? 0) + 1,
            }
            id = proofKey(change.groupID, change.mutationID)
            const prior = proofs.get(id)
            if (prior !== undefined && prior.outcome !== 'rolled-back')
              throw new GroupStateConflictError('Mutation ID already used; resolve its proof')
            proofs.set(id, proof)
            if (participantTx !== undefined) {
              const retainedProof = proof
              tx.onCommit(() => {
                retainedProof.outcome = 'committed'
              })
              tx.onRollback(() => {
                retainedProof.outcome = 'rolled-back'
              })
            }
            const revision = proof.revision
            const before = snapshot(tx)
            tx.rows['group-owner']?.set(groupOwnerKey(change.groupID), {
              revision,
              mutationID: change.mutationID,
            })
            let proposedLifetime: GroupLifetime | undefined
            let proposedTrust: GroupRecoveryTrust | undefined
            const savedStates = new Map<number, GroupStateRecord>()
            let previousTrust: GroupRecoveryTrust | null | undefined
            async function retainedTrust() {
              if (previousTrust === undefined) previousTrust = await raw.trust.load()
              return previousTrust
            }
            const unlockedStores: GroupStores<MemoryTransaction> = {
              tx,
              lifetime: {
                load: () => raw.lifetime.load(),
                async save(value) {
                  const next = copyStoredValue(value)
                  if (
                    next.groupID !== change.groupID ||
                    next.revision !== revision ||
                    next.mutationID !== change.mutationID ||
                    !Number.isSafeInteger(next.latestIncarnation) ||
                    next.latestIncarnation < 1 ||
                    (next.activeIncarnation !== null &&
                      next.activeIncarnation !== next.latestIncarnation)
                  )
                    throw new GroupStateConflictError('Invalid proposed lifetime')
                  if (
                    previous === null
                      ? next.latestIncarnation !== 1 || next.activeIncarnation !== 1
                      : next.latestIncarnation !== previous.latestIncarnation &&
                        next.latestIncarnation !== previous.latestIncarnation + 1
                  )
                    throw new GroupStateConflictError('Incarnation sequence conflict')
                  if (
                    previous !== null &&
                    next.latestIncarnation > previous.latestIncarnation &&
                    next.activeIncarnation !== next.latestIncarnation
                  )
                    throw new GroupStateConflictError('New incarnation requires installation')
                  if (
                    previous !== null &&
                    next.latestIncarnation === previous.latestIncarnation &&
                    next.activeIncarnation !== null &&
                    next.activeIncarnation !== previous.activeIncarnation
                  )
                    throw new GroupStateConflictError('Retired incarnation cannot reactivate')
                  if (
                    previous?.restorePending &&
                    !next.restorePending &&
                    next.latestIncarnation === previous.latestIncarnation
                  )
                    throw new GroupStateConflictError('Restore requires a fresh incarnation')
                  proposedLifetime = next
                  await raw.lifetime.save(next)
                },
              },
              trust: {
                async load() {
                  tx.rows.trust
                  return proposedTrust === undefined
                    ? await raw.trust.load()
                    : copyStoredValue(proposedTrust)
                },
                async save(value) {
                  tx.rows.trust
                  const owned = copyStoredValue(value)
                  assertTrustTransition(proposedTrust ?? (await retainedTrust()), owned)
                  proposedTrust = owned
                },
              },
              incarnation(incarnation) {
                const rows = createIncarnationStores({
                  tx,
                  key: { groupID: change.groupID, incarnation },
                  atRest,
                })
                const state: ReturnType<typeof raw.state> = {
                  load: rows.state.load,
                  async save(value) {
                    const owned = copyStoredValue(value)
                    if (
                      owned.groupID !== change.groupID ||
                      owned.incarnation !== incarnation ||
                      savedStates.has(incarnation)
                    )
                      throw new GroupStateConflictError('State identity or version conflict')
                    const life = proposedLifetime ?? previous
                    if (
                      life?.activeIncarnation !== incarnation &&
                      !(
                        owned.deleted &&
                        previous?.activeIncarnation === incarnation &&
                        life?.activeIncarnation !== incarnation
                      )
                    )
                      throw new DisplacedGroupHandleError('Inactive state writer')
                    await retainedTrust()
                    await raw.state(incarnation).save(owned)
                    savedStates.set(incarnation, owned)
                  },
                }
                return {
                  ...rows,
                  state: {
                    load: state.load,
                    save: sequenceMemoryOperation(tx, state.save, 'domain'),
                  },
                }
              },
            }
            const stores: GroupStores<MemoryTransaction> = {
              ...unlockedStores,
              lifetime: {
                load: sequenceMemoryOperation(tx, unlockedStores.lifetime.load),
                save: sequenceMemoryOperation(tx, unlockedStores.lifetime.save, 'domain'),
              },
              trust: {
                load: sequenceMemoryOperation(tx, unlockedStores.trust.load),
                save: sequenceMemoryOperation(tx, unlockedStores.trust.save, 'domain'),
              },
            }
            result = await work(stores, change.mutationID)
            await entry.enter('finalise')
            const { outboxEvents, deletedKeys } = await sequenceMemoryCoordinator(
              entry,
              async () => {
                const life =
                  proposedLifetime ??
                  (previous === null
                    ? undefined
                    : { ...previous, revision, mutationID: change.mutationID })
                if (life === undefined)
                  throw new GroupStateConflictError('Initial transition requires a lifetime')
                const installing =
                  previous === null ||
                  (life.activeIncarnation !== null &&
                    life.activeIncarnation !== previous.activeIncarnation)
                if (installing) {
                  const candidate = savedStates.get(life.activeIncarnation as number)
                  const trust = proposedTrust
                  if (
                    candidate === undefined ||
                    candidate.deleted ||
                    trust === undefined ||
                    trust.installed.incarnation !== candidate.incarnation ||
                    trust.installed.epoch !== candidate.epoch ||
                    !sameStoredValue(trust.installed.authenticator, candidate.epochAuthenticator)
                  )
                    throw new GroupStateConflictError(
                      'Installation requires matching co-written state and trust',
                    )
                  if (previous !== null && (await retainedTrust()) === null)
                    throw new GroupStateConflictError('Existing lifetime requires retained trust')
                }
                for (const [incarnation, next] of savedStates) {
                  // Tombstone counters were validated without opening private state.
                  if (next.deleted) continue
                  const oldBytes = before.state?.get(
                    physicalRecordKey({
                      groupID: change.groupID,
                      incarnation,
                      namespace: 'state',
                      recordID: 'current',
                    }),
                  )
                  const original =
                    oldBytes === undefined
                      ? null
                      : await memoryRecordTable<GroupStateRecord>({
                          tx: { ...tx, rows: before },
                          key: { groupID: change.groupID, incarnation },
                          namespace: 'state',
                          atRest,
                        }).load('current')
                  if (
                    !next.deleted &&
                    (original === null || original.deleted || original.epoch !== next.epoch)
                  ) {
                    const trust = proposedTrust
                    if (
                      trust === undefined ||
                      trust.installed.incarnation !== incarnation ||
                      trust.installed.epoch !== next.epoch ||
                      !sameStoredValue(trust.installed.authenticator, next.epochAuthenticator)
                    )
                      throw new GroupStateConflictError('Identity change requires matching trust')
                    assertStateTransition(original, next, await retainedTrust())
                    if (
                      !trust.spentEpochAuthenticators.some((value) =>
                        sameStoredValue(value, next.epochAuthenticator),
                      )
                    )
                      trust.spentEpochAuthenticators.push(Uint8Array.from(next.epochAuthenticator))
                  }
                }
                if (
                  previous?.activeIncarnation !== null &&
                  previous?.activeIncarnation !== undefined &&
                  life.activeIncarnation !== previous.activeIncarnation
                ) {
                  const source = await raw.stateMetadata(previous.activeIncarnation).load()
                  if (source === null || !source.deleted) {
                    const tombstone: GroupStateRecord = {
                      groupID: change.groupID,
                      incarnation: previous.activeIncarnation,
                      version: (source?.version ?? 0) + 1,
                      deleted: true,
                    }
                    await raw.state(previous.activeIncarnation).save(tombstone)
                    savedStates.set(previous.activeIncarnation, tombstone)
                  }
                }
                if (
                  life.activeIncarnation !== null &&
                  savedStates.get(life.activeIncarnation)?.deleted
                )
                  throw new GroupStateConflictError('Active incarnation cannot be deleted')
                if (proposedTrust !== undefined) {
                  const retained = await retainedTrust()
                  if (
                    retained === null ||
                    !sameStoredValue(retained.installed, proposedTrust.installed)
                  ) {
                    const candidate = savedStates.get(proposedTrust.installed.incarnation)
                    if (
                      candidate === undefined ||
                      candidate.deleted ||
                      candidate.epoch !== proposedTrust.installed.epoch ||
                      !sameStoredValue(
                        candidate.epochAuthenticator,
                        proposedTrust.installed.authenticator,
                      )
                    )
                      throw new GroupStateConflictError(
                        'Installed trust requires matching co-written state',
                      )
                  }
                  await raw.trust.save(proposedTrust)
                }
                const after = snapshot(tx)
                const affected = changedIncarnations(before, after, change.groupID)
                if (
                  life.activeIncarnation !== null &&
                  (!sameStoredValue(before.trust, after.trust) ||
                    (previous !== null && previous.restorePending !== life.restorePending))
                ) {
                  const namespaces = affected.get(life.activeIncarnation) ?? new Set<string>()
                  namespaces.add('trust')
                  affected.set(life.activeIncarnation, namespaces)
                }
                for (const [incarnation, namespaces] of affected) {
                  if (savedStates.has(incarnation)) continue
                  let state: GroupStateRecord | null
                  try {
                    state = await raw.state(incarnation).load()
                  } catch (error) {
                    if (
                      [...namespaces].every(
                        (namespace) => namespace === 'control' || namespace === 'meta',
                      )
                    )
                      continue
                    throw error
                  }
                  if (state !== null && !state.deleted) {
                    const address = {
                      groupID: change.groupID,
                      incarnation,
                      namespace: 'state',
                      recordID: 'current',
                    }
                    // Metadata versioning does not reopen recovery trust or run candidate admission.
                    tx.rows.state?.set(
                      physicalRecordKey(address),
                      await withoutMemoryCoordinator(() =>
                        sealRecord(atRest, address, { ...state, version: state.version + 1 }),
                      ),
                    )
                    await raw.stateMetadata(incarnation).save({
                      groupID: change.groupID,
                      incarnation,
                      version: state.version + 1,
                      deleted: false,
                    })
                  }
                }
                if (proposedLifetime === undefined) await raw.lifetime.save(life)
                const outboxEvents: Array<AppStatusEvent> = []
                if (effects?.outbox !== undefined) {
                  for (const [incarnation, namespaces] of changedIncarnations(
                    before,
                    snapshot(tx),
                    change.groupID,
                  )) {
                    if (!namespaces.has('meta')) continue
                    const oldEvents = new Set(
                      (
                        await createUnlockedIncarnationStores({
                          tx: { ...tx, rows: before },
                          key: { groupID: change.groupID, incarnation },
                          atRest,
                        }).meta.events()
                      ).map((event) => event.id),
                    )
                    for (const event of await createUnlockedIncarnationStores({
                      tx,
                      key: { groupID: change.groupID, incarnation },
                      atRest,
                    }).meta.events()) {
                      if (
                        !oldEvents.has(event.id) &&
                        (event.kind === 'accepted' ||
                          event.kind === 'published' ||
                          event.kind === 'failed')
                      )
                        outboxEvents.push(event)
                    }
                  }
                }
                const deletedKeys: Array<GroupKey> = []
                if (effects?.delete !== undefined)
                  for (const [incarnation, state] of savedStates)
                    if (state.deleted) deletedKeys.push({ groupID: change.groupID, incarnation })
                return { outboxEvents, deletedKeys }
              },
            )
            const beforeEffects = snapshot(tx)
            await entry.enter('effects')
            for (const event of outboxEvents) await effects?.outbox?.(tx, event)
            for (const key of deletedKeys) await effects?.delete?.(tx, key)
            await entry.enter('account')
            await sequenceMemoryCoordinator(entry, async () => {
              const affected = changedIncarnations(beforeEffects, snapshot(tx), change.groupID)
              const life = await raw.lifetime.load()
              for (const [incarnation, namespaces] of affected) {
                if (life === null || incarnation > life.latestIncarnation)
                  throw new DisplacedGroupHandleError('Effect wrote an unknown incarnation')
                // Once per transition, including incarnations first touched by an effect.
                const metadata = await raw.stateMetadata(incarnation).load()
                const original = await createUnlockedGroupStateStores({
                  tx: { ...tx, rows: before },
                  groupID: change.groupID,
                  atRest,
                })
                  .stateMetadata(incarnation)
                  .load()
                if (metadata === null || metadata.deleted || metadata.version !== original?.version)
                  continue
                let state: GroupStateRecord | null
                try {
                  state = await raw.state(incarnation).load()
                } catch (error) {
                  if ([...namespaces].every((name) => name === 'control' || name === 'meta'))
                    continue
                  throw error
                }
                if (state === null || state.deleted) continue
                const address = {
                  groupID: change.groupID,
                  incarnation,
                  namespace: 'state',
                  recordID: 'current',
                }
                tx.rows.state?.set(
                  physicalRecordKey(address),
                  await withoutMemoryCoordinator(() =>
                    sealRecord(atRest, address, { ...state, version: state.version + 1 }),
                  ),
                )
                await raw
                  .stateMetadata(incarnation)
                  .save({ ...metadata, version: state.version + 1 })
              }
            })
            return result
          } finally {
            if (participantTx === undefined && owners.failure === null) await entry.enter('outcome')
          }
        },
        {
          onUnknown(settlement) {
            if (proof !== undefined) {
              proof.settlement = settlement
              const retainedProof = proof
              void entry.retain(() => prove(request.groupID, request.mutationID, retainedProof))
            }
          },
        },
      )
    } catch (error) {
      if (error instanceof UnchangedGroupResult) {
        if (id !== undefined) proofs.delete(id)
        return error.value as TValue
      }
      if (participantTx !== undefined || !(error instanceof StorageOutcomeUnknownError)) {
        if (proof !== undefined) proof.outcome = 'rolled-back'
        throw error
      }
      if (id === undefined || proof === undefined) throw error
      const mutationID = (JSON.parse(id) as [string, string])[1]
      const pending = owners.joinProof({ groupID: request.groupID }, mutationID)
      if (pending !== null && (await pending) === 'committed') return result
      throw error
    } finally {
      if (
        participantTx === undefined &&
        proof !== undefined &&
        proof.outcome === undefined &&
        proof.settlement === undefined
      )
        proof.outcome = 'committed'
      if (
        participantTx === undefined &&
        proof?.settlement === undefined &&
        owners.failure === null &&
        entry.phase === 'outcome'
      )
        entry.settle(proof?.outcome ?? 'rolled-back')
    }
  }
  const groups: GroupPersistence<MemoryTransaction> = {
    load: (groupID) => read(groupID, (stores) => stores.lifetime.load()),
    loadState: (key) =>
      read(key.groupID, (stores) => stores.incarnation(key.incarnation).state.load()),
    loadTrust: (groupID) => read(groupID, (stores) => stores.trust.load()),
    async list() {
      if (owners.failure !== null) throw owners.failure
      if (owners.current() !== undefined)
        throw new ReentrantOwnershipError('Root persistence call inside an owner entry')
      const ids = new Set<string>()
      for (const key of db.snapshot().lifetime?.keys() ?? [])
        ids.add((JSON.parse(key) as [string])[0])
      const values: Array<GroupLifetime> = []
      for (const id of [...ids].sort()) {
        const value = await groups.load(id)
        if (value !== null) values.push(value)
      }
      return values
    },
    ports: (key) => createMemoryGroupPorts({ groups, key }),
    transition: (change, work) => {
      const owned = copyStoredValue(change)
      return owners.run(
        'transition',
        { groupID: owned.groupID, ownerDID: null },
        async (entry) => {
          await prepare(entry, owned.groupID)
          return await transitionOwned(owned, work, entry)
        },
        { mutationID: owned.mutationID },
      )
    },
    resolve,
  }
  bindMemoryGroupPorts(groups, {
    read: (key, work) => read(key.groupID, work),
    write: (key, work, options) => {
      const mutationID = options?.mutationID ?? crypto.randomUUID()
      return owners.run(
        'transition',
        { groupID: key.groupID, ownerDID: null },
        async (entry) => {
          await prepare(entry, key.groupID)
          return await transitionOwned(
            {
              groupID: key.groupID,
              key,
              active: options?.active ?? false,
              mutationID: mutationID,
              check: options?.check,
            },
            work,
            entry,
          )
        },
        { mutationID },
      )
    },
    lastControlMutation: (key) =>
      read(
        key.groupID,
        async (stores) =>
          await sequenceMemoryOperation(
            stores.tx,
            async () =>
              (
                await memoryRecordTable<ControlRecord>({
                  tx: stores.tx,
                  key,
                  namespace: 'control',
                  atRest,
                }).load('current')
              )?.mutationID ?? null,
          )(),
      ),
  })
  return {
    groups,
    transitionInTransaction<TValue>(
      tx: MemoryTransaction,
      change: GroupTransition,
      work: (stores: GroupStores<MemoryTransaction>) => Promise<TValue>,
    ): Promise<TValue> {
      const entry = owners.current()
      if (entry === undefined) throw new GroupStateConflictError('Missing group ownership entry')
      return transitionOwned(copyStoredValue(change), work, entry, tx)
    },
  }
}

export function createMemoryGroupPersistence(params: {
  db: MemoryDatabase
  owners: OwnerQueues
  atRest: AtRestCodec
  providerID: string
  effects?: TransactionalGroupEffects<MemoryTransaction>
  ownershipContext?: OwnershipContextPort
}): GroupPersistence<MemoryTransaction> {
  return createMemoryGroupCoordinator(params).groups
}
