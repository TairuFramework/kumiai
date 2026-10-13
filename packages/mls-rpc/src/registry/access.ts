import type { GroupHandle } from '@kumiai/mls'
import type { SendAdmission } from '@kumiai/rpc'

import type { ControlRead, ControlReadScope } from '../access.js'
import type { EntryCapability, EntryReads } from '../entry-capability.js'
import { DisplacedGroupHandleError } from '../persistence-errors.js'
import type { GroupKey, GroupTransaction } from '../persistence-types.js'
import { type ColdEnvironment, restoreValidated, type ValidatedGroupState } from './cold.js'
import type { createRegistryRuntime } from './runtime.js'
import type { RegistryHandleAccess } from './types.js'

export type RegistryOwner = {
  key: GroupKey
  value: ValidatedGroupState
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
  invalidate(): void
  assertCurrent(): void
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
      params.invalidate()
      throw error
    }
  }
  async function read<T>(fn: (handle: GroupHandle) => T | Promise<T>): Promise<T> {
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
    try {
      return await capability.read(owner.key.groupID, async (reads) => {
        let active = true
        const refresh = async (): Promise<ControlRead> => {
          if (!active) throw new Error('Control read scope has ended')
          return await isolated(reads)
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
    epoch: () => owner.value.snapshot.epoch,
    stateVersion: () => owner.value.record.version,
    admission: () => ({ ...owner.admission }),
    read,
    readControl,
    onRetire(hook) {
      owner.hooks.add(hook)
      return () => {
        owner.hooks.delete(hook)
      }
    },
  }
}
