import {
  type ControllerLog,
  didFromInception,
  type InceptionEvent,
  isControllerLog,
} from '@kokuin/controller'
import type { CryptoOptions } from '@kokuin/token'
import { type ClientState, defaultCredentialTypes, isDefaultCredential, nodeTypes } from 'ts-mls'

import { foldControllerLog } from './controller-log.js'
import { parseMLSCredentialIdentity } from './credential.js'
import type { VerifiedLedgerEntry } from './ledger.js'
import { DEVICE_ENTRY_TYPE } from './registry.js'

export const HISTORY_HORIZON = 393_216
export const MAX_EPOCH_EVENTS_FOR_LEAVES = 32
export const SETTLE_PROMPT_EPOCH_EVENTS = 24

export type EpochEventCountParams = {
  log: ControllerLog
} & CryptoOptions

export async function epochEventCount({ log, ...options }: EpochEventCountParams): Promise<number> {
  const inception = log.chain[0]?.event
  if (inception?.t !== 'icp') throw new Error('Missing controller inception')
  const folded = await foldControllerLog(
    didFromInception(inception as InceptionEvent),
    log,
    options,
  )
  if (!folded.ok) throw new Error(folded.reason)
  return folded.applied.length
}

export type SettleAdvisoryParams = {
  log: ControllerLog
} & CryptoOptions

export async function settleAdvisory({
  log,
  ...options
}: SettleAdvisoryParams): Promise<'ok' | 'prompt' | 'blocked'> {
  const count = await epochEventCount({ log, ...options })
  if (count > MAX_EPOCH_EVENTS_FOR_LEAVES) return 'blocked'
  return count >= SETTLE_PROMPT_EPOCH_EVENTS ? 'prompt' : 'ok'
}

const utf8 = new TextEncoder()

export function controllerLogSize(events: ReadonlyArray<unknown>): number {
  return events.reduce<number>(
    (total, event) => total + utf8.encode(JSON.stringify(event)).length,
    0,
  )
}

export function proofSize(value: unknown): number {
  return isControllerLog(value)
    ? controllerLogSize(value.chain) + controllerLogSize(value.events)
    : 0
}

export type HistorySizeParams = {
  tree: ClientState['ratchetTree']
  entries: ReadonlyArray<VerifiedLedgerEntry>
}

/** Count validated controller history. Callers apply the horizon only to lifecycle groups. */
export function historySize({ tree, entries }: HistorySizeParams): number {
  let size = 0
  for (const node of tree) {
    if (node == null || node.nodeType !== nodeTypes.leaf) continue
    const credential = node.leaf.credential
    if (
      !isDefaultCredential(credential) ||
      credential.credentialType !== defaultCredentialTypes.basic
    )
      continue
    const binding = parseMLSCredentialIdentity(credential.identity).controller
    if (binding != null) size += controllerLogSize(binding.prefix)
  }
  for (const { entry } of entries) {
    if (
      entry.type !== DEVICE_ENTRY_TYPE ||
      entry.value == null ||
      typeof entry.value !== 'object'
    ) {
      continue
    }
    const proof = (entry.value as { proof?: unknown }).proof
    size += proofSize(proof)
  }
  return size
}
