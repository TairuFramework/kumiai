# Typed `ProtocolSurface` — design

**Date:** 2026-09-04
**Package:** `@kumiai/rpc` (with a non-breaking touch to `@kumiai/broadcast`)
**Milestone:** [pre-1.0 breaking API surface](../../agents/plans/milestones/pre-1.0-breaking-api.md)
**Backlog origin:** [rpc API surface](../../agents/plans/backlog/rpc-api-surface.md), item 1

## Problem

`ProtocolSurface<Protocol extends ProtocolDefinition>` (`packages/rpc/src/peer.ts:263-268`)
declares a type parameter its members ignore. `Protocol` is phantom:

```ts
export type ProtocolSurface<Protocol extends ProtocolDefinition> = {
  dispatch: (prc: string, data?: Record<string, unknown>) => Promise<void>
  request: (prc: string, prm?: unknown, options?: RequestOptions) => Promise<unknown>
  gather: (prc: string, prm?: unknown, options?: GatherOptions) => Promise<Array<GatheredReply>>
  to: (memberDID: string) => Promise<Client<Protocol>>
}
```

A caller gets no procedure-name completion, no parameter checking, and no result type — even though
`GroupPeer.protocol(name)` (`peer.ts:271`) has the protocol definition in hand at the call site
(`protocol: <K extends keyof Protocols>(name: K) => ProtocolSurface<Protocols[K]>`).

`to` is the exception: it already returns `Client<Protocol>`, so the parameter is not entirely dead —
only `dispatch`/`request`/`gather` erased it.

This is **type-safety debt on the public surface**, not a correctness bug. It is on the pre-1.0
breaking milestone because keying the surface off the procedure map breaks every existing call
site's inferred types at once — the milestone doc names it "the largest single item on this
milestone, and the one least doable after 1.0." At 0.x the break is a `minor`; after 1.0 it is a
`major`.

## Where the typing lives

`dispatch`/`request`/`gather` delegate to a `BroadcastClient` (`peer.ts:335`, impl at
`peer.ts:728-772`). `BroadcastClient` is **untyped by design** — broadcast is a generic fan-out
substrate whose `dispatch(prc: string, data)`, `request(prc: string, prm)`, `gather(prc: string,
prm)` are string/`unknown` typed (`packages/broadcast/src/client.ts:84,88,131`). That is correct
for broadcast and stays.

All typing is therefore added at the rpc `ProtocolSurface` boundary, which holds `Protocol` in its
type parameter. The surface presents typed methods that erase to the untyped `BroadcastClient`
calls; `surfaceFor` builds against an untyped internal shape and `GroupPeer.protocol` casts to
`ProtocolSurface<Protocols[K]>` at its return (see "Internal bridge"). No runtime behavior changes.

## Model

Mirror enkaku's `ClientDefinitionsType` machinery (`@enkaku/client`), reusing the exported helpers
from `@enkaku/protocol`: `DataOf`, `ReturnOf`, `EventProcedureDefinition`,
`RequestProcedureDefinition`. Group RPC uses its own method names (`dispatch`/`request`/`gather`),
not enkaku's (`sendEvent`/`request`/`createStream`), so the shapes are mirrored, not reused
wholesale.

Procedure-kind → surface method:

| Procedure kind | Surface method(s) | Notes |
|---|---|---|
| `event` | `dispatch` | typed `data` |
| `request` | `request`, `gather` | typed `param`, typed result; `request` = first accepted reply, `gather` = all replies |
| `stream`, `channel` | none | broadcast substrate has no stream/channel; matches today's surface |

## New surface

The surface must use enkaku's **two-layer** shape: a precomputed *definitions map* that does the
event/request narrowing **inside** a mapped type and stores the payload/result types, and methods
that index the stored map. Indexing `Protocol[P]['data']` directly under a `P extends
EventNames<Protocol>` filter does **not** type-check — TypeScript does not narrow the later indexed
access from the key filter, and `GroupProcedureDefinition` (`protocol.ts:40`) is a union whose
members share no `data`/`param`/`result` property. This is exactly why enkaku stores `Data`/`Param`/
`Result` in `EventDefinitionsType`/`RequestDefinitionsType` and indexes those
(`@enkaku/client/lib/client.d.ts:31,36,98,105`).

```ts
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
```

- `DataOf` / `ReturnOf` / `EventProcedureDefinition` / `RequestProcedureDefinition` are the
  `@enkaku/protocol` helpers; `FilterNever` is the local copy of enkaku's (drops `never`-valued
  keys).
- The definitions maps resolve usefully only against a **concrete** protocol (what
  `defineGroupProtocol({...} as const)` and every real `protocol(name)` call site produce). Against
  the **abstract** bound `GroupProtocolDefinition`, each member is the full union, matches neither
  branch, and both maps become `{}` — `keyof {} & string` is `never`, so `dispatch`/`request`/
  `gather` accept no name. This is why the internal surface cannot be a wide instance of the filtered
  type (see "Internal bridge").

### Argument encoding — single config object, enkaku-style

The surface moves from today's positional `(prc, prm?, options?)` to **one optional config object per
method** (the `...args` tuples inlined in the surface above), folding the payload and the options
together the way `@enkaku/client` does. Wider break than the retype alone — every call site's *call
form* changes, not just its inferred types — taken in the same `minor` because the surface is
already breaking and the config shape is the ergonomic the team wants to carry to 1.0.

- Options (`RequestOptions = { errorThreshold?, timeoutMs? }`,
  `GatherOptions = { quorum?, timeoutMs? }`, `broadcast/src/client.ts:17-18`) fold **into the same
  config** as `param` via `& RequestOptions` / `& GatherOptions`, so `request(name, { param,
  timeoutMs })` is one object — the enkaku shape.
- A no-param / no-data procedure makes the config **fully optional** (the `T['Data'] extends never` /
  `T['Param'] extends never` branch): `dispatch(name)`, `request(name)`, `request(name, {
  timeoutMs })` all type-check; supplying `param`/`data` there is a type error (`?: never`).
- `BroadcastClient` keeps its positional `(prc, prm, options)` API (untyped substrate, out of
  scope). Two rpc layers translate to it — see "Internal bridge".

### Constraint — tighten the whole chain (findings 1+2)

`GroupProtocolDefinition` is **narrower** than `ProtocolDefinition` (it adds the retention
discriminant, `protocol.ts:21,40`), so a generic bounded only by `ProtocolDefinition` does **not**
satisfy the tighter bound — the variance runs the opposite way to an earlier draft's claim.
Tightening `ProtocolSurface` therefore **cascades**, and all three move together in this `minor`:

- `ProtocolSurface<Protocol extends GroupProtocolDefinition>`
- `GroupPeer<Protocols extends Record<string, GroupProtocolDefinition>>` (`peer.ts:270`)
- `GroupPeerParams<Protocols extends Record<string, GroupProtocolDefinition>>` (`peer.ts:188`)

This is the honest bound — these *are* group protocols — accepted as a wider break in the same
release. **Implementation must verify** the tighten does not force rework in `GroupPeerParams`'s
`handlers` typing (`handlers[name]`, `peer.ts:645`) or the anchor/journal params; if the checker
demands a `handlers` retype, that is in scope for this PR, and any change beyond the three type
bounds and the internal-bridge cast is a finding to re-surface, not to absorb silently.

### Internal bridge — two layers, not one (findings 2, 3, 4)

The public surface is **not** `surfaceFor` directly. `createGroupPeer` returns readiness wrappers
(`peer.ts:2111-2118`) whose `dispatch`/`request`/`gather` currently forward three positional args to
`surfaceFor(key).*`, and the wrapper object is cast `as ProtocolSurface<Protocols[K]>` at
`peer.ts:2118`. **Both** layers change to the config object:

1. `surfaceFor` (`peer.ts:728`) stops typing itself `ProtocolSurface<ProtocolDefinition>` — it
   cannot become `ProtocolSurface<GroupProtocolDefinition>` (that instance's methods accept no
   name, the `never` collapse above). It builds against a **dedicated internal config shape**, named
   as its own type:

   ```ts
   type InternalSurface = {
     dispatch: (prc: string, config?: { data?: Record<string, unknown> }) => Promise<void>
     request: (prc: string, config?: { param?: unknown } & RequestOptions) => Promise<unknown>
     gather:  (prc: string, config?: { param?: unknown } & GatherOptions) => Promise<Array<GatheredReply>>
     to: (memberDID: string) => Promise<Client<ProtocolDefinition>>
   }
   ```

   `dispatch`'s `data` is `Record<string, unknown>` (not `unknown`) so it is assignable to
   `BroadcastClient.dispatch(data: Record<string, unknown>)` (`broadcast/src/client.ts:84`) and to
   `encodeEventFrame` (`peer.ts:732,738`) with no extra assertion. `request`/`gather` destructure
   `config?.param` (broadcast's `prm: unknown`) and the option fields into the positional call.

2. The readiness wrappers (`peer.ts:2114-2117`) forward `(prc, config)` — two args — to
   `surfaceFor(key).*`. Dropping the third positional argument is a required change, not covered by
   the cast: an over-arity call to the two-argument internal method would itself be a type error.

**Cast-drift risk (finding 4).** The `as ProtocolSurface<Protocols[K]>` cast means the compiler no
longer checks that the wrapper's argument layout, option forwarding, and return types match the
public surface — exactly the gap that let the current positional wrappers stay stale in this design.
Mitigation, in scope: keep the cast on the smallest possible expression, and add a **type-level
conformance test** — assert `InternalSurface` is assignable to
`ProtocolSurface<SomeConcreteProtocol>` structurally (or that a sample wrapper value satisfies it)
so a future internal-shape drift fails `test:types` instead of silently reshaping an asserted public
API.

## `GatheredReply<Result>` — `@kumiai/broadcast`

Make the type generic, defaulted so every existing use is unchanged:

```ts
// packages/broadcast/src/client.ts
export type GatheredReply<T = unknown> = { senderDID: string; value: T }
```

Non-breaking: the default `unknown` preserves `BroadcastClient.gather`'s own `Array<GatheredReply>`
return and every current consumer. Broadcast owns the type, so this is its honest home rather than an
rpc-local duplicate. Same version band, so it ships in the same `minor`.

## Implementation surface

- `packages/rpc/src/peer.ts`:
  - the `ProtocolSurface` type + the `GroupEventDefs`/`GroupRequestDefs`/`FilterNever` helpers;
  - the two cascaded bounds (`GroupPeer` `peer.ts:270`, `GroupPeerParams` `peer.ts:188`);
  - the `surfaceFor` impl (`peer.ts:728-772`) — retyped to the internal config shape, config
    destructured into the positional `BroadcastClient`;
  - the readiness wrappers (`peer.ts:2114-2118`) — forward `(prc, config)`, drop the third arg,
    keep the `as ProtocolSurface<Protocols[K]>` cast on the wrapper object;
  - verify `handlers[name]` typing (`peer.ts:645`) survives the tighter `Protocols` bound.
- `packages/broadcast/src/client.ts` — `GatheredReply<T = unknown>`.
- Possibly `packages/rpc/src/index.ts` re-exports — no surface addition expected beyond the retyped
  `ProtocolSurface` already exported.

## Testing

Compile-time only — the backlog doc's "Test hooks" section calls for exactly this. A type-level test
(`expectTypeOf` or `assertType`) in `@kumiai/rpc`:

- an **unknown procedure name** fails to compile;
- a **wrong param type** fails to compile;
- `request` result **infers** to the declared `ReturnOf<result>`;
- `gather` result **infers** to `Array<GatheredReply<ReturnOf<result>>>`;
- `dispatch` on a **request procedure** (and vice versa) fails to compile;
- a no-param procedure accepts the config-optional call `request(name)`;
- a no-param procedure accepts the **options-only config** `request(name, { timeoutMs })`, and
  passing `param` to it is a type error (`param?: never`);
- passing `data`/`param` at the top level (the old positional form) fails to compile — the config
  wrapper is mandatory;
- **conformance (finding 4):** `InternalSurface` is assignable to `ProtocolSurface<C>` for a concrete
  sample protocol `C` — so a drift in the internal shape fails `test:types` rather than silently
  reshaping the cast public API.

vitest strips types, so a green vitest run proves nothing about these assertions. Every step pairs
with `pnpm --filter @kumiai/rpc test:types` (or the repo's typecheck), which is the real gate.

Runtime behavior is unchanged, but the **call form is not**: every `dispatch`/`request`/`gather`
call site in `test/` (e.g. `test/peer-app-drain.test.ts:44`
`dispatch('chat/posted', { text })` → `dispatch('chat/posted', { data: { text } })`,
`test/directed-legibility.test.ts:65`) migrates to the config object. That migration is part of this
work; runtime suites must stay green *after* it. The only new runtime lines are `surfaceFor`'s config
destructure and the readiness wrappers' two-arg forward, so a runtime-test failure signals a
mistranslation, not a design gap.

## Blast radius / breaking classification

- **Breaking** for any consumer that relied on the surface's `unknown`/`string` looseness — the
  accepted cost, and the reason it is on the pre-1.0 milestone. `minor` at 0.x.
- **Also breaking**: the cascaded `GroupPeer`/`GroupPeerParams` `Protocols` bound tightens from
  `ProtocolDefinition` to `GroupProtocolDefinition` (findings 1+2). A consumer whose `Protocols` map
  holds a non-group `ProtocolDefinition` (a retained non-event procedure) now fails to compile —
  intended, since `defineGroupProtocol` already rejects that at runtime. Same `minor`.
- **Also breaking — call form**: `dispatch`/`request`/`gather` move to the enkaku-style single
  config object (`{ data }` / `{ param, …options }`). Every call site rewrites, not just its types.
  Widest of the three breaks; taken in the same `minor` for a 1.0-stable ergonomic.
- **Runtime behavior unchanged** — the only new runtime lines are `surfaceFor`'s config destructure
  and the readiness wrappers' two-arg forward; runtime suites stay green once call sites are
  migrated.
- **Conformance suites** (`@kumiai/rpc-conformance`, `@kumiai/hub-conformance`) type against
  `GroupMLS` and the hub ports, not `ProtocolSurface`; no contract-suite churn expected. Confirm by
  running both suites against the real implementation and the doubles per AGENTS.md.
- `@kumiai/broadcast` change is **non-breaking** (defaulted generic).

## Out of scope

- The other two `rpc-api-surface.md` items (`open-once`/`directed` `UnwrapResult` narrowing;
  `GroupMLS.rosterDIDs` leaf identity) — separate breaks, separate PRs per that doc.
- Any `GroupPeer`/`GroupPeerParams` change beyond the `Protocols` bound tighten and whatever
  `handlers` retype that bound forces.

## Release note

Record a `pnpm change` `minor` intent for `@kumiai/rpc` (breaking retype at 0.x) and a `minor` for
`@kumiai/broadcast` (additive generic) — the band moves together. Per repo memory: 0.5 band is
released; first-publish fixups do not apply, an ordinary in-band `minor` does.
