# Make anycast sound: success-only suppression + authenticated reply identity

**Priority:** 5.
**Origin:** 2026-07-02 audit (commit `bb343d9`), milestone
`milestones/2026-07-audit-remediation.md`.

## Findings

### High

- **`packages/broadcast/src/responder.ts:113-115` (duplicated
  `packages/rpc/src/bus-server.ts:77,89-90`) — error replies suppress healthy
  responders.** Any observed `res` — including error replies — calls `markReplied`, so for
  suppressible anycast one fast *failing* responder suppresses all would-be-successful
  ones and the client times out. Fix: only suppress on `err == null` replies.
- **`packages/broadcast/src/client.ts:56-57,129-133` — reply identity is self-asserted.**
  Replies are keyed and attributed by the unauthenticated `from` field while the
  MLS-authenticated `msg.senderDID` from `unwrap` is ignored, so any group member can
  forge another member's identity in `gather` results. Fix: use `senderDID` as (or check
  it against) the reply identity.

### Medium (same code paths, fold in)

- **`packages/rpc/src/bus-server.ts:14-15,34-115` — `createGroupBusServer` re-implements
  ~70 lines of `createBroadcastResponder`** (jitter, suppression, reply shape) and
  re-declares `ReplyData`/`RequestData` — the two already share the error-suppression bug
  above. Fix: extend the broadcast responder with an event-handler hook; delete the
  duplicate. Doing this first means the suppression fix lands once.
- **`packages/rpc/src/bus-server.ts:96-102` + `handlers.ts:39-51` — bus-lane input
  unvalidated.** Request `prm` and event `data` reach handlers with zero validation
  against the protocol's declared JSON schemas (the directed enkaku `Server` path does
  validate). Fix: validate in `adaptBusHandlers` or `createGroupBusServer`.
- **`packages/rpc/src/handlers.ts:44-46` — bus-lane handler `ctx.signal` can never fire**
  (fresh `AbortController().signal`, never aborted). Fix: abort on responder
  dispose/suppression, or omit `signal` from the context.

## Scope

`@kumiai/broadcast` (`responder.ts`, `client.ts`), `@kumiai/rpc` (`bus-server.ts`,
`handlers.ts`).

## Test hooks

No mixed error/success anycast test exists (`responder.test.ts:30` tests only a lone
erroring responder) — would catch the suppression bug. See
`next/2026-07-07-test-gaps.md`.
