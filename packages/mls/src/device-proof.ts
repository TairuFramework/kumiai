import type { SignedEvent } from '@kokuin/controller'
import { normalizeDID } from '@kokuin/token'

import { verifyManagementCapability } from './authentication.js'
import type { VerifiedLedgerEntry } from './ledger.js'
import type { DeviceValue } from './registry.js'

/** What the tree yields about a leaf for the device-proof gate: its binding, prefix, and leaf key. */
export type LeafBinding = {
  /** The bound profile DID, or undefined for a floating leaf. */
  controller?: string
  /** The embedded controller log prefix (present iff bound), for resolving a capability signature. */
  prefix?: Array<SignedEvent>
  /** The leaf's MLS signature public key. */
  leafKey: Uint8Array
}

/** The pure inputs the gate reads: leaf bindings (from the pre-commit tree) and controllerOf. */
export type DeviceProofContext = {
  bindingOfDID: (did: string) => LeafBinding | undefined
  controllerOf: (deviceDID: string) => string | undefined
}

/**
 * The acceptance-pipeline gate for one `kumiai.device` entry. Returns whether the entry is
 * authorized; the caller rejects the WHOLE commit on any false.
 *
 * - beacon (`op: 'beacon'`): the issuer must be a bound device of the controller named as
 *   `subject`. Advisory and self-scoped — no capability.
 * - self-register (`op: 'register'`, `subject === issuer`): the issuer's own leaf must be bound to
 *   `value.controller`. Leaf-attested — no capability.
 * - manage ops (co-device register, add, revoke, label): the issuer must be a bound device of the
 *   authorized profile (`value.controller` for register/add, `controllerOf(subject)` for
 *   revoke/label), presenting that profile's management capability, `cnf`-pinned to the issuer's
 *   leaf key and `exp`-bounded. The profile's log prefix comes from the issuer's OWN bound leaf.
 *
 * Pure of the fold — runs only where the tree is present (never on a bootstrap re-fold).
 */
export async function verifyDeviceEntry(
  verified: VerifiedLedgerEntry<DeviceValue>,
  ctx: DeviceProofContext,
): Promise<boolean> {
  const issuer = normalizeDID(verified.issuer)
  const subject = normalizeDID(verified.entry.subject)
  const value = verified.entry.value

  if (value.op === 'beacon') {
    // Self-scoped, low-stakes: the issuer must be a bound device of the controller named as
    // `subject`. Advisory state that gates nothing, so NO management capability is required —
    // unlike revoke/label, which manage another device's binding.
    const binding = ctx.bindingOfDID(issuer)
    if (binding?.controller == null) return false
    return normalizeDID(binding.controller) === subject
  }

  if (value.op === 'register' && subject === issuer) {
    const binding = ctx.bindingOfDID(issuer)
    if (binding?.controller == null || value.controller == null) return false
    return normalizeDID(binding.controller) === normalizeDID(value.controller)
  }

  const authorizedProfile =
    value.op === 'register' || value.op === 'add'
      ? value.controller == null
        ? undefined
        : normalizeDID(value.controller)
      : ctx.controllerOf(subject) // revoke / label — the registry already binds the subject
  if (authorizedProfile == null) return false

  const binding = ctx.bindingOfDID(issuer)
  if (binding?.controller == null || binding.prefix == null) return false
  if (normalizeDID(binding.controller) !== authorizedProfile) return false

  return await verifyManagementCapability({
    capability: value.capability,
    prefix: binding.prefix,
    controllerID: authorizedProfile,
    audience: issuer,
    leafKey: binding.leafKey,
  })
}
