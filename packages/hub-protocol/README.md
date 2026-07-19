# @kumiai/hub-protocol

The hub's wire definition and storage contract: an `@enkaku` `ProtocolDefinition` for blind pub/sub
over opaque topic IDs, the `HubStore` interface a host implements behind it, and the named errors
that cross the wire. Types and schemas only — no client, no server, no storage.

## Exports

- `hubProtocol` / `HubProtocol` — the enkaku protocol definition: `hub/publish`, `hub/subscribe`,
  `hub/unsubscribe`, `hub/topic/fetch`, `hub/receive` (a channel), `hub/keypackage/upload`,
  `hub/keypackage/fetch`.
- `HubStore` and its params/result types — the storage contract, verified by
  `@kumiai/hub-conformance`.
- `HeadMismatchError`, `NotSubscribedError`, `RetentionExceededError`, `HUB_ERROR_CODES`,
  `hubErrorCodeOf`, `hubErrorFromCode` — the named errors and their wire codes, so a caller can tell
  "I lost the compare-and-set, rebase and retry" from "the hub is unreachable". A transport failure
  carries no hub code at all.

The hub is blind: topic IDs are opaque strings it never derives or interprets, and payloads are
base64 on the wire and `Uint8Array` in the store.

## Retention is a class and a duration, and they are independent

The **class** is declared per publish (`retain: 'log' | 'mailbox'`); the **duration** is requested
per subscribe.

- `'mailbox'` (the default) is delivery-derived: every reader is known at publish time, so the last
  ack frees the frame.
- `'log'` is not: a subscriber that must read a frame may not exist when it is published — a member
  invited tomorrow reads commits published today — so no refcount over current subscribers can free
  it. It is appended whether or not anyone is subscribed, and only `trim` removes it. Never `ack`,
  never `unsubscribe`.

A topic's log is its log-class frames and **nothing else**. That exclusion is load-bearing: a
mailbox frame does not move the head, so a reader that met one in the log would advance its cursor
to a position the head can never equal, and every compare-and-set anchored there would lose forever.
Since the class is the *publisher's* to choose, a store that serves mailbox frames from the log lets
any member permanently wedge every writer on the topic with a single publish. The same reasoning
governs any depth bound a host layers on: count log-class frames only, or a mailbox flood evicts the
log.

## The head is stored state, not a projection of the log

`head` names the last accepted log publish and **outlives every frame**, so it still stands after a
`trim` or `purge` empties the log. A host that derives it (`SELECT max(sequenceID) WHERE topic = ?
AND retain = 'log'`) passes every single-connection test, then returns `null` the first time a log
ages out — and a peer that reads that `null`, compare-and-sets on `expectedHead: null`, wins, and
forks the group.

Two more things a plausible store gets wrong:

- **`sequenceID` is minted by the store, inside the accepting transaction** — never by the calling
  process, which collides across two hubs on one database. It is lexicographically ordered and
  strictly increasing within a topic: fixed-width zero-padded, not a bare decimal (`"10" < "9"`) and
  not a UUID. Every comparison the design makes is a string comparison on this value.
- **`publish` is one transaction, in one order**: check `publishID` for a replay, then compare
  `expectedHead`, then mint, append, and advance the head. Dedup before the head check, because a
  replay carries a stale `expectedHead` by construction — the publish it replays is what moved the
  head — so a store comparing first tells the caller its commit was lost when it landed. And the
  `publishID` record is **not a log entry**: no deleter may reach it, its retention is its own
  (indefinite recommended), and it outlives the frame it names.

## `logPosition` is not `sequenceID`

A pushed frame on `hub/receive` carries both. `sequenceID` names its place in **this recipient's
delivery queue** — a sequence that runs across every subscribed topic, skips the recipient's own
frames, and is emptied by acking. `logPosition` names where the frame sits in **its topic's log**,
which is the position `hub/topic/fetch` would serve it at, and therefore the only value a reader's
log cursor may be moved to.

It is present exactly when the frame is log-class and absent otherwise. A mailbox frame has no place
in any log, so an empty string or a zero would be a lie a cursor acts on — and a cursor moved to a
position the log does not contain skips every frame between it and the real one, permanently and
silently. The store is the one party that can report it, because it assigned both.
