import { testMailboxHubConformance } from '@kumiai/hub-conformance'

import { FakeHub } from './fixtures/fake-hub.js'

const MAX_RETENTION = 30 * 24 * 60 * 60
const MAX_DEPTH = 6

/**
 * The double every transport test in this package runs against, checked against the hub contract.
 * It is a {@link MailboxHub}: no readable log, so only the clauses a mailbox hub can answer for.
 */
testMailboxHubConformance({
  label: 'hub-tunnel FakeHub',
  createHub: (options) => new FakeHub(options),
  maxRetention: MAX_RETENTION,
  maxDepth: MAX_DEPTH,
})
