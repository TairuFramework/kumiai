import type { GroupBatchScheduler } from '@kumiai/rpc'

import { createGroupBatchScheduler, groupBatchOptions } from './group-batch.js'
import type { GroupBatchOptions } from './persistence-types.js'

type Binding = {
  options: Required<GroupBatchOptions>
  groups: Map<string, GroupBatchScheduler>
}

const bindings = new WeakMap<object, Binding>()

export function bindGroupBatchOptions(binding: object, options?: GroupBatchOptions): void {
  const resolved = groupBatchOptions(options)
  const existing = bindings.get(binding)
  if (existing !== undefined) {
    if (
      existing.options.maxBatchFrames !== resolved.maxBatchFrames ||
      existing.options.maxBatchDelayMs !== resolved.maxBatchDelayMs ||
      existing.options.maxBatchWorkMs !== resolved.maxBatchWorkMs
    )
      throw new Error('Coordinator already has different batch options')
    return
  }
  bindings.set(binding, { options: resolved, groups: new Map() })
}

export function groupBatchFor(binding: object, groupID: string): GroupBatchScheduler {
  if (!bindings.has(binding)) bindGroupBatchOptions(binding)
  const state = bindings.get(binding) as Binding
  let scheduler = state.groups.get(groupID)
  if (scheduler === undefined) {
    scheduler = createGroupBatchScheduler({ options: state.options })
    state.groups.set(groupID, scheduler)
  }
  return scheduler
}
