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

```ts
export type ProtocolSurface<Protocol extends GroupProtocolDefinition> = {
  dispatch: <P extends EventNames<Protocol>>(
    prc: P,
    ...args: DispatchArgs<Protocol[P]>
  ) => Promise<void>
  request: <P extends RequestNames<Protocol>>(
    prc: P,
    ...args: RequestArgs<Protocol[P]>   // [prm?, options?] — see argument encoding below
  ) => Promise<ReturnOf<Protocol[P]['result']>>
  gather: <P extends RequestNames<Protocol>>(
    prc: P,
    ...args: GatherArgs<Protocol[P]>
  ) => Promise<Array<GatheredReply<ReturnOf<Protocol[P]['result']>>>>
  to: (memberDID: string) => Promise<Client<Protocol>>
}
```

- `EventNames<Protocol>` / `RequestNames<Protocol>` — the keys whose procedure matches
  `EventProcedureDefinition` / `RequestProcedureDefinition`, selected with a `FilterNever`-style
  mapped type as enkaku does. **These resolve only against a *concrete* protocol** whose members are
  single procedure defs (what `defineGroupProtocol({...} as const)` and every real `protocol(name)`
  call site produce). Against the *abstract* upper bound `GroupProtocolDefinition = Record<string,
  GroupProcedureDefinition>`, each indexed value is the full event/request/stream/channel union
  (`protocol.ts:40`), which wholly extends neither the event nor the request subtype, so both name
  sets **collapse to `never`**. This is why the internal surface cannot be a wide instance of the
  filtered type (see "Internal bridge" below).

### Argument encoding (finding 4)

Kumiai's surface is **positional** — `request(prc, prm?, options?)` — not enkaku's single config
object. The plan pins one tuple and tests it:

```ts
type RequestArgs<P> =
  DataOf<P['param']> extends never
    ? [prm?: undefined, options?: RequestOptions]   // no-param: request(name) | request(name, undefined, opts)
    : [prm: DataOf<P['param']>, options?: RequestOptions]
```

`GatherArgs` mirrors it with `GatherOptions`; `DispatchArgs` mirrors it for the event `data` schema
with no options member. "Mirror enkaku" describes the *filtering* machinery only — the call
ergonomics stay the current positional shape, and the no-param-with-options form
(`request(name, undefined, opts)`) is a named type-test case (see Testing) so it cannot silently
regress.

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

### Internal bridge (finding 3)

`surfaceFor` (`peer.ts:728`) currently types itself `ProtocolSurface<ProtocolDefinition>`. It cannot
become `ProtocolSurface<GroupProtocolDefinition>` — that instance's methods accept *no* procedure
name (the `never` collapse above). Instead `surfaceFor` builds against a **dedicated untyped
internal shape** — the current wide `(prc: string, data?/prm?: unknown, options?) => Promise<...>`
signatures, named as its own type rather than an instantiation of the public surface — and
`GroupPeer.protocol` casts that to `ProtocolSurface<Protocols[K]>` at the return boundary. The impl
body (delegation to the untyped `BroadcastClient`) is unchanged; only the internal type and the
one cast at `protocol()` are new.

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

- `packages/rpc/src/peer.ts` — the `ProtocolSurface` type, the two cascaded bounds (`GroupPeer`
  `peer.ts:270`, `GroupPeerParams` `peer.ts:188`), and the `surfaceFor` impl (`peer.ts:728-772`).
  Impl **body unchanged**; `surfaceFor` types itself against a dedicated untyped internal shape and
  `GroupPeer.protocol` casts to `ProtocolSurface<Protocols[K]>` at the return boundary (see
  "Internal bridge"). Verify the `handlers[name]` typing (`peer.ts:645`) survives the tighter
  `Protocols` bound.
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
- a no-param procedure accepts the **no-arg** call `request(name)`;
- a no-param procedure accepts the **options-only** call `request(name, undefined, options)` (the
  finding-4 case) — and, if the chosen tuple forbids it, that is caught here rather than by a
  consumer.

vitest strips types, so a green vitest run proves nothing about these assertions. Every step pairs
with `pnpm --filter @kumiai/rpc test:types` (or the repo's typecheck), which is the real gate.

Runtime tests are expected to stay green untouched (no runtime change). The existing surface call
sites in `test/` (e.g. `test/peer-app-drain.test.ts:44`,
`test/directed-legibility.test.ts:65`) exercise real protocols; if their inferred types now require
adjustment that is the intended break and gets fixed in place.

## Blast radius / breaking classification

- **Breaking** for any consumer that relied on the surface's `unknown`/`string` looseness — the
  accepted cost, and the reason it is on the pre-1.0 milestone. `minor` at 0.x.
- **Also breaking**: the cascaded `GroupPeer`/`GroupPeerParams` `Protocols` bound tightens from
  `ProtocolDefinition` to `GroupProtocolDefinition` (findings 1+2). A consumer whose `Protocols` map
  holds a non-group `ProtocolDefinition` (a retained non-event procedure) now fails to compile —
  intended, since `defineGroupProtocol` already rejects that at runtime. Same `minor`.
- **No runtime change** — the break is compile-time; runtime suites stay green.
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
