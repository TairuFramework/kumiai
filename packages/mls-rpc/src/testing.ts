import type { GroupHandle } from '@kumiai/mls'

import { receiveInstrumentation, registryReceiveSlots } from './registry/live-receive.js'
import {
  leaseReaders,
  liveHandles,
  registryLiveSend,
  registryMaintenanceGates,
} from './registry/live-send.js'
import { registryHandoffReaders, registrySenderRestorers } from './registry/registry.js'
import type { GroupHandleRegistry, RegistryHandleAccess } from './registry/types.js'

export { createMemoryDevicePersistence } from './memory-device-persistence.js'
export { type MemoryFaultController, memoryFaults } from './memory-faults.js'
export { createMemoryGroupPersistence } from './memory-group-persistence.js'
export { createMemoryGroupPorts } from './memory-group-ports.js'
export { createIncarnationStores } from './memory-incarnation-stores.js'
export { createMemoryPackageStores } from './memory-package-stores.js'
export { createMemoryTransaction } from './memory-transaction.js'
export { createOwnerQueues } from './owner-queue.js'

/** Raw-key restoration exception for tests. Never use this sender alongside registry leases. */
export function restoreCommittedSender(registry: GroupHandleRegistry, groupID: string) {
  const restore = registrySenderRestorers.get(registry)
  if (restore === undefined) throw new TypeError('Unknown registry')
  return restore(groupID)
}

export { ApplicationLeaseUnavailableError } from './registry/live-send.js'

export function registryLeaseSnapshot(access: RegistryHandleAccess) {
  return leaseReaders.get(access)?.() ?? null
}
const receiveCounts = new WeakMap<object, number>()
export function receiveRebuilds(access: RegistryHandleAccess): number {
  const slot = registryReceiveSlots.get(access)
  if (slot === undefined) throw new TypeError('Unknown registry access')
  const instrumentation = receiveInstrumentation.get(slot) ?? {}
  instrumentation.rebuilt = () => receiveCounts.set(slot, (receiveCounts.get(slot) ?? 0) + 1)
  receiveInstrumentation.set(slot, instrumentation)
  return receiveCounts.get(slot) ?? 0
}
export function setReceiveCapacity(access: RegistryHandleAccess, cap: number): void {
  const slot = registryReceiveSlots.get(access)
  if (slot === undefined) throw new TypeError('Unknown registry access')
  receiveInstrumentation.set(slot, { ...receiveInstrumentation.get(slot), cap })
}
export function hasRegistryPendingHandoff(registry: GroupHandleRegistry, groupID: string) {
  return registryHandoffReaders.get(registry)?.(groupID) ?? false
}
export function isLiveHandle(handle: unknown): boolean {
  return typeof handle === 'object' && handle !== null && liveHandles.has(handle as GroupHandle)
}
function live(access: RegistryHandleAccess) {
  const value = registryLiveSend.get(access)
  if (value === undefined) throw new TypeError('Unknown registry access')
  return value
}
export function drainRegistryMaintenance(access: RegistryHandleAccess) {
  return live(access).drain()
}
export function blockRegistryMaintenance(access: RegistryHandleAccess) {
  return live(access).blockMaintenance()
}
/** Holds every background reservation for this registry until released. Installs still reserve. */
type MaintenanceGate = { started: Promise<void>; release(): void }
const maintenanceGates = new WeakMap<GroupHandleRegistry, MaintenanceGate>()

export function gateRegistryMaintenance(registry: GroupHandleRegistry) {
  const existing = maintenanceGates.get(registry)
  if (existing !== undefined) return existing
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  registryMaintenanceGates.set(registry, async (signal) => {
    entered()
    if (signal.aborted) return
    let abort!: () => void
    try {
      await Promise.race([
        released,
        new Promise<void>((resolve) => {
          abort = resolve
          signal.addEventListener('abort', abort, { once: true })
        }),
      ])
    } finally {
      signal.removeEventListener('abort', abort)
    }
  })
  const gate = {
    started,
    release() {
      registryMaintenanceGates.delete(registry)
      maintenanceGates.delete(registry)
      release()
    },
  }
  maintenanceGates.set(registry, gate)
  return gate
}
export function dropRegistryOwner(access: RegistryHandleAccess) {
  live(access).dropOwner()
}
export function armLiveEncryptFault(
  access: RegistryHandleAccess,
  when: 'throw-before' | 'throw-after' | 'block',
) {
  const copy = registryLeaseSnapshot(access)?.copy
  if (copy === undefined) throw new TypeError('Missing live sender')
  const encrypt = copy.encryptApplication.bind(copy)
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  copy.encryptApplication = async (...args) => {
    copy.encryptApplication = encrypt
    entered()
    if (when === 'throw-before') throw new Error('Injected encryption failure before consumption')
    if (when === 'block') await released
    const sealed = await encrypt(...args)
    if (when === 'throw-after') throw new Error('Injected encryption failure after consumption')
    return sealed
  }
  return { started, release: () => release() }
}
