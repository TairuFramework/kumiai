import type {
  CapturedRecapture,
  CapturedRejoinRecord,
  CheckpointService,
  ConfirmedRecoveryHandoff,
  ControlStore,
  GroupMLS,
  GroupPeer,
  GroupProtocolDefinition,
  RecoveryCompletion,
  RecoveryContinuation,
  RecoveryContinuationPort,
  RecoveryEvent,
  RecoveryReconciliation,
  ResyncProof,
} from '@kumiai/rpc'
import { applyResolved, controlSafetyHeld, isHardControlHold } from '@kumiai/rpc'

import { createRegistryCheckpointService } from './checkpoint.js'
import { copyStoredValue, sameStoredValue } from './memory-incarnation-stores.js'
import type { RecoveryRouting } from './mls.js'
import {
  GroupStateConflictError,
  GroupUnavailableError,
  RegistryResyncRefusedError,
  RegistryRetireHookError,
  RegistrySourceMovedError,
} from './persistence-errors.js'
import type { GroupKey, GroupTransaction } from './persistence-types.js'
import {
  RecoveryCandidateError,
  reconcileRecoveryCapture,
  restoreRecoveryCandidate,
} from './recovery.js'
import { validateCapturedRecoveryRecord } from './recovery-record.js'
import { registryRecoveryCoordinator } from './registry/recovery-coordinator.js'
import { RetainedTrustUnavailableError, registrySafety } from './registry/safety.js'
import { createRecoverySwitchFactory, toRegistrySwitchWrite } from './registry/switch-write.js'
import type { GroupHandleRegistry, RegistryRecoverySource } from './registry/types.js'
import type { RecoveryEnvironment } from './registry/validation.js'

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
export type RegistryPeerOptions = {
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
  | { kind: 'starting' | 'running' | 'switching' | 'pending' | 'disposed' }
  | { kind: 'failed'; error: unknown }
export type RegistryPeer = {
  peer(): Peer | null
  installedKey(): GroupKey
  status(): RegistryPeerStatus
  ready: Promise<void>
  dispose(): void
  drained(): Promise<void>
}
export type RegistryPeerParams = {
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
    recoveryEpochFloor?: number,
  ) => Promise<void>
  createMLS(
    key: GroupKey,
    onConfirmedRecovery: (handoff: ConfirmedRecoveryHandoff) => void,
  ): GroupMLS | Promise<GroupMLS>
  createPeer(key: GroupKey, options: RegistryPeerOptions): Promise<Peer>
}

export async function createRegistryPeer(params: RegistryPeerParams): Promise<RegistryPeer> {
  const { registry } = params
  const registered = registrySafety<GroupTransaction>(registry)
  if (registered === null) throw new TypeError('Registry peer requires a registered registry')
  const capability = registered
  const coordinator = registryRecoveryCoordinator(registry)
  const target = { ...params.target }
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
      recoveryEpochFloor = epoch,
    ) => {
      const sourceKey = record.source.key
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
              await control.apply(
                {
                  ...changes,
                  ...(snapshot.controlHold?.reason === 'acceptance-unknown'
                    ? { controlHold: null }
                    : {}),
                },
                mutationID,
              )
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
  let recoveryAttempt: Pick<CapturedRejoinRecord, 'id' | 'trigger'> | undefined
  function fail(error: unknown, record = recoveryAttempt): void {
    if (status.kind === 'failed') return
    status = { kind: 'failed', error }
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
    if (held !== null || isHardControlHold(control.controlHold))
      throw new GroupUnavailableError({
        reason: held === 'recovery-unavailable' ? held : 'invalid',
      })
    retire(requested)
    const generation = retirementGeneration
    const mls = await params.createMLS({ ...requested }, onConfirmedRecovery)
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
          checkpoints: createRegistryCheckpointService(registry, requested),
          recoveryOnly: control.rejoin !== null || !mls.sendAdmission().admissible,
          target: { ...target },
          onConfirmedRecovery,
          settleAcceptedRecovery,
          reconcileAcceptedRecovery: async (record, reply) => {
            const saved = await coordinator.readRecoveryRecord(key)
            if (
              reconcileConfirmedRecovery !== record.id ||
              record.stage !== 'confirmed' ||
              !sameStoredValue(saved, record)
            )
              throw new GroupStateConflictError('Accepted recovery changed before recapture')
            const resolved = await coordinator.resolveRecoverySwitch(record)
            if (resolved.kind !== 'rolled-back') return { kind: 'retry' }
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
  async function resume(): Promise<void> {
    let backoff = 100
    while (!disposed) {
      try {
        let record = await coordinator.readRecoveryRecord(key)
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
          if (record.trigger !== 'automatic')
            throw new GroupStateConflictError('Manual recovery requires host activation')
        }
        if (
          capability.held(key) !== null ||
          controlSafetyHeld(control) !== null ||
          isHardControlHold(control.controlHold)
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
          return
        }
        if (resolved.kind === 'rolled-back') {
          status = { kind: 'switching' }
          const control = await capability.entry.read(key.groupID, (reads) =>
            reads.control(key.incarnation),
          )
          if (capability.held(key) !== null || controlSafetyHeld(control) !== null)
            throw new GroupStateConflictError('Recovery source is held')
          const source = await registry.recoverySource(key.groupID)
          if (current !== null) await stopPeer(current)
          // Reread after source callbacks and completion writes have drained.
          record = await coordinator.readRecoveryRecord(key)
          if (record === null || !('format' in record) || record.stage !== 'confirmed')
            throw new GroupStateConflictError('Confirmed recovery moved after drainage')
          try {
            await accept(record, source)
          } catch (error) {
            if (
              !(
                error instanceof AcceptedRecoveryOriginMovedError ||
                error instanceof RegistryResyncRefusedError
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
  const ready = track(Promise.resolve().then(resume))
  void ready.catch((error: unknown) => {
    fail(error)
  })
  return {
    peer: () => current,
    installedKey: () => ({ ...key }),
    status: () => ({ ...status }),
    ready,
    dispose() {
      if (disposed) return
      disposed = true
      if (status.kind !== 'failed') status = { kind: 'disposed' }
      if (timer !== undefined) clearTimeout(timer)
      wake?.()
      unregister()
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
