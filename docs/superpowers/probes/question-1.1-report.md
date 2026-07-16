# Probe report — per-procedure retention for logged app events

**Status: DONE**

## Question answered

Yes. A per-procedure `retain: 'log'` marker, declared in the group protocol definition and
enforced at definition time, makes a logged app event pull-drainable (retained by the hub and
readable back with `fetchTopic`) while ephemeral events (the default) and all RPC stay on the live
mailbox lane. Both classes coexist on one app topic and `fetchTopic` returns only the logged
frames. The approach in the brief worked without touching `@kumiai/broadcast` or `@enkaku/protocol`.

## What changed

All changes are in `packages/rpc` (uncommitted — staged/unstaged for review; see below).

### 1. rpc-owned `defineGroupProtocol` — `packages/rpc/src/protocol.ts` (new)

Replaces the re-export from `@kumiai/broadcast`. Provides:

- `defineGroupProtocol` — an identity helper (preserves literal inference, like the underlying
  broadcast one) that additionally lets an `event` procedure declare `retain?: 'log'`.
  - **Type level:** the type parameter carries a self-referential constraint
    `Definition extends GroupProtocolDefinition & { [Name in keyof Definition]: RetainRule<Definition[Name]> }`,
    where `RetainRule<Procedure> = Procedure extends { type: 'event' } ? unknown : { retain?: never }`.
    A `request`/`stream`/`channel` procedure carrying `retain` fails the constraint and is a
    **type error**. (`protocol.ts:44-63`)
  - **Runtime level:** throws at definition time if any non-`event` procedure carries `retain`
    (belt-and-suspenders for JS callers / erased types). (`protocol.ts:64-72`)
- `retentionOf(protocol, procedureName) → 'log' | 'ephemeral'` — reads a procedure's declared
  retention for dispatch (and the future drain). (`protocol.ts:78-81`)
- Types `Retention`, `RetainableEventProcedureDefinition`, `GroupProcedureDefinition`,
  `GroupProtocolDefinition`.

Note on the type design: the first attempt used a homomorphic mapped **parameter** type
(`definition: Definition & EnforceRetention<Definition>`). Under a `const` type parameter that
reverse-maps during inference and collapses the *entire* offending entry to `never`, producing an
error on every property (type/param/result), which a single `// @ts-expect-error` cannot cover
cleanly. Moving the rule into the type-parameter **constraint** (inference from a plain
`definition: Definition`, validated afterward) lands exactly one error on the `retain` line.

### 2. rpc index — `packages/rpc/src/index.ts`

Line 7's `export { defineGroupProtocol, type GroupProtocolDefinition } from '@kumiai/broadcast'`
replaced with the rpc-owned exports from `./protocol.js` (Biome reordered the export blocks).

### 3. Shared encode helper — `packages/rpc/src/app-frame.ts` (new)

`encodeEventFrame(prc, data)` → `fromUTF(JSON.stringify({ payload: { typ: 'event', prc, data } }))`,
byte-identical to the broadcast transport's own pre-wrap encode
(`packages/broadcast/src/transport.ts:38,113` + the client's event shape at `client.ts:63`).

### 4. Publish split in `dispatch` — `packages/rpc/src/peer.ts`

- `ProtocolRuntime` gains a `topicID` field, set in `buildEpoch` from the same
  `protocolTopic(secret, epoch, name)` the runtime already derives. (`peer.ts:219-226`, `~303`)
- `surfaceFor(...).dispatch` branches on `retentionOf(protocols[name], prc)`:
  - `ephemeral` (default): unchanged — `runtime.client.dispatch(prc, data)`.
  - `log`: `mux.publish({ topicID, payload: await crypto.wrap(encodeEventFrame(prc, data ?? {})), retain: 'log' })`.
    The `data ?? {}` matches `BroadcastClient.dispatch`'s own default so the log-lane bytes equal
    the live-lane bytes. (`peer.ts:~330-347`)

Receive is unchanged: a logged publish lands on the same app topic as a mailbox publish and reaches
subscribers through the same mux drain, so the live listener still fires for logged events.

## The test — `packages/rpc/test/peer-app-retention.test.ts` (new)

Built directly on `createGroupPeer` + `FakeHub` + `createFakeCrypto` (the `peer.test.ts` pattern),
with a two-procedure protocol on one topic (`room/posted` = `retain:'log'`, `room/typing` =
ephemeral) defined via the rpc `defineGroupProtocol`.

1. **logged + ephemeral, one topic:** both events reach the online subscriber's handler live
   (proving the logged event is not diverted off the live path), and `fetchTopic` on the app topic
   returns exactly one frame — the logged one — decoded/unwrapped to its plaintext
   `{ payload: { typ:'event', prc:'room/posted', data:{ text:'kept' } } }`. The ephemeral frame is
   delivered live but absent from the log. (Covers acceptance criteria 1a, 1b, 2.)
2. **guardrail:** `retain:'log'` on a `request` procedure is rejected by a `// @ts-expect-error`
   (the type rejects it) AND `toThrow(/retain/)` (runtime). (Covers criterion 3.)

Criterion 4 (request/gather still function): no existing request/gather test was touched; the whole
suite stays green (`peer.test.ts`, `directed.test.ts`, `gather-suppress.test.ts`,
`integration.test.ts`, `bus-server.test.ts`).

### Fixture changes

**None.** No fixture needed extending — `createGroupPeer` already accepts arbitrary
`protocols`/`handlers`, and the app lane delivers to a registered handler without an MLS port. The
test wires its own peers rather than `makeMLSPeer` (which is hard-wired to the `chat` fixture),
mirroring the existing `peer.test.ts`/`peer-control-lanes.test.ts` direct-construction style.

## Verify output

Command: `pnpm run build && rtk proxy pnpm run lint && pnpm test` (repo root). Chain exit code: `0`.

```
# pnpm run build
 Tasks:    8 successful, 8 total   (build:types)
 Tasks:    8 successful, 8 total   (build:js)
@kumiai/rpc:build:js: Successfully compiled: 18 files with swc

# rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 211 files in 182ms. No fixes applied.

# pnpm test  (turbo: test:types + test:unit across the monorepo)
@kumiai/rpc:test:unit:  ✓ test/peer-app-retention.test.ts (2 tests) 70ms
...
@kumiai/rpc:test:unit:  Test Files  30 passed (30)
@kumiai/rpc:test:unit:       Tests  176 passed | 1 skipped (177)
@kumiai/hub-tunnel:test:unit:  Tests  63 passed (63)
@kumiai/hub-server:test:unit:  Tests  69 passed (69)
@kumiai/hub-client:test:unit:  Tests  5 passed (5)
@kumiai/mls:test:unit:  Test Files  25 passed (25)
@kumiai/mls:test:unit:       Tests  306 passed (306)
 Tasks:    30 successful, 30 total
```

`test:types` (`tsc --noEmit -p tsconfig.test.json`) passes with the `// @ts-expect-error` consumed —
confirming the type genuinely rejects `retain:'log'` on a request procedure (an unused directive
would have failed the type check). The 1 skipped rpc test is the pre-existing
`peer-app-drain.test.ts` restart-drain skip, untouched.

## Uncommitted changes

Left uncommitted for review (no commits made). On branch `feat/app-lane-delivery` (not switched):

- Modified: `packages/rpc/src/index.ts`, `packages/rpc/src/peer.ts`
- New: `packages/rpc/src/protocol.ts`, `packages/rpc/src/app-frame.ts`,
  `packages/rpc/test/peer-app-retention.test.ts`
- New (this report): `docs/superpowers/probes/`

## Surprises / concerns

- **Type-design subtlety (resolved):** the mapped-parameter-type approach reverse-maps under
  `const` inference and collapses the entry to `never` (multi-line errors). The constraint-clause
  form is the one that yields a single clean error. Worth remembering if this pattern is reused
  elsewhere.
- **`data ?? {}` coupling:** byte-identity with the live lane depends on mirroring
  `BroadcastClient.dispatch`'s `data = {}` default in the log branch. If the client's event shape or
  default ever changes, `encodeEventFrame` must track it. The live-delivery assertion in the test
  guards this (a logged event that didn't decode through the normal receive path would not fire the
  handler), but the two encoders are not literally the same function — `encodeEventFrame` replicates
  the transport's private `encode` because it is not exported from `@kumiai/broadcast` (which the
  brief said not to modify).
- **`retentionOf` reads a runtime `.retain` field** off the definition. It is only present because
  the rpc `defineGroupProtocol` (identity) leaves it on the object; a protocol built some other way
  (e.g. `as const satisfies ProtocolDefinition`) can never carry it, so those default to
  `'ephemeral'`, which is correct.
- **Scope kept minimal:** no drain, anchor model, or pruned signal — those are later questions, per
  the brief. This probe is marker + guardrail + publish split + proof of pull-ability only.
```
