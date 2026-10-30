import type { BatchBudget, BatchKind, GroupBatchScheduler } from '@kumiai/rpc'

import type { GroupBatchOptions } from './persistence-types.js'

export function groupBatchOptions(options: GroupBatchOptions = {}): Required<GroupBatchOptions> {
  const maxBatchFrames = options.maxBatchFrames ?? 64
  const maxBatchDelayMs = options.maxBatchDelayMs ?? 2
  const maxBatchWorkMs = options.maxBatchWorkMs ?? 8
  if (!Number.isInteger(maxBatchFrames) || maxBatchFrames <= 0)
    throw new RangeError('maxBatchFrames must be a positive finite integer')
  if (!Number.isFinite(maxBatchDelayMs) || maxBatchDelayMs < 0)
    throw new RangeError('maxBatchDelayMs must be finite and non-negative')
  if (!Number.isFinite(maxBatchWorkMs) || maxBatchWorkMs <= 0)
    throw new RangeError('maxBatchWorkMs must be finite and positive')
  return { maxBatchFrames, maxBatchDelayMs, maxBatchWorkMs }
}

function batchBudget(
  options: Required<GroupBatchOptions>,
  kind: BatchKind,
  now: () => number,
): BatchBudget {
  const maxFrames = kind === 'open' ? Math.min(64, options.maxBatchFrames) : options.maxBatchFrames
  let started: number | undefined
  let taken = 0
  const begin = () => {
    started ??= now()
  }
  return {
    maxFrames,
    maxWorkMs: options.maxBatchWorkMs,
    now,
    begin,
    take() {
      begin()
      if (taken >= maxFrames) return false
      // Setup cannot pre-empt the first operation; subsequent operations honour the boundary.
      if (taken > 0 && now() - (started as number) >= options.maxBatchWorkMs) return false
      taken++
      return true
    },
  }
}

type ReadyWork = {
  source: string
  kind: BatchKind
  signal?: AbortSignal
  run(budget: BatchBudget): Promise<unknown>
  resolve(value: unknown): void
  reject(reason: unknown): void
  withdraw(): void
}

export function createGroupBatchScheduler(params: {
  options?: GroupBatchOptions
  now?: () => number
}): GroupBatchScheduler {
  const options = groupBatchOptions(params.options)
  const now = params.now ?? Date.now
  const ready: Array<ReadyWork> = []
  const served = new Set<string>()
  let active = false
  let closed: Error | undefined

  function pump(): void {
    if (active || closed !== undefined || ready.length === 0) return
    if (ready.every((work) => served.has(work.source))) served.clear()
    let index = ready.findIndex((work) => !served.has(work.source) && work.kind === 'control')
    if (index < 0) index = ready.findIndex((work) => !served.has(work.source))
    const work = ready.splice(index, 1)[0]
    if (work === undefined) return
    active = true
    served.add(work.source)
    work.signal?.removeEventListener('abort', work.withdraw)
    const budget = batchBudget(options, work.kind, now)
    const run = async (): Promise<void> => {
      try {
        work.resolve(await work.run(budget))
      } catch (error) {
        work.reject(error)
      } finally {
        // An unresolved callback/proof keeps this turn, even after source withdrawal.
        active = false
        pump()
      }
    }
    void run()
  }

  return {
    schedule<T>(work: {
      source: string
      kind: BatchKind
      signal?: AbortSignal
      run(budget: BatchBudget): Promise<T>
    }): Promise<T> {
      if (closed !== undefined) return Promise.reject(closed)
      if (work.signal?.aborted) return Promise.reject(work.signal.reason)
      return new Promise<T>((resolve, reject) => {
        const pending: ReadyWork = {
          ...work,
          resolve: (value) => resolve(value as T),
          reject,
          withdraw() {
            const index = ready.indexOf(pending)
            if (index < 0) return
            ready.splice(index, 1)
            pending.signal?.removeEventListener('abort', pending.withdraw)
            reject(pending.signal?.reason)
          },
        }
        ready.push(pending)
        pending.signal?.addEventListener('abort', pending.withdraw, { once: true })
        pump()
      })
    },
    close(reason) {
      closed ??= reason
      for (const work of ready.splice(0)) {
        work.signal?.removeEventListener('abort', work.withdraw)
        work.reject(closed)
      }
    },
  }
}
