import { normalizeDID } from '@kokuin/token'
import type { ControlSnapshot, ForkHalt, SafetyHold } from '@kumiai/rpc'

import { bindRegistryCheckpoint } from '../checkpoint.js'
import {
  type AccountedGroupObservation,
  coordinatorBinding,
  type EntryReads,
  entryCapability,
} from '../entry-capability.js'
import {
  DisplacedGroupHandleError,
  GroupControlUnsettledError,
  GroupStateConflictError,
  GroupUnavailableError,
  SpentSetCorruptError,
  StorageOutcomeUnknownError,
} from '../persistence-errors.js'
import type { GroupKey, GroupStores, GroupTransaction } from '../persistence-types.js'
import { groupCondition, groupConditionWriter } from '../safety-conditions.js'
import { createRegistryAccess, type RegistryOwner } from './access.js'
import { admissionFor, type ColdEnvironment, loadValidatedGroup } from './cold.js'
import { bindRegistryRecoveryCoordinator } from './recovery-coordinator.js'
import { deleteIncarnations } from './retired.js'
import {
  bindRegistryRetirement,
  createRegistryRetirement,
  type RetirementSlot,
} from './retirement.js'
import { createRegistryRuntime, createRegistrySafetyLatch } from './runtime.js'
import { accountedRuntime } from './runtime-facts.js'
import {
  bindRegistrySafety,
  RetainedTrustUnavailableError,
  readRetainedTrust,
  trustUnavailableWriter,
} from './safety.js'
import { createRegistrySeed } from './seed.js'
import { readRecoverySource } from './source.js'
import { createRegistrySwitch } from './switch.js'
import type {
  GroupHandleRegistry,
  GroupHandleRegistryParams,
  RegistryHandleAccess,
} from './types.js'
import { registryOptions } from './validation.js'

type GroupSlot = RetirementSlot & {
  load: { generation: number; promise: Promise<RegistryHandleAccess> } | null
}
class StaleRegistryGeneration extends Error {}
class DeleteDrainChanged extends Error {}

const liveRegistries = new WeakMap<object, GroupHandleRegistry>()

export function createGroupHandleRegistry<TTx extends GroupTransaction>(
  params: GroupHandleRegistryParams<TTx>,
): GroupHandleRegistry {
  const { persistence } = params
  if (!params.providerID || params.providerID !== persistence.providerID)
    throw new GroupStateConflictError('Registry provider mismatch')
  if (normalizeDID(params.recovery.identity.id) !== normalizeDID(persistence.ownerDID))
    throw new GroupStateConflictError('Registry owner mismatch')
  const registeredCapability = entryCapability(persistence.groups)
  const binding = coordinatorBinding(persistence.groups)
  if (registeredCapability === null || binding === null)
    throw new GroupStateConflictError('Registry requires registered entry capability')
  if (liveRegistries.has(binding))
    throw new GroupStateConflictError('Coordinator already has a live registry')
  const capability = registeredCapability
  const registryBinding = binding
  const environment: ColdEnvironment = {
    ownerDID: persistence.ownerDID,
    recovery: { ...params.recovery, options: registryOptions(params.recovery.options) },
    restore: params.restore,
  }
  const slots = new Map<string, GroupSlot>()
  const latches = new Map<string, ReturnType<typeof createRegistrySafetyLatch>>()
  const keyID = (key: GroupKey) => JSON.stringify([key.groupID, key.incarnation])
  const held = (key: GroupKey): SafetyHold => latches.get(keyID(key))?.held() ?? null
  function safetyLatch(key: GroupKey) {
    const id = keyID(key)
    let value = latches.get(id)
    if (value === undefined) {
      value = createRegistrySafetyLatch()
      latches.set(id, value)
    }
    return value
  }
  function latch(key: GroupKey, reason: NonNullable<SafetyHold>): void {
    if (disposed) return
    groupSlot(key.groupID)
    safetyLatch(key).latch(reason)
  }
  function reportHold(key: GroupKey, halt: ForkHalt): void {
    if (disposed) return
    groupSlot(key.groupID)
    safetyLatch(key).report(halt, true)
  }
  function observeHold(key: GroupKey, control: ControlSnapshot): void {
    if (control.forkHalt?.producer === 'app-report') safetyLatch(key).report(control.forkHalt)
    else if (control.forkHalt !== null) latch(key, 'fork-halted')
    if (control.recoveryUnavailable !== null) latch(key, 'recovery-unavailable')
  }
  const persistTrustUnavailable = trustUnavailableWriter({ entry: capability, latch, observeHold })
  const persistGroupCondition = groupConditionWriter({ entry: capability, latch })
  async function diagnoseFailure(error: unknown): Promise<void> {
    if (
      !(error instanceof SpentSetCorruptError) &&
      !(error instanceof RetainedTrustUnavailableError)
    )
      return
    try {
      if (error instanceof SpentSetCorruptError) {
        if (error.key !== undefined)
          await persistGroupCondition(error.key, 'spent-set-corrupt', null)
      } else await persistTrustUnavailable(error.key)
    } catch (failure) {
      if (failure instanceof GroupUnavailableError && failure.reason === 'invalid') throw failure
      // Failed persistence leaves the latch and original trust diagnosis authoritative.
    }
  }
  const diagnosing = new Set<string>()
  function diagnoseObservation(observation: AccountedGroupObservation): void {
    const key = observation.activeKey
    // Readable trust already passed the surviving spent-set check when it was opened.
    if (
      key === null ||
      observation.condition === 'spent-set-corrupt' ||
      (observation.trustStatus === 'readable' && observation.trust !== null)
    )
      return
    const id = keyID(key)
    if (diagnosing.has(id)) return
    diagnosing.add(id)
    const pending = (async () => {
      try {
        await capability.read(key.groupID, async (reads) => {
          const lifetime = await reads.lifetime()
          if (lifetime?.groupID === key.groupID && lifetime.activeIncarnation === key.incarnation)
            await readRetainedTrust(reads, key)
        })
      } catch (error) {
        await diagnoseFailure(error)
      } finally {
        diagnosing.delete(id)
      }
    })()
    // Observations are advisory. Only the typed diagnosis can install a hold.
    void track(pending).catch(() => {})
  }
  const observers = new Set<() => void>()
  const inflight = new Set<Promise<unknown>>()
  let closing = false
  let disposed = false
  let disposal: Promise<void> | null = null
  let starting: Promise<void> | null = null
  let started = false
  function assertOpen(): void {
    if (capability.failureSignal?.aborted) throw capability.failureSignal.reason
    if (closing) throw new DisplacedGroupHandleError('Registry is disposed')
  }
  function track<TResult>(pending: Promise<TResult>): Promise<TResult> {
    inflight.add(pending)
    void pending.then(
      () => inflight.delete(pending),
      () => inflight.delete(pending),
    )
    return pending
  }
  async function start(): Promise<void> {
    assertOpen()
    await initialise()
  }
  async function initialise(): Promise<void> {
    if (started) return
    if (starting !== null) return await starting
    starting = (async () => {
      const device = await persistence.load()
      if (device.restoreWork !== null)
        throw new GroupUnavailableError({ reason: 'restore-pending' })
      const lifetimes = await persistence.groups.list()
      if (lifetimes.some((value) => value.restorePending))
        throw new GroupUnavailableError({ reason: 'restore-pending' })
      started = true
    })()
    try {
      await starting
    } finally {
      starting = null
    }
  }
  function groupSlot(groupID: string): GroupSlot {
    let slot = slots.get(groupID)
    if (slot === undefined) {
      slot = {
        generation: 0,
        retirementGeneration: 0,
        lastRetirementKey: null,
        retirement: null,
        owner: null,
        hooks: null,
        load: null,
      }
      slots.set(groupID, slot)
      const observedSlot = slot
      const notifications = new WeakMap<AccountedGroupObservation, () => void>()
      const unsubscribe = capability.observe(
        groupID,
        (observation) => {
          if (
            observation.activeKey !== null &&
            observation.controlStatus === 'readable' &&
            observation.control !== null
          ) {
            observeHold(observation.activeKey, observation.control)
          }
          if (
            observation.activeKey !== null &&
            (observation.condition === 'spent-set-corrupt' ||
              observation.trustStatus === 'spent-set-corrupt')
          )
            latch(observation.activeKey, 'spent-set-corrupt')
          const previous = observedSlot.owner
          observedSlot.generation++
          if (previous !== null) previous.cacheValid = false
          const projected = accountedRuntime({
            observation,
            groupID,
            ownerDID: environment.ownerDID,
            previous: previous?.acceptedTrust ?? null,
          })
          if (previous === null) return
          if (
            observation.activeKey?.incarnation === previous.key.incarnation &&
            observation.trustStatus === 'spent-set-corrupt'
          ) {
            previous.snapshot = {
              ...previous.snapshot,
              available: false,
              condition: 'spent-set-corrupt',
            }
            previous.admission = {
              epoch: previous.snapshot.epoch,
              admissible: false,
              reason: held(previous.key) ?? 'spent-set-corrupt',
            }
            const dispatch = previous.runtime.install(previous.snapshot)
            if (dispatch !== undefined) notifications.set(observation, dispatch)
            return
          }
          if (
            projected === null ||
            observation.trust === null ||
            projected.snapshot.incarnation !== previous.key.incarnation
          ) {
            observedSlot.owner = null
            const dispatch = previous.runtime.install(null)
            if (dispatch !== undefined) notifications.set(observation, dispatch)
            return
          }
          previous.acceptedTrust = observation.trust
          previous.snapshot = projected.snapshot
          previous.admission = projected.admission
          const dispatch = previous.runtime.install(projected.snapshot)
          if (dispatch !== undefined) notifications.set(observation, dispatch)
        },
        (observation) => {
          const dispatch = notifications.get(observation)
          notifications.delete(observation)
          dispatch?.()
          diagnoseObservation(observation)
        },
      )
      observers.add(unsubscribe)
    }
    return slot
  }
  function invalidate(slot: GroupSlot): void {
    slot.generation++
    slot.owner = null
  }
  function publish(slot: GroupSlot, previous: RegistryOwner | null): void {
    if (previous !== null && previous !== slot.owner) previous.runtime.publish(null)
    if (slot.owner !== null) slot.owner.runtime.publish(slot.owner.snapshot)
  }
  const retirement = createRegistryRetirement({
    slot: groupSlot,
    drain: (groupID) => capability.read(groupID, async () => {}),
    displace(slot, key) {
      const previous = slot.owner
      if (previous?.key.incarnation === key.incarnation) {
        slot.owner = null
        previous.runtime.publish(null)
      }
    },
    failureSignal: capability.failureSignal,
  })
  async function load(
    reads: EntryReads,
    groupID: string,
    slot: GroupSlot,
    generation = slot.generation,
    admittedOwner?: RegistryOwner,
    assertMutationSafety?: () => void,
  ) {
    function assertLoadCurrent(): void {
      if (admittedOwner !== undefined) {
        if (slot.owner !== admittedOwner)
          throw new DisplacedGroupHandleError('Registry owner is no longer current')
      } else if (slot.generation !== generation) throw new StaleRegistryGeneration()
    }
    assertLoadCurrent()
    const { value, control } = await loadValidatedGroup(
      reads,
      groupID,
      slot.owner?.cacheValid ? slot.owner.value : null,
      environment,
      assertMutationSafety,
    )
    assertLoadCurrent()
    value.snapshot.condition = groupCondition(await reads.checkpoints(), value.key).condition
    observeHold(value.key, control)
    if (value.snapshot.condition === 'spent-set-corrupt') latch(value.key, 'spent-set-corrupt')
    if (admittedOwner !== undefined && value.key.incarnation !== admittedOwner.key.incarnation)
      throw new DisplacedGroupHandleError('Registry access belongs to a retired incarnation')
    if (slot.owner === null || slot.owner.key.incarnation !== value.key.incarnation) {
      // Host registrations survive cache invalidation, but never cross incarnations.
      if (slot.hooks?.key.incarnation !== value.key.incarnation)
        slot.hooks = { key: { ...value.key }, callbacks: new Set() }
      const owner: RegistryOwner = {
        key: { ...value.key },
        value,
        acceptedTrust: value.trust,
        cacheValid: true,
        snapshot: value.snapshot,
        admission: admissionFor(value, control),
        runtime: createRegistryRuntime(),
        hooks: slot.hooks.callbacks,
        access: null,
      }
      const access = createRegistryAccess({
        owner,
        capability,
        environment,
        restoreCandidate: params.restoreCandidate,
        resolve: (mutationID) => persistence.groups.resolve(groupID, mutationID),
        load: (reads, assertMutationSafety) =>
          load(reads, groupID, slot, slot.generation, owner, assertMutationSafety),
        publish: () => publish(slot, owner),
        safetyHeld: () =>
          held(owner.key) ??
          (owner.admission.admissible
            ? null
            : owner.admission.reason === 'spent-set-corrupt' ||
                owner.admission.reason === 'fork-halted' ||
                owner.admission.reason === 'recovery-unavailable'
              ? owner.admission.reason
              : null),
        diagnoseFailure,
        assertCurrent: () => {
          if (slot.owner !== owner)
            throw new DisplacedGroupHandleError('Registry owner is no longer current')
        },
        assertAvailable: () => {
          assertOpen()
          if (slot.owner !== owner)
            throw new DisplacedGroupHandleError('Registry owner is no longer current')
          retirement.assertAvailable(groupID)
        },
        invalidate: (displaced) => {
          if (slot.owner !== owner) return
          if (slot.retirement !== null && !displaced) owner.cacheValid = false
          else invalidate(slot)
        },
      })
      owner.access = {
        get key() {
          return access.key
        },
        get runtime() {
          return access.runtime
        },
        epoch: access.epoch,
        stateVersion: access.stateVersion,
        admission() {
          const admission = access.admission()
          const reason = held(owner.key)
          return reason === null ? admission : { epoch: admission.epoch, admissible: false, reason }
        },
        read: access.read,
        readControl: access.readControl,
        mutate: access.mutate,
        replace: access.replace,
        adopt: access.adopt,
        onRetire: access.onRetire,
      }
      slot.owner = owner
    } else {
      slot.owner.value = value
      slot.owner.acceptedTrust = value.trust
      slot.owner.cacheValid = true
      slot.owner.snapshot = value.snapshot
      slot.owner.admission = admissionFor(value, control)
    }
    return value
  }
  async function deleteGroup(requestedKey: GroupKey): Promise<void> {
    const key = { ...requestedKey }
    await retireGroup(key, 'Inactive deletion source', (stores, mutationID) =>
      deleteIncarnations(stores, key, mutationID),
    )
  }
  /** Drains source hooks and work, then runs one retiring transaction on a quiet source. */
  async function retireGroup<TResult>(
    requestedKey: GroupKey,
    inactive: string,
    work: (stores: GroupStores<TTx>, mutationID: string) => Promise<TResult>,
    afterDrain?: () => Promise<void>,
  ): Promise<TResult> {
    assertOpen()
    const key = { ...requestedKey }
    retirement.assertAvailable(key.groupID)
    await start()
    const slot = groupSlot(key.groupID)
    const attempt = retirement.beginRetirement(key)
    let unknown = false
    let stopObservation = () => {}
    function settle(outcome: 'committed' | 'rolled-back'): void {
      attempt.settle(outcome)
      stopObservation()
    }
    try {
      for (let round = 0; round < 3; round++) {
        await attempt.drain()
        await afterDrain?.()
        const activity = capability.activity(key.groupID)
        const generation = slot.generation
        const mutationID = crypto.randomUUID()
        try {
          // Project displacement first; listeners dispatch only after owner release.
          stopObservation = capability.observe(key.groupID, (observation) => {
            if (observation.mutationID === mutationID) settle('committed')
          })
          return await capability.run(
            { groupID: key.groupID, mutationID },
            async (reads) => {
              const lifetime = await reads.lifetime()
              if (lifetime?.activeIncarnation !== key.incarnation)
                throw new DisplacedGroupHandleError(inactive)
              return { expected: lifetime, value: null }
            },
            async (stores) => {
              const current = capability.activity(key.groupID, mutationID)
              if (
                slot.retirement?.attempt !== attempt ||
                slot.generation !== generation ||
                current.generation !== activity.generation ||
                current.pending !== 0
              )
                throw new DeleteDrainChanged()
              stores.tx.onRollback(() => settle('rolled-back'))
              return await work(stores, mutationID)
            },
          )
        } catch (error) {
          if (error instanceof DeleteDrainChanged) {
            stopObservation()
            continue
          }
          unknown = error instanceof StorageOutcomeUnknownError
          throw error
        }
      }
      throw new GroupControlUnsettledError('Group work changed during three deletion drains')
    } finally {
      if (!unknown) settle('rolled-back')
    }
  }
  function dispose(): Promise<void> {
    if (disposal !== null) return disposal
    closing = true
    disposal = (async () => {
      try {
        await Promise.allSettled([...(starting === null ? [] : [starting]), ...inflight])
        const results = await Promise.allSettled(
          [...slots].map(async ([groupID, slot]) => {
            const key = slot.hooks?.key ?? slot.owner?.key
            if (key === undefined) {
              await capability.read(groupID, async () => {})
              return
            }
            const attempt = slot.retirement?.attempt ?? retirement.beginRetirement(key)
            try {
              try {
                await attempt.drain()
              } finally {
                // Even a rejecting hook may have submitted completion work.
                await capability.read(groupID, async () => {})
              }
            } finally {
              attempt.settle('rolled-back')
            }
          }),
        )
        const rejected = results.filter((result) => result.status === 'rejected')
        if (rejected.length === 1) throw rejected[0]?.reason
        if (rejected.length > 1)
          throw new AggregateError(
            rejected.map((result) => result.reason),
            'Registry disposal failed',
          )
      } finally {
        disposed = true
        for (const unsubscribe of observers) unsubscribe()
        observers.clear()
        for (const value of latches.values()) value.dispose()
        for (const slot of slots.values()) {
          const previous = slot.owner
          invalidate(slot)
          slot.hooks?.callbacks.clear()
          slot.hooks = null
          previous?.runtime.publish(null)
        }
        liveRegistries.delete(registryBinding)
      }
    })()
    return disposal
  }
  const seed = createRegistrySeed({
    capability,
    retirement,
    environment: environment.recovery,
    ownerDID: environment.ownerDID,
    start,
    held,
  })
  const switchIncarnation = createRegistrySwitch({
    persistence: persistence.groups,
    capability,
    retirement,
    recovery: environment.recovery,
    ownerDID: environment.ownerDID,
    // Issued switches remain tracked while disposal closes public admission.
    start: initialise,
    held,
  })
  const registry: GroupHandleRegistry = {
    start,
    async seed(group, options) {
      assertOpen()
      groupSlot(group.groupID)
      try {
        return await track(seed(group, options))
      } catch (error) {
        await diagnoseFailure(error)
        throw error
      }
    },
    async switchIncarnation(candidate, options) {
      assertOpen()
      return await track(switchIncarnation(candidate, options))
    },
    delete(key) {
      return track(deleteGroup(key))
    },
    dispose,
    async recoverySource(groupID) {
      try {
        assertOpen()
        groupSlot(groupID)
      } catch (error) {
        return Promise.reject(error)
      }
      try {
        return await capability.read(groupID, (reads) => readRecoverySource(reads, groupID))
      } catch (error) {
        await diagnoseFailure(error)
        throw error
      }
    },
    async access(groupID) {
      assertOpen()
      retirement.assertAvailable(groupID)
      await start()
      assertOpen()
      const slot = groupSlot(groupID)
      retirement.assertAvailable(groupID)
      if (slot.load !== null && slot.load.generation === slot.generation)
        return await slot.load.promise
      let generation = slot.generation
      const retirementGeneration = slot.retirementGeneration
      const previous = slot.owner
      let promise!: Promise<RegistryHandleAccess>
      promise = (async () => {
        try {
          for (;;) {
            try {
              const access = await capability.read(groupID, async (reads) => {
                retirement.assertGeneration(groupID, retirementGeneration)
                await load(reads, groupID, slot, generation)
                const access = slot.owner?.access
                if (access === null || access === undefined)
                  throw new GroupUnavailableError({ reason: 'invalid' })
                return access
              })
              if (slot.generation !== generation || slot.owner?.access !== access)
                throw new StaleRegistryGeneration()
              publish(slot, previous)
              assertOpen()
              retirement.assertGeneration(groupID, retirementGeneration)
              return access
            } catch (error) {
              await diagnoseFailure(error)
              retirement.assertGeneration(groupID, retirementGeneration)
              retirement.assertAvailable(groupID)
              if (!(error instanceof StaleRegistryGeneration)) {
                if (
                  slot.generation === generation &&
                  (error instanceof GroupUnavailableError ||
                    error instanceof DisplacedGroupHandleError)
                )
                  invalidate(slot)
                publish(slot, previous)
                throw error
              }
              // Re-enter Read: the active lifetime must permit loading before restoration retries.
              generation = slot.generation
              if (slot.load?.promise === promise) slot.load.generation = generation
            }
          }
        } finally {
          if (slot.load?.promise === promise) slot.load = null
        }
      })()
      slot.load = { generation, promise }
      return await promise
    },
  }
  bindRegistrySafety(registry, {
    binding: registryBinding,
    entry: capability,
    latch,
    held,
    persistTrustUnavailable,
    persistGroupCondition,
    reportHold,
    observeHold,
    prepareReportedHoldRelease(key, halt) {
      const release = safetyLatch(key).prepareRelease(halt)
      return () => {
        if (!disposed) release()
      }
    },
    retire: (key, work, afterDrain) =>
      track(retireGroup(key, 'Inactive retirement source', work, afterDrain)),
    safetyHold: held,
    onSafetyChanged(key, sink) {
      assertOpen()
      groupSlot(key.groupID)
      return safetyLatch(key).subscribeChanged(sink)
    },
    onSafetyHold(key, sink) {
      assertOpen()
      groupSlot(key.groupID)
      return safetyLatch(key).subscribe(sink)
    },
    onRetire(requestedKey, hook) {
      assertOpen()
      const key = { ...requestedKey }
      retirement.assertAvailable(key.groupID)
      const slot = groupSlot(key.groupID)
      const current = slot.owner?.key ?? slot.hooks?.key
      if (current !== undefined && current.incarnation !== key.incarnation)
        throw new DisplacedGroupHandleError(
          'Retirement subscription belongs to another incarnation',
        )
      slot.hooks ??= { key, callbacks: new Set() }
      const hooks = slot.hooks.callbacks
      const registered = () => hook()
      hooks.add(registered)
      return () => {
        hooks.delete(registered)
      }
    },
  })
  bindRegistryCheckpoint({
    registry,
    entry: capability,
    identity: params.recovery.identity,
    assertOpen,
    track,
  })
  bindRegistryRecoveryCoordinator({ registry, entry: capability, persistence: persistence.groups })
  bindRegistryRetirement(registry, retirement)
  liveRegistries.set(binding, registry)
  return registry
}
