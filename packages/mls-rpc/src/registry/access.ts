import type { GroupHandle } from '@kumiai/mls'
import type { SendAdmission } from '@kumiai/rpc'

import type { ControlRead, ControlReadScope } from '../access.js'
import type { EntryCapability, EntryReads } from '../entry-capability.js'
import { DisplacedGroupHandleError, GroupUnavailableError } from '../persistence-errors.js'
import type { GroupKey, GroupRecoveryTrust, GroupTransaction } from '../persistence-types.js'
import { type ColdEnvironment, restoreValidated, type ValidatedGroupState } from './cold.js'
import type { createRegistryRuntime } from './runtime.js'
import type { GroupRuntimeSnapshot, RegistryHandleAccess } from './types.js'

export type RegistryOwner = {
  key: GroupKey
  value: ValidatedGroupState
  acceptedTrust: GroupRecoveryTrust
  cacheValid: boolean
  snapshot: GroupRuntimeSnapshot
  admission: SendAdmission
  runtime: ReturnType<typeof createRegistryRuntime>
  hooks: Set<() => Promise<void>>
  access: RegistryHandleAccess | null
}

export function createRegistryAccess<TTx extends GroupTransaction>(params: {
  owner: RegistryOwner
  capability: EntryCapability<TTx>
  environment: ColdEnvironment
  load(reads: EntryReads): Promise<ValidatedGroupState>
  publish(): void
  invalidate(displaced: boolean): void
  assertCurrent(): void
  assertAvailable(): void
}): RegistryHandleAccess {
  const { owner, capability, environment } = params
  async function isolated(reads: EntryReads): Promise<ControlRead> {
    try {
      const value = await params.load(reads)
      if (value.key.incarnation !== owner.key.incarnation)
        throw new DisplacedGroupHandleError('Registry access belongs to a retired incarnation')
      const handle = await restoreValidated(value, environment)
      params.assertCurrent()
      return {
        handle,
        source: {
          key: { ...value.key },
          stateVersion: value.record.version,
          identity: {
            ...value.trust.installed,
            authenticator: value.trust.installed.authenticator.slice(),
          },
        },
      }
    } catch (error) {
      if (error instanceof GroupUnavailableError || error instanceof DisplacedGroupHandleError)
        params.invalidate(
          error instanceof DisplacedGroupHandleError ||
            (error instanceof GroupUnavailableError && error.reason === 'deleted'),
        )
      throw error
    }
  }
  async function read<T>(fn: (handle: GroupHandle) => T | Promise<T>): Promise<T> {
    params.assertAvailable()
    try {
      return await capability.read(owner.key.groupID, async (reads) => {
        const { handle } = await isolated(reads)
        return await fn(handle)
      })
    } finally {
      params.publish()
    }
  }
  async function readControl<T>(fn: (scope: ControlReadScope) => Promise<T>): Promise<T> {
    params.assertAvailable()
    try {
      return await capability.read(owner.key.groupID, async (reads) => {
        let active = true
        const refresh = async (): Promise<ControlRead> => {
          if (!active) throw new Error('Control read scope has ended')
          const value = await isolated(reads)
          if (!active) throw new Error('Control read scope has ended')
          return value
        }
        try {
          return await fn({ ...(await refresh()), refresh })
        } finally {
          active = false
        }
      })
    } finally {
      params.publish()
    }
  }
  return {
    get key() {
      return { ...owner.key }
    },
    get runtime() {
      return owner.runtime.runtime
    },
    epoch() {
      params.assertAvailable()
      return owner.snapshot.epoch
    },
    stateVersion() {
      params.assertAvailable()
      return owner.snapshot.stateVersion
    },
    admission() {
      params.assertAvailable()
      return { ...owner.admission }
    },
    read,
    readControl,
    onRetire(hook) {
      params.assertAvailable()
      const registered = () => hook()
      owner.hooks.add(registered)
      return () => {
        owner.hooks.delete(registered)
      }
    },
  }
}
