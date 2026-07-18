# Probe brief — one contract for `GroupCrypto` and `GroupMLS`, run against the fakes and the real thing

Implementation probe in `/Users/paul/dev/yulsi/kumiai`, branch `feat/app-lane-delivery`. Do NOT switch
branches, do NOT commit. Leave changes uncommitted.

**Never run `git checkout`, `git restore`, or `git stash` on a file with uncommitted work.**

## Why this exists

Six defects this session had one root cause: **a double answered where its real port refuses.** The
worst two made the app lane fail to deliver a single message over real MLS while 288 tests stayed green.

The fix that worked for the hub was a shared contract every implementation must pass
(`packages/hub-conformance/src/log-hub.ts`) — it immediately found three more divergences. `GroupCrypto`
and `GroupMLS` have no such contract, and they are the ports where the divergences actually cost.

`@kumiai/mls-rpc` now implements both for real, so both sides finally exist to compare.

## Approved approach (follow it; BLOCKED if it fights the code — do not redesign)

**Build a port conformance suite for `GroupCrypto` and `GroupMLS`, and run it against both the fakes
(`packages/rpc/test/fixtures/fake-crypto.ts`, `memory-group-mls.ts`) and the real implementations in
`@kumiai/mls-rpc`.**

Seed it from the divergences already found — each has a demonstrated cost, and each must be a clause:

**`GroupCrypto`**
- `exportSecret` is **per-epoch**: the same call at two epochs gives different secrets. (The removal
  boundary is exactly this.)
- Every member at an epoch derives the **same** secret, with nothing exchanged.
- `unwrap` **consumes**: opening the same frame twice does not succeed twice. This is defect A, and no
  test could see it.
- `unwrap` opens **only at the current epoch**, and throwing is ordinary control flow.
- `wrap` is **not pure** — say what is actually guaranteed.
- `frameEpoch` returns `null` for bytes that are not a readable sealed frame, and never invents an epoch.

**`GroupMLS`**
- `readCommitHeader` returns the epoch whenever the frame decodes, and a committer **only** where it
  authenticates — absent for a commit framed at any other epoch, in both directions.
- An external commit's committer is present **only** when its signature verifies.
- `processCommit` advances in place for a received commit; a commit removing the local member does not
  advance it.
- `rosterDIDs` reflects an applied roster change, and only an applied one.

Add whatever else the two implementations disagree about — **finding a disagreement is the point of the
exercise.**

Then **promote the highest-value peer scenarios to run against the real ports** in `tests/integration/`:
the returning-member drain across a rotation, a restart mid-walk, the durable cursor surviving a
restart, and a frame published mid-walk. These are the branch's load-bearing claims and they have only
ever run against fakes.

## Expect divergences, and report every one

A fake failing a clause is the deliverable, not a problem. **Fix the fake, never the clause** — unless
the clause is wrong about the real port, in which case say so with evidence from the real
implementation, not from the fake's comments. That is how two of this session's defects survived:
the double's own doc comment was treated as the contract.

If a property genuinely cannot be expressed against both implementations, say which and why. A smaller
suite both sides pass honestly beats a larger one with exemptions.

## Done when (all required)

1. **A shared contract suite exists** for both ports and runs against the fakes and `@kumiai/mls-rpc`.
2. **Every clause above is covered**, or documented as not expressible with the reason.
3. **Both sides pass** — fakes fixed where they diverged, each fix reported.
4. **The four promoted scenarios pass against real MLS, real crypto, and a real hub.**
5. **Mutation check (required, paste it):** make one fake lenient again in one clause → that clause goes
   red for that implementation only. Invert by hand.
6. Whole suite green: `pnpm run build`, `rtk proxy pnpm run lint`,
   `pnpm exec turbo run test:types test:unit --force`, integration all passing, nothing skipped.

## Warning

Six tests this session passed for reasons unrelated to what they claimed; one was written by the
reviewer. **Watch every clause fail against an implementation that violates it before trusting it.** A
clause that has never been red proves nothing.

## Scope boundary

The new conformance package/module, the rpc fakes, `packages/mls-rpc/`, and `tests/integration/`. Do NOT
change `packages/rpc/src/**`, `packages/mls/src/**`, `classify.ts`, or the hub packages. **If a clause
shows production code is wrong, STOP and report it** — that is a finding needing its own review, and it
is the most valuable thing this probe can produce.

## Known and accepted — do NOT close, do NOT report

The `processCommit`→anchor-`save` crash window; the laggard publisher; a fresh joiner's empty ts-mls
window; `oldest > cursor` over-reporting; the commit-topic storm and external-commit replay (filed); the
RPC receive binding mid-rotation (filed); `createMemoryBus` lacking sender identity (filed).

## Conventions

`kigu:conventions` + repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`; capital
`ID`; `#fields`; never edit `lib/`.

## Report contract

Full report → `docs/superpowers/probes/port-conformance-report.md`. Return ONLY: status,
uncommitted-changes note, one-line test summary, every divergence found with which side was wrong, and
concerns.
