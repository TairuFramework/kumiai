# Stream gathered replies and cancel a gather per call — complete

**Date:** 2026-09-25
**Status:** complete
**Packages:** `@kumiai/broadcast` (patch intent, additive; ships in the 0.10 band release), `@kumiai/rpc` (patch intent, additive; ships in the 0.10 band release)
**Origin:** Kubun `@kubun/plugin-p2p` `discoverWorkflows`, which fans one query out through one peer per
hub and could neither count a global quorum as replies arrived nor stop gathers waiting on dark hubs.

## Goal

Let a caller observe each accepted, attributed reply of a gather as it arrives, and cancel one gather
without disposing the client, so a consumer fanning out over several hubs can dedupe DIDs globally, count
a global quorum, and abort the rest.

## What was built

- **`GatherOptions<T>`** gains `onReply?(reply)` and `signal?: AbortSignal`. The one-shot
  `Promise<Array<GatheredReply>>` result is unchanged; existing callers are unaffected.
- **`onReply`** fires once per accepted reply (non-error, first from its authenticated `senderDID`),
  synchronously after the reply is recorded and before the quorum check, with the same object that ends
  up in the result. Throws are swallowed: an observer never changes settlement.
- **Abort resolves, never rejects**: a pre-aborted signal resolves `[]` without sending; an abort after
  send resolves with the replies collected so far — the same outcome as dispose. An abort fired during
  synchronous setup is caught by a recheck after the listener is registered.
- **One guarded `settle`** owns every exit (quorum, timeout, abort, dispose, write rejection, synchronous
  write throw): clears the timer, deletes the pending entry, removes the abort listener, exactly once. A
  late reply finds no entry, so `onReply` cannot fire after settlement, and a long-lived shared signal
  accumulates no listeners.
- **rpc surface** types `onReply` per protocol (`GatheredReply<Result>`) and forwards both options. The
  peer's gather races its `ready` wait against the signal: abort returns `[]` promptly on a peer that is
  not yet ready (a dark hub), `assertLive()` still runs on both outcomes, and the race's listener is
  removed either way.

## Key decisions

- **Callback over async iterable**: keeps the one-shot result for current callers; nothing needed an
  iterator.
- **`onReply` in method syntax, deliberately**: method parameters are bivariant under
  `strictFunctionTypes`, which keeps a typed public config assignable to the untyped internal surface
  config that the protocol-surface type test pins. An arrow-typed property breaks that assignment.
- **No `signal` on `request()`/`dispatch()`**: no consumer needs it.
- **No Enkaku change**: `TransportParams.signal` governs transport lifetime, not one correlated gather;
  the per-call state lives in `BroadcastClient`.
- Cross-hub dedupe and global quorum stay with the consumer.

## Verification

Forced gate `turbo run test:types test:unit --force` green (`Cached: 0`), integration suite green. A blind
branch review found two low issues (setup-time abort, untested settle-once guard), fixed with
mutation-checked tests: each guard was removed and its test confirmed to fail.

## Follow-on

Kubun adoption in `discoverWorkflows`: count normalized DIDs via `onReply` and abort remaining hub gathers
once the global quorum is reached. Kubun-side work, not tracked here.
