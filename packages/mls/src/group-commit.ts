import { normalizeDID, type SigningIdentity } from '@kokuin/token'
import {
  type ClientState,
  createCommit,
  type DefaultProposal,
  defaultCredentialTypes,
  defaultProposalTypes,
  encode,
  type GroupContextExtension,
  isDefaultCredential,
  type KeyPackage,
  type LeafIndex,
  mlsMessageEncoder,
} from 'ts-mls'

import { LEDGER_HEAD_EXTENSION_TYPE } from './anchor.js'
import { parseMLSCredentialIdentity } from './credential.js'
import { verifyDeviceEntry } from './device-proof.js'
import { encodeControlEnvelope } from './envelope.js'
import { foldEnvelope } from './envelope-fold.js'
import type { FoldInput } from './fold.js'
import { assertBindingAuthorTime } from './group-credential.js'
import {
  buildCommitPolicyContext,
  deriveGroup,
  type GroupHandle,
  mutexFor,
} from './group-handle.js'
import { buildLedgerHeadExtension, extendHead, readLedgerHead } from './head.js'
import {
  ledgerEntryDigest,
  signLedgerEntry,
  type VerifiedLedgerEntry,
  verifyLedgerEntry,
} from './ledger.js'
import { prepareLifecycleGate, validateEntry } from './lifecycle.js'
import { authority, controllerOf, DEVICE_ENTRY_TYPE, type DeviceValue } from './registry.js'
import { type GroupPermission, ROLE_ENTRY_TYPE } from './roster.js'
import type { Invite } from './types.js'

export type InviteRecipientMismatchErrorParams = {
  groupID: string
  expectedDID: string
  actualDID: string
}

/** The supplied key package names a different identity from the invite's recipient. */
export class InviteRecipientMismatchError extends Error {
  #groupID: string
  #expectedDID: string
  #actualDID: string

  constructor(params: InviteRecipientMismatchErrorParams) {
    super(
      `commitInvite: the key package presents ${params.actualDID}, but the invite names recipient ${params.expectedDID}`,
    )
    this.name = 'InviteRecipientMismatchError'
    this.#groupID = params.groupID
    this.#expectedDID = params.expectedDID
    this.#actualDID = params.actualDID
  }

  get groupID(): string {
    return this.#groupID
  }

  /** DID the invite names. */
  get expectedDID(): string {
    return this.#expectedDID
  }

  /** DID the supplied key package presents. */
  get actualDID(): string {
    return this.#actualDID
  }
}

export type CreateInviteParams = {
  group: GroupHandle
  identity: SigningIdentity
  recipientDID: string
} & (
  | { permission: GroupPermission; entries?: never }
  | { permission?: never; entries?: Array<string> }
)

export type CreateInviteResult = {
  invite: Invite
}

/** Create an invite without adding its recipient; commitInvite enacts the admission. */
export async function createInvite(params: CreateInviteParams): Promise<CreateInviteResult> {
  const { group, identity, recipientDID } = params
  let appended: Array<string>
  if (group.anchor.controller != null) {
    if (params.permission != null)
      throw new Error('createInvite: lifecycle invites have no permission')
    if (group.findMemberLeafIndex(identity.id) == null) {
      throw new Error('createInvite: the inviter must hold a leaf')
    }
    appended = params.entries ?? []
    for (const token of appended) {
      const verified = await verifyLedgerEntry(token)
      if (
        verified == null ||
        verified.entry.groupID !== group.groupID ||
        verified.entry.type.startsWith('kumiai.') ||
        normalizeDID(verified.issuer) !== normalizeDID(identity.id)
      )
        throw new Error('createInvite: entries must be consumer entries signed by the inviter')
    }
  } else {
    if (params.permission == null)
      throw new Error('createInvite: standard invites require permission')
    if (group.roster.roles.get(authority(group.registry, identity.id)) !== 'admin') {
      throw new Error('createInvite: the inviter must be an admin in the group roster')
    }
    appended = [
      await signLedgerEntry(identity, {
        type: ROLE_ENTRY_TYPE,
        groupID: group.groupID,
        subject: recipientDID,
        value: params.permission,
      }),
    ]
  }
  return {
    invite: {
      groupID: group.groupID,
      inviterID: identity.id,
      recipientDID,
      ledgerEntries: [...group.ledgerTokens, ...appended],
    },
  }
}

/**
 * The GroupContext extension list a commit installs when it enacts `entryIDs`: the
 * current list with only the ledger-head extension replaced by the head extended by
 * those ids, in envelope order. Every other extension — the anchor above all — is the
 * verbatim object from the current GroupContext, never a re-encode: the receiving
 * policy byte-compares the anchor.
 */
function extensionsWithHead(
  group: GroupHandle,
  entryIDs: Array<string>,
): Array<GroupContextExtension> {
  const current = readLedgerHead(group)
  if (current == null) {
    throw new Error('group has no ledger head extension; it cannot enact ledger entries')
  }
  const next = buildLedgerHeadExtension(extendHead(current.head, entryIDs))
  return group.state.groupContext.extensions.map((ext) =>
    ext.extensionType === LEDGER_HEAD_EXTENSION_TYPE ? next : ext,
  )
}

/**
 * The one place a commit carrying control-ledger entries is built: `commitInvite`,
 * `removeMember`, and `commitLedgerEntries` all route through it, so envelope and
 * head never drift apart.
 *
 * `enacted` is exactly what this commit enacts, and only the caller can decide it:
 * entries are enacted by *position*, so one whose content the log already carries is
 * a legitimate re-enactment (e.g. a demotion back to a previously-held role) and must
 * not be filtered by content.
 *
 * The envelope names only what this commit enacts, never the whole history: replaying
 * history would re-judge every past entry against the present roster, and a grant by
 * a since-demoted admin would read as a non-admin's — freezing every group that ever
 * rotated admins.
 *
 * When `enacted` is non-empty the commit also carries a group-context-extensions
 * proposal advancing the head by exactly those ids, in envelope order. An empty list
 * moves no head and carries no envelope.
 */
export async function commitWithEntries(
  group: GroupHandle,
  extraProposals: Array<DefaultProposal>,
  enacted: Array<string>,
  options: {
    ratchetTreeExtension?: boolean
    requireAdmin?: boolean
    commitState?: ClientState
  } = {},
): Promise<Awaited<ReturnType<typeof createCommit>>> {
  if (group.anchor.controller != null && group.findMemberLeafIndex(group.credential.id) == null) {
    throw new Error('the committer must hold a leaf')
  }
  const ratchetTreeExtension = options.ratchetTreeExtension ?? false
  const requireAdmin = options.requireAdmin ?? true
  // Same reason createInvite guards the inviter: a non-admin's commit is rejected by
  // every receiver, so fail here rather than emitting a commit nobody will apply.
  // Authority-aware: a device of an admin profile commits as that profile. Device-only commits
  // (register/add/revoke/label) are authorized by proofs, not a role, so they pass requireAdmin:false.
  if (
    requireAdmin &&
    group.anchor.controller == null &&
    group.roster.roles.get(authority(group.registry, group.credential.id)) !== 'admin'
  ) {
    throw new Error('the committer must be an admin in the group roster')
  }

  // Fold the entries exactly as every receiver will; refuse to author a commit the
  // group would reject. Without this the write path fails *open*: the committer
  // advances its own log and head while every receiver rejects the commit, forking
  // itself off. Being an admin is not enough — an entry's own issuer must hold
  // authority at the position it lands, so a token signed by a since-demoted admin is
  // dead paper no matter who commits it.
  const inputs: Array<FoldInput> = []
  for (const token of enacted) {
    const verified = await verifyLedgerEntry(token)
    if (verified == null) {
      throw new Error('cannot enact a ledger entry whose signature does not verify')
    }
    inputs.push({ verified, entryID: ledgerEntryDigest(token) })
  }
  const fold = foldEnvelope(
    group.roster,
    group.registry,
    inputs,
    group.groupID,
    group.anchor.controller == null
      ? undefined
      : {
          controllerID: group.anchor.controller,
          memberController: (did) => group.bindingOfDID(did)?.controller,
        },
  )
  if (!fold.ok) {
    if (fold.error != null) throw fold.error
    throw new Error(`cannot enact ledger entry ${fold.entryID}: ${fold.reason}`)
  }

  // Same reason as the fold guard above: verify device entries against THIS group's tree and
  // registry so the committer never authors a commit every receiver's own gate will reject.
  const proofCtx = {
    bindingOfDID: (d: string) => group.bindingOfDID(d),
    controllerOf: (d: string) => controllerOf(group.registry, d),
  }
  for (const input of inputs) {
    if (input.verified.entry.type !== DEVICE_ENTRY_TYPE) continue
    if (
      group.anchor.controller != null &&
      (input.verified.entry.value as DeviceValue).op !== 'beacon'
    ) {
      continue
    }
    const ok = await verifyDeviceEntry(input.verified as VerifiedLedgerEntry<DeviceValue>, proofCtx)
    if (!ok) {
      throw new Error(`cannot enact device entry ${input.entryID}: proof verification failed`)
    }
  }

  const entryIDs = enacted.map(ledgerEntryDigest)

  const enactedDeviceEntries = inputs
    .filter((i) => i.verified.entry.type === DEVICE_ENTRY_TYPE)
    .map((i) => ({
      subject: normalizeDID(i.verified.entry.subject),
      op: (i.verified.entry.value as DeviceValue).op,
    }))
  const gateContext = buildCommitPolicyContext(group, {
    baseRoster: group.roster,
    candidateRoster: fold.roster,
    entryIDs,
    enactedDeviceEntries,
  })
  const commitState = { ...(options.commitState ?? group.state), unappliedProposals: {} }

  const proposals = [...extraProposals]
  if (entryIDs.length > 0) {
    proposals.push({
      proposalType: defaultProposalTypes.group_context_extensions,
      groupContextExtensions: { extensions: extensionsWithHead(group, entryIDs) },
    })
  }

  const gate = await prepareLifecycleGate(
    group,
    inputs.map(({ verified }) => verified),
    fold.registry,
    gateContext,
  )
  const incoming = {
    kind: 'commit' as const,
    senderLeafIndex: group.state.privatePath.leafIndex as LeafIndex,
    proposals: proposals.map((proposal) => ({
      proposal,
      senderLeafIndex: group.state.privatePath.leafIndex as LeafIndex,
    })),
  }
  gate.check(incoming)
  for (const proposal of proposals) {
    if (proposal.proposalType === defaultProposalTypes.add) {
      const leaf = proposal.add.keyPackage.leafNode
      if (
        isDefaultCredential(leaf.credential) &&
        leaf.credential.credentialType === defaultCredentialTypes.basic
      ) {
        assertBindingAuthorTime(parseMLSCredentialIdentity(leaf.credential.identity).controller)
      }
      await validateEntry(group, leaf)
    }
  }
  const result = await createCommit({
    context: group.context,
    state: commitState,
    extraProposals: proposals,
    ...(ratchetTreeExtension && { ratchetTreeExtension: true }),
    ...(entryIDs.length > 0 && {
      authenticatedData: encodeControlEnvelope({ v: 1, entries: entryIDs }),
    }),
  })
  await gate.postApply(result.newState)
  return result
}

/**
 * The entries an invite adds beyond the committer's own log: everything past the
 * log's length. Positional, never by content — a re-granted role is a token the log
 * already carries earlier, and content-narrowing would drop the very entry the invite
 * exists to enact.
 *
 * Positional narrowing is sound only when the invite's list *begins with* the
 * committer's log, so that is asserted, not assumed: an invite against a different
 * history would mis-slice and move the head by ids that do not follow the group's own,
 * corrupting the chain for every receiver.
 */
function entriesAddedByInvite(group: GroupHandle, invite: Invite): Array<string> {
  const held = group.ledgerTokens
  if (
    invite.ledgerEntries.length < held.length ||
    held.some((token, index) => invite.ledgerEntries[index] !== token)
  ) {
    throw new Error("commitInvite: the invite's ledger does not extend this group's own")
  }
  return invite.ledgerEntries.slice(held.length)
}

export type CommitLedgerEntriesResult = {
  /** Framed MLSMessage bytes. Broadcast to existing members via the DS. */
  commitMessage: Uint8Array
  newGroup: GroupHandle
  /** Post-commit epoch the group is now at (== newGroup.epoch). */
  epoch: bigint
}

/**
 * The admin write path for the control ledger: a commit carrying no membership
 * proposal, only the entries it enacts and the head move covering them. An entry that
 * never rides a commit is invisible to the head, and a joiner recomputing the head
 * would read the history as doctored.
 *
 * Enacts exactly `tokens` at the end of the log — including one whose content the log
 * already carries (how an admin is demoted back to a previously-held role). Rejects an
 * empty `tokens` list.
 *
 * Reads `group` and returns a NEW derived handle (`newGroup`); it never advances
 * `group`. The caller MUST adopt `newGroup` — never reuse `group` — before the next
 * commit: two commits from the same source handle both frame at its epoch and diverge.
 * The mutex only serializes concurrent calls against one handle; it does not make a
 * second commit from a superseded handle safe.
 */
export async function commitLedgerEntries(
  group: GroupHandle,
  tokens: Array<string>,
): Promise<CommitLedgerEntriesResult> {
  return mutexFor(group).run(async () => {
    if (tokens.length === 0) {
      throw new Error('commitLedgerEntries: no ledger entries to commit')
    }
    const result = await commitWithEntries(group, [], tokens)
    const newGroup = deriveGroup(group, result.newState)
    await newGroup.applyLedgerEntries(tokens)
    return {
      commitMessage: encode(mlsMessageEncoder, result.commit),
      newGroup,
      epoch: newGroup.epoch,
    }
  })
}

export type CommitInviteResult = {
  /** Framed MLSMessage bytes. Broadcast to existing members via the DS. */
  commitMessage: Uint8Array
  /** Framed MLSMessage(Welcome) bytes. Delivered to the new member. */
  welcomeMessage: Uint8Array
  newGroup: GroupHandle
  /** Post-commit epoch (== newGroup.epoch). NOT the commit's wire-header epoch: a
   *  commit is framed at the sender's pre-commit epoch (== epoch - 1n), which is what
   *  receivers compare against their own handle.epoch for ordering (see
   *  readMessageEpoch). */
  epoch: bigint
}

/**
 * Commit an invite by adding the invitee's key package. Produces an MLS Commit +
 * Welcome.
 *
 * The invite's ledger entries are enacted here: their content ids ride the commit's
 * control envelope and advance the head by exactly those ids, so every receiver folds
 * the appended entries as it applies the Add. The envelope carries ids, not
 * bodies — a receiver holding neither the entry nor a `resolveLedgerEntries` resolver
 * throws MissingLedgerEntriesError.
 *
 * The invite carries the group's whole history (a joiner has nothing to fold it onto),
 * but only the entries beyond that history ride the commit — see
 * {@link entriesAddedByInvite} and {@link commitWithEntries}.
 *
 * Reads `group` and returns a NEW derived handle (`newGroup`); it never advances
 * `group`. The caller MUST adopt `newGroup` — never reuse `group` — before the next
 * commit: two commits from the same source handle both frame at its epoch and diverge.
 * The mutex only serializes concurrent calls against one handle; it does not make a
 * second commit from a superseded handle safe.
 */
export async function commitInvite(
  group: GroupHandle,
  keyPackage: KeyPackage,
  invite: Invite,
): Promise<CommitInviteResult> {
  return mutexFor(group).run(async () => {
    if (invite.groupID !== group.groupID) {
      throw new Error(`commitInvite: invite is for group ${invite.groupID}, not ${group.groupID}`)
    }

    const enacted = entriesAddedByInvite(group, invite)

    const expectedDID = normalizeDID(invite.recipientDID)
    if (group.anchor.controller == null) {
      let grantedTo: string | null = null
      for (const token of enacted) {
        const verified = await verifyLedgerEntry(token)
        if (verified?.entry.type === ROLE_ENTRY_TYPE && verified.entry.groupID === group.groupID) {
          grantedTo = verified.entry.subject
        }
      }
      if (grantedTo == null) {
        throw new Error(
          `commitInvite: the invite enacts no ${ROLE_ENTRY_TYPE} entry for this group`,
        )
      }
      if (normalizeDID(grantedTo) !== expectedDID) {
        throw new InviteRecipientMismatchError({
          groupID: group.groupID,
          expectedDID,
          actualDID: normalizeDID(grantedTo),
        })
      }
    }

    // `credentialType !== basic` does not narrow on its own: CredentialCustom.credentialType is a
    // bare `number`, so the compiler cannot rule it out. ts-mls's own guard can.
    //
    // This inlines the same credential->DID chain `didFromCredential` (credential.ts) implements
    // for the receive-side policy, kept separate deliberately: this path needs to distinguish a
    // non-basic credential from a malformed-JSON failure for its error messages, and that helper
    // is deliberately unexported. The two must stay in agreement — if they diverge, the committer
    // authors a commit every receiver rejects, a liveness failure rather than a security one.
    const credential = keyPackage.leafNode.credential
    if (
      !isDefaultCredential(credential) ||
      credential.credentialType !== defaultCredentialTypes.basic
    ) {
      throw new Error(
        'commitInvite: the key package carries a non-basic credential, which names no DID to bind',
      )
    }
    const actualDID = normalizeDID(parseMLSCredentialIdentity(credential.identity).id)
    if (actualDID !== expectedDID) {
      throw new InviteRecipientMismatchError({
        groupID: group.groupID,
        expectedDID,
        actualDID,
      })
    }

    const addProposal: DefaultProposal = {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage },
    }
    const result = await commitWithEntries(group, [addProposal], enacted, {
      ratchetTreeExtension: true,
    })

    const newGroup = deriveGroup(group, result.newState)

    if (result.welcome == null) {
      throw new Error('commitInvite: expected a Welcome message for the add proposal')
    }
    // The entries this commit enacts are now part of the group's ledger.
    await newGroup.applyLedgerEntries(enacted)
    return {
      commitMessage: encode(mlsMessageEncoder, result.commit),
      welcomeMessage: encode(mlsMessageEncoder, result.welcome),
      newGroup,
      epoch: newGroup.epoch,
    }
  })
}
