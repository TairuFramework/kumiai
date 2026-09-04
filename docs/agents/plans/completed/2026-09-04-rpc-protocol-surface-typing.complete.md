# Typed `ProtocolSurface` — complete

**Date:** 2026-09-04
**Status:** complete
**Packages:** `@kumiai/rpc` (minor, breaking at 0.x), `@kumiai/broadcast` (minor, additive)
**Milestone:** [pre-1.0 breaking API surface](../milestones/pre-1.0-breaking-api.md) — the item named
"the largest single item on this milestone, and the one least doable after 1.0."
**Backlog origin:** [rpc API surface](../backlog/rpc-api-surface.md), finding 1.

## Goal

Close the phantom type parameter on `@kumiai/rpc`'s `ProtocolSurface`. Before this, `ProtocolSurface<Protocol>`
declared a type parameter its `dispatch`/`request`/`gather` members ignored (`prc: string`, `data?:
Record<string, unknown>`, `unknown` results) — a caller got no procedure-name completion, no payload
checking, and no result type, even though `GroupPeer.protocol(name)` had the protocol definition in hand.

## What was built

- **Typed surface keyed off the procedure map.** `dispatch`/`request`/`gather` now accept only the
  procedure names of the matching kind, with typed payloads and typed results: `dispatch` takes event
  names with typed `data`; `request`/`gather` take request names with typed `param` and typed result;
  `gather` returns `Array<GatheredReply<Result>>`. Unknown names and wrong-kind names are rejected by
  the type.
- **Enkaku-style single config object.** The three methods moved from positional `(prc, prm?, options?)`
  to one optional config object per method — `dispatch(prc, { data })`, `request(prc, { param, ...options })`,
  `gather(prc, { param, ...options })`. Options fold into the same object as the payload. This is a wider
  break than the retype alone (every call *form* changes), taken in the same minor for the 1.0-stable
  ergonomic.
- **`GatheredReply<T = unknown>` generic** in `@kumiai/broadcast`. Defaulted, so every existing use stays
  valid; broadcast owns the type, so it is the honest home rather than an rpc-local duplicate.

## Key design decisions (preserved from the spec)

- **Two-layer definitions map, mirroring enkaku's `ClientDefinitionsType`.** Indexing `Protocol[P]['data']`
  directly under a key filter does **not** type-check — TypeScript does not narrow the later indexed access
  from the key filter, and `GroupProcedureDefinition` is a union whose members share no `data`/`param`/`result`
  property. So a precomputed map (`GroupEventDefs`/`GroupRequestDefs`) does the event/request narrowing inside
  a mapped type and stores `Data`/`Param`/`Result`; the methods index the stored map. Reuses `@enkaku/protocol`'s
  `DataOf`/`ReturnOf`/`EventProcedureDefinition`/`RequestProcedureDefinition`.
- **All typing lives at the rpc boundary.** `BroadcastClient` is untyped by design (generic fan-out substrate);
  it keeps its positional `(prc, prm, options)` API. Two rpc layers translate the config object to it: `surfaceFor`
  builds against a dedicated internal shape (`InternalSurface`, `dispatch` data typed `Record<string, unknown>` so
  it is assignable to broadcast + `encodeEventFrame`), and the readiness wrappers forward `(prc, config)`.
- **The cascaded bound tighten.** `GroupProtocolDefinition` is *narrower* than `ProtocolDefinition` (adds the
  retention discriminant), so tightening `ProtocolSurface` cascades to `GroupPeer` and `GroupPeerParams`
  (`Protocols extends Record<string, GroupProtocolDefinition>`). Note (found during review): because the retention
  discriminant is *optional*, `ProtocolDefinition` stays bidirectionally assignable to `GroupProtocolDefinition`,
  so the tightened bound does not actually *reject* a plain `ProtocolDefinition` map — the genuine break is the
  call form, and `createGroupPeer`'s own bound was left at `ProtocolDefinition`. The changeset wording states the
  bound "tightens" without claiming it rejects.
- **No runtime behavior change.** The only new runtime lines are `surfaceFor`'s config destructure and the
  readiness wrappers' two-arg forward.
- **Cast-drift guard.** `GroupPeer.protocol` casts the internal wrapper `as ProtocolSurface<...>`, so the compiler
  stops checking wrapper-vs-public conformance. A type-level conformance assertion pins the internal config shape
  against the public surface so future drift fails `test:types`. (A first version of this assertion compared against
  a hand-copied literal and was a near no-op; the shipped version binds the real exported `InternalSurface` and was
  mutation-verified to fail on a renamed field / dropped method.)

## Verification

- `test:types` is the real gate (vitest strips types). A type-level test asserts: unknown name rejected, wrong-kind
  name rejected, wrong payload type rejected, `request` result inferred, `gather` → `Array<GatheredReply<Result>>`,
  absent-schema branches (no-data event, no-param/no-result request → config optional, options-only, `param?: never`
  rejection, `void` result), and the sealed generic (`ProtocolSurface` takes exactly one type argument — its defs
  maps are not caller-forgeable).
- Runtime suites stayed green after ~34 call sites across 19 `packages/rpc/test` files migrated to the config object.
- Both conformance suites (`@kumiai/rpc-conformance`, `@kumiai/hub-conformance`) unchanged — they type against
  `GroupMLS` and the hub ports, not `ProtocolSurface`.
- Repo-wide `turbo run test:types` clean, forced fresh, across `@kumiai/rpc`, `@kumiai/mls-rpc`, and
  `@kumiai/integration-tests`.

## Codex review + hardening

A blind Codex pass on the built branch flagged four items, all closed before completion: the forgeable
`Events`/`Requests` generic params were sealed behind a one-arg public `ProtocolSurface` (delegating to a
non-exported alias); `InternalSurface` was exported and the conformance test bound to the real type incl. `to()`;
wrong-type and absent-schema assertions were added. One honest limit is documented rather than overclaimed: the
`to()` protocol-identity check is empirically vacuous under `Client` covariance, and the request/gather *result*
return types are deliberately un-lockable (the cast intentionally widens `unknown` → `Result`).

## Post-merge coverage fix

The initial call-site migration was gated per-package (`--filter @kumiai/rpc test:types`), which never typechecked
the separate `@kumiai/integration-tests` package — 14 un-migrated positional `dispatch` sites surfaced only under a
repo-root `pnpm test`. Migrated, and `tests/integration/package.json` gained a `test:unit` script (it previously had
only `test` + `test:types`), so its vitest now runs in the root `turbo run test:types test:unit` gate. Lesson: a
breaking-API migration must gate on the repo-wide typecheck, not a per-package filter.

## Deferred / follow-up (none blocking)

- `createGroupPeer`'s bound stays at `Record<string, ProtocolDefinition>`; the tightened `GroupPeer`/`GroupPeerParams`
  bound is leaky at that entry point (optional retention discriminant, as above). Informational — not a defect, and
  the changeset wording is already accurate.
- The other two `rpc-api-surface.md` items (`open-once`/`directed` `UnwrapResult` narrowing; `GroupMLS.rosterDIDs`
  leaf identity) remain open — separate breaks, separate PRs, as that doc scopes them.
