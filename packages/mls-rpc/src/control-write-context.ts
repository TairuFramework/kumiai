import type { CommitOnceWriteContext } from '@kumiai/rpc'

// Build authority is scoped to the provider transaction, never to caller changes.
export const controlBuildContexts = new WeakMap<object, CommitOnceWriteContext>()
