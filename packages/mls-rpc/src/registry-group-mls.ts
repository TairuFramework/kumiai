import { normalizeDID } from '@kokuin/token'
import {
  decodeClientState,
  decodeGroupAnchor,
  publicMembershipFacts,
  restoreGroup,
  sealRosterAbsenceReply,
} from '@kumiai/mls'
import {
  type ControlStore,
  controlSafetyHeld,
  type GroupMLS,
  isHardControlHold,
  RecoveryTargetBehindError,
  type SendAdmission,
} from '@kumiai/rpc'

import type { ControlHandleAccess, ControlReadScope } from './access.js'
import { provenCheckpointFacts } from './checkpoint-store.js'
import type { AccountedGroupObservation, EntryReads } from './entry-capability.js'
import { manualRecoveryAttempt } from './manual-recovery.js'
import { sameStoredValue } from './memory-incarnation-stores.js'
import {
  createGroupMLS,
  type GroupMLSParams,
  type RecoveryRouting,
  registryRosterSealers,
} from './mls.js'
import { DisplacedGroupHandleError, GroupUnavailableError } from './persistence-errors.js'
import type { GroupKey, GroupTransaction } from './persistence-types.js'
import { reconcileRecoveryCapture } from './recovery.js'
import {
  checkForkRecoveryCaptureInReads,
  registryRecoveryCoordinator,
} from './registry/recovery-coordinator.js'
import { accountedRuntime } from './registry/runtime-facts.js'
import { registrySafety } from './registry/safety.js'
import { readRecoverySource, recoverySourceIdentity } from './registry/source.js'
import { toRegistrySwitchWrite } from './registry/switch-write.js'
import type { GroupHandleRegistry, RegistryRecoverySource } from './registry/types.js'
import type { RecoveryEnvironment } from './registry/validation.js'
import { createRegistryHandleAccess } from './registry-handle-access.js'
import { clearGroupCondition } from './safety-conditions.js'

export type RegistryGroupMLSParams = Omit<
  GroupMLSParams,
  | 'access'
  | 'control'
  | 'readRecoverySource'
  | 'recoveryAdoption'
  | 'onSafetyHold'
  | 'authoriseForkRecovery'
  | 'readInstalledRecoveryLineage'
  | 'checkForkRecoveryCapture'
  | 'settleForkRecoveryCapture'
> & {
  registry: GroupHandleRegistry
  key: GroupKey
  recovery: RecoveryEnvironment
  target: RecoveryRouting
  manualRecovery?: { authorisationID: string; source: GroupKey }
}

export async function createRegistryGroupMLS(params: RegistryGroupMLSParams): Promise<GroupMLS> {
  if (params.recoverySecret !== undefined && typeof params.recoverySecretFromTrust !== 'function')
    throw new TypeError('Custom recoverySecret requires recoverySecretFromTrust')
  const capability = registrySafety<GroupTransaction>(params.registry)
  if (capability === null) throw new TypeError('Registry GroupMLS requires a registered registry')
  const manualRecovery =
    params.manualRecovery === undefined
      ? undefined
      : {
          authorisationID: params.manualRecovery.authorisationID,
          source: { ...params.manualRecovery.source },
        }
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
  async function checkManual(reads: EntryReads): Promise<void> {
    if (manualRecovery === undefined) return
    const { authorisationID, source } = manualRecovery
    const manual = manualRecoveryAttempt(await reads.checkpoints(), key, authorisationID)
    if (
      !sameStoredValue(source, key) ||
      manual.stage !== 'authorised' ||
      manual.pauseReason !== null ||
      manual.choice.mode !== 'resync' ||
      manual.choice.targetID !== target.targetID ||
      manual.choice.commitTopicID !== target.topicID ||
      (await reads.lifetime())?.activeIncarnation !== key.incarnation
    )
      throw new DisplacedGroupHandleError('Manual recovery authority moved')
  }
  async function readSource(reads: EntryReads): Promise<RegistryRecoverySource> {
    await checkManual(reads)
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
  let lineageScope: ControlReadScope | undefined
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
        return await value.readControl(async (scope) => {
          lineageScope = scope
          try {
            return await fn(scope)
          } finally {
            lineageScope = undefined
          }
        })
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
  const ordinaryControl: ControlStore = {
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
  const control =
    manualRecovery === undefined
      ? ordinaryControl
      : registryRecoveryCoordinator(registry)
          .manualStore(key)
          .manualRecoveryControl(manualRecovery.authorisationID)
  registryRosterSealers.set(lazy, (request, captureHead) =>
    capability.entry.read(key.groupID, async (reads) => {
      const source = await readSource(reads)
      const control = await reads.control(key.incarnation)
      if (
        controlSafetyHeld(control) !== null ||
        isHardControlHold(control.controlHold) ||
        capability.held(key) !== null
      )
        return null
      if (
        source.identity === null ||
        (control.cursor?.position ?? null) !== captureHead ||
        (control.cursor !== null && control.cursor.epoch !== source.identity.epoch) ||
        control.cursor?.stranded === true ||
        control.cursor?.incomplete === true ||
        control.strand !== null
      )
        return null
      const record = await reads.state(key.incarnation)
      if (record === null || record.deleted || record.state === null) return null
      const state = decodeClientState(record.state)
      if (state == null) return null
      const records = await reads.checkpoints()
      const facts = provenCheckpointFacts(records, key.groupID).sort((a, b) => a.epoch - b.epoch)
      const lineage = facts
        .filter((fact) => fact.key.incarnation === key.incarnation)
        .flatMap((fact) =>
          records.flatMap((row) =>
            row.kind === 'publication' && row.factID === fact.id && row.frame !== null
              ? [row.frame.slice()]
              : [],
          ),
        )
      const group = await restoreGroup({
        state,
        credential: record.credential,
        ledgerEntries: record.ledger,
        options: params.recovery.options,
      })
      return await sealRosterAbsenceReply({
        group,
        identity: params.identity,
        request: new TextDecoder().decode(request),
        captureHead,
        retainedRosterFacts: facts.flatMap((row) => (row.kind === 'fact' ? [row.canonical] : [])),
        lineage,
      })
    }),
  )
  const groupMLS = createGroupMLS({
    ...params,
    access: lazy,
    control,
    settleForkRecoveryCapture: (input) =>
      registryRecoveryCoordinator(registry).settleForkRecoveryCapture(input, params.recovery),
    authoriseForkRecovery: (reply, noticeID) =>
      registryRecoveryCoordinator(registry).authoriseForkRecovery(
        key,
        reply,
        noticeID,
        params.recovery,
      ),
    checkForkRecoveryCapture: (input) =>
      registryRecoveryCoordinator(registry).checkForkRecoveryCapture(input, params.recovery),
    readInstalledRecoveryLineage: async ({ comparisonEpoch, throughEpoch }) => {
      const scope = lineageScope
      if (
        scope?.loadCheckpoints === undefined ||
        scope.source.identity?.epoch !== throughEpoch ||
        scope.source.key.incarnation !== key.incarnation
      )
        return []
      const records = await scope.loadCheckpoints()
      const facts = provenCheckpointFacts(records, key.groupID)
        .filter(
          (fact) =>
            fact.key.incarnation === key.incarnation &&
            fact.epoch >= comparisonEpoch &&
            fact.epoch <= throughEpoch,
        )
        .sort((a, b) => a.epoch - b.epoch)
      return facts.flatMap((fact) =>
        records.flatMap((row) =>
          row.kind === 'publication' && row.factID === fact.id && row.frame !== null
            ? [row.frame.slice()]
            : [],
        ),
      )
    },
    readRecoverySource: () =>
      capability.entry.read(key.groupID, async (reads) =>
        recoverySourceIdentity(await readSource(reads)),
      ),
    recoveryAdoption: {
      ...(manualRecovery === undefined
        ? {}
        : {
            manualRecovery: {
              ...manualRecovery,
              check: () => capability.entry.read(key.groupID, checkManual),
            },
          }),
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
  const captured = groupMLS.capturedRecovery
  if (captured !== undefined) {
    const reconcile = captured.reconcileCapture
    captured.reconcileCapture = async (record, reply) => {
      const result = await reconcile(record, reply)
      if (result.kind !== 'head-only' || manualRecovery !== undefined) return result
      // Re-authenticate under the owner before clearing a diagnostic from an earlier capture.
      const mutationID = crypto.randomUUID()
      await capability.entry.run(
        { groupID: key.groupID, mutationID },
        async (reads) => {
          const source = await readSource(reads)
          if (record.forkRecovery !== undefined) {
            const attempt = (await reads.control(key.incarnation)).forkRecoveryAttempt
            if (
              attempt == null ||
              attempt.id !== record.id ||
              !(await checkForkRecoveryCaptureInReads(reads, attempt, reply, params.recovery))
            )
              throw new RecoveryTargetBehindError('Fork recovery capture is target-behind')
          }
          const verified = await reconcileRecoveryCapture({
            source,
            target,
            record,
            reply,
            environment: {
              ...params.recovery,
              accept: async () => {
                throw new Error('Head reconciliation cannot install')
              },
            },
          })
          if (verified.kind !== 'head-only' || verified.head !== result.head)
            throw new DisplacedGroupHandleError('Recovery capture changed before reconciliation')
          const control = await reads.control(key.incarnation)
          const stateStatus = await reads.diagnoseState(key.incarnation)
          const installed = source.trust.installed
          // A signed head anchors only the identical installed state, never another branch's snapshot.
          const cursor =
            result.head !== null &&
            stateStatus === 'readable' &&
            installed.epoch === record.target.groupInfoEpoch &&
            sameStoredValue(installed.authenticator, record.target.groupInfoAuthenticator) &&
            (control.cursor?.position == null || control.cursor.position < result.head)
              ? { ...control.cursor, position: result.head, epoch: installed.epoch }
              : undefined
          return { expected: await reads.lifetime(), value: cursor }
        },
        async (stores, cursor) => {
          if (cursor !== undefined)
            await stores.incarnation(key.incarnation).control.apply({ cursor }, mutationID)
          await clearGroupCondition(stores.checkpoints, key)
        },
      )
      return result
    }
  }
  return groupMLS
}
