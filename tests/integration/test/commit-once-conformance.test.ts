import { peerCommitOnceScenarios, testCommitOnceConformance } from '@kumiai/rpc-conformance'

import { runRealCommitOnceScenario } from './app-lane-e2e.js'

testCommitOnceConformance({
  label: 'real MLS',
  run: runRealCommitOnceScenario,
  scenarios: peerCommitOnceScenarios,
})
