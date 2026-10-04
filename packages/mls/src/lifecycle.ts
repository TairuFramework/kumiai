import { foldLog } from '@kokuin/controller'
import { normalizeDID } from '@kokuin/token'
import {
  type ClientState,
  defaultCredentialTypes,
  defaultProposalTypes,
  type GroupContextExtension,
  type IncomingMessageCallback,
  isDefaultCredential,
  isDefaultProposal,
  type LeafNode,
  nodeTypes,
  type ProposalWithSender,
} from 'ts-mls'

import { LEDGER_HEAD_EXTENSION_TYPE } from './anchor.js'
import { verifyLeafCredential } from './authentication.js'
import {
  assertCapabilityLifetime,
  MAX_LEAF_LIFETIME,
  MAX_TRUSTED_GRANT_LIFETIME,
  readCapability,
} from './capability.js'
import { parseMLSCredentialIdentity } from './credential.js'
import { LeafBindingError, LeafLapsedError, RevokeProofError } from './errors.js'
import type { GroupHandle } from './group-handle.js'
import { decodeLedgerHead, extendHead, genesisHead, headsMatch } from './head.js'
import { HISTORY_HORIZON, historySize } from './history.js'
import type { VerifiedLedgerEntry } from './ledger.js'
import { verifyLifecycleProof } from './lifecycle-proof.js'
import { type CommitPolicyContext, evaluateGroupContextExtensions } from './policy.js'
import { DEVICE_ENTRY_TYPE, type DeviceRegistry, type DeviceValue, denySetOf } from './registry.js'

export type CommitRejectionReason = 'binding' | 'lapse' | 'floor' | 'policy' | 'invalid'

export function rejectionReason(error: unknown): CommitRejectionReason {
  if (error instanceof LeafLapsedError) return 'lapse'
  if (error instanceof LeafBindingError)
    return error.reason === 'generation-floor' ? 'floor' : 'binding'
  if (error instanceof RevokeProofError && error.reason === 'generation-floor') return 'floor'
  return 'invalid'
}

function identity(leaf: LeafNode) {
  if (
    !isDefaultCredential(leaf.credential) ||
    leaf.credential.credentialType !== defaultCredentialTypes.basic
  ) {
    throw new LeafBindingError('identity-change')
  }
  return parseMLSCredentialIdentity(leaf.credential.identity)
}

export function leafAt(tree: ClientState['ratchetTree'], index: number): LeafNode | undefined {
  const node = tree[index * 2]
  return node?.nodeType === nodeTypes.leaf ? node.leaf : undefined
}

function attestedTime(leaf: LeafNode, controllerID: string): number {
  const binding = identity(leaf).controller
  if (binding == null || normalizeDID(binding.id) !== normalizeDID(controllerID)) return 0
  const payload = readCapability(binding.capability).payload
  const parent = Array.isArray(payload.cap) ? payload.cap[0] : payload.cap
  return parent == null ? payload.iat : readCapability(parent).payload.iat
}

function timeOf(tree: ClientState['ratchetTree'], controllerID: string, floor: number): number {
  let time = floor
  for (const node of tree) {
    if (node?.nodeType === nodeTypes.leaf)
      time = Math.max(time, attestedTime(node.leaf, controllerID))
  }
  return time
}

export function treeTime(group: GroupHandle, controllerID: string): number {
  const floor =
    group.anchor.controller == null
      ? 0
      : (group.registry.controllers.get(normalizeDID(controllerID))?.timeFloor ?? 0)
  return timeOf(group.state.ratchetTree, controllerID, floor)
}

export function isLapsed(group: GroupHandle, leaf: LeafNode): boolean {
  const controller = group.anchor.controller
  if (controller == null) return false
  const binding = identity(leaf).controller
  return (
    binding != null && readCapability(binding.capability).payload.exp < treeTime(group, controller)
  )
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}

function credentialEqual(a: LeafNode, b: LeafNode): boolean {
  return (
    isDefaultCredential(a.credential) &&
    isDefaultCredential(b.credential) &&
    a.credential.credentialType === defaultCredentialTypes.basic &&
    b.credential.credentialType === defaultCredentialTypes.basic &&
    bytesEqual(a.credential.identity, b.credential.identity)
  )
}

function checkBinding(group: GroupHandle, leaf: LeafNode, previous?: LeafNode): void {
  const parsed = identity(leaf)
  const binding = parsed.controller
  const controller = group.anchor.controller
  if (controller != null && binding == null) throw new LeafBindingError('floating-refused')
  if (
    controller != null &&
    binding != null &&
    normalizeDID(binding.id) !== normalizeDID(controller)
  )
    throw new LeafBindingError('controller-mismatch')
  const denied = denySetOf(group.registry)
  if (denied.has(normalizeDID(parsed.id))) throw new LeafBindingError('denied-issuer')
  const record = group.registry.devices.get(normalizeDID(parsed.id))
  if (record != null && (binding == null || normalizeDID(binding.id) !== record.controller))
    throw new LeafBindingError('controller-mismatch')
  if (previous != null) {
    const old = identity(previous)
    if (
      parsed.id !== old.id ||
      parsed.longForm !== old.longForm ||
      !bytesEqual(leaf.signaturePublicKey, previous.signaturePublicKey) ||
      (old.controller != null && (binding == null || binding.id !== old.controller.id))
    )
      throw new LeafBindingError('identity-change')
    if (
      binding != null &&
      old.controller != null &&
      readCapability(binding.capability).payload.iat <
        readCapability(old.controller.capability).payload.iat
    )
      throw new LeafBindingError('identity-change')
  }
  if (binding == null) return
  const payload = readCapability(binding.capability).payload
  assertCapabilityLifetime(
    payload,
    controller == null ? MAX_LEAF_LIFETIME : (group.anchor.leafLifetime ?? 86_400),
  )
  const parent = Array.isArray(payload.cap) ? payload.cap[0] : payload.cap
  if (parent != null)
    assertCapabilityLifetime(
      readCapability(parent).payload,
      controller == null
        ? MAX_TRUSTED_GRANT_LIFETIME
        : (group.anchor.trustedGrantLifetime ?? 2_592_000),
    )
  if (payload.cap != null && denied.has(normalizeDID(payload.iss)))
    throw new LeafBindingError('denied-issuer')
  const folded = foldLog(binding.id, binding.prefix)
  if (!folded.ok) throw new LeafBindingError('controller-mismatch')
  if (
    controller != null &&
    (folded.states.at(-1)?.gen ?? 0) <
      (group.registry.controllers.get(normalizeDID(controller))?.genFloor ?? 0)
  )
    throw new LeafBindingError('generation-floor')
}

function checkAdmissionExpiry(group: GroupHandle, leaf: LeafNode): void {
  const binding = identity(leaf).controller
  if (
    binding != null &&
    readCapability(binding.capability).payload.exp <= treeTime(group, binding.id)
  )
    throw new LeafLapsedError('lapsed')
}

function checkEntry(group: GroupHandle, leaf: LeafNode, previous?: LeafNode): void {
  checkBinding(group, leaf, previous)
  checkAdmissionExpiry(group, leaf)
}

async function validateBoundLeaf(
  group: GroupHandle,
  leaf: LeafNode,
  previous?: LeafNode,
): Promise<void> {
  checkBinding(group, leaf, previous)
  await verifyLeafCredential(leaf.credential, leaf.signaturePublicKey, {
    deviceDenySet: () => denySetOf(group.registry),
    leafLifetime: () =>
      group.anchor.controller == null ? undefined : (group.anchor.leafLifetime ?? 86_400),
    trustedGrantLifetime: () =>
      group.anchor.controller == null
        ? undefined
        : (group.anchor.trustedGrantLifetime ?? 2_592_000),
  })
}

export async function validateEntry(
  group: GroupHandle,
  leaf: LeafNode,
  previous?: LeafNode,
): Promise<void> {
  await validateBoundLeaf(group, leaf, previous)
  checkAdmissionExpiry(group, leaf)
}

function checkSurvivors(
  group: GroupHandle,
  tree: ClientState['ratchetTree'],
  registry: DeviceRegistry,
): void {
  const denied = denySetOf(registry)
  const controller = group.anchor.controller
  for (const node of tree) {
    if (node?.nodeType !== nodeTypes.leaf) continue
    const parsed = identity(node.leaf)
    if (denied.has(normalizeDID(parsed.id))) throw new LeafBindingError('denied-issuer')
    if (parsed.controller == null) {
      if (controller != null) throw new LeafBindingError('floating-refused')
      continue
    }
    const binding = parsed.controller
    const payload = readCapability(binding.capability).payload
    if (payload.cap != null && denied.has(normalizeDID(payload.iss)))
      throw new LeafBindingError('denied-issuer')
    if (controller != null) {
      const folded = foldLog(binding.id, binding.prefix)
      if (normalizeDID(binding.id) !== normalizeDID(controller) || !folded.ok)
        throw new LeafBindingError('controller-mismatch')
      if (
        (folded.states.at(-1)?.gen ?? 0) <
        (registry.controllers.get(normalizeDID(controller))?.genFloor ?? 0)
      )
        throw new LeafBindingError('generation-floor')
    }
  }
}

export async function validateWelcomeTree(group: GroupHandle): Promise<void> {
  for (const [index, node] of group.state.ratchetTree.entries()) {
    if (node?.nodeType !== nodeTypes.leaf) continue
    await validateBoundLeaf(group, node.leaf)
    if (index === group.state.privatePath.leafIndex * 2) checkAdmissionExpiry(group, node.leaf)
  }
  checkSurvivors(group, group.state.ratchetTree, group.registry)
}

/** The callback judges proposals; survivors check the path before any state is installed. */
export async function prepareLifecycleGate(
  group: GroupHandle,
  entries: Array<VerifiedLedgerEntry>,
  candidateRegistry: DeviceRegistry,
  context: CommitPolicyContext,
  externalLeaf?: LeafNode,
) {
  const controller = group.anchor.controller
  if (controller == null) {
    for (const { entry, issuer } of entries) {
      if (entry.type !== DEVICE_ENTRY_TYPE) continue
      const capability = (entry.value as DeviceValue).capability
      const binding = group.bindingOfDID(issuer)
      if (
        capability != null &&
        binding?.controller != null &&
        readCapability(capability).payload.exp < treeTime(group, binding.controller)
      )
        throw new LeafLapsedError('lapsed')
    }
  }
  const before = group.state.ratchetTree
  const ledger = group.ledger.map(({ verified }) => verified)
  const afterLedger = [...ledger, ...entries]
  const beforeSize = controller == null ? 0 : historySize(before, ledger)
  const beforeTime = controller == null ? 0 : treeTime(group, controller)
  const lapsed = new Set<number>()
  if (controller != null) {
    for (let index = 0; index * 2 < before.length; index++) {
      const leaf = leafAt(before, index)
      const binding = leaf == null ? undefined : identity(leaf).controller
      if (binding != null && readCapability(binding.capability).payload.exp < beforeTime)
        lapsed.add(index)
    }
  }
  const lifecycleEntries = entries.filter(
    ({ entry }) =>
      entry.type === DEVICE_ENTRY_TYPE &&
      ['revoke', 'reset', 'clock'].includes((entry.value as DeviceValue).op),
  )
  const proofs = lifecycleEntries.filter(({ entry }) => (entry.value as DeviceValue).op !== 'clock')
  const clocks = lifecycleEntries.filter(({ entry }) => (entry.value as DeviceValue).op === 'clock')
  if (
    controller != null &&
    (proofs.length > 1 ||
      clocks.length > 1 ||
      (proofs.length > 0 && entries.length !== proofs.length + clocks.length))
  )
    throw new RevokeProofError('effects-mismatch')
  const expectedRemoves = new Set<number>()
  if (controller != null) {
    for (const entry of lifecycleEntries) {
      const effects = await verifyLifecycleProof(group, entry as VerifiedLedgerEntry<DeviceValue>)
      if ((entry.entry.value as DeviceValue).op !== 'clock')
        for (const index of effects.removeLeafIndices) expectedRemoves.add(index)
    }
  }
  if (externalLeaf != null) await validateEntry(group, externalLeaf)
  let incomingCommit:
    | Extract<Parameters<IncomingMessageCallback>[0], { kind: 'commit' }>
    | undefined

  function checkSize(tree: ClientState['ratchetTree']): void {
    if (controller == null) return
    const size = historySize(tree, afterLedger)
    if (size > HISTORY_HORIZON && size > beforeSize) throw new LeafBindingError('history-horizon')
  }
  function checkTime(tree: ClientState['ratchetTree']): void {
    if (controller == null) return
    const floor = candidateRegistry.controllers.get(normalizeDID(controller))?.timeFloor ?? 0
    if (timeOf(tree, controller, floor) < beforeTime) throw new RevokeProofError('effects-mismatch')
  }
  function checkRegistryAdds(proposals: Array<ProposalWithSender>): void {
    for (const { entry } of entries) {
      if (entry.type !== DEVICE_ENTRY_TYPE) continue
      const value = entry.value as DeviceValue
      if (value.op !== 'register' && value.op !== 'add') continue
      const subject = normalizeDID(entry.subject)
      const held = group.registry.devices.get(subject)
      if (held != null && held.controller !== normalizeDID(value.controller as string))
        throw new LeafBindingError('controller-mismatch')
      const current = group.bindingOfDID(subject)
      if (current != null && current.controller !== normalizeDID(value.controller as string))
        throw new LeafBindingError('controller-mismatch')
      for (const { proposal } of proposals) {
        if (!isDefaultProposal(proposal) || proposal.proposalType !== defaultProposalTypes.add)
          continue
        const parsed = identity(proposal.add.keyPackage.leafNode)
        if (
          normalizeDID(parsed.id) === subject &&
          (parsed.controller == null ||
            normalizeDID(parsed.controller.id) !== normalizeDID(value.controller as string))
        )
          throw new LeafBindingError('controller-mismatch')
      }
    }
  }
  const check = (incoming: Parameters<IncomingMessageCallback>[0]): void => {
    const proposals = incoming.kind === 'commit' ? incoming.proposals : [incoming.proposal]
    if (incoming.kind === 'commit') incomingCommit = incoming
    checkRegistryAdds(proposals)
    const external = proposals.some(
      ({ proposal }) => proposal.proposalType === defaultProposalTypes.external_init,
    )
    const removes = proposals.filter(
      ({ proposal }) =>
        isDefaultProposal(proposal) && proposal.proposalType === defaultProposalTypes.remove,
    )
    if (external) {
      if (
        incoming.kind !== 'commit' ||
        externalLeaf == null ||
        proposals.length !== 2 ||
        removes.length !== 1
      )
        throw new Error('Invalid external replacement')
      const remove = removes[0]?.proposal
      if (
        remove == null ||
        !isDefaultProposal(remove) ||
        remove.proposalType !== defaultProposalTypes.remove
      )
        throw new Error('Missing replacement target')
      const old = leafAt(before, remove.remove.removed)
      if (old == null) throw new LeafBindingError('identity-change')
      checkEntry(group, externalLeaf, old)
      const tree = before.slice()
      tree[remove.remove.removed * 2] = { nodeType: nodeTypes.leaf, leaf: externalLeaf }
      checkTime(tree)
      checkSize(tree)
      return
    }
    if (controller != null && proofs.length > 0) {
      const actual = removes.map(({ proposal }) =>
        isDefaultProposal(proposal) && proposal.proposalType === defaultProposalTypes.remove
          ? proposal.remove.removed
          : -1,
      )
      if (
        actual.length !== expectedRemoves.size ||
        new Set(actual).size !== expectedRemoves.size ||
        actual.some((index) => !expectedRemoves.has(index))
      )
        throw new RevokeProofError('removes-mismatch')
      if (
        incoming.kind !== 'commit' ||
        incoming.senderLeafIndex == null ||
        expectedRemoves.has(incoming.senderLeafIndex)
      )
        throw new RevokeProofError('effects-mismatch')
    }
    const tree = before.slice()
    for (const { proposal, senderLeafIndex: proposalSender } of proposals) {
      if (!isDefaultProposal(proposal)) {
        if (controller != null) throw new Error('Unsupported lifecycle proposal')
        continue
      }
      const sender =
        proposalSender ?? (incoming.kind === 'commit' ? incoming.senderLeafIndex : undefined)
      if (
        controller != null &&
        proofs.length > 0 &&
        proposal.proposalType !== defaultProposalTypes.remove &&
        proposal.proposalType !== defaultProposalTypes.group_context_extensions
      )
        throw new RevokeProofError('effects-mismatch')
      switch (proposal.proposalType) {
        case defaultProposalTypes.add: {
          checkEntry(group, proposal.add.keyPackage.leafNode)
          const parsed = identity(proposal.add.keyPackage.leafNode)
          const record = candidateRegistry.devices.get(normalizeDID(parsed.id))
          if (
            record != null &&
            (parsed.controller == null || normalizeDID(parsed.controller.id) !== record.controller)
          )
            throw new LeafBindingError('controller-mismatch')
          tree.push({ nodeType: nodeTypes.leaf, leaf: proposal.add.keyPackage.leafNode })
          break
        }
        case defaultProposalTypes.update: {
          const old = sender == null ? undefined : leafAt(before, sender)
          if (old == null || sender == null) throw new LeafBindingError('identity-change')
          checkEntry(group, proposal.update.leafNode, old)
          tree[sender * 2] = { nodeType: nodeTypes.leaf, leaf: proposal.update.leafNode }
          break
        }
        case defaultProposalTypes.remove: {
          const target = proposal.remove.removed
          const old = leafAt(before, target)
          if (
            controller != null &&
            (old == null ||
              (proofs.length === 0 &&
                !lapsed.has(target) &&
                !(
                  proposalSender === target &&
                  (incoming.kind === 'proposal' || incoming.senderLeafIndex !== target)
                )))
          )
            throw new Error('Unauthorised Remove')
          tree[target * 2] = undefined
          break
        }
        case defaultProposalTypes.group_context_extensions:
          if (
            evaluateGroupContextExtensions(proposal.groupContextExtensions.extensions, context) ===
            'reject'
          )
            throw new Error('Invalid extensions')
          break
        default:
          if (controller != null) throw new Error('Unsupported lifecycle proposal')
      }
    }
    if (
      incoming.kind === 'commit' &&
      context.commitEnactsEntries &&
      !proposals.some(
        ({ proposal }) => proposal.proposalType === defaultProposalTypes.group_context_extensions,
      )
    )
      throw new Error('Missing head move')
    if (controller != null && incoming.kind === 'commit' && incoming.senderLeafIndex != null) {
      const sender = leafAt(before, incoming.senderLeafIndex)
      if (
        sender != null &&
        lapsed.has(incoming.senderLeafIndex) &&
        (proposals.some(
          ({ proposal }) => proposal.proposalType !== defaultProposalTypes.group_context_extensions,
        ) ||
          entries.some(
            ({ entry }) =>
              entry.type !== DEVICE_ENTRY_TYPE || (entry.value as DeviceValue).op !== 'clock',
          ))
      )
        throw new LeafLapsedError('lapsed')
    }
    if (incoming.kind === 'commit') checkTime(tree)
    checkSize(tree)
    checkSurvivors(group, tree, candidateRegistry)
  }
  const postApply = async (state: ClientState): Promise<void> => {
    if (incomingCommit == null || state.groupActiveState.kind === 'removedFromGroup') return
    const external = incomingCommit.senderLeafIndex == null
    const senderIndex = incomingCommit.senderLeafIndex
    const hasRemoves = incomingCommit.proposals.some(
      ({ proposal }) => proposal.proposalType === defaultProposalTypes.remove,
    )
    if (!external && senderIndex != null) {
      const next = leafAt(state.ratchetTree, senderIndex)
      const old = leafAt(before, senderIndex)
      if (
        next != null &&
        old != null &&
        (!credentialEqual(next, old) ||
          !bytesEqual(next.signaturePublicKey, old.signaturePublicKey))
      ) {
        if (controller != null && (hasRemoves || proofs.length > 0))
          throw new LeafBindingError('identity-change')
        await validateEntry(group, next, old)
      }
    }
    if (controller != null && senderIndex != null) {
      const old = leafAt(before, senderIndex)
      const next = leafAt(state.ratchetTree, senderIndex)
      if (
        old != null &&
        lapsed.has(senderIndex) &&
        (next == null ||
          credentialEqual(old, next) ||
          readCapability(identity(next).controller?.capability ?? '').payload.exp < beforeTime)
      )
        throw new LeafLapsedError('lapsed')
    }
    checkTime(state.ratchetTree)
    checkSize(state.ratchetTree)
    checkSurvivors(group, state.ratchetTree, candidateRegistry)
  }
  return { check, postApply }
}

/** Historical messages use the tree and clock floor authenticated in their own epoch. */
export function assertSenderNotLapsed(
  group: GroupHandle,
  tree: ClientState['ratchetTree'],
  leafIndex: number | null | undefined,
  extensions: Array<GroupContextExtension>,
): void {
  const controller = group.anchor.controller
  if (controller == null || leafIndex == null) return
  const leaf = leafAt(tree, leafIndex)
  if (leaf == null) return
  const data = extensions.find(
    (extension) => extension.extensionType === LEDGER_HEAD_EXTENSION_TYPE,
  )?.extensionData
  const expected = data instanceof Uint8Array ? decodeLedgerHead(data) : null
  if (expected == null) throw new Error('Missing epoch ledger head')
  let head = genesisHead(group.groupID)
  let floor = 0
  for (const held of group.ledger) {
    if (headsMatch(head, expected.head)) break
    head = extendHead(head, [held.entryID])
    const { entry } = held.verified
    if (entry.type === DEVICE_ENTRY_TYPE && (entry.value as DeviceValue).op === 'clock')
      floor = Math.max(floor, (entry.value as DeviceValue).time ?? 0)
  }
  if (!headsMatch(head, expected.head)) throw new Error('Unknown epoch ledger head')
  const binding = identity(leaf).controller
  if (
    binding != null &&
    readCapability(binding.capability).payload.exp < timeOf(tree, controller, floor)
  )
    throw new LeafLapsedError('lapsed')
}
