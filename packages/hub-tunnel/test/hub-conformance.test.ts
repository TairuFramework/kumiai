import type { ConformanceLogHub, ConformanceMailboxHub } from '@kumiai/hub-conformance'
import { testMailboxHubConformance } from '@kumiai/hub-conformance'

import type { HubReceiveOptions, LogHub, MailboxHub } from '../src/transport.js'
import { FakeHub } from './fixtures/fake-hub.js'

// THE COVERAGE TRIPWIRE. The suite re-declares the hub shapes structurally (it cannot import
// them without a package cycle), so nothing otherwise notices when a hub contract grows a member
// the suite has never heard of — a gap that produces no failure, because a member with no clause
// simply is not exercised. The first pair proves the suite asks for nothing the contract lacks;
// the SECOND pair is the one that catches drift, and it fails to compile the moment a hub member
// appears with no conformance counterpart.
//
// `events` is the one deliberate exclusion: connection lifecycle, optional on both shapes, and
// not something a store or a double can be wrong about in a way that costs a message.
type Covered<Hub> = Omit<Hub, 'events'>
const _mailboxIsAHub = (hub: MailboxHub): ConformanceMailboxHub => hub
const _logIsAHub = (hub: LogHub): ConformanceLogHub => hub
const _mailboxCoversHub = (hub: ConformanceMailboxHub): Covered<MailboxHub> => hub
const _logCoversHub = (hub: ConformanceLogHub): Covered<LogHub> => hub

// THE OPTIONAL-FIELD TRIPWIRE. The pair above is mutual assignability, and mutual assignability is
// SILENT about a missing optional property: `{ topicID?: string }` and
// `{ topicID?: string; extra?: string }` are mutually assignable to each other (an object missing
// an optional key still satisfies a type that declares it optional, in both directions), so a
// `HubReceiveOptions` that grows an optional field the conformance suite's inline `receive` option
// type does not mirror would pass `_mailboxIsAHub`/`_mailboxCoversHub` above without a compile
// error, and the drift would be invisible. This compares the KEY SETS instead, wrapped in tuples so
// the union `keyof` produces is compared as one type rather than distributed member-by-member —
// which a missing key changes even when every value type still unifies.
type KeysExact<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false
type ConformanceReceiveOptions = NonNullable<Parameters<ConformanceMailboxHub['receive']>[1]>
type ReceiveOptionsKeysExact =
  KeysExact<HubReceiveOptions, ConformanceReceiveOptions> extends true ? true : never
const _receiveOptionsKeysMatch: ReceiveOptionsKeysExact = true

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
