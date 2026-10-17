import type { GroupHandle } from './group-handle.js'

export class CommitAuthoringRefusedError extends Error {
  constructor(message = 'Private commit authoring requires the control-build permit') {
    super(message)
    this.name = 'CommitAuthoringRefusedError'
  }
}

export type CommitReceipt = {
  commit: Uint8Array
  referencedProposals: Array<string>
  epoch: number
  authenticatorBefore: Uint8Array
  candidateAuthenticator: Uint8Array
}

type Permit = { consumed: boolean; receipt: CommitReceipt | null }

const AUTHORING = new WeakMap<GroupHandle, 'restricted' | Permit>()

export function restrictCommitAuthoring(handle: GroupHandle): GroupHandle {
  AUTHORING.set(handle, 'restricted')
  return handle
}

export function isCommitAuthoringMarked(handle: GroupHandle): boolean {
  return AUTHORING.has(handle)
}

export async function withCommitPermit<TValue>(
  restore: () => Promise<GroupHandle>,
  fn: (permitted: GroupHandle) => Promise<TValue>,
): Promise<{ value: TValue; receipt: CommitReceipt | null }> {
  const permitted = await restore()
  if (AUTHORING.has(permitted)) throw new CommitAuthoringRefusedError()
  const permit: Permit = { consumed: false, receipt: null }
  AUTHORING.set(permitted, permit)
  try {
    const value = await fn(permitted)
    return { value, receipt: permit.receipt }
  } finally {
    restrictCommitAuthoring(permitted)
  }
}

export function authorPrivateCommit<TValue>(
  handle: GroupHandle,
  construct: () => Promise<{ value: TValue; receipt: CommitReceipt }>,
): Promise<TValue> {
  const permit = AUTHORING.get(handle)
  if (permit === 'restricted' || permit?.consumed) throw new CommitAuthoringRefusedError()
  // Consume before invoking user code, including synchronous re-entry and failures.
  if (permit != null) permit.consumed = true
  return construct().then(({ value, receipt }) => {
    if (permit != null) permit.receipt = receipt
    return value
  })
}
