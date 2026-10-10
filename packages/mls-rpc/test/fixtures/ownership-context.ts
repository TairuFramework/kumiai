import { AsyncLocalStorage } from 'node:async_hooks'

import type { OwnershipContextPort } from '../../src/persistence-types.js'

export function createAsyncLocalOwnershipContext(): OwnershipContextPort {
  const context = new AsyncLocalStorage<object>()
  return {
    run: (token, fn) => context.run(token, fn),
    get: () => context.getStore(),
  }
}
