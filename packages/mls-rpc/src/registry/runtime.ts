import type { ForkHalt, SafetyHold } from '@kumiai/rpc'

import { copyStoredValue, sameStoredValue } from '../memory-incarnation-stores.js'
import type { GroupEpochRuntime, GroupRuntimeSnapshot } from './types.js'

export function createRegistrySafetyLatch() {
  const reasons = new Set<NonNullable<SafetyHold>>()
  let appHold: ForkHalt | null = null
  const sinks = new Set<(reason: SafetyHold) => void>()
  const held = (): SafetyHold =>
    reasons.has('fork-halted') || appHold !== null
      ? 'fork-halted'
      : reasons.has('spent-set-corrupt')
        ? 'spent-set-corrupt'
        : reasons.has('recovery-unavailable')
          ? 'recovery-unavailable'
          : null
  function supply(sink: (reason: SafetyHold) => void): void {
    try {
      sink(held())
    } catch {
      // A broken core sink cannot change storage outcomes or suppress other sinks.
    }
  }
  function change(work: () => void): void {
    const before = held()
    work()
    if (before === held()) return
    for (const sink of [...sinks]) if (sinks.has(sink)) supply(sink)
  }
  return {
    held,
    latch(next: NonNullable<SafetyHold>): void {
      change(() => {
        reasons.add(next)
      })
    },
    report(halt: ForkHalt, fresh = false): void {
      if (!fresh && sameStoredValue(appHold, halt)) return
      change(() => {
        appHold = copyStoredValue(halt)
      })
    },
    prepareRelease(halt: ForkHalt): () => void {
      // Identical reports may be distinct incidents. Release only the captured latch.
      const incident = appHold
      return () => {
        if (
          halt.producer !== 'app-report' ||
          appHold !== incident ||
          !sameStoredValue(incident, halt)
        )
          return
        change(() => {
          appHold = null
        })
      }
    },
    subscribeChanged(sink: (reason: SafetyHold) => void): () => void {
      const registered = (value: SafetyHold) => sink(value)
      sinks.add(registered)
      if (held() !== null) supply(registered)
      return () => {
        sinks.delete(registered)
      }
    },
    subscribe(sink: (reason: NonNullable<SafetyHold>) => void): () => void {
      return this.subscribeChanged((reason) => {
        if (reason !== null) sink(reason)
      })
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
