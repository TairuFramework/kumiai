import type { GroupKey } from './control/types.js'
import type { PendingAppFrame } from './crypto.js'

export type GroupTransaction = {
  providerID: string
  groupID: string | null
  onCommit(fn: () => void): void
  onRollback(fn: () => void): void
}

export type HandlerCompletion<TTx extends GroupTransaction> = {
  key: GroupKey
  complete(ids: Array<string>): Promise<void>
  transact(
    ids: Array<string>,
    handle: (tx: TTx, records: Array<PendingAppFrame>) => Promise<void>,
  ): Promise<void>
}
