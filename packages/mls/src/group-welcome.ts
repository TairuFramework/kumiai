import { normalizeDID, type OwnIdentity } from '@kokuin/token'
import {
  type ClientState,
  type Credential,
  contentTypes,
  decode,
  defaultCredentialTypes,
  defaultProposalTypes,
  encode,
  generateKeyPackageWithKey,
  isDefaultCredential,
  isDefaultProposal,
  type LeafIndex,
  type MlsPublicMessage,
  joinGroup as mlsJoinGroup,
  joinGroupExternal as mlsJoinGroupExternal,
  mlsMessageDecoder,
  mlsMessageEncoder,
  nodeTypes,
  proposalOrRefTypes,
  protocolVersions,
  type Welcome,
  wireformats,
} from 'ts-mls'

import { decodeGroupAnchor, GROUP_ANCHOR_EXTENSION_TYPE } from './anchor.js'
import { verifyLeafCredential } from './authentication.js'
import { sanitizeRatchetTree } from './codec.js'
import {
  type ControllerBinding,
  type MemberCredential,
  parseMLSCredentialIdentity,
} from './credential.js'
import { LeafBindingError } from './errors.js'
import { buildLeafCapabilities, resolveMlsContext } from './group-context.js'
import { assertBindingAuthorTime, makeMLSCredential } from './group-credential.js'
import { buildCommitPolicyContext, GroupHandle } from './group-handle.js'
import { assertHeadMatches, computeHead, readLedgerHead } from './head.js'
import { ledgerEntryDigest, verifyLedgerEntry } from './ledger.js'
import { prepareLifecycleGate, validateWelcomeTree } from './lifecycle.js'
import type { DeviceRegistry } from './registry.js'
import { ROLE_ENTRY_TYPE } from './roster.js'
import type { GroupOptions, Invite, KeyPackageBundle } from './types.js'

export type ProcessWelcomeResult = {
  group: GroupHandle
  credential: MemberCredential
}

export type ProcessWelcomeParams = {
  identity: OwnIdentity
  invite: Invite
  /** Wire-form framed MLSMessage(Welcome) bytes (preferred), or a pre-decoded
   *  ts-mls Welcome object (legacy). */
  welcome: Uint8Array | Welcome
  keyPackageBundle: KeyPackageBundle
  ratchetTree?: unknown
  options?: GroupOptions
}

/**
 * Process a Welcome message to join a group.
 */
type JoinGroupParams = Parameters<typeof mlsJoinGroup>[0]

export async function processWelcome(params: ProcessWelcomeParams): Promise<ProcessWelcomeResult> {
  const { identity, invite, welcome, keyPackageBundle, ratchetTree, options } = params
  const context = await resolveMlsContext(options)

  if (normalizeDID(invite.recipientDID) !== normalizeDID(identity.id)) {
    throw new Error('processWelcome: the invite recipient is not this identity')
  }

  let resolvedWelcome: unknown = welcome
  if (welcome instanceof Uint8Array) {
    const decoded = decode(mlsMessageDecoder, welcome)
    if (decoded == null || decoded.wireformat !== wireformats.mls_welcome) {
      throw new Error('processWelcome: expected a framed MLSMessage(Welcome)')
    }
    resolvedWelcome = decoded.welcome
  }

  const sanitizedTree = Array.isArray(ratchetTree) ? sanitizeRatchetTree(ratchetTree) : ratchetTree
  const state = await mlsJoinGroup({
    context,
    welcome: resolvedWelcome as JoinGroupParams['welcome'],
    keyPackage: keyPackageBundle.publicPackage as JoinGroupParams['keyPackage'],
    privateKeys: keyPackageBundle.privatePackage as JoinGroupParams['privateKeys'],
    ...(sanitizedTree != null && {
      ratchetTree: sanitizedTree as JoinGroupParams['ratchetTree'],
    }),
  })

  const joinedLeaf = state.ratchetTree[state.privatePath.leafIndex * 2]
  if (
    joinedLeaf?.nodeType !== nodeTypes.leaf ||
    !isDefaultCredential(joinedLeaf.leaf.credential) ||
    joinedLeaf.leaf.credential.credentialType !== defaultCredentialTypes.basic ||
    normalizeDID(parseMLSCredentialIdentity(joinedLeaf.leaf.credential.identity).id) !==
      normalizeDID(invite.recipientDID)
  ) {
    throw new Error('processWelcome: the joined leaf does not name the invite recipient')
  }

  const credential: MemberCredential = {
    id: identity.id,
    groupID: invite.groupID,
  }

  const group = new GroupHandle({
    state,
    credential,
    context,
    commitPolicy: options?.commitPolicy,
    resolveLedgerEntries: options?.resolveLedgerEntries,
    onLedgerEntries: options?.onLedgerEntries,
  })
  // The head authenticated in the joined GroupContext is the fold from genesis over the
  // group's entries, in order. Recompute it over the inviter's supplied entries: an
  // omitted, reordered, or truncated list cannot reproduce it. Checked before folding,
  // so an incomplete ledger never reaches the roster.
  const authenticated = readLedgerHead(group)
  if (authenticated == null) {
    throw new Error('processWelcome: the group has no ledger head extension')
  }
  assertHeadMatches(
    authenticated.head,
    computeHead(invite.groupID, invite.ledgerEntries.map(ledgerEntryDigest)),
  )

  // Fold the invite's entries: the roster is seeded from the anchor and the fold grants
  // authority only to an admin-so-far, so a member-signed entry cannot promote anyone
  // even though applyLedgerEntries itself is the permissive primitive.
  if (group.anchor.controller == null) {
    let namesSelf = false
    for (const token of invite.ledgerEntries) {
      const verified = await verifyLedgerEntry(token)
      if (
        verified?.entry.type === ROLE_ENTRY_TYPE &&
        verified.entry.groupID === invite.groupID &&
        normalizeDID(verified.entry.subject) === normalizeDID(identity.id)
      )
        namesSelf = true
    }
    if (!namesSelf)
      throw new Error('processWelcome: the invite carries no role entry naming this identity')
  }
  await group.applyLedgerEntries(invite.ledgerEntries)
  await validateWelcomeTree(group)

  return { group, credential }
}

export type ProcessWelcomeOnceParams = ProcessWelcomeParams & {
  /** The group ids this member already holds a handle for. */
  joined: Iterable<string>
}

/**
 * Join from a Welcome, unless this member already joined that group — then return
 * `null` and keep the existing handle.
 *
 * A Welcome is delivered AT LEAST ONCE by design (a sender re-delivers on a crash
 * between journaling its commit and delivering, or it would strand an invitee never
 * told it was added), so the receiver must absorb the repeat. {@link processWelcome}
 * does NOT — it is a pure function with no registry of joined groups, so a repeat
 * succeeds silently and hands back a second handle frozen at the join epoch.
 * **Adopting that handle rolls the member back: every member added since is gone from
 * its roster, it can no longer read traffic, and nothing raises an error.** This
 * function exists to remove that hazard.
 *
 * The check cannot be hoisted above `processWelcome`: a Welcome's group id is
 * encrypted to the joiner's key, so there is nothing to check until the handle exists.
 * So this joins, compares the resulting group id against `joined`, and drops the stale
 * handle (a local falling out of scope — nothing zeroizes its key material) rather than
 * returning it. Dedup keys on the group id alone; a Welcome for an id absent from
 * `joined` is an ordinary first join.
 */
export async function processWelcomeOnce(
  params: ProcessWelcomeOnceParams,
): Promise<ProcessWelcomeResult | null> {
  const { joined, ...welcomeParams } = params
  const held = new Set(joined)
  const result = await processWelcome(welcomeParams)
  if (held.has(result.group.groupID)) {
    return null
  }
  return result
}

// ---------------------------------------------------------------------------
// External rejoin (RFC 9420 §11.2.1 — stale device self-recovery)
// ---------------------------------------------------------------------------

export type JoinGroupExternalParams = {
  identity: OwnIdentity
  /** Framed MLSMessage(GroupInfo) bytes from exportGroupInfo. */
  groupInfo: Uint8Array
  /** Caller's cached credential (from prior processWelcome). Reused as-is,
   *  not re-validated. */
  credential: MemberCredential
  /** Stale-recovery only: atomically removes prior leaf for same identity. */
  resync: true
  /** Authenticated recovery reply ledger, checked against the source GroupContext. */
  ledgerEntries?: Array<string>
  controller?: ControllerBinding
  options?: GroupOptions
  authenticatedData?: Uint8Array
}

export type JoinGroupExternalResult = {
  /** Framed MLSMessage(PublicMessage) bytes. Broadcast to existing members. */
  commitMessage: Uint8Array
  /** New GroupHandle at post-commit epoch. */
  group: GroupHandle
  /** @internal Inputs from the source admission gate, without operational source secrets. */
  sourceTree: ClientState['ratchetTree']
  sourceRegistry: DeviceRegistry
}

export async function joinGroupExternal(
  params: JoinGroupExternalParams,
): Promise<JoinGroupExternalResult> {
  const {
    identity,
    groupInfo: groupInfoBytes,
    credential,
    resync,
    options,
    authenticatedData,
    controller,
    ledgerEntries,
  } = params

  // Resync replaces the caller's own prior leaf, so the rejoining identity must match
  // the presented credential. A friendly precheck, not the security boundary: on a
  // mismatch ts-mls rejects the external commit downstream anyway. Eviction
  // completeness rests on ts-mls requiring a matching prior leaf in the resynced tree,
  // which a removed member no longer has.
  if (normalizeDID(identity.id) !== normalizeDID(credential.id)) {
    throw new Error(
      `joinGroupExternal: identity.id (${identity.id}) must match credential.id (${credential.id}) for resync`,
    )
  }

  const message = decode(mlsMessageDecoder, groupInfoBytes)
  if (message == null) {
    throw new Error('Invalid groupInfo: failed to decode MLSMessage')
  }
  if (message.wireformat !== wireformats.mls_group_info) {
    throw new Error(
      `Invalid groupInfo: expected wireformat mls_group_info, got ${String(message.wireformat)}`,
    )
  }
  // Discriminated-union narrow via the literal wireformat tag — no cast needed.
  const { groupInfo } = message

  // A resync must target the group this credential names. The returned handle reports
  // `credential.groupID` whatever group it joins, so without this a caller steered onto
  // a GroupInfo for another group would hold a handle that lies about its identity.
  const offeredGroupID = new TextDecoder().decode(groupInfo.groupContext.groupId)
  if (offeredGroupID !== credential.groupID) {
    throw new Error(
      `joinGroupExternal: groupInfo names group ${offeredGroupID}, not credential.groupID (${credential.groupID})`,
    )
  }

  const anchorExtension = groupInfo.groupContext.extensions.find(
    (extension) => extension.extensionType === GROUP_ANCHOR_EXTENSION_TYPE,
  )
  const anchor =
    anchorExtension?.extensionData instanceof Uint8Array
      ? decodeGroupAnchor(anchorExtension.extensionData)
      : null
  if (anchor == null) throw new Error('joinGroupExternal: the group has no valid anchor')
  if (anchor.controller != null && controller == null)
    throw new LeafBindingError('floating-refused')
  assertBindingAuthorTime(controller)
  const context = await resolveMlsContext(options, anchor)
  const originalCredentials: Array<{ credential: Credential; signaturePublicKey: Uint8Array }> = []
  const joinContext = {
    ...context,
    authService: {
      async validateCredential(leafCredential: Credential, signaturePublicKey: Uint8Array) {
        if (
          !isDefaultCredential(leafCredential) ||
          leafCredential.credentialType !== defaultCredentialTypes.basic
        )
          return false
        const parsed = parseMLSCredentialIdentity(leafCredential.identity)
        if (anchor.controller != null && parsed.controller == null)
          throw new LeafBindingError('floating-refused')
        if (
          anchor.controller != null &&
          parsed.controller != null &&
          normalizeDID(parsed.controller.id) !== normalizeDID(anchor.controller)
        )
          throw new LeafBindingError('controller-mismatch')
        await verifyLeafCredential(leafCredential, signaturePublicKey, {
          leafLifetime: () =>
            anchor.controller == null ? undefined : (anchor.leafLifetime ?? 86_400),
          trustedGrantLifetime: () =>
            anchor.controller == null ? undefined : (anchor.trustedGrantLifetime ?? 2_592_000),
        })
        originalCredentials.push({ credential: leafCredential, signaturePublicKey })
        return true
      },
    },
  }

  // The rejoining leaf must advertise every GroupContext extension the group uses, or
  // ts-mls rejects the external join. Derive them from the GroupInfo being resynced
  // against, honoring an explicit capabilities override.
  const keyPackage = await generateKeyPackageWithKey({
    credential: makeMLSCredential(identity, controller),
    signatureKeyPair: { signKey: identity.privateKey, publicKey: identity.publicKey },
    cipherSuite: context.cipherSuite,
    capabilities: buildLeafCapabilities(groupInfo.groupContext.extensions, options?.capabilities),
  })

  const { publicMessage, newState } = await mlsJoinGroupExternal({
    context: joinContext,
    groupInfo,
    keyPackage: keyPackage.publicPackage,
    privateKeys: keyPackage.privatePackage,
    resync,
    ...(authenticatedData != null && { authenticatedData }),
  })

  const framedCommit: MlsPublicMessage = {
    version: protocolVersions.mls10,
    wireformat: wireformats.mls_public_message,
    publicMessage,
  }
  const commitMessage = encode(mlsMessageEncoder, framedCommit)

  const group = new GroupHandle({
    state: newState,
    credential,
    context,
    commitPolicy: options?.commitPolicy,
    resolveLedgerEntries: options?.resolveLedgerEntries,
    onLedgerEntries: options?.onLedgerEntries,
  })

  const ownIndex = newState.privatePath.leafIndex
  const own = newState.ratchetTree[ownIndex * 2]
  const previous = originalCredentials.find(
    ({ credential: candidate }) =>
      isDefaultCredential(candidate) &&
      candidate.credentialType === defaultCredentialTypes.basic &&
      normalizeDID(parseMLSCredentialIdentity(candidate.identity).id) === normalizeDID(identity.id),
  )
  if (own?.nodeType !== nodeTypes.leaf || previous == null)
    throw new LeafBindingError('identity-change')
  // Only the replaced leaf's credential and key affect the lifecycle predicates.
  if (publicMessage.content.contentType !== contentTypes.commit)
    throw new Error('Expected external commit')
  const proposals = publicMessage.content.commit.proposals.map((proposal) => {
    if (proposal.proposalOrRefType !== proposalOrRefTypes.proposal)
      throw new Error('Expected inline proposal')
    return { proposal: proposal.proposal, senderLeafIndex: ownIndex as LeafIndex }
  })
  const removed = proposals.find(
    ({ proposal }) =>
      isDefaultProposal(proposal) && proposal.proposalType === defaultProposalTypes.remove,
  )?.proposal
  if (
    removed == null ||
    !isDefaultProposal(removed) ||
    removed.proposalType !== defaultProposalTypes.remove
  )
    throw new Error('Missing replacement target')
  const beforeTree = newState.ratchetTree.slice()
  beforeTree[ownIndex * 2] = undefined
  beforeTree[removed.remove.removed * 2] = { ...own, leaf: { ...own.leaf, ...previous } }
  const before = new GroupHandle({
    state: { ...newState, ratchetTree: beforeTree, groupContext: groupInfo.groupContext },
    credential,
    context: await resolveMlsContext(options, anchor),
  })
  if (ledgerEntries != null) await before.bootstrapLedger(ledgerEntries)
  const gate = await prepareLifecycleGate(
    before,
    [],
    before.registry,
    buildCommitPolicyContext(before, {
      baseRoster: before.roster,
      candidateRoster: before.roster,
      entryIDs: [],
      enactedDeviceEntries: [],
    }),
    own.leaf,
  )
  gate.check({ kind: 'commit', senderLeafIndex: undefined, proposals })
  await gate.postApply(newState)
  await validateWelcomeTree(group)
  return { commitMessage, group, sourceTree: beforeTree, sourceRegistry: before.registry }
}
