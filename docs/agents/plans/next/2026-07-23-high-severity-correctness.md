# Three high-severity correctness findings, promoted out of backlog

**Priority:** 1 — ahead of every other `next/` item. These are the highest-severity findings the
2026-07-02 audit produced, and they have sat in `backlog/` for three weeks behind a Phase 1 that
has not moved.
**Origin:** 2026-07-02 audit (commit `bb343d9`), milestone
`../milestones/2026-07-audit-remediation.md`. Extracted at the 2026-07-23 triage from the
`### High (correctness)` sections of `../backlog/2026-07-07-rpc-peer-lifecycle-hardening.md` and
`../backlog/2026-07-07-hub-tunnel-reliability.md`; the medium and low findings stay in those docs.

## Why these moved

The audit-remediation milestone flagged both source docs "pull forward at next triage once Phase 1
lands". Phase 1 items 4–8 have not landed and have no owner, so the instruction gated **high**
correctness work behind stalled **medium** work — a priority inversion, not a sequencing decision.
Promoting the high items resolves it without disturbing the rest of either doc.

## Verification status

All three re-read against `5eb220a` on 2026-07-23 and **confirmed still open**. Line numbers below
are current, not the `bb343d9` numbers the source docs carry. One finding's named mechanism no
longer exists and has been restated.

## Findings

### 1. `to()` is not gated on `ready` — `packages/rpc/src/peer.ts:1946`

`peer.protocol(name)` returns four methods. Three are wrapped:

```ts
dispatch: (prc, data) => withReady(() => surfaceFor(key).dispatch(prc, data)),
request: (prc, prm, options) => withReady(() => surfaceFor(key).request(prc, prm, options)),
gather: (prc, prm, options) => withReady(() => surfaceFor(key).gather(prc, prm, options)),
to: (memberDID) => surfaceFor(key).to(memberDID),
```

`to` is not. Calling it before init completes reaches `surfaceFor` (`:647`) with no protocol
registered and throws `Unknown protocol: <name>` for a name that is perfectly valid — a
misleading error for a timing bug.

**Fix:** wrap in `withReady` like its three siblings. Note this changes `to`'s return type from
sync to `Promise`, so it is a signature change on the public surface as well as a fix — cheap now
while `@kumiai/rpc` is 0.x, and worth taking together with the `ProtocolSurface` retyping in
`../backlog/rpc-api-surface.md` if that lands in the same window.

### 2. `resync()` bypasses the commit mutex — `packages/rpc/src/peer.ts:1952-1955`

**Restated 2026-07-23.** The original finding said `resync()` bypasses `handshakeTail`. That
mechanism no longer exists; it is now `commitTail`, taken through the `runSerial` helper
(`:794-805`), documented as "the group's commit mutex: every commit-lane operation serialized
through one tail".

The defect survived the rename. `resync()` is:

```ts
resync: async () => {
  await ready
  await rebuildEpoch()
},
```

Every one of the other seven `rebuildEpoch()` call sites runs under `runSerial` — `:1305` under
`:1298`; `:1575` and `:1682` under `:1573`; `:1698` under `:1697`; `:1770` and `:1860` under
`:1767`; and `:1287` inside `reconcileCommits`, which is reached only from `:1596` and `:1779`,
both themselves inside `runSerial` blocks. `resync()` is the sole caller that takes no lock.

So a host-called `resync()` can interleave with an inbound-commit rebuild and run two concurrent
teardown/build cycles over shared `runtimes`/`secret`/`epoch` state.

**Fix:** chain onto `commitTail` via `runSerial`, as every other rebuild path does. One caveat the
implementation must respect: `runSerial` is explicitly **not reentrant** (`:791-792`) — a task that
calls it again waits on a tail including itself. `resync()` is a top-level entry point and
`rebuildEpoch` does not itself take the lock, so wrapping is safe, but confirm that still holds at
implementation time rather than assuming it.

### 3. The durable-ack contract is dead — `packages/hub-tunnel/src/transport.ts:22`

`HubReceiveSubscription` declares `ack?: (sequenceID: string) => void | Promise<void>` and
documents it as "acknowledge a delivered message as durably handled, so the hub stops redelivering
it on reconnect". Nothing in `transport.ts` or `encrypted-transport.ts` ever calls it — the
encrypted wrapper also structurally drops the member. Over a durable hub, every tunnel frame is
redelivered on every reconnect until purge.

**Higher-stakes than when the audit filed it.** `HubPublishParams.retain` (`:52`) now defines the
`'mailbox'` class as "removed once every delivery is acked, or when it ages out" — so the retention
semantics introduced by `5eb220a` rest on a contract no caller satisfies. A mailbox-class entry is
now reclaimed only by ageing out.

**Fix, one of two, and the choice is the work:** ack processed frames in the read pump and forward
the call through the encrypted wrapper; **or** delete the contract, drop the `ack` member, and
document that durability belongs to the rpc mux. Do not leave it declared and uncalled — that is
what let the retention semantics be built on top of it.

## Test hooks

- Peer concurrency: `resync()` racing an inbound Commit, and `to()` called before init resolves.
  Both listed in `2026-07-07-test-gaps.md`.
- Tunnel teardown/redelivery: no test asserts the ack path or the teardown contract (`session-end`
  frame published, `hub.unsubscribe` called, `onSessionEnd` firing on a peer's frame). Also in
  `2026-07-07-test-gaps.md`.

Whichever fix option item 3 takes, it needs a redelivery test over a durable hub — the defect is
invisible against an in-memory hub that never redelivers.
