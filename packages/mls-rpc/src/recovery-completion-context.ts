import type { ControlChanges, GroupKey } from '@kumiai/rpc'

import type { GroupTransaction } from './persistence-types.js'

export const recoveryCompletionContexts = new WeakMap<
  GroupTransaction,
  { key: GroupKey; changes: ControlChanges }
>()
