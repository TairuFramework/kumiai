import type { HubFetchTopicResult } from '@kumiai/hub-tunnel'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'

import { asLogPosition, assertForwardPage, type LogPosition } from '../cursor.js'

export async function searchOccurrence(
  fetch: (after: LogPosition | null) => Promise<HubFetchTopicResult>,
  from: LogPosition | null,
  payloadDigest: string,
): Promise<{ found: LogPosition } | 'absent' | 'gap'> {
  let after = from
  for (;;) {
    const page = await fetch(after)
    // External recovery retains occurrence-only semantics until authenticated target capture.
    for (const row of page.messages) {
      if (toB64U(sha256(row.payload)) === payloadDigest)
        return { found: asLogPosition(row.sequenceID) }
    }
    if (page.gap) return 'gap'
    assertForwardPage(after, page.messages)
    const previous = page.messages.at(-1)?.sequenceID ?? after
    if (page.head === null) return previous === null ? 'absent' : 'gap'
    if (previous !== null && previous >= page.head) return 'absent'
    const last = page.messages.at(-1)
    if (last === undefined) return 'gap'
    after = asLogPosition(last.sequenceID)
  }
}
