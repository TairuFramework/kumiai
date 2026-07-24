import {
  testAckConformance,
  testLogHubConformance,
  testMailboxAckConformance,
} from '@kumiai/hub-conformance'
import type { MailboxHub } from '@kumiai/hub-tunnel'
import { afterEach } from 'vitest'

import { createHubMux, type HubMux } from '../src/hub-mux.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { FakeHub } from './fixtures/fake-hub.js'

const MAX_RETENTION = 30 * 24 * 60 * 60
const MAX_DEPTH = 6

/**
 * The doubles the whole rpc suite executes against, run against the hub contract itself. Every
 * peer-level test in this package holds one of these and none of them checked that it behaves like
 * a hub — which is how three separate doubles came to have an infallible `subscribe` while the real
 * hub refuses, leaving `hub-mux`'s swallowed subscribe failure unreachable from every test here.
 */
testLogHubConformance({
  label: 'FakeHub',
  createHub: (options) => new FakeHub(options),
  maxRetention: MAX_RETENTION,
  maxDepth: MAX_DEPTH,
})

testLogHubConformance({
  label: 'DurableFakeHub',
  createHub: (options) => new DurableFakeHub(options),
  maxRetention: MAX_RETENTION,
  maxDepth: MAX_DEPTH,
})

// DurableFakeHub declares an ack (`durable-fake-hub.ts`), so it opts into the clauses that assert
// its presence and behaviour — FakeHub has none and does not opt in.
testAckConformance({
  label: 'DurableFakeHub',
  createHub: (options) => new DurableFakeHub(options),
  maxRetention: MAX_RETENTION,
  maxDepth: MAX_DEPTH,
  // DurableFakeHub's own receive() never replays backlog — only this does — so this is the only
  // way the suite can observe the redelivery its ack suppresses.
  redeliver: (hub, subscriberDID) => hub.redeliver(subscriberDID),
})

/**
 * `hub-mux`'s `mailbox` view is a real `MailboxHub` with a real `ack` wired to the drain's
 * refcounted claim (`releaseClaim` in `../src/hub-mux.ts`) — none of the five relay points this
 * branch fixed can answer `fetchTopic`, and this is the strongest of the five to opt in.
 *
 * It is not opted into `testMailboxHubConformance` above: that suite subscribes and receives as
 * two DISTINCT identities (ALICE and BOB) on one shared hub, and `mailbox.subscribe`/`receive`
 * both ignore the `subscriberDID` argument, always acting as the mux's own fixed `localDID` — so
 * "Alice's receive" and "Bob's receive" would be the same underlying view, breaking the no-echo
 * clause. The ack conformance suite below only ever subscribes/receives as ONE identity (Bob),
 * which is exactly what a single-peer mailbox view is.
 */
const MUX_LOCAL_DID = 'did:key:mux-mailbox-subject'

type MuxMailboxTestHub = MailboxHub & { redeliver: () => void }

// The conformance suite's `createHub` has no matching disposal hook — each case's mux would
// otherwise leak a live drain loop for the rest of the process. Tracked here and torn down in
// `afterEach` below, which fires for every test the suite generates in this file, not just this one.
const muxInstances: Array<HubMux> = []

function createMuxMailboxHub(options: {
  maxRetention: number
  maxDepth: number
}): MuxMailboxTestHub {
  const inner = new DurableFakeHub(options)
  const mux = createHubMux({
    hub: inner,
    localDID: MUX_LOCAL_DID,
    onSubscribeFailed: () => {},
  })
  muxInstances.push(mux)
  return Object.assign(mux.mailbox, {
    // Same mechanism the suite uses for DurableFakeHub directly: push the subject's unacked
    // retained messages back into the SAME upstream subscription the mux drains, which is what a
    // reconnect's backlog replay looks like from underneath a mux that never itself reconnects.
    redeliver: () => inner.redeliver(MUX_LOCAL_DID),
  })
}

afterEach(async () => {
  await Promise.all(muxInstances.splice(0).map((mux) => mux.dispose()))
})

testMailboxAckConformance({
  label: 'hub-mux mailbox (createHubMux(...).mailbox)',
  createHub: (options) => createMuxMailboxHub(options),
  maxRetention: MAX_RETENTION,
  maxDepth: MAX_DEPTH,
  redeliver: (hub) => hub.redeliver(),
})
