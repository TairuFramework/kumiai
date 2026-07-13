import type { HubPublishParams } from '@kumiai/hub-tunnel'

import { encodeCommitFrame } from '../../src/commit-frame.js'
import { encodeHandshakeFrame, HANDSHAKE_KIND } from '../../src/handshake.js'
import { encodeLedgerEntries } from '../../src/ledger-entries.js'
import { encodeMemoryCommit, memoryEntryID } from '../../src/memory-group-mls.js'
import { commitTopic } from '../../src/topic.js'
import { createFakeCrypto } from './fake-crypto.js'

type PublishingHub = { publish: (params: HubPublishParams) => Promise<{ sequenceID: string }> }

export type PublishCommitParams = {
  hub: PublishingHub
  senderDID: string
  recoverySecret: Uint8Array
  /** The epoch this Commit is framed at — the epoch every member that can apply it is at. */
  epoch: number
  /** The signed tokens it enacts. They ride the frame, sealed under `epoch`. */
  entries?: Array<string>
  /** Override the commit bytes (an empty commit is a no-op the receiver cannot apply). */
  commit?: Uint8Array
}

/**
 * A member that is not a peer in the test — an admin off-stage — publishing a commit
 * frame, exactly as a peer's `localCommitted` builds one: `[commit][wrap(bodies)]`,
 * with the bodies sealed under the pre-commit epoch secret.
 */
export async function publishCommit(params: PublishCommitParams): Promise<{ sequenceID: string }> {
  const { hub, senderDID, recoverySecret, epoch, entries = [] } = params
  const crypto = createFakeCrypto({ epoch, localDID: senderDID })
  const commit = params.commit ?? encodeMemoryCommit(epoch, entries.map(memoryEntryID))
  const sealed = await crypto.wrap(encodeLedgerEntries(entries))
  return hub.publish({
    senderDID,
    topicID: commitTopic(recoverySecret),
    payload: encodeHandshakeFrame(HANDSHAKE_KIND.commit, encodeCommitFrame(commit, sealed)),
    retain: 'log',
  })
}
