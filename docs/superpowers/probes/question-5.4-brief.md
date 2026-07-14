# Question 5.4 — the hub Importants and Minors from the branch review

Repo `/Users/paul/dev/yulsi/kumiai`, branch `feat/control-ledger-lane`. **Tree green at `1347e68`**
(rpc 171 + 1 skipped, mls 298, hub-server 66, hub-protocol 8, 27/27). Review findings in
`packages/hub-tunnel` and `packages/hub-server` (+ the `hub-protocol` contract they touch). **No
`packages/rpc` or `packages/mls` change** — those are separate probes.

Read first: `packages/hub-tunnel/src/encrypted-transport.ts` (`wrapHub`), `packages/hub-server/src/handlers.ts`
(`hub/publish`), `packages/hub-server/src/memoryStore.ts`, `packages/hub-protocol/src/types.ts`,
`packages/hub-protocol/src/conformance.ts`.

Each fix: **red before green where it is a behaviour bug**, and **mutation-check** anything you assert.
Do not weaken an existing test or clause. Keep all 23 conformance clauses and every unit green.

---

## Important 1 — `wrapHub` silently drops `retain`, `expectedHead`, `publishID`

`encrypted-transport.ts` (`wrapHub.publish`) reconstructs the params with only
`senderDID`/`topicID`/`payload`. A caller that hands this wrapper a **conditional** publish
(`expectedHead` set) gets an **unconditional mailbox** publish — the CAS is gone and nothing fails.
`subscribe` also drops the `options` argument `MailboxHub.subscribe` now declares.

**The reviewer's preferred fix is type-level, and it is the right instinct: make the drop a compile
error, not a silent degradation.** Establish first *what this tunnel is for* — it carries app frames,
which are mailbox-class and never CAS'd. If the tunnel is mailbox-only **by design**, then
`MailboxHub.publish` should take a narrower `MailboxPublishParams` that **does not have** `retain` /
`expectedHead` / `publishID`, so a caller *cannot* hand it a conditional publish in the first place and
the wrapper has nothing to drop. If instead a conditional publish through the tunnel is legitimate,
`wrapHub` must **forward** all the fields. Decide which, say why in the report, and implement it so the
failure mode is structural — a type error — rather than a runtime silent loss. Do the same for the
dropped `subscribe` options.

## Important 2 — a deduped publish is re-fanned-out to every subscriber

`handlers.ts` `hub/publish` runs the live fan-out loop unconditionally, but `store.publish` on a
replayed `publishID` returns the original sequenceID having appended nothing. So a replay **pushes the
frame to every connected subscriber a second time** — a frame they have already applied, with a
sequenceID whose delivery row may already be acked and gone. `types.ts` claims a replay produces "no
event"; at the hub layer that is false.

**Fix:** `store.publish` must tell its caller whether the publish was deduped. Change its return to
`{ sequenceID, deduped: boolean }` (or equivalent), have the handler **skip the fan-out** when
`deduped`, and thread it through `memoryStore`, the `HubStore` contract in `types.ts`, and **the
conformance suite** — add a clause: a second publish with the same `publishID` returns the same
sequenceID, `deduped: true`, appends nothing, **and** (a host-visible assertion) does not create a new
delivery. Mutation-check it: make `deduped` always `false`, show the clause and any fan-out test go red.
Update the `hub-client` and `hub-tunnel` return-type consumers if the shape change reaches them. **This
touches the freshly-hardened suite — keep all 23 existing clauses green.**

## The Minors

- **`memoryStore` `maxRetention` defaults to `Number.POSITIVE_INFINITY` and `createHub` exposes no way to
  set it** — so the `RetentionExceededError` path is dead on the default hub and any client can pin
  frames forever with `subscribe({ retention: 2**31 })`. Default it to something finite and let
  `createHub` / the store options set it. State the default in the contract.
- **Retention is a function of *current* subscribers, so a transient zero-subscriber window collapses a
  topic's window to the hub default.** Stated as design in `types.ts` but the *consequence* is not —
  document it where a host will read it.
- **Neither `trim` nor depth eviction emits the `purge` event, while `purge` does.** `HubStoreEvents`
  does not say whether they should. Decide, implement consistently, and state it.
- **`FetchTopicResult` has no `hasMore` / `cursor`** — a paging reader derives termination from `head`,
  and against a fully-trimmed topic (`head` set, `oldest` null) that derivation is subtle. Consider
  returning `hasMore`; if you add it, add a conformance clause and update `types.ts`. If you judge it
  not worth the contract surface, say so and leave it — this one is genuinely optional.
- **`fetch`'s `after` falls back to index 0 when the cursor entry is no longer pending** (pre-existing) —
  silently restarting the page from the beginning. Assess whether this can actually mis-serve a live
  consumer; fix if it can, document the bound if it cannot.

For each Minor you *change*, add or extend a test. For each you decide to *leave*, one sentence in the
report on why. Do not silently skip one.

## ⚠️ Wrong-but-passing

- A conformance clause that asserts only the sequenceID is unchanged on a deduped publish, without
  asserting **no new delivery** — the whole point is that the hub does not re-emit.
- Making `wrapHub` "forward the fields" without deciding whether it *should* — if the tunnel is
  mailbox-only, the fields should not exist to forward. The type is the fix.

## Definition of done

- Both Importants fixed; the `publish` dedup signal covered by a new conformance clause, mutation-checked.
- Every Minor either fixed-with-a-test or explicitly-left-with-a-reason.
- `types.ts` updated wherever a contract obligation changed.
- No `rpc` / `mls` change. All 23 prior clauses and all units green.

## Conventions

`type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID`/`HTTP`/`JWT`/`DID`; ES
`#fields`, never `private`/`readonly`. pnpm only. **Never edit generated `lib/`.** Code/comments/tests
never reference plan questions or phase labels.

Verify (an `rtk` shim intercepts bare `pnpm run`):

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

## Stop conditions

- **If the `publish` return-shape change ripples wider than the hub packages** (into `rpc`/`mls`
  consumers of `MailboxHub`/`LogHub`), stop and report the blast radius before finishing — a
  cross-package contract change may want its own review. Do **not** edit `rpc`/`mls` to accommodate it
  without saying so.
- **Do not commit.**

## Report contract

Write `docs/superpowers/probes/question-5.4-report.md`: the `wrapHub` decision and why, the dedup fix and
its new clause + mutation check, each Minor's disposition, the blast radius of the `publish` shape
change, and the full verify output. Return only: status, a one-line test summary, and concerns.
