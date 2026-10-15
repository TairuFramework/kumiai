import type { SafetyHold } from '@kumiai/rpc'

import { coordinatorBinding } from '../entry-capability.js'
import type { GroupKey, GroupPersistence, GroupTransaction } from '../persistence-types.js'
import { registrySafety } from './safety.js'
import type { GroupHandleRegistry } from './types.js'

export type RegistryConsumers = {
  onSafetyHold(key: GroupKey, latch: (reason: NonNullable<SafetyHold>) => void): () => void
  onRetire(key: GroupKey, hook: () => Promise<void>): () => void
  safetyHold(key: GroupKey): SafetyHold
}

export function registryConsumers<TTx extends GroupTransaction>(params: {
  registry: GroupHandleRegistry
  persistence: GroupPersistence<TTx>
}): RegistryConsumers {
  const capability = registrySafety<TTx>(params.registry)
  if (capability === null || capability.binding !== coordinatorBinding(params.persistence))
    throw new TypeError(
      'Registry consumers require a registered registry with the same coordinator',
    )
  return {
    onSafetyHold: capability.onSafetyHold,
    onRetire: capability.onRetire,
    safetyHold: capability.safetyHold,
  }
}
