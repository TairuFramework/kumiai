import { testAckConformance, testLogHubConformance } from '@kumiai/hub-conformance'

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
