import type { SafetyHold } from '@kumiai/rpc'

import type { GroupEpochRuntime, GroupRuntimeSnapshot } from './types.js'

export function createRegistrySafetyLatch() {
  let reason: SafetyHold = null
  const sinks = new Set<(reason: NonNullable<SafetyHold>) => void>()
  function supply(sink: (reason: NonNullable<SafetyHold>) => void): void {
    if (reason === null) return
    try {
      sink(reason)
    } catch {
      // A broken core sink cannot change storage outcomes or suppress other sinks.
    }
  }
  return {
    held: (): SafetyHold => reason,
    latch(next: NonNullable<SafetyHold>): void {
      if (reason === 'fork-halted' || reason === next) return
      reason = next
      for (const sink of [...sinks]) {
        if (sinks.has(sink)) supply(sink)
      }
    },
    subscribe(sink: (reason: NonNullable<SafetyHold>) => void): () => void {
      const registered = (value: NonNullable<SafetyHold>) => sink(value)
      sinks.add(registered)
      supply(registered)
      return () => {
        sinks.delete(registered)
      }
    },
    dispose(): void {
      sinks.clear()
    },
  }
}

export function copyRuntimeSnapshot(value: GroupRuntimeSnapshot): GroupRuntimeSnapshot {
  return { ...value, authenticator: value.authenticator.slice(), members: new Set(value.members) }
}

export function createRegistryRuntime(): {
  runtime: GroupEpochRuntime
  install(value: GroupRuntimeSnapshot | null): (() => void) | undefined
  publish(value: GroupRuntimeSnapshot | null): void
  listenerFailures(): { count: number; lastError: unknown }
} {
  let current: GroupRuntimeSnapshot | null = null
  const listeners = new Set<(value: GroupRuntimeSnapshot | null) => void>()
  let failureCount = 0
  let lastError: unknown
  function listenerFailed(error: unknown): void {
    failureCount++
    lastError = error
  }
  const controller = {
    runtime: {
      snapshot: () => (current === null ? null : copyRuntimeSnapshot(current)),
      onEpochChanged(listener: (value: GroupRuntimeSnapshot | null) => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    install(value: GroupRuntimeSnapshot | null) {
      if (current === null && value === null) return
      if (
        current !== null &&
        value !== null &&
        current.groupID === value.groupID &&
        current.incarnation === value.incarnation &&
        current.epoch === value.epoch &&
        current.stateVersion === value.stateVersion &&
        current.available === value.available &&
        current.condition === value.condition &&
        current.authenticator.length === value.authenticator.length &&
        current.authenticator.every((byte, index) => byte === value.authenticator[index]) &&
        current.members.size === value.members.size &&
        [...current.members].every((member) => value.members.has(member))
      )
        return
      current = value === null ? null : copyRuntimeSnapshot(value)
      const notification = current
      const registered = [...listeners]
      return () => {
        for (const listener of registered) {
          if (!listeners.has(listener)) continue
          try {
            const result: unknown = listener(
              notification === null ? null : copyRuntimeSnapshot(notification),
            )
            if (result != null) void Promise.resolve(result).catch(listenerFailed)
          } catch (error) {
            listenerFailed(error)
          }
        }
      }
    },
    listenerFailures: () => ({ count: failureCount, lastError }),
    publish(value: GroupRuntimeSnapshot | null) {
      controller.install(value)?.()
    },
  }
  return controller
}
