import type { StoredMessage } from '@kumiai/hub-protocol'
import type { LogHub } from '@kumiai/hub-tunnel'

import type { WireHub } from './log-hub-over-wire.js'

type GapLog = LogHub & {
  published: Array<StoredMessage>
  trim(topicID: string, before: string): void
  head(topicID: string): string | null
  hideFrom(readerDID: string, sequenceID: string): void
  revealTo(readerDID: string, sequenceID: string): void
}
const { FakeHub } = (await import(
  new URL('../../../packages/rpc/test/fixtures/fake-hub.ts', import.meta.url).href
)) as { FakeHub: new () => GapLog }

/** Real MLS peers over the gap-capable retained-log fixture. */
export function createGapHub(): WireHub & { log: GapLog } {
  const log = new FakeHub()
  return {
    log,
    connect: () => Object.assign(log, { disconnect: async () => {} }),
    dispose: async () => {},
  }
}
