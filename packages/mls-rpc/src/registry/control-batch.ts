import type { GroupHandle } from '@kumiai/mls'
import type { AnchorSlot, AnchorStore, ControlSnapshot, ControlStore, GroupKey } from '@kumiai/rpc'

import type { ControlHandleAccess } from '../access.js'
import type { createControlValidationPort } from '../control-validation.js'
import type { RegistryHandleAccess } from './types.js'

export type RegistryControlBatchEntry = {
  key: GroupKey
  run<T>(input: {
    source: string
    signal?: AbortSignal
    prepare(scope: {
      access: ControlHandleAccess
      control: ControlStore
      anchor: AnchorStore
    }): Promise<T>
  }): Promise<{ value: T; epoch: number; control: ControlSnapshot; anchor: AnchorSlot | null }>
}

const bindings = new WeakMap<
  RegistryHandleAccess | ControlHandleAccess,
  RegistryControlBatchEntry
>()
const restorers = new WeakMap<ControlHandleAccess, (bytes: Uint8Array) => Promise<GroupHandle>>()
const sources = new WeakMap<
  ControlHandleAccess,
  NonNullable<Parameters<typeof createControlValidationPort>[0]['restoreSource']>
>()

export class ControlDrainRequiredError extends Error {
  constructor() {
    super('Opened plaintext must drain before control removal')
    this.name = 'ControlDrainRequiredError'
  }
}

export function bindControlSourceRestore(
  access: ControlHandleAccess,
  restore: NonNullable<Parameters<typeof createControlValidationPort>[0]['restoreSource']>,
): void {
  sources.set(access, restore)
}

export function controlSourceRestore(access: ControlHandleAccess) {
  return sources.get(access)
}

export function bindControlCandidateRestore(
  access: ControlHandleAccess,
  restore: (bytes: Uint8Array) => Promise<GroupHandle>,
): void {
  restorers.set(access, restore)
}

export function controlCandidateRestore(access: ControlHandleAccess) {
  const restore = restorers.get(access)
  if (restore === undefined) throw new TypeError('Missing control candidate restore')
  return restore
}

export function bindRegistryControlBatch(
  access: RegistryHandleAccess | ControlHandleAccess,
  entry: RegistryControlBatchEntry,
): void {
  bindings.set(access, entry)
}

export function registryControlBatch(
  access: RegistryHandleAccess | ControlHandleAccess,
): RegistryControlBatchEntry | undefined {
  return bindings.get(access)
}
