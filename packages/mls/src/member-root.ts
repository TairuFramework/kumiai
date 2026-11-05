import {
  type ControllerLog,
  decodeKey,
  digestOf,
  type EpochEvent,
  type FoldResult,
  type KeyState,
  type MemberState,
  type SignedEvent,
} from '@kokuin/controller'
import type { CryptoProvider } from '@kokuin/crypto'
import { type CryptoOptions, normalizeDID } from '@kokuin/token'

import { capabilityKey, readCapability } from './capability.js'
import type { FoldOk } from './controller-ingest.js'
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

export type MemberRootsOfParams = {
  binding: ControllerBinding
  leafDID: string
}

/** Decode only; callers authenticate the tokens and membership references. */
export function memberRootsOf({
  binding,
  leafDID,
}: MemberRootsOfParams): Array<{ slot: EvidenceSlot; root: MemberRoot }> {
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

async function foldedLog(controller: string, log: ControllerLog, options?: CryptoOptions) {
  const folded = await foldControllerLog(controller, log, options)
  if (!folded.ok) throw new RevokeProofError('effects-mismatch')
  return folded
}

function denies(state: KeyState, did: string): boolean {
  return [...state.deny].some((entry) => normalizeDID(entry) === normalizeDID(did))
}

type EffectProofs = {
  folded: FoldOk
  events: Map<string, SignedEvent<EpochEvent>>
  viewAt: (
    epoch: string | undefined,
  ) => Promise<{ folded: FoldResult; applied: Set<string> } | undefined>
  revokes: Map<string, Array<number>>
  drops: Map<string, Array<number>>
  tombstones: Map<string, Array<number>>
  snapshots: Map<string, Array<number>>
}

async function effectProofs(
  did: string,
  log: ControllerLog,
  options?: CryptoOptions,
): Promise<EffectProofs> {
  const folded = await foldedLog(did, log, options)
  const events = new Map(log.events.map((signed) => [digestOf(signed.event), signed]))
  const anchors = new Map(folded.states.map((state, index) => [state.digest, index]))
  const views = new Map<string, { folded: FoldResult; applied: Set<string> }>([
    [folded.head.epoch, { folded, applied: new Set(folded.applied) }],
  ])
  const drops = new Map<string, Array<number>>()
  // A settle that carries a removal in snapshot `u` proves it even when no chain state held it live.
  const tombstones = new Map<string, Array<number>>()
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
    for (const add of state.tombstones?.keys() ?? []) {
      if (!prior.tombstones?.has(add)) append(tombstones, add, index)
    }
  }
  const viewAt = async (epoch: string | undefined) => {
    if (epoch == null) return views.get(folded.head.epoch)
    const held = views.get(epoch)
    if (held != null) return held
    const anchor = anchors.get(epoch)
    if (anchor == null) return undefined
    const historical = await foldControllerLog(
      did,
      {
        chain: log.chain.slice(0, anchor + 1),
        events: log.events,
      },
      options,
    )
    const view = {
      folded: historical,
      applied: new Set(historical.ok ? historical.applied : []),
    }
    views.set(epoch, view)
    return view
  }
  return { folded, events, drops, tombstones, revokes, snapshots, viewAt }
}

async function checkEffect(
  log: ControllerLog,
  claim: EffectClaim,
  genFloor: number,
  proofs: EffectProofs,
): Promise<void> {
  let folded = proofs.folded
  const ref = claim.ref
  if ('event' in ref) {
    const view = await proofs.viewAt(ref.epoch)
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
    if (!proofs.drops.get(claim.member.add)?.includes(index)) {
      const tombstone = state.tombstones?.get(claim.member.add)
      if (tombstone == null || !proofs.tombstones.get(claim.member.add)?.includes(index))
        throw new RevokeProofError('no-rev')
      if (normalizeDID(tombstone.did) !== normalizeDID(claim.member.did))
        throw new RevokeProofError('effects-mismatch')
    }
  }
  if (state.gen < genFloor) throw new RevokeProofError('generation-floor')
}

export type EffectOfParams = {
  controller: string
  log: ControllerLog
  claim: EffectClaim
  genFloor: number
} & CryptoOptions

export async function effectOf({
  controller,
  log,
  claim,
  genFloor,
  ...options
}: EffectOfParams): Promise<void> {
  await checkEffect(
    log,
    claim,
    genFloor,
    await effectProofs(normalizeDID(controller), log, options),
  )
}

export async function effectProofContext(
  controller: string,
  log: ControllerLog,
  options?: CryptoOptions,
) {
  const did = normalizeDID(controller)
  const proofs = await effectProofs(did, log, options)
  return {
    effectOf: async (claim: EffectClaim, genFloor: number) =>
      await checkEffect(log, claim, genFloor, proofs),
    claimsFor: async (recorded: ControllerLog | undefined, genFloor: number) =>
      await claimsWithProofs(did, recorded, log, genFloor, proofs, options),
  }
}

export type ClaimsForParams = {
  controller: string
  recorded: ControllerLog | undefined
  merged: ControllerLog
  genFloor: number
} & CryptoOptions

export async function claimsFor({
  controller,
  recorded,
  merged,
  genFloor,
  ...options
}: ClaimsForParams): Promise<Array<EffectClaim>> {
  return (await effectProofContext(controller, merged, options)).claimsFor(recorded, genFloor)
}

async function claimsWithProofs(
  did: string,
  recorded: ControllerLog | undefined,
  merged: ControllerLog,
  genFloor: number,
  proofs: EffectProofs,
  options?: CryptoOptions,
): Promise<Array<EffectClaim>> {
  const before = recorded == null ? undefined : await foldedLog(did, recorded, options)
  const after = proofs.folded
  const delta = effectDelta({ before: before?.head, after: after.head })
  const eventClaims = new Map<string, Array<{ claim: EffectClaim; gen: number }>>()
  // Authenticate each supplied epoch once, including retained pre-settlement closures.
  for (const [digest, { event }] of proofs.events) {
    if (event.t !== 'rev' && event.t !== 'rmv') continue
    const view = await proofs.viewAt(event.e)
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
  const effects: Array<EffectClaim> = []
  for (const claim of claims) {
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
      await checkEffect(merged, event.claim, floor, proofs)
      effects.push(event.claim)
      continue
    }
    const atFloor = (index: number) => (after.states[index]?.gen ?? -1) >= floor
    // Drops before tombstones: a 0.12.0 receiver accepts only the drop.
    const index =
      claim.kind === 'deny'
        ? proofs.revokes.get(claim.did)?.find(atFloor)
        : (proofs.drops.get(claim.member.add)?.find(atFloor) ??
          proofs.tombstones.get(claim.member.add)?.find(atFloor))
    let ref: ProofRef | undefined = index == null ? undefined : { chainIndex: index }
    if (claim.kind === 'deny') {
      const snapshot = proofs.snapshots
        .get(claim.did)
        ?.find((index) => (after.states[index]?.gen ?? -1) >= floor)
      if (ref == null && snapshot != null) ref = { snapshot }
    }
    if (ref != null) {
      const candidate = { ...claim, ref }
      await checkEffect(merged, candidate, floor, proofs)
      effects.push(candidate)
      continue
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
      continue
    throw new RevokeProofError('no-rev')
  }
  return effects
}

export type MemberRootStatus =
  | { status: 'root' }
  | { status: 'effective'; key: Uint8Array; lease: number }
  | { status: 'removed' }
  | { status: 'unavailable'; why: 'no-log' | 'saturated' | 'unknown-incarnation' | 'prefix' }

const projectionFolds = new WeakMap<
  ControllerProjection,
  { folded: FoldResult; crypto: CryptoProvider | undefined }
>()

async function projectionFold(
  controller: string,
  projection: ControllerProjection | undefined,
  options?: CryptoOptions,
) {
  if (projection?.recordedLog == null) return undefined
  const cached = projectionFolds.get(projection)
  if (cached != null && cached.crypto === options?.crypto) return cached.folded
  const folded = await foldControllerLog(controller, projection.recordedLog, options)
  projectionFolds.set(projection, { folded, crypto: options?.crypto })
  return folded
}

export function effectiveAttestingMembers(
  head: KeyState | undefined,
  projection: ControllerProjection | undefined,
  time?: number,
): Array<[string, MemberState]> {
  if (head == null || head.saturated || head.gen < (projection?.genFloor ?? 0)) return []
  return [...head.members].filter(
    ([add, member]) =>
      member.effective &&
      !member.removed &&
      !projection?.removedMembers.has(add) &&
      (time == null || time <= member.lease),
  )
}

export type MemberRootStatusParams = {
  registry: DeviceRegistry
  controller: string
  root: MemberRoot
} & CryptoOptions

export async function memberRootStatus({
  registry,
  controller,
  root,
  ...options
}: MemberRootStatusParams): Promise<MemberRootStatus> {
  if (root.kind === 'root') return { status: 'root' }
  const did = normalizeDID(controller)
  const projection = registry.controllers.get(did)
  if (projection?.removedMembers.has(root.add)) return { status: 'removed' }
  const folded = await projectionFold(did, projection, options)
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

export type EffectiveAuthorityOfParams = {
  leaf: LeafRef
  registry: DeviceRegistry
  controller: string
} & CryptoOptions

export async function effectiveAuthorityOf({
  leaf,
  registry,
  controller,
  ...options
}: EffectiveAuthorityOfParams): Promise<
  | { root: MemberRoot; slot: EvidenceSlot; expiry?: number }
  | { status: 'removed' }
  | { status: 'unavailable' }
> {
  const did = normalizeDID(controller)
  if (normalizeDID(leaf.binding.id) !== did) return { status: 'unavailable' }
  const roots = memberRootsOf({ binding: leaf.binding, leafDID: leaf.did })
  const primary = roots[0]
  if (primary == null) return { status: 'unavailable' }
  const status = await memberRootStatus({
    registry,
    controller: did,
    root: primary.root,
    ...options,
  })
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
  if (status.status === 'root' || status.status === 'effective') {
    const holder = roots.find(({ slot }) => slot === 'holder')
    if (holder != null) {
      const held = await memberRootStatus({
        registry,
        controller: did,
        root: holder.root,
        ...options,
      })
      if (held.status === 'removed' || held.status === 'unavailable') return { status: held.status }
    }
    return primary
  }
  if (status.status === 'unavailable') return { status: 'unavailable' }
  const substitutes: Array<{ slot: EvidenceSlot; raw: string | undefined }> = [
    { slot: 'holder', raw: leaf.binding.holderGrant },
    { slot: 'survivor', raw: projection?.survivorGrants.get(normalizeDID(leaf.did)) },
  ]
  for (const { slot, raw } of substitutes) {
    if (raw == null) continue
    const root = substituteRoot(raw, leaf)
    if (root == null) continue
    const status = await memberRootStatus({ registry, controller: did, root, ...options })
    if (status.status === 'root' || status.status === 'effective')
      return { root, slot, expiry: readCapability(raw).payload.exp }
  }
  return { status: 'removed' }
}

export type CascadeOfParams = {
  leaves: ReadonlyArray<LeafRef & { leafIndex: number }>
  claims: ReadonlyArray<EffectClaim>
  before: DeviceRegistry
  after: DeviceRegistry
  controller: string
} & CryptoOptions

export async function cascadeOf({
  leaves,
  claims,
  before,
  after,
  controller,
  ...options
}: CascadeOfParams): Promise<{
  revoked: Array<RevokedEffect>
  removed: Array<RemovedEffect>
  removeLeafIndices: Array<number>
}> {
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
      holderRoot == null
        ? undefined
        : await memberRootStatus({ registry: after, controller, root: holderRoot, ...options })
    const authority = await effectiveAuthorityOf({ leaf, registry: after, controller, ...options })
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
    const prior = await effectiveAuthorityOf({ leaf, registry: before, controller, ...options })
    const roots = memberRootsOf({ binding: leaf.binding, leafDID: leaf.did }).map(
      ({ root }) => root,
    )
    if ('root' in prior) roots.unshift(prior.root)
    let root: (typeof roots)[number] | undefined
    for (const candidate of roots) {
      if (
        candidate.kind === 'member' &&
        (await memberRootStatus({ registry: after, controller, root: candidate, ...options }))
          .status === 'removed'
      ) {
        root = candidate
        break
      }
    }
    if (root?.kind !== 'member') continue
    removed.push({ did, cascadedFrom: normalizeDID(root.did) })
    removeLeafIndices.push(leaf.leafIndex)
  }
  return { revoked, removed, removeLeafIndices }
}
