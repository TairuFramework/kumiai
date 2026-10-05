import {
  didFromInception,
  foldLog,
  type InceptionEvent,
  type SignedEvent,
} from '@kokuin/controller'
import { normalizeDID } from '@kokuin/token'

import { readCapability } from './capability.js'
import { RevokeProofError } from './errors.js'
import type { GroupHandle } from './group-handle.js'
import { controllerLogSize, HISTORY_HORIZON, historySize } from './history.js'
import type { VerifiedLedgerEntry } from './ledger.js'
import type { DeviceRegistry, DeviceValue, RevokedEffect } from './registry.js'

export { controllerLogSize, HISTORY_HORIZON } from './history.js'

/** Derived from a proof and the pre-commit tree; proposal comparison belongs to the commit gate. */
export type LifecycleProofEffects = {
  controller: string
  recordedLog: Array<SignedEvent>
  genFloor: number
  timeFloor: number
  logPosition?: number
  revoked: Array<RevokedEffect>
  removeLeafIndices: Array<number>
}

type AuthenticatedProof = {
  recordedLog: Array<SignedEvent>
  genFloor: number
  logPosition: number
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
  const recorded = previous?.recordedLog ?? []
  const floor = previous?.genFloor ?? 0
  if (
    (value.controller != null && normalizeDID(value.controller) !== controller) ||
    (value.op === 'reset' && subject !== controller)
  )
    throw new RevokeProofError('wrong-controller')
  const proof = value.proof
  if (!Array.isArray(proof)) throw new RevokeProofError('no-rev')
  if (recorded.length === 0 && proof.length === 0) throw new RevokeProofError('no-rev')
  for (const signed of proof) {
    const event = signed?.event
    if (event == null || (event.t !== 'icp' && event.t !== 'rot' && event.t !== 'rev')) {
      throw new RevokeProofError('not-authority-signed')
    }
    if ('cap' in event && event.cap != null) throw new RevokeProofError('not-authority-signed')
    if (event.t === 'icp') {
      let inceptionDID: string
      try {
        inceptionDID = didFromInception(event as InceptionEvent)
      } catch (cause) {
        const rejection = new RevokeProofError('not-authority-signed')
        rejection.cause = cause
        throw rejection
      }
      if (normalizeDID(inceptionDID) !== controller) throw new RevokeProofError('wrong-controller')
    } else if (event.i !== controller) {
      throw new RevokeProofError('wrong-controller')
    }
  }
  // An old full chain must report the floor even though it cannot attach after a reset.
  if (proof.length > 0 && proof.every(({ event }) => event.g < floor)) {
    throw new RevokeProofError('generation-floor')
  }
  if (value.op === 'revoke' && recorded.length > 0 && proof[0]?.event.t === 'icp') {
    throw new RevokeProofError('detached')
  }
  if (value.op === 'revoke' && recorded.length > 0) {
    const generation = recorded.at(-1)?.event.g ?? 0
    if (proof.some(({ event }) => event.g > generation)) throw new RevokeProofError('needs-reset')
  }
  const log = value.op === 'reset' ? proof : [...recorded, ...proof]
  const folded = foldLog(controller, log)
  if (!folded.ok) {
    const detached =
      folded.reason.includes('sequence') ||
      folded.reason.includes('digest') ||
      folded.reason.includes('prior') ||
      folded.reason.includes('inception must')
    throw new RevokeProofError(detached ? 'detached' : 'not-authority-signed')
  }
  for (let index = 1; index < folded.states.length; index++) {
    if (folded.states[index]?.digest === folded.states[index - 1]?.digest) {
      throw new RevokeProofError('not-authority-signed')
    }
  }
  if (value.op === 'reset') {
    let position = -1
    for (let index = 1; index < log.length; index++) {
      if (log[index]?.event.g !== log[index - 1]?.event.g) position = index
    }
    const generation = folded.states[position]?.gen
    if (generation == null) throw new RevokeProofError('no-rev')
    if (generation <= floor) throw new RevokeProofError('generation-floor')
    return { recordedLog: [...log], genFloor: generation, logPosition: position }
  }
  let belowFloor = false
  for (let index = 0; index < log.length; index++) {
    const event = log[index]?.event
    const state = folded.states[index]
    if (event?.t !== 'rev' || !('x' in event) || typeof event.x !== 'string' || state == null)
      continue
    if (normalizeDID(event.x) !== subject) continue
    if (![...state.deny].some((did) => normalizeDID(did) === subject)) continue
    if (state.gen < floor) {
      belowFloor = true
      continue
    }
    return { recordedLog: [...log], genFloor: floor, logPosition: index }
  }
  throw new RevokeProofError(belowFloor ? 'generation-floor' : 'no-rev')
}

/** Verify live effects while all leaves still describe the epoch before the commit. */
export async function verifyLifecycleProof(
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
    const capability = binding?.capability == null ? undefined : readCapability(binding.capability)
    const parent = capability?.payload.cap
    const parentRaw = Array.isArray(parent) ? parent[0] : parent
    const issuer =
      parentRaw == null || capability == null ? undefined : normalizeDID(capability.payload.iss)
    const attested =
      parentRaw == null ? capability?.payload.iat : readCapability(parentRaw).payload.iat
    const folded = binding?.prefix == null ? undefined : foldLog(controller, binding.prefix)
    return {
      did: normalizeDID(member.id),
      leafIndex: member.leafIndex,
      issuer,
      generation: folded?.ok ? folded.states.at(-1)?.gen : undefined,
      attested:
        binding?.controller != null && normalizeDID(binding.controller) === controller
          ? attested
          : undefined,
      prefix: binding?.prefix ?? [],
    }
  })
  const timeFloor = previous?.timeFloor ?? 0
  if (value.op === 'clock') {
    const treeTime = Math.max(timeFloor, ...leaves.map((leaf) => leaf.attested ?? 0))
    if (subject !== controller) throw new RevokeProofError('wrong-controller')
    if (
      value.time == null ||
      !Number.isFinite(value.time) ||
      value.time <= timeFloor ||
      value.time > treeTime
    ) {
      throw new RevokeProofError('effects-mismatch')
    }
    return {
      controller,
      recordedLog: previous?.recordedLog ?? [],
      genFloor: previous?.genFloor ?? 0,
      timeFloor: value.time,
      revoked: [],
      removeLeafIndices: [],
    }
  }
  const authenticated = authenticateLifecycleProof(controller, verified, group.registry)
  const revoked: Array<RevokedEffect> = []
  if (value.op === 'revoke') {
    if (group.registry.devices.get(subject)?.status === 'revoked')
      throw new RevokeProofError('effects-mismatch')
    revoked.push({ did: subject })
  } else if (value.op === 'reset') {
    for (const leaf of leaves) {
      if (leaf.generation != null && leaf.generation < authenticated.genFloor)
        revoked.push({ did: leaf.did })
    }
  } else {
    throw new RevokeProofError('no-rev')
  }
  const direct = new Set(revoked.map(({ did }) => did))
  for (const leaf of leaves) {
    if (leaf.issuer != null && direct.has(leaf.issuer) && !direct.has(leaf.did)) {
      revoked.push({ did: leaf.did, cascadedFrom: leaf.issuer })
    }
  }
  if (
    value.revoked?.length !== revoked.length ||
    revoked.some((effect, index) => {
      const declared = value.revoked?.[index]
      return (
        declared == null ||
        normalizeDID(declared.did) !== effect.did ||
        (declared.cascadedFrom == null ? undefined : normalizeDID(declared.cascadedFrom)) !==
          effect.cascadedFrom
      )
    })
  )
    throw new RevokeProofError('effects-mismatch')
  const affected = new Set(revoked.map(({ did }) => did))
  const removed = leaves.filter(({ did }) => affected.has(did))
  const before = historySize(
    group.state.ratchetTree,
    group.ledger.map(({ verified }) => verified),
  )
  const after =
    before +
    controllerLogSize(value.proof ?? []) -
    removed.reduce((size, leaf) => size + controllerLogSize(leaf.prefix), 0)
  if (after > HISTORY_HORIZON && after > before) throw new RevokeProofError('too-large')
  return {
    controller,
    ...authenticated,
    timeFloor,
    revoked,
    removeLeafIndices: removed.map(({ leafIndex }) => leafIndex),
  }
}
