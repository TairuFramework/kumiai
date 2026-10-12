import { testCommitOnceConformance } from '@kumiai/rpc-conformance'

import { runMemoryCommitOnceScenario } from './fixtures/peer.js'

testCommitOnceConformance({ label: 'strict memory MLS', run: runMemoryCommitOnceScenario })

import type {
  ConformanceControlAdoptionPort,
  ConformanceControlBuildRef,
  ConformanceControlHold,
  ConformanceControlSlot,
  ConformanceControlValidationPort,
  ConformanceFirstValidCommit,
  ConformanceOperation,
} from '@kumiai/rpc-conformance'

import type { ControlHold, ControlValidationPort } from '../src/control/search.js'
import type {
  ControlAdoptionPort,
  ControlBuildRef,
  ControlSlot,
  FirstValidCommit,
  Operation,
} from '../src/control/types.js'
import type { LogPosition } from '../src/cursor.js'

type RPCRecords = {
  slot: ControlSlot
  reference: ControlBuildRef
  operation: Operation
  hold: ControlHold
  acceptance: FirstValidCommit
  validation: ControlValidationPort
  adoption: ControlAdoptionPort
}
type Mirrors = {
  slot: ConformanceControlSlot<LogPosition>
  reference: ConformanceControlBuildRef<LogPosition>
  operation: ConformanceOperation<LogPosition>
  hold: ConformanceControlHold<LogPosition>
  acceptance: ConformanceFirstValidCommit<LogPosition>
  validation: ConformanceControlValidationPort<LogPosition>
  adoption: ConformanceControlAdoptionPort<LogPosition>
}
const _mirrorsCoverPorts = (value: Mirrors): RPCRecords => value
const _portsCoverMirrors = (value: RPCRecords): Mirrors => value
