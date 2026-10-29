import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serialize } from 'node:v8'
import { didFromInception, type InceptionEvent } from '@kokuin/controller'

import { registryForLog } from '../src/registry.js'
import { buildSaturatedLog } from './fixtures/controller-epoch.js'

export default async function setup(): Promise<() => Promise<void>> {
  const log = await buildSaturatedLog()
  const inception = log.chain[0]
  if (inception?.event.t !== 'icp') throw new Error('Missing saturated inception')
  const registry = registryForLog(didFromInception(inception.event as InceptionEvent), log)
  const directory = await mkdtemp(join(tmpdir(), 'kumiai-mls-saturated-'))
  const path = join(directory, 'fixture.bin')
  try {
    await writeFile(path, serialize({ log, registry }))
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  // Workers start after setup completes and inherit this run's completed fixture.
  process.env.KUMIAI_MLS_SATURATED_FIXTURE_PATH = path
  return async () => {
    delete process.env.KUMIAI_MLS_SATURATED_FIXTURE_PATH
    await rm(directory, { recursive: true, force: true })
  }
}
