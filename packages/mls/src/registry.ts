import { type ControllerLog, digestOf, isControllerLog, resolveBranches } from '@kokuin/controller'
import { normalizeDID } from '@kokuin/token'

import type { GroupAnchor } from './anchor.js'
import { readCapability } from './capability.js'
import { ingestControllerLog } from './controller-ingest.js'
import { foldChain, foldControllerLog, memberDropIndices, revokeIndices } from './controller-log.js'
import type { MLSCredentialIdentity } from './credential.js'
import { RecoveryKnowledgeError, RevokeProofError } from './errors.js'
import type { FoldDrop, FoldInput } from './fold.js'
import type { GroupHandle } from './group-handle.js'
import type { VerifiedLedgerEntry } from './ledger.js'
import { authenticateLifecycleProof } from './lifecycle-proof.js'
import {
  claimsFor,
  type EffectClaim,
  type ProofRef,
  type RemovedEffect,
  type RemovedMember,
} from './member-root.js'
import {
  adminCount,
  ROLE_ENTRY_TYPE,
  type RoleValue,
  type RosterState,
  roleReducer,
} from './roster.js'

/** The reserved control type carrying a device-registry mutation. One branch, one namespace slot. */
export const DEVICE_ENTRY_TYPE = 'kumiai.device'

/** The device lifecycle operations plus the advisory controller-log beacon. */
export type DeviceOp =
  | 'register'
  | 'add'
  | 'revoke'
  | 'label'
  | 'beacon'
  | 'reset'
  | 'clock'
  | 'log'
  | 'seed'

/**
 * A `kumiai.device` entry's `value`. `controller` names the profile a register/add binds to;
 * `label` renames; `capability` carries the management-capability proof a manage op is verified
 * against IN THE ACCEPTANCE PIPELINE — the pure fold never reads it (recorded-once trust).
 */
export type DeviceValue = {
  op: DeviceOp
  controller?: string
  label?: string
  capability?: string
  proof?: ControllerLog
  effects?: Array<EffectClaim>
  removed?: Array<RemovedEffect>
  survivors?: Array<string>
  revoked?: Array<RevokedEffect>
  time?: number
  attest?: true
  /** Beacon only: the length of the controller's FULL log at announcement time. */
  logLength?: number
  /** Beacon only: the head digest of the controller's FULL log at announcement time. */
  headDigest?: string
}

export type RevokedEffect = { did: string; cascadedFrom?: string }

export type Revocation = {
  controller: string
  proofRef: ProofRef
  reason?: 'reset'
  cascadedFrom?: string
}

/** A folded device binding or revocation. Reset-only removal permits fresh admission. */
export type DeviceRecord = {
  controller: string
  status: 'active' | 'revoked'
  label?: string
  proofRef?: ProofRef
  reason?: 'reset'
  cascadedFrom?: string
}

export type ControllerProjection = {
  recordedLog?: ControllerLog
  genFloor: number
  timeFloor: number
  attestations: ReadonlyMap<string, number>
  removedMembers: ReadonlyMap<string, RemovedMember>
  survivorGrants: ReadonlyMap<string, string>
  beacon?: ControllerBeacon
}

export function controllerProjection(): ControllerProjection {
  return {
    genFloor: 0,
    timeFloor: 0,
    attestations: new Map(),
    removedMembers: new Map(),
    survivorGrants: new Map(),
  }
}

/** An advisory pointer to a controller's FULL log head. Never a validation input. */
export type ControllerBeacon = { logLength: number; headDigest: string }

/**
 * The group-folded device registry: `device DID -> record`, keyed by normalized DID. A pure
 * function of the accepted `kumiai.device` entries, folded beside {@link RosterState}. Two views
 * derive from `devices` and are never stored: {@link controllerOf} and {@link denySetOf}.
 * `controllers` records authenticated logs and floors, with an independent advisory beacon.
 */
export type DeviceRegistry = {
  devices: ReadonlyMap<string, DeviceRecord>
  controllers: ReadonlyMap<string, ControllerProjection>
}

export function registrySeed(): DeviceRegistry {
  return { devices: new Map(), controllers: new Map() }
}

/** Structural guard: a value carrying a known `op` (and, for register/add, a string controller). */
export function isDeviceValue(value: unknown): value is DeviceValue {
  if (value == null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (
    v.op !== 'register' &&
    v.op !== 'add' &&
    v.op !== 'revoke' &&
    v.op !== 'label' &&
    v.op !== 'beacon' &&
    v.op !== 'reset' &&
    v.op !== 'clock' &&
    v.op !== 'log' &&
    v.op !== 'seed'
  ) {
    return false
  }
  const logBearing = v.op === 'log' || v.op === 'seed'
  const proofBearing =
    logBearing || v.op === 'reset' || (v.op === 'revoke' && v.proof !== undefined)
  if (
    !proofBearing &&
    ('proof' in v || 'revoked' in v || 'effects' in v || 'removed' in v || 'survivors' in v)
  )
    return false
  if (
    logBearing &&
    (!isControllerLog(v.proof) ||
      'revoked' in v ||
      'effects' in v ||
      'removed' in v ||
      'survivors' in v ||
      'capability' in v)
  )
    return false
  if ((v.op === 'register' || v.op === 'add') && typeof v.controller !== 'string') return false
  if (v.op === 'beacon' && (typeof v.logLength !== 'number' || typeof v.headDigest !== 'string')) {
    return false
  }
  if (v.label !== undefined && typeof v.label !== 'string') return false
  if (v.controller !== undefined && typeof v.controller !== 'string') return false
  if (v.capability !== undefined && typeof v.capability !== 'string') return false
  if (v.logLength !== undefined && typeof v.logLength !== 'number') return false
  if (v.headDigest !== undefined && typeof v.headDigest !== 'string') return false
  if (v.time !== undefined && (typeof v.time !== 'number' || !Number.isFinite(v.time))) return false
  if (v.proof !== undefined && !isControllerLog(v.proof)) return false
  if (
    v.revoked !== undefined &&
    (!Array.isArray(v.revoked) ||
      v.revoked.some((effect: unknown) => {
        if (effect == null || typeof effect !== 'object') return true
        const record = effect as Record<string, unknown>
        return (
          typeof record.did !== 'string' ||
          (record.cascadedFrom !== undefined && typeof record.cascadedFrom !== 'string')
        )
      }))
  )
    return false
  if (v.op === 'clock' && typeof v.time !== 'number') return false
  if (v.attest !== undefined && (v.op !== 'clock' || v.attest !== true)) return false
  if (
    !logBearing &&
    (v.op === 'reset' || v.proof !== undefined) &&
    (!isControllerLog(v.proof) ||
      !Array.isArray(v.revoked) ||
      !Array.isArray(v.effects) ||
      !Array.isArray(v.removed))
  )
    return false
  if (
    v.effects !== undefined &&
    (!Array.isArray(v.effects) ||
      v.effects.some((claim: unknown) => {
        if (claim == null || typeof claim !== 'object') return true
        const c = claim as Record<string, unknown>
        if (
          c.kind === 'deny'
            ? typeof c.did !== 'string'
            : c.kind !== 'remove' ||
              c.member == null ||
              typeof c.member !== 'object' ||
              typeof (c.member as Record<string, unknown>).did !== 'string' ||
              typeof (c.member as Record<string, unknown>).add !== 'string'
        )
          return true
        if (c.ref == null || typeof c.ref !== 'object') return true
        const ref = c.ref as Record<string, unknown>
        const keys = Object.keys(ref)
        return !(
          (keys.length === 1 &&
            ((Number.isInteger(ref.chainIndex) && (ref.chainIndex as number) >= 0) ||
              (Number.isInteger(ref.snapshot) && (ref.snapshot as number) >= 0))) ||
          (typeof ref.event === 'string' &&
            keys.every((key) => key === 'event' || key === 'epoch') &&
            (ref.epoch === undefined || typeof ref.epoch === 'string'))
        )
      }))
  )
    return false
  if (
    v.removed !== undefined &&
    (!Array.isArray(v.removed) ||
      v.removed.some(
        (effect: unknown) =>
          effect == null ||
          typeof effect !== 'object' ||
          typeof (effect as Record<string, unknown>).did !== 'string' ||
          typeof (effect as Record<string, unknown>).cascadedFrom !== 'string',
      ))
  )
    return false
  if (
    v.survivors !== undefined &&
    (!Array.isArray(v.survivors) || v.survivors.some((raw: unknown) => typeof raw !== 'string'))
  )
    return false
  return true
}

export function isLifecycleDeviceValue(value: DeviceValue): boolean {
  if (!isDeviceValue(value)) return false
  return (
    value.op === 'beacon' ||
    value.op === 'clock' ||
    value.op === 'log' ||
    value.op === 'seed' ||
    ((value.op === 'revoke' || value.op === 'reset') &&
      value.proof !== undefined &&
      value.revoked !== undefined &&
      value.capability === undefined)
  )
}

/**
 * The registry fold step. Pure, order-dependent, authorization-free — a device entry's authority
 * is the acceptance pipeline's job (a self-register leaf attestation, or a management capability),
 * never the fold's. Lifecycle effects replay recorded DIDs without consulting a later tree.
 */
export function registryApply(
  verified: VerifiedLedgerEntry<DeviceValue>,
  state: DeviceRegistry,
  controllerID?: string,
): DeviceRegistry {
  const subject = normalizeDID(verified.entry.subject)
  const value = verified.entry.value
  const devices = new Map(state.devices)
  const controllers = new Map(state.controllers)
  const existing = devices.get(subject)
  if (
    controllerID != null &&
    (value.op === 'reset' ||
      value.op === 'revoke' ||
      value.op === 'clock' ||
      value.op === 'log' ||
      value.op === 'seed')
  ) {
    const controller = normalizeDID(controllerID)
    const previous = controllers.get(controller) ?? controllerProjection()
    if (value.op === 'clock') {
      if (value.attest === true) {
        const folded =
          previous.recordedLog == null
            ? undefined
            : foldControllerLog(controller, previous.recordedLog)
        const member = folded?.ok
          ? [...folded.head.members.values()].find(
              (member) => normalizeDID(member.did) === normalizeDID(verified.issuer),
            )
          : undefined
        if (member == null) throw new RevokeProofError('effects-mismatch')
        const attestations = new Map(previous.attestations)
        attestations.set(
          member.key,
          Math.max(attestations.get(member.key) ?? 0, value.time as number),
        )
        controllers.set(controller, { ...previous, attestations })
      } else {
        controllers.set(controller, {
          ...previous,
          timeFloor: Math.max(previous.timeFloor, value.time as number),
        })
      }
    } else {
      const effect = authenticateLifecycleProof(controller, verified, state)
      let projection = {
        ...previous,
        recordedLog: effect.recordedLog,
        genFloor: effect.genFloor,
      }
      if (value.op === 'seed') projection = seedEffects(controller, devices, projection)
      controllers.set(controller, projection)
      const resetRef = effect.resetRef
      const denials = new Map(
        (value.effects ?? []).flatMap((claim) =>
          claim.kind === 'deny' ? [[normalizeDID(claim.did), claim.ref] as const] : [],
        ),
      )
      for (const revoked of value.revoked ?? []) {
        const did = normalizeDID(revoked.did)
        const held = devices.get(did)
        if (held?.status === 'revoked' && (value.op === 'reset' || !isResetOnly(held))) continue
        const proofRef = denials.get(normalizeDID(revoked.cascadedFrom ?? did)) ?? resetRef
        if (proofRef == null) throw new RevokeProofError('effects-mismatch')
        devices.set(did, {
          controller,
          status: 'revoked',
          proofRef,
          ...(value.op === 'reset' ? { reason: 'reset' as const } : {}),
          ...(revoked.cascadedFrom == null
            ? {}
            : { cascadedFrom: normalizeDID(revoked.cascadedFrom) }),
        })
      }
      for (const [did, proofRef] of denials) {
        const held = devices.get(did)
        if (held?.status === 'revoked' && !isResetOnly(held)) continue
        devices.set(did, { controller, status: 'revoked', proofRef })
      }
      const removedMembers = new Map(projection.removedMembers)
      for (const claim of value.effects ?? []) {
        if (claim.kind !== 'remove') continue
        removedMembers.set(claim.member.add, {
          did: normalizeDID(claim.member.did),
          gen: effect.genFloor,
          proofRef: claim.ref,
        })
      }
      for (const [add, member] of removedMembers) {
        if (!('event' in member.proofRef)) continue
        const index = memberDropIndices(controller, effect.recordedLog.chain, add).at(-1)
        if (index != null) removedMembers.set(add, { ...member, proofRef: { chainIndex: index } })
      }
      const survivorGrants = new Map(projection.survivorGrants)
      for (const raw of value.survivors ?? []) {
        survivorGrants.set(normalizeDID(readCapability(raw).payload.aud), raw)
      }
      controllers.set(controller, { ...projection, removedMembers, survivorGrants })
      for (const [did, held] of devices) {
        if (held.controller !== controller || held.proofRef == null || !('event' in held.proofRef))
          continue
        const index = revokeIndices(
          controller,
          effect.recordedLog.chain,
          held.cascadedFrom ?? did,
        ).at(-1)
        if (index != null) devices.set(did, { ...held, proofRef: { chainIndex: index } })
      }
    }
    return { devices, controllers }
  }
  switch (value.op) {
    case 'register':
    case 'add': {
      // Acceptance checks fresh evidence before reactivating a reset-only binding.
      if (existing?.status === 'revoked' && !isResetOnly(existing)) {
        return { devices, controllers }
      }
      // `controller` is structurally guaranteed present for register/add by isDeviceValue.
      const controller = normalizeDID(value.controller as string)
      devices.set(subject, {
        controller,
        status: 'active',
        ...(value.label !== undefined
          ? { label: value.label }
          : existing?.label !== undefined
            ? { label: existing.label }
            : {}),
      })
      return { devices, controllers }
    }
    case 'revoke': {
      if (existing == null) return { devices, controllers }
      const { reason: _reason, ...terminal } = existing
      devices.set(subject, { ...terminal, status: 'revoked' })
      return { devices, controllers }
    }
    case 'reset':
    case 'clock':
    case 'log':
    case 'seed':
      return { devices, controllers }
    case 'label': {
      if (existing == null) return { devices, controllers }
      devices.set(subject, {
        ...existing,
        ...(value.label !== undefined ? { label: value.label } : {}),
      })
      return { devices, controllers }
    }
    case 'beacon': {
      // Advisory, self-scoped: `subject` is the CONTROLLER DID. Last-write-wins; never touches
      // `devices` or the deny set, never gates validation. Guarded present by isDeviceValue.
      const previous = controllers.get(subject) ?? controllerProjection()
      controllers.set(subject, {
        ...previous,
        beacon: { logLength: value.logLength as number, headDigest: value.headDigest as string },
      })
      return { devices, controllers }
    }
  }
}

/** Only reset removal without a cascade permits a later admission. */
export function isResetOnly(record: DeviceRecord): boolean {
  return record.status === 'revoked' && record.reason === 'reset' && record.cascadedFrom == null
}

/** Structural admission exception. Callers still authenticate the capability and holder grant. */
export function mayReadmitResetDevice(
  registry: DeviceRegistry,
  parsed: MLSCredentialIdentity,
): boolean {
  const record = registry.devices.get(normalizeDID(parsed.id))
  const binding = parsed.controller
  if (
    record == null ||
    !isResetOnly(record) ||
    binding == null ||
    normalizeDID(binding.id) !== record.controller
  )
    return false
  const folded = foldChain(binding.id, binding.prefix)
  return (
    folded.ok &&
    (folded.states.at(-1)?.gen ?? 0) >= (registry.controllers.get(record.controller)?.genFloor ?? 0)
  )
}

/** The profile a device is bound to in the folded registry, or undefined — the authority input. */
export function controllerOf(registry: DeviceRegistry, deviceDID: string): string | undefined {
  return registry.devices.get(normalizeDID(deviceDID))?.controller
}

/** The advisory beacon a controller last announced, or undefined. Never a validation input. */
export function beaconOf(
  registry: DeviceRegistry,
  controllerDID: string,
): ControllerBeacon | undefined {
  return registry.controllers.get(normalizeDID(controllerDID))?.beacon
}

export function recordedLogOf(
  registry: DeviceRegistry,
  controller: string,
): ControllerLog | undefined {
  return registry.controllers.get(normalizeDID(controller))?.recordedLog
}

export function assertRetainsKnownEffects(
  controller: string,
  known: DeviceRegistry,
  candidate: DeviceRegistry,
): void {
  const did = normalizeDID(controller)
  const held = known.controllers.get(did)
  const offered = candidate.controllers.get(did)
  const before = held?.recordedLog == null ? undefined : foldControllerLog(did, held.recordedLog)
  const after =
    offered?.recordedLog == null ? undefined : foldControllerLog(did, offered.recordedLog)
  if (held?.recordedLog != null && offered?.recordedLog != null) {
    const branches = resolveBranches(did, [held.recordedLog.chain, offered.recordedLog.chain])
    if (!branches.ok) throw new RecoveryKnowledgeError('forked')
  }
  if (
    (offered?.timeFloor ?? 0) < (held?.timeFloor ?? 0) ||
    (offered?.genFloor ?? 0) < (held?.genFloor ?? 0)
  )
    throw new RecoveryKnowledgeError('floor')
  for (const [device, record] of known.devices) {
    if (record.controller !== did || record.status !== 'revoked' || isResetOnly(record)) continue
    const retained = candidate.devices.get(device)
    if (retained?.controller !== did || retained.status !== 'revoked' || isResetOnly(retained))
      throw new RecoveryKnowledgeError('revocation')
  }
  const resetPast = (generation: number): boolean =>
    after?.ok === true && after.head.gen > generation && (offered?.genFloor ?? 0) > generation
  for (const [add, member] of held?.removedMembers ?? []) {
    if (!offered?.removedMembers.has(add) && !resetPast(member.gen))
      throw new RecoveryKnowledgeError('removal')
  }
  if (before?.ok) {
    const retained = new Set(after?.ok ? after.applied : [])
    const settledAt = after?.ok
      ? after.states.findIndex((state) => state.digest === before.head.epoch)
      : -1
    const settled = after?.ok === true && settledAt >= 0 && settledAt < after.states.length - 1
    for (const event of before.applied) {
      if (!retained.has(event) && !settled && !resetPast(before.head.gen))
        throw new RecoveryKnowledgeError('epoch-event')
    }
  }
  if (after?.ok) {
    for (const member of after.head.members.values()) {
      if (
        member.effective &&
        (offered?.attestations.get(member.key) ?? 0) < (held?.attestations.get(member.key) ?? 0)
      )
        throw new RecoveryKnowledgeError('attestation')
    }
  }
}

export function registryForLog(controller: string, log: ControllerLog): DeviceRegistry {
  const { log: recordedLog, after } = ingestControllerLog(controller, undefined, log)
  const devices = new Map<string, DeviceRecord>()
  const projection = seedEffects(normalizeDID(controller), devices, {
    ...controllerProjection(),
    recordedLog,
    genFloor: after.head.gen,
  })
  return {
    devices,
    controllers: new Map([[normalizeDID(controller), projection]]),
  }
}

function seedEffects(
  controller: string,
  devices: Map<string, DeviceRecord>,
  projection: ControllerProjection & { recordedLog: ControllerLog },
): ControllerProjection & { recordedLog: ControllerLog } {
  const log = projection.recordedLog
  const folded = foldControllerLog(controller, log)
  if (!folded.ok) throw new RevokeProofError('effects-mismatch')
  const removedMembers = new Map(projection.removedMembers)
  for (const claim of claimsFor(controller, undefined, log, 0)) {
    if (claim.kind === 'deny') {
      devices.set(normalizeDID(claim.did), { controller, status: 'revoked', proofRef: claim.ref })
    } else {
      const ref = claim.ref
      const gen =
        'event' in ref
          ? log.events.find(({ event }) => digestOf(event) === ref.event)?.event.g
          : folded.states['chainIndex' in ref ? ref.chainIndex : ref.snapshot]?.gen
      if (gen == null) throw new RevokeProofError('no-rev')
      removedMembers.set(claim.member.add, {
        did: normalizeDID(claim.member.did),
        gen,
        proofRef: ref,
      })
    }
  }
  return { ...projection, removedMembers }
}

/**
 * The deny set Slice 1's seam consumes: the device DIDs at `status: 'revoked'` NOW. Matched, never
 * enumerated by consumers (`has`), holding device DIDs only, per the kokuin deny-set rule.
 */
export function denySetOf(registry: DeviceRegistry): ReadonlySet<string> {
  const denied = new Set<string>()
  for (const [did, record] of registry.devices) {
    if (record.status === 'revoked') denied.add(did)
  }
  return denied
}

/**
 * The universal rule: an ACTIVE binding resolves the issuer to its controller; anything else
 * resolves to the issuer itself. A revoked binding confers no authority until accepted re-entry.
 * Floating leaves and entries enacted while revoked cannot resolve to the former controller.
 * (Note the split:
 * {@link controllerOf} is the RAW lookup, deliberately status-blind, since the deviceRevoked event
 * emission and the revoke/label gate read the surviving binding of a just-revoked device.)
 */
export function authority(registry: DeviceRegistry, issuer: string): string {
  const norm = normalizeDID(issuer)
  const record = registry.devices.get(norm)
  return record != null && record.status === 'active' ? record.controller : norm
}

/**
 * Fold the whole control ledger into BOTH projections in one ordered pass, so a role entry's
 * authority resolves against the registry-so-far (device entries strictly earlier), never a
 * later binding. This is the determinism-preserving replacement for driving two independent
 * per-type folds: {@link foldLedger}'s own doc warns that a reducer whose authority reads another
 * entry type cannot be driven by a per-type applier — the roster reducer now reads the registry,
 * so both advance together here.
 *
 * A `kumiai.device` entry updates the registry (trusted — proofs are the pipeline's gate). A
 * `kumiai.role` entry is authorized by `roster.roles.get(authority(registry, issuer)) === 'admin'`
 * and must not empty the admin set. Every other type, a groupID mismatch, or a malformed value is
 * dropped (never thrown), routed through `onDrop` exactly as {@link foldRoster}.
 */
export function foldControl(
  entries: Array<FoldInput>,
  anchor: GroupAnchor,
  groupID: string,
  onDrop?: (drop: FoldDrop) => void,
): { roster: RosterState; registry: DeviceRegistry } {
  let roster = roleReducer.seed(anchor)
  let registry = registrySeed()
  for (const [position, { verified, entryID }] of entries.entries()) {
    const { entry, issuer } = verified
    if (entry.groupID !== groupID) {
      onDrop?.({ entryID, type: entry.type, reason: `cross-group entry for '${groupID}'` })
      continue
    }
    if (entry.type === DEVICE_ENTRY_TYPE) {
      if (!isDeviceValue(entry.value)) {
        onDrop?.({ entryID, type: entry.type, reason: 'malformed kumiai.device value' })
        continue
      }
      if (anchor.controller != null && !isLifecycleDeviceValue(entry.value)) {
        onDrop?.({
          entryID,
          type: entry.type,
          reason: 'device operation is not allowed in a lifecycle group',
        })
        continue
      }
      try {
        if (entry.value.op === 'seed' && position !== 0) throw new RevokeProofError('detached')
        registry = registryApply(
          { issuer, entry: { ...entry, value: entry.value } },
          registry,
          anchor.controller,
        )
      } catch {
        onDrop?.({ entryID, type: entry.type, reason: 'invalid lifecycle proof' })
      }
      continue
    }
    if (anchor.controller != null || entry.type !== ROLE_ENTRY_TYPE) {
      onDrop?.({ entryID, type: entry.type, reason: `unrelated type '${entry.type}'` })
      continue
    }
    if (entry.value !== 'admin' && entry.value !== 'member') {
      onDrop?.({ entryID, type: entry.type, reason: 'invalid role value' })
      continue
    }
    const auth = authority(registry, issuer)
    if (roster.roles.get(auth) !== 'admin') {
      onDrop?.({
        entryID,
        type: entry.type,
        reason: `authority '${auth}' of issuer '${normalizeDID(issuer)}' is not admin`,
      })
      continue
    }
    const next = roleReducer.apply(
      { issuer, entry: { ...entry, value: entry.value as RoleValue } },
      roster,
    )
    if (adminCount(next) === 0) {
      onDrop?.({ entryID, type: entry.type, reason: 'would empty the admin set' })
      continue
    }
    roster = next
  }
  return { roster, registry }
}

/** A ledger revocation, independent of the controller's current log deny set. */
export function revocationOf(group: GroupHandle, did: string): Revocation | null {
  const record = group.registry.devices.get(normalizeDID(did))
  if (record?.status !== 'revoked' || record.proofRef === undefined) return null
  return {
    controller: record.controller,
    proofRef: record.proofRef,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ...(record.cascadedFrom === undefined ? {} : { cascadedFrom: record.cascadedFrom }),
  }
}
