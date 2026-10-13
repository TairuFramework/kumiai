import { normalizeDID } from '@kokuin/token'

import {
  type AccountedGroupObservation,
  coordinatorBinding,
  type EntryReads,
  entryCapability,
} from '../entry-capability.js'
import {
  DisplacedGroupHandleError,
  GroupStateConflictError,
  GroupUnavailableError,
} from '../persistence-errors.js'
import type { GroupTransaction } from '../persistence-types.js'
import { createRegistryAccess, type RegistryOwner } from './access.js'
import { admissionFor, type ColdEnvironment, loadValidatedGroup } from './cold.js'
import {
  bindRegistryRetirement,
  createRegistryRetirement,
  type RetirementSlot,
} from './retirement.js'
import { createRegistryRuntime } from './runtime.js'
import { accountedRuntime } from './runtime-facts.js'
import { readRecoverySource } from './source.js'
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
  const environment: ColdEnvironment = {
    ownerDID: persistence.ownerDID,
    recovery: { ...params.recovery, options: registryOptions(params.recovery.options) },
    restore: params.restore,
  }
  const slots = new Map<string, GroupSlot>()
  let starting: Promise<void> | null = null
  let started = false
  async function start(): Promise<void> {
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
      capability.observe(
        groupID,
        (observation) => {
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
        },
      )
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
    )
    assertLoadCurrent()
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
      owner.access = createRegistryAccess({
        owner,
        capability,
        environment,
        load: (reads) => load(reads, groupID, slot, slot.generation, owner),
        publish: () => publish(slot, owner),
        assertCurrent: () => {
          if (slot.owner !== owner)
            throw new DisplacedGroupHandleError('Registry owner is no longer current')
        },
        assertAvailable: () => {
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
  const registry: GroupHandleRegistry = {
    start,
    recoverySource(groupID) {
      groupSlot(groupID)
      return capability.read(groupID, (reads) => readRecoverySource(reads, groupID))
    },
    async access(groupID) {
      retirement.assertAvailable(groupID)
      await start()
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
              retirement.assertGeneration(groupID, retirementGeneration)
              return access
            } catch (error) {
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
  bindRegistryRetirement(registry, retirement)
  liveRegistries.set(binding, registry)
  return registry
}
