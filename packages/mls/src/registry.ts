import type { SignedEvent } from '@kokuin/controller'
import { normalizeDID } from '@kokuin/token'

import type { GroupAnchor } from './anchor.js'
import type { FoldDrop, FoldInput } from './fold.js'
import type { GroupHandle } from './group-handle.js'
import type { VerifiedLedgerEntry } from './ledger.js'
import { authenticateLifecycleProof } from './lifecycle-proof.js'
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
export type DeviceOp = 'register' | 'add' | 'revoke' | 'label' | 'beacon' | 'reset' | 'clock'

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
  proof?: Array<SignedEvent>
  revoked?: Array<RevokedEffect>
  time?: number
  /** Beacon only: the length of the controller's FULL log at announcement time. */
  logLength?: number
  /** Beacon only: the head digest of the controller's FULL log at announcement time. */
  headDigest?: string
}

export type RevokedEffect = { did: string; cascadedFrom?: string }

export type Revocation = {
  controller: string
  logPosition: number
  reason?: 'reset'
  cascadedFrom?: string
}

/** A folded device binding or permanent revocation. */
export type DeviceRecord = {
  controller: string
  status: 'active' | 'revoked'
  label?: string
  logPosition?: number
  reason?: 'reset'
  cascadedFrom?: string
}

export type ControllerProjection = {
  recordedLog: Array<SignedEvent>
  genFloor: number
  timeFloor: number
  beacon?: ControllerBeacon
}

export function controllerProjection(): ControllerProjection {
  return { recordedLog: [], genFloor: 0, timeFloor: 0 }
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
    v.op !== 'clock'
  ) {
    return false
  }
  const proofBearing = v.op === 'reset' || (v.op === 'revoke' && v.proof !== undefined)
  if (!proofBearing && ('proof' in v || 'revoked' in v)) return false
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
  if (v.proof !== undefined && !Array.isArray(v.proof)) return false
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
  if (
    (v.op === 'reset' || v.proof !== undefined) &&
    (!Array.isArray(v.proof) || !Array.isArray(v.revoked))
  )
    return false
  return true
}

export function isLifecycleDeviceValue(value: DeviceValue): boolean {
  if (!isDeviceValue(value)) return false
  return (
    value.op === 'beacon' ||
    value.op === 'clock' ||
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
    (value.op === 'reset' || value.op === 'revoke' || value.op === 'clock')
  ) {
    const controller = normalizeDID(controllerID)
    const previous = controllers.get(controller) ?? controllerProjection()
    if (value.op === 'clock') {
      controllers.set(controller, {
        ...previous,
        timeFloor: Math.max(previous.timeFloor, value.time as number),
      })
    } else {
      const effect = authenticateLifecycleProof(controller, verified, state)
      controllers.set(controller, {
        ...previous,
        recordedLog: effect.recordedLog,
        genFloor: effect.genFloor,
      })
      for (const revoked of value.revoked ?? []) {
        const did = normalizeDID(revoked.did)
        if (devices.get(did)?.status === 'revoked') continue
        devices.set(did, {
          controller,
          status: 'revoked',
          logPosition: effect.logPosition,
          ...(value.op === 'reset' ? { reason: 'reset' } : {}),
          ...(revoked.cascadedFrom == null
            ? {}
            : { cascadedFrom: normalizeDID(revoked.cascadedFrom) }),
        })
      }
    }
    return { devices, controllers }
  }
  switch (value.op) {
    case 'register':
    case 'add': {
      // Terminal revocation: once a subject is revoked, no later register/add re-activates it. The
      // fold only ever subtracts authority — to re-authorize a device, a fresh device DID is minted.
      // The record is left frozen at 'revoked' (the acceptance gate still verified the entry, but the
      // fold does not resurrect a revoked binding). Keeps determinism: every member applies this rule.
      if (existing?.status === 'revoked') {
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
      devices.set(subject, { ...existing, status: 'revoked' })
      return { devices, controllers }
    }
    case 'reset':
    case 'clock':
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
 * resolves to the issuer itself. A revoked binding confers no authority — terminal revocation only
 * ever subtracts — so a revoked device re-entering as a floating leaf, or a role entry it signed
 * before revocation but enacted after, must not resolve to its former controller. (Note the split:
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
  for (const { verified, entryID } of entries) {
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

/** A permanent ledger revocation, independent of the controller's current log deny set. */
export function revocationOf(group: GroupHandle, did: string): Revocation | null {
  const record = group.registry.devices.get(normalizeDID(did))
  if (record?.status !== 'revoked' || record.logPosition === undefined) return null
  return {
    controller: record.controller,
    logPosition: record.logPosition,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ...(record.cascadedFrom === undefined ? {} : { cascadedFrom: record.cascadedFrom }),
  }
}
