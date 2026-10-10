/// <reference types="node" />

import { AsyncLocalStorage } from 'node:async_hooks'

import {
  GroupStateConflictError,
  PersistencePhaseError,
  ReentrantOwnershipError,
} from './persistence-errors.js'

export type EntryKind = 'transition' | 'combined' | 'read'
export type EntryPhase =
  | 'queued'
  | 'prepare'
  | 'work'
  | 'finalise'
  | 'effects'
  | 'account'
  | 'outcome'
  | 'ambiguous'
  | 'settled'
  | 'released'
export type WriteTarget = 'domain' | 'side' | 'coordinator'
export type OwnerScopes = { ownerDID: string | null; groupID: string | null }
export type ProofOutcome = 'committed' | 'rolled-back'
export type OwnerEntry = {
  readonly kind: EntryKind
  readonly scopes: OwnerScopes
  readonly phase: EntryPhase
  readonly mutationID: string | null
  enter(phase: EntryPhase): Promise<void>
  sequence<T>(operation: () => Promise<T>): Promise<T>
  assertWrite(target: WriteTarget): void
  onCommit(fn: () => void): void
  onRollback(fn: () => void): void
  settle(outcome: ProofOutcome): void
  retain(proof: () => Promise<ProofOutcome>): Promise<ProofOutcome>
}
export type OwnerQueues = {
  run<T>(
    kind: EntryKind,
    scopes: OwnerScopes,
    body: (entry: OwnerEntry) => Promise<T>,
    options?: { mutationID?: string; signal?: AbortSignal },
  ): Promise<T>
  current(): OwnerEntry | undefined
  joinProof(
    owner: { groupID: string } | { ownerDID: string },
    mutationID: string,
  ): Promise<ProofOutcome> | null
  started(scopeKey: string): boolean
  markStarted(scopeKey: string): void
  failStop(error: GroupStateConflictError): void
  readonly failure: GroupStateConflictError | null
}

const ownershipContext = new AsyncLocalStorage<OwnerEntry>()
type SequencedOperation = { entry: OwnerEntry; tail: Promise<void>; active: boolean }
// Each operation owns a child queue, so composition never waits on its own ancestor.
const sequencedContext = new AsyncLocalStorage<SequencedOperation>()
const failureSignals = new WeakMap<OwnerEntry, AbortSignal>()

export function ownerEntryFailureSignal(entry: OwnerEntry): AbortSignal | undefined {
  return failureSignals.get(entry)
}

type Slot = { held: boolean; waiters: Array<() => void> }
type Owned = {
  entry: OwnerEntry
  proof: Promise<ProofOutcome> | null
  drop(error: GroupStateConflictError): void
}

function scopeKey(kind: 'device' | 'group', id: string): string {
  return JSON.stringify([kind, id])
}

export function createOwnerQueues(): OwnerQueues {
  const slots = new Map<string, Slot>()
  const entries = new Set<Owned>()
  const started = new Set<string>()
  const stopped = new AbortController()
  let failure: GroupStateConflictError | null = null
  function assertRunning(): void {
    if (failure !== null) throw failure
  }

  function acquire(key: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason)
    let slot = slots.get(key)
    if (slot === undefined) {
      slot = { held: false, waiters: [] }
      slots.set(key, slot)
    }
    const ownerSlot = slot
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const index = ownerSlot.waiters.indexOf(grant)
        if (index !== -1) ownerSlot.waiters.splice(index, 1)
        signal.removeEventListener('abort', cancel)
        reject(signal.reason)
      }
      const grant = () => {
        signal.removeEventListener('abort', cancel)
        ownerSlot.held = true
        let released = false
        resolve(() => {
          if (released) return
          released = true
          const next = ownerSlot.waiters.shift()
          if (next === undefined) {
            ownerSlot.held = false
            slots.delete(key)
          } else next()
        })
      }
      if (ownerSlot.held) {
        ownerSlot.waiters.push(grant)
        signal.addEventListener('abort', cancel, { once: true })
      } else grant()
    })
  }

  function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer)
        reject(failure)
      }
      const timer = setTimeout(() => {
        stopped.signal.removeEventListener('abort', cancel)
        resolve()
      }, milliseconds)
      stopped.signal.addEventListener('abort', cancel, { once: true })
    })
  }

  const queues: OwnerQueues = {
    get failure() {
      return failure
    },
    current() {
      const entry = ownershipContext.getStore()
      return entry?.phase === 'released' ? undefined : entry
    },
    started(key) {
      return started.has(key)
    },
    markStarted(key) {
      assertRunning()
      started.add(key)
    },
    joinProof(owner, mutationID) {
      for (const owned of entries) {
        const { entry, proof } = owned
        if (
          proof !== null &&
          entry.phase === 'ambiguous' &&
          entry.mutationID === mutationID &&
          ('groupID' in owner
            ? entry.scopes.groupID === owner.groupID
            : entry.scopes.ownerDID === owner.ownerDID)
        )
          return proof
      }
      return null
    },
    failStop(error) {
      if (failure !== null) return
      failure = error
      // Drop every hook queue before rejecting callers or granting any waiter.
      for (const owned of entries) owned.drop(error)
      stopped.abort(error)
    },
    async run(kind, requestedScopes, body, options) {
      assertRunning()
      if (queues.current() !== undefined) {
        throw new ReentrantOwnershipError('Root persistence call inside an owner entry')
      }
      // Keep cancellation per entry so the factory cannot retain completed callers through a promise.
      let rejectFailure!: (error: GroupStateConflictError) => void
      const failed = new Promise<never>((_resolve, reject) => {
        rejectFailure = reject
      })
      const scopes = Object.freeze({ ...requestedScopes })
      const signal =
        options?.signal === undefined
          ? stopped.signal
          : AbortSignal.any([stopped.signal, options.signal])
      const releases: Array<() => void> = []
      let phase: EntryPhase = 'queued'
      let outcome: ProofOutcome | null = null
      let tail = Promise.resolve()
      let closing: Promise<void> | null = null
      let bodyFinished = false
      const commits: Array<() => void> = []
      const rollbacks: Array<() => void> = []

      function release(): void {
        if (phase === 'released') return
        phase = 'released'
        entries.delete(owned)
        for (const unlock of releases.reverse()) unlock()
        releases.length = 0
      }

      function releaseSettled(): void {
        if (bodyFinished && phase === 'settled') release()
      }

      function assertLive(): void {
        assertRunning()
        if (phase === 'released') throw new PersistencePhaseError('Owner entry released')
      }

      function register(hooks: Array<() => void>, hook: () => void): void {
        assertLive()
        if (
          phase === 'outcome' ||
          phase === 'ambiguous' ||
          phase === 'settled' ||
          closing !== null
        ) {
          throw new PersistencePhaseError('Hook registration expired')
        }
        hooks.push(hook)
      }

      const entry: OwnerEntry = {
        kind,
        scopes,
        mutationID: options?.mutationID ?? null,
        get phase() {
          return phase
        },
        async enter(next) {
          assertLive()
          const context = sequencedContext.getStore()
          if (context?.entry === entry && context.active) {
            throw new PersistencePhaseError('Cannot change phase inside a sequenced operation')
          }
          if (closing !== null) throw new PersistencePhaseError('Phase is already changing')
          const allowed =
            (phase === 'queued' && (next === 'prepare' || (kind === 'read' && next === 'work'))) ||
            (phase === 'prepare' && next === 'work') ||
            (phase === 'work' && next === 'finalise') ||
            (phase === 'finalise' && next === 'effects') ||
            (phase === 'effects' && next === 'account') ||
            (['prepare', 'work', 'finalise', 'effects', 'account'].includes(phase) &&
              next === 'outcome') ||
            (phase === 'outcome' && kind !== 'read' && (next === 'work' || next === 'ambiguous'))
          if (!allowed) throw new PersistencePhaseError(`Cannot enter ${next} from ${phase}`)
          // Stop new reservations immediately, but let started operations finish in their phase.
          closing = tail.then(() => {
            assertLive()
            phase = next
            closing = null
          })
          await Promise.race([closing, failed])
        },
        sequence(operation) {
          const context = sequencedContext.getStore()
          const parent = context?.entry === entry && context.active ? context : undefined
          try {
            assertLive()
            if (
              (closing !== null && parent === undefined) ||
              !['work', 'finalise', 'effects', 'account'].includes(phase)
            ) {
              throw new PersistencePhaseError('Store sequencing expired')
            }
          } catch (error) {
            return Promise.reject(error)
          }
          const result = (parent?.tail ?? tail).then(async () => {
            assertLive()
            const current: SequencedOperation = { entry, tail: Promise.resolve(), active: true }
            try {
              return await ownershipContext.run(entry, () =>
                sequencedContext.run(current, operation),
              )
            } finally {
              // Abandoned children still own the phase, including descendants started while draining.
              for (;;) {
                const children = current.tail
                await children
                if (children === current.tail) break
              }
              current.active = false
            }
          })
          const drained = result.then(
            () => undefined,
            () => undefined,
          )
          if (parent === undefined) tail = drained
          else parent.tail = drained
          return Promise.race([result, failed])
        },
        assertWrite(target) {
          assertLive()
          const allowed =
            target === 'domain'
              ? phase === 'work'
              : target === 'side'
                ? phase === 'work' || phase === 'effects'
                : phase === 'finalise' || phase === 'account'
          if (!allowed) throw new PersistencePhaseError(`Cannot write ${target} in ${phase}`)
        },
        onCommit(fn) {
          register(commits, fn)
        },
        onRollback(fn) {
          register(rollbacks, fn)
        },
        settle(next) {
          assertRunning()
          if (outcome !== null) {
            if (outcome !== next)
              throw new GroupStateConflictError('Contradicting owner settlement')
            return
          }
          assertLive()
          if (phase !== 'outcome' && phase !== 'ambiguous') {
            throw new PersistencePhaseError(`Cannot settle in ${phase}`)
          }
          outcome = next
          phase = 'settled'
          const hooks = (next === 'committed' ? commits : rollbacks).slice()
          commits.length = 0
          rollbacks.length = 0
          ownershipContext.run(entry, () => {
            for (const hook of hooks) {
              if (failure !== null) break
              try {
                hook()
              } catch {
                /* Hook exceptions cannot change the proven outcome. */
              }
            }
          })
          releaseSettled()
        },
        retain(proof) {
          assertLive()
          if (kind === 'read' || (phase !== 'outcome' && phase !== 'ambiguous')) {
            throw new PersistencePhaseError(`Cannot retain ${kind} in ${phase}`)
          }
          if (owned.proof !== null) return owned.proof
          phase = 'ambiguous'
          const resolveProof = async (): Promise<ProofOutcome> => {
            let milliseconds = 100
            for (;;) {
              assertRunning()
              let proven: ProofOutcome
              try {
                proven = await ownershipContext.run(entry, proof)
              } catch {
                assertRunning()
                await delay(milliseconds)
                milliseconds = Math.min(milliseconds * 2, 15000)
                continue
              }
              assertRunning()
              entry.settle(proven)
              return proven
            }
          }
          owned.proof = Promise.race([resolveProof(), failed])
          void owned.proof.catch(() => undefined)
          return owned.proof
        },
      }
      failureSignals.set(entry, stopped.signal)
      const owned: Owned = {
        entry,
        proof: null,
        drop(error) {
          commits.length = 0
          rollbacks.length = 0
          // Backend completion owns already-started work; no new reservation may run.
          phase = 'released'
          entries.delete(owned)
          rejectFailure(error)
        },
      }
      entries.add(owned)

      async function cleanup(): Promise<void> {
        if (failure !== null || owned.proof !== null) return
        if (kind === 'read') {
          release()
          return
        }
        if (phase !== 'settled') {
          if (phase === 'queued') await entry.enter('prepare')
          if (closing !== null) await closing
          if (entry.phase !== 'settled' && entry.phase !== 'outcome') await entry.enter('outcome')
          if (entry.phase !== 'settled') entry.settle('rolled-back')
        }
        releaseSettled()
      }

      const execute = async () => {
        try {
          if (scopes.ownerDID !== null) {
            releases.push(await acquire(scopeKey('device', scopes.ownerDID), signal))
            if (signal.aborted) throw signal.reason
          }
          if (scopes.groupID !== null) {
            releases.push(await acquire(scopeKey('group', scopes.groupID), signal))
            if (signal.aborted) throw signal.reason
          }
          assertRunning()
        } catch (error) {
          release()
          throw error
        }
        try {
          const value = await ownershipContext.run(entry, () => body(entry))
          if (kind !== 'read' && phase !== 'settled' && owned.proof === null) {
            throw new PersistencePhaseError('Owner body finished without settlement')
          }
          return value
        } finally {
          bodyFinished = true
          releaseSettled()
          // A rejected caller need not await its suspended operations; ownership still does.
          void cleanup().catch(() => undefined)
        }
      }
      return Promise.race([execute(), failed])
    },
  }
  return queues
}
