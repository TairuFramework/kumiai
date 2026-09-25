# Acknowledged durable app-frame delivery

**Origin:** backlog item `2026-09-25-rpc-acknowledged-durable-app-frame-delivery.md`. Consumer:
`@kubun/plugin-p2p`, which needs a transient failure between MLS open and host apply to recover
automatically.

## Problem

Opening an app frame consumes its message key (`crypto.ts` `unwrap`, `open-once.ts`). The retained drain
marks a frame done before emitting it, swallows a throwing listener, and advances the durable cursor over
the done run (`app-lane.ts` `drain`, `advanceCursor`). A live log push at the current epoch is staged done
in `note()` before the host outcome is known. So a crash between open and host apply loses the frame:
if the host saved the advanced ratchet, the frame can never open again; if it did not, the advanced cursor
skips the frame on restart.

## Goal

Declared `retain: 'log'` events are delivered **at least once** across crashes and handler failures, in
log order per protocol, with a stable frame identity the host can deduplicate on. Everything else keeps
today's semantics.

## Scope

- **In:** app frames published `retain: 'log'`: every frame the retained drain reads, and every live push
  that carries `logPosition`.
- **Out, unchanged:** ephemeral events (at most once, fire-and-forget), anycast requests and their replies
  (complete through live correlation or expiry), directed traffic, the commit lane.
- Kubun's adoption is a follow-up in the kubun repo.

The durable decision is made **before** open: a retained frame is a log frame, and a live push carries
`logPosition` only for a log frame. A log frame naming a procedure the protocol does not declare `log`
is completed by kumiai without delivery, exactly as the drain drops it today.

## Frame identity

```ts
export type AppFrameRef = {
  /** Stable across live push, retained pull, reconnect and replay at another position. */
  id: string
  /** The app topic the frame was read from. */
  topicID: string
  /** The protocol name the topic belongs to, so a record outlives its segment's topic mapping. */
  protocol: string
  /** The frame's log position on that topic. */
  position: string
}
```

`id = toB64U(sha256(u32be(len(topicIDBytes)) ‖ topicIDBytes ‖ ciphertext))`. Length-prefixed so the
concatenation is injective. The ciphertext is identical however the frame reaches the peer, so the live
push and the retained pull of one frame share one `id`. Only one of them can open it (the key is
consumed); the other fails `unwrap` and is dead, as today.

`position` orders records within a topic; `id` is the deduplication key. `protocol` is not part of `id`.

## Port change: `GroupCrypto`

```ts
export type PendingAppFrame = { frame: AppFrameRef; payload: Uint8Array; senderDID: string }

export type PendingAppFrames = {
  /** Every pending record, ordered by topicID then position. */
  list(): Promise<Array<PendingAppFrame>>
  /** Clear one record. Idempotent: an unknown id resolves. */
  complete(id: string): Promise<void>
}

export type GroupCrypto = {
  // ...existing members...
  unwrap(
    bytes: Uint8Array,
    opts?: { expectedAAD?: Uint8Array; frame?: AppFrameRef },
  ): GroupUnwrapResult | Promise<GroupUnwrapResult>
  /** Present iff this port provides durable app delivery. */
  pending?: PendingAppFrames
}
```

**Contract when `opts.frame` is set** (only ever set when `pending` is present):

- Before `unwrap` resolves, the port has durably saved, in **one atomic unit**, the handle state that
  consumed this frame's key **and** a pending record `{ frame, payload, senderDID }`.
- If `unwrap` throws, neither was saved: the handle state on disk still predates this frame.
- A record whose `id` already exists is not duplicated.
- `list()` returns every record saved and not completed, surviving process restart.

When `opts.frame` is absent, `unwrap` behaves exactly as today.

**Real implementation (`@kumiai/mls-rpc` `createGroupCrypto`):** a new optional param

```ts
pending?: {
  /** Save the handle and the record in one host transaction. */
  persistOpened(handle: GroupHandle, record: PendingAppFrame): Promise<void>
  list(): Promise<Array<PendingAppFrame>>
  complete(id: string): Promise<void>
}
```

`unwrap` with `frame` decrypts, then awaits `persistOpened(handle(), record)` before resolving; a throw
from `persistOpened` propagates. The port exposes `pending: { list, complete }`.

## App lane

**Frame states.** `AppFrame.sealed: Uint8Array | null` becomes a three-state field:
`{ state: 'sealed'; bytes } | { state: 'pending'; id } | { state: 'done' }`. The cursor rule is
unchanged: it passes a run of `done` frames and stops at the first that is not.

**Retained drain (`drain`).** For a frame sealed at the handle's epoch, when `crypto.pending` is present,
call `unwrap` with `frame`. On success the frame becomes `pending(id)` and its record is enqueued for
delivery; the drain does **not** emit. Unopenable, not-this-epoch and dead frames behave as today. Without
`crypto.pending` the drain behaves exactly as today.

**Live log push (`note` + open-once path).** When `crypto.pending` is present, a live push with
`logPosition` at the handle's epoch is staged `pending` (not `done`). The open-once path passes `frame`
to `unwrap` for such pushes, and on success enqueues the record instead of fanning it out to the event
listeners. Requests, replies and ephemeral events keep the existing fan-out.

The staged live push and a buffered retained copy of the same frame are the same `position`; the merge
keeps one entry, and whichever path opens it moves it to `pending(id)`.

**Hub ack.** A live log push is acked once `unwrap` resolves (the pending record is durable), before
delivery. An `unwrap` throw keeps today's `retainOnFailure` rule.

## Delivery queue

One ordered queue per protocol, running **outside** the commit mutex and the app-lane mutex.

For each record, in order:

1. Parse the payload. Self-echo (normalized `senderDID === localDID`), malformed JSON, not `typ: 'event'`,
   unknown protocol, or a procedure not declared `retain: 'log'`: kumiai calls `complete(id)` itself and
   moves on.
2. Validate and emit to the host handler with the frame reference in its context
   (`handlers.ts`: event handler context gains `frame: AppFrameRef`).
3. **Handler resolves** = acknowledgement: `await pending.complete(id)`, mark the frame `done`, and
   schedule a cursor advance under the app-lane mutex.
4. **Handler throws**: the record stays pending. Retry the same record after a backoff (1 s doubling to a
   60 s cap), blocking later records in this protocol's queue. This head-of-line block is intended: order
   is the contract. A host that wants to drop a frame acknowledges it.
5. A `complete()` failure is retried the same way; the handler may therefore run again (at least once).

Invalid event data (schema validation failure) is dropped and logged as today, then completed.

**Restart.** In `ready`, before the first drain opens anything, `list()` all pending records and enqueue
them, in order, per protocol. Records on a topic from an older segment are still delivered; delivery does
not depend on the current segment, only the cursor does. The record's `frame.protocol` selects the queue;
a record naming a protocol this peer no longer serves is completed without delivery.

**Dispose.** The queue stops; pending records stay in the store for the next start.

## Locking

- `persistOpened` runs where `unwrap` runs today: inside the commit mutex (drain) or the open-once chain
  (live). It must not call back into the peer.
- Host handlers run outside every kumiai lock. A handler may call `commit()`, `dispatch()` or `gather()`
  without deadlock, and a single-connection SQLite host never holds its connection across a kumiai lock
  wait.
- No later frame of a protocol is delivered before an earlier pending one is acknowledged. Later frames
  may be **opened** meanwhile (each lands in `pending` durably), so open order and delivery order are both
  log order.

## Guarantee (documented in the rpc README)

- Log events: at-least-once. The host records a deduplication entry keyed by `frame.id` in the same
  transaction as its effect, and acknowledges by resolving.
- An effect outside that transaction must be idempotent, or reconcile by `frame.id`, before the handler
  resolves.
- Replies: complete when their live correlation accepts them or expires. Ephemeral events: best-effort.

## Conformance

`rpc-conformance` gains a `pending` clause set, run against the real `mls-rpc` port (with an in-memory
host store) and the fake crypto double:

- `unwrap` with `frame` saves a record `list()` returns; a second open of the same bytes throws and saves
  nothing.
- A `persistOpened` failure makes `unwrap` throw and leaves nothing listed.
- `list()` order; `complete()` idempotent.
- Records survive a simulated restart (new port instance over the same store).

Hub conformance runs as regression. The double must stay no more permissive than the port.

## Tests (`packages/rpc/test/`)

- Live log push: delivered once through the queue, handler context carries `frame`; hub acked after open.
- Retained pull: same, cursor passes the frame only after the handler resolves.
- Duplicate delivery of the same ciphertext (live push + retained pull): one delivery.
- Handler throws: retried with backoff; later frames wait; cursor does not pass; ack clears it.
- **Decisive restart test:** shared in-memory "database" (handle snapshot + pending records + cursor)
  across two peer instances. Open a retained frame, crash before the handler runs; restart with the same
  database and hub: the frame is applied once, its record cleared, then the next frame opens and delivers.
- Cursor ordering with one pending frame followed by done frames.
- Without `crypto.pending`: existing behaviour unchanged (existing suites stay green).
- Handler calling `commit()` from inside delivery: no deadlock.

## Release

Minor band bump (0.6) for all twelve packages: the `GroupCrypto` port grows and a throwing log-event
handler now retries instead of consuming. `pnpm change` intents per package.

## Plan mode

learning-loop. Unproven assumptions to validate first:

1. A ts-mls handle serialize plus a pending row commit in one transaction inside `persistOpened`, and a
   restored handle cannot reopen the frame.
2. Moving delivery out of the mutexes keeps drain/live/cursor interleavings safe.
3. Live push and retained pull of one frame converge on one pending entry.
