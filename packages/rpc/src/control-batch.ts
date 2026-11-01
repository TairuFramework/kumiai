import type { AnchorSlot } from './anchor.js'
import type { ControlValidationPort } from './control/search.js'
import type {
  AdoptionExpected,
  ControlAdoptionPort,
  ControlChanges,
  ControlSnapshot,
  GroupKey,
} from './control/types.js'
import type { GroupCrypto, GroupMLS } from './crypto.js'

export type ReadyControlScope = {
  source: AdoptionExpected
  control(): ControlSnapshot
  anchor(): AnchorSlot | null
  readEpoch: GroupMLS['readEpoch']
  readCommitHeader: GroupMLS['readCommitHeader']
  rosterEntries: GroupMLS['rosterEntries']
  isLedgerComplete: GroupMLS['isLedgerComplete']
  openEntries: GroupCrypto['openEntries']
  exportSecret: GroupCrypto['exportSecret']
  validation: ControlValidationPort
  prepareCommit: GroupMLS['processCommit']
  prepareOwn: ControlAdoptionPort['adopt']
  stageControl(changes: ControlChanges, mutationID: string): void
  stageAnchor(slot: AnchorSlot): void
}
export type ControlBatchBinding = {
  key: GroupKey
  run<T>(input: {
    source: string
    signal?: AbortSignal
    prepare(scope: ReadyControlScope): Promise<T>
  }): Promise<{ value: T; epoch: number; control: ControlSnapshot; anchor: AnchorSlot | null }>
}

const bindings = new WeakMap<GroupMLS, ControlBatchBinding>()

export function bindControlBatch(mls: GroupMLS, binding: ControlBatchBinding): void {
  const existing = bindings.get(mls)
  if (existing !== undefined && existing !== binding)
    throw new Error('MLS already has a control batch binding')
  bindings.set(mls, binding)
}

export function controlBatch(mls: GroupMLS): ControlBatchBinding | undefined {
  return bindings.get(mls)
}
