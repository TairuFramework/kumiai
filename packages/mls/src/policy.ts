import { normalizeDID } from '@kokuin/token'
import type {
  GroupContextExtension,
  IncomingMessageAction,
  Proposal,
  ProposalWithSender,
} from 'ts-mls'
import { defaultProposalTypes, isDefaultProposal } from 'ts-mls'

import { LEDGER_HEAD_EXTENSION_TYPE } from './anchor.js'
import type { RosterState } from './roster.js'

/**
 * Everything the receiving-side gate needs, resolved by the caller. Pure: no
 * group handle, no I/O. `didOfLeaf` maps a pre-commit ratchet-tree leaf index to
 * its member DID (undefined for an empty or unresolvable leaf).
 * `currentExtensions` is the pre-commit GroupContext extension list, the baseline
 * the group-context-extensions rule pins. `externalCommitDID` is the DID resolved
 * from an external commit's UpdatePath leaf (precomputed by the caller); undefined
 * for a non-external commit.
 */
export type CommitPolicyContext = {
  /** Roster before this commit applies. Judges every proposal sender's authority:
   *  a promotion riding this same commit does not grant its subject commit authority. */
  baseRoster: RosterState
  /** Roster after foldEnvelope applies this commit's group.role entries. Judges the
   *  removed target: a Remove of a leaf still `admin` here carried no demotion and is rejected. */
  candidateRoster: RosterState
  didOfLeaf: (leafIndex: number) => string | undefined
  /** The pre-commit GroupContext extension list. A group_context_extensions commit
   *  may change nothing in it but the ledger_head entry. */
  currentExtensions: Array<GroupContextExtension>
  /** The head extension bytes this commit must install: the current head extended by
   *  the commit's envelope entry ids, in envelope order. Equals the current head when
   *  the commit enacts nothing, so a commit that moves the head without enacting
   *  anything is rejected too. */
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
 * Fail-closed admin check: a leaf that resolves to no DID, or a DID absent from
 * the roster, or one holding any role but `admin`, is not an admin. An undefined
 * leaf (external commit with no committer leaf) is never an admin.
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
 * The group-context-extensions rule: an admin may replace the extension list
 * only to move the ledger-head extension to the head this commit's envelope
 * accounts for. A GCE proposal replaces the *entire* list, so the proposed list
 * must positionally equal the current list — same length, same extension types in
 * the same positions, byte-identical data — with the single exception of the
 * ledger_head entry, whose data must equal the expected head. This pins the anchor
 * and every other extension: an admin cannot inject or strip an extension (e.g.
 * external_senders, which grants a non-member the ability to inject proposals)
 * inside an otherwise-valid head move.
 *
 * The head must equal the current head extended by the envelope's entry ids, in
 * envelope order. A head moved to anything else — including moved at all by a
 * commit that enacts nothing — would stop proving which entries the group has
 * enacted, which is the omission hole the head exists to close.
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
  if (extensions.length !== expected.length) return 'reject'
  for (let i = 0; i < expected.length; i++) {
    const got = extensions[i]
    const want = expected[i]
    if (got.extensionType !== want.extensionType) return 'reject'
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
 * Apply one proposal's row using the given effective sender. Unknown or custom
 * proposal types fail closed. `external_init` is evaluated at the commit level,
 * never here, so it rejects if it reaches a per-proposal row (a standalone
 * external_init).
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
      // A removed admin must have been demoted in this same envelope: the candidate
      // roster then shows them `member`. Still `admin` here means no demotion rode the
      // commit. Checked before the self-removal shortcut, so an admin cannot self-remove
      // without demoting itself.
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
 * The whole-commit external-init rule. An external commit joins by proving
 * control of a roster DID's key and removing that DID's stale leaf, so it is
 * accepted only when `externalCommitDID` is a roster member and the commit's
 * proposals are exactly one `external_init` plus one `remove` of the leaf whose
 * DID equals `externalCommitDID` — nothing else.
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
 * Pure receiving-side commit policy. Given the resolved context, decides whether
 * an incoming commit or standalone proposal is admissible. Never throws.
 *
 * Per proposal the effective sender is the proposal's own `senderLeafIndex` when
 * present, else the committer's — a commit may carry by-reference proposals
 * authored by other members, so checking only the committer would let an admin
 * launder a member's Remove. A commit is accepted only when every proposal
 * passes its row; the first failing proposal rejects the whole commit. A commit
 * with no proposals is a key rotation any member may make. When any proposal is
 * an `external_init`, the whole commit is judged by the external-init rule rather
 * than the per-proposal loop.
 *
 * One rule is not a proposal's own: a commit that enacts ledger entries must carry
 * a group-context-extensions proposal, or it would enact entries without moving the
 * head, and the head would stop covering the ledger.
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
 * Thrown by the caller's resolver path when the entry bodies an envelope names
 * cannot be resolved from the ledger. Carries the unresolved ids. Defined here
 * because it belongs to the commit-policy resolution boundary, but it is never
 * thrown by {@link defaultCommitPolicy}, which is pure and total.
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
