import type { GroupKey } from './control/types.js'
import type { PreOpenAppFrameRef } from './crypto.js'
import type { GroupTransaction, HandlerCompletion } from './handler-completion.js'

export type AppCompletionCoverage = {
  key: GroupKey
  topicID: string
  generation: number
  previous: string | null
  through: string | null
  prefix: Array<{ frame: PreOpenAppFrameRef; state: 'pending' | 'dead' | 'completed' }>
}
export type AppCompletionCoverageSource = {
  capture(ids: Array<string>): Array<AppCompletionCoverage>
  current(coverage: AppCompletionCoverage): boolean
  committed(ids: Array<string>, coverage: Array<AppCompletionCoverage>): void
}
export type AppCompletionCoverageBinding = { advance(): Promise<void>; unbind(): void }

const registrations = new WeakMap<
  object,
  (source: AppCompletionCoverageSource) => AppCompletionCoverageBinding
>()

export function registerAppCompletionCoverage<TTx extends GroupTransaction>(
  completion: HandlerCompletion<TTx>,
  bind: (source: AppCompletionCoverageSource) => AppCompletionCoverageBinding,
): void {
  if (registrations.has(completion)) throw new TypeError('Completion coverage already registered')
  registrations.set(completion, bind)
}

export function bindAppCompletionCoverage<TTx extends GroupTransaction>(
  completion: HandlerCompletion<TTx>,
  source: AppCompletionCoverageSource,
): AppCompletionCoverageBinding | undefined {
  return registrations.get(completion)?.(source)
}
