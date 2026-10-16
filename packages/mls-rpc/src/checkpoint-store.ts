import type { CheckpointRecord, CheckpointStore } from '@kumiai/rpc'

import {
  memoryOpen,
  memoryOperation,
  memoryReadAdmitted,
  memoryRequired,
} from './memory-group-state.js'
import { memoryRecordTable } from './memory-incarnation-stores.js'
import { physicalRecordKey } from './persistence-codec.js'
import { GroupStateConflictError } from './persistence-errors.js'
import type { AtRestCodec, MemoryTransaction } from './persistence-types.js'

function validate(record: CheckpointRecord, groupID: string, id: string): void {
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

export async function openCheckpointRow(
  params: { tx: MemoryTransaction; groupID: string; atRest: AtRestCodec },
  id: string,
  bytes: unknown,
): Promise<CheckpointRecord> {
  const { tx, groupID, atRest } = params
  let address: unknown
  try {
    address = JSON.parse(id)
  } catch (cause) {
    throw new GroupStateConflictError('Checkpoint address mismatch', { cause })
  }
  if (
    !Array.isArray(address) ||
    address.length !== 3 ||
    address[0] !== groupID ||
    address[1] !== null ||
    typeof address[2] !== 'string'
  )
    throw new GroupStateConflictError('Checkpoint address mismatch')
  const location = { groupID, incarnation: null, namespace: 'checkpoints', recordID: address[2] }
  if (id !== physicalRecordKey(location))
    throw new GroupStateConflictError('Checkpoint address mismatch')
  if (!(bytes instanceof Uint8Array))
    throw new GroupStateConflictError('Unreadable sealed checkpoint row')
  const record = (await memoryOpen(tx, atRest, location, bytes)) as CheckpointRecord
  validate(record, groupID, location.recordID)
  return record
}

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
  function rows() {
    const rows = tx.rows.checkpoints
    if (rows === undefined) throw new GroupStateConflictError('Missing checkpoint namespace')
    return rows
  }
  return {
    load: (id) =>
      memoryRequired(tx, async () => {
        const checkpointRows = rows()
        memoryReadAdmitted(tx)
        const physicalID = physicalRecordKey({
          groupID,
          incarnation: null,
          namespace: 'checkpoints',
          recordID: id,
        })
        const bytes = checkpointRows.get(physicalID)
        if (bytes === undefined) return null
        const record = await openCheckpointRow(params, physicalID, bytes)
        rows().has(physicalID)
        return record
      }),
    list: () =>
      memoryRequired(tx, async () => {
        const checkpointRows = rows()
        memoryReadAdmitted(tx)
        const records: Array<CheckpointRecord> = []
        for (const [id, bytes] of checkpointRows) {
          records.push(await openCheckpointRow(params, id, bytes))
        }
        rows()
        return records
      }),
    async put(record) {
      validate(record, groupID, record.id)
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
