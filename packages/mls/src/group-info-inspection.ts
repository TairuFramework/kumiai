import { normalizeDID } from '@kokuin/token'
import {
  type Credential,
  decode,
  defaultCredentialTypes,
  isDefaultCredential,
  type MlsMessage,
  mlsMessageDecoder,
  wireformats,
} from 'ts-mls'

import {
  decodeGroupAnchor,
  GROUP_ANCHOR_EXTENSION_TYPE,
  LEDGER_HEAD_EXTENSION_TYPE,
} from './anchor.js'
import { verifyLeafCredential } from './authentication.js'
import { parseMLSCredentialIdentity } from './credential.js'
import { LeafBindingError } from './errors.js'
import { resolveMlsContext } from './group-context.js'
import { foldLedgerControl, type LedgerLogEntry, registryWithTreeBindings } from './group-handle.js'
import type { JoinGroupExternalParams } from './group-welcome.js'
import { assertHeadMatches, computeHead, decodeLedgerHead } from './head.js'
import { ledgerEntryDigest, verifyLedgerEntry } from './ledger.js'
import { assertRecoveryBinding, validatePublicWelcomeTree } from './lifecycle.js'
import { SealedGroupInfoError } from './recovery.js'
import {
  readRecoveryPublicTree,
  validateRecoveryPublicTree,
  verifyRecoveryPublicGroupInfo,
} from './recovery-absence.js'

export type InspectRecoveryGroupInfoParams = Pick<
  JoinGroupExternalParams,
  'groupInfo' | 'identity' | 'credential' | 'controller' | 'ledgerEntries' | 'options'
>

/** @internal Shared external-join parsing and original credential authentication. */
export async function externalGroupInfoInputs(params: InspectRecoveryGroupInfoParams) {
  if (normalizeDID(params.identity.id) !== normalizeDID(params.credential.id))
    throw new LeafBindingError('identity-change')
  let message: MlsMessage | undefined
  try {
    message = decode(mlsMessageDecoder, params.groupInfo)
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: SealedGroupInfoError takes cause in its third argument.
    throw new SealedGroupInfoError('malformed', 'Invalid GroupInfo', { cause })
  }
  if (message?.wireformat !== wireformats.mls_group_info)
    throw new SealedGroupInfoError('malformed', 'Expected GroupInfo')
  const { groupInfo } = message
  const groupID = new TextDecoder().decode(groupInfo.groupContext.groupId)
  if (groupID !== params.credential.groupID)
    throw new SealedGroupInfoError('group-mismatch', 'GroupInfo names another group')
  const extension = groupInfo.groupContext.extensions.find(
    (entry) => entry.extensionType === GROUP_ANCHOR_EXTENSION_TYPE,
  )
  const anchor =
    extension?.extensionData instanceof Uint8Array
      ? decodeGroupAnchor(extension.extensionData)
      : null
  if (anchor === null) throw new SealedGroupInfoError('malformed', 'GroupInfo has no valid anchor')
  const context = await resolveMlsContext(params.options, anchor)
  const originalCredentials: Array<{ credential: Credential; signaturePublicKey: Uint8Array }> = []
  const authService = {
    async validateCredential(credential: Credential, signaturePublicKey: Uint8Array) {
      if (
        !isDefaultCredential(credential) ||
        credential.credentialType !== defaultCredentialTypes.basic
      )
        return false
      await verifyLeafCredential(credential, signaturePublicKey, {
        judging: () => ({ stage: 'structural', mode: 'rejudge' }),
        leafLifetime: () =>
          anchor.controller == null ? undefined : (anchor.leafLifetime ?? 86_400),
        trustedGrantLifetime: () =>
          anchor.controller == null ? undefined : (anchor.trustedGrantLifetime ?? 2_592_000),
      })
      const parsed = parseMLSCredentialIdentity(credential.identity)
      if (anchor.controller != null && parsed.controller == null)
        throw new LeafBindingError('floating-refused')
      if (
        anchor.controller != null &&
        parsed.controller != null &&
        normalizeDID(parsed.controller.id) !== normalizeDID(anchor.controller)
      )
        throw new LeafBindingError('controller-mismatch')
      originalCredentials.push({ credential, signaturePublicKey })
      return true
    },
  }
  return { message, groupInfo, groupID, anchor, context, originalCredentials, authService }
}

/** Validate public recovery inputs without generating keys, signing or constructing a candidate. */
export async function inspectRecoveryGroupInfo(
  params: InspectRecoveryGroupInfoParams,
): Promise<{ groupID: string; epoch: number }> {
  const inputs = await externalGroupInfoInputs(params)
  const { message, groupInfo, groupID, context, anchor } = inputs
  const epoch = Number(groupInfo.groupContext.epoch)
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < 0 ||
    !(await verifyRecoveryPublicGroupInfo(message, context.cipherSuite))
  )
    throw new SealedGroupInfoError('unauthenticated', 'Invalid GroupInfo signature or tree hash')
  await validateRecoveryPublicTree(message, context, inputs.authService)
  const { tree } = readRecoveryPublicTree(message)
  const log: Array<LedgerLogEntry> = []
  if (params.ledgerEntries !== undefined) {
    const extension = groupInfo.groupContext.extensions.find(
      (entry) => entry.extensionType === LEDGER_HEAD_EXTENSION_TYPE,
    )
    const head =
      extension?.extensionData instanceof Uint8Array
        ? decodeLedgerHead(extension.extensionData)
        : null
    if (head === null) throw new SealedGroupInfoError('malformed', 'GroupInfo has no ledger head')
    assertHeadMatches(head.head, computeHead(groupID, params.ledgerEntries.map(ledgerEntryDigest)))
    for (const token of params.ledgerEntries) {
      const verified = await verifyLedgerEntry(token)
      if (verified === null || verified.entry.groupID !== groupID)
        throw new SealedGroupInfoError('unauthenticated', 'Invalid recovery ledger')
      log.push({ entryID: ledgerEntryDigest(token), token, verified })
    }
  } else if (anchor.controller != null) {
    throw new SealedGroupInfoError('malformed', 'Lifecycle recovery requires its ledger')
  }
  const folded = foldLedgerControl(log, anchor, groupID)
  const group = {
    anchor,
    state: { ratchetTree: tree },
    registry: registryWithTreeBindings(folded.registry, tree, anchor),
    ledger: log,
  }
  await validatePublicWelcomeTree(group)
  await assertRecoveryBinding({ group, identity: params.identity, controller: params.controller })
  return { groupID, epoch }
}
