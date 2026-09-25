# Stream gathered replies and cancel a gather per call

**Origin:** backlog item `2026-09-25-rpc-cross-hub-gather.md`. Consumer: Kubun `@kubun/plugin-p2p`
`discoverWorkflows` (`../kubun/packages/plugin-p2p/src/groups/group-peer-manager.ts:1609-1666`), which
fans one query out through one peer per hub, dedupes DIDs across hubs after `Promise.all`, and cannot
count a global quorum as replies arrive or stop gathers still waiting on dark hubs.

## Goal

Let a caller observe each accepted, attributed reply of a gather as it arrives, and cancel one gather
without disposing the client. A consumer fanning out over several hubs can then normalize and dedupe
DIDs globally, count a global quorum, and abort the remaining gathers.

## API

`GatherOptions` (`packages/broadcast/src/client.ts`) gains two optional fields:

```ts
export type GatherOptions<T = unknown> = {
  quorum?: number
  timeoutMs?: number
  /** Called once per accepted reply (non-error, first from its sender), before the quorum check. */
  onReply?: (reply: GatheredReply<T>) => void
  /** Cancels this gather. The promise resolves with the replies collected so far. */
  signal?: AbortSignal
}
```

- `BroadcastClient.gather` keeps its signature and its one-shot `Promise<Array<GatheredReply>>`
  result. Existing callers are unaffected.
- `ProtocolSurface.gather` (`packages/rpc/src/peer.ts`) types `onReply` per protocol:
  `GatheredReply<T['Result']>`. `InternalSurface.gather` uses the untyped form.
- The surface forwarding (`peer.ts` `surfaceFor(...).gather`) passes all four options through.
- `request()` gets no signal. No consumer needs it.

## Semantics (`BroadcastClient.gather`)

**Accepted reply.** A reply with no `err`, from a `senderDID` not yet seen in this call. The existing
within-call dedupe on the authenticated `senderDID` is unchanged. `senderDID` is passed to `onReply`
exactly as the transport established it; broadcast does no normalization (the rpc peer already
normalizes before delivery).

**`onReply` ordering.** Invoked synchronously inside `collect`, after the reply is recorded and before
the quorum check. The reply that completes the quorum is therefore delivered to `onReply` too.

**Throwing `onReply`.** Caught and discarded. A throwing observer never changes the recorded replies,
the quorum count, or how the call settles.

**Abort before call.** If `signal.aborted` is already true when `gather` runs: resolve `[]`
immediately. No transport write, no pending entry, no timer, no listener.

**Abort after send.** Resolve with the replies collected so far.

**Single settlement path.** Every exit — quorum, timeout, abort, dispose, write failure — goes through
one `settle` step that, exactly once (guarded):

1. clears the timer,
2. deletes the pending `rid` entry,
3. removes the abort listener,
4. resolves (quorum/timeout/abort/dispose) or rejects (write failure).

After settlement no entry exists for the `rid`, so a late reply is dropped by `#read` and `onReply` can
never fire again. The abort listener is registered with `{ once: true }` and also removed explicitly on
other exits, so a long-lived signal shared by many gathers does not accumulate listeners.

**Timeout.** `timeoutMs` stays the maximum call duration and still resolves with collected replies.

**Write failure.** Still rejects with the write error, through the same cleanup.

**Dispose.** Unchanged outcome (resolves with partial replies), now through the same cleanup, so the
abort listener is removed too.

## Semantics (rpc surface)

`GroupPeer.protocol(name).gather` wraps the surface call in `withReady`, which awaits the peer's
initial `ready`. A peer that is not yet ready (for example, a dark hub) would otherwise hold an aborted
gather until `ready` settles. The gather wrapper therefore races `ready` against the signal: if the
signal aborts first (or is already aborted), resolve `[]` without waiting further and without calling
the surface. If `ready` rejects, the existing rejection propagates unchanged. `assertLive` still runs
before the surface call when `ready` wins.

## Out of scope

- Async-iterable gather result.
- Cross-call dedupe or global quorum inside kumiai; those stay with the consumer.
- Abort signal on `request()` or `dispatch()`.
- Enkaku changes. `TransportParams.signal` controls transport lifetime, not one correlated gather;
  the correlation state lives in `BroadcastClient`.

## Ports and conformance

No test double implements the gather surface (`rpc-conformance` and `hub-conformance` exercise the MLS
ledger gather, a different API). This change adds optional fields to a consumer-facing type; it does
not change a port contract. Run the full repo test and `test:types` gates; the contract suites run as
part of them.

## Tests

`packages/broadcast/test/client.test.ts` (or a new `gather-stream.test.ts`):

- `onReply` fires once per accepted reply, in arrival order, with the authenticated `senderDID`.
- A duplicate `senderDID` and an `err` reply do not fire `onReply`.
- The quorum-completing reply fires `onReply` before the promise resolves.
- Early global completion: two gathers on two clients, a caller-side counter over normalized DIDs
  aborts both once a global quorum is reached; both resolve with their partial replies.
- Abort before call: resolves `[]`, no transport write observed.
- Abort after send: resolves with the replies so far; a reply delivered afterwards does not fire
  `onReply` and does not change the resolved array.
- Timeout resolves with collected replies; abort listener removed afterwards.
- Write failure rejects; pending entry, timer and listener removed.
- Dispose resolves with partial replies; listener removed.
- A throwing `onReply` does not change the result or stop later replies being collected.
- A shared signal across many settled gathers holds no leftover listeners.

`packages/rpc/test/`:

- `ProtocolSurface.gather` type test: `onReply` receives `GatheredReply<Result>` for the protocol.
- `onReply` and `signal` are forwarded end to end through a group peer (extend
  `peer.test.ts` or `integration.test.ts`).
- Abort while the peer is waiting on `ready` resolves `[]` without waiting for `ready`.

## Release

`pnpm change` intents for `@kumiai/broadcast` and `@kumiai/rpc`: additive, within the 0.5 band.
Update the broadcast and rpc READMEs where `gather` options are documented.
