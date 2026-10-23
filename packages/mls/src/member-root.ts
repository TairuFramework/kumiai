import {
  type ControllerLog,
  decodeKey,
  digestOf,
  type FoldResult,
  type KeyState,
} from '@kokuin/controller'
import { normalizeDID } from '@kokuin/token'

import { capabilityKey, readCapability } from './capability.js'
import { effectDelta } from './controller-ingest.js'
import { foldControllerLog, memberDropIndices, revokeIndices } from './controller-log.js'
import type { ControllerBinding } from './credential.js'
import { LeafBindingError, RevokeProofError } from './errors.js'
import type { ControllerProjection, DeviceRegistry, RevokedEffect } from './registry.js'

export type MemberRoot =
  | { kind: 'root'; controller: string }
  | { kind: 'member'; did: string; add: string; gen: number }

export type EvidenceSlot = 'capability' | 'parent' | 'holder' | 'membership' | 'survivor'

export type ProofRef =
  | { chainIndex: number }
  | { snapshot: number }
  | { event: string; epoch?: string }

export type EffectClaim =
  | { kind: 'deny'; did: string; ref: ProofRef }
  | { kind: 'remove'; member: { did: string; add: string }; ref: ProofRef }

type EffectTarget =
  | Omit<Extract<EffectClaim, { kind: 'deny' }>, 'ref'>
  | Omit<Extract<EffectClaim, { kind: 'remove' }>, 'ref'>

export type RemovedMember = { did: string; gen: number; proofRef: ProofRef }
export type RemovedEffect = { did: string; cascadedFrom: string }

/** Decode only; callers authenticate the tokens and membership references. */
export function memberRootsOf(
  binding: ControllerBinding,
  leafDID: string,
): Array<{ slot: EvidenceSlot; root: MemberRoot }> {
  const tokenRoot = (raw: string): MemberRoot => {
    const { iss, mbr } = readCapability(raw).payload
    return mbr == null
      ? { kind: 'root', controller: binding.id }
      : { kind: 'member', did: iss, add: mbr.add, gen: mbr.g }
  }
  if (binding.member != null) {
    return [
      {
        slot: 'membership',
        root: { kind: 'member', did: leafDID, add: binding.member.add, gen: binding.member.g },
      },
    ]
  }
  if (binding.capability == null) throw new LeafBindingError('controller-mismatch')
  const { cap } = readCapability(binding.capability).payload
  const parent = Array.isArray(cap) ? cap[0] : cap
  const roots: Array<{ slot: EvidenceSlot; root: MemberRoot }> = [
    parent == null
      ? { slot: 'capability', root: tokenRoot(binding.capability) }
      : { slot: 'parent', root: tokenRoot(parent) },
  ]
  if (binding.holderGrant != null)
    roots.push({ slot: 'holder', root: tokenRoot(binding.holderGrant) })
  return roots
}

function foldedLog(controller: string, log: ControllerLog) {
  const folded = foldControllerLog(controller, log)
  if (!folded.ok) throw new RevokeProofError('effects-mismatch')
  return folded
}

function denies(state: KeyState, did: string): boolean {
  return [...state.deny].some((entry) => normalizeDID(entry) === normalizeDID(did))
}

export function effectOf(
  controller: string,
  log: ControllerLog,
  claim: EffectClaim,
  genFloor: number,
): void {
  const did = normalizeDID(controller)
  let folded = foldedLog(did, log)
  const ref = claim.ref
  if ('event' in ref) {
    if (ref.epoch != null) {
      const anchor = folded.states.findIndex((state) => state.digest === ref.epoch)
      if (anchor === -1) throw new RevokeProofError('no-rev')
      folded = foldedLog(did, { chain: log.chain.slice(0, anchor + 1), events: log.events })
    }
    const signed = log.events.find(({ event }) => digestOf(event) === ref.event)
    if (signed == null) throw new RevokeProofError('no-rev')
    const event = signed.event
    if (!folded.applied.includes(ref.event)) throw new RevokeProofError('effects-mismatch')
    if (event.g < genFloor) throw new RevokeProofError('generation-floor')
    if (claim.kind === 'deny') {
      if (event.t !== 'rev' || normalizeDID(event.x) !== normalizeDID(claim.did))
        throw new RevokeProofError('effects-mismatch')
    } else {
      const member = folded.head.members.get(claim.member.add)
      if (
        event.t !== 'rmv' ||
        event.add !== claim.member.add ||
        member == null ||
        normalizeDID(member.did) !== normalizeDID(claim.member.did)
      )
        throw new RevokeProofError('effects-mismatch')
    }
    return
  }
  const index = 'snapshot' in ref ? ref.snapshot : ref.chainIndex
  const state = folded.states[index]
  const prior = folded.states[index - 1]
  if (state == null || prior == null || log.chain[index]?.event.t !== 'rot')
    throw new RevokeProofError('no-rev')
  if ('snapshot' in ref) {
    if (claim.kind !== 'deny' || state.gen <= prior.gen || !denies(state, claim.did))
      throw new RevokeProofError('effects-mismatch')
  } else if (claim.kind === 'deny') {
    if (!revokeIndices(did, log.chain, claim.did).includes(index))
      throw new RevokeProofError('no-rev')
  } else {
    const member = prior.members.get(claim.member.add)
    if (member != null && normalizeDID(member.did) !== normalizeDID(claim.member.did))
      throw new RevokeProofError('effects-mismatch')
    if (!memberDropIndices(did, log.chain, claim.member.add).includes(index))
      throw new RevokeProofError('no-rev')
  }
  if (state.gen < genFloor) throw new RevokeProofError('generation-floor')
}

export function claimsFor(
  controller: string,
  recorded: ControllerLog | undefined,
  merged: ControllerLog,
  genFloor: number,
): Array<EffectClaim> {
  const did = normalizeDID(controller)
  const before = recorded == null ? undefined : foldedLog(did, recorded)
  const after = foldedLog(did, merged)
  const delta = effectDelta(before?.head, after.head)
  const removed = new Map(delta.removed.map((member) => [member.add, member]))
  if (before == null) {
    for (const state of [...after.states, after.head]) {
      for (const [add, member] of state.members) {
        if (after.head.members.get(add)?.effective) continue
        if (member.removed || memberDropIndices(did, merged.chain, add).length > 0)
          removed.set(add, { did: normalizeDID(member.did), add })
      }
    }
  }
  const claims: Array<EffectTarget> = [
    ...delta.denied.map((did): EffectTarget => ({ kind: 'deny', did })),
    ...[...removed.values()]
      .sort((a, b) => (a.add < b.add ? -1 : a.add > b.add ? 1 : 0))
      .map((member): EffectTarget => ({ kind: 'remove', member })),
  ]
  return claims.map((claim) => {
    const floor = claim.kind === 'deny' ? Math.max(genFloor, after.head.gen) : genFloor
    // Old-epoch copies remain in the entry even when the authoritative projection prunes them.
    for (const { event } of merged.events) {
      if (event.t !== (claim.kind === 'deny' ? 'rev' : 'rmv')) continue
      const ref: ProofRef = {
        event: digestOf(event),
        ...('e' in event && event.e !== after.head.epoch ? { epoch: event.e } : {}),
      }
      const candidate = { ...claim, ref }
      try {
        effectOf(did, merged, candidate, floor)
        return candidate
      } catch (cause) {
        if (!(cause instanceof RevokeProofError)) throw cause
      }
    }
    const indices =
      claim.kind === 'deny'
        ? revokeIndices(did, merged.chain, claim.did)
        : memberDropIndices(did, merged.chain, claim.member.add)
    const index = indices.find((index) => (after.states[index]?.gen ?? -1) >= floor)
    if (index != null) return { ...claim, ref: { chainIndex: index } }
    if (claim.kind === 'deny') {
      const snapshot = after.states.findIndex((state, index) => {
        const prior = after.states[index - 1]
        return (
          merged.chain[index]?.event.t === 'rot' &&
          prior != null &&
          state.gen > prior.gen &&
          state.gen >= floor &&
          denies(state, claim.did)
        )
      })
      if (snapshot !== -1) return { ...claim, ref: { snapshot } }
    }
    throw new RevokeProofError('no-rev')
  })
}

export type MemberRootStatus =
  | { status: 'root' }
  | { status: 'effective'; key: Uint8Array; lease: number }
  | { status: 'removed' }
  | { status: 'unavailable'; why: 'no-log' | 'saturated' | 'unknown-incarnation' | 'prefix' }

const projectionFolds = new WeakMap<ControllerProjection, FoldResult>()

function projectionFold(controller: string, projection: ControllerProjection | undefined) {
  if (projection?.recordedLog == null) return undefined
  let folded = projectionFolds.get(projection)
  if (folded == null) {
    folded = foldControllerLog(controller, projection.recordedLog)
    projectionFolds.set(projection, folded)
  }
  return folded
}

export function memberRootStatus(
  registry: DeviceRegistry,
  controller: string,
  root: MemberRoot,
): MemberRootStatus {
  if (root.kind === 'root') return { status: 'root' }
  const did = normalizeDID(controller)
  const projection = registry.controllers.get(did)
  const tombstone = projection?.removedMembers.get(root.add)
  if (tombstone != null && normalizeDID(tombstone.did) === normalizeDID(root.did))
    return { status: 'removed' }
  const folded = projectionFold(did, projection)
  if (folded == null) return { status: 'unavailable', why: 'no-log' }
  if (!folded.ok) return { status: 'unavailable', why: 'prefix' }
  if (root.gen !== folded.head.gen || root.gen < (projection?.genFloor ?? 0))
    return { status: 'removed' }
  if (folded.head.saturated) return { status: 'unavailable', why: 'saturated' }
  const member = folded.head.members.get(root.add)
  if (member == null || normalizeDID(member.did) !== normalizeDID(root.did))
    return { status: 'unavailable', why: 'unknown-incarnation' }
  if (member.removed || !member.effective) return { status: 'removed' }
  return { status: 'effective', key: decodeKey(member.key).publicKey, lease: member.lease }
}

export type LeafRef = { did: string; binding: ControllerBinding; leafKey: Uint8Array }

function substituteRoot(raw: string, leaf: LeafRef): MemberRoot | undefined {
  try {
    const { payload } = readCapability(raw)
    const key = capabilityKey(payload).publicKey
    if (
      normalizeDID(payload.aud) !== normalizeDID(leaf.did) ||
      key.length !== leaf.leafKey.length ||
      key.some((byte, index) => byte !== leaf.leafKey[index])
    )
      return undefined
    return payload.mbr == null
      ? { kind: 'root', controller: leaf.binding.id }
      : { kind: 'member', did: payload.iss, add: payload.mbr.add, gen: payload.mbr.g }
  } catch {
    return undefined
  }
}

export function effectiveAuthorityOf(
  leaf: LeafRef,
  registry: DeviceRegistry,
  controller: string,
): { root: MemberRoot; slot: EvidenceSlot } | { status: 'removed' } | { status: 'unavailable' } {
  const did = normalizeDID(controller)
  if (normalizeDID(leaf.binding.id) !== did) return { status: 'unavailable' }
  const projection = registry.controllers.get(did)
  const chain = projection?.recordedLog?.chain
  if (
    chain != null &&
    leaf.binding.prefix.some((signed, index) => {
      const recorded = chain[index]
      return recorded == null || digestOf(recorded.event) !== digestOf(signed.event)
    })
  )
    return { status: 'unavailable' }
  const roots = memberRootsOf(leaf.binding, leaf.did)
  const primary = roots[0]
  if (primary == null) return { status: 'unavailable' }
  const status = memberRootStatus(registry, did, primary.root)
  if (status.status === 'root' || status.status === 'effective') return primary
  if (status.status === 'unavailable') return { status: 'unavailable' }
  const substitutes: Array<{ slot: EvidenceSlot; raw: string | undefined }> = [
    { slot: 'holder', raw: leaf.binding.holderGrant },
    { slot: 'survivor', raw: projection?.survivorGrants.get(normalizeDID(leaf.did)) },
  ]
  for (const { slot, raw } of substitutes) {
    if (raw == null) continue
    const root = substituteRoot(raw, leaf)
    if (root == null) continue
    const status = memberRootStatus(registry, did, root)
    if (status.status === 'root' || status.status === 'effective') return { root, slot }
  }
  return { status: 'removed' }
}

export function cascadeOf(
  leaves: ReadonlyArray<LeafRef & { leafIndex: number }>,
  claims: ReadonlyArray<EffectClaim>,
  before: DeviceRegistry,
  after: DeviceRegistry,
  controller: string,
): {
  revoked: Array<RevokedEffect>
  removed: Array<RemovedEffect>
  removeLeafIndices: Array<number>
} {
  const revoked: Array<RevokedEffect> = claims
    .filter((claim) => claim.kind === 'deny')
    .map((claim) => ({ did: normalizeDID(claim.did) }))
  const direct = new Set(revoked.map(({ did }) => did))
  const affected = new Set(direct)
  const removed: Array<RemovedEffect> = []
  const removeLeafIndices: Array<number> = []
  for (const leaf of leaves) {
    const did = normalizeDID(leaf.did)
    if (normalizeDID(leaf.binding.id) !== normalizeDID(controller)) continue
    const capability =
      leaf.binding.capability == null ? undefined : readCapability(leaf.binding.capability).payload
    const issuer = capability?.cap == null ? undefined : normalizeDID(capability.iss)
    const holderRoot =
      leaf.binding.holderGrant == null ? undefined : substituteRoot(leaf.binding.holderGrant, leaf)
    const holderStatus =
      holderRoot == null ? undefined : memberRootStatus(after, controller, holderRoot)
    const evidenced =
      !direct.has(did) &&
      after.devices.get(did)?.status !== 'revoked' &&
      (holderStatus?.status === 'root' || holderStatus?.status === 'effective')
    if (issuer != null && direct.has(issuer) && !direct.has(did) && !evidenced) {
      if (!affected.has(did)) revoked.push({ did, cascadedFrom: issuer })
      affected.add(did)
    }
    if (affected.has(did)) {
      removeLeafIndices.push(leaf.leafIndex)
      continue
    }
    if (!claims.some((claim) => claim.kind === 'remove')) continue
    const authority = effectiveAuthorityOf(leaf, after, controller)
    if (!('status' in authority) || authority.status !== 'removed') continue
    const prior = effectiveAuthorityOf(leaf, before, controller)
    const root = 'root' in prior ? prior.root : memberRootsOf(leaf.binding, leaf.did)[0]?.root
    if (root?.kind !== 'member') continue
    removed.push({ did, cascadedFrom: normalizeDID(root.did) })
    removeLeafIndices.push(leaf.leafIndex)
  }
  return { revoked, removed, removeLeafIndices }
}
