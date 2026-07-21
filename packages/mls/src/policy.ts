import { normalizeDID } from '@kokuin/token'
import type {
  GroupContextExtension,
  IncomingMessageAction,
  Proposal,
  ProposalWithSender,
} from 'ts-mls'
import { defaultProposalTypes, isDefaultProposal } from 'ts-mls'

import { LEDGER_HEAD_EXTENSION_TYPE, RESERVED_EXTENSION_TYPE } from './anchor.js'
import type { RosterState } from './roster.js'

/**
 * Everything the receiving-side gate needs, resolved by the caller. Pure: no group handle, no
 * I/O. `didOfLeaf` maps a pre-commit leaf index to its member DID (undefined if unresolvable).
 * `currentExtensions` is the pre-commit extension list the group-context-extensions rule pins
 * against. `externalCommitDID` is the DID resolved from an external commit's UpdatePath leaf
 * (precomputed by the caller); undefined for a non-external commit.
 */
export type CommitPolicyContext = {
  /** Roster before the commit. Judges every sender's authority — a promotion riding this same
   *  commit doesn't grant its subject commit authority. */
  baseRoster: RosterState
  /** Roster after foldEnvelope applies this commit's kumiai.role entries. Judges the removed
   *  target: a Remove of a leaf still `admin` here carried no demotion and is rejected. */
  candidateRoster: RosterState
  didOfLeaf: (leafIndex: number) => string | undefined
  /** The pre-commit GroupContext extension list. A group_context_extensions commit may change
   *  nothing in it but the ledger_head entry. */
  currentExtensions: Array<GroupContextExtension>
  /** The head extension bytes this commit must install: the current head extended by the
   *  commit's envelope entry ids, in order. Equals the current head when the commit enacts
   *  nothing, so a commit that moves the head without enacting anything is rejected too. */
  expectedHeadExtensionData: Uint8Array
  /** Whether the commit's envelope names any entries. */
  commitEnactsEntries: boolean
  externalCommitDID?: string
}

/** A commit or standalone proposal handed to the gate, matching the ts-mls callback shape. */
type IncomingMessage =
  | { kind: 'commit'; senderLeafIndex: number | undefined; proposals: Array<ProposalWithSender> }
  | { kind: 'proposal'; proposal: ProposalWithSender }

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

/**
 * Fail-closed admin check: no DID, a DID absent from the roster, or any role but `admin`, is
 * not admin. An undefined leaf (external commit with no committer) is never admin.
 */
function isAdmin(context: CommitPolicyContext, leafIndex: number | undefined): boolean {
  if (leafIndex === undefined) {
    return false
  }
  const did = context.didOfLeaf(leafIndex)
  if (did === undefined) {
    return false
  }
  return context.baseRoster.roles.get(normalizeDID(did)) === 'admin'
}

/**
 * The group-context-extensions rule: an admin may replace the extension list only to move the
 * ledger-head to the head this commit's envelope accounts for, or to also install
 * {@link RESERVED_EXTENSION_TYPE} empty. A GCE proposal replaces the *entire* list, so the
 * proposed list must positionally equal the current one — same length, types, positions,
 * byte-identical data — except the ledger_head entry (must equal the expected head) and at
 * most one added `RESERVED_EXTENSION_TYPE` entry with empty data. This pins every other
 * extension, so an admin can't inject or strip one (e.g. external_senders, which lets a
 * non-member inject proposals) inside a head move, nor install the reserved type with
 * non-empty data — it isn't consumed by anything yet, so no policy exists for its data.
 *
 * The head must equal the current head extended by the envelope's entry ids in order; moved to
 * anything else, or moved by a commit enacting nothing, and it stops proving what the group
 * enacted.
 */
function evaluateGroupContextExtensions(
  extensions: Array<{ extensionType: number; extensionData: unknown }>,
  context: CommitPolicyContext,
): IncomingMessageAction {
  const expected = context.currentExtensions.map((ext) =>
    ext.extensionType === LEDGER_HEAD_EXTENSION_TYPE
      ? {
          extensionType: LEDGER_HEAD_EXTENSION_TYPE,
          extensionData: context.expectedHeadExtensionData,
        }
      : ext,
  )
  // The only freedom beyond the head move: one added RESERVED_EXTENSION_TYPE entry with empty
  // data, and only if not already installed — an install, not a second copy. Strip it, if
  // present, before the positional compare below; every other difference falls through and is
  // rejected as before.
  let candidate = extensions
  const reservedAlreadyInstalled = expected.some(
    (ext) => ext.extensionType === RESERVED_EXTENSION_TYPE,
  )
  if (!reservedAlreadyInstalled && extensions.length === expected.length + 1) {
    const reservedIndex = extensions.findIndex((ext) => {
      return (
        ext.extensionType === RESERVED_EXTENSION_TYPE &&
        ext.extensionData instanceof Uint8Array &&
        ext.extensionData.length === 0
      )
    })
    if (reservedIndex !== -1) {
      candidate = extensions.slice(0, reservedIndex).concat(extensions.slice(reservedIndex + 1))
    }
  }
  if (candidate.length !== expected.length) return 'reject'
  for (let i = 0; i < expected.length; i++) {
    const got = candidate[i]
    const want = expected[i]
    if (got.extensionType !== want.extensionType) return 'reject'
    // Both sides must be raw bytes to compare. ts-mls's extensionsEqual isn't re-exported, so
    // this hand-rolled compare only handles Uint8Array data; a decoded-object extension (e.g.
    // external_senders, required_capabilities) fails the instanceof guard and is rejected even
    // if unmodified — fail-closed liveness, not a security gap, since no group here anchors one
    // today. Revisit if one is introduced.
    if (
      !(got.extensionData instanceof Uint8Array) ||
      !(want.extensionData instanceof Uint8Array) ||
      !bytesEqual(got.extensionData, want.extensionData)
    ) {
      return 'reject'
    }
  }
  return 'accept'
}

/**
 * Apply one proposal's row for the given effective sender. Unknown/custom types fail closed.
 * `external_init` is judged at the commit level, never here — a standalone one rejects.
 */
function evaluateProposal(
  proposal: Proposal,
  effectiveSender: number | undefined,
  context: CommitPolicyContext,
): IncomingMessageAction {
  if (!isDefaultProposal(proposal)) {
    return 'reject'
  }
  switch (proposal.proposalType) {
    case defaultProposalTypes.add:
    case defaultProposalTypes.psk:
    case defaultProposalTypes.reinit:
      return isAdmin(context, effectiveSender) ? 'accept' : 'reject'
    case defaultProposalTypes.remove: {
      // A removed admin must have been demoted in this same envelope — still `admin` in the
      // candidate roster means no demotion rode the commit. Checked before the self-removal
      // shortcut, so an admin can't self-remove without demoting itself.
      const removedDID = context.didOfLeaf(proposal.remove.removed)
      if (
        removedDID !== undefined &&
        context.candidateRoster.roles.get(normalizeDID(removedDID)) === 'admin'
      ) {
        return 'reject'
      }
      if (isAdmin(context, effectiveSender)) {
        return 'accept'
      }
      return effectiveSender !== undefined && proposal.remove.removed === effectiveSender
        ? 'accept'
        : 'reject'
    }
    case defaultProposalTypes.update:
      return 'accept'
    case defaultProposalTypes.group_context_extensions:
      return isAdmin(context, effectiveSender)
        ? evaluateGroupContextExtensions(proposal.groupContextExtensions.extensions, context)
        : 'reject'
    default:
      return 'reject'
  }
}

/**
 * The whole-commit external-init rule. An external commit joins by proving control of a
 * roster DID's key and removing that DID's stale leaf: accepted only when `externalCommitDID`
 * is a roster member and the proposals are exactly one `external_init` plus one `remove` of the
 * leaf whose DID matches — nothing else.
 */
function evaluateExternalCommit(
  proposals: Array<ProposalWithSender>,
  context: CommitPolicyContext,
): IncomingMessageAction {
  const did = context.externalCommitDID
  if (did === undefined || !context.baseRoster.roles.has(normalizeDID(did))) {
    return 'reject'
  }
  if (proposals.length !== 2) {
    return 'reject'
  }
  let sawExternalInit = false
  let removeTarget: number | undefined
  for (const { proposal } of proposals) {
    if (!isDefaultProposal(proposal)) {
      return 'reject'
    }
    if (proposal.proposalType === defaultProposalTypes.external_init) {
      sawExternalInit = true
    } else if (proposal.proposalType === defaultProposalTypes.remove) {
      removeTarget = proposal.remove.removed
    } else {
      return 'reject'
    }
  }
  if (!sawExternalInit || removeTarget === undefined) {
    return 'reject'
  }
  return context.didOfLeaf(removeTarget) === did ? 'accept' : 'reject'
}

/**
 * Pure receiving-side commit policy: given the resolved context, decides whether an incoming
 * commit or standalone proposal is admissible. Never throws.
 *
 * Per proposal, the effective sender is its own `senderLeafIndex` if present, else the
 * committer's — a commit may carry by-reference proposals from other members, so checking only
 * the committer would let an admin launder a member's Remove. Every proposal must pass its row
 * or the whole commit rejects; no proposals is a key rotation any member may make. An
 * `external_init` anywhere routes the whole commit to the external-init rule instead of the
 * per-proposal loop.
 *
 * One rule isn't a proposal's own: a commit enacting ledger entries must carry a
 * group-context-extensions proposal, or entries would be enacted without moving the head.
 */
export function defaultCommitPolicy(
  incoming: IncomingMessage,
  context: CommitPolicyContext,
): IncomingMessageAction {
  if (incoming.kind === 'proposal') {
    const { proposal, senderLeafIndex } = incoming.proposal
    return evaluateProposal(proposal, senderLeafIndex, context)
  }

  const { proposals, senderLeafIndex } = incoming
  if (
    context.commitEnactsEntries &&
    !proposals.some(
      ({ proposal }) => proposal.proposalType === defaultProposalTypes.group_context_extensions,
    )
  ) {
    return 'reject'
  }
  if (proposals.length === 0) {
    return 'accept'
  }
  if (
    proposals.some(({ proposal }) => proposal.proposalType === defaultProposalTypes.external_init)
  ) {
    return evaluateExternalCommit(proposals, context)
  }
  for (const { proposal, senderLeafIndex: proposalSender } of proposals) {
    const effectiveSender = proposalSender ?? senderLeafIndex
    if (evaluateProposal(proposal, effectiveSender, context) === 'reject') {
      return 'reject'
    }
  }
  return 'accept'
}

/**
 * Thrown by the caller's resolver when an envelope names entry ids the ledger can't resolve.
 * Belongs to the commit-policy resolution boundary, but {@link defaultCommitPolicy} itself is
 * pure and total, and never throws it.
 */
export class MissingLedgerEntriesError extends Error {
  #ids: Array<string>

  constructor(ids: Array<string>) {
    super(`ledger entries could not be resolved: ${ids.join(', ')}`)
    this.name = 'MissingLedgerEntriesError'
    this.#ids = ids
  }

  /** The entry ids named by the envelope that could not be resolved. */
  get ids(): Array<string> {
    return this.#ids
  }
}
