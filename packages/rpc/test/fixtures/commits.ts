import type { HubPublishParams } from '@kumiai/hub-tunnel'

import { encodeCommitFrame } from '../../src/commit-frame.js'
import { encodeHandshakeFrame, HANDSHAKE_KIND } from '../../src/handshake.js'
import { encodeLedgerEntries } from '../../src/ledger-entries.js'
import { commitTopic } from '../../src/topic.js'
import { createFakeCrypto } from './fake-crypto.js'
import { encodeMemoryCommit, memoryEntryID, memoryLedgerHead } from './memory-group-mls.js'

type PublishingHub = { publish: (params: HubPublishParams) => Promise<{ sequenceID: string }> }

export type PublishCommitParams = {
  hub: PublishingHub
  /** Who hands the frame to the hub. The hub authenticates this, and nothing else about it. */
  senderDID: string
  /**
   * Who AUTHORED the commit, inside the commit's own bytes, where MLS signs it. Defaults to
   * the transport sender, because in an honest group they are the same member — and they are
   * separable here because the whole point is that a peer must never confuse them.
   */
  committerDID?: string
  recoverySecret: Uint8Array
  /** The epoch this Commit is framed at — the epoch every member that can apply it is at. */
  epoch: number
  /** The signed tokens it enacts. They ride the frame, sealed under `epoch`. */
  entries?: Array<string>
  /**
   * The tokens the group's ledger ALREADY holds, in order. A commit that enacts entries
   * carries the head folded over the committer's whole ledger, so an off-stage admin
   * committing onto a non-empty ledger has to say what was under it — a head folded over the
   * new entries alone is a head no receiver's ledger reproduces.
   */
  ledgerBefore?: Array<string>
  /** Override the commit bytes (an empty commit is a no-op the receiver cannot apply). */
  commit?: Uint8Array
  /**
   * The head this publish is conditional on. Omitted, the frame is appended unconditionally —
   * fine for an admin off-stage in a test that is not about the race. Given, it is a real
   * compare-and-set, and TWO publishes naming the same head are what a hub has to break its
   * own contract to accept.
   */
  expectedHead?: string | null
}

/**
 * A member that is not a peer in the test — an admin off-stage — publishing a commit
 * frame, exactly as a peer's `commit()` builds one: `[commit][wrap(bodies)]`, with the
 * bodies sealed under the pre-commit epoch secret.
 */
export async function publishCommit(params: PublishCommitParams): Promise<{ sequenceID: string }> {
  const { hub, senderDID, recoverySecret, epoch, entries = [], ledgerBefore = [] } = params
  const committerDID = params.committerDID ?? senderDID
  const crypto = createFakeCrypto({ epoch, localDID: senderDID })
  const entryIDs = entries.map(memoryEntryID)
  const commit =
    params.commit ??
    encodeMemoryCommit(epoch, committerDID, entryIDs, {
      ...(entryIDs.length > 0
        ? { head: memoryLedgerHead([...ledgerBefore.map(memoryEntryID), ...entryIDs]) }
        : {}),
    })
  const sealed = await crypto.wrap(encodeLedgerEntries(entries))
  return hub.publish({
    senderDID,
    topicID: commitTopic(recoverySecret),
    payload: encodeHandshakeFrame(HANDSHAKE_KIND.commit, encodeCommitFrame(commit, sealed)),
    retain: 'log',
    ...(params.expectedHead !== undefined ? { expectedHead: params.expectedHead } : {}),
  })
}
