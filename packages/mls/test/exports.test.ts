import { expect, test } from 'vitest'

import {
  type ControllerProjection,
  effectDelta,
  type FoldOk,
  ingestControllerLog,
  proofSize,
  recordedLogOf,
  registryForLog,
} from '../src/index.js'
import { buildEpoch } from './fixtures/controller-epoch.js'

test('controller log helpers are available through the package entry point', async () => {
  const { did, log } = await buildEpoch({ members: 0 })
  const ingested = ingestControllerLog(did, undefined, log)
  const after: FoldOk = ingested.after
  expect(after.ok).toBe(true)
  expect(effectDelta(undefined, after.head)).toEqual({
    denied: [],
    removed: [],
    generation: false,
  })

  const registry = registryForLog(did, log)
  const projection: ControllerProjection | undefined = registry.controllers.get(did)
  expect(projection?.recordedLog).toEqual(log)
  expect(recordedLogOf(registry, did)).toEqual(log)
})

test('proof sizing is available through the package entry point', () => {
  expect(proofSize({ chain: [], events: [] })).toBe(0)
})
