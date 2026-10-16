import type { CheckpointRecord, CheckpointStore } from '@kumiai/rpc'

import { memoryOperation } from './memory-group-state.js'
import { memoryRecordTable } from './memory-incarnation-stores.js'
import { GroupStateConflictError } from './persistence-errors.js'
import type { AtRestCodec, MemoryTransaction } from './persistence-types.js'

export function createUnlockedCheckpointStore(params: {
  tx: MemoryTransaction
  groupID: string
  atRest: AtRestCodec
}): CheckpointStore {
  const { tx, groupID, atRest } = params
  const table = memoryRecordTable<CheckpointRecord>({
    tx,
    key: { groupID, incarnation: null },
    namespace: 'checkpoints',
    atRest,
  })
  function validate(record: CheckpointRecord, id: string): void {
    if (
      record?.key?.groupID !== groupID ||
      record.id !== id ||
      !Number.isSafeInteger(record.key.incarnation) ||
      record.key.incarnation < 1 ||
      !['fact', 'publication', 'cursor'].includes(record.kind)
    ) {
      throw new GroupStateConflictError('Checkpoint record binding mismatch')
    }
  }
  async function load(id: string): Promise<CheckpointRecord | null> {
    const value = await table.load(id)
    if (value !== null) validate(value, id)
    return value
  }
  return {
    load,
    list: async () => {
      const records: Array<CheckpointRecord> = []
      for (const id of table.ids()) {
        const record = await load(id)
        if (record !== null) records.push(record)
      }
      return records
    },
    async put(record) {
      validate(record, record.id)
      await table.save(record.id, record)
    },
    async remove(ids) {
      for (const id of ids) table.remove(id)
    },
  }
}

export function createCheckpointStore(
  params: Parameters<typeof createUnlockedCheckpointStore>[0],
): CheckpointStore {
  const store = createUnlockedCheckpointStore(params)
  const { tx } = params
  return {
    load: memoryOperation(tx, store.load),
    list: memoryOperation(tx, store.list),
    put: memoryOperation(tx, store.put, 'side'),
    remove: memoryOperation(tx, store.remove, 'side'),
  }
}
