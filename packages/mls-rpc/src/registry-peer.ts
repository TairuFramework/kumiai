import type {
  CapturedRecapture,
  CapturedRejoinRecord,
  CheckpointService,
  ConfirmedRecoveryHandoff,
  ControlStore,
  GroupMLS,
  GroupPeer,
  GroupProtocolDefinition,
  ManualRecoveryRecord,
  NotMemberEvidence,
  RecoveryCompletion,
  RecoveryContinuation,
  RecoveryContinuationPort,
  RecoveryEvent,
  RecoveryReconciliation,
  ResyncProof,
} from '@kumiai/rpc'
import {
  applyResolved,
  controlSafetyHeld,
  isHardControlHold,
  RecoveryTargetBehindError,
} from '@kumiai/rpc'

import { createRegistryCheckpointService } from './checkpoint.js'
import {
  type ManualRecoveryStore,
  manualRecoveryAttempt,
  resumableManualRecovery,
} from './manual-recovery.js'
import { copyStoredValue, sameStoredValue } from './memory-incarnation-stores.js'
import type { RecoveryRouting } from './mls.js'
import {
  GroupStateConflictError,
  GroupUnavailableError,
  RegistryResyncRefusedError,
  RegistryRetireHookError,
  RegistrySourceMovedError,
  SpentSetCorruptError,
} from './persistence-errors.js'
import type { GroupKey, GroupTransaction } from './persistence-types.js'
import {
  RecoveryCandidateError,
  reconcileRecoveryCapture,
  restoreRecoveryCandidate,
} from './recovery.js'
import { decodeCapturedRecoveryCandidate } from './recovery-codec.js'
import { recoveryCompletionContexts } from './recovery-completion-context.js'
import { validateCapturedRecoveryRecord } from './recovery-record.js'
import {
  bindRegistryManualRunner,
  registryRecoveryCoordinator,
} from './registry/recovery-coordinator.js'
import {
  RetainedTrustUnavailableError,
  readRetainedTrust,
  registrySafety,
} from './registry/safety.js'
import { createRecoverySwitchFactory, toRegistrySwitchWrite } from './registry/switch-write.js'
import type { GroupHandleRegistry, RegistryRecoverySource } from './registry/types.js'
import type { RecoveryEnvironment } from './registry/validation.js'
import { deferred } from './runtime.js'
import type { RecoveryTarget } from './safety.js'
import {
  createNotMemberHandler,
  flushConditionEvents,
  groupCondition,
} from './safety-conditions.js'

const SOURCE_RETIREMENT_TIMEOUT_MS = 5_000
class PeerRetirementTimeoutError extends RegistryRetireHookError {}
class AcceptedRecoveryOriginMovedError extends GroupStateConflictError {}

function retirementTimedOut(cause: unknown): boolean {
  return (
    cause instanceof PeerRetirementTimeoutError ||
    (cause instanceof AggregateError && cause.errors.some(retirementTimedOut))
  )
}

type Peer = GroupPeer<Record<string, GroupProtocolDefinition>>
export type RecoveryPendingReason =
  | 'no-reply'
  | 'no-eligible-responder'
  | 'target-behind'
  | 'target-unresolved'
export type RegistryPeerOptions = {
  hub?: RecoveryTarget['hub']
  control?: ControlStore
  manualRecovery?: { authorisationID: string; source: GroupKey }
  recoveryTarget?: RecoveryRouting

  onNotMember?: (params: {
    evidence: Uint8Array
    requestID: string
    requestKey: Uint8Array
  }) => Promise<void>
  onRecovery?: (event: RecoveryEvent) => void | Promise<void>
  checkpoints: CheckpointService
  mls: GroupMLS
  recoveryOnly: boolean
  target: RecoveryRouting
  onConfirmedRecovery(handoff: ConfirmedRecoveryHandoff): void
  settleAcceptedRecovery?: RegistryPeerParams['settleAcceptedRecovery']
  reconcileConfirmedRecovery?: string
  reconcileAcceptedRecovery?: (
    record: CapturedRejoinRecord,
    reply: CapturedRecapture,
  ) => Promise<RecoveryReconciliation>
  continuation: RecoveryContinuation | null
  completion: RecoveryCompletion | null
}
export type RegistryPeerStatus =
  | { kind: 'starting' | 'running' | 'switching' | 'disposed' }
  | { kind: 'pending'; reason?: RecoveryPendingReason; authorisationID?: string }
  | { kind: 'spent-set-corrupt'; eventID: string }
  | {
      kind: 'not-member'
      eventID: string
      evidence: NotMemberEvidence
      retrying: true
      pendingReason?: RecoveryPendingReason
      authorisationID?: string
    }
  | { kind: 'failed'; error: unknown }
export type RegistryPeer = {
  runManualRecovery(record: ManualRecoveryRecord): Promise<GroupKey>
  peer(): Peer | null
  installedKey(): GroupKey
  status(): RegistryPeerStatus
  ready: Promise<void>
  dispose(): void
  drained(): Promise<void>
}
export type RegistryPeerParams = {
  resolveTarget?: (targetID: string) => Promise<RecoveryTarget>
  registry: GroupHandleRegistry
  key: GroupKey
  recovery: RecoveryEnvironment
  target: RecoveryRouting
  continuation: RecoveryContinuationPort
  onRecovery?: (event: RecoveryEvent) => void | Promise<void>
  settleAcceptedRecovery?: (
    record: CapturedRejoinRecord,
    epoch: number,
    leafDigest: string,
    recoveryEpochFloor: number | null,
  ) => Promise<void>
  createMLS(
    key: GroupKey,
    onConfirmedRecovery: (handoff: ConfirmedRecoveryHandoff) => void,
    options: {
      target: RecoveryRouting
      manualRecovery?: { authorisationID: string; source: GroupKey }
    },
  ): GroupMLS | Promise<GroupMLS>
  createPeer(key: GroupKey, options: RegistryPeerOptions): Promise<Peer>
}

export async function createRegistryPeer(params: RegistryPeerParams): Promise<RegistryPeer> {
  const { registry } = params
  const registered = registrySafety<GroupTransaction>(registry)
  if (registered === null) throw new TypeError('Registry peer requires a registered registry')
  const capability = registered
  const coordinator = registryRecoveryCoordinator(registry)
  let target = { ...params.target }
  let manual: ManualRecoveryRecord | null = null
  let selectedTarget: RecoveryTarget | null = null
  let manualStore: ManualRecoveryStore | null = null
  let preparingManual = false
  let manualCompletion: {
    id: string
    promise: Promise<GroupKey>
    resolve(key: GroupKey): void
    reject(error: unknown): void
  } | null = null
  async function discoverManual(): Promise<void> {
    if (manual !== null) return
    // A successor choice is the app's to resume; it also retires any pending resync.
    manual = await capability.entry.read(key.groupID, async (reads) =>
      resumableManualRecovery(await reads.checkpoints(), key),
    )
    if (manual !== null) manualStore = coordinator.manualStore(manual.source, params.resolveTarget)
  }
  const manualID = () => manual?.id

  let key = { ...params.key }
  let current: Peer | null = null
  let disposed = false
  let worker: Promise<void> | null = null
  let creating: Promise<Peer> | null = null
  let retirementGeneration = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let wake: (() => void) | undefined
  let unregister = () => {}
  const peers = new Set<Peer>()
  const pending = new Set<Promise<unknown>>()
  let reconcileConfirmedRecovery: string | undefined
  const settleAcceptedRecovery =
    params.settleAcceptedRecovery ??
    (async (
      record: CapturedRejoinRecord,
      epoch: number,
      leafDigest: string,
      recoveryEpochFloor: number | null,
    ) => {
      const sourceKey = record.source.key
      if (record.trigger === 'manual' && record.authorisationID !== null) {
        const store = coordinator
          .manualStore(record.source.key)
          .manualRecoveryControl(record.authorisationID)
        await applyResolved(
          store,
          {
            deleteRejoin: true,
            recoveryEpochFloor,
            putSettledRejoins: [
              {
                kind: 'accepted-unadoptable',
                id: record.id,
                digest: record.digest,
                payloadDigest: record.payloadDigest,
                epochAfter: record.epochAfter,
                acceptedEpoch: epoch,
                leafDigest,
                origin: { sourceKey, target: record.target, searchFrom: record.searchFrom },
                ledgerBefore: record.ledgerBefore,
              },
            ],
          },
          crypto.randomUUID(),
        )
        return
      }
      const store: ControlStore = {
        key: sourceKey,
        load: () =>
          capability.entry.read(sourceKey.groupID, (reads) => reads.control(sourceKey.incarnation)),
        lastMutation: () =>
          capability.entry.read(sourceKey.groupID, (reads) =>
            reads.controlMutation(sourceKey.incarnation),
          ),
        apply: (changes, mutationID) =>
          capability.entry.run(
            { groupID: sourceKey.groupID, mutationID },
            async (reads) => {
              const snapshot = await reads.control(sourceKey.incarnation)
              if (
                !sameStoredValue(snapshot.rejoin, record) ||
                controlSafetyHeld(snapshot) !== null ||
                isHardControlHold(snapshot.controlHold)
              )
                throw new GroupStateConflictError('Accepted recovery moved before settlement')
              return { expected: await reads.lifetime(), value: null }
            },
            async (stores) => {
              const control = stores.incarnation(sourceKey.incarnation).control
              const snapshot = await control.load()
              if (
                !sameStoredValue(snapshot.rejoin, record) ||
                controlSafetyHeld(snapshot) !== null ||
                isHardControlHold(snapshot.controlHold)
              )
                throw new GroupStateConflictError('Accepted recovery moved before settlement')
              const settled = {
                ...changes,
                ...(snapshot.controlHold?.reason === 'acceptance-unknown'
                  ? { controlHold: null }
                  : {}),
              }
              if (snapshot.forkRecoveryAttempt?.id === record.id)
                recoveryCompletionContexts.set(stores.tx, {
                  key: sourceKey,
                  changes: settled,
                  forkRecovery: { attempt: null },
                })
              try {
                await control.apply(settled, mutationID)
              } finally {
                recoveryCompletionContexts.delete(stores.tx)
              }
            },
          ),
      }
      await applyResolved(
        store,
        {
          deleteRejoin: true,
          recoveryEpochFloor,
          putSettledRejoins: [
            {
              kind: 'accepted-unadoptable',
              id: record.id,
              digest: record.digest,
              payloadDigest: record.payloadDigest,
              epochAfter: record.epochAfter,
              acceptedEpoch: epoch,
              leafDigest,
              origin: { sourceKey, target: record.target, searchFrom: record.searchFrom },
              ledgerBefore: record.ledgerBefore,
            },
          ],
        },
        crypto.randomUUID(),
      )
      record.requestKey.fill(0)
      record.candidate.fill(0)
    })
  let status: RegistryPeerStatus = { kind: 'starting' }
  let conditionTimer: ReturnType<typeof setTimeout> | undefined
  let pendingReason: RecoveryPendingReason | undefined
  async function refreshCondition(): Promise<void> {
    const { observed, deadlines, hardHeld } = await capability.entry.read(
      key.groupID,
      async (reads) => {
        const records = await reads.checkpoints()
        const control = await reads.control(key.incarnation)
        return {
          observed: groupCondition(records, key),
          hardHeld:
            control.forkHalt !== null ||
            isHardControlHold(control.controlHold) ||
            capability.held(key) === 'fork-halted',
          deadlines: records.flatMap((row) =>
            row.kind === 'condition' &&
            row.key.incarnation === key.incarnation &&
            row.notification?.emitted === false
              ? [row.notification.emitAt]
              : [],
          ),
        }
      },
    )
    if (disposed || status.kind === 'failed') return
    if (conditionTimer !== undefined) clearTimeout(conditionTimer)
    conditionTimer = undefined
    if (deadlines.length > 0)
      conditionTimer = setTimeout(
        () => {
          conditionTimer = undefined
          void track(
            flushConditionEvents(registry, key, () => !disposed).then(refreshCondition),
          ).catch(() => {
            if (!disposed)
              conditionTimer = setTimeout(() => {
                void track(refreshCondition()).catch(() => {})
              }, 30000)
          })
        },
        Math.max(0, Math.min(2147483647, Math.min(...deadlines) - Date.now())),
      )
    if (!hardHeld && observed.condition === 'spent-set-corrupt' && observed.eventID !== undefined) {
      status = { kind: 'spent-set-corrupt', eventID: observed.eventID }
      return
    }
    if (
      observed.condition === 'not-member' &&
      observed.evidence !== null &&
      observed.eventID !== undefined
    )
      status = {
        kind: 'not-member',
        eventID: observed.eventID,
        evidence: observed.evidence,
        retrying: true,
        ...(pendingReason === undefined ? {} : { pendingReason }),
        ...(manual === null ? {} : { authorisationID: manual.id }),
      }
    else if (status.kind === 'not-member') status = { kind: 'running' }
  }
  function onRecovery(event: RecoveryEvent): void | Promise<void> {
    if (manual !== null && event.phase === 'failed' && event.reason === 'refused')
      manualCompletion?.reject(new RegistryResyncRefusedError({ reason: 'unaccepted' }))
    if (event.phase === 'failed' && event.pendingReason !== undefined) {
      pendingReason = event.pendingReason
      if (status.kind === 'not-member') status = { ...status, pendingReason }
      else if (!disposed && status.kind !== 'failed' && status.kind !== 'spent-set-corrupt')
        status = {
          kind: 'pending',
          reason: pendingReason,
          ...(manual === null ? {} : { authorisationID: manual.id }),
        }
    }
    return params.onRecovery?.(event)
  }
  const unobserve = capability.entry.observe(
    key.groupID,
    () => {},
    () => {
      if (!disposed) void track(refreshCondition()).catch(() => {})
    },
  )
  let recoveryAttempt: Pick<CapturedRejoinRecord, 'id' | 'trigger'> | undefined
  async function diagnoseSpentSet(): Promise<void> {
    try {
      await capability.entry.read(key.groupID, async (reads) => {
        const lifetime = await reads.lifetime()
        if (lifetime?.activeIncarnation === key.incarnation) await readRetainedTrust(reads, key)
      })
    } catch (error) {
      // Other trust failures keep their existing startup diagnosis.
      if (error instanceof SpentSetCorruptError) throw error
    }
  }
  async function persistSpentCondition(error: SpentSetCorruptError): Promise<void> {
    try {
      await capability.persistGroupCondition(key, 'spent-set-corrupt', null)
    } catch (failure) {
      if (failure instanceof GroupUnavailableError && failure.reason === 'invalid') throw failure
      // A failed diagnostic write leaves the corruption, not the storage fault, as the cause.
      throw error
    }
  }
  function fail(error: unknown, record = recoveryAttempt): void {
    if (status.kind === 'failed') return
    status = { kind: 'failed', error }
    if (!preparingManual) manualCompletion?.reject(error)
    if (!disposed && record !== undefined) {
      const event: RecoveryEvent = {
        groupID: target.topicID,
        attemptID: record.id,
        trigger: record.trigger === 'automatic' ? 'automatic' : 'consumer',
        phase: 'failed',
        reason: 'error',
        error,
      }
      void Promise.resolve()
        .then(() => params.onRecovery?.(event))
        .catch(() => {})
    }
  }
  function track<T>(value: Promise<T>): Promise<T> {
    pending.add(value)
    void value.then(
      () => pending.delete(value),
      () => pending.delete(value),
    )
    return value
  }
  async function stopPeer(peer: Peer): Promise<void> {
    const results = await Promise.allSettled([peer.dispose(), peer.drained()])
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    if (current === peer) current = null
    peers.delete(peer)
  }
  function retire(requested: GroupKey): void {
    unregister()
    // Retirement waits source work only. A switch worker must never wait on itself.
    unregister = capability.onRetire(requested, async () => {
      retirementGeneration++
      let timeout: ReturnType<typeof setTimeout> | undefined
      const drain = track(
        (async () => {
          const source = creating === null ? current : await creating
          if (source !== null) await stopPeer(source)
        })(),
      )
      try {
        await Promise.race([
          drain,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new PeerRetirementTimeoutError('Source retirement timed out')),
              SOURCE_RETIREMENT_TIMEOUT_MS,
            )
          }),
        ])
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
      }
    })
  }
  async function start(requested: GroupKey): Promise<void> {
    if (disposed) return
    const source = await registry.recoverySource(requested.groupID)
    if (!sameStoredValue(source.key, requested))
      throw new GroupStateConflictError('Peer incarnation moved')
    const control = await capability.entry.read(requested.groupID, (reads) =>
      reads.control(requested.incarnation),
    )
    const held = capability.held(requested) ?? controlSafetyHeld(control)
    const manualSource = manual !== null && sameStoredValue(manual.source, requested)
    if (!manualSource && (held !== null || isHardControlHold(control.controlHold)))
      throw new GroupUnavailableError({
        reason: held === 'recovery-unavailable' ? held : 'invalid',
      })
    retire(requested)
    const generation = retirementGeneration
    const authority =
      manualSource && manual !== null
        ? { authorisationID: manual.id, source: { ...manual.source } }
        : undefined
    const mls = await params.createMLS({ ...requested }, onConfirmedRecovery, {
      target: { ...target },
      ...(authority === undefined ? {} : { manualRecovery: authority }),
    })
    let peer: Peer | undefined
    let installed = false
    try {
      if (disposed || generation !== retirementGeneration) return
      const continuation = await params.continuation.loadRecoveryContinuation(requested)
      if (disposed || generation !== retirementGeneration) return
      creating = params.createPeer(
        { ...requested },
        {
          mls,
          ...(authority === undefined
            ? {}
            : {
                manualRecovery: authority,
                control: manualStore?.manualRecoveryControl(authority.authorisationID),
              }),
          ...(selectedTarget === null
            ? {}
            : { hub: selectedTarget.hub, recoveryTarget: { ...target } }),
          checkpoints: createRegistryCheckpointService(registry, requested),
          recoveryOnly:
            manualSource ||
            control.rejoin !== null ||
            control.forkRecoveryAttempt != null ||
            !mls.sendAdmission().admissible,
          target: { ...target },
          onConfirmedRecovery,
          onRecovery,
          onNotMember: async (input) => {
            await track(
              createNotMemberHandler({
                registry,
                key: requested,
                recovery: params.recovery,
                current: () =>
                  !disposed &&
                  generation === retirementGeneration &&
                  sameStoredValue(key, requested),
              })(input),
            )
            await refreshCondition()
          },
          settleAcceptedRecovery,
          reconcileAcceptedRecovery: async (record, reply) => {
            const saved = await coordinator.readRecoveryRecord(manual?.source ?? key, manualID())
            if (
              reconcileConfirmedRecovery !== record.id ||
              record.stage !== 'confirmed' ||
              !sameStoredValue(saved, record)
            )
              throw new GroupStateConflictError('Accepted recovery changed before recapture')
            const resolved = await coordinator.resolveRecoverySwitch(record)
            if (resolved.kind !== 'rolled-back') return { kind: 'retry' }
            if (record.forkRecovery !== undefined) {
              if (
                !(await coordinator.checkForkRecoveryCapture(
                  {
                    attempt: {
                      id: record.id,
                      source: record.source.key,
                      forkRecovery: record.forkRecovery,
                    },
                    reply,
                  },
                  params.recovery,
                ))
              )
                return { kind: 'retry', reason: 'target-behind' }
              return await coordinator.settleForkRecoveryCapture({ record, reply }, params.recovery)
            }
            // Installation already refused. Settlement authenticates X against its immutable public origin.
            return await reconcileRecoveryCapture({
              source: record.source as RegistryRecoverySource,
              target,
              record,
              reply,
              environment: {
                ...params.recovery,
                accept: async () => {
                  throw new Error('Settlement cannot install recovery')
                },
              },
            })
          },
          reconcileConfirmedRecovery,
          continuation,
          completion:
            continuation === null
              ? null
              : (input) =>
                  params.continuation.finishRecoveryContinuation({ ...input, continuation }),
        },
      )
      try {
        peer = await creating
      } finally {
        creating = null
      }
      peers.add(peer)
      if (disposed || generation !== retirementGeneration) return
      installed = true
    } finally {
      if (!installed) {
        try {
          if (peer !== undefined) await stopPeer(peer)
        } finally {
          if ('dispose' in mls && typeof mls.dispose === 'function') await mls.dispose()
        }
      }
    }
    key = { ...requested }
    current = peer
    status = { kind: 'running' }
    await refreshCondition()
  }
  async function accept(
    record: CapturedRejoinRecord,
    source: RegistryRecoverySource,
  ): Promise<void> {
    if (
      !sameStoredValue(record.source.key, key) ||
      record.target.targetID !== target.targetID ||
      record.target.topicID !== target.topicID
    )
      throw new GroupStateConflictError('Recovery origin or target moved')
    if (
      !sameStoredValue(
        {
          ...source,
          stateVersion: record.source.stateVersion,
          lifetimeRevision: record.source.lifetimeRevision,
        },
        record.source,
      )
    )
      throw new AcceptedRecoveryOriginMovedError('Accepted recovery origin moved')
    if (record.position === undefined || record.verdict === undefined)
      throw new GroupStateConflictError('Confirmed recovery proof required')
    const proof: ResyncProof = {
      ...copyStoredValue(record.target),
      position: record.position,
      payloadDigest: record.payloadDigest,
      verdict: record.verdict.slice(),
    }
    const write = createRecoverySwitchFactory(record)
    if (record.forkRecovery !== undefined) {
      const saved = decodeCapturedRecoveryCandidate(record.candidate, record.requestKey)
      if (
        !(await coordinator.checkForkRecoveryCapture(
          {
            attempt: {
              id: record.id,
              source: record.source.key,
              forkRecovery: record.forkRecovery,
            },
            reply: {
              sealed: saved.attestedReply,
              requestID: saved.requestID,
              requestKey: record.requestKey,
              epochFloor: null,
            },
          },
          params.recovery,
        ))
      )
        throw new RegistryResyncRefusedError({ reason: 'tuple' })
    }
    const pending = await restoreRecoveryCandidate({
      source,
      candidate: record.candidate,
      requestKey: record.requestKey,
      environment: {
        ...params.recovery,
        async accept(candidate, input) {
          const staged = {
            incarnation: source.key.incarnation + 1,
            epochAfter: Number(candidate.epoch),
            removed: candidate.state.groupActiveState.kind === 'removedFromGroup',
            epochAuthenticator: candidate.state.keySchedule.epochAuthenticator.slice(),
          }
          await registry.switchIncarnation(candidate, {
            source: input.source,
            rejoinID: record.id,
            proof: input.proof,
            write: toRegistrySwitchWrite({ record, staged, write: input.write(staged) }),
          })
        },
      },
    })
    await pending.onAccepted(source, proof, write)
  }
  async function pause(delay: number): Promise<void> {
    if (disposed) return
    await new Promise<void>((resolve) => {
      wake = resolve
      timer = setTimeout(resolve, delay)
    })
    timer = undefined
    wake = undefined
  }
  async function moveCurrent(record: ManualRecoveryRecord): Promise<boolean> {
    if (manualStore === null) return false
    let runtime: { stateVersion: number; ledgerComplete: boolean }
    try {
      const access = await registry.access(key.groupID)
      if (!sameStoredValue(access.key, record.source)) return false
      runtime = {
        stateVersion: access.stateVersion(),
        ledgerComplete: await access.read((group) => group.isLedgerComplete()),
      }
    } catch {
      return false // Unreadable state can only rejoin.
    }
    if (!(await manualStore.moveCurrent(record.id, runtime))) return false
    // Routing goes live only after the completed move is proven.
    manual = null
    manualStore = null
    await start(key)
    manualCompletion?.resolve({ ...key })
    manualCompletion = null
    return true
  }
  async function resume(): Promise<void> {
    let backoff = 100
    await discoverManual()
    if (manual !== null && manualStore !== null) {
      selectedTarget = await manualStore.resolveManualRecoveryTarget(manual.id)
      if (selectedTarget === null) {
        pendingReason = 'target-unresolved'
        status = { kind: 'pending', reason: pendingReason, authorisationID: manual.id }
        await refreshCondition()
        timer = setTimeout(() => {
          if (!disposed) void track(resume()).catch((error: unknown) => fail(error))
        }, 1000)
        return
      }
      target = { targetID: selectedTarget.id, topicID: selectedTarget.commitTopicID }
      pendingReason = undefined
      if (manual.stage === 'completed' && manual.attempt === null && manual.destination !== null) {
        key = { ...manual.destination }
        manual = null
        manualStore = null
      }
    }
    while (!disposed) {
      try {
        let record = await coordinator.readRecoveryRecord(manual?.source ?? key, manualID())
        if (disposed) return
        const control = await capability.entry.read(key.groupID, (reads) =>
          reads.control(key.incarnation),
        )
        if (record !== null && 'format' in record) {
          recoveryAttempt = { id: record.id, trigger: record.trigger }
          try {
            validateCapturedRecoveryRecord(record)
          } catch (cause) {
            throw new GroupStateConflictError('Invalid saved recovery record', { cause })
          }
          if (
            record.trigger !== 'automatic' &&
            (manual === null || record.authorisationID !== manual.id)
          )
            throw new GroupStateConflictError('Manual recovery requires host activation')
        }
        const hardHeld =
          control.forkHalt !== null ||
          isHardControlHold(control.controlHold) ||
          capability.held(key) === 'fork-halted'
        // Diagnose spent corruption before a same-key transport move or recovery refusal.
        const diagnoseSpent = !hardHeld
        if (diagnoseSpent) await diagnoseSpentSet()
        if (diagnoseSpent && capability.held(key) === 'spent-set-corrupt')
          throw new SpentSetCorruptError({ key })
        if (manual?.stage === 'authorised' && (await moveCurrent(manual))) return
        if (
          manual === null &&
          (capability.held(key) !== null ||
            controlSafetyHeld(control) !== null ||
            isHardControlHold(control.controlHold))
        )
          throw new GroupStateConflictError('Recovery source is held')
        if (
          record === null ||
          ('format' in record && (record.stage === 'built' || record.stage === 'published'))
        ) {
          await start(key)
          return
        }
        if (!('format' in record) || (record.stage !== 'confirmed' && record.stage !== 'adopted'))
          throw new GroupStateConflictError('Recovery record is not resumable')
        if (record.stage === 'confirmed' && record.switchMutationID === null) {
          const source = await registry.recoverySource(key.groupID)
          if (!sameStoredValue(source.key, key))
            throw new GroupStateConflictError('Recovery source moved')
          await coordinator.assignSwitchID(record)
          continue
        }
        const resolved = await coordinator.resolveRecoverySwitch(record)
        if (disposed) return
        if (resolved.kind === 'committed') {
          if (current !== null) await stopPeer(current)
          await start(resolved.destination)
          manualCompletion?.resolve(resolved.destination)
          manualCompletion = null
          pendingReason = undefined
          manual = null
          manualStore = null
          return
        }
        if (resolved.kind === 'rolled-back') {
          status = { kind: 'switching' }
          const control = await capability.entry.read(key.groupID, (reads) =>
            reads.control(key.incarnation),
          )
          if (
            manual === null &&
            (capability.held(key) !== null || controlSafetyHeld(control) !== null)
          )
            throw new GroupStateConflictError('Recovery source is held')
          if (current !== null) await stopPeer(current)
          const source = await registry.recoverySource(key.groupID)
          // Reread after source callbacks and completion writes have drained.
          record = await coordinator.readRecoveryRecord(manual?.source ?? key, manualID())
          if (record === null || !('format' in record) || record.stage !== 'confirmed')
            throw new GroupStateConflictError('Confirmed recovery moved after drainage')
          try {
            await accept(record, source)
          } catch (error) {
            if (
              !(
                error instanceof AcceptedRecoveryOriginMovedError ||
                error instanceof RegistryResyncRefusedError ||
                error instanceof RecoveryTargetBehindError
              )
            )
              throw error
            reconcileConfirmedRecovery = record.id
            await start(key)
            return
          }
          continue
        }
        status = { kind: 'pending' }
      } catch (error) {
        if (disposed) return
        if (error instanceof SpentSetCorruptError) {
          await persistSpentCondition(error)
          if (capability.held(key) === 'fork-halted') throw error
          if (manual !== null) {
            // The authorised row stays; recover() must still settle.
            manualCompletion?.reject(error)
            manualCompletion = null
          }
          await refreshCondition()
          return
        }
        if (error instanceof RetainedTrustUnavailableError)
          await registry.recoverySource(key.groupID)
        if (error instanceof RegistrySourceMovedError && backoff === 100) {
          backoff = 200
          continue
        }
        if (
          !(error instanceof RegistrySourceMovedError) &&
          (error instanceof GroupStateConflictError ||
            error instanceof RegistryResyncRefusedError ||
            (error instanceof RegistryRetireHookError && !retirementTimedOut(error.cause)) ||
            error instanceof RecoveryCandidateError ||
            error instanceof GroupUnavailableError)
        )
          throw error
        // Retry provider failures through saved-ID resolution, never through a new candidate.
      }
      await pause(backoff)
      backoff = Math.min(backoff * 2, 15_000)
    }
  }
  function onConfirmedRecovery(handoff: ConfirmedRecoveryHandoff): void {
    void handoff.completion.catch(() => {})
    if (
      disposed ||
      status.kind === 'failed' ||
      worker !== null ||
      !sameStoredValue(handoff.record.source.key, key)
    )
      return
    status = { kind: 'switching' }
    const completion = handoff.completion
    const running = Promise.resolve().then(async () => {
      await completion
      await ready
      if (!disposed && current !== null) await stopPeer(current)
      if (!disposed) await resume()
    })
    worker = running
    track(running)
    void running
      .catch((error: unknown) => {
        fail(error, handoff.record)
      })
      .finally(() => {
        if (worker === running) worker = null
      })
  }
  async function activateManual(record: ManualRecoveryRecord): Promise<GroupKey> {
    if (disposed) throw new GroupStateConflictError('Recovery peer disposed')
    if (manualCompletion?.id === record.id) return await manualCompletion.promise
    if (manualCompletion !== null)
      throw new GroupStateConflictError('Another manual recovery is running')
    preparingManual = true
    const completion = deferred<GroupKey>()
    const promise = completion.promise
    manualCompletion = { id: record.id, ...completion }
    void promise.catch(() => {})
    const running = (async () => {
      await ready.catch(() => {})
      if (worker !== null) await worker.catch(() => {})
      if (current !== null) await stopPeer(current)
      await capability.entry.read(record.source.groupID, async (reads) => {
        const saved = manualRecoveryAttempt(await reads.checkpoints(), record.source, record.id)
        if (
          saved.stage !== 'authorised' ||
          !sameStoredValue(saved.choice, record.choice) ||
          (await reads.lifetime())?.activeIncarnation !== record.source.incarnation
        )
          throw new GroupStateConflictError('Manual recovery source or authority moved')
      })
      manual = copyStoredValue(record)
      manualStore = coordinator.manualStore(record.source, params.resolveTarget)
      key = { ...record.source }
      status = { kind: 'switching' }
      preparingManual = false
      if (timer !== undefined) clearTimeout(timer)
      await resume()
    })()
    void track(running).catch((error: unknown) => {
      preparingManual = false
      manualCompletion?.reject(error)
      fail(error)
    })
    return await promise
  }
  const unbindManual = bindRegistryManualRunner(registry, key.groupID, activateManual)
  const ready = track(Promise.resolve().then(resume))
  void ready.catch((error: unknown) => {
    fail(error)
  })
  return {
    runManualRecovery: (record) => {
      if (record.source.groupID !== key.groupID)
        return Promise.reject(
          new GroupStateConflictError('Manual recovery belongs to another group'),
        )
      return coordinator.runManual(record)
    },
    peer: () => current,
    installedKey: () => ({ ...key }),
    status: () => (status.kind === 'not-member' ? copyStoredValue(status) : { ...status }),
    ready,
    dispose() {
      if (disposed) return
      disposed = true
      if (status.kind !== 'failed') status = { kind: 'disposed' }
      if (timer !== undefined) clearTimeout(timer)
      wake?.()
      unregister()
      unobserve()
      unbindManual()
      manualCompletion?.reject(new GroupStateConflictError('Recovery peer disposed'))
      if (conditionTimer !== undefined) clearTimeout(conditionTimer)
      for (const peer of peers) void track(peer.dispose()).catch(() => {})
    },
    async drained() {
      if (!disposed) throw new Error('Call dispose() before drained()')
      while (pending.size > 0) await Promise.allSettled([...pending])
      await Promise.all([...peers].map((peer) => peer.drained()))
      if (status.kind === 'failed') throw status.error
    },
  }
}
