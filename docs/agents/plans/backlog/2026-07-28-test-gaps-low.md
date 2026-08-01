# Test gaps, low priority

**Priority:** low — none of these guards a security property or a load-bearing contract; each is a
branch or a wiring step nothing asserts.
**Origin:** split out of `completed/2026-07-07-test-gaps.complete.md` on 2026-07-28, when that item was re-verified
against current source. The Highs and Mediums that survived stayed there; this is the residue.

Each entry below was re-checked on 2026-07-28 — what is written is the state then, not the 2026-07-02
audit's.

- **Async-unwrap ordering.** `broadcast/test/sender.test.ts` and `transport.test.ts` pass only a
  synchronous `unwrap` (`recoverUnwrap`). An `unwrap` returning a promise can reorder delivery
  relative to a synchronous one, and nothing pins which order the transport guarantees.
- **Acceptor-tunnel teardown when a client vanishes without `session-end`.** The idle path itself is
  covered — `hub-tunnel/test/transport-lifecycle.test.ts:109` raises `TimeoutInterruption` and tears
  down, and `:139` checks inbound activity resets the timer. What is untested is the acceptor side
  specifically: a client that disappears mid-session, leaving the acceptor's registry entry and
  subscription to be reclaimed by idle timeout rather than by a frame.
- **Purge scheduling in `createHub`** — **mostly closed 2026-07-29, narrowed 2026-08-01.**
  `hub-server/src/hub.ts:104-113` installs a `setInterval` calling `store.purge`, cleared on
  `server.disposed`. When this was filed no test reached that level. The `onStoreError` work has
  since pinned two of its three halves: `hub-server/test/hub.test.ts:530` advances fake timers and
  asserts the hub schedules the purge, that the interval fires, and that a rejected purge is retried
  on the next one.

  What is still untested is `server.disposed.then(() => clearInterval(purgeTimer))` — that dispose
  stops the timer. The shape is now cheap, because that test supplies it: the same proxied store and
  fake timers, disposing and then advancing to assert no further call.
- **No mobile-runtime coverage of hub or rpc.** `tests/e2e-expo` depends on `@kumiai/mls` alone
  (`tests/e2e-expo/package.json:18`), so nothing exercises `@kumiai/hub-client` or `@kumiai/rpc`
  under a React Native runtime — where the crypto provider and the transport differ from Node.
