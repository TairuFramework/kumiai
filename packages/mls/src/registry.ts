import { normalizeDID } from '@kokuin/token'

import type { GroupAnchor } from './anchor.js'
import type { FoldDrop, FoldInput } from './fold.js'
import type { VerifiedLedgerEntry } from './ledger.js'
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
export type DeviceOp = 'register' | 'add' | 'revoke' | 'label' | 'beacon'

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
  /** Beacon only: the length of the controller's FULL log at announcement time. */
  logLength?: number
  /** Beacon only: the head digest of the controller's FULL log at announcement time. */
  headDigest?: string
}

/** A folded device binding. `controller` is the profile DID; `status` gates the deny set. */
export type DeviceRecord = { controller: string; status: 'active' | 'revoked'; label?: string }

/** An advisory pointer to a controller's FULL log head. Never a validation input. */
export type ControllerBeacon = { logLength: number; headDigest: string }

/**
 * The group-folded device registry: `device DID -> record`, keyed by normalized DID. A pure
 * function of the accepted `kumiai.device` entries, folded beside {@link RosterState}. Two views
 * derive from `devices` and are never stored: {@link controllerOf} and {@link denySetOf}.
 * `controllers` is a second, independent per-controller projection fed by the `beacon` op.
 */
export type DeviceRegistry = {
  devices: ReadonlyMap<string, DeviceRecord>
  controllers: ReadonlyMap<string, ControllerBeacon>
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
    v.op !== 'beacon'
  ) {
    return false
  }
  if ((v.op === 'register' || v.op === 'add') && typeof v.controller !== 'string') return false
  if (v.op === 'beacon' && (typeof v.logLength !== 'number' || typeof v.headDigest !== 'string')) {
    return false
  }
  if (v.label !== undefined && typeof v.label !== 'string') return false
  if (v.controller !== undefined && typeof v.controller !== 'string') return false
  if (v.capability !== undefined && typeof v.capability !== 'string') return false
  if (v.logLength !== undefined && typeof v.logLength !== 'number') return false
  if (v.headDigest !== undefined && typeof v.headDigest !== 'string') return false
  return true
}

/**
 * The registry fold step. Pure, order-dependent, authorization-free — a device entry's authority
 * is the acceptance pipeline's job (a self-register leaf attestation, or a management capability),
 * never the fold's. On the trusted fold path a revoke/label always concerns a subject a prior
 * register bound, so an absent subject is a no-op guard rather than a real case.
 */
export function registryApply(
  verified: VerifiedLedgerEntry<DeviceValue>,
  state: DeviceRegistry,
): DeviceRegistry {
  const subject = normalizeDID(verified.entry.subject)
  const value = verified.entry.value
  const devices = new Map(state.devices)
  const controllers = new Map(state.controllers)
  const existing = devices.get(subject)
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
      controllers.set(subject, {
        logLength: value.logLength as number,
        headDigest: value.headDigest as string,
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
  return registry.controllers.get(normalizeDID(controllerDID))
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

/** The universal rule: `authority(issuer) = controllerOf(issuer) ?? issuer`, both normalized. */
export function authority(registry: DeviceRegistry, issuer: string): string {
  const norm = normalizeDID(issuer)
  return controllerOf(registry, norm) ?? norm
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
      registry = registryApply({ issuer, entry: { ...entry, value: entry.value } }, registry)
      continue
    }
    if (entry.type !== ROLE_ENTRY_TYPE) {
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
