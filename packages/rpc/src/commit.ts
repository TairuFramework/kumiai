import { HeadMismatchError } from '@kumiai/hub-protocol'

/**
 * `commit()` ran out of time rebasing: it kept losing the compare-and-set past its deadline.
 * Losing one is not an error — this is losing them longer than the caller would wait.
 */
export class CommitDeadlineError extends Error {
  override name = 'CommitDeadlineError'
}

/**
 * Control cannot build on an unreconciled state, an unresolved anchor, or an incomplete ledger.
 * An enqueued intent stays durable and retries after the hold clears. Hosts can inspect outcomes
 * or call `replay()` to wake settlement; issuing another operation creates additional work.
 */
export class RecoveryRequiredError extends Error {
  override name = 'RecoveryRequiredError'
}

/**
 * The compare-and-set was lost: someone else's commit is at the head. The error crosses a
 * transport and is rebuilt from a wire code, so a peer talking to a real hub holds a
 * reconstructed instance — match on the NAME too, or a remote loss reads as an unknown publish
 * failure and the peer keeps an operation it should have settled.
 */
export function isHeadMismatch(error: unknown): boolean {
  return (
    error instanceof HeadMismatchError ||
    (error instanceof Error && error.name === 'HeadMismatchError')
  )
}
