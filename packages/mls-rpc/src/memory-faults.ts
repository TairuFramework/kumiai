import type { MemoryDatabase, MemoryTransaction, PendingCommitFault } from './persistence-types.js'

type SelectTransaction = (tx: MemoryTransaction) => boolean

export type MemoryFaultController = {
  forceCommittedRow(namespace: string, key: string, value: unknown | undefined): void
  failNext(
    point: 'after-first-write' | 'before-commit' | 'status-read',
    select?: SelectTransaction,
  ): void
  commitThenReject(select?: SelectTransaction): void
  rejectCommitPending(select?: SelectTransaction): PendingCommitFault
}

type FaultPoint = Parameters<MemoryFaultController['failNext']>[0]

type PendingFault = {
  fault: PendingCommitFault
  reject(finish: (outcome: 'commit' | 'rollback') => void): void
  waiting(): void
}

export type MemoryFaultState = {
  take(point: FaultPoint, tx?: MemoryTransaction): boolean
  takeCommit(tx: MemoryTransaction): 'reject' | PendingFault | undefined
}

const states = new WeakMap<MemoryDatabase, MemoryFaultController>()

export function registerMemoryFaults(
  db: MemoryDatabase,
  forceCommittedRow: MemoryFaultController['forceCommittedRow'],
): MemoryFaultState {
  const points = new Map<FaultPoint, SelectTransaction | undefined>()
  const commits: Array<{ value: 'reject' | PendingFault; select?: SelectTransaction }> = []
  states.set(db, {
    forceCommittedRow,
    failNext(point, select) {
      points.set(point, select)
    },
    commitThenReject(select) {
      commits.push({ value: 'reject', select })
    },
    rejectCommitPending(select) {
      let rejected!: () => void
      let waiting!: () => void
      let finishBackend!: (outcome: 'commit' | 'rollback') => void
      let finished: 'commit' | 'rollback' | undefined
      const fault: PendingCommitFault = {
        rejected: new Promise<void>((resolve) => {
          rejected = resolve
        }),
        barrierWaiting: new Promise<void>((resolve) => {
          waiting = resolve
        }),
        async finish(outcome) {
          await fault.rejected
          if (finished !== undefined) {
            if (finished !== outcome) throw new Error('Backend ownership conflict')
            return
          }
          finishBackend(outcome)
          finished = outcome
        },
      }
      const value: PendingFault = {
        fault,
        reject(finish) {
          finishBackend = finish
          rejected()
        },
        waiting() {
          waiting()
        },
      }
      commits.push({ value, select })
      return fault
    },
  })
  return {
    take(point, tx) {
      const select = points.get(point)
      if (select !== undefined && (tx === undefined || !select(tx))) return false
      return points.delete(point)
    },
    takeCommit(tx) {
      const index = commits.findIndex(({ select }) => select === undefined || select(tx))
      if (index === -1) return undefined
      return commits.splice(index, 1)[0]?.value
    },
  }
}

export function memoryFaults(db: MemoryDatabase): MemoryFaultController {
  const controller = states.get(db)
  if (controller === undefined) throw new TypeError('Not a memory transaction database')
  return controller
}
