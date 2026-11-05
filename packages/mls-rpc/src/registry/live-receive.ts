import {
  decodeClientState,
  denyApplicationSend,
  type GroupHandle,
  readMessageAAD,
  readMessageEpoch,
  restrictCommitAuthoring,
} from '@kumiai/mls'
import { decodeAppAAD, FrameEpochError, GroupSafetyHeldError, type SafetyHold } from '@kumiai/rpc'
import { sha256 } from '@noble/hashes/sha2.js'

import { assertOpenableEpoch } from '../crypto.js'
import { sameStoredValue } from '../memory-incarnation-stores.js'
import type { OwnerQueues } from '../owner-queue.js'
import { ReentrantOwnershipError } from '../persistence-errors.js'
import { type ColdEnvironment, copyRecord } from './cold.js'
import type { LiveSlot } from './live-send.js'
import { ApplicationLeaseUnavailableError } from './live-send.js'
import { receiveProjection } from './reserve.js'
import type { SourceCryptoScope } from './source-crypto-commands.js'
import type {
  ReadableGroupState,
  ReceiveInput,
  ReceiveResult,
  RegistryHandleAccess,
} from './types.js'

export const registryReceiveSlots = new WeakMap<RegistryHandleAccess, LiveSlot>()
export const receiveInstrumentation = new WeakMap<LiveSlot, { rebuilt?(): void; cap?: number }>()

export function setReceiveBase(slot: LiveSlot, record: ReadableGroupState): void {
  if (slot.consumed.incarnation !== null && record.incarnation < slot.consumed.incarnation) return
  if (
    slot.base !== null &&
    slot.base.incarnation === record.incarnation &&
    slot.base.version > record.version
  )
    return
  if (slot.consumed.incarnation !== record.incarnation) {
    slot.consumed = { incarnation: record.incarnation, epochs: new Map(), closed: new Set() }
    slot.receive = null
    slot.receiveDigest = null
  }
  slot.base = copyRecord(record)
  const state = decodeClientState(record.state)
  if (state !== undefined) {
    const retained = new Set([
      record.epoch,
      ...Array.from(state.historicalReceiverData.keys(), Number),
    ])
    for (const epoch of slot.consumed.epochs.keys())
      if (!retained.has(epoch)) slot.consumed.epochs.delete(epoch)
    for (const epoch of slot.consumed.closed)
      if (!retained.has(epoch)) slot.consumed.closed.delete(epoch)
  }
}

export function createLiveReceive(params: {
  owners: OwnerQueues
  slot: LiveSlot
  environment: ColdEnvironment
  assertAvailable(): void
  safetyHeld(): SafetyHold
  accounting(): Promise<void>
  waitForMaintenanceGate(signal: AbortSignal): Promise<void> | undefined
  refresh(): Promise<void>
  diagnoseFailure(error: unknown): Promise<void>
}) {
  const { slot } = params
  let refreshing: Promise<void> | null = null
  function assertAvailable(): void {
    params.assertAvailable()
    const held = params.safetyHeld()
    if (held !== null) throw new GroupSafetyHeldError(held)
  }
  function track<T>(pending: Promise<T>): Promise<T> {
    slot.inflight.add(pending)
    void pending.then(
      () => slot.inflight.delete(pending),
      () => slot.inflight.delete(pending),
    )
    return pending
  }
  function refresh(): Promise<void> | null {
    if (refreshing !== null) return refreshing
    if (slot.base !== null) return null
    const signal = slot.cancellation.signal
    const pending = track(
      params.owners.detached(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        try {
          if (signal.aborted) return
          await params.waitForMaintenanceGate(signal)
          if (signal.aborted) return
          assertAvailable()
          await params.refresh()
        } catch (error) {
          if (error instanceof ReentrantOwnershipError) throw error
          await params.diagnoseFailure(error)
        }
      }),
    )
    refreshing = pending
    const finished = () => {
      if (refreshing === pending) refreshing = null
    }
    void pending.then(finished, finished)
    return pending
  }
  slot.refresh = refresh
  async function owned(
    inputs: Array<ReceiveInput>,
    scope: SourceCryptoScope,
  ): Promise<Array<ReceiveResult>> {
    if (inputs.length > 64) throw new RangeError('App batch exceeds 64 frames')
    const frames = inputs.map(({ ciphertext, expectedAAD }) => ({
      ciphertext: ciphertext.slice(),
      expectedAAD: expectedAAD?.slice(),
    }))
    const signal = slot.cancellation.signal
    function assertCallAvailable(): void {
      scope.assertLive()
      if (signal.aborted) throw signal.reason
      assertAvailable()
    }
    assertCallAvailable()
    if (slot.base === null) throw new ApplicationLeaseUnavailableError('cold')
    const base = slot.base
    const state = decodeClientState(base.state)
    if (state === undefined) throw new ApplicationLeaseUnavailableError('cold')
    const digest = sha256(receiveProjection(state))
    let scratch: GroupHandle
    if (slot.receive === null || !sameStoredValue(digest, slot.receiveDigest)) {
      const handle = denyApplicationSend(
        restrictCommitAuthoring(await params.environment.restore(copyRecord(base))),
      )
      assertCallAvailable()
      scope.protect(handle)
      scratch = handle
      receiveInstrumentation.get(slot)?.rebuilt?.()
    } else scratch = scope.protect(slot.receive)
    const handle = scratch
    const unsubscribe = scope.onRevoke(() => {
      if (slot.receive === handle) {
        slot.receive = null
        slot.receiveDigest = null
      }
    })
    try {
      const current = Number(handle.epoch)
      const retained = new Set([
        current,
        ...Array.from(handle.state.historicalReceiverData.keys(), Number),
      ])
      const consumed = {
        incarnation: slot.consumed.incarnation,
        epochs: new Map(
          [...slot.consumed.epochs].map(([epoch, tuples]) => [epoch, new Set(tuples)]),
        ),
        closed: new Set(slot.consumed.closed),
      }
      for (const epoch of consumed.epochs.keys())
        if (!retained.has(epoch)) consumed.epochs.delete(epoch)
      for (const epoch of consumed.closed) if (!retained.has(epoch)) consumed.closed.delete(epoch)
      const cap =
        receiveInstrumentation.get(slot)?.cap ??
        handle.listMembers().length * 500 * retained.size + 1_024
      const count = () =>
        [...consumed.epochs.values()].reduce((sum, bucket) => sum + bucket.size, 0)
      function makeRoom(): void {
        while (count() > cap) {
          const oldest = [...consumed.epochs.keys()]
            .filter((epoch) => epoch !== current)
            .sort((a, b) => a - b)[0]
          if (oldest === undefined) return
          consumed.epochs.delete(oldest)
          consumed.closed.add(oldest)
        }
      }
      makeRoom()
      const results: Array<ReceiveResult> = []
      for (const { ciphertext, expectedAAD } of frames) {
        const aad = readMessageAAD(ciphertext)
        const refuse = (
          reason:
            | 'log-intent'
            | 'invalid'
            | 'closed-epoch'
            | 'generation-bound'
            | 'consumed'
            | 'capacity',
        ): ReceiveResult => ({ kind: 'refused', reason })
        if (aad !== null && decodeAppAAD(aad)?.intent === 'log') {
          results.push(refuse('log-intent'))
          continue
        }
        if (expectedAAD === undefined || !sameStoredValue(aad, expectedAAD)) {
          results.push(refuse('invalid'))
          continue
        }
        const messageEpoch = readMessageEpoch(ciphertext)
        if (messageEpoch === undefined) {
          results.push(refuse('invalid'))
          continue
        }
        const epoch = Number(messageEpoch)
        try {
          assertOpenableEpoch(handle, ciphertext)
        } catch (error) {
          if (!(error instanceof FrameEpochError)) throw error
          results.push({
            kind: 'refused',
            reason: epoch > current ? 'future-epoch' : 'past-epoch',
            frameEpoch: epoch,
            handleEpoch: current,
          })
          continue
        }
        if (consumed.closed.has(epoch)) {
          results.push(refuse('closed-epoch'))
          continue
        }
        let sender: Awaited<ReturnType<GroupHandle['readSenderData']>>
        try {
          sender = await scope.call(() => handle.readSenderData(ciphertext))
        } catch {
          sender = null
        }
        assertCallAvailable()
        if (sender === null) {
          results.push(refuse('invalid'))
          continue
        }
        if (sender.generation >= 500) {
          results.push(refuse('generation-bound'))
          continue
        }
        const tuple = `${sender.leaf}:${sender.generation}`
        if (consumed.epochs.get(epoch)?.has(tuple)) {
          results.push(refuse('consumed'))
          continue
        }
        // A refusal never closes a bucket or consumes capacity.
        const reclaimable = [...consumed.epochs].some(
          ([epoch, bucket]) => epoch !== current && bucket.size !== 0,
        )
        if (count() >= cap && !reclaimable) {
          results.push(refuse('capacity'))
          continue
        }
        try {
          const opened = await scope.call(() => handle.decrypt(ciphertext, { expectedAAD }))
          assertCallAvailable()
          const bucket = consumed.epochs.get(epoch) ?? new Set<string>()
          bucket.add(tuple)
          consumed.epochs.set(epoch, bucket)
          makeRoom()
          results.push({
            kind: 'opened',
            ...opened,
            aad: expectedAAD.slice(),
            frameEpoch: epoch,
            handleEpoch: current,
          })
        } catch (error) {
          results.push({ kind: 'refused', reason: 'invalid', error })
        }
        assertCallAvailable()
      }
      assertCallAvailable()
      slot.receive = handle
      slot.receiveDigest = digest
      slot.consumed = consumed
      return results
    } finally {
      unsubscribe()
    }
  }
  return { owned, refresh }
}
