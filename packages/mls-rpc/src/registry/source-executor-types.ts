import type { AdoptionExpected, GroupKey } from '@kumiai/rpc'

export type SourceBinding = { key: GroupKey; generation: number }
export type BoundSourceResult<TValue> = { binding: SourceBinding; value: TValue }
export type SourceCommand<TInput, TOutput> = { input: TInput; output: TOutput }
export type SourceCommands = {
  'source.inspect': SourceCommand<undefined, AdoptionExpected>
}
export type SourceExecutor = {
  execute<TName extends keyof SourceCommands>(request: {
    binding: SourceBinding
    command: TName
    input: SourceCommands[TName]['input']
    signal?: AbortSignal
  }): Promise<BoundSourceResult<SourceCommands[TName]['output']>>
}
export type DeviceLifecycle = {
  beforeUse(): Promise<void>
  assertCurrent(): void
}
export type SourceExecutorControl = {
  admit(key: GroupKey, purpose: 'source' | 'recovery' | 'destination'): Promise<SourceBinding>
  invalidate(key: GroupKey, reason: Error): void
  assertCurrent(binding: SourceBinding): void
}
