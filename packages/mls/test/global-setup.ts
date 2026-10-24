import { rename, writeFile } from 'node:fs/promises'
import { serialize } from 'node:v8'
import { didFromInception, type InceptionEvent } from '@kokuin/controller'

import { registryForLog } from '../src/registry.js'
import { buildSaturatedLog, SATURATED_LOG_PATH } from './fixtures/controller-epoch.js'

export default async function setup(): Promise<void> {
  const log = await buildSaturatedLog()
  const inception = log.chain[0]
  if (inception?.event.t !== 'icp') throw new Error('Missing saturated inception')
  const registry = registryForLog(didFromInception(inception.event as InceptionEvent), log)
  const temporary = `${SATURATED_LOG_PATH}.${process.pid}`
  await writeFile(temporary, serialize({ log, registry }))
  await rename(temporary, SATURATED_LOG_PATH)
}
