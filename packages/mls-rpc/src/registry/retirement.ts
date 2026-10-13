import {
  DisplacedGroupHandleError,
  RegistryRetireHookError,
  RegistryRetiringError,
} from '../persistence-errors.js'
import type { GroupKey } from '../persistence-types.js'
import type { RegistryOwner } from './access.js'
import type { GroupHandleRegistry, RetirementAttempt } from './types.js'

export type RetirementSlot = {
  generation: number
  retirementGeneration: number
  lastRetirementKey: GroupKey | null
  owner: RegistryOwner | null
  retirement: { key: GroupKey; attempt: RetirementAttempt } | null
}
export type RegistryRetirement = {
  beginRetirement(key: GroupKey): RetirementAttempt
  assertAvailable(groupID: string): void
  assertGeneration(groupID: string, generation: number): void
}

// Internal lifecycle access for registry operations and provider-backed fixtures.
const retirements = new WeakMap<GroupHandleRegistry, RegistryRetirement>()

export function bindRegistryRetirement(
  registry: GroupHandleRegistry,
  retirement: RegistryRetirement,
): void {
  retirements.set(registry, retirement)
}
export function registryRetirement(registry: GroupHandleRegistry): RegistryRetirement {
  const retirement = retirements.get(registry)
  if (retirement === undefined) throw new Error('Unknown registry retirement coordinator')
  return retirement
}

export function createRegistryRetirement(params: {
  slot(groupID: string): RetirementSlot
  drain(groupID: string): Promise<void>
  displace(slot: RetirementSlot, key: GroupKey): void
  failureSignal?: AbortSignal
}): RegistryRetirement {
  function assertAvailable(groupID: string): void {
    if (params.failureSignal?.aborted) throw params.failureSignal.reason
    const hold = params.slot(groupID).retirement
    if (hold !== null) throw new RegistryRetiringError({ key: hold.key })
  }
  return {
    assertAvailable,
    assertGeneration(groupID, generation) {
      if (params.failureSignal?.aborted) throw params.failureSignal.reason
      const slot = params.slot(groupID)
      if (slot.retirementGeneration !== generation && slot.lastRetirementKey !== null)
        throw new RegistryRetiringError({ key: slot.lastRetirementKey })
    },
    beginRetirement(requestedKey) {
      const key = { ...requestedKey }
      const slot = params.slot(key.groupID)
      assertAvailable(key.groupID)
      if (slot.owner !== null && slot.owner.key.incarnation !== key.incarnation)
        throw new DisplacedGroupHandleError('Retirement source is no longer current')
      const hooks = slot.owner?.hooks ?? new Set<() => Promise<void>>()
      const generation = ++slot.generation
      slot.retirementGeneration++
      slot.lastRetirementKey = key
      let round: Promise<void> | null = null
      const onFailStop = () => settle('rolled-back')
      function settle(outcome: 'committed' | 'rolled-back'): void {
        if (slot.retirement?.attempt !== attempt) return
        params.failureSignal?.removeEventListener('abort', onFailStop)
        if (outcome === 'committed') params.displace(slot, key)
        else if (slot.owner !== null) slot.owner.cacheValid = false
        slot.retirement = null
        slot.generation++
        slot.retirementGeneration++
      }
      const attempt: RetirementAttempt = {
        generation,
        settle,
        drain() {
          if (round !== null) return round
          if (slot.retirement?.attempt !== attempt)
            return Promise.reject(new DisplacedGroupHandleError('Retirement attempt has ended'))
          const drain = async () => {
            const signal = params.failureSignal
            let fail!: (error: unknown) => void
            const failed = new Promise<never>((_resolve, reject) => {
              fail = reject
            })
            const onFailure = () => fail(signal?.reason)
            signal?.addEventListener('abort', onFailure, { once: true })
            try {
              if (signal?.aborted) throw signal.reason
              await Promise.race([params.drain(key.groupID), failed])
              if (signal?.aborted) throw signal.reason
              if (slot.retirement?.attempt !== attempt)
                throw new DisplacedGroupHandleError('Retirement attempt has ended')
              const results = await Promise.race([
                Promise.allSettled(
                  [...hooks].map(async (hook) => {
                    await hook()
                  }),
                ),
                failed,
              ])
              if (signal?.aborted) throw signal.reason
              const rejected = results.find((result) => result.status === 'rejected')
              if (rejected?.status === 'rejected')
                throw new RegistryRetireHookError('Registry retirement hook rejected', {
                  cause: rejected.reason,
                })
            } catch (error) {
              settle('rolled-back')
              throw error
            } finally {
              signal?.removeEventListener('abort', onFailure)
            }
          }
          round = drain().finally(() => {
            round = null
          })
          return round
        },
      }
      slot.retirement = { key, attempt }
      params.failureSignal?.addEventListener('abort', onFailStop, { once: true })
      return attempt
    },
  }
}
