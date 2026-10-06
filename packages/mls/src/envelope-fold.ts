import { normalizeDID } from '@kokuin/token'

import { RevokeProofError } from './errors.js'
import type { FoldInput } from './fold.js'
import type { VerifiedLedgerEntry } from './ledger.js'
import {
  authority,
  DEVICE_ENTRY_TYPE,
  type DeviceRegistry,
  type DeviceValue,
  isDeviceValue,
  isLifecycleDeviceValue,
  registryApply,
} from './registry.js'
import {
  adminCount,
  type GroupPermission,
  ROLE_ENTRY_TYPE,
  type RoleValue,
  type RosterState,
  roleReducer,
} from './roster.js'

/**
 * The outcome of folding an envelope's control entries. On accept: the candidate
 * roster (base ∪ this envelope's kumiai.role entries), the candidate registry (base ∪
 * this envelope's kumiai.device entries), and the non-group entries to surface to the
 * consumer, in envelope order. On reject: a reason and the offending entry id. A
 * rejection is a value — the caller turns it into a commit rejection.
 */
export type EnvelopeFoldResult =
  | {
      ok: true
      roster: RosterState
      registry: DeviceRegistry
      surfaced: Array<VerifiedLedgerEntry>
    }
  | { ok: false; reason: string; entryID: string; error?: RevokeProofError }

export const GROUP_TYPE_PREFIX = 'kumiai.'

/** Present for a lifecycle group: consumer entries must come from a controller-bound leaf. */
export type FoldEnvelopeContext = {
  controllerID: string
  /** The controller bound to the issuer's pre-commit leaf, if any. */
  memberController: (did: string) => string | undefined
}

export type FoldEnvelopeParams = {
  baseRoster: RosterState
  baseRegistry: DeviceRegistry
  entries: Array<FoldInput>
  groupID: string
  context?: FoldEnvelopeContext
}

function isRoleValue(value: unknown): value is GroupPermission {
  return value === 'admin' || value === 'member'
}

/**
 * Fold an envelope's verified entries against a base roster, enforcing that every
 * entry is admin-authored in state-so-far. Pure, never throws.
 *
 * The strict, commit-side counterpart to {@link foldRoster}: where the roster fold
 * silently drops an unauthorized or unrelated entry (correct for hostile ingest),
 * a commit envelope must reject the moment anything is off, so `ledger_head` never
 * covers an entry the ledger does not hold.
 *
 * One pass, one rule. `baseRoster` is the state folded from the ledger the handle
 * already holds; this reasons only about *this* envelope's new entries, using it as
 * the starting state-so-far and mutating a copy as `kumiai.role` entries apply. Every
 * entry's issuer must be an admin at its own position — the universal invariant that
 * subsumes `kumiai.role`'s own authority rule. State-so-far, not a pre-commit
 * snapshot, so an envelope of `[promote Bob, entry-issued-by-Bob]` is accepted.
 */
export function foldEnvelope(params: FoldEnvelopeParams): EnvelopeFoldResult {
  const { baseRoster, baseRegistry, entries, groupID, context } = params
  let workingRoster: RosterState = { roles: new Map(baseRoster.roles) }
  let workingRegistry: DeviceRegistry = {
    devices: new Map(baseRegistry.devices),
    controllers: new Map(baseRegistry.controllers),
  }
  const surfaced: Array<VerifiedLedgerEntry> = []

  for (const { verified, entryID } of entries) {
    const { entry, issuer } = verified

    // An entry signed for another group is a replay, even though it verified.
    if (entry.groupID !== groupID) {
      return { ok: false, reason: 'cross-group entry', entryID }
    }

    // The typed exception to the admin invariant: a device entry is authorized by a proof in the
    // acceptance pipeline, not a roster role. The fold applies it structurally and threads the
    // registry that later authority checks read.
    if (entry.type === DEVICE_ENTRY_TYPE) {
      if (!isDeviceValue(entry.value)) {
        return { ok: false, reason: 'malformed kumiai.device value', entryID }
      }
      const value: DeviceValue = entry.value
      if (
        context != null
          ? !isLifecycleDeviceValue(value)
          : value.op === 'reset' || value.op === 'clock' || value.proof !== undefined
      ) {
        return { ok: false, reason: 'device operation is not allowed in this group', entryID }
      }
      try {
        workingRegistry = registryApply(
          { issuer, entry: { ...entry, value } },
          workingRegistry,
          context?.controllerID,
        )
      } catch (error) {
        return {
          ok: false,
          reason: 'invalid lifecycle proof',
          entryID,
          ...(error instanceof RevokeProofError ? { error } : {}),
        }
      }
      continue
    }

    if (context != null) {
      if (entry.type.startsWith(GROUP_TYPE_PREFIX)) {
        return { ok: false, reason: 'reserved lifecycle entry type', entryID }
      }
      const bound = context.memberController(normalizeDID(issuer))
      if (bound == null || normalizeDID(bound) !== normalizeDID(context.controllerID)) {
        return { ok: false, reason: 'issuer has no pre-commit controller-bound leaf', entryID }
      }
      surfaced.push(verified)
      continue
    }

    // The universal invariant, now authority-aware: the issuer's AUTHORITY (controller ?? id,
    // read off the registry-so-far) must be an admin in state-so-far.
    if (workingRoster.roles.get(authority(workingRegistry, issuer)) !== 'admin') {
      return { ok: false, reason: `non-admin issuer '${issuer}'`, entryID }
    }

    if (entry.type === ROLE_ENTRY_TYPE) {
      if (!isRoleValue(entry.value)) {
        return { ok: false, reason: 'invalid role value', entryID }
      }
      const roleEntry: VerifiedLedgerEntry<RoleValue> = {
        issuer,
        entry: { ...entry, value: entry.value },
      }
      workingRoster = roleReducer.apply(roleEntry, workingRoster)
      // A group with zero admins can never again add, remove, promote, or demote.
      if (adminCount(workingRoster) === 0) {
        return { ok: false, reason: 'would empty the admin set', entryID }
      }
      continue
    }

    // `kumiai.*` is reserved for @kumiai/mls; an unknown one fails closed.
    if (entry.type.startsWith(GROUP_TYPE_PREFIX)) {
      return { ok: false, reason: 'unknown kumiai.* type', entryID }
    }

    // Notarized (verified, admin-authored, group-scoped) and handed on unread.
    surfaced.push(verified)
  }

  return { ok: true, roster: workingRoster, registry: workingRegistry, surfaced }
}
