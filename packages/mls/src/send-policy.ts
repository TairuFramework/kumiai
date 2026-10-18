import type { ClientState } from './codec.js'
import { encodeClientState } from './codec.js'
import type { MemberCredential } from './credential.js'
import { assertGroupHandle, type GroupHandle, mutexFor } from './group-handle.js'

type SendPolicy = { kind: 'denied' } | { kind: 'bound'; limit: () => number }
const POLICIES = new WeakMap<GroupHandle, SendPolicy>()

declare const holdingBrand: unique symbol
export type HoldingToken = { [holdingBrand]: true }
const HOLDING = new WeakMap<HoldingToken, GroupHandle>()
const CAPTURED = new WeakSet<HoldingToken>()

/** Test doubles override this serialized reservation entry, retaining withReservationLock. */
export const reserveApplicationKernel = Symbol('reserveApplicationKernel')

export class ApplicationSendRefusedError extends Error {
  constructor() {
    super('Application send policy refuses encryption')
    this.name = 'ApplicationSendRefusedError'
  }
}

export function denyApplicationSend(handle: GroupHandle): GroupHandle {
  assertGroupHandle(handle)
  POLICIES.set(handle, { kind: 'denied' })
  return handle
}

export function bindSendCeiling(handle: GroupHandle, limit: () => number): GroupHandle {
  assertGroupHandle(handle)
  if (POLICIES.has(handle)) throw new TypeError('Application send policy already set')
  POLICIES.set(handle, { kind: 'bound', limit })
  return handle
}

export function isApplicationSendDenied(handle: GroupHandle): boolean {
  return POLICIES.get(handle)?.kind === 'denied'
}

export function inheritSendPolicy(source: GroupHandle, derived: GroupHandle): void {
  if (POLICIES.has(source)) denyApplicationSend(derived)
}

export function ownApplicationGeneration(state: ClientState): number {
  return state.secretTree.leafNodes[state.privatePath.leafIndex * 2]?.application.generation ?? 0
}

export function assertApplicationSend(handle: GroupHandle): void {
  assertGroupHandle(handle)
  const policy = POLICIES.get(handle)
  if (
    policy?.kind === 'denied' ||
    (policy?.kind === 'bound' && !(ownApplicationGeneration(handle.state) < policy.limit()))
  ) {
    throw new ApplicationSendRefusedError()
  }
}

export async function withHoldingToken<T>(
  handle: GroupHandle,
  fn: (holding: HoldingToken) => Promise<T>,
): Promise<T> {
  const holding = Object.freeze({}) as HoldingToken
  HOLDING.set(holding, handle)
  try {
    return await fn(holding)
  } finally {
    HOLDING.delete(holding)
  }
}

/** A valid token proves this handle's serializer is already held. */
export function withReservationLock<T>(
  handle: GroupHandle,
  holding: HoldingToken | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  assertGroupHandle(handle)
  if (holding !== undefined) {
    if (HOLDING.get(holding) !== handle) throw new TypeError('Invalid holding token')
    return fn()
  }
  return mutexFor(handle).run(fn)
}

export type Relinquished = {
  state: Uint8Array
  ledgerTokens: Array<string>
  credential: MemberCredential
}

export async function relinquishSend(
  handle: GroupHandle,
  opts: { holding?: HoldingToken } = {},
): Promise<Relinquished> {
  denyApplicationSend(handle)
  if (opts.holding !== undefined && HOLDING.get(opts.holding) !== handle) {
    throw new TypeError('Invalid holding token')
  }
  const capture = (): Relinquished => ({
    state: encodeClientState(handle.state),
    ledgerTokens: [...handle.ledgerTokens],
    credential: { ...handle.credential },
  })
  // Only the callback's first capture may borrow the held serializer.
  if (opts.holding !== undefined && !CAPTURED.has(opts.holding)) {
    CAPTURED.add(opts.holding)
    return capture()
  }
  const release = await mutexFor(handle).acquire()
  try {
    return capture()
  } finally {
    release()
  }
}

export async function reserveApplicationRange(
  handle: GroupHandle,
  opts: { floor: number; size: number; cap: number },
): Promise<{ pre: Uint8Array; advanced: Uint8Array; start: number; limit: number } | null> {
  assertGroupHandle(handle)
  if (!Number.isInteger(opts.floor) || opts.floor < 0)
    throw new TypeError('Invalid reservation floor')
  if (!isApplicationSendDenied(handle)) throw new TypeError('Reservation requires a denied handle')
  return mutexFor(handle).run(() => {
    return withHoldingToken(handle, async (holding) => {
      const start = Math.max(ownApplicationGeneration(handle.state), opts.floor)
      if (start >= opts.cap) return null
      await handle[reserveApplicationKernel](start, holding)
      const pre = encodeClientState(handle.state)
      const limit = Math.min(start + opts.size, opts.cap)
      await handle[reserveApplicationKernel](limit, holding)
      return { pre, advanced: encodeClientState(handle.state), start, limit }
    })
  })
}
