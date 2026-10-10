import type { MemoryDatabase, PendingCommitFault } from './persistence-types.js'

export type MemoryFaultController = {
  forceCommittedRow(namespace: string, key: string, value: unknown | undefined): void
  failNext(point: 'after-first-write' | 'before-commit' | 'status-read'): void
  commitThenReject(): void
  rejectCommitPending(): PendingCommitFault
}

type FaultPoint = Parameters<MemoryFaultController['failNext']>[0]

type PendingFault = {
  fault: PendingCommitFault
  reject(finish: (outcome: 'commit' | 'rollback') => void): void
  waiting(): void
}

export type MemoryFaultState = {
  take(point: FaultPoint): boolean
  takeCommit(): 'reject' | PendingFault | undefined
}

const states = new WeakMap<MemoryDatabase, MemoryFaultController>()

export function registerMemoryFaults(
  db: MemoryDatabase,
  forceCommittedRow: MemoryFaultController['forceCommittedRow'],
): MemoryFaultState {
  const points = new Set<FaultPoint>()
  const commits: Array<'reject' | PendingFault> = []
  states.set(db, {
    forceCommittedRow,
    failNext(point) {
      points.add(point)
    },
    commitThenReject() {
      commits.push('reject')
    },
    rejectCommitPending() {
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
      commits.push({
        fault,
        reject(finish) {
          finishBackend = finish
          rejected()
        },
        waiting() {
          waiting()
        },
      })
      return fault
    },
  })
  return {
    take(point) {
      return points.delete(point)
    },
    takeCommit() {
      return commits.shift()
    },
  }
}

export function memoryFaults(db: MemoryDatabase): MemoryFaultController {
  const controller = states.get(db)
  if (controller === undefined) throw new TypeError('Not a memory transaction database')
  return controller
}
