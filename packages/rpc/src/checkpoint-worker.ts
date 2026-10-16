import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'

import type { CheckpointRecord, CheckpointService } from './checkpoint-types.js'
import type { GroupKey } from './control/types.js'
import { assertLogPosition } from './cursor.js'
import type { HubMux } from './hub-mux.js'
import { checkpointTopic } from './topic.js'

type Cursor = Extract<CheckpointRecord, { kind: 'cursor' }>
type Publication = Extract<CheckpointRecord, { kind: 'publication' }>
type Params = {
  key: GroupKey
  mux: Pick<HubMux, 'onInbound' | 'fetchTopic' | 'publish'>
  recoverySecret: Uint8Array
  checkpoints: CheckpointService
  networkAllowed: () => boolean
  now: () => number
  random: () => number
}

export function createCheckpointWorker(params: Params): {
  start(): Promise<void>
  resume(): Promise<void>
  dispose(): Promise<void>
} {
  const { mux, checkpoints } = params
  const key = { ...params.key }
  const topicID = checkpointTopic(params.recoverySecret)
  const cursorID = `checkpoint-cursor:${key.incarnation}:${topicID}`
  let started = false
  let disposed = false
  let release: (() => void) | undefined
  let running: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let cursor: Cursor | undefined
  let receivePending = true
  let nextWakeAt = params.now() + 1000
  const seen = new Set<string>()
  const live = () => !disposed && params.networkAllowed()
  const sameKey = (row: CheckpointRecord) =>
    row.key.groupID === key.groupID && row.key.incarnation === key.incarnation

  function arm(delay: number): void {
    if (!started || disposed) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(
      () => {
        timer = undefined
        void resume()
      },
      Math.max(1, delay),
    )
  }

  async function saveCursor(): Promise<void> {
    if (!live() || cursor === undefined) return
    await checkpoints.updateRecords({ put: [cursor] })
  }

  async function turn(): Promise<void> {
    nextWakeAt = params.now() + 1000
    if (!live()) return
    if (release === undefined) {
      release = mux.onInbound(
        topicID,
        (_message, ack) => {
          ack()
          if (!live()) return
          receivePending = true
          arm(1)
        },
        { retention: 604800 },
      )
    }
    let records = await checkpoints.readRecords()
    if (!live()) return
    cursor = records.find(
      (row): row is Cursor => row.kind === 'cursor' && row.id === cursorID && sameKey(row),
    ) ?? {
      kind: 'cursor',
      id: cursorID,
      key,
      topicID,
      position: null,
    }
    cursor.schedule ??= {
      clock: params.now(),
      tokens: 8,
      refilledAt: params.now(),
      receiveAt: params.now(),
      retryDelay: 1000,
    }
    const schedule = cursor.schedule
    // A wall-clock rewind can delay work, but cannot mint rate or verification credit.
    const now = Math.max(params.now(), schedule.clock)
    schedule.clock = now
    const refill = Math.floor((now - schedule.refilledAt) / 1000)
    if (refill > 0) {
      schedule.tokens = Math.min(8, schedule.tokens + refill)
      schedule.refilledAt += refill * 1000
    }
    nextWakeAt = schedule.refilledAt + 1000
    for (const row of records) {
      if (row.kind !== 'publication' || !sameKey(row)) continue
      const deadline = row.accepted ? row.nextHeartbeatAt : row.retryAt
      if (deadline != null && deadline > now) nextWakeAt = Math.min(nextWakeAt, deadline)
    }
    await saveCursor()
    if (!live()) return

    while (live() && schedule.tokens >= 1) {
      let debt = records.find(
        (row): row is Publication => row.kind === 'publication' && sameKey(row) && !row.accepted,
      )
      if (debt === undefined) {
        const current = records.find(
          (row) => row.kind === 'fact' && sameKey(row) && row.supersededAt === null,
        )
        debt = records.find(
          (row): row is Publication =>
            row.kind === 'publication' &&
            sameKey(row) &&
            row.factID === current?.id &&
            row.accepted &&
            row.nextHeartbeatAt !== null &&
            row.nextHeartbeatAt <= now,
        )
        if (debt !== undefined) {
          debt = {
            ...debt,
            accepted: false,
            publishID: crypto.randomUUID(),
            retryAt: 0,
            retryDelay: 1000,
          }
          await checkpoints.updateRecords({ put: [debt] })
          if (!live()) return
        }
      }
      if (debt === undefined || (debt.retryAt ?? 0) > now) break
      if (debt.frame === null || debt.publishID === null) {
        await checkpoints.signInstalled(debt.factID)
        if (!live()) return
        records = await checkpoints.readRecords()
        if (!live()) return
        const debtID = debt.id
        debt = records.find(
          (row): row is Publication => row.kind === 'publication' && row.id === debtID,
        )
      }
      if (debt?.frame == null || debt.publishID === null) break
      // Reserve before handoff. An ambiguous network result still consumes the same budget.
      schedule.tokens--
      await saveCursor()
      if (!live()) return
      try {
        await mux.publish({
          topicID,
          payload: debt.frame.slice(),
          publishID: debt.publishID,
          retain: 'log',
        })
        if (!live()) return
        await checkpoints.updateRecords({
          put: [
            {
              ...debt,
              accepted: true,
              retryAt: 0,
              retryDelay: 1000,
              nextHeartbeatAt:
                Math.max(now, params.now()) + 1440000 + Math.floor(params.random() * 720000),
            },
          ],
        })
      } catch {
        if (!live()) return
        const delay = debt.retryDelay ?? 1000
        await checkpoints.updateRecords({
          put: [
            {
              ...debt,
              retryAt: Math.max(now, params.now()) + delay,
              retryDelay: Math.min(15000, delay * 2),
            },
          ],
        })
        break
      }
      if (!live()) return
      records = await checkpoints.readRecords()
    }

    if (!live() || !receivePending || now < schedule.receiveAt) return
    receivePending = false
    // Persist the work turn before fetching. Reconnect wakeups cannot bypass it.
    schedule.receiveAt = now + 1
    await saveCursor()
    if (!live()) return
    try {
      if (cursor.position !== null) assertLogPosition(cursor.position)
      const page = await mux.fetchTopic({
        topicID,
        ...(cursor.position === null ? {} : { after: cursor.position }),
        limit: 32,
      })
      if (!live()) return
      let frames = 0
      // 32 complete frames bound intake to 128 KiB and 64 signature checks.
      for (const message of page.messages) {
        if (!live() || frames >= 32) break
        assertLogPosition(message.sequenceID)
        if (cursor.position !== null && message.sequenceID <= cursor.position)
          throw new Error('Non-increasing checkpoint position')
        frames++
        if (message.payload.length <= 4096) {
          const hash = toB64U(sha256(message.payload))
          if (!seen.has(hash)) {
            await checkpoints.importCheckpoint(key, message.payload.slice())
            if (!live()) return
            seen.add(hash)
            if (seen.size > 256) seen.delete(seen.values().next().value as string)
          }
        }
        cursor.position = message.sequenceID
        await saveCursor()
      }
      schedule.retryDelay = 1000
      receivePending ||= page.messages.length >= 32
      await saveCursor()
    } catch {
      receivePending = true
      schedule.receiveAt = now + schedule.retryDelay
      schedule.retryDelay = Math.min(15000, schedule.retryDelay * 2)
      await saveCursor()
    }
  }

  function resume(): Promise<void> {
    if (!started || disposed) return Promise.resolve()
    if (running !== undefined) return running
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    let failed = false
    running = turn()
      .catch(() => {
        failed = true
      })
      .finally(() => {
        running = undefined
        const deadline =
          receivePending && cursor?.schedule !== undefined
            ? Math.min(nextWakeAt, cursor.schedule.receiveAt)
            : nextWakeAt
        const delay =
          failed || !live() ? 1000 : Math.min(1000, Math.max(1, deadline - params.now()))
        arm(delay)
      })
    return running
  }

  return {
    start() {
      started = true
      return resume()
    },
    resume,
    async dispose() {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      release?.()
      release = undefined
      await running
    },
  }
}
