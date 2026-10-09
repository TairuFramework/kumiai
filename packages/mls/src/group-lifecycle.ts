import {
  didFromInception,
  foldLog,
  type InceptionEvent,
  type SignedEvent,
} from '@kokuin/controller'
import { createSigningIdentityForDID, type DIDString, normalizeDID } from '@kokuin/token'
import {
  type ClientState,
  type DefaultProposal,
  defaultProposalTypes,
  encode,
  isDefaultProposal,
  mlsMessageEncoder,
  nodeTypes,
} from 'ts-mls'

import { readCapability } from './capability.js'
import { type ControllerBinding, parseMLSCredentialIdentity } from './credential.js'
import { LeafBindingError, RevokeProofError, type RevokeProofReason } from './errors.js'
import { commitWithEntries } from './group-commit.js'
import { assertBindingAuthorTime } from './group-credential.js'
import type { DeviceWriteResult } from './group-device.js'
import { deriveGroup, type GroupHandle, mutexFor } from './group-handle.js'
import { HISTORY_HORIZON, historySize } from './history.js'
import { signLedgerEntry, type VerifiedLedgerEntry } from './ledger.js'
import { isLapsed, leafAt, treeTime, validateEntry } from './lifecycle.js'
import {
  authenticateLifecycleProof,
  isExemptMember,
  verifyLifecycleProof,
} from './lifecycle-proof.js'
import { DEVICE_ENTRY_TYPE, type DeviceValue, isResetOnly, type RevokedEffect } from './registry.js'

export type CommitResult = DeviceWriteResult

/**
 * Author a by-reference Remove for this handle's own leaf at its current epoch.
 * Once a member processes a pending self-removal, application encrypt throws until
 * a commit lands. Callers should commit pending self-removals promptly.
 */
export async function proposeSelfRemoval(
  group: GroupHandle,
): Promise<{ frame: Uint8Array; epoch: bigint }> {
  return group.proposeSelfRemoval()
}

/**
 * Commit other members' pending self-removals without absorbing other pending proposals.
 * Returns null when only the committer's own self-removal (or none) is pending.
 * Once a member processes a pending self-removal, application encrypt throws until
 * a commit lands. Callers should commit pending self-removals promptly.
 */
export async function commitSelfRemovals(group: GroupHandle): Promise<CommitResult | null> {
  return mutexFor(group).run(async () => {
    const pendingProposals = Object.fromEntries(
      Object.entries(group.state.unappliedProposals).filter(
        ([, { proposal, senderLeafIndex }]) =>
          isDefaultProposal(proposal) &&
          proposal.proposalType === defaultProposalTypes.remove &&
          proposal.remove.removed === senderLeafIndex &&
          senderLeafIndex !== group.state.privatePath.leafIndex,
      ),
    )
    if (Object.keys(pendingProposals).length === 0) return null
    const tree = group.state.ratchetTree.slice()
    for (const { proposal } of Object.values(pendingProposals)) {
      if (isDefaultProposal(proposal) && proposal.proposalType === defaultProposalTypes.remove)
        tree[proposal.remove.removed * 2] = undefined
    }
    const tokens = await clockEntries(group, tree)
    const result = await commitWithEntries({
      group,
      extraProposals: [],
      pendingProposals,
      enacted: tokens,
      requireAdmin: false,
    })
    const newGroup = deriveGroup(group, result.newState)
    await newGroup.applyLedgerEntries(tokens)
    return {
      commitMessage: encode(mlsMessageEncoder, result.commit),
      newGroup,
      epoch: newGroup.epoch,
    }
  })
}

export type RevokeBuildResult =
  | { status: 'built'; result: DeviceWriteResult }
  | { status: 'already-revoked' }
  | { status: 'self-affected'; subject: string }
  | { status: 'not-provable'; reason: RevokeProofReason }

function ownIdentity(group: GroupHandle) {
  const leaf = leafAt(group.state.ratchetTree, group.state.privatePath.leafIndex)
  if (leaf == null || !('identity' in leaf.credential))
    throw new LeafBindingError('identity-change')
  const parsed = parseMLSCredentialIdentity(leaf.credential.identity)
  return createSigningIdentityForDID(
    (parsed.longForm ?? parsed.id) as DIDString,
    group.state.signaturePrivateKey,
  )
}

async function clockEntries(
  group: GroupHandle,
  tree: ClientState['ratchetTree'],
): Promise<Array<string>> {
  const controller = group.anchor.controller
  if (controller == null) return []
  const before = treeTime(group, controller)
  let after = group.registry.controllers.get(normalizeDID(controller))?.timeFloor ?? 0
  for (const node of tree) {
    if (node?.nodeType !== nodeTypes.leaf || !('identity' in node.leaf.credential)) continue
    const binding = parseMLSCredentialIdentity(node.leaf.credential.identity).controller
    if (binding == null || normalizeDID(binding.id) !== normalizeDID(controller)) continue
    const payload = readCapability(binding.capability).payload
    const parent = Array.isArray(payload.cap) ? payload.cap[0] : payload.cap
    after = Math.max(after, parent == null ? payload.iat : readCapability(parent).payload.iat)
  }
  if (after >= before) return []
  return [
    await signLedgerEntry(ownIdentity(group), {
      type: DEVICE_ENTRY_TYPE,
      groupID: group.groupID,
      subject: controller,
      value: { op: 'clock', time: before },
    }),
  ]
}

type BuildResultParams = {
  group: GroupHandle
  proposals: Array<DefaultProposal>
  tokens: Array<string>
  /** Replacement state for a renewal, whose own leaf differs from the live tree. */
  commitState?: ClientState
}

async function buildResult(params: BuildResultParams): Promise<DeviceWriteResult> {
  const { group, proposals, tokens, commitState } = params
  const result = await commitWithEntries({
    group,
    extraProposals: proposals,
    enacted: tokens,
    requireAdmin: false,
    commitState,
  })
  // MLS captured the replacement tree as historical data when building a renewal.
  const historical = result.newState.historicalReceiverData.get(group.epoch)
  if (historical != null && commitState != null) historical.ratchetTree = group.state.ratchetTree
  const newGroup = deriveGroup(group, result.newState)
  await newGroup.applyLedgerEntries(tokens)
  return {
    commitMessage: encode(mlsMessageEncoder, result.commit),
    newGroup,
    epoch: newGroup.epoch,
  }
}

export async function renewLeaf(
  group: GroupHandle,
  binding: ControllerBinding,
): Promise<DeviceWriteResult> {
  return mutexFor(group).run(async () => {
    assertBindingAuthorTime(binding)
    const index = group.state.privatePath.leafIndex * 2
    const tree = group.state.ratchetTree.slice()
    const original = tree[index]
    if (original?.nodeType !== nodeTypes.leaf || !('identity' in original.leaf.credential))
      throw new LeafBindingError('identity-change')
    const own = structuredClone(original)
    if (!('identity' in own.leaf.credential)) throw new LeafBindingError('identity-change')
    const parsed = parseMLSCredentialIdentity(own.leaf.credential.identity)
    own.leaf.credential.identity = new TextEncoder().encode(
      JSON.stringify({ v: 1, ...parsed, controller: binding }),
    )
    tree[index] = own
    await validateEntry(group, own.leaf, original.leaf)
    if (group.anchor.controller != null) {
      const entries = group.ledger.map(({ verified }) => verified)
      const before = historySize(group.state.ratchetTree, entries)
      const after = historySize(tree, entries)
      if (after > HISTORY_HORIZON && after > before) throw new LeafBindingError('history-horizon')
    }
    const tokens = await clockEntries(group, tree)
    return buildResult({
      group,
      proposals: [],
      tokens,
      commitState: { ...group.state, ratchetTree: tree },
    })
  })
}

export type RemoveLapsedLeavesResult = {
  removed: Array<string>
  /** Absent when no leaf had lapsed. */
  result?: DeviceWriteResult
}

export async function removeLapsedLeaves(group: GroupHandle): Promise<RemoveLapsedLeavesResult> {
  return mutexFor(group).run(async () => {
    const removed: Array<string> = []
    const proposals: Array<DefaultProposal> = []
    const tree = group.state.ratchetTree.slice()
    for (const member of group.listMembers()) {
      const leaf = leafAt(tree, member.leafIndex)
      if (leaf == null || !isLapsed(group, leaf)) continue
      removed.push(member.id)
      tree[member.leafIndex * 2] = undefined
      proposals.push({
        proposalType: defaultProposalTypes.remove,
        remove: { removed: member.leafIndex },
      })
    }
    if (removed.length === 0) return { removed }
    const tokens = await clockEntries(group, tree)
    return { removed, result: await buildResult({ group, proposals, tokens }) }
  })
}

type ProofForParams = {
  group: GroupHandle
  log: Array<SignedEvent>
  subject: string
  reset: boolean
}

/** The slice of `log` a receiver needs on top of the controller events it already recorded. */
function proofFor(params: ProofForParams): Array<SignedEvent> {
  const { group, log, subject, reset } = params
  const controller = group.anchor.controller
  if (controller == null) throw new RevokeProofError('wrong-controller')
  if (log.length === 0) throw new RevokeProofError('no-rev')
  const first = log[0]
  if (first?.event.t === 'icp') {
    let did: string
    try {
      did = didFromInception(first.event as InceptionEvent)
    } catch (cause) {
      const rejection = new RevokeProofError('not-authority-signed')
      rejection.cause = cause
      throw rejection
    }
    if (normalizeDID(did) !== normalizeDID(controller))
      throw new RevokeProofError('wrong-controller')
  }
  if (log.some(({ event }) => event.t !== 'icp' && event.i !== controller))
    throw new RevokeProofError('wrong-controller')
  const folded = foldLog(controller, log)
  if (!folded.ok) {
    const detached = /sequence|digest|prior|inception must/.test(folded.reason)
    throw new RevokeProofError(detached ? 'detached' : 'not-authority-signed')
  }
  // Drop events that leave the folded state unchanged.
  const advancing = log.filter(
    (_, index) => index === 0 || folded.states[index]?.digest !== folded.states[index - 1]?.digest,
  )
  const canonical = foldLog(controller, advancing)
  if (!canonical.ok) throw new RevokeProofError('not-authority-signed')
  let resetIndex = -1
  for (let index = 1; index < advancing.length; index++) {
    if (advancing[index]?.event.g !== advancing[index - 1]?.event.g) resetIndex = index
  }
  const projection = group.registry.controllers.get(normalizeDID(controller))
  const recorded = projection?.recordedLog ?? []
  const floor = projection?.genFloor ?? 0
  if (reset) {
    if (resetIndex < 0) throw new RevokeProofError('no-rev')
    return [advancing[0] as SignedEvent, ...advancing.slice(resetIndex)]
  }
  const recordedFold = foldLog(controller, recorded)
  const recordedHead = recordedFold.ok ? recordedFold.states.at(-1) : undefined
  const generation = canonical.states.at(-1)?.gen ?? 0
  if (recorded.length > 0 && generation > (recordedHead?.gen ?? floor))
    throw new RevokeProofError('needs-reset')
  const start = recorded.length === 0 ? Math.max(1, resetIndex) : 1
  let end = advancing.findIndex(
    ({ event }, index) =>
      index >= start &&
      event.t === 'rev' &&
      'x' in event &&
      typeof event.x === 'string' &&
      normalizeDID(event.x) === subject &&
      (canonical.states[index]?.gen ?? 0) >= floor,
  )
  if (end < 0) {
    if (generation < floor) throw new RevokeProofError('generation-floor')
    throw new RevokeProofError('no-rev')
  }
  if (recorded.length === 0) {
    return [advancing[0] as SignedEvent, ...advancing.slice(start, end + 1)]
  }
  const headIndex = canonical.states.findIndex(({ digest }) => digest === recordedHead?.digest)
  if (headIndex < 0) throw new RevokeProofError('detached')
  end = Math.max(headIndex, end)
  return advancing.slice(headIndex + 1, end + 1)
}

/**
 * Revoked in the registry, with no leaf of its own and no leaf it issued left in the tree, apart
 * from evidenced children, which its revocation never removes.
 */
function isFullyRevoked(group: GroupHandle, subject: string): boolean {
  const record = group.registry.devices.get(subject)
  if (record?.status !== 'revoked' || isResetOnly(record)) return false
  if (group.findMemberLeafIndex(subject) != null) return false
  return !group.listMembers().some((member) => {
    const capability = group.bindingOfDID(member.id)?.capability
    return (
      capability != null &&
      normalizeDID(readCapability(capability).payload.iss) === subject &&
      !isExemptMember(group, member.leafIndex)
    )
  })
}

export type RevokeWithProofParams =
  | { subject: string; log: Array<SignedEvent> }
  | { reset: true; log: Array<SignedEvent> }

export async function revokeWithProof(
  group: GroupHandle,
  params: RevokeWithProofParams,
): Promise<RevokeBuildResult> {
  return mutexFor(group).run(async () => {
    try {
      const controller = group.anchor.controller
      if (controller == null) throw new RevokeProofError('wrong-controller')
      const reset = 'reset' in params
      const subject = normalizeDID(reset ? controller : params.subject)
      if (!reset && isFullyRevoked(group, subject)) return { status: 'already-revoked' }
      const value: DeviceValue = {
        op: reset ? 'reset' : 'revoke',
        proof: proofFor({ group, log: params.log, subject, reset }),
        revoked: [],
      }
      const verified: VerifiedLedgerEntry<DeviceValue> = {
        issuer: group.credential.id,
        entry: { type: DEVICE_ENTRY_TYPE, groupID: group.groupID, subject, value },
      }
      const authenticated = authenticateLifecycleProof(controller, verified, group.registry)
      const revoked: Array<RevokedEffect> = reset ? [] : [{ did: subject }]
      const leaves = group.listMembers().map((member) => {
        const binding = group.bindingOfDID(member.id)
        const payload =
          binding?.capability == null ? undefined : readCapability(binding.capability).payload
        const folded = binding?.prefix == null ? undefined : foldLog(controller, binding.prefix)
        return {
          ...member,
          issuer: payload?.cap == null ? undefined : normalizeDID(payload.iss),
          generation: folded?.ok ? folded.states.at(-1)?.gen : undefined,
          exempt: isExemptMember(group, member.leafIndex),
        }
      })
      if (reset)
        for (const leaf of leaves) {
          if (leaf.generation != null && leaf.generation < authenticated.genFloor)
            revoked.push({ did: normalizeDID(leaf.id) })
        }
      const direct = new Set(revoked.map(({ did }) => did))
      for (const leaf of leaves) {
        if (
          leaf.issuer != null &&
          direct.has(leaf.issuer) &&
          !direct.has(normalizeDID(leaf.id)) &&
          !leaf.exempt
        )
          revoked.push({ did: normalizeDID(leaf.id), cascadedFrom: leaf.issuer })
      }
      value.revoked = revoked
      if (revoked.some(({ did }) => did === normalizeDID(group.credential.id)))
        return { status: 'self-affected', subject: group.credential.id }
      const effects = await verifyLifecycleProof(group, verified)
      const tree = group.state.ratchetTree.slice()
      const proposals: Array<DefaultProposal> = effects.removeLeafIndices.map((removed) => {
        tree[removed * 2] = undefined
        return { proposalType: defaultProposalTypes.remove, remove: { removed } }
      })
      const tokens = [
        await signLedgerEntry(ownIdentity(group), verified.entry),
        ...(await clockEntries(group, tree)),
      ]
      return { status: 'built', result: await buildResult({ group, proposals, tokens }) }
    } catch (error) {
      if (error instanceof RevokeProofError) return { status: 'not-provable', reason: error.reason }
      if (error instanceof LeafBindingError && error.reason === 'history-horizon')
        return { status: 'not-provable', reason: 'too-large' }
      throw error
    }
  })
}
