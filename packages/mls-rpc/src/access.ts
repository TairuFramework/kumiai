import type { GroupHandle } from '@kumiai/mls'
import {
  type AdoptionWrite,
  type AdoptionWriteFactory,
  ControlWriteNotCommittedError,
  type PendingAppFrame,
  type SendAdmission,
} from '@kumiai/rpc'

type PersistOpened = (stagedState: Uint8Array, record: PendingAppFrame) => Promise<void>

export type HandleAccess = {
  /** Published with admission after mutation/open and after replacement adoption resolves. */
  epoch(): number
  /** Lock-free snapshot. During adoption it describes the epoch being left. */
  admission(): SendAdmission
  read<TValue>(fn: (handle: GroupHandle) => TValue | Promise<TValue>): Promise<TValue>
  mutate<TValue>(
    fn: (handle: GroupHandle, persist: (handle: GroupHandle) => Promise<void>) => Promise<TValue>,
    adoption?: AdoptionWriteFactory,
  ): Promise<TValue>
  /** Check identity and carry progress under the replacement's persistence gate. */
  replace(
    next: GroupHandle,
    adoption?: AdoptionWriteFactory,
    prepare?: (current: GroupHandle) => Promise<boolean>,
  ): Promise<void>
  open<TValue>(
    fn: (handle: GroupHandle, persistOpened: PersistOpened) => Promise<TValue>,
    persistOpened: PersistOpened,
  ): Promise<TValue>
}

export type SimpleHandleAccessParams = {
  handle: () => GroupHandle
  adopt: (next: GroupHandle) => void | Promise<void>
  persist?: (handle: GroupHandle, write?: AdoptionWrite) => void | Promise<void>
}

export function simpleHandleAccess(params: SimpleHandleAccessParams): HandleAccess {
  let publishedAdmission = params.handle().sendAdmission()
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
  const save = async (handle: GroupHandle, adoption?: AdoptionWriteFactory): Promise<void> => {
    const write = adoption?.({
      epochAfter: Number(handle.epoch),
      removed: !handle
        .listMembers()
        .some((member) => member.leafIndex === handle.state.privatePath.leafIndex),
      epochAuthenticator: handle.state.keySchedule.epochAuthenticator.slice(),
    })
    await params.persist?.(handle, write)
  }

  return {
    epoch: () => publishedAdmission.epoch,
    admission: () => publishedAdmission,
    read: (fn) => serialise(async () => await fn(params.handle())),
    mutate: (fn, adoption) =>
      serialise(async () => {
        if (adoption != null && params.persist == null) {
          throw new ControlWriteNotCommittedError('adoption requires a persist callback')
        }
        const handle = params.handle()
        let saved = false
        const persist = async (current: GroupHandle): Promise<void> => {
          await save(current, adoption)
          saved = true
        }
        const result = await fn(handle, persist)
        if (!saved) await save(handle, adoption)
        publishedAdmission = handle.sendAdmission()
        return result
      }),
    replace: (next, adoption, prepare) =>
      serialise(async () => {
        if (prepare != null && !(await prepare(params.handle()))) return
        if (adoption != null && params.persist == null) {
          throw new ControlWriteNotCommittedError('adoption requires a persist callback')
        }
        await save(next, adoption)
        await params.adopt(next)
        publishedAdmission = next.sendAdmission()
        next.confirmAdopted()
      }),
    open: (fn, persistOpened) =>
      serialise(async () => {
        const handle = params.handle()
        const result = await fn(handle, persistOpened)
        publishedAdmission = handle.sendAdmission()
        return result
      }),
  }
}
