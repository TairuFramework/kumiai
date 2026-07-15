import { normalizeDID, type SigningIdentity } from '@kokuin/token'
import {
  createCommit,
  type DefaultProposal,
  defaultProposalTypes,
  encode,
  type GroupContextExtension,
  type KeyPackage,
  mlsMessageEncoder,
} from 'ts-mls'

import { LEDGER_HEAD_EXTENSION_TYPE } from './anchor.js'
import { encodeControlEnvelope } from './envelope.js'
import { foldEnvelope } from './envelope-fold.js'
import type { FoldInput } from './fold.js'
import {
  buildCommitPolicyContext,
  deriveGroup,
  type GroupHandle,
  mutexFor,
} from './group-handle.js'
import { buildLedgerHeadExtension, extendHead, readLedgerHead } from './head.js'
import { ledgerEntryDigest, signLedgerEntry, verifyLedgerEntry } from './ledger.js'
import { defaultCommitPolicy } from './policy.js'
import { type GroupPermission, ROLE_ENTRY_TYPE } from './roster.js'
import type { Invite } from './types.js'

export type CreateInviteParams = {
  group: GroupHandle
  identity: SigningIdentity
  recipientDID: string
  permission: GroupPermission
}

export type CreateInviteResult = {
  invite: Invite
}

/**
 * Create an invite for a new member. Does NOT add them — call commitInvite with
 * their key package for that.
 *
 * Only an admin may invite: a role entry from a non-admin issuer is dropped by every
 * receiver's fold, so refusing here turns a silent downstream rejection into a local
 * error.
 */
export async function createInvite(params: CreateInviteParams): Promise<CreateInviteResult> {
  const { group, identity, recipientDID, permission } = params
  if (group.roster.roles.get(normalizeDID(identity.id)) !== 'admin') {
    throw new Error('createInvite: the inviter must be an admin in the group roster')
  }

  // The role entry naming the invitee. Its issuer is the inviter (authenticated by
  // the token signature) and its value is the permission granted.
  const roleToken = await signLedgerEntry(identity, {
    type: ROLE_ENTRY_TYPE,
    groupID: group.groupID,
    subject: recipientDID,
    value: permission,
  })

  const invite: Invite = {
    groupID: group.groupID,
    inviterID: identity.id,
    // The whole log, new role entry last: a joiner handed only its own entry would
    // never learn of earlier role changes and would reject every commit by an admin
    // promoted since — a permanent fork nothing re-sends. The new entry must fold
    // after the history it depends on, hence last. Re-granting a role the log already
    // carries appends it again (a legal re-enactment). The joiner still folds from the
    // anchor, so padding this list cannot promote anyone.
    ledgerEntries: [...group.ledgerTokens, roleToken],
  }

  return { invite }
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
  ratchetTreeExtension = false,
): Promise<Awaited<ReturnType<typeof createCommit>>> {
  // Same reason createInvite guards the inviter: a non-admin's commit is rejected by
  // every receiver, so fail here rather than emitting a commit nobody will apply.
  if (group.roster.roles.get(normalizeDID(group.credential.id)) !== 'admin') {
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
  const fold = foldEnvelope(group.roster, inputs, group.groupID)
  if (!fold.ok) {
    throw new Error(`cannot enact ledger entry ${fold.entryID}: ${fold.reason}`)
  }

  const entryIDs = enacted.map(ledgerEntryDigest)

  // Filter the pending-proposal set the committer would otherwise absorb: ts-mls folds
  // every unappliedProposal into the commit, so a non-admin's pending proposal would
  // ride it and every peer would reject the whole thing — one member could stall the
  // group. Judge each against the same defaultCommitPolicy and context receivers build,
  // dropping any the group would reject.
  const filterContext = buildCommitPolicyContext(group, {
    baseRoster: group.roster,
    candidateRoster: fold.roster,
    entryIDs,
  })
  const keptPending: typeof group.state.unappliedProposals = {}
  for (const [ref, pws] of Object.entries(group.state.unappliedProposals)) {
    if (defaultCommitPolicy({ kind: 'proposal', proposal: pws }, filterContext) !== 'reject') {
      keptPending[ref] = pws
    }
  }
  const commitState = { ...group.state, unappliedProposals: keptPending }

  const proposals = [...extraProposals]
  if (entryIDs.length > 0) {
    proposals.push({
      proposalType: defaultProposalTypes.group_context_extensions,
      groupContextExtensions: { extensions: extensionsWithHead(group, entryIDs) },
    })
  }

  return await createCommit({
    context: group.context,
    state: commitState,
    extraProposals: proposals,
    ...(ratchetTreeExtension && { ratchetTreeExtension: true }),
    ...(entryIDs.length > 0 && {
      authenticatedData: encodeControlEnvelope({ v: 1, entries: entryIDs }),
    }),
  })
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
 * the invitee's role entry as it applies the Add. The envelope carries ids, not
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
    const addProposal: DefaultProposal = {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage },
    }
    const result = await commitWithEntries(group, [addProposal], enacted, true)

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
