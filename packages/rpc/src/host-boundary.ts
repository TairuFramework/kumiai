import type { GatherOptions } from '@kumiai/broadcast'

import type { PendingCommit } from './commit.js'
import type { GroupCrypto, GroupMLS, PendingAppFrames, PendingRecovery } from './crypto.js'
import { PeerDisposedError } from './errors.js'
import type { GroupPeerMLSParams, GroupPeerParams } from './peer.js'
import type { GroupProtocolDefinition } from './protocol.js'

type Callable = (...args: Array<unknown>) => unknown
export type HostBoundary = {
  wrap<T extends object>(value: T): T
  close(): void
  drained(teardown: Promise<unknown>): Promise<void>
}

type MemberKind = 'host' | 'data' | 'port'
type HostMembers<T extends object> = {
  [K in keyof T]-?: NonNullable<T[K]> extends (...args: Array<never>) => unknown
    ? 'host'
    : 'data' | 'port'
}

// New recovery methods must be classified alongside the existing acceptance callback.
export const pendingRecoveryHostMembers = {
  epoch: 'data',
  markBindingUnusable: 'host',
  confirmationKey: 'host',
  judgeVerdict: 'host',
  commit: 'data',
  onAccepted: 'host',
} as const satisfies HostMembers<PendingRecovery>

export const pendingCommitHostMembers = {
  commit: 'data',
  bodies: 'data',
  kind: 'data',
  journal: 'data',
  onAccepted: 'host',
} as const satisfies HostMembers<PendingCommit>

export const cryptoHostMembers = {
  epoch: 'host',
  exportSecret: 'host',
  wrap: 'host',
  unwrap: 'host',
  frameAAD: 'host',
  frameEpoch: 'host',
  sealEntries: 'host',
  openEntries: 'host',
  pending: 'port',
} as const satisfies HostMembers<GroupCrypto>

export const pendingFrameHostMembers = {
  list: 'host',
  complete: 'host',
} as const satisfies HostMembers<PendingAppFrames>

export const mlsHostMembers = {
  verifyRecoveryRequest: 'host',
  confirmationKey: 'host',
  sealRecoveryVerdict: 'host',
  openRecoveryVerdict: 'host',
  sendAdmission: 'host',
  readEpoch: 'host',
  rosterEntries: 'host',
  readCommitHeader: 'host',
  processCommit: 'host',
  prepareRecovery: 'host',
  createRecoveryRequest: 'host',
  sealGroupInfo: 'host',
  applyRecovery: 'host',
  isLedgerComplete: 'host',
  sealLedger: 'host',
  openSealedLedger: 'host',
  bootstrapLedger: 'host',
  getLedger: 'host',
  exportRecoverySecret: 'host',
} as const satisfies HostMembers<GroupMLS>

type Params = GroupPeerParams<Record<string, GroupProtocolDefinition>>
type ParamKind =
  | 'crypto'
  | 'mls'
  | 'port'
  | 'callback'
  | 'handlers'
  | 'recovery'
  | 'data'
  | 'transport'
  | 'runtime'
export const peerHostFields = {
  hub: 'transport',
  runtime: 'runtime',
  crypto: 'crypto',
  mls: 'mls',
  journal: 'port',
  anchorStore: 'port',
  appCursorStore: 'port',
  appOutbox: 'port',
  appOutboxLimit: 'data',
  adoptJournalled: 'callback',
  handlers: 'handlers',
  recovery: 'recovery',
  localDID: 'data',
  protocols: 'data',
  suppress: 'data',
  commitLogRetentionSeconds: 'data',
  appLogRetentionSeconds: 'data',
  commitDeadlineMs: 'data',
  onAppWindowPruned: 'callback',
  onStrand: 'callback',
  onRecovery: 'callback',
  onAppDeliveryStalled: 'callback',
  onAppDeliveryResumed: 'callback',
  onSubscribeFailed: 'callback',
  onReceiveEnded: 'callback',
} as const satisfies Record<keyof Params | keyof GroupPeerMLSParams, ParamKind>

export const gatherHostMembers = {
  quorum: 'data',
  timeoutMs: 'data',
  signal: 'data',
  onReply: 'host',
} as const satisfies HostMembers<GatherOptions>

export function wrapGatherOptions(boundary: HostBoundary, options: GatherOptions): GatherOptions {
  return selectHostMembers(boundary, options, gatherHostMembers)
}

export function createHostBoundary(): HostBoundary {
  let closed = false
  let active = 0
  const idle = new Set<() => void>()
  const views = new WeakMap<object, object>()
  const receivers = new WeakMap<object, Map<Callable, Callable>>()

  const finish = (): void => {
    active--
    if (active === 0) {
      for (const resolve of idle) resolve()
      idle.clear()
    }
  }

  const invoke = (callback: Callable, receiver: unknown, args: Array<unknown>): unknown => {
    if (closed) throw new PeerDisposedError('Host boundary is closed')
    active++
    try {
      const result = Reflect.apply(callback, receiver, args)
      const then = result == null ? undefined : (result as { then?: unknown }).then
      if (typeof then === 'function') {
        const settled = new Promise<unknown>((resolve, reject) => {
          Reflect.apply(then, result, [resolve, reject])
        })
        void settled.then(finish, finish)
        return settled
      }
      finish()
      return result
    } catch (error) {
      finish()
      throw error
    }
  }

  function wrap<T extends object>(value: T): T {
    const cached = views.get(value)
    if (cached != null) return cached as T
    let view: object
    if (typeof value === 'function') {
      view = new Proxy(value, {
        apply: (target, receiver, args) => invoke(target as Callable, receiver, args),
      })
    } else {
      // A separate target avoids frozen-property proxy invariants on host ports.
      view = new Proxy(
        {},
        {
          get(_target, key) {
            let owner: object | null = value
            let descriptor: PropertyDescriptor | undefined
            while (owner != null && descriptor == null) {
              descriptor = Reflect.getOwnPropertyDescriptor(owner, key)
              owner = Reflect.getPrototypeOf(owner)
            }
            const member =
              descriptor?.get == null
                ? Reflect.get(value, key, value)
                : invoke(descriptor.get as Callable, value, [])
            if (typeof member !== 'function') return member
            let methods = receivers.get(value)
            if (methods == null) {
              methods = new Map()
              receivers.set(value, methods)
            }
            const callback = member as Callable
            const cachedMethod = methods.get(callback)
            if (cachedMethod != null) return cachedMethod
            const method: Callable =
              views.get(callback) === callback
                ? (...args) => Reflect.apply(callback, value, args)
                : (...args) => invoke(callback, value, args)
            methods.set(callback, method)
            views.set(method, method)
            return method
          },
          ownKeys: () => Reflect.ownKeys(value),
          getOwnPropertyDescriptor: (_target, key) => {
            const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
            return descriptor == null
              ? undefined
              : { configurable: true, enumerable: descriptor.enumerable }
          },
          getPrototypeOf: () => Reflect.getPrototypeOf(value),
        },
      )
    }
    views.set(value, view)
    views.set(view, view)
    return view as T
  }

  return {
    wrap,
    close: () => {
      closed = true
    },
    drained: async (teardown) => {
      if (!closed) throw new Error('Host boundary must be closed before draining')
      await teardown.catch(() => {})
      if (active !== 0)
        await new Promise<void>((resolve) => {
          idle.add(resolve)
        })
    },
  }
}

function selectHostMembers<T extends object>(
  boundary: HostBoundary,
  value: T,
  members: Record<keyof T, MemberKind>,
): T {
  const wrapped = boundary.wrap(value)
  const view = {}
  for (const [key, kind] of Object.entries(members)) {
    Object.defineProperty(view, key, {
      enumerable: true,
      configurable: true,
      get: () => Reflect.get(kind === 'host' ? wrapped : value, key),
    })
  }
  return view as T
}

export function wrapPendingCommit(boundary: HostBoundary, value: PendingCommit): PendingCommit {
  return selectHostMembers(boundary, value, pendingCommitHostMembers)
}

export function wrapPendingRecovery(
  boundary: HostBoundary,
  value: PendingRecovery,
): PendingRecovery {
  return selectHostMembers(boundary, value, pendingRecoveryHostMembers)
}

export function wrapPeerHost<TParams extends object>(
  boundary: HostBoundary,
  params: TParams,
): TParams {
  const wrapped = boundary.wrap(params)
  const view = {} as TParams
  for (const [key, kind] of Object.entries(peerHostFields)) {
    if (kind === 'data' || kind === 'transport' || kind === 'runtime' || kind === 'callback') {
      Object.defineProperty(view, key, {
        enumerable: true,
        get: () => Reflect.get(kind === 'callback' ? wrapped : params, key),
      })
      continue
    }
    const value: unknown = Reflect.get(wrapped, key)
    if (value == null) continue
    let selected: unknown
    if (kind === 'crypto') {
      const crypto = value as GroupCrypto
      selected = selectHostMembers(boundary, crypto, cryptoHostMembers)
      Object.defineProperty(selected, 'pending', {
        enumerable: true,
        value:
          crypto.pending == null
            ? undefined
            : selectHostMembers(boundary, crypto.pending, pendingFrameHostMembers),
      })
    } else if (kind === 'mls')
      selected = selectHostMembers(boundary, value as GroupMLS, mlsHostMembers)
    else if (kind === 'handlers') {
      selected = Object.fromEntries(
        Object.entries(value as Record<string, object>).map(([name, handlers]) => [
          name,
          boundary.wrap(handlers),
        ]),
      )
    } else selected = boundary.wrap(value as object)
    Reflect.set(view, key, selected)
  }
  return view
}
