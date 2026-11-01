import type { AppBatchBinding } from '@kumiai/rpc'

import type { RegistryHandleAccess } from './types.js'

export type RegistryStreamingOpen = AppBatchBinding['openReady']

const bindings = new WeakMap<RegistryHandleAccess, AppBatchBinding>()

export function bindRegistryStreamingOpen(
  access: RegistryHandleAccess,
  binding: AppBatchBinding,
): void {
  bindings.set(access, binding)
}

export function registryStreamingOpen(access: RegistryHandleAccess): AppBatchBinding | undefined {
  return bindings.get(access)
}
