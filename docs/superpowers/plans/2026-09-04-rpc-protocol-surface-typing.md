# Typed `ProtocolSurface` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** executing
**Mode:** tasks

**Goal:** Key `@kumiai/rpc`'s `ProtocolSurface` off the protocol's procedure map so
`dispatch`/`request`/`gather` are typed against the concrete protocol, closing the phantom type
parameter.

**Architecture:** Mirror `@enkaku/client`'s two-layer typing — a precomputed definitions map
(`GroupEventDefs`/`GroupRequestDefs`) that narrows event/request procedures inside a mapped type and
stores `Data`/`Param`/`Result`, and public methods that index the stored map. The methods take one
enkaku-style config object (`{ data }` / `{ param, ...options }`). The untyped `BroadcastClient`
substrate is unchanged; two rpc layers (`surfaceFor` and the readiness wrappers) translate the
config object to the positional client behind a cast at `GroupPeer.protocol`.

**Tech Stack:** TypeScript, `@enkaku/protocol` type helpers (`DataOf`, `ReturnOf`,
`EventProcedureDefinition`, `RequestProcedureDefinition`), vitest `expectTypeOf`, `tsc --noEmit`
(`test:types`).

**Spec:** `docs/superpowers/specs/2026-09-04-rpc-protocol-surface-typing-design.md` — read it
alongside this plan.

## Global Constraints

- pnpm only. Run scripts as `rtk proxy pnpm run <script>` or invoke the tool directly; the bare
  `pnpm run` shim can redirect to the wrong tool.
- Do not edit generated files (`lib/`).
- Internal `@kumiai/*` deps are `workspace:^`; the twelve packages share one version band and move
  together.
- `@kumiai/broadcast` and `@kumiai/rpc` both ship in the **same `minor`** (0.x → breaking is a
  minor). The 0.5 band is already released, so this is an ordinary in-band `minor`, no first-publish
  fixup.
- No `ProtocolSurface` runtime-behavior change: the only new runtime lines are `surfaceFor`'s config
  destructure and the readiness wrappers' two-arg forward. Runtime suites must stay green after call
  sites migrate.
- `test:types` is the real gate for every type claim (vitest strips types). Pair every type change
  with `rtk proxy pnpm --filter <pkg> run test:types`.

---

### Task 1: `GatheredReply<T = unknown>` generic in `@kumiai/broadcast`

Make the reply type carry a typed value, defaulted so every existing use is unchanged. Isolated and
non-breaking; lands first so `@kumiai/rpc` can reference `GatheredReply<Result>`.

**Files:**
- Modify: `packages/broadcast/src/client.ts:23`
- Test: `packages/broadcast/test/gathered-reply-types.test.ts` (create)

**Interfaces:**
- Produces: `type GatheredReply<T = unknown> = { senderDID: string; value: T }` — exported from
  `@kumiai/broadcast` (already re-exported at `packages/broadcast/src/index.ts:11`).

- [ ] **Step 1: Write the failing type test**

Create `packages/broadcast/test/gathered-reply-types.test.ts`:

```ts
import { expectTypeOf, test } from 'vitest'
import type { GatheredReply } from '../src/client.js'

test('GatheredReply carries a typed value and defaults to unknown', () => {
  expectTypeOf<GatheredReply<number>['value']>().toEqualTypeOf<number>()
  expectTypeOf<GatheredReply>().toEqualTypeOf<{ senderDID: string; value: unknown }>()
})
```

- [ ] **Step 2: Run test:types to verify it fails**

Run: `rtk proxy pnpm --filter @kumiai/broadcast run test:types`
Expected: FAIL — `GatheredReply<number>` errors ("Type 'GatheredReply' is not generic").

- [ ] **Step 3: Add the type parameter**

In `packages/broadcast/src/client.ts:23`, change:

```ts
export type GatheredReply = { senderDID: string; value: unknown }
```

to:

```ts
export type GatheredReply<T = unknown> = { senderDID: string; value: T }
```

Leave `BroadcastClient.gather`'s own `Promise<Array<GatheredReply>>` return as-is — the default
`unknown` keeps it valid.

- [ ] **Step 4: Run tests to verify green**

Run: `rtk proxy pnpm --filter @kumiai/broadcast run test`
Expected: PASS — both `test:types` and `test:unit` green (the default preserves every existing use).

- [ ] **Step 5: Commit**

```bash
git add packages/broadcast/src/client.ts packages/broadcast/test/gathered-reply-types.test.ts
git commit -m "feat(broadcast): make GatheredReply generic over its value type"
```

---

### Task 2: Typed `ProtocolSurface` in `@kumiai/rpc`

The atomic type-plus-impl change. The definitions maps, the public surface, the internal shape, the
`surfaceFor` retype, the readiness-wrapper retype, and the three cascaded constraint bounds must
compile together — they land in one commit. Migrate call sites driven by `test:types`.

**Files:**
- Modify: `packages/rpc/src/peer.ts` — imports (top), `ProtocolSurface` + new helpers
  (`peer.ts:263-268`), `GroupPeerParams` bound (`peer.ts:188`), `GroupPeer` bound (`peer.ts:270`),
  `surfaceFor` (`peer.ts:728-772`), readiness wrappers (`peer.ts:2111-2118`).
- Modify: every `test/*.ts` with a `peer.protocol(x).dispatch|request|gather(...)` call
  (checker-flagged; ~25 files).
- Test: `packages/rpc/test/protocol-surface-types.test.ts` (create).

**Interfaces:**
- Consumes: `GatheredReply<T>` from Task 1.
- Produces:
  - `type ProtocolSurface<Protocol extends GroupProtocolDefinition>` with typed
    `dispatch`/`request`/`gather`/`to` (signatures below).
  - `GroupPeer<Protocols extends Record<string, GroupProtocolDefinition>>`,
    `GroupPeerParams<Protocols extends Record<string, GroupProtocolDefinition>>`.

- [ ] **Step 1: Add the type-level test (red)**

Create `packages/rpc/test/protocol-surface-types.test.ts`. It uses a never-called function so tsc
checks it but vitest never executes it:

```ts
import type { GatheredReply } from '@kumiai/broadcast'
import { expectTypeOf } from 'vitest'
import { createGroupPeer } from '../src/peer.js'
import { defineGroupProtocol } from '../src/protocol.js'

const chat = defineGroupProtocol({
  'chat/posted': { type: 'event', data: { type: 'object', properties: { text: { type: 'string' } } } },
  'chat/ask': { type: 'request', param: { type: 'object' }, result: { type: 'string' } },
})
type Protocols = { chat: typeof chat }

// Never called at runtime; present only for `tsc` to check.
async function _protocolSurfaceTypes(peer: ReturnType<typeof createGroupPeer<Protocols>>) {
  const chat = peer.protocol('chat')

  // dispatch: event names only, data under `data`
  await chat.dispatch('chat/posted', { data: { text: 'hi' } })
  // @ts-expect-error unknown procedure name
  await chat.dispatch('chat/nope', { data: {} })
  // @ts-expect-error dispatch rejects a request procedure
  await chat.dispatch('chat/ask', { data: {} })

  // request: request names only, typed result
  const answer = await chat.request('chat/ask', { param: {} })
  expectTypeOf(answer).toEqualTypeOf<string>()
  // options fold into the same config
  await chat.request('chat/ask', { param: {}, timeoutMs: 10 })
  // @ts-expect-error request rejects an event procedure
  await chat.request('chat/posted', { param: {} })

  // gather: typed replies
  const replies = await chat.gather('chat/ask', { param: {} })
  expectTypeOf(replies).toEqualTypeOf<Array<GatheredReply<string>>>()
}
```

- [ ] **Step 2: Run test:types to verify it fails**

Run: `rtk proxy pnpm --filter @kumiai/rpc run test:types`
Expected: FAIL — the `@ts-expect-error` lines are *unused* against today's loose surface (no error to
suppress), so tsc reports "Unused '@ts-expect-error' directive", and `expectTypeOf(answer)` is
`unknown` not `string`.

- [ ] **Step 3: Add the enkaku helpers imports**

In `packages/rpc/src/peer.ts`, extend the `@enkaku/protocol` import (currently `import type {
ProtocolDefinition } from '@enkaku/protocol'`, `peer.ts:2`):

```ts
import type {
  DataOf,
  EventProcedureDefinition,
  ProtocolDefinition,
  RequestProcedureDefinition,
  ReturnOf,
} from '@enkaku/protocol'
```

Ensure `GroupProtocolDefinition` is imported from `./protocol.js` (add it to the existing
`./protocol.js` import if not already present):

```ts
import { type GroupProtocolDefinition, retentionOf } from './protocol.js'
```

- [ ] **Step 4: Replace the `ProtocolSurface` type with the two-layer form**

Replace `packages/rpc/src/peer.ts:263-268` with:

```ts
type FilterNever<T> = { [K in keyof T as T[K] extends never ? never : K]: T[K] }

type GroupEventDefs<Protocol extends GroupProtocolDefinition> = FilterNever<{
  [P in keyof Protocol & string]: Protocol[P] extends EventProcedureDefinition
    ? { Data: DataOf<Protocol[P]['data']> }
    : never
}>
type GroupRequestDefs<Protocol extends GroupProtocolDefinition> = FilterNever<{
  [P in keyof Protocol & string]: Protocol[P] extends RequestProcedureDefinition
    ? { Param: DataOf<Protocol[P]['param']>; Result: ReturnOf<Protocol[P]['result']> }
    : never
}>

export type ProtocolSurface<
  Protocol extends GroupProtocolDefinition,
  Events extends GroupEventDefs<Protocol> = GroupEventDefs<Protocol>,
  Requests extends GroupRequestDefs<Protocol> = GroupRequestDefs<Protocol>,
> = {
  dispatch: <P extends keyof Events & string, T extends Events[P] = Events[P]>(
    prc: P,
    ...args: T['Data'] extends never ? [config?: { data?: never }] : [config: { data: T['Data'] }]
  ) => Promise<void>
  request: <P extends keyof Requests & string, T extends Requests[P] = Requests[P]>(
    prc: P,
    ...args: T['Param'] extends never
      ? [config?: { param?: never } & RequestOptions]
      : [config: { param: T['Param'] } & RequestOptions]
  ) => Promise<T['Result']>
  gather: <P extends keyof Requests & string, T extends Requests[P] = Requests[P]>(
    prc: P,
    ...args: T['Param'] extends never
      ? [config?: { param?: never } & GatherOptions]
      : [config: { param: T['Param'] } & GatherOptions]
  ) => Promise<Array<GatheredReply<T['Result']>>>
  to: (memberDID: string) => Promise<Client<Protocol>>
}

// The untyped internal shape surfaceFor builds against, bridged to the positional BroadcastClient.
type InternalSurface = {
  dispatch: (prc: string, config?: { data?: Record<string, unknown> }) => Promise<void>
  request: (prc: string, config?: { param?: unknown } & RequestOptions) => Promise<unknown>
  gather: (prc: string, config?: { param?: unknown } & GatherOptions) => Promise<Array<GatheredReply>>
  to: (memberDID: string) => Promise<Client<ProtocolDefinition>>
}
```

`RequestOptions`/`GatherOptions`/`GatheredReply`/`Client` are already imported in `peer.ts`.

- [ ] **Step 5: Tighten the two cascaded bounds**

`packages/rpc/src/peer.ts:188` — `GroupPeerParams`:

```ts
export type GroupPeerParams<Protocols extends Record<string, GroupProtocolDefinition>> = {
```

`packages/rpc/src/peer.ts:270` — `GroupPeer`:

```ts
export type GroupPeer<Protocols extends Record<string, GroupProtocolDefinition>> = {
```

Leave `createGroupPeer<Protocols extends Record<string, ProtocolDefinition>>` and internal
`ProtocolDefinition` uses untouched for now; Step 7 fixes whatever the checker demands.

- [ ] **Step 6: Retype `surfaceFor` and destructure the config**

Change `surfaceFor`'s return annotation (`peer.ts:728`) from `ProtocolSurface<ProtocolDefinition>`
to `InternalSurface`, and rewrite the three method bodies to read from `config`:

```ts
const surfaceFor = (name: string): InternalSurface => {
  const runtime = runtimes.get(name)
  if (runtime == null) throw new Error(`Unknown protocol: ${name}`)
  return {
    dispatch: async (prc, config) => {
      const data = config?.data ?? {}
      if (retentionOf(protocols[name], prc) === 'log') {
        const { topicID, payload } = await sealForSegment(name, encodeEventFrame(prc, data))
        await mux.publish({ topicID, payload, retain: 'log' })
        return
      }
      await runtime.client.dispatch(prc, data)
    },
    request: (prc, config) =>
      runtime.client.request(prc, config?.param, {
        errorThreshold: config?.errorThreshold,
        timeoutMs: config?.timeoutMs,
      }),
    gather: (prc, config) =>
      runtime.client.gather(prc, config?.param, {
        quorum: config?.quorum,
        timeoutMs: config?.timeoutMs,
      }),
    to: async (memberDID) => {
      // ... body unchanged from peer.ts:746-771 ...
    },
  }
}
```

Keep the `to` body exactly as it is today — only `dispatch`/`request`/`gather` change. Passing
`{ errorThreshold: undefined, timeoutMs: undefined }` is safe: `BroadcastClient.request` applies
`options.errorThreshold ?? Number.POSITIVE_INFINITY` and `?? DEFAULT_TIMEOUT_MS`.

- [ ] **Step 7: Retype the readiness wrappers to `(prc, config)`**

Replace `packages/rpc/src/peer.ts:2114-2117` (inside `protocol:`), forwarding two args:

```ts
      return {
        dispatch: (prc, config) => withReady(() => surfaceFor(key).dispatch(prc, config)),
        request: (prc, config) => withReady(() => surfaceFor(key).request(prc, config)),
        gather: (prc, config) => withReady(() => surfaceFor(key).gather(prc, config)),
        to: (memberDID) => withReady(() => surfaceFor(key).to(memberDID)),
      } as ProtocolSurface<Protocols[K]>
```

- [ ] **Step 8: Run test:types — expect the new test green and call sites flagged**

Run: `rtk proxy pnpm --filter @kumiai/rpc run test:types`
Expected: `protocol-surface-types.test.ts` now type-checks (all `@ts-expect-error` used,
`expectTypeOf` passes). Remaining failures are the ~25 test files whose
`peer.protocol(x).dispatch|request|gather(...)` calls still pass the payload positionally — the
migration list. Also fix any failure inside `createGroupPeer`'s body / `handlers` typing surfaced by
the tighter `Protocols` bound (`ProcedureHandlers<Protocols[K]>` at `peer.ts:194,645`): a
`GroupProtocolDefinition` satisfies `ProcedureHandlers`'s `ProtocolDefinition` bound, so this is
expected to compile; if it does not, retyping the internal `ProtocolDefinition` casts in
`createGroupPeer` to `GroupProtocolDefinition` is in scope for this task — anything larger, stop and
re-surface.

- [ ] **Step 9: Migrate the flagged call sites to the config object**

For each site tsc flagged, wrap the payload and fold options:
- `peer.protocol(x).dispatch('a/b', { text })` → `.dispatch('a/b', { data: { text } })`
- `.request('a/b', prm)` → `.request('a/b', { param: prm })`
- `.request('a/b', prm, { timeoutMs })` → `.request('a/b', { param: prm, timeoutMs })`
- `.gather('a/b', prm, { quorum })` → `.gather('a/b', { param: prm, quorum })`
- a no-payload `.dispatch('a/b')` / `.request('a/b')` stays as-is (config optional).

Do **not** touch `.protocol(x).to(y)` calls (unchanged) or direct `BroadcastClient` / directed
enkaku `Client` calls in tests (those use `sendEvent`/`request`, a different API). Re-run
`test:types` until clean.

- [ ] **Step 10: Run the full rpc test suite**

Run: `rtk proxy pnpm --filter @kumiai/rpc run test`
Expected: PASS — `test:types` clean and `test:unit` green (no runtime behavior changed). If a runtime
test fails, it is a config-destructure mistranslation, not a design gap — fix the translation.

- [ ] **Step 11: Add the cast-drift conformance assertion**

Append to `packages/rpc/test/protocol-surface-types.test.ts` a check that the internal shape stays
compatible with the public surface (so future internal drift fails `test:types`):

```ts
// If InternalSurface drifts from the public surface, this stops compiling.
function _internalConformsToPublic(internal: import('../src/peer.js').ProtocolSurface<typeof chat>) {
  const asPublic: {
    dispatch: typeof internal.dispatch
    request: typeof internal.request
    gather: typeof internal.gather
  } = internal
  void asPublic
}
```

If `InternalSurface` is not exported, assert instead that a value shaped like `InternalSurface` is
assignable to `ProtocolSurface<typeof chat>` via a `satisfies`-style local. Keep the assertion in
this never-called function. Re-run `test:types`; expected PASS.

- [ ] **Step 12: Confirm no conformance-suite churn**

Run: `rtk proxy pnpm --filter @kumiai/rpc-conformance run test && rtk proxy pnpm --filter @kumiai/hub-conformance run test`
Expected: PASS unchanged — the suites type against `GroupMLS` and the hub ports, not
`ProtocolSurface`. If either fails, a port was touched unexpectedly; stop and re-surface.

- [ ] **Step 13: Lint and commit**

```bash
rtk proxy pnpm run lint
git add packages/rpc/src/peer.ts packages/rpc/test/protocol-surface-types.test.ts packages/rpc/test
git commit -m "feat(rpc): type ProtocolSurface against the protocol procedure map

dispatch/request/gather are keyed off GroupEventDefs/GroupRequestDefs and
take one enkaku-style config object. GroupPeer/GroupPeerParams bounds
tighten to GroupProtocolDefinition. BroadcastClient stays positional;
surfaceFor and the readiness wrappers translate the config object."
```

---

### Task 3: Release intents and milestone bookkeeping

Record the version bumps and mark the milestone item taken.

**Files:**
- Create: release intent files via `pnpm change` (see kigu:releasing).
- Modify: `docs/agents/plans/milestones/pre-1.0-breaking-api.md` (the `ProtocolSurface` item),
  `docs/agents/plans/backlog/rpc-api-surface.md` (item 1).

- [ ] **Step 1: Record the change intents**

Run `pnpm change` (per the kigu:releasing skill) and record:
- `@kumiai/rpc` — **minor**: "Type `ProtocolSurface` against the protocol procedure map; methods take
  an enkaku-style config object. Breaking: call form and the `GroupPeer`/`GroupPeerParams`
  `Protocols` bound tighten to `GroupProtocolDefinition`."
- `@kumiai/broadcast` — **minor**: "`GatheredReply` is generic over its value type (defaulted, additive)."

- [ ] **Step 2: Mark the milestone item taken**

In `docs/agents/plans/milestones/pre-1.0-breaking-api.md`, strike through the `ProtocolSurface` bullet
under `@kumiai/rpc` and annotate `*Taken 2026-09-04:*` with a one-line summary and the
completed-doc path (written at the completing stage). In
`docs/agents/plans/backlog/rpc-api-surface.md`, mark finding 1 taken, and correct the stale
"Related, blocked elsewhere" AAD note (the mls AAD blocker cleared 2026-09-03).

- [ ] **Step 3: Commit**

```bash
git add .changes docs/agents/plans/milestones/pre-1.0-breaking-api.md docs/agents/plans/backlog/rpc-api-surface.md
git commit -m "chore(rpc): record release intents and mark ProtocolSurface item taken"
```

---

## Self-Review

**Spec coverage:**
- Two-layer definitions map + config-object surface → Task 2 Step 4. ✓
- `GatheredReply<T>` generic → Task 1. ✓
- Cascaded bounds (ProtocolSurface/GroupPeer/GroupPeerParams) → Task 2 Steps 4-5. ✓
- Internal bridge (both layers, `Record<string, unknown>` dispatch data) → Task 2 Steps 6-7. ✓
- Cast-drift conformance test → Task 2 Step 11. ✓
- Type-level tests (unknown name / wrong kind / inferred result / no-param / options-only) →
  Task 2 Step 1. ✓
- Conformance-suite confirmation → Task 2 Step 12. ✓
- Release note (both packages, same minor) → Task 3. ✓

**Placeholder scan:** `to` body in Task 2 Step 6 says "unchanged from peer.ts:746-771" — that is a
deliberate preserve-verbatim instruction, not a placeholder; the surrounding method code is given in
full.

**Type consistency:** `InternalSurface`, `GroupEventDefs`, `GroupRequestDefs`, `ProtocolSurface`,
`GatheredReply<T>` names are used identically across Tasks 1-2. `RequestOptions = { errorThreshold?,
timeoutMs? }` and `GatherOptions = { quorum?, timeoutMs? }` match `broadcast/src/client.ts:17-18`.
