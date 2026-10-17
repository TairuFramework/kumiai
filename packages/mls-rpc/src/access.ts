import { type GroupHandle, restrictCommitAuthoring } from '@kumiai/mls'
import {
  type AdoptionExpected,
  type AdoptionWrite,
  type AdoptionWriteFactory,
  type CheckpointRecord,
  type ControlSnapshot,
  type ControlStore,
  ControlWriteNotCommittedError,
  type GroupKey,
  type PendingAppFrame,
  type SendAdmission,
} from '@kumiai/rpc'

import { DisplacedGroupHandleError } from './persistence-errors.js'

type PersistOpened = (stagedState: Uint8Array, record: PendingAppFrame) => Promise<void>

export type ControlRead = { handle: GroupHandle; source: AdoptionExpected }
export type ControlReadScope = ControlRead & {
  refresh(): Promise<ControlRead>
  loadControl(control?: ControlStore): Promise<ControlSnapshot>
  loadCheckpoints?(): Promise<Array<CheckpointRecord>>
}

export type ControlHandleAccess = Pick<
  HandleAccess,
  'epoch' | 'admission' | 'read' | 'readControl' | 'mutate' | 'replace'
>

export type HandleAccess = {
  readControl<TValue>(fn: (scope: ControlReadScope) => Promise<TValue>): Promise<TValue>
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
    prepare?: (current: GroupHandle, source: AdoptionExpected) => Promise<boolean>,
  ): Promise<void>
  open<TValue>(
    fn: (handle: GroupHandle, persistOpened: PersistOpened) => Promise<TValue>,
    persistOpened: PersistOpened,
  ): Promise<TValue>
}

export type SimpleHandleAccessParams = {
  key: GroupKey
  stateVersion: () => number | Promise<number>
  handle: () => GroupHandle
  adopt: (next: GroupHandle) => void | Promise<void>
  persist?: (handle: GroupHandle, write?: AdoptionWrite) => void | Promise<void>
}

export function simpleHandleAccess(params: SimpleHandleAccessParams): HandleAccess {
  const key = { ...params.key }
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
  const readControl = async (): Promise<ControlRead> => {
    const handle = restrictCommitAuthoring(params.handle())
    return {
      handle,
      source: {
        key: { ...key },
        stateVersion: await params.stateVersion(),
        identity: {
          ...key,
          epoch: Number(handle.epoch),
          authenticator: handle.state.keySchedule.epochAuthenticator.slice(),
        },
      },
    }
  }
  const save = async (
    handle: GroupHandle,
    adoption?: AdoptionWriteFactory,
    current?: GroupHandle,
  ): Promise<void> => {
    const write = adoption?.({
      incarnation: key.incarnation,
      epochAfter: Number(handle.epoch),
      removed: !handle
        .listMembers()
        .some((member) => member.leafIndex === handle.state.privatePath.leafIndex),
      epochAuthenticator: handle.state.keySchedule.epochAuthenticator.slice(),
    })
    if (
      current !== undefined &&
      write?.expected?.journal !== undefined &&
      write.expected.acceptance !== undefined
    )
      await current.carryReceiveProgress(handle)
    await params.persist?.(handle, write)
  }

  return {
    epoch: () => publishedAdmission.epoch,
    admission: () => publishedAdmission,
    readControl: (fn) =>
      serialise(async () => {
        let active = true
        const refresh = async (): Promise<ControlRead> => {
          if (!active) throw new Error('Control read scope has ended')
          const value = await readControl()
          if (!active) throw new Error('Control read scope has ended')
          return value
        }
        const loadControl = async (control?: ControlStore): Promise<ControlSnapshot> => {
          if (!active) throw new Error('Control read scope has ended')
          if (control === undefined) throw new TypeError('A control store is required')
          if (control.key.groupID !== key.groupID || control.key.incarnation !== key.incarnation)
            throw new DisplacedGroupHandleError('Control store belongs to another incarnation')
          const value = await control.load()
          if (!active) throw new Error('Control read scope has ended')
          return value
        }
        try {
          return await fn({ ...(await readControl()), refresh, loadControl })
        } finally {
          active = false
        }
      }),
    read: (fn) => serialise(async () => await fn(restrictCommitAuthoring(params.handle()))),
    mutate: (fn, adoption) =>
      serialise(async () => {
        if (adoption != null && params.persist == null) {
          throw new ControlWriteNotCommittedError('adoption requires a persist callback')
        }
        const handle = restrictCommitAuthoring(params.handle())
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
        restrictCommitAuthoring(next)
        const current = await readControl()
        if (prepare != null && !(await prepare(current.handle, current.source))) return
        if (adoption != null && params.persist == null) {
          throw new ControlWriteNotCommittedError('adoption requires a persist callback')
        }
        await save(next, adoption, current.handle)
        await params.adopt(next)
        publishedAdmission = next.sendAdmission()
        next.confirmAdopted()
      }),
    open: (fn, persistOpened) =>
      serialise(async () => {
        const handle = restrictCommitAuthoring(params.handle())
        const result = await fn(handle, persistOpened)
        publishedAdmission = handle.sendAdmission()
        return result
      }),
  }
}
