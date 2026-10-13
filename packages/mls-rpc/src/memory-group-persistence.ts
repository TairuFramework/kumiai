import { controlAdoptionAllowed } from '@kumiai/rpc'

import {
  type AccountedGroupObservation,
  bindEntryCapability,
  type EntryCapability,
  type EntryReads,
  type StateMetadata,
} from './entry-capability.js'
import {
  bindMemoryGroupPorts,
  createMemoryGroupPorts,
  UnchangedGroupResult,
} from './memory-group-ports.js'
import {
  assertMemoryAccess,
  bindMemoryOwner,
  bindMemorySnapshot,
  coordinateMemoryTransaction,
  createGroupStateStores,
  createMemoryPrepareTransaction,
  createUnlockedGroupStateStores,
  memoryOperation,
  memorySeal,
  memoryTransactionEntry,
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
import { physicalRecordKey } from './persistence-codec.js'
import {
  DisplacedGroupHandleError,
  GroupStateConflictError,
  GroupStateUncertainError,
  PersistencePhaseError,
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

type Observer = {
  active: boolean
  onProof: (observation: AccountedGroupObservation) => void
  afterRelease?: (observation: AccountedGroupObservation) => void
}
type Binding = {
  providerID: string
  owners: OwnerQueues
  proofs: Map<string, Proof>
  observers: Map<string, Set<Observer>>
}
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
  const rows = Object.fromEntries(
    Object.entries(tx.rows).map(([namespace, rows]) => [namespace, new Map(rows)]),
  )
  bindMemorySnapshot(tx.rows, rows)
  return rows
}

async function loadAffectedState(
  tx: MemoryTransaction,
  key: GroupKey,
  atRest: AtRestCodec,
  namespaces: Set<string>,
): Promise<GroupStateRecord | null> {
  const requiredOpen = ![...namespaces].every((name) => name === 'control' || name === 'meta')
  try {
    return await createUnlockedGroupStateStores({ tx, groupID: key.groupID, atRest, requiredOpen })
      .state(key.incarnation)
      .load()
  } catch (error) {
    if (requiredOpen) throw error
    return null
  }
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
    binding = { providerID, owners, proofs: new Map(), observers: new Map() }
    bindings.set(db, binding)
  } else if (binding.providerID !== providerID)
    throw new GroupStateConflictError('Persistence provider mismatch')
  if (binding.owners !== owners)
    throw new GroupStateConflictError('Persistence ownership queue mismatch')
  owners.bindOwnershipContext(params.ownershipContext)
  const proofs = binding.proofs
  const observers = binding.observers
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
  async function prepareBarrier(entry: OwnerEntry, groupID: string): Promise<void> {
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
  }
  async function prepare(entry: OwnerEntry, groupID: string): Promise<void> {
    await prepareBarrier(entry, groupID)
    await entry.enter('work')
  }
  function prepareReads(entry: OwnerEntry, groupID: string): EntryReads {
    const tx = createMemoryPrepareTransaction({
      rows: db.snapshot(groupID),
      entry,
      owners,
      groupID,
      providerID,
    })
    const states = createUnlockedGroupStateStores({ tx, groupID, atRest })
    const incarnation = (incarnation: number) =>
      createUnlockedIncarnationStores({ tx, key: { groupID, incarnation }, atRest })
    const reads: EntryReads = {
      lifetime: memoryOperation(tx, states.lifetime.load),
      trust: memoryOperation(tx, states.trust.load),
      metadata: memoryOperation(
        tx,
        async (incarnation: number) => await states.stateMetadata(incarnation).load(),
      ),
      state: memoryOperation(
        tx,
        async (incarnation: number) => await states.state(incarnation).load(),
      ),
      control: memoryOperation(
        tx,
        async (number: number) => await incarnation(number).control.load(),
      ),
      events: memoryOperation(
        tx,
        async (number: number) => await incarnation(number).meta.events(),
      ),
      controlMutation: memoryOperation(
        tx,
        async (incarnation: number) =>
          (
            await memoryRecordTable<ControlRecord>({
              tx,
              key: { groupID, incarnation },
              namespace: 'control',
              atRest,
            }).load('current')
          )?.mutationID ?? null,
      ),
      diagnoseState: memoryOperation(tx, async (incarnation: number) => {
        try {
          const value = await createUnlockedGroupStateStores({
            tx,
            groupID,
            atRest,
            requiredOpen: false,
          })
            .state(incarnation)
            .load()
          return value === null
            ? 'missing'
            : value.deleted
              ? 'deleted'
              : value.state === null
                ? 'null'
                : 'readable'
        } catch {
          // Revocation is never classified as corruption. The diagnostic exposes no bytes.
          assertMemoryAccess(tx.rows)
          return 'unreadable'
        }
      }),
    }
    return Object.freeze(reads)
  }
  async function readOwned<TValue>(
    entry: OwnerEntry,
    groupID: string,
    work: (stores: GroupStores<MemoryTransaction>) => Promise<TValue>,
  ): Promise<TValue> {
    await prepare(entry, groupID)
    return await db.transact(scope(groupID), async (baseTx) => {
      const tx = boundTx(baseTx, entry)
      const attempt = entry.attempt()
      try {
        const result = await entry.callback(() => work(basicStores(tx, groupID)))
        await entry.enter('outcome')
        return result
      } catch (error) {
        attempt.revoke(
          owners.failure ?? new PersistencePhaseError('Read attempt rejected', { cause: error }),
        )
        entry.release()
        throw error
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
  async function captureObservation(
    tx: MemoryTransaction,
    before: MemoryStoreRows,
    groupID: string,
    mutationID: string,
    entry: OwnerEntry,
  ): Promise<void> {
    const listeners = [...(observers.get(groupID) ?? [])]
    if (listeners.length === 0) return
    const observation = await coordinateMemoryTransaction(tx, async (tx) => {
      const raw = createUnlockedGroupStateStores({ tx, groupID, atRest, requiredOpen: false })
      async function diagnose<TValue>(load: () => Promise<TValue | null>): Promise<{
        value: TValue | null
        status: 'missing' | 'readable' | 'unreadable'
      }> {
        try {
          const value = await load()
          return { value, status: value === null ? 'missing' : 'readable' }
        } catch {
          // Diagnostic failures cannot change settlement. Revocation still aborts capture.
          assertMemoryAccess(tx.rows)
          return { value: null, status: 'unreadable' }
        }
      }
      const { value: lifetime, status: lifetimeStatus } = await diagnose(raw.lifetime.load)
      const metadata: Array<StateMetadata> = []
      let metadataStatus: AccountedGroupObservation['metadataStatus'] = 'missing'
      async function loadMetadata(incarnation: number): Promise<StateMetadata | null> {
        const { value, status } = await diagnose(raw.stateMetadata(incarnation).load)
        if (status === 'unreadable' || metadataStatus === 'missing') metadataStatus = status
        return value
      }
      for (const incarnation of changedIncarnations(before, snapshot(tx), groupID).keys()) {
        const value = await loadMetadata(incarnation)
        if (value !== null) metadata.push(value)
      }
      const { value: trust, status: trustStatus } = await diagnose(raw.trust.load)
      const activeKey =
        lifetime?.activeIncarnation == null
          ? null
          : { groupID, incarnation: lifetime.activeIncarnation }
      let activeVersion: number | null = null
      let control: AccountedGroupObservation['control'] = null
      let controlStatus: AccountedGroupObservation['controlStatus'] = 'missing'
      let stateStatus: AccountedGroupObservation['stateStatus'] = 'missing'
      let terminal: boolean | null = null
      if (activeKey !== null) {
        activeVersion = (await loadMetadata(activeKey.incarnation))?.version ?? null
        const activeStores = createUnlockedIncarnationStores({
          tx,
          key: activeKey,
          atRest,
          requiredOpen: false,
        })
        const diagnosticControl = await diagnose(activeStores.control.load)
        control = diagnosticControl.value
        controlStatus = diagnosticControl.status
        const { value: state, status } = await diagnose(raw.state(activeKey.incarnation).load)
        stateStatus =
          state === null
            ? status
            : state.deleted
              ? 'deleted'
              : state.state === null
                ? 'null'
                : 'readable'
        terminal = state === null || state.deleted ? null : state.terminal
      }
      return {
        mutationID,
        lifetime,
        lifetimeStatus,
        metadata,
        metadataStatus,
        trust,
        trustStatus,
        activeKey,
        activeVersion,
        control,
        controlStatus,
        stateStatus,
        terminal,
      }
    })
    const attempt = entry.attempt()
    // Clone before proof; each observer owns the same value through both callbacks.
    for (const listener of listeners) {
      const detached = copyStoredValue(observation)
      entry.onCommit(() => {
        if (listener.active && entry.attempt() === attempt) listener.onProof(detached)
      })
      if (listener.afterRelease !== undefined) {
        const afterRelease = listener.afterRelease
        entry.afterRelease(() => {
          if (listener.active && entry.attempt() === attempt) afterRelease(detached)
        })
      }
    }
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
          const attempt = entry.attempt()
          try {
            const raw = createUnlockedGroupStateStores({
              tx,
              groupID: request.groupID,
              atRest,
            })
            const previous = await memoryOperation(tx, raw.lifetime.load)()
            const marker = owner(tx, request.groupID)
            let change: GroupTransition
            if ('key' in request) {
              if (
                previous === null ||
                (request.active && previous.activeIncarnation !== request.key.incarnation)
              )
                throw new DisplacedGroupHandleError('Inactive group incarnation')
              await entry.callback(() => request.check?.(basicStores(baseTx, request.groupID)))
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
            async function retainedTrust(readTx = tx) {
              if (previousTrust === undefined)
                previousTrust = await createUnlockedGroupStateStores({
                  tx: readTx,
                  groupID: request.groupID,
                  atRest,
                }).trust.load()
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
                  async adoptionContext() {
                    if (previous?.activeIncarnation !== incarnation) return null
                    const retired =
                      proposedLifetime !== undefined &&
                      proposedLifetime.activeIncarnation !== incarnation
                    if (retired)
                      return {
                        kind: 'retirement',
                        key: { groupID: change.groupID, incarnation },
                      }
                    const after = savedStates.get(incarnation)
                    if (after === undefined || after.deleted) return null
                    const prior = await memoryRecordTable<GroupStateRecord>({
                      tx: { ...tx, rows: before },
                      key: { groupID: change.groupID, incarnation },
                      namespace: 'state',
                      atRest,
                    }).load('current')
                    if (prior === null || prior.deleted) return null
                    return {
                      kind: 'adoption',
                      before: {
                        groupID: change.groupID,
                        incarnation,
                        epoch: prior.epoch,
                        authenticator: prior.epochAuthenticator,
                      },
                      after:
                        after === undefined || after.deleted
                          ? null
                          : {
                              groupID: change.groupID,
                              incarnation,
                              epoch: after.epoch,
                              authenticator: after.epochAuthenticator,
                            },
                    }
                  },
                })
                const state: ReturnType<typeof raw.state> = {
                  loadInitialIdentity: rows.state.loadInitialIdentity,
                  loadMetadata: rows.state.loadMetadata,
                  load: rows.state.load,
                  async save(value, expected) {
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
                    // Retirement relies on source metadata even when the private state is unreadable.
                    if (!owned.deleted) {
                      const prior = await raw.state(incarnation).load()
                      const snapshot = await createUnlockedIncarnationStores({
                        tx,
                        key: { groupID: change.groupID, incarnation },
                        atRest,
                      }).control.load()
                      const source = {
                        key: { groupID: change.groupID, incarnation },
                        stateVersion: prior?.version ?? 0,
                        identity:
                          prior === null || prior.deleted
                            ? null
                            : {
                                groupID: change.groupID,
                                incarnation,
                                epoch: prior.epoch,
                                authenticator: prior.epochAuthenticator,
                              },
                      }
                      if (
                        (expected !== undefined &&
                          !controlAdoptionAllowed(snapshot, source, expected)) ||
                        (prior !== null &&
                          !prior.deleted &&
                          !owned.deleted &&
                          (prior.terminal !== owned.terminal ||
                            prior.epoch !== owned.epoch ||
                            !sameStoredValue(prior.epochAuthenticator, owned.epochAuthenticator)) &&
                          snapshot.controlHold !== null &&
                          snapshot.controlHold.reason !== 'acceptance-unknown')
                      ) {
                        const error = new Error('Adoption source or control proof moved')
                        error.name = 'ControlAdoptionMovedError'
                        throw error
                      }
                    }
                    await retainedTrust()
                    await raw.state(incarnation).save(owned)
                    savedStates.set(incarnation, owned)
                  },
                }
                return {
                  ...rows,
                  state: {
                    loadInitialIdentity: state.loadInitialIdentity,
                    loadMetadata: state.loadMetadata,
                    load: state.load,
                    save: memoryOperation(tx, state.save, 'domain'),
                  },
                }
              },
            }
            const stores: GroupStores<MemoryTransaction> = {
              ...unlockedStores,
              lifetime: {
                load: memoryOperation(tx, unlockedStores.lifetime.load),
                save: memoryOperation(tx, unlockedStores.lifetime.save, 'domain'),
              },
              trust: {
                load: memoryOperation(tx, unlockedStores.trust.load),
                save: memoryOperation(tx, unlockedStores.trust.save, 'domain'),
              },
            }
            result = await entry.callback(() => work(stores, change.mutationID))
            // Host accessors can throw, so capture before starting a phase change.
            const capturedEffects = entry.callback(() => ({
              outbox: effects?.outbox?.bind(effects),
              delete: effects?.delete?.bind(effects),
            }))
            await entry.enter('finalise')
            if (entry.rollbackOnly)
              throw new GroupStateConflictError('Transaction is rollback-only')
            const { outboxEvents, deletedKeys, beforeEffects } = await coordinateMemoryTransaction(
              tx,
              async (tx) => {
                const raw = createUnlockedGroupStateStores({ tx, groupID: request.groupID, atRest })
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
                  if (previous !== null && (await retainedTrust(tx)) === null)
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
                    assertStateTransition(original, next, await retainedTrust(tx))
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
                  const retained = await retainedTrust(tx)
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
                  const state = await loadAffectedState(
                    tx,
                    { groupID: change.groupID, incarnation },
                    atRest,
                    namespaces,
                  )
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
                      await memorySeal(tx, atRest, address, {
                        ...state,
                        version: state.version + 1,
                      }),
                    )
                    await raw.stateMetadata(incarnation).save({
                      groupID: change.groupID,
                      incarnation,
                      version: state.version + 1,
                      deleted: false,
                      initialIdentity:
                        (await raw.stateMetadata(incarnation).load())?.initialIdentity ?? null,
                    })
                  }
                }
                if (proposedLifetime === undefined) await raw.lifetime.save(life)
                const outboxEvents: Array<AppStatusEvent> = []
                if (capturedEffects.outbox !== undefined) {
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
                if (capturedEffects.delete !== undefined)
                  for (const [incarnation, state] of savedStates)
                    if (state.deleted) deletedKeys.push({ groupID: change.groupID, incarnation })
                return { outboxEvents, deletedKeys, beforeEffects: snapshot(tx) }
              },
            )
            await entry.enter('effects')
            for (const event of outboxEvents)
              await entry.callback(() => capturedEffects.outbox?.(tx, event))
            for (const key of deletedKeys)
              await entry.callback(() => capturedEffects.delete?.(tx, key))
            await entry.enter('account')
            await coordinateMemoryTransaction(tx, async (tx) => {
              const raw = createUnlockedGroupStateStores({ tx, groupID: request.groupID, atRest })
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
                const state = await loadAffectedState(
                  tx,
                  { groupID: change.groupID, incarnation },
                  atRest,
                  namespaces,
                )
                if (state === null || state.deleted) continue
                const address = {
                  groupID: change.groupID,
                  incarnation,
                  namespace: 'state',
                  recordID: 'current',
                }
                tx.rows.state?.set(
                  physicalRecordKey(address),
                  await memorySeal(tx, atRest, address, { ...state, version: state.version + 1 }),
                )
                await raw
                  .stateMetadata(incarnation)
                  .save({ ...metadata, version: state.version + 1 })
              }
            })
            if (entry.rollbackOnly)
              throw new GroupStateConflictError('Transaction is rollback-only')
            await captureObservation(tx, before, change.groupID, change.mutationID, entry)
            return result
          } catch (error) {
            attempt.revoke(
              owners.failure ??
                new PersistencePhaseError('Transition attempt rejected', { cause: error }),
            )
            throw error
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
    readEvidence: (key) => {
      const owned = { ...key }
      return read(owned.groupID, async (stores) => {
        const lifetime = await stores.lifetime.load()
        const rows = stores.incarnation(owned.incarnation)
        const state = await rows.state.load()
        const control = await rows.control.load()
        return {
          source: {
            key: owned,
            stateVersion: state?.version ?? 0,
            identity:
              lifetime?.activeIncarnation === owned.incarnation && state != null && !state.deleted
                ? { ...owned, epoch: state.epoch, authenticator: state.epochAuthenticator.slice() }
                : null,
          },
          applied: control.applied,
          cursor: control.cursor,
          terminal: state != null && !state.deleted && state.terminal,
        }
      })
    },
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
  const capability: EntryCapability<MemoryTransaction> = {
    activity: (groupID, excludingMutationID) => owners.activity(groupID, excludingMutationID),
    failureSignal: owners.failureSignal,
    observe(groupID, onProof, afterRelease) {
      const listener: Observer = { active: true, onProof, afterRelease }
      let listeners = observers.get(groupID)
      if (listeners === undefined) {
        listeners = new Set()
        observers.set(groupID, listeners)
      }
      listeners.add(listener)
      return () => {
        if (!listener.active) return
        listener.active = false
        listeners.delete(listener)
        if (listeners.size === 0) observers.delete(groupID)
      }
    },
    read(groupID, fn) {
      return owners.run('read', { groupID, ownerDID: null }, async (entry) => {
        try {
          await prepareBarrier(entry, groupID)
          const result = await entry.callback(() => fn(prepareReads(entry, groupID)))
          await entry.enter('outcome')
          return result
        } catch (error) {
          entry
            .attempt()
            .revoke(
              owners.failure ??
                new PersistencePhaseError('Prepare read rejected', { cause: error }),
            )
          entry.release()
          throw error
        }
      })
    },
    run(request, prepare, work) {
      const owned = copyStoredValue(request)
      return owners.run(
        'transition',
        { groupID: owned.groupID, ownerDID: null },
        async (entry) => {
          try {
            await prepareBarrier(entry, owned.groupID)
            const prepared = await entry.callback(() => prepare(prepareReads(entry, owned.groupID)))
            // Capture caller-controlled expectations before entering work. Prepared values stay opaque.
            const expected = entry.callback(() => copyStoredValue(prepared.expected))
            const value = entry.callback(() => prepared.value)
            const mutationID = entry.callback(() => owned.mutationID ?? prepared.mutationID)
            if (
              typeof mutationID !== 'string' ||
              (owned.mutationID === null && mutationID.length === 0)
            )
              throw new PersistencePhaseError('Prepare did not supply a mutation ID')
            await entry.enter('work')
            if (owned.mutationID === null) entry.bindMutationID(mutationID)
            if (entry.rollbackOnly) throw new GroupStateConflictError('Prepare is rollback-only')
            return await transitionOwned(
              { ...owned, mutationID, expected },
              (stores) => work(stores, value),
              entry,
            )
          } catch (error) {
            entry
              .attempt()
              .revoke(
                owners.failure ??
                  new PersistencePhaseError('Prepare transition rejected', { cause: error }),
              )
            throw error
          }
        },
        { mutationID: owned.mutationID ?? undefined },
      )
    },
  }
  bindEntryCapability({ persistence: groups, capability, coordinatorBinding: binding })
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
          await memoryOperation(
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
      const entry = memoryTransactionEntry(tx.rows)
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
  params.owners.bindOwnershipContext(params.ownershipContext)
  return createMemoryGroupCoordinator(params).groups
}
