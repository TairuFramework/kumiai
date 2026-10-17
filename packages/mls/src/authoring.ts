import type { GroupHandle } from './group-handle.js'

export class CommitAuthoringRefusedError extends Error {
  constructor(message = 'Private commit authoring requires the control-build permit') {
    super(message)
    this.name = 'CommitAuthoringRefusedError'
  }
}

export type CommitReceipt = {
  commit: Uint8Array
  welcome: Uint8Array | null
  referencedProposals: Array<string>
  epoch: number
  authenticatorBefore: Uint8Array
  candidateAuthenticator: Uint8Array
}

type Permit = {
  consumed: boolean
  receipt: CommitReceipt | null
  construction: Promise<PromiseSettledResult<void>> | null
}

const AUTHORING = new WeakMap<GroupHandle, 'restricted' | Permit>()

export function restrictCommitAuthoring(handle: GroupHandle): GroupHandle {
  AUTHORING.set(handle, 'restricted')
  return handle
}

export function isCommitAuthoringMarked(handle: GroupHandle): boolean {
  return AUTHORING.has(handle)
}

/**
 * Waits for both fn and the sole permitted construction to settle.
 * Admission closes when fn's settlement is observed. Earlier microtasks may consume
 * the sole permit and remain tracked, even if fn's promise has already settled.
 * Construction failure rejects the scope, even if caught by fn, and takes precedence over callback failure.
 */
export async function withCommitPermit<TValue>(
  restore: () => Promise<GroupHandle>,
  fn: (permitted: GroupHandle) => Promise<TValue>,
): Promise<{ value: TValue; receipt: CommitReceipt | null }> {
  const permitted = await restore()
  if (AUTHORING.has(permitted)) throw new CommitAuthoringRefusedError()
  const permit: Permit = { consumed: false, receipt: null, construction: null }
  AUTHORING.set(permitted, permit)
  let outcome: PromiseSettledResult<TValue>
  try {
    outcome = { status: 'fulfilled', value: await fn(permitted) }
  } catch (reason) {
    outcome = { status: 'rejected', reason }
  }
  restrictCommitAuthoring(permitted)
  const construction = await permit.construction
  if (construction?.status === 'rejected') throw construction.reason
  if (outcome.status === 'rejected') throw outcome.reason
  return { value: outcome.value, receipt: permit.receipt }
}

/** Throws synchronously on refusal, before invoking construct. */
export function authorPrivateCommit<TValue>(
  handle: GroupHandle,
  construct: () => Promise<{ value: TValue; receipt: CommitReceipt }>,
): Promise<TValue> {
  const permit = AUTHORING.get(handle)
  if (permit === 'restricted' || permit?.consumed) throw new CommitAuthoringRefusedError()
  // Consume before invoking user code, including synchronous re-entry and failures.
  if (permit != null) permit.consumed = true
  let construction: Promise<TValue>
  try {
    construction = construct().then(({ value, receipt }) => {
      if (permit != null) permit.receipt = receipt
      return value
    })
  } catch (reason) {
    if (permit != null) permit.construction = Promise.resolve({ status: 'rejected', reason })
    throw reason
  }
  if (permit != null) {
    // Observe rejection immediately, even when fn neither awaits nor catches it.
    permit.construction = construction.then(
      () => ({ status: 'fulfilled', value: undefined }),
      (reason: unknown) => ({ status: 'rejected', reason }),
    )
  }
  return construction
}
