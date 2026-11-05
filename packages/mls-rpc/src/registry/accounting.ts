import type { EntryCapability, EntryReads } from '../entry-capability.js'
import { groupBatchFor } from '../group-batch-binding.js'
import type { GroupKey, GroupTransaction } from '../persistence-types.js'
import { untilAbort } from '../runtime.js'
import { readSourceMetadata } from './source-command-runtime.js'

export function scheduleRegistryAccounting<TTx extends GroupTransaction>(params: {
  capability: EntryCapability<TTx>
  binding: object
  key: GroupKey
  source: 'live' | 'handoff' | 'trust'
  signal?: AbortSignal
  current(): boolean
  read(reads: EntryReads): Promise<void>
}): Promise<void> {
  params.capability.assertRoot()
  const current = () => !params.signal?.aborted && params.current()
  if (!current()) return Promise.resolve()
  return groupBatchFor(params.binding, params.key.groupID).schedule({
    source: JSON.stringify(['registry-accounting', params.key.incarnation, params.source]),
    kind: 'accounting',
    signal: params.signal,
    run: async () => {
      if (!current()) return
      const pending = params.capability.read(params.key.groupID, async (reads) => {
        if (!current()) return
        try {
          if (params.source !== 'trust') await readSourceMetadata(reads, params.key)
          await params.read(reads)
        } catch (error) {
          if (current()) throw error
        }
      })
      if (params.signal === undefined) await pending
      else await untilAbort(pending, params.signal)
    },
  })
}
