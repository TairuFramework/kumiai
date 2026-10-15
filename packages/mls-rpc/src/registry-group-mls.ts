import { normalizeDID } from '@kokuin/token'
import { decodeGroupAnchor, publicMembershipFacts } from '@kumiai/mls'
import {
  type ConfirmedRecoveryHandoff,
  type ControlStore,
  controlSafetyHeld,
  type GroupMLS,
  type SendAdmission,
} from '@kumiai/rpc'

import type { ControlHandleAccess } from './access.js'
import type { AccountedGroupObservation, EntryReads } from './entry-capability.js'
import { createGroupMLS, type GroupMLSParams, type RecoveryRouting } from './mls.js'
import { DisplacedGroupHandleError, GroupUnavailableError } from './persistence-errors.js'
import type { GroupKey, GroupTransaction } from './persistence-types.js'
import { accountedRuntime } from './registry/runtime-facts.js'
import { registrySafety } from './registry/safety.js'
import { readRecoverySource, recoverySourceIdentity } from './registry/source.js'
import { toRegistrySwitchWrite } from './registry/switch-write.js'
import type { GroupHandleRegistry, RegistryRecoverySource } from './registry/types.js'
import type { RecoveryEnvironment } from './registry/validation.js'
import { createRegistryHandleAccess } from './registry-handle-access.js'

export type RegistryGroupMLSParams = Omit<
  GroupMLSParams,
  'access' | 'control' | 'readRecoverySource' | 'recoveryAdoption' | 'onSafetyHold'
> & {
  registry: GroupHandleRegistry
  key: GroupKey
  recovery: RecoveryEnvironment
  target: RecoveryRouting
  onConfirmedRecovery(handoff: ConfirmedRecoveryHandoff): void
}

export async function createRegistryGroupMLS(params: RegistryGroupMLSParams): Promise<GroupMLS> {
  if (typeof params.onConfirmedRecovery !== 'function')
    throw new TypeError('Registry recovery requires a confirmed recovery coordinator sink')
  if (params.recoverySecret !== undefined && typeof params.recoverySecretFromTrust !== 'function')
    throw new TypeError('Custom recoverySecret requires recoverySecretFromTrust')
  const capability = registrySafety<GroupTransaction>(params.registry)
  if (capability === null) throw new TypeError('Registry GroupMLS requires a registered registry')
  const key = { ...params.key }
  if (
    !key.groupID ||
    !Number.isSafeInteger(key.incarnation) ||
    key.incarnation < 1 ||
    !params.target.targetID ||
    !params.target.topicID ||
    normalizeDID(params.identity.id) !== normalizeDID(params.recovery.identity.id)
  )
    throw new TypeError('Invalid registry GroupMLS parameters')
  const { registry } = params
  const target = { ...params.target }
  function assertKey(source: { key: GroupKey }): void {
    if (source.key.groupID !== key.groupID || source.key.incarnation !== key.incarnation)
      throw new DisplacedGroupHandleError('Registry GroupMLS belongs to another incarnation')
  }
  async function readSource(reads: EntryReads): Promise<RegistryRecoverySource> {
    const source = await readRecoverySource(reads, key.groupID)
    assertKey(source)
    if (normalizeDID(source.trust.credential.id) !== normalizeDID(params.identity.id))
      throw new GroupUnavailableError({ reason: 'invalid' })
    return source
  }
  let admission: SendAdmission
  let initialised = false
  let pendingObservation: AccountedGroupObservation | undefined
  function cache(next: SendAdmission): void {
    const reason = capability?.held(key)
    admission = reason == null ? { ...next } : { epoch: next.epoch, admissible: false, reason }
  }
  function observe(observation: AccountedGroupObservation): void {
    if (!initialised) {
      pendingObservation = observation
      return
    }
    const projected = accountedRuntime({
      observation,
      groupID: key.groupID,
      ownerDID: params.identity.id,
      previous: null,
    })
    if (projected?.snapshot.incarnation === key.incarnation) cache(projected.admission)
    else {
      const terminal =
        (!admission.admissible && admission.reason === 'terminal') ||
        (observation.activeKey?.incarnation === key.incarnation && observation.terminal === true)
      cache({
        epoch: admission.epoch,
        admissible: false,
        reason: terminal ? 'terminal' : 'stranded',
      })
    }
  }
  // Subscribe before the read so a committed change cannot fall between snapshot and subscription.
  const unsubscribeEntry = capability.entry.observe(key.groupID, observe)
  try {
    admission = await capability.entry.read(key.groupID, async (reads) => {
      const source = await readSource(reads)
      const control = await reads.control(key.incarnation)
      const epoch = source.trust.installed.epoch
      const safety = capability.held(key) ?? controlSafetyHeld(control)
      if (safety !== null) return { epoch, admissible: false, reason: safety } as const
      const anchor = decodeGroupAnchor(source.trust.genesisAnchor)
      if (anchor === null) throw new GroupUnavailableError({ reason: 'invalid' })
      const facts = publicMembershipFacts({
        tree: source.trust.signerTree,
        anchor,
        registry: source.trust.registry,
        ownerDID: params.identity.id,
      })
      if (!facts.ownPresent) return { epoch, admissible: false, reason: 'terminal' } as const
      const status = await reads.diagnoseState(key.incarnation)
      const state =
        status === 'readable' || status === 'null' ? await reads.state(key.incarnation) : null
      if (state !== null && !state.deleted && state.terminal)
        return { epoch, admissible: false, reason: 'terminal' } as const
      // Private state loss strands ordinary sends, while retained trust still permits recovery.
      if (status !== 'readable') return { epoch, admissible: false, reason: 'stranded' } as const
      if (control.strand !== null) return { epoch, admissible: false, reason: 'stranded' } as const
      if (facts.lapsed) return { epoch, admissible: false, reason: 'lapsed' } as const
      return { epoch, admissible: true } as const
    })
  } catch (error) {
    unsubscribeEntry()
    throw error
  }
  initialised = true
  if (pendingObservation !== undefined) observe(pendingObservation)
  let opening: Promise<ControlHandleAccess> | undefined
  const unsubscribeSafety = capability.onSafetyHold(key, (reason) => {
    admission = { epoch: admission.epoch, admissible: false, reason }
  })
  let unsubscribeRuntime: (() => void) | undefined
  capability.onRetire(key, async () => {
    unsubscribeSafety()
    unsubscribeEntry()
    unsubscribeRuntime?.()
    cache({ epoch: admission.epoch, admissible: false, reason: 'stranded' })
  })
  async function access(): Promise<ControlHandleAccess> {
    if (opening === undefined) {
      opening = (async () => {
        const value = await registry.access(key.groupID)
        assertKey(value)
        cache(value.admission())
        unsubscribeRuntime = value.runtime.onEpochChanged((snapshot) => {
          if (snapshot === null)
            cache({ epoch: admission.epoch, admissible: false, reason: 'stranded' })
          else cache(value.admission())
        })
        return createRegistryHandleAccess({ access: value })
      })().catch((error: unknown) => {
        opening = undefined
        cache({
          epoch: admission.epoch,
          admissible: false,
          reason: admission.admissible ? 'stranded' : admission.reason,
        })
        throw error
      })
    }
    return await opening
  }
  function refreshAdmission(value: ControlHandleAccess): void {
    try {
      cache(value.admission())
    } catch (error) {
      if (!(error instanceof DisplacedGroupHandleError)) throw error
      // Invalidation already removed the runtime snapshot. Preserve the operation's storage error.
      cache({ epoch: admission.epoch, admissible: false, reason: 'stranded' })
    }
  }
  const lazy: ControlHandleAccess = {
    epoch: () => admission.epoch,
    admission: () => ({ ...admission }),
    async read(fn) {
      const value = await access()
      try {
        return await value.read(fn)
      } finally {
        refreshAdmission(value)
      }
    },
    async readControl(fn) {
      const value = await access()
      try {
        return await value.readControl(fn)
      } finally {
        refreshAdmission(value)
      }
    },
    async mutate(fn, adoption) {
      const value = await access()
      try {
        return await value.mutate(fn, adoption)
      } finally {
        refreshAdmission(value)
      }
    },
    async replace(next, adoption, prepare) {
      const value = await access()
      try {
        await value.replace(next, adoption, prepare)
      } finally {
        refreshAdmission(value)
      }
    },
  }
  const control: ControlStore = {
    key: { ...key },
    load: () =>
      capability.entry.read(key.groupID, async (reads) => {
        await readSource(reads)
        return await reads.control(key.incarnation)
      }),
    lastMutation: () =>
      capability.entry.read(key.groupID, async (reads) => {
        await readSource(reads)
        return await reads.controlMutation(key.incarnation)
      }),
    apply: (changes, mutationID) =>
      capability.entry.run(
        { groupID: key.groupID, mutationID },
        async (reads) => {
          await readSource(reads)
          return { expected: await reads.lifetime(), value: null }
        },
        async (stores) => {
          await stores.incarnation(key.incarnation).control.apply(changes, mutationID)
        },
      ),
  }
  return createGroupMLS({
    ...params,
    access: lazy,
    control,
    readRecoverySource: () =>
      capability.entry.read(key.groupID, async (reads) =>
        recoverySourceIdentity(await readSource(reads)),
      ),
    recoveryAdoption: {
      target,
      environment: params.recovery,
      readRecoverySource: () => capability.entry.read(key.groupID, readSource),
      async accept(candidate, { source, proof, write }) {
        assertKey(source)
        const record = (await control.load()).rejoin
        if (record == null || !('format' in record) || record.format !== 2)
          throw new TypeError('Captured recovery record required')
        const staged = {
          incarnation: key.incarnation + 1,
          epochAfter: Number(candidate.epoch),
          removed: candidate.state.groupActiveState.kind === 'removedFromGroup',
          epochAuthenticator: candidate.state.keySchedule.epochAuthenticator.slice(),
        }
        await registry.switchIncarnation(candidate, {
          source,
          proof,
          rejoinID: record.id,
          write: toRegistrySwitchWrite({ record, staged, write: write(staged) }),
        })
      },
    },
    onSafetyHold: (latch) => capability.onSafetyHold(key, latch),
  })
}
