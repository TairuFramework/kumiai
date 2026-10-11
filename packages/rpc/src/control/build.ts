import type { GroupCrypto } from '../crypto.js'
import type { LogPosition } from '../cursor.js'
import type { AdoptionExpected, ControlSlot, HostBuilt, Operation } from './types.js'

export type FrameControlBuild = (
  built: HostBuilt,
  seal: GroupCrypto['sealEntries'],
) => Promise<{ payload: Uint8Array; publishID: string; expectedHead: LogPosition | null }>

export type PrepareControlResult =
  | { kind: 'saved' | 'occupied' | 'moved' | 'expired'; operation: Operation }
  | { kind: 'rejected'; operation: Operation; reason: string }

export type ControlBuildPort = {
  prepareBuild(op: Operation, frame: FrameControlBuild): Promise<PrepareControlResult>
}

export type SaveControlBuild = (
  intent: Operation & { stage: 'intent' },
  built: ControlSlot,
  expected: AdoptionExpected,
  mutationID: string,
) => Promise<'saved' | 'moved' | 'occupied'>
