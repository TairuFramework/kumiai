# Probe brief — anchor-derived app topic: stable across non-removal, rotates on Remove

Implementation probe in `/Users/paul/dev/yulsi/kumiai`, package `packages/rpc`, branch
`feat/app-lane-delivery` (do NOT switch; leave changes uncommitted). Small, focused.

Builds directly on already-committed work:
- Q2.1 records app-lane **anchor state** `anchor: { secret, epoch }` in `peer.ts` — seeded at genesis,
  rotated (to the post-commit per-epoch secret) only when an applied Commit drops a leaf. Exposed via
  `peer.anchorEpoch()`. That state currently has **no reader** — this question makes the app topics
  read it.
- Q1.1 added per-procedure `retain:'log'` (logged app events publish via `mux.publish({retain:'log'})`,
  pullable via `mux.fetchTopic`).

## The exact question

Does deriving the app-lane topics from the **anchor** (`anchor.secret`/`anchor.epoch`) instead of the
current epoch hold the topic constant while epochs advance without a Remove, and rotate it onto a new
topic exactly when a Remove is applied — with delivery continuing across both?

## Relevant spec section (verbatim)

> `appTopic = protocolTopic(anchorSecret, anchorEpoch, name)` and `inboxTopic(anchorSecret,
> anchorEpoch, did)`, captured from `exportSecret()` at the last commit containing a Remove.
> Non-removal commits leave the topic stable; a Remove rotates it. `topic.ts` needs no signature
> change — the existing functions receive anchor values instead of the current per-epoch values.
> Online: subscribe the current app topic, live push. On applying a Remove, update the anchor, drop
> the old subscription (safe — log-class), subscribe the new topic. wrap/unwrap stay on the live epoch
> crypto (MLS content is sealed under the current epoch; only the topic ID is anchor-bound).

## Approved approach (follow this; BLOCKED if it fights the code — do not redesign)

In `buildEpoch` (`peer.ts:252-303`), switch every app-lane / inbox / directed **topic derivation**
from the current `secret`/`epoch` to `anchor.secret`/`anchor.epoch`:
- `protocolTopic(anchor.secret, anchor.epoch, name)` (currently `:257`)
- `selfInbox = inboxTopic(anchor.secret, anchor.epoch, localDID)` (currently `:264`)
- the acceptor's `resolveSendTopic` (currently `inboxTopic(secret, epoch, senderDID)`, `:294`)
- `createDirectedClient({ ..., secret, epoch })` (currently `:338-339`) → pass `anchor.secret`/
  `anchor.epoch`.

Keep `wrap: crypto.wrap` / `unwrap: crypto.unwrap` (`:269-270`) UNCHANGED — the content stays sealed
under the live epoch; only the topic ID becomes anchor-bound.

Rotation should fall out of the existing structure: `reconcileCommits` / `onCommitDelivery` already
call `rebuildEpoch` on an advance. A non-removal advance leaves the anchor unchanged → `buildEpoch`
re-derives the **same** topic (continuity); a removal changed the anchor (Q2.1) → `buildEpoch` derives
the **new** topic (rotation), and the old log-class subscription is safe to drop. Do NOT add new
rotation plumbing unless the existing rebuild path demonstrably fails to rotate — if it does, report
what you found before changing it.

Optional (only if trivially clean): skip the app-lane rebuild when the anchor is unchanged, to cut
churn. Correctness (continuity + rotation) is the bar; do not let an optimization risk it. If unsure,
leave the rebuild as-is.

Now that topics are anchor-bound, the module `secret`/`epoch` vars (`:253-254`) may end up unused for
app-lane derivation. Check every reader: if they are genuinely unused after the switch, remove them; if
still read elsewhere (e.g. by non-app-lane code), leave them. Do not leave a write-only variable.

`topic.ts` MUST keep its current signatures — you are only changing the *arguments* passed.

## Scope boundary

Topic-ID source only. Do NOT build the returning-member drain (Phase 3) and do NOT change
directed-lane delivery semantics beyond the topic-derivation swap. A directed message sent to a member
during a segment it never subscribed remains out of scope.

## Done when (all required)

New test `packages/rpc/test/peer-app-topic.test.ts`:
1. **Stable across non-removal:** two online members (e.g. alice, bob) exchange **logged** app events
   (`retain:'log'` procedure) across several non-removal commits; every event is received by the
   subscriber's handler, and the app topic ID is unchanged the whole time.
2. **Rotates on Remove:** apply a Remove commit (evict a third member); after it, the members exchange
   logged events again and delivery continues — on a **new** topic ID, different from the pre-removal
   one.

Assert the topic **identity**, not just delivery. The fake crypto's `exportSecret()` is
epoch-independent (a fixed secret — see `fixtures/fake-crypto.ts`), so the app topic depends only on
`anchor.epoch` (+ the protocol name): compute the expected topic with
`protocolTopic(fixedSecret, peer.anchorEpoch(), name)` before and after the Remove and assert it is the
same across non-removal commits and different after the Remove. Use `mux.fetchTopic` / the known fake
secret to tie the assertion to the real topic the frames landed on.

Existing tests stay green — especially `peer-remove-detect.test.ts`, `peer-app-retention.test.ts`,
`peer-control-lanes.test.ts`.

## Conventions

Read `kigu:conventions` + repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`;
capital `ID`; `#fields`; don't edit `lib/`. Code/comments/tests never name plan questions or phases —
capture the invariant ("the app topic is stable within a removal-bounded segment and rotates on a
Remove").

## Verify (repo root, paste real output)

`pnpm run build && rtk proxy pnpm run lint && pnpm test`
(`pnpm run lint` alone → eslint via the `rtk` shim; use `rtk proxy pnpm run lint`.)

## Report contract

Full report → `docs/superpowers/probes/question-2.2-report.md` (changes with file:line, whether the
existing rebuild path rotated as hoped or needed help, the test, pasted verify output, surprises,
concerns). Return ONLY: status, uncommitted-changes note, one-line test summary, concerns. No full diff.
