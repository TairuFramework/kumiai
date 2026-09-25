import type { GroupHandle } from '@kumiai/mls'
import type { PendingAppFrame } from '@kumiai/rpc'

type PersistOpened = (stagedState: Uint8Array, record: PendingAppFrame) => Promise<void>

export type HandleAccess = {
  epoch(): number
  read<TValue>(fn: (handle: GroupHandle) => TValue | Promise<TValue>): Promise<TValue>
  mutate<TValue>(
    fn: (handle: GroupHandle, persist: (handle: GroupHandle) => Promise<void>) => Promise<TValue>,
  ): Promise<TValue>
  replace(next: GroupHandle): Promise<void>
  open<TValue>(
    fn: (handle: GroupHandle, persistOpened: PersistOpened) => Promise<TValue>,
    persistOpened: PersistOpened,
  ): Promise<TValue>
}

export type SimpleHandleAccessParams = {
  handle: () => GroupHandle
  adopt: (next: GroupHandle) => void | Promise<void>
  persist?: (handle: GroupHandle) => void | Promise<void>
}

export function simpleHandleAccess(params: SimpleHandleAccessParams): HandleAccess {
  let publishedEpoch = Number(params.handle().epoch)
  let tail: Promise<void> = Promise.resolve()
  const serialise = async <TValue>(fn: () => Promise<TValue>): Promise<TValue> => {
    const previous = tail
    let release: () => void = () => {}
    tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
  const save = async (handle: GroupHandle): Promise<void> => {
    await params.persist?.(handle)
  }

  return {
    epoch: () => publishedEpoch,
    read: (fn) => serialise(async () => await fn(params.handle())),
    mutate: (fn) =>
      serialise(async () => {
        const handle = params.handle()
        let saved = false
        const persist = async (current: GroupHandle): Promise<void> => {
          await save(current)
          saved = true
        }
        const result = await fn(handle, persist)
        if (!saved) await save(handle)
        publishedEpoch = Number(handle.epoch)
        return result
      }),
    replace: (next) =>
      serialise(async () => {
        await save(next)
        await params.adopt(next)
        publishedEpoch = Number(next.epoch)
      }),
    open: (fn, persistOpened) =>
      serialise(async () => {
        const handle = params.handle()
        const result = await fn(handle, persistOpened)
        publishedEpoch = Number(handle.epoch)
        return result
      }),
  }
}
