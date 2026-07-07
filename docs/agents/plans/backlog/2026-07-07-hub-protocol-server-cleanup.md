# hub protocol/server cleanup

**Priority:** backlog — protocol versioning, shared types, error codes, and API ergonomics
across `@kumiai/hub-protocol`, `@kumiai/hub-client`, `@kumiai/hub-server`.
**Origin:** 2026-07-02 audit (commit `bb343d9`), milestone
`milestones/2026-07-audit-remediation.md`.

## Findings

### Medium (API / protocol design)

- **`packages/hub-protocol/src/protocol.ts:3-151` — no protocol version anywhere** (only
  the tunnel frame/envelope carries `v: 1`); breaking changes are undetectable by peers.
  Fix: version the procedure namespace (`hub/v1/...`) or add a hello/version procedure.
- **`packages/hub-protocol/src/types.ts:11-15` vs `hub-tunnel/src/transport.ts:36-48` vs
  `hub-client/src/client.ts:8-11` — `PublishParams` defined three times** with drifting
  shapes (Uint8Array vs base64 string payload); hub-tunnel's `HubLike` re-declares the
  store surface. Fix: single home in hub-protocol; derive `HubLike`.
- **`packages/hub-client/src/client.ts:8-11,39-43` — `HubClient.publish` takes pre-base64
  `payload: string`,** leaking wire encoding to callers while the rest of the stack uses
  `Uint8Array`. Fix: accept `Uint8Array`, `toB64` internally.

### Low

- `packages/hub-server/src/handlers.ts:125,135,142,224,231,240` — every handler force-cast
  (`as RequestHandler<...>`), suppressing type errors between protocol schema and
  implementation. Fix: type the handlers map as `ProcedureHandlers<HubProtocol>` without
  per-member casts.
- `packages/hub-server/src/handlers.ts:57,93,151` — plain `Error` mixed with
  `HandlerError`; `EK01` doubles for rate-limit and writer-conflict. Fix: `HandlerError`
  with distinct codes throughout.
- `packages/hub-client/src/client.ts:57-65` — `receive()` returns the raw `ChannelCall`;
  correct at-least-once consumption requires hand-crafting `channel.send({ ack: [...] })`.
  Fix: expose an async-iterator wrapper with `ack(sequenceID)`.
- `packages/hub-protocol/src/protocol.ts:88-98` — `hub/receive` push schema omits
  `maxLength` bounds present on request schemas; client-side validation of pushes is
  unbounded. Fix: mirror publish-side bounds.
- `packages/hub-server/src/memoryStore.ts:91-104` — global monotonic `counter` returned as
  `sequenceID` even for dropped publishes leaks hub-wide message volume; caller can't tell
  stored from dropped. Fix: per-topic or randomized sequence IDs and/or a
  `stored: boolean` result. (security)
- `packages/hub-server/src/hub.ts:93` — `server.disposed.then(...)` has no rejection
  handler; the purge `setInterval` is also never `unref`ed. Fix: add `.catch`/`finally`;
  `unref()` where available. (correctness)

## Test hooks

Purge scheduling in `createHub` (`hub.ts:85-94`) untested — see
`next/2026-07-07-test-gaps.md`.
