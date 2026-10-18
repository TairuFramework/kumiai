import { registrySenderRestorers } from './registry/registry.js'
import type { GroupHandleRegistry } from './registry/types.js'

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
