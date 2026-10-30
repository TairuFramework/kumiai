import type { GroupKey } from './control/types.js'
import type { GroupCrypto, OpenAppInput, OpenAppResult } from './crypto.js'

export type BatchBudget = {
  maxFrames: number
  maxWorkMs: number
  now(): number
  begin(): void
  take(): boolean
}

export type BatchKind = 'control' | 'open' | 'completion' | 'settlement' | 'enqueue' | 'accounting'

export type GroupBatchScheduler = {
  schedule<T>(work: {
    source: string
    kind: BatchKind
    signal?: AbortSignal
    run(budget: BatchBudget): Promise<T>
  }): Promise<T>
  close(reason: Error): void
}

export type StreamingOpenResult = { consumed: number; results: Array<OpenAppResult> }

export type AppBatchBinding = {
  key: GroupKey
  scheduler: GroupBatchScheduler
  openReady(frames: Array<OpenAppInput>, budget: BatchBudget): Promise<StreamingOpenResult>
}

const bindings = new WeakMap<GroupCrypto, AppBatchBinding>()

export function bindAppBatch(crypto: GroupCrypto, binding: AppBatchBinding): void {
  const existing = bindings.get(crypto)
  if (existing !== undefined && existing !== binding)
    throw new Error('Crypto already has an application batch binding')
  bindings.set(crypto, binding)
}

export function appBatch(crypto: GroupCrypto): AppBatchBinding | undefined {
  return bindings.get(crypto)
}
