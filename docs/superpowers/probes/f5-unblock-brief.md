# Probe brief — a pushed log frame must say where it sits in the log

Implementation probe in `/Users/paul/dev/yulsi/kumiai`, branch `feat/app-lane-delivery`. Do NOT switch
branches, do NOT commit. Leave changes uncommitted.

**Never run `git checkout`, `git restore`, or `git stash` on a file with uncommitted work.**

## Why this exists

The app lane's drain pulls a segment's log **once** and latches, so frames published mid-walk are never
delivered — dropped-if-not-listening, reintroduced inside the drain that exists to prevent it.

Dropping the latch is safe only if the live path advances the same cursor the drain does. It cannot:
`hub.receive` yields a **delivery position** (a place in this recipient's queue, across all topics,
skipping its own frames), and the cursor needs a **log position**. `packages/rpc/src/cursor.ts:4-13`
brands them apart precisely so they cannot be crossed, `peer.ts` already refused this move for the commit
lane, and the conformance suite proves they differ — the delivery stream contains a mailbox sequenceID
the log does not (`hub-conformance/src/index.ts:158` vs `:170`). Saving a delivery position as the app
cursor is silent permanent message loss.

A previous probe was blocked here, correctly. Read `docs/superpowers/probes/f5-report.md` first.

## Approved approach (follow it; BLOCKED if it fights the code — do not redesign)

**Extend the hub contract: a pushed frame that is log-class carries its log position alongside its
delivery position.** The hub is the one party that knows both — it assigned both — and every other route
to this fact is a guess.

1. **The field is present exactly when the frame is log-class, and absent otherwise.** A mailbox frame
   has no place in any log, and an empty string or a zero is a lie the cursor would act on. Absent, not
   empty.
2. **It is typed as a log position** (the existing brand), so it cannot be crossed with the delivery
   position it travels beside. The whole defect is that these two look alike.
3. **Add it to the conformance contract** you now have (`packages/hub-conformance/src/log-hub.ts`), so
   every implementation and every double must carry it. A clause that a log-class push's log position
   equals the position the same frame occupies in `fetchTopic`, and that a mailbox push has none. This
   is the leverage the conformance work was for — use it.
4. **Then, in rpc:** the live app path advances the durable cursor with that position, under the existing
   rule — a cursor may only pass a frame that is DELIVERED or DEAD, advancing only over a contiguous
   done prefix. With that in place, drop `appSegmentLoaded` and let the drain re-pull; a re-pull from the
   cursor then returns only what was genuinely never delivered.
5. **Keep the two rpc-side positions distinct**: the durable cursor and the last-fetched position differ
   whenever an ahead-frame is buffered. Name both.

**If the hub cannot cheaply know the log position at push time, STOP and report BLOCKED** with what you
found. Do not synthesize it, do not infer it from a counter, do not assume the reference store's shared
counter is the contract — the audit already caught that assumption once.

## Done when (all required)

1. **A log-class push carries its log position; a mailbox push does not.** Conformance clause, run
   against the real store and every double. Must fail against today's code.
2. **A frame published mid-walk is delivered exactly once**, with the latch gone. Must fail today.
3. **An online peer is re-delivered nothing** across a re-pulling drain — the four existing
   duplicate-catching tests (`peer-app-topic` ×3, `peer-removed-blind` ×1) stay green, untouched.
4. **A restart does not re-deliver frames that arrived live**, which today it does.
5. **Mutation checks (required, paste each):** restore the latch → (2) goes red; stop the live path
   advancing the cursor → (4) goes red; make a mailbox push carry a log position → (1) goes red. Invert
   by hand.
6. Whole suite green (rpc 266+, mls 311, 30/30 turbo, integration 23/23). Do not weaken an existing test.

## Warning, from this session

Four tests written this session passed for reasons unrelated to what they claimed — one written by the
reviewer. **Run every new test against the unfixed state and watch it fail before trusting it.** If it
passes there, the test is wrong, not the code.

## Scope boundary

`packages/hub-protocol/`, `packages/hub-server/`, `packages/hub-client/`, `packages/hub-tunnel/`,
`packages/hub-conformance/`, `packages/rpc/src/`, and the two rpc hub doubles
(`test/fixtures/fake-hub.ts`, `test/fixtures/durable-fake-hub.ts`) plus new tests.

**Do NOT touch** other files under `packages/rpc/test/` (another probe may be finishing there),
`packages/mls/`, `classify.ts`, or `readCommitHeader`.

## Known and accepted — do NOT close, do NOT report

The `processCommit`→anchor-`save` crash window; the laggard publisher; a fresh joiner's empty ts-mls
window; `oldest > cursor` over-reporting; the commit-topic storm and external-commit replay (filed); the
RPC receive binding mid-rotation (filed); `createMemoryBus` lacking sender identity (filed).

## Conventions

`kigu:conventions` + repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`; capital
`ID`; `#fields`; never edit `lib/`. Comments state the invariant, never a finding or phase number.

## Verify (repo root, paste real output)

`pnpm run build && rtk proxy pnpm run lint && pnpm test`

## Report contract

Full report → `docs/superpowers/probes/f5-unblock-report.md`. Return ONLY: status, uncommitted-changes
note, one-line test summary, concerns. No full diff.
