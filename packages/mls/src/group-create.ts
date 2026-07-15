import { createInMemoryDIDCache, normalizeDID, type OwnIdentity } from '@kokuin/token'
import { type ClientState, generateKeyPackageWithKey, createGroup as mlsCreateGroup } from 'ts-mls'

import {
  buildCurrentGroupAnchorExtension,
  decodeGroupAnchor,
  GROUP_ANCHOR_EXTENSION_TYPE,
  LEDGER_HEAD_EXTENSION_TYPE,
} from './anchor.js'
import type { MemberCredential } from './credential.js'
import { buildLeafCapabilities, resolveMlsContext } from './group-context.js'
import { makeMLSCredential } from './group-credential.js'
import { GroupHandle } from './group-handle.js'
import { buildLedgerHeadExtension, genesisHead } from './head.js'
import type { GroupOptions } from './types.js'

export type CreateGroupResult = {
  group: GroupHandle
  credential: MemberCredential
}

/** Create a new MLS group. The identity becomes the sole member and admin. */
export async function createGroup(
  identity: OwnIdentity,
  groupID: string,
  options?: GroupOptions,
): Promise<CreateGroupResult> {
  const cache = options?.cache ?? createInMemoryDIDCache()
  const context = await resolveMlsContext(options)

  // Every group is anchored at creation: creator is the epoch-0 admin, ledger head
  // starts at genesis. A caller-supplied anchor is left untouched (the caller owns
  // its contents); its `creatorDID` coupling to the creating identity is validated
  // below. A decode failure here is left to the fail-closed decode in the constructor.
  const extensions = [...(options?.extensions ?? [])]
  const suppliedAnchorExtension = extensions.find(
    (ext) => ext.extensionType === GROUP_ANCHOR_EXTENSION_TYPE,
  )
  if (suppliedAnchorExtension != null) {
    const suppliedAnchorData = suppliedAnchorExtension.extensionData
    const suppliedAnchor =
      suppliedAnchorData instanceof Uint8Array ? decodeGroupAnchor(suppliedAnchorData) : null
    if (
      suppliedAnchor != null &&
      normalizeDID(suppliedAnchor.creatorDID) !== normalizeDID(identity.id)
    ) {
      throw new Error(
        `createGroup: the anchor's creatorDID (${suppliedAnchor.creatorDID}) must be the creating identity (${identity.id})`,
      )
    }
  }
  if (!extensions.some((ext) => ext.extensionType === GROUP_ANCHOR_EXTENSION_TYPE)) {
    extensions.push(buildCurrentGroupAnchorExtension(identity.id))
  }
  if (!extensions.some((ext) => ext.extensionType === LEDGER_HEAD_EXTENSION_TYPE)) {
    extensions.push(buildLedgerHeadExtension(genesisHead(groupID)))
  }
  const statePromise = generateKeyPackageWithKey({
    credential: makeMLSCredential(identity),
    signatureKeyPair: { signKey: identity.privateKey, publicKey: identity.publicKey },
    cipherSuite: context.cipherSuite,
    capabilities: buildLeafCapabilities(extensions, options?.capabilities),
  }).then((keyPackage) => {
    return mlsCreateGroup({
      context,
      groupId: new TextEncoder().encode(groupID),
      keyPackage: keyPackage.publicPackage,
      privateKeyPackage: keyPackage.privatePackage,
      extensions,
    })
  })
  const state = await statePromise

  const credential: MemberCredential = {
    id: identity.id,
    groupID,
  }
  const group = new GroupHandle({
    state,
    credential,
    context,
    cache,
    resolver: options?.resolver,
    commitPolicy: options?.commitPolicy,
    resolveLedgerEntries: options?.resolveLedgerEntries,
    onLedgerEntries: options?.onLedgerEntries,
  })

  return { group, credential }
}

export type RestoreGroupParams = {
  state: ClientState
  credential: MemberCredential
  /** Signed ledger tokens the host persisted, replayed to rebuild the roster. */
  ledgerEntries?: Array<string>
  options?: GroupOptions
}

export async function restoreGroup(params: RestoreGroupParams): Promise<GroupHandle> {
  const cache = params.options?.cache ?? createInMemoryDIDCache()
  // Construction reseeds `{creator: 'admin'}` from the anchor in the restored state;
  // an anchorless state throws (the same fail-closed guard).
  const group = new GroupHandle({
    state: params.state,
    credential: params.credential,
    context: await resolveMlsContext(params.options),
    cache,
    resolver: params.options?.resolver,
    commitPolicy: params.options?.commitPolicy,
    resolveLedgerEntries: params.options?.resolveLedgerEntries,
    onLedgerEntries: params.options?.onLedgerEntries,
  })
  await group.applyLedgerEntries(params.ledgerEntries ?? [])
  return group
}
