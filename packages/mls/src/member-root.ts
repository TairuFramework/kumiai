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
import { foldControllerLog } from './controller-log.js'
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

function effectProofs(did: string, log: ControllerLog) {
  const folded = foldedLog(did, log)
  const events = new Map(log.events.map((signed) => [digestOf(signed.event), signed]))
  const anchors = new Map(folded.states.map((state, index) => [state.digest, index]))
  const views = new Map<string, { folded: FoldResult; applied: Set<string> }>([
    [folded.head.epoch, { folded, applied: new Set(folded.applied) }],
  ])
  const drops = new Map<string, Array<number>>()
  const revokes = new Map<string, Array<number>>()
  const snapshots = new Map<string, Array<number>>()
  const denials = folded.states.map((state) => new Set([...state.deny].map(normalizeDID)))
  const rootOnly = log.chain.every(({ event }, index) => event.t === (index === 0 ? 'icp' : 'rot'))
  const append = (indices: Map<string, Array<number>>, target: string, index: number) => {
    const held = indices.get(target) ?? []
    held.push(index)
    indices.set(target, held)
  }
  for (let index = 1; index < folded.states.length; index++) {
    const state = folded.states[index]
    const prior = folded.states[index - 1]
    if (state == null || prior == null || log.chain[index]?.event.t !== 'rot') continue
    for (const target of denials[index] ?? []) {
      if (state.gen > prior.gen) append(snapshots, target, index)
      else if (rootOnly && state.gen === prior.gen && !denials[index - 1]?.has(target))
        append(revokes, target, index)
    }
    if (state.gen !== prior.gen) continue
    for (const [add, member] of prior.members) {
      if (!member.removed && !state.members.has(add)) append(drops, add, index)
    }
  }
  const viewAt = (epoch: string | undefined) => {
    if (epoch == null) return views.get(folded.head.epoch)
    const held = views.get(epoch)
    if (held != null) return held
    const anchor = anchors.get(epoch)
    if (anchor == null) return undefined
    const historical = foldControllerLog(did, {
      chain: log.chain.slice(0, anchor + 1),
      events: log.events,
    })
    const view = {
      folded: historical,
      applied: new Set(historical.ok ? historical.applied : []),
    }
    views.set(epoch, view)
    return view
  }
  return { folded, events, drops, revokes, snapshots, viewAt }
}

function checkEffect(
  log: ControllerLog,
  claim: EffectClaim,
  genFloor: number,
  proofs: ReturnType<typeof effectProofs>,
): void {
  let folded = proofs.folded
  const ref = claim.ref
  if ('event' in ref) {
    const view = proofs.viewAt(ref.epoch)
    if (view == null) throw new RevokeProofError('no-rev')
    if (!view.folded.ok) throw new RevokeProofError('effects-mismatch')
    folded = view.folded
    const signed = proofs.events.get(ref.event)
    if (signed == null) throw new RevokeProofError('no-rev')
    const event = signed.event
    if (!view.applied.has(ref.event)) throw new RevokeProofError('effects-mismatch')
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
    if (!proofs.revokes.get(normalizeDID(claim.did))?.includes(index))
      throw new RevokeProofError('no-rev')
  } else {
    const member = prior.members.get(claim.member.add)
    if (member != null && normalizeDID(member.did) !== normalizeDID(claim.member.did))
      throw new RevokeProofError('effects-mismatch')
    if (!proofs.drops.get(claim.member.add)?.includes(index)) throw new RevokeProofError('no-rev')
  }
  if (state.gen < genFloor) throw new RevokeProofError('generation-floor')
}

export function effectOf(
  controller: string,
  log: ControllerLog,
  claim: EffectClaim,
  genFloor: number,
): void {
  checkEffect(log, claim, genFloor, effectProofs(normalizeDID(controller), log))
}

export function effectProofContext(controller: string, log: ControllerLog) {
  const did = normalizeDID(controller)
  const proofs = effectProofs(did, log)
  return {
    effectOf: (claim: EffectClaim, genFloor: number) => checkEffect(log, claim, genFloor, proofs),
    claimsFor: (recorded: ControllerLog | undefined, genFloor: number) =>
      claimsWithProofs(did, recorded, log, genFloor, proofs),
  }
}

export function claimsFor(
  controller: string,
  recorded: ControllerLog | undefined,
  merged: ControllerLog,
  genFloor: number,
): Array<EffectClaim> {
  return effectProofContext(controller, merged).claimsFor(recorded, genFloor)
}

function claimsWithProofs(
  did: string,
  recorded: ControllerLog | undefined,
  merged: ControllerLog,
  genFloor: number,
  proofs: ReturnType<typeof effectProofs>,
): Array<EffectClaim> {
  const before = recorded == null ? undefined : foldedLog(did, recorded)
  const after = proofs.folded
  const delta = effectDelta(before?.head, after.head)
  const eventClaims = new Map<string, Array<{ claim: EffectClaim; gen: number }>>()
  // Authenticate each supplied epoch once, including retained pre-settlement closures.
  for (const [digest, { event }] of proofs.events) {
    if (event.t !== 'rev' && event.t !== 'rmv') continue
    const view = proofs.viewAt(event.e)
    if (view == null || !view.folded.ok || !view.applied.has(digest)) continue
    const ref: ProofRef = {
      event: digest,
      ...(event.e === after.head.epoch ? {} : { epoch: event.e }),
    }
    let target: string
    let claim: EffectClaim
    if (event.t === 'rev') {
      target = `deny:${normalizeDID(event.x)}`
      claim = { kind: 'deny', did: normalizeDID(event.x), ref }
    } else {
      const member = view.folded.head.members.get(event.add)
      if (member == null) continue
      target = `remove:${event.add}`
      claim = { kind: 'remove', member: { did: normalizeDID(member.did), add: event.add }, ref }
    }
    const held = eventClaims.get(target) ?? []
    held.push({ claim, gen: event.g })
    eventClaims.set(target, held)
  }
  const removed = new Map(delta.removed.map((member) => [member.add, member]))
  if (before == null) {
    for (const state of [...after.states, after.head]) {
      for (const [add, member] of state.members) {
        if (after.head.members.get(add)?.effective) continue
        if (member.removed || proofs.drops.has(add))
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
  return claims.flatMap((claim): Array<EffectClaim> => {
    const floor = claim.kind === 'deny' ? Math.max(genFloor, after.head.gen) : genFloor
    const target = claim.kind === 'deny' ? `deny:${claim.did}` : `remove:${claim.member.add}`
    const event = eventClaims.get(target)?.find(({ claim: candidate, gen }) => {
      return (
        gen >= floor &&
        (claim.kind === 'deny' ||
          (candidate.kind === 'remove' && candidate.member.did === claim.member.did))
      )
    })
    if (event != null) {
      checkEffect(merged, event.claim, floor, proofs)
      return [event.claim]
    }
    const indices =
      claim.kind === 'deny' ? proofs.revokes.get(claim.did) : proofs.drops.get(claim.member.add)
    const index = indices?.find((index) => (after.states[index]?.gen ?? -1) >= floor)
    let ref: ProofRef | undefined = index == null ? undefined : { chainIndex: index }
    if (claim.kind === 'deny') {
      const snapshot = proofs.snapshots
        .get(claim.did)
        ?.find((index) => (after.states[index]?.gen ?? -1) >= floor)
      if (ref == null && snapshot != null) ref = { snapshot }
    }
    if (ref != null) {
      const candidate = { ...claim, ref }
      checkEffect(merged, candidate, floor, proofs)
      return [candidate]
    }
    // Generation changes and DID denials end authority without an explicit removal proof.
    if (
      claim.kind === 'remove' &&
      before != null &&
      !after.head.members.get(claim.member.add)?.removed &&
      !proofs.drops.has(claim.member.add) &&
      !eventClaims.has(target) &&
      (before.head.gen !== after.head.gen || denies(after.head, claim.member.did))
    )
      return []
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
  if (projection?.removedMembers.has(root.add)) return { status: 'removed' }
  const folded = projectionFold(did, projection)
  if (folded == null) return { status: 'unavailable', why: 'no-log' }
  if (!folded.ok) return { status: 'unavailable', why: 'prefix' }
  if (root.gen !== folded.head.gen || root.gen < (projection?.genFloor ?? 0))
    return { status: 'removed' }
  if (folded.head.saturated) return { status: 'unavailable', why: 'saturated' }
  const member = folded.head.members.get(root.add)
  if (member == null) return { status: 'unavailable', why: 'unknown-incarnation' }
  if (member.removed || !member.effective || normalizeDID(member.did) !== normalizeDID(root.did))
    return { status: 'removed' }
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
):
  | { root: MemberRoot; slot: EvidenceSlot; expiry?: number }
  | { status: 'removed' }
  | { status: 'unavailable' } {
  const did = normalizeDID(controller)
  if (normalizeDID(leaf.binding.id) !== did) return { status: 'unavailable' }
  const roots = memberRootsOf(leaf.binding, leaf.did)
  const primary = roots[0]
  if (primary == null) return { status: 'unavailable' }
  const status = memberRootStatus(registry, did, primary.root)
  const projection = registry.controllers.get(did)
  const chain = projection?.recordedLog?.chain
  if (
    chain != null &&
    leaf.binding.prefix.some((signed, index) => {
      const recorded = chain[index]
      return recorded == null || digestOf(recorded.event) !== digestOf(signed.event)
    })
  )
    return { status: status.status === 'removed' ? 'removed' : 'unavailable' }
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
    if (status.status === 'root' || status.status === 'effective')
      return { root, slot, expiry: readCapability(raw).payload.exp }
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
    const authority = effectiveAuthorityOf(leaf, after, controller)
    const evidenced =
      !direct.has(did) &&
      after.devices.get(did)?.status !== 'revoked' &&
      (holderStatus?.status === 'root' ||
        holderStatus?.status === 'effective' ||
        ('root' in authority && authority.slot === 'survivor'))
    if (issuer != null && direct.has(issuer) && !direct.has(did) && !evidenced) {
      if (!affected.has(did)) revoked.push({ did, cascadedFrom: issuer })
      affected.add(did)
    }
    if (affected.has(did)) {
      removeLeafIndices.push(leaf.leafIndex)
      continue
    }
    if (!('status' in authority) || authority.status !== 'removed') continue
    const prior = effectiveAuthorityOf(leaf, before, controller)
    const root = 'root' in prior ? prior.root : memberRootsOf(leaf.binding, leaf.did)[0]?.root
    if (root?.kind !== 'member') continue
    removed.push({ did, cascadedFrom: normalizeDID(root.did) })
    removeLeafIndices.push(leaf.leafIndex)
  }
  return { revoked, removed, removeLeafIndices }
}
