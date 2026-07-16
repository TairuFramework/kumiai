# Probe brief — per-procedure retention for logged app events

You are an implementation probe in the `@kumiai/kumiai` monorepo (`/Users/paul/dev/yulsi/kumiai`),
package `packages/rpc`. Work only in `packages/rpc` (plus `packages/rpc/test`). Do a focused, minimal
change — this is a probe validating one assumption, not a full feature.

## The exact question being answered

Does a **per-procedure `retain:'log'` marker** make a logged app event pull-drainable, while ephemeral
events and all RPC (`request`/`gather`/`reply`) stay live — with the marker declared in the group
protocol definition and enforced at definition time?

## Relevant spec section (verbatim — do not just reference)

> App traffic has two orthogonal dimensions: Kind — `event` (fire-and-forget, 1→N) |
> `request`/`gather`/`reply` (RPC correlation); Retention — `log` (retained by the hub, pullable to a
> cursor, drained on return) | `ephemeral` (live push, mailbox-class, dropped if no subscriber).
>
> Guardrail: only events may be `log`. `request`/`gather`/`reply` are always ephemeral. Retaining
> correlation traffic is unsafe: a `request` re-pulled during a drain re-fires its responder; the
> `rid`/timeout/quorum a reply correlates against is dead by the time a member returns.
>
> Retention is declared per procedure in the group protocol definition — not chosen per call. An event
> procedure marks `retain: 'log'`; the default is ephemeral. Every `dispatch` of that procedure is
> retained regardless of call site. The protocol definition is where the guardrail is enforced:
> declaring `retain:'log'` on a `request`/`gather` procedure is rejected at definition time. The send
> API stays a single `dispatch(prc, data)` that routes by the procedure's declared retention; the
> receive side is unchanged (handlers keyed by procedure name). A topic may carry both classes —
> `fetchTopic` returns only `retain:'log'` frames, so a returning member's drain pulls every app topic
> and receives exactly the logged events; mixing on one topic is safe.

## Approved approach (from the design discussion — follow this; report BLOCKED if it doesn't work, do NOT try a different design without asking)

1. **rpc-owned `defineGroupProtocol`.** Today `packages/rpc/src/index.ts:7` re-exports
   `defineGroupProtocol` and `GroupProtocolDefinition` straight from `@kumiai/broadcast`
   (`packages/broadcast/src/protocol.ts`). Replace that re-export with an rpc-owned wrapper so an
   `event` procedure may declare an optional `retain: 'log'` field (default = ephemeral when absent).
   - Type level: the accepted definition type allows `retain?: 'log'` **only** on procedures whose
     `type` is `'event'`; a `request`/`gather` procedure carrying `retain:'log'` should be a **type
     error** (a conditional/mapped type over the procedure entries). Keep it structurally compatible
     with the underlying `GroupProtocolDefinition` for everything else, and preserve literal-type
     inference like the current identity helper does.
   - Runtime level: `defineGroupProtocol` also **throws at definition time** if any non-`event`
     procedure carries `retain:'log'` (belt-and-suspenders for JS callers / erased types).
   - Do NOT modify `@kumiai/broadcast` or `@enkaku/protocol`. The marker and its validation live in
     rpc. `@kumiai/broadcast`'s `defineGroupProtocol` stays as-is; rpc wraps it.
   - Provide a helper to read a procedure's retention from a definition (used by dispatch + the future
     drain): `(protocol, procedureName) → 'log' | 'ephemeral'`.

2. **Publish split in `dispatch`.** In `packages/rpc/src/peer.ts`, the app surface's `dispatch` is
   `surfaceFor(...).dispatch = (prc, data) => runtime.client.dispatch(prc, data)` (around
   `peer.ts:328`). Branch by the procedure's declared retention:
   - `ephemeral` (default): unchanged — `runtime.client.dispatch(prc, data)`.
   - `log`: publish via the mux log lane — `mux.publish({ topicID, payload, retain: 'log' })`, where
     `topicID` is the same app `protocolTopic(secret, epoch, name)` the runtime already uses
     (`peer.ts:257`), and `payload` is **byte-identical** to what the broadcast transport would have
     produced for that event, so the existing live receive + `unwrap` stay symmetric. The transport
     encodes `wrap(encode({ payload: { typ: 'event', prc, data } }))` where `encode` is
     `fromUTF(JSON.stringify(value))` (see `packages/broadcast/src/transport.ts:38,105-114`) and
     `wrap` is `crypto.wrap`. Factor a tiny shared encode helper rather than duplicating the JSON
     shape by hand; the bytes MUST match the transport's, verified by the live-delivery assertion.
   - Receive is unified and unchanged: both a `retain:'log'` publish and a mailbox publish land on the
     same topic and reach subscribers through the same mux drain, so the live listener still fires for
     logged events. Only publish branches here; the returning-member drain is a LATER question, not
     this probe.

3. Keep the change minimal. Do not build the drain, the anchor model, or the pruned signal — those are
   later questions. This probe is only: the marker + guardrail + publish split + proof of pull-ability.

If approach step 2 fights the transport (e.g. you cannot produce byte-identical frames without
touching `@kumiai/broadcast`), STOP and report `BLOCKED` with the specific obstacle — do not fall back
to modifying broadcast on your own.

## Done when (acceptance criteria — all required)

Write a new test `packages/rpc/test/peer-app-retention.test.ts` proving:
1. A **logged** event (`retain:'log'` procedure) dispatched by one member is (a) received live by an
   online subscriber via its handler, AND (b) independently returned by `mux.fetchTopic` on that app
   topic (assert the decoded/unwrapped plaintext, not just presence).
2. An **ephemeral** event (no `retain`) is received live by the subscriber's handler but is **NOT**
   returned by `mux.fetchTopic` on that topic.
3. Declaring `retain:'log'` on a `request`/`gather` procedure is rejected — a **type error** (a
   `// @ts-expect-error` line proving the type rejects it) AND a runtime throw from
   `defineGroupProtocol`.
4. `request`/`gather` still function (an existing test covering them stays green — do not weaken it).

Use the existing test fixtures under `packages/rpc/test/fixtures/` (e.g. `makeMLSPeer`,
`DurableFakeHub`) the way `peer-app-drain.test.ts` and `peer-control-lanes.test.ts` do. If the fixture
cannot register an app handler to observe delivery, extend the fixture minimally (this is a known gap
called out in the design) — but keep it small and note it in the report.

## Conventions (MUST follow)

- Read `kigu:conventions` (kigu marketplace skill) and the repo `AGENTS.md`/`CLAUDE.md`.
- `type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID`/`HTTP`/`JWT`; ES `#fields`,
  never `private`/`readonly`. Do not edit generated `lib/`.
- **Code, comments, and test names never reference plan questions, decision numbers, or phase labels**
  (no `// Q1.1`, no "phase 1"). Capture the invariant directly (e.g. "logged events are retained and
  pullable; ephemeral events are not").

## Verify (run from repo root, paste the actual output into the report)

`pnpm run build && rtk proxy pnpm run lint && pnpm test`

Note: plain `pnpm run lint` is intercepted by a local `rtk` shim → eslint; use `rtk proxy pnpm run
lint` for real biome output. If a command is unavailable, say so in the report rather than skipping.

## Report contract

Write the FULL report (what you changed, file:line, the test, the pasted verify output, any fixture
changes, surprises, and concerns) to `docs/superpowers/probes/question-1.1-report.md`.

Return to me ONLY: status (`DONE` / `DONE_WITH_CONCERNS` / `NEEDS_CONTEXT` / `BLOCKED`), the commit(s)
you made (if any — otherwise leave changes staged/uncommitted and say so), a one-line test summary, and
any concerns. Do not paste the full diff back to me.
