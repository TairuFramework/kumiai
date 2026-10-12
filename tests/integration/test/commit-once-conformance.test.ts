import { testCommitOnceConformance } from '@kumiai/rpc-conformance'

import { runRealCommitOnceScenario } from './app-lane-e2e.js'

testCommitOnceConformance({ label: 'real MLS', run: runRealCommitOnceScenario })

import { testControlCrashBoundaries } from '../../../packages/rpc/test/fixtures/peer.js'

testControlCrashBoundaries('real-mls')
