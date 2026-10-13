import type { SafetyHold } from '@kumiai/rpc'

import type { EntryCapability } from '../entry-capability.js'
import type { GroupKey, GroupTransaction } from '../persistence-types.js'
import type { GroupHandleRegistry } from './types.js'

export type RegistrySafetyCapability<TTx extends GroupTransaction> = {
  binding: object
  entry: EntryCapability<TTx>
  latch(key: GroupKey, reason: NonNullable<SafetyHold>): void
  held(key: GroupKey): SafetyHold
}

const capabilities = new WeakMap<GroupHandleRegistry, unknown>()

export function bindRegistrySafety<TTx extends GroupTransaction>(
  registry: GroupHandleRegistry,
  capability: RegistrySafetyCapability<TTx>,
): void {
  capabilities.set(registry, capability)
}

export function registrySafety<TTx extends GroupTransaction>(
  registry: GroupHandleRegistry,
): RegistrySafetyCapability<TTx> | null {
  return (capabilities.get(registry) as RegistrySafetyCapability<TTx> | undefined) ?? null
}
