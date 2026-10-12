import { testCommitOnceConformance } from '@kumiai/rpc-conformance'

import { testControlCrashBoundaries } from './fixtures/control-crash.js'
import { runControlProofConflict } from './fixtures/storage-persistence.js'

for (const mode of ['double', 'real-mls'] as const) {
  testControlCrashBoundaries(mode)
  testCommitOnceConformance({
    label: `sealed provider: ${mode}`,
    scenarios: ['ownership-conflict'],
    run: () => runControlProofConflict(mode),
  })
}
