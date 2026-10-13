import type { GroupEpochRuntime, GroupRuntimeSnapshot } from './types.js'

export function copyRuntimeSnapshot(value: GroupRuntimeSnapshot): GroupRuntimeSnapshot {
  return { ...value, authenticator: value.authenticator.slice(), members: new Set(value.members) }
}

export function createRegistryRuntime(): {
  runtime: GroupEpochRuntime
  publish(value: GroupRuntimeSnapshot | null): void
} {
  let current: GroupRuntimeSnapshot | null = null
  const listeners = new Set<(value: GroupRuntimeSnapshot | null) => void>()
  return {
    runtime: {
      snapshot: () => (current === null ? null : copyRuntimeSnapshot(current)),
      onEpochChanged(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    publish(value) {
      if (current === null && value === null) return
      if (
        current !== null &&
        value !== null &&
        current.groupID === value.groupID &&
        current.incarnation === value.incarnation &&
        current.epoch === value.epoch &&
        current.stateVersion === value.stateVersion &&
        current.available === value.available &&
        current.authenticator.length === value.authenticator.length &&
        current.authenticator.every((byte, index) => byte === value.authenticator[index]) &&
        current.members.size === value.members.size &&
        [...current.members].every((member) => value.members.has(member))
      )
        return
      current = value === null ? null : copyRuntimeSnapshot(value)
      // Notifications run after the Read entry has released ownership.
      for (const listener of listeners) {
        try {
          listener(current === null ? null : copyRuntimeSnapshot(current))
        } catch {}
      }
    },
  }
}
