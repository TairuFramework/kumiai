import {
  commitKeyRotation,
  encodeClientState,
  type GroupHandle,
  GroupRestoreError as InvalidCandidateError,
  type MemberCredential,
} from '@kumiai/mls'
import {
  controlSafetyHeld,
  digestAppliedCommit,
  type HostBuilt,
  INTERNAL_OPERATION_PREFIX,
  type InternalOperations,
  type Operation,
  OperationRejectedError,
  type OperationRequest,
  type Outcome,
  type SendAdmission,
} from '@kumiai/rpc'
import { sha256 } from '@noble/hashes/sha2.js'

import { sameStoredValue } from './memory-incarnation-stores.js'
import { decodeStoredValue, encodeStoredValue } from './persistence-codec.js'
import type { EpochIdentity } from './persistence-types.js'
import type { RegistryHandleAccess } from './registry/types.js'

export type AutoRotationCandidate = {
  state: Uint8Array
  credential: MemberCredential
  ledger: Array<string>
}

/** Candidate adapters accept this envelope alongside their own host journal formats. */
export function decodeAutoRotationCandidate(bytes: Uint8Array): AutoRotationCandidate {
  try {
    const value = decodeStoredValue(bytes) as Partial<AutoRotationCandidate> | null
    if (
      value === null ||
      typeof value !== 'object' ||
      !(value.state instanceof Uint8Array) ||
      typeof value.credential?.id !== 'string' ||
      value.credential.id.length === 0 ||
      typeof value.credential.groupID !== 'string' ||
      value.credential.groupID.length === 0 ||
      !Array.isArray(value.ledger) ||
      !value.ledger.every((entry) => typeof entry === 'string')
    )
      throw new TypeError('Invalid rotation candidate envelope')
    return value as AutoRotationCandidate
  } catch (cause) {
    throw new InvalidCandidateError('Invalid rotation candidate envelope', { cause })
  }
}

export function autoRotationRequest(identity: EpochIdentity): OperationRequest {
  const body = encodeStoredValue({
    groupID: identity.groupID,
    incarnation: identity.incarnation,
    epoch: identity.epoch,
    authenticator: identity.authenticator,
  })
  const digest = Array.from(sha256(body).subarray(0, 16), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  return {
    id: `${INTERNAL_OPERATION_PREFIX}rotation/${digest}`,
    kind: 'rotation',
    revokes: false,
    body,
  }
}

export function isAutoRotation(op: Pick<OperationRequest, 'id'>): boolean {
  return op.id.startsWith(`${INTERNAL_OPERATION_PREFIX}rotation/`)
}

/** The independent memory author uses these same pre-authoring refusals. */
export function assertAutoRotation(op: OperationRequest, group: GroupHandle): EpochIdentity {
  const identity = decodeStoredValue(op.body) as EpochIdentity
  if (
    op.kind !== 'rotation' ||
    op.revokes ||
    !sameStoredValue(autoRotationRequest(identity), {
      id: op.id,
      kind: op.kind,
      revokes: op.revokes,
      body: op.body,
    }) ||
    identity.groupID !== group.groupID ||
    identity.epoch !== Number(group.epoch) ||
    !sameStoredValue(identity.authenticator, group.state.keySchedule.epochAuthenticator)
  )
    throw new OperationRejectedError('Rotation identity superseded')
  if (Object.keys(group.state.unappliedProposals).length !== 0)
    throw new OperationRejectedError('Rotation refuses pending proposals')
  if (group.state.groupActiveState.kind !== 'active')
    throw new OperationRejectedError('Rotation requires an active group')
  const admission: SendAdmission = group.sendAdmission()
  if (!admission.admissible && admission.reason !== 'rotation-required')
    throw new OperationRejectedError('Rotation is not admissible')
  return identity
}

export async function buildKeyRotation(op: Operation, group: GroupHandle): Promise<HostBuilt> {
  const identity = assertAutoRotation(op, group)
  const built = await commitKeyRotation(group)
  return {
    commit: built.commitMessage,
    bodies: [],
    journal: encodeStoredValue({
      state: encodeClientState(built.newGroup.state),
      credential: built.newGroup.credential,
      ledger: built.newGroup.ledgerTokens,
    }),
    welcome: null,
    incarnation: identity.incarnation,
    epoch: identity.epoch,
    authenticatorBefore: identity.authenticator.slice(),
    digest: digestAppliedCommit(built.commitMessage),
  }
}

export function createAutoRotationScheduler(params: {
  access: RegistryHandleAccess
}): InternalOperations & { stop(): void } {
  const { access } = params
  let stopped = false
  let enqueue: ((request: OperationRequest) => Promise<void>) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let again = false
  let liveID: string | null = null
  let backoff = 250
  let notBefore = 0
  let eligibility: Uint8Array | null = null
  const schedule = (delay: number): void => {
    if (stopped || enqueue === undefined) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void step()
    }, delay)
  }
  const failed = (): void => {
    notBefore = Date.now() + backoff
    backoff = Math.min(backoff * 2, 15_000)
  }
  const step = async (): Promise<void> => {
    if (stopped || enqueue === undefined) return
    if (running) {
      again = true
      return
    }
    running = true
    let active = false
    try {
      const identity = access.runtime.snapshot()
      const admission = access.admission()
      if (
        identity === null ||
        !identity.available ||
        admission.admissible ||
        admission.reason !== 'rotation-required'
      )
        return
      active = true
      const request = autoRotationRequest(identity)
      const captured = await access.readControl(async (scope) => ({
        snapshot: await scope.loadControl(),
        eligibility: encodeStoredValue({
          id: request.id,
          available: identity.available,
          condition: identity.condition ?? null,
          members: [...identity.members].sort(),
          proposals: scope.handle.state.unappliedProposals,
          active: scope.handle.state.groupActiveState.kind,
          admission: scope.handle.sendAdmission(),
        }),
      }))
      const { snapshot } = captured
      if (!sameStoredValue(eligibility, captured.eligibility)) {
        eligibility = captured.eligibility
        backoff = 250
        notBefore = 0
        liveID = null
      }
      if (Date.now() < notBefore) return
      const current = access.runtime.snapshot()
      const freshAdmission = access.admission()
      if (
        stopped ||
        current === null ||
        !current.available ||
        autoRotationRequest(current).id !== request.id ||
        freshAdmission.admissible ||
        freshAdmission.reason !== 'rotation-required'
      )
        return
      if (
        controlSafetyHeld(snapshot) !== null ||
        snapshot.controlHold !== null ||
        snapshot.rejoin !== null ||
        snapshot.commitOnce !== null ||
        snapshot.operations.length !== 0 ||
        snapshot.spentSource?.epoch === identity.epoch
      )
        return
      if (liveID === request.id) return
      liveID = request.id
      try {
        await enqueue(request)
      } catch {
        liveID = null
        failed()
      }
    } catch {
      failed()
      active = true
    } finally {
      running = false
      if (!stopped) {
        if (again) {
          again = false
          schedule(0)
        } else if (active) schedule(notBefore > Date.now() ? notBefore - Date.now() : 15_000)
      }
    }
  }
  const changed = (): void => {
    liveID = null
    backoff = 250
    notBefore = 0
    schedule(0)
  }
  const unsubscribers = [
    access.onRotationRequired(changed),
    access.onAdmissionChanged(changed),
    // State-version churn from our own control work must not reset rejected backoff.
    access.runtime.onEpochChanged(() => schedule(0)),
  ]
  return {
    bind(capability) {
      enqueue = capability.enqueue
      schedule(0)
    },
    onOutcome(outcome: Outcome) {
      if (!outcome.opID?.startsWith(`${INTERNAL_OPERATION_PREFIX}rotation/`)) return
      liveID = null
      if (outcome.kind === 'rejected' && outcome.reason === 'Rotation identity superseded') {
        backoff = 250
        notBefore = 0
      } else if (outcome.kind === 'rejected') failed()
      else if (outcome.kind === 'unknown') notBefore = Date.now() + 15_000
      schedule(Math.max(0, notBefore - Date.now()))
    },
    stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      for (const unsubscribe of unsubscribers) unsubscribe()
    },
  }
}
