import { assertCapabilityToken, checkCapability } from '@kokuin/capability'
import { type ControllerLog, isControllerLog, LOG_TOO_LARGE, mergeLogs } from '@kokuin/controller'
import { normalizeDID, verifyToken } from '@kokuin/token'
import { defaultCredentialTypes, isDefaultCredential, type LeafNode, nodeTypes } from 'ts-mls'

import { hasHolderEvidence } from './authentication.js'
import {
  assertCapabilityLifetime,
  assertControllerGrant,
  capabilityKey,
  MLS_LEAF_ACT,
  MLS_LEAF_RES,
  readCapability,
} from './capability.js'
import { effectDelta, ingestControllerLog } from './controller-ingest.js'
import { foldChain, foldControllerLog } from './controller-log.js'
import { parseMLSCredentialIdentity } from './credential.js'
import { createRegistryControllerResolver } from './embedded-resolver.js'
import { LeafBindingError, LeafLapsedError, RevokeProofError } from './errors.js'
import type { GroupHandle } from './group-handle.js'
import { controllerLogSize, HISTORY_HORIZON, historySize, proofSize } from './history.js'
import type { VerifiedLedgerEntry } from './ledger.js'
import { attestedTreeTime, isLapsed, leafAt } from './lifecycle.js'
import {
  cascadeOf,
  claimsFor,
  type EffectClaim,
  effectOf,
  memberRootStatus,
  type RemovedEffect,
} from './member-root.js'
import {
  type DeviceRegistry,
  type DeviceValue,
  denySetOf,
  type RevokedEffect,
  registryApply,
} from './registry.js'

export { controllerLogSize, HISTORY_HORIZON } from './history.js'

/** Derived from a proof and the pre-commit tree; proposal comparison belongs to the commit gate. */
export type LifecycleProofEffects = {
  controller: string
  recordedLog: ControllerLog
  genFloor: number
  timeFloor: number
  revoked: Array<RevokedEffect>
  removed: Array<RemovedEffect>
  removeLeafIndices: Array<number>
}

type AuthenticatedProof = {
  recordedLog: ControllerLog
  genFloor: number
  resetRef?: { snapshot: number }
}

/** Keep controller merge limits inside the lifecycle proof error boundary. */
export function mergeLifecycleProofLogs(
  controller: string,
  first: ControllerLog,
  second: ControllerLog,
): ControllerLog {
  try {
    return mergeLogs(controller, first, second)
  } catch (cause) {
    if (!(cause instanceof Error) || !cause.message.startsWith(LOG_TOO_LARGE)) throw cause
    const error = new RevokeProofError('too-large')
    error.cause = cause
    throw error
  }
}

/** Reattach historical closures without reviving unapplied current-epoch events. */
export function lifecycleProofLog(
  controller: string,
  ingested: ReturnType<typeof ingestControllerLog>,
  proof: ControllerLog,
): ControllerLog {
  return mergeLifecycleProofLogs(controller, ingested.log, {
    chain: ingested.log.chain,
    events: proof.events.filter(({ event }) => event.e !== ingested.after.head.epoch),
  })
}

/** Authenticate replayable log data without reading any membership state. */
export function authenticateLifecycleProof(
  controllerID: string,
  verified: VerifiedLedgerEntry<DeviceValue>,
  registry: DeviceRegistry,
): AuthenticatedProof {
  const controller = normalizeDID(controllerID)
  const subject = normalizeDID(verified.entry.subject)
  const value = verified.entry.value
  const previous = registry.controllers.get(controller)
  const floor = previous?.genFloor ?? 0
  if (
    (value.controller != null && normalizeDID(value.controller) !== controller) ||
    subject !== controller
  )
    throw new RevokeProofError('wrong-controller')
  const proof = value.proof
  if (value.op === 'log' || value.op === 'seed') {
    if (!isControllerLog(proof)) throw new RevokeProofError('not-authority-signed')
    if (value.op === 'seed' ? previous?.recordedLog != null : previous?.recordedLog == null)
      throw new RevokeProofError('detached')
    const ingested = ingestControllerLog(controller, previous?.recordedLog, proof, previous)
    if (value.op === 'log') {
      const delta = effectDelta(ingested.before?.head, ingested.after.head)
      if (delta.generation) throw new RevokeProofError('needs-reset')
      if (delta.denied.length > 0 || delta.removed.length > 0)
        throw new RevokeProofError('effects-mismatch')
    }
    return { recordedLog: ingested.log, genFloor: Math.max(floor, ingested.after.head.gen) }
  }
  if (!isControllerLog(proof)) throw new RevokeProofError('no-rev')
  if (proof.chain.length > 0 && proof.chain.every(({ event }) => event.g < floor))
    throw new RevokeProofError('generation-floor')
  if (
    value.op === 'reset' &&
    proof.chain[0]?.event.t === 'icp' &&
    proof.chain.every(({ event }) => event.g <= floor)
  )
    throw new RevokeProofError('generation-floor')
  if (value.op === 'revoke' && proof.chain.some(({ event }) => event.g > (previous?.genFloor ?? 0)))
    throw new RevokeProofError('needs-reset')
  const ingested = ingestControllerLog(controller, previous?.recordedLog, proof, previous)
  if (ingested.after.head.saturated) throw new RevokeProofError('too-large')
  const delta = effectDelta(ingested.before?.head, ingested.after.head)
  if (value.op === 'reset') {
    if (!delta.generation || ingested.after.head.gen <= floor)
      throw new RevokeProofError('generation-floor')
  } else if (delta.generation) throw new RevokeProofError('needs-reset')
  const proofLog = lifecycleProofLog(controller, ingested, proof)
  const expected = claimsFor(controller, previous?.recordedLog, proofLog, floor)
  if (value.effects == null || (value.effects.length === 0 && value.op !== 'reset'))
    throw new RevokeProofError('no-rev')
  for (const claim of value.effects) {
    if (value.op !== 'reset' && 'snapshot' in claim.ref) throw new RevokeProofError('no-rev')
    effectOf(controller, proofLog, claim, floor)
  }
  const target = (claim: EffectClaim) =>
    claim.kind === 'deny'
      ? `deny:${normalizeDID(claim.did)}`
      : `remove:${normalizeDID(claim.member.did)}:${claim.member.add}`
  if (
    value.effects.length !== expected.length ||
    expected.some((claim, index) => {
      const declared = value.effects?.[index]
      return declared == null || target(claim) !== target(declared)
    })
  )
    throw new RevokeProofError('effects-mismatch')
  const resetIndex =
    value.op === 'reset'
      ? ingested.log.chain.findIndex(
          ({ event }, index, chain) => index > 0 && event.g > (chain[index - 1]?.event.g ?? 0),
        )
      : -1
  return {
    recordedLog: ingested.log,
    genFloor: Math.max(floor, ingested.after.head.gen),
    ...(resetIndex < 0 ? {} : { resetRef: { snapshot: resetIndex } }),
  }
}

/**
 * A leaf that stays when its issuer is denied: in a group whose anchor names a controller, a
 * chained leaf of that controller carrying its holder's own valid grant from it, for a holder that
 * is not denied. The cascade skips it and survivor checks keep it.
 */
export function isEvidencedChild(
  group: GroupHandle,
  leaf: LeafNode,
  denied: ReadonlySet<string> = denySetOf(group.registry),
): boolean {
  const controller = group.anchor.controller
  if (
    controller == null ||
    !isDefaultCredential(leaf.credential) ||
    leaf.credential.credentialType !== defaultCredentialTypes.basic
  )
    return false
  let parsed: ReturnType<typeof parseMLSCredentialIdentity>
  try {
    parsed = parseMLSCredentialIdentity(leaf.credential.identity)
  } catch {
    return false
  }
  if (parsed.controller == null || normalizeDID(parsed.controller.id) !== normalizeDID(controller))
    return false
  return hasHolderEvidence(
    parsed,
    leaf.signaturePublicKey,
    denied,
    group.anchor.trustedGrantLifetime ?? 2_592_000,
  )
}

/** Whether the member at `leafIndex` is an evidenced child that a cascade leaves in place. */
export function isExemptMember(group: GroupHandle, leafIndex: number): boolean {
  const node = group.state.ratchetTree[leafIndex * 2]
  return node?.nodeType === nodeTypes.leaf && isEvidencedChild(group, node.leaf)
}

/** The entry must declare exactly the derived effects, in derivation order. */
function effectsMatch(
  declared: Array<RevokedEffect> | undefined,
  derived: Array<RevokedEffect>,
): boolean {
  if (declared?.length !== derived.length) return false
  return derived.every((effect, index) => {
    const held = declared[index]
    if (held == null || normalizeDID(held.did) !== effect.did) return false
    const cascadedFrom = held.cascadedFrom == null ? undefined : normalizeDID(held.cascadedFrom)
    return cascadedFrom === effect.cascadedFrom
  })
}

/** Verify live effects while all leaves still describe the epoch before the commit. */
export async function lifecycleProofEffects(
  group: GroupHandle,
  verified: VerifiedLedgerEntry<DeviceValue>,
): Promise<LifecycleProofEffects> {
  const controllerID = group.anchor.controller
  if (controllerID == null) throw new RevokeProofError('wrong-controller')
  const controller = normalizeDID(controllerID)
  const subject = normalizeDID(verified.entry.subject)
  const value = verified.entry.value
  const issuerController = group.bindingOfDID(verified.issuer)?.controller
  if (
    verified.entry.groupID !== group.groupID ||
    issuerController == null ||
    normalizeDID(issuerController) !== controller
  ) {
    throw new RevokeProofError('wrong-controller')
  }
  const previous = group.registry.controllers.get(controller)
  const leaves = group.listMembers().map((member) => {
    const binding = group.bindingOfDID(member.id)
    const folded = binding?.prefix == null ? undefined : foldChain(controller, binding.prefix)
    return {
      did: normalizeDID(member.id),
      leafIndex: member.leafIndex,
      generation: folded?.ok ? folded.states.at(-1)?.gen : undefined,
      prefix: binding?.prefix ?? [],
    }
  })
  const timeFloor = previous?.timeFloor ?? 0
  if (value.op === 'clock') {
    if (subject !== controller) throw new RevokeProofError('wrong-controller')
    if (value.time == null || !Number.isFinite(value.time))
      throw new RevokeProofError('effects-mismatch')
    if (value.attest === true) {
      const folded =
        previous?.recordedLog == null
          ? undefined
          : foldControllerLog(controller, previous.recordedLog)
      const eligible =
        folded?.ok &&
        !folded.head.saturated &&
        folded.head.gen >= (previous?.genFloor ?? 0) &&
        [...folded.head.members].some(
          ([add, member]) =>
            member.effective &&
            !member.removed &&
            !previous?.removedMembers.has(add) &&
            normalizeDID(member.did) === normalizeDID(verified.issuer) &&
            (value.time as number) > (previous?.attestations.get(member.key) ?? 0) &&
            (value.time as number) <= member.lease,
        )
      if (!eligible) throw new RevokeProofError('effects-mismatch')
    } else if (
      value.time <= timeFloor ||
      value.time > attestedTreeTime(group.state.ratchetTree, group.registry, controller)
    ) {
      throw new RevokeProofError('effects-mismatch')
    }
    return {
      controller,
      recordedLog: previous?.recordedLog ?? { chain: [], events: [] },
      genFloor: previous?.genFloor ?? 0,
      timeFloor: value.attest === true ? timeFloor : value.time,
      revoked: [],
      removed: [],
      removeLeafIndices: [],
    }
  }
  const authenticated = authenticateLifecycleProof(controller, verified, group.registry)
  if (value.op === 'log') {
    const index = group.findMemberLeafIndex(verified.issuer)
    const leaf = index == null ? undefined : leafAt(group.state.ratchetTree, index)
    if (leaf == null) throw new RevokeProofError('wrong-controller')
    if (denySetOf(group.registry).has(normalizeDID(verified.issuer)))
      throw new LeafBindingError('denied-id')
    if (isLapsed(group, leaf)) throw new LeafLapsedError('lapsed')
    const before = historySize(
      group.state.ratchetTree,
      group.ledger.map(({ verified }) => verified),
    )
    if (before + proofSize(value.proof) > HISTORY_HORIZON) throw new RevokeProofError('too-large')
    return {
      controller,
      ...authenticated,
      timeFloor,
      revoked: [],
      removed: [],
      removeLeafIndices: [],
    }
  }
  if (value.op !== 'revoke' && value.op !== 'reset') throw new RevokeProofError('no-rev')
  const candidate = registryApply(
    { ...verified, entry: { ...verified.entry, value: { ...value, revoked: [] } } },
    group.registry,
    controller,
  )
  for (const raw of value.survivors ?? []) {
    const { payload } = readCapability(raw)
    assertControllerGrant(payload, controller)
    if (payload.mbr == null || payload.cap != null) throw new LeafBindingError('issuer-mismatch')
    assertCapabilityLifetime(payload, group.anchor.trustedGrantLifetime ?? 2_592_000)
    const leaf = group.bindingOfDID(payload.aud)
    const key = capabilityKey(payload).publicKey
    if (
      leaf?.controller !== controller ||
      key.length !== leaf.leafKey.length ||
      key.some((byte, index) => byte !== leaf.leafKey[index])
    )
      throw new LeafBindingError('confirmation-invalid')
    const status = memberRootStatus(candidate, controller, {
      kind: 'member',
      did: payload.iss,
      add: payload.mbr.add,
      gen: payload.mbr.g,
    })
    if (status.status !== 'effective')
      throw new LeafBindingError(
        status.status === 'removed' ? 'member-removed' : 'member-unavailable',
      )
    const resolver = createRegistryControllerResolver({
      controllerID: controller,
      prefix: candidate.controllers.get(controller)?.recordedLog?.chain ?? [],
      registry: candidate,
    }).frozen()
    const token = await verifyToken(raw, {
      methods: [resolver],
      historic: true,
      atTime: payload.iat,
      allowUnsigned: false,
    })
    assertCapabilityToken(token)
    await checkCapability({ act: MLS_LEAF_ACT, res: MLS_LEAF_RES }, payload, {
      atTime: payload.iat,
      methods: [resolver],
      maxDepth: 1,
      maxMemberGrantLifetime: group.anchor.trustedGrantLifetime ?? 2_592_000,
    })
  }
  const resetRef = authenticated.resetRef
  if (value.op === 'reset' && resetRef == null) throw new RevokeProofError('no-rev')
  const resetDIDs = new Set(
    value.op === 'reset'
      ? leaves
          .filter((leaf) => leaf.generation != null && leaf.generation < authenticated.genFloor)
          .map(({ did }) => did)
      : [],
  )
  const claims: Array<EffectClaim> =
    resetRef == null
      ? [...(value.effects ?? [])]
      : [
          ...[...resetDIDs].map((did): EffectClaim => ({ kind: 'deny', did, ref: resetRef })),
          ...(value.effects ?? []).filter(
            (claim) => claim.kind !== 'deny' || !resetDIDs.has(normalizeDID(claim.did)),
          ),
        ]
  const cascade = cascadeOf(
    group.listMembers().flatMap((member) => {
      const binding = group.bindingOfDID(member.id)
      if (binding?.controller == null || binding.prefix == null) return []
      return [
        {
          did: member.id,
          leafIndex: member.leafIndex,
          binding: { ...binding, id: binding.controller, prefix: binding.prefix },
          leafKey: binding.leafKey,
        },
      ]
    }),
    claims,
    group.registry,
    candidate,
    controller,
  )
  if (value.op === 'reset')
    cascade.revoked = cascade.revoked.filter(
      ({ did, cascadedFrom }) => resetDIDs.has(did) || cascadedFrom != null,
    )
  const affected = new Set(cascade.removeLeafIndices)
  const removed = leaves.filter(({ leafIndex }) => affected.has(leafIndex))
  const before = historySize(
    group.state.ratchetTree,
    group.ledger.map(({ verified }) => verified),
  )
  const after =
    before +
    proofSize(value.proof) -
    removed.reduce((size, leaf) => size + controllerLogSize(leaf.prefix), 0)
  if (after > HISTORY_HORIZON && after > before) throw new RevokeProofError('too-large')
  return {
    controller,
    ...authenticated,
    timeFloor,
    ...cascade,
  }
}

export async function verifyLifecycleProof(
  group: GroupHandle,
  verified: VerifiedLedgerEntry<DeviceValue>,
): Promise<LifecycleProofEffects> {
  const effects = await lifecycleProofEffects(group, verified)
  const value = verified.entry.value
  if (
    (value.op === 'revoke' || value.op === 'reset') &&
    (!effectsMatch(value.revoked, effects.revoked) || !effectsMatch(value.removed, effects.removed))
  )
    throw new RevokeProofError('effects-mismatch')
  return effects
}
