import { type ClientState, defaultCredentialTypes, isDefaultCredential, nodeTypes } from 'ts-mls'

import { parseMLSCredentialIdentity } from './credential.js'
import type { VerifiedLedgerEntry } from './ledger.js'
import { DEVICE_ENTRY_TYPE } from './registry.js'

export const HISTORY_HORIZON = 393_216

const utf8 = new TextEncoder()

function eventBytes(events: ReadonlyArray<unknown>): number {
  return events.reduce<number>(
    (total, event) => total + utf8.encode(JSON.stringify(event)).length,
    0,
  )
}

/** Count validated controller history. Callers apply the horizon only to lifecycle groups. */
export function historySize(
  tree: ClientState['ratchetTree'],
  entries: ReadonlyArray<VerifiedLedgerEntry>,
): number {
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
    if (binding != null) size += eventBytes(binding.prefix)
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
    if (Array.isArray(proof)) size += eventBytes(proof)
  }
  return size
}
