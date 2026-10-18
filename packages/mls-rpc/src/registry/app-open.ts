import {
  type GroupHandle,
  type Relinquished,
  readMessageAAD,
  readMessageEpoch,
  relinquishSend,
} from '@kumiai/mls'
import {
  appFrameIdempotencyKey,
  compareLogPositions,
  decodeAppEventPlaintext,
  frameID,
  GroupSafetyHeldError,
  isAppLogPosition,
  sortPendingAppFrames,
} from '@kumiai/rpc'

import type { ControlRead } from '../access.js'
import type { EntryCapability, EntryReads } from '../entry-capability.js'
import { copyStoredValue, sameStoredValue } from '../memory-incarnation-stores.js'
import { DisplacedGroupHandleError, GroupStateConflictError } from '../persistence-errors.js'
import {
  type AppPoisonRecord,
  type GroupStores,
  type GroupTransaction,
  MAX_OPEN_BATCH_FRAMES,
  type OpenAppInput,
  type OpenAppResult,
  type PendingAppFrame,
  type PreOpenAppFrameRef,
  RECEIVE_SAVE_ATTEMPTS,
} from '../persistence-types.js'
import type { RegistryOwner } from './access.js'
import { RetainedTrustUnavailableError } from './safety.js'
import type { ReadableGroupState, RegistryHandleAccess } from './types.js'

function sameOccurrence(a: PreOpenAppFrameRef, b: PreOpenAppFrameRef): boolean {
  return (
    a.id === b.id && a.topicID === b.topicID && a.segment === b.segment && a.position === b.position
  )
}
class Noop extends Error {
  #results: Array<OpenAppResult>
  constructor({ results = [] }: { results?: Array<OpenAppResult> } = {}) {
    super('No app transition')
    this.#results = results
  }
  get results(): Array<OpenAppResult> {
    return this.#results
  }
}

export function createRegistryAppOpen<TTx extends GroupTransaction>(params: {
  owner: RegistryOwner
  capability: EntryCapability<TTx>
  isolated(reads: EntryReads, assertMutationSafety?: () => void): Promise<ControlRead>
  recordFor(
    captured: Relinquished,
    value: RegistryOwner['value'],
  ): Promise<{ record: ReadableGroupState }>
  assertAvailable(): void
  assertCurrent(): void
  assertSafety(): void
  assertWorkSafety(stores: GroupStores<TTx>): Promise<void>
  publish(): void
  diagnoseFailure(error: unknown): Promise<void>
}): Pick<RegistryHandleAccess, 'openBatch' | 'pending'> {
  const { owner, capability } = params
  const n = owner.key.incarnation
  async function openBatch(inputs: Array<OpenAppInput>): Promise<Array<OpenAppResult>> {
    if (inputs.length === 0) return []
    if (inputs.length > MAX_OPEN_BATCH_FRAMES) throw new RangeError('App batch exceeds 64 frames')
    const frames = copyStoredValue(inputs)
    for (const { frame } of frames) {
      if (frame.groupID !== owner.key.groupID || frame.incarnation !== n)
        throw new DisplacedGroupHandleError('App frame belongs to another incarnation')
    }
    params.assertAvailable()
    try {
      for (let attempt = 0; ; attempt++) {
        const mutationID = crypto.randomUUID()
        let receiveConflict: GroupStateConflictError | undefined
        try {
          return await capability.run(
            { groupID: owner.key.groupID, mutationID },
            async (reads) => {
              params.assertSafety()
              const { handle, source } = await params.isolated(reads, params.assertSafety)
              const value = owner.value
              const lifetime = await reads.lifetime()
              const results: Array<OpenAppResult> = []
              const seen = new Map<string, { frame: PreOpenAppFrameRef; result: OpenAppResult }>()
              const cursors = new Map<string, string | null>()
              const puts: Array<PendingAppFrame> = []
              const poisons: Array<AppPoisonRecord> = []
              const handleEpoch = Number(handle.epoch)
              async function open({
                frame,
                ciphertext,
                expectedAAD,
              }: OpenAppInput): Promise<OpenAppResult> {
                const refuse = (
                  reason: 'invalid-ciphertext' | 'wrong-aad' | 'duplicate' | 'invalid-position',
                ): OpenAppResult => ({ kind: 'refused', frame, reason, keyConsumed: false })
                if (!isAppLogPosition(frame.position)) return refuse('invalid-position')
                if (!cursors.has(frame.topicID))
                  cursors.set(frame.topicID, await reads.appCursor(n, frame.topicID))
                const cursor = cursors.get(frame.topicID)
                if (cursor != null && compareLogPositions(cursor, frame.position) >= 0)
                  return refuse('duplicate')
                const earlier = seen.get(frame.id)
                if (earlier !== undefined)
                  return sameOccurrence(earlier.frame, frame) ? earlier.result : refuse('duplicate')
                const saved = await reads.appFrame(n, frame.id)
                const previous = saved.pending?.frame ?? saved.poison?.frame
                if (previous !== undefined) {
                  if (!sameOccurrence(previous, frame)) return refuse('duplicate')
                  return saved.pending !== null
                    ? { kind: 'opened', record: saved.pending, handleEpoch }
                    : { kind: 'refused', frame, reason: 'malformed-plaintext', keyConsumed: true }
                }
                const messageEpoch = readMessageEpoch(ciphertext)
                if (messageEpoch === undefined) return refuse('invalid-ciphertext')
                const epoch = Number(messageEpoch)
                if (epoch > handleEpoch)
                  return {
                    kind: 'held',
                    frame,
                    reason: 'future-epoch',
                    frameEpoch: epoch,
                    handleEpoch,
                  }
                if (epoch < handleEpoch && !handle.state.historicalReceiverData.has(messageEpoch))
                  return {
                    kind: 'refused',
                    frame,
                    reason: 'past-epoch',
                    keyConsumed: false,
                    frameEpoch: epoch,
                    handleEpoch,
                  }
                if (
                  expectedAAD !== undefined &&
                  !sameStoredValue(readMessageAAD(ciphertext), expectedAAD)
                )
                  return refuse('wrong-aad')
                const decoded: { value: ReturnType<typeof decodeAppEventPlaintext> } = {
                  value: null,
                }
                let opened: Awaited<ReturnType<GroupHandle['decryptStaged']>>
                try {
                  opened = await handle.decryptStaged(
                    ciphertext,
                    { expectedAAD },
                    async (_state, opened) => {
                      decoded.value = decodeAppEventPlaintext(opened.payload)
                    },
                  )
                } catch {
                  return refuse('invalid-ciphertext')
                }
                if (decoded.value === null) {
                  poisons.push({ frame, reason: 'malformed-plaintext', keyConsumed: true })
                  return {
                    kind: 'refused',
                    frame,
                    reason: 'malformed-plaintext',
                    keyConsumed: true,
                  }
                }
                const openedFrame = { ...frame, procedure: decoded.value.procedure }
                const record: PendingAppFrame = {
                  frame: openedFrame,
                  payload: opened.payload.slice(),
                  senderDID: opened.senderDID,
                  epoch,
                  idempotencyKey: appFrameIdempotencyKey(openedFrame),
                }
                puts.push(record)
                return { kind: 'opened', record, handleEpoch }
              }
              for (const input of frames) {
                if (input.frame.id !== frameID(input.frame.topicID, input.ciphertext)) {
                  results.push({
                    kind: 'refused',
                    frame: input.frame,
                    reason: 'invalid-ciphertext',
                    keyConsumed: false,
                  })
                  continue
                }
                const result = await open(input)
                if (!seen.has(input.frame.id))
                  seen.set(input.frame.id, { frame: input.frame, result })
                results.push(result)
              }
              if (puts.length === 0 && poisons.length === 0) throw new Noop({ results })
              return {
                expected: lifetime,
                mutationID,
                value: {
                  source,
                  record: (await params.recordFor(await relinquishSend(handle), value)).record,
                  puts,
                  poisons,
                  results,
                },
              }
            },
            async (stores, prepared) => {
              params.assertCurrent()
              await params.assertWorkSafety(stores)
              const target = stores.incarnation(n)
              const state = await target.state.load()
              if (state?.version !== prepared.source.stateVersion) {
                receiveConflict = new GroupStateConflictError('Receive source moved')
                throw receiveConflict
              }
              // The owner gate spans prepare and work, including off-clock pending/poison writes.
              const cursors = new Map<string, string | null>()
              for (const { frame } of [...prepared.puts, ...prepared.poisons]) {
                if (!cursors.has(frame.topicID))
                  cursors.set(frame.topicID, await target.cursor.load(frame.topicID))
                const cursor = cursors.get(frame.topicID)
                if (cursor != null && compareLogPositions(cursor, frame.position) >= 0) {
                  receiveConflict = new GroupStateConflictError('Receive cursor moved')
                  throw receiveConflict
                }
              }
              await target.state.save(prepared.record)
              await target.pending.put(prepared.puts)
              await target.pending.poison(prepared.poisons)
              return prepared.results
            },
          )
        } catch (error) {
          if (error instanceof Noop) return error.results
          if (error !== receiveConflict || attempt + 1 >= RECEIVE_SAVE_ATTEMPTS) throw error
        }
      }
    } catch (error) {
      await params.diagnoseFailure(error)
      if (error instanceof RetainedTrustUnavailableError)
        // biome-ignore lint/style/useErrorCause: Mutation boundaries expose the diagnosed safety reason.
        throw new GroupSafetyHeldError('recovery-unavailable')
      throw error
    } finally {
      params.publish()
    }
  }
  return {
    openBatch,
    pending: {
      async list() {
        params.assertAvailable()
        try {
          return await capability.read(owner.key.groupID, async (reads) => {
            params.assertCurrent()
            return copyStoredValue(sortPendingAppFrames(await reads.pendingFrames(n)))
          })
        } catch (error) {
          await params.diagnoseFailure(error)
          throw error
        } finally {
          params.publish()
        }
      },
      async complete(id) {
        params.assertAvailable()
        try {
          await capability.run(
            { groupID: owner.key.groupID, mutationID: crypto.randomUUID() },
            async (reads) => {
              params.assertCurrent()
              const saved = await reads.appFrame(n, id)
              if (saved.pending === null && saved.poison === null) throw new Noop()
              return { expected: await reads.lifetime(), value: undefined }
            },
            async (stores) => {
              params.assertCurrent()
              await stores.incarnation(n).pending.complete([id])
            },
          )
        } catch (error) {
          if (error instanceof Noop) return
          await params.diagnoseFailure(error)
          throw error
        } finally {
          params.publish()
        }
      },
    },
  }
}
