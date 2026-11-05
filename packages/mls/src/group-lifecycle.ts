import {
  type ControllerLog,
  didFromInception,
  digestOf,
  type InceptionEvent,
  pruneLog,
} from '@kokuin/controller'
import {
  type CryptoOptions,
  createSigningIdentityForDID,
  type DIDString,
  normalizeDID,
} from '@kokuin/token'
import {
  type ClientState,
  type DefaultProposal,
  defaultProposalTypes,
  encode,
  isDefaultProposal,
  mlsMessageEncoder,
  nodeTypes,
} from 'ts-mls'

import { effectDelta, ingestControllerLog } from './controller-ingest.js'
import { closureOf, foldControllerLog, isDetachedFoldReason } from './controller-log.js'
import { type ControllerBinding, parseMLSCredentialIdentity } from './credential.js'
import { foldEnvelope } from './envelope-fold.js'
import { LeafBindingError, RevokeProofError, type RevokeProofReason } from './errors.js'
import { commitWithEntries } from './group-commit.js'
import { assertBindingAuthorTime } from './group-credential.js'
import type { DeviceWriteResult } from './group-device.js'
import { deriveGroup, type GroupHandle, mutexFor } from './group-handle.js'
import { HISTORY_HORIZON, historySize } from './history.js'
import {
  ledgerEntryDigest,
  signLedgerEntry,
  type VerifiedLedgerEntry,
  verifyLedgerEntry,
} from './ledger.js'
import { attestedTreeTime, isLapsed, leafAt, treeTime, validateEntry } from './lifecycle.js'
import {
  authenticateLifecycleProof,
  lifecycleProofEffects,
  lifecycleProofLog,
  mergeLifecycleProofLogs,
  verifyLifecycleProof,
} from './lifecycle-proof.js'
import {
  claimsFor,
  type EffectClaim,
  effectiveAttestingMembers,
  effectiveAuthorityOf,
} from './member-root.js'
import {
  DEVICE_ENTRY_TYPE,
  type DeviceRegistry,
  type DeviceValue,
  isResetOnly,
  recordedLogOf,
} from './registry.js'

export type CommitResult = DeviceWriteResult

export async function controllerLogDelta(
  group: GroupHandle,
  log: ControllerLog,
): Promise<ControllerLog | null> {
  const controller = group.anchor.controller
  if (controller == null) throw new RevokeProofError('wrong-controller')
  const options = { crypto: group.crypto }
  const recorded = recordedLogOf(group.registry, controller)
  if (recorded == null) throw new RevokeProofError('detached')
  const first = log.chain[0]?.event
  if (first == null) throw new RevokeProofError('no-rev')
  if (
    (first.t === 'icp' &&
      normalizeDID(didFromInception(first as InceptionEvent)) !== normalizeDID(controller)) ||
    log.chain.some(
      ({ event }) =>
        event.t !== 'icp' &&
        (event.i == null || normalizeDID(event.i) !== normalizeDID(controller)),
    )
  )
    throw new RevokeProofError('wrong-controller')
  const folded = await foldControllerLog(controller, log, options)
  if (!folded.ok)
    throw new RevokeProofError(
      isDetachedFoldReason(folded.reason) ? 'detached' : 'not-authority-signed',
    )
  const pruned = await pruneLog({ ...options, did: controller, input: log })
  const incoming = await ingestControllerLog(controller, undefined, pruned, undefined, options)
  const previous = await ingestControllerLog(controller, undefined, recorded, undefined, options)
  const reset = incoming.after.head.gen > previous.after.head.gen
  const merged = incoming.log
  const common = reset ? 1 : Math.min(recorded.chain.length, merged.chain.length)
  for (let index = 0; index < common; index++) {
    const prior = recorded.chain[index]
    const next = merged.chain[index]
    if (prior == null || next == null || digestOf(prior.event) !== digestOf(next.event))
      throw new RevokeProofError('detached')
  }
  const seen = new Set(recorded.events.map(({ event }) => digestOf(event)))
  const delta = {
    chain: reset ? merged.chain : merged.chain.slice(recorded.chain.length),
    events: merged.events.filter(({ event }) => !seen.has(digestOf(event))),
  }
  if (delta.chain.length === 0 && delta.events.length === 0) return null
  await ingestControllerLog(controller, recorded, delta, undefined, options)
  return delta
}

export async function publishControllerLog(
  group: GroupHandle,
  log: ControllerLog,
): Promise<DeviceWriteResult | null> {
  return mutexFor(group).run(async () => {
    const delta = await controllerLogDelta(group, log)
    if (delta == null) return null
    const controller = group.anchor.controller
    if (controller == null) throw new RevokeProofError('wrong-controller')
    const ingested = await ingestControllerLog(
      controller,
      recordedLogOf(group.registry, controller),
      delta,
      group.registry.controllers.get(normalizeDID(controller)),
      { crypto: group.crypto },
    )
    const effects = effectDelta(ingested.before?.head, ingested.after.head)
    if (effects.generation || effects.denied.length > 0 || effects.removed.length > 0)
      throw new RevokeProofError('effects-mismatch')
    const token = await signLedgerEntry(ownIdentity(group), {
      type: DEVICE_ENTRY_TYPE,
      groupID: group.groupID,
      subject: controller,
      value: { op: 'log', proof: delta },
    })
    return buildResult({ group, proposals: [], tokens: [token] })
  })
}

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
    const tokens: Array<string> = []
    const result = await commitWithEntries({
      group,
      extraProposals: [],
      pendingProposals,
      enacted: tokens,
      requireAdmin: false,
    })
    const newGroup = await deriveGroup(group, result.newState)
    await newGroup.applyLedgerEntries(result.enacted)
    return {
      commitMessage: encode(mlsMessageEncoder, result.commit),
      newGroup,
      epoch: newGroup.epoch,
    }
  })
}

export type RevokeBuildResult =
  | { status: 'built'; effects: Array<EffectClaim>; result: DeviceWriteResult }
  | { status: 'already-revoked' }
  | { status: 'self-affected'; subject: string }
  | { status: 'not-provable'; reason: RevokeProofReason }

function ownIdentity(group: GroupHandle) {
  const leaf = leafAt(group.state.ratchetTree, group.state.privatePath.leafIndex)
  if (leaf == null || !('identity' in leaf.credential))
    throw new LeafBindingError('identity-change')
  const parsed = parseMLSCredentialIdentity(leaf.credential.identity)
  return createSigningIdentityForDID({
    id: (parsed.longForm ?? parsed.id) as DIDString,
    privateKey: group.state.signaturePrivateKey,
    crypto: group.crypto,
  })
}

export async function preservationClock(
  group: GroupHandle,
  candidateTree: ClientState['ratchetTree'],
  candidateRegistry: DeviceRegistry,
): Promise<Array<string>> {
  const controller = group.anchor.controller
  if (controller == null) return []
  const before = await treeTime(group, controller)
  if (
    (await attestedTreeTime(candidateTree, candidateRegistry, controller, {
      crypto: group.crypto,
    })) >= before
  )
    return []
  return [
    await signLedgerEntry(ownIdentity(group), {
      type: DEVICE_ENTRY_TYPE,
      groupID: group.groupID,
      subject: controller,
      value: { op: 'clock', time: before },
    }),
  ]
}

export async function attestTreeTime(
  group: GroupHandle,
  time: number = Date.now() / 1000,
): Promise<DeviceWriteResult | null> {
  return mutexFor(group).run(async () => {
    const controller = group.anchor.controller
    if (controller == null) return null
    const projection = group.registry.controllers.get(normalizeDID(controller))
    if (projection?.recordedLog == null) return null
    const folded = await foldControllerLog(controller, projection.recordedLog, {
      crypto: group.crypto,
    })
    if (!folded.ok || folded.head.saturated) return null
    const members = effectiveAttestingMembers(folded.head, projection, time).filter(
      ([, member]) => normalizeDID(member.did) === normalizeDID(group.credential.id),
    )
    if (members.length === 0) return null
    if (members.every(([, member]) => time <= (projection.attestations.get(member.key) ?? 0)))
      return null
    const token = await signLedgerEntry(ownIdentity(group), {
      type: DEVICE_ENTRY_TYPE,
      groupID: group.groupID,
      subject: controller,
      value: { op: 'clock', time, attest: true },
    })
    return buildResult({ group, proposals: [], tokens: [token] })
  })
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
  const newGroup = await deriveGroup(group, result.newState)
  await newGroup.applyLedgerEntries(result.enacted)
  return {
    commitMessage: encode(mlsMessageEncoder, result.commit),
    newGroup,
    epoch: newGroup.epoch,
  }
}

export async function renewLeaf(
  group: GroupHandle,
  binding: ControllerBinding,
  options?: { controllerLog?: ControllerLog },
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
    const tokens: Array<string> = []
    let candidate = group.registry
    if (options?.controllerLog != null) {
      const delta = await controllerLogDelta(group, options.controllerLog)
      if (delta != null) {
        const token = await signLedgerEntry(ownIdentity(group), {
          type: DEVICE_ENTRY_TYPE,
          groupID: group.groupID,
          subject: binding.id,
          value: { op: 'log', proof: delta },
        })
        const verified = await verifyLedgerEntry(token, { crypto: group.crypto })
        if (verified == null) throw new Error('Invalid authored log entry')
        const folded = await foldEnvelope({
          crypto: group.crypto,
          baseRoster: group.roster,
          baseRegistry: group.registry,
          entries: [{ verified, entryID: ledgerEntryDigest(token) }],
          groupID: group.groupID,
          context:
            group.anchor.controller == null
              ? undefined
              : {
                  controllerID: group.anchor.controller,
                  memberController: (did) => group.bindingOfDID(did)?.controller,
                },
        })
        if (!folded.ok) throw folded.error ?? new Error(folded.reason)
        candidate = folded.registry
        tokens.push(token)
      }
    }
    await validateEntry(group, own.leaf, original.leaf, {
      registry: candidate,
      stage: 'full',
      mode: 'admit',
    })
    if (group.anchor.controller != null) {
      const entries = group.ledger.map(({ verified }) => verified)
      const before = historySize(group.state.ratchetTree, entries)
      const after = historySize(tree, entries)
      if (after > HISTORY_HORIZON && after > before) throw new LeafBindingError('history-horizon')
    }
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
    for (const member of group.listMembers()) {
      const leaf = leafAt(group.state.ratchetTree, member.leafIndex)
      if (leaf == null || !(await isLapsed(group, leaf))) continue
      removed.push(member.id)
      proposals.push({
        proposalType: defaultProposalTypes.remove,
        remove: { removed: member.leafIndex },
      })
    }
    if (removed.length === 0) return { removed }
    const tokens: Array<string> = []
    return { removed, result: await buildResult({ group, proposals, tokens }) }
  })
}

function alreadyApplied(group: GroupHandle, claims: ReadonlyArray<EffectClaim>): boolean {
  return (
    claims.length > 0 &&
    claims.every((claim) => {
      if (claim.kind === 'remove')
        return (
          group.registry.controllers
            .get(normalizeDID(group.anchor.controller as string))
            ?.removedMembers.has(claim.member.add) === true
        )
      const did = normalizeDID(claim.did)
      const record = group.registry.devices.get(did)
      return (
        record?.status === 'revoked' &&
        !isResetOnly(record) &&
        group.findMemberLeafIndex(did) == null
      )
    })
  )
}

export type RemovalEvidence = { controller: string; epoch: string; closure: ControllerLog }

export async function removalEvidence(
  controller: string,
  log: ControllerLog,
  rmv: string,
  options?: CryptoOptions,
): Promise<RemovalEvidence | undefined> {
  const signed = log.events.find(({ event }) => digestOf(event) === rmv)
  if (signed?.event.t !== 'rmv') return undefined
  const closure = await closureOf(controller, log, [rmv], options)
  if (closure == null) return undefined
  return { controller: normalizeDID(controller), epoch: signed.event.e, closure }
}

export async function survivorTargets(
  group: GroupHandle,
  add: string,
): Promise<Array<{ did: string; leafKey: Uint8Array }>> {
  const controller = group.anchor.controller
  if (controller == null) return []
  const descendants: Array<{ did: string; leafKey: Uint8Array }> = []
  for (const { id } of group.listMembers()) {
    const binding = group.bindingOfDID(id)
    if (binding?.controller !== normalizeDID(controller) || binding.prefix == null) continue
    const authority = await effectiveAuthorityOf(
      {
        did: id,
        binding: { ...binding, id: binding.controller, prefix: binding.prefix },
        leafKey: binding.leafKey,
      },
      group.registry,
      controller,
      { crypto: group.crypto },
    )
    if ('root' in authority && authority.root.kind === 'member' && authority.root.add === add)
      descendants.push({ did: id, leafKey: binding.leafKey.slice() })
  }
  return descendants
}

export type RevokeWithProofParams =
  | {
      log: ControllerLog
      deny?: Array<string>
      remove?: Array<{ did: string; add: string }>
      survivors?: Array<string>
      evidence?: Array<RemovalEvidence>
    }
  | { reset: true; log: ControllerLog }

export async function revokeWithProof(
  group: GroupHandle,
  params: RevokeWithProofParams,
): Promise<RevokeBuildResult> {
  return mutexFor(group).run(async () => {
    try {
      const controller = group.anchor.controller
      if (controller == null) throw new RevokeProofError('wrong-controller')
      const options = { crypto: group.crypto }
      const reset = 'reset' in params
      const requested = reset ? [] : (params.deny ?? []).map(normalizeDID)
      const removals = reset
        ? []
        : (params.remove ?? []).map(({ did, add }) => ({ did: normalizeDID(did), add }))
      if (!reset && requested.length === 0 && removals.length === 0)
        throw new RevokeProofError('no-rev')
      if (params.log.chain.length === 0) throw new RevokeProofError('no-rev')
      const projection = group.registry.controllers.get(normalizeDID(controller))
      if (params.log.chain.every(({ event }) => event.g < (projection?.genFloor ?? 0)))
        throw new RevokeProofError('generation-floor')
      let proof = await controllerLogDelta(group, params.log)
      if (!reset && params.evidence != null && proof != null) {
        const evidence = params.evidence.filter(
          (held) =>
            normalizeDID(held.controller) === normalizeDID(controller) &&
            held.closure.events.some(
              ({ event }) =>
                event.t === 'rmv' &&
                event.e === held.epoch &&
                removals.some(({ add }) => event.add === add),
            ),
        )
        const supplied = await mergeLifecycleProofLogs(
          controller,
          { chain: params.log.chain, events: proof.events },
          { chain: params.log.chain, events: evidence.flatMap(({ closure }) => closure.events) },
          options,
        )
        proof = { ...proof, events: supplied.events }
      }
      const ingested =
        proof == null
          ? null
          : await ingestControllerLog(
              controller,
              projection?.recordedLog,
              proof,
              projection,
              options,
            )
      if (!reset && ingested != null && ingested.after.head.gen !== ingested.before?.head.gen)
        throw new RevokeProofError('needs-reset')
      if (!reset) {
        const requestedClaims: Array<EffectClaim> = [
          ...(requested.length === 0 || projection?.recordedLog == null
            ? []
            : (
                await claimsFor(
                  controller,
                  undefined,
                  projection.recordedLog,
                  projection.genFloor,
                  options,
                )
              ).filter(
                (claim) => claim.kind === 'deny' && requested.includes(normalizeDID(claim.did)),
              )),
          ...removals.flatMap((member): Array<EffectClaim> => {
            const removed = projection?.removedMembers.get(member.add)
            return removed?.did === member.did
              ? [{ kind: 'remove', member, ref: removed.proofRef }]
              : []
          }),
        ]
        if (
          requestedClaims.length ===
            new Set(requested).size + new Set(removals.map(({ add }) => add)).size &&
          alreadyApplied(group, requestedClaims)
        )
          return { status: 'already-revoked' }
      }
      if (proof == null || ingested == null) throw new RevokeProofError('no-rev')
      const effects = await claimsFor(
        controller,
        projection?.recordedLog,
        await lifecycleProofLog(controller, ingested, proof, options),
        projection?.genFloor ?? 0,
        options,
      )
      if (
        !reset &&
        (requested.some(
          (did) =>
            !effects.some((claim) => claim.kind === 'deny' && normalizeDID(claim.did) === did),
        ) ||
          removals.some(
            (member) =>
              !effects.some(
                (claim) =>
                  claim.kind === 'remove' &&
                  claim.member.add === member.add &&
                  normalizeDID(claim.member.did) === member.did,
              ),
          ))
      )
        throw new RevokeProofError('no-rev')
      const value: DeviceValue = {
        op: reset ? 'reset' : 'revoke',
        proof,
        effects,
        revoked: [],
        removed: [],
        ...(!reset && params.survivors != null ? { survivors: [...params.survivors] } : {}),
      }
      const verified: VerifiedLedgerEntry<DeviceValue> = {
        issuer: group.credential.id,
        entry: { type: DEVICE_ENTRY_TYPE, groupID: group.groupID, subject: controller, value },
      }
      await authenticateLifecycleProof(controller, verified, group.registry, options)
      const derived = await lifecycleProofEffects(group, verified)
      value.revoked = derived.revoked
      value.removed = derived.removed
      if (derived.removeLeafIndices.includes(group.state.privatePath.leafIndex))
        return { status: 'self-affected', subject: group.credential.id }
      await verifyLifecycleProof(group, verified)
      const proposals: Array<DefaultProposal> = derived.removeLeafIndices.map((removed) => ({
        proposalType: defaultProposalTypes.remove,
        remove: { removed },
      }))
      const tokens = [await signLedgerEntry(ownIdentity(group), verified.entry)]
      return { status: 'built', effects, result: await buildResult({ group, proposals, tokens }) }
    } catch (error) {
      if (error instanceof RevokeProofError) return { status: 'not-provable', reason: error.reason }
      if (error instanceof LeafBindingError && error.reason === 'history-horizon')
        return { status: 'not-provable', reason: 'too-large' }
      throw error
    }
  })
}
