import { normalizeDID, type OwnIdentity } from '@kokuin/token'
import { type ClientState, generateKeyPackageWithKey, createGroup as mlsCreateGroup } from 'ts-mls'

import {
  buildCurrentGroupAnchorExtension,
  buildGroupAnchorExtension,
  decodeGroupAnchor,
  GROUP_ANCHOR_EXTENSION_TYPE,
  type GroupAnchor,
  LEDGER_HEAD_EXTENSION_TYPE,
} from './anchor.js'
import { verifyLeafCredential } from './authentication.js'
import type { MemberCredential } from './credential.js'
import { LeafBindingError } from './errors.js'
import { buildLeafCapabilities, resolveMlsContext } from './group-context.js'
import { assertBindingAuthorTime, makeMLSCredential } from './group-credential.js'
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
  assertBindingAuthorTime(options?.controller)

  // A binding enriches a supplied anchor before genesis; standard anchor bytes stay untouched.
  // Existing lifecycle fields must agree with the authored policy before the tree is validated.
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
    if (
      suppliedAnchor != null &&
      suppliedAnchorData instanceof Uint8Array &&
      options?.controller != null
    ) {
      const leafLifetime = options.leafLifetime ?? 86_400
      const trustedGrantLifetime = options.trustedGrantLifetime ?? 2_592_000
      if (
        suppliedAnchor.controller !== undefined &&
        suppliedAnchor.controller !== options.controller.id
      ) {
        throw new LeafBindingError('controller-mismatch')
      }
      if (
        (suppliedAnchor.leafLifetime !== undefined &&
          suppliedAnchor.leafLifetime !== leafLifetime) ||
        (suppliedAnchor.trustedGrantLifetime !== undefined &&
          suppliedAnchor.trustedGrantLifetime !== trustedGrantLifetime)
      ) {
        throw new Error('Lifecycle lifetime options must match the supplied anchor')
      }
      // Reading normally withholds future-version app payloads; authoring must preserve them.
      const original = JSON.parse(new TextDecoder().decode(suppliedAnchorData)) as GroupAnchor
      extensions[extensions.indexOf(suppliedAnchorExtension)] = buildGroupAnchorExtension({
        ...suppliedAnchor,
        app: original.app,
        controller: options.controller.id,
        leafLifetime,
        trustedGrantLifetime,
      })
    }
  }
  if (suppliedAnchorExtension == null) {
    extensions.push(
      options?.controller == null
        ? buildCurrentGroupAnchorExtension(identity.id)
        : buildGroupAnchorExtension({
            creatorDID: identity.id,
            version: 1,
            controller: options.controller.id,
            leafLifetime: options.leafLifetime ?? 86_400,
            trustedGrantLifetime: options.trustedGrantLifetime ?? 2_592_000,
          }),
    )
  }
  const anchorExtension = extensions.find(
    (ext) => ext.extensionType === GROUP_ANCHOR_EXTENSION_TYPE,
  )
  const anchorData = anchorExtension?.extensionData
  const anchor: GroupAnchor | null =
    anchorData instanceof Uint8Array ? decodeGroupAnchor(anchorData) : null
  if (anchor == null) throw new Error('group anchor extension present but could not be decoded')
  if (anchor.controller != null) {
    if (options?.controller == null) throw new LeafBindingError('floating-refused')
    if (normalizeDID(anchor.controller) !== normalizeDID(options.controller.id)) {
      throw new LeafBindingError('controller-mismatch')
    }
  } else if (options?.controller != null) {
    throw new LeafBindingError('controller-mismatch')
  }
  const context = await resolveMlsContext(options, anchor)
  const mlsCredential = makeMLSCredential(identity, options?.controller)
  if (options?.controller != null) {
    await verifyLeafCredential(mlsCredential, identity.publicKey, {
      leafLifetime: () => anchor.leafLifetime ?? 86_400,
      trustedGrantLifetime: () => anchor.trustedGrantLifetime ?? 2_592_000,
    })
  }
  if (!extensions.some((ext) => ext.extensionType === LEDGER_HEAD_EXTENSION_TYPE)) {
    extensions.push(buildLedgerHeadExtension(genesisHead(groupID)))
  }
  const statePromise = generateKeyPackageWithKey({
    credential: mlsCredential,
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
  // Construction reseeds control authority from the anchor in the restored state;
  // an anchorless state throws (the same fail-closed guard).
  const group = new GroupHandle({
    state: params.state,
    credential: params.credential,
    context: await resolveMlsContext(params.options),
    commitPolicy: params.options?.commitPolicy,
    resolveLedgerEntries: params.options?.resolveLedgerEntries,
    onLedgerEntries: params.options?.onLedgerEntries,
  })
  await group.applyLedgerEntries(params.ledgerEntries ?? [])
  return group
}
