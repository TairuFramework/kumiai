import type { CommitOnceWriteContext } from '@kumiai/rpc'

import type { GroupKey } from './persistence-types.js'

// Build authority is scoped to the provider transaction, never to caller changes.
export const controlBuildContexts = new WeakMap<object, CommitOnceWriteContext>()

// Finalisation verifies the pointer move promised by the retirement closure.
export const controlRetirementSources = new WeakMap<object, GroupKey>()
