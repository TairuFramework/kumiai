import { normalizeDID } from '@kokuin/token'
import {
  type ClientState,
  defaultCredentialTypes,
  defaultProposalTypes,
  isDefaultCredential,
  isDefaultProposal,
  type LeafNode,
  nodeTypes,
  type ProposalWithSender,
} from 'ts-mls'

import { parseMLSCredentialIdentity } from './credential.js'

/** More than one leaf of a lifecycle group names the DID an admission would replace. */
export class DuplicateMemberLeafError extends Error {
  #did: string

  constructor(did: string) {
    super(`The group holds more than one leaf for ${did}`)
    this.name = 'DuplicateMemberLeafError'
    this.#did = did
  }

  get did(): string {
    return this.#did
  }
}

function leafDID(leaf: LeafNode): string | undefined {
  if (
    !isDefaultCredential(leaf.credential) ||
    leaf.credential.credentialType !== defaultCredentialTypes.basic
  )
    return undefined
  try {
    const { id } = parseMLSCredentialIdentity(leaf.credential.identity)
    return id === '' ? undefined : normalizeDID(id)
  } catch {
    return undefined
  }
}

function leafIndicesOf(tree: ClientState['ratchetTree'], did: string): Array<number> {
  const indices: Array<number> = []
  for (const [position, node] of tree.entries()) {
    if (node?.nodeType === nodeTypes.leaf && leafDID(node.leaf) === did) indices.push(position / 2)
  }
  return indices
}

/**
 * The leaf an admission of `leaf` replaces: the one leaf the tree already holds for the same DID,
 * or `undefined` when it holds none. Two or more such leaves are ambiguous and refused.
 */
export function staleLeafIndex(
  tree: ClientState['ratchetTree'],
  leaf: LeafNode,
): number | undefined {
  const did = leafDID(leaf)
  if (did == null) return undefined
  const indices = leafIndicesOf(tree, did)
  if (indices.length > 1) throw new DuplicateMemberLeafError(did)
  return indices[0]
}

export type StaleLeafReplacementParams = {
  /** The tree before the commit. */
  before: ClientState['ratchetTree']
  /** The leaf a Remove targets. */
  target: number
  /** Every proposal the commit carries. */
  proposals: Array<ProposalWithSender>
  /** The committer's leaf. */
  committer: number
  /** The deny sets the replaced DID must be absent from. */
  denied: Array<ReadonlySet<string>>
}

/**
 * The added leaf that replaces `target` in the same commit, when the commit is an admission of a
 * fresh key package for the DID whose only leaf `target` is. The caller still judges that leaf as
 * the replacement of `target`; this only finds the pairing.
 */
export function stalePairedAdd(params: StaleLeafReplacementParams): LeafNode | undefined {
  const { before, target, proposals, committer, denied } = params
  if (target === committer) return undefined
  const node = before[target * 2]
  if (node?.nodeType !== nodeTypes.leaf) return undefined
  const did = leafDID(node.leaf)
  if (did == null || leafIndicesOf(before, did).length !== 1) return undefined
  if (denied.some((set) => [...set].some((held) => normalizeDID(held) === did))) return undefined
  const removes = proposals.filter(
    ({ proposal }) =>
      isDefaultProposal(proposal) &&
      proposal.proposalType === defaultProposalTypes.remove &&
      proposal.remove.removed === target,
  )
  const adds = proposals.flatMap(({ proposal }) =>
    isDefaultProposal(proposal) &&
    proposal.proposalType === defaultProposalTypes.add &&
    leafDID(proposal.add.keyPackage.leafNode) === did
      ? [proposal.add.keyPackage.leafNode]
      : [],
  )
  return removes.length === 1 && adds.length === 1 ? adds[0] : undefined
}
