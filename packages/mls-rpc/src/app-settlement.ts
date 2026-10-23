import { entryCapability } from './entry-capability.js'
import { GroupStateConflictError } from './persistence-errors.js'
import type { GroupKey, GroupPersistence, GroupTransaction } from './persistence-types.js'

export async function finaliseAppSettlements<TTx extends GroupTransaction>(params: {
  persistence: GroupPersistence<TTx>
  key: GroupKey
}): Promise<void> {
  const key = { ...params.key }
  const capability = entryCapability(params.persistence)
  if (capability === null)
    throw new GroupStateConflictError('Settlement service requires registered entry capability')
  const entries = await capability.read(key.groupID, async (reads) => {
    const entries = await reads.outbox(key.incarnation)
    const certified = []
    for (const entry of entries) {
      if ((await reads.settlement(key.incarnation, entry.seq)) !== null) certified.push(entry)
    }
    return certified
  })
  for (const entry of entries) await capability.finaliseCertifiedApp(key, entry.seq)
}
