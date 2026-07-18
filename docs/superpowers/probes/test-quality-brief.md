# Probe brief — tests that pass whether or not the thing they name works

Implementation probe in `/Users/paul/dev/yulsi/kumiai`, branch `feat/app-lane-delivery`. Do NOT switch
branches, do NOT commit. Leave changes uncommitted.

**Never run `git checkout`, `git restore`, or `git stash` on a file with uncommitted work.**

## The standard

**A test must fail when the behaviour it names is removed.** Everything below is a test or guard that
does not. This is not cosmetic: three production defects this session hid behind green tests, and one
vacuous test was written by the reviewer an hour ago and caught only by mutating it.

The method throughout: **delete or invert the code the test names, and watch.** If it stays green, the
test is the finding.

## The findings

1. **Two guards in `deliverAppFrames` (`packages/rpc/src/peer.ts`) survive deletion.**
   - The `retentionOf(...) !== 'log'` re-check — a retained frame naming an ephemeral procedure.
   - The `opened.senderDID === localDID` self-echo skip.

   Both are load-bearing by argument (the first is "retention is the protocol's word, not the frame's";
   the second is "the live fan-out never echoes a publisher its own broadcast"). Neither is pinned.
   Write the test that reddens when each is deleted.

2. **`peer-app-drain.test.ts:20` sits in the drain suite and tests the live lane** — it dispatches an
   ephemeral procedure, which the drain never delivers. Move it where it belongs, or make it a drain
   test. Say which and why.

3. **`peer-removed-blind.test.ts`'s title claims forward secrecy the fake cannot express.** The XOR fake
   models topic derivation, not confidentiality. Either retitle it to what it actually proves (a removed
   member cannot derive the group's new topic) or move the confidentiality claim to `packages/mls`,
   where real crypto can carry it. Do not leave a title asserting more than the test can.

4. **`peer-recover-lane.test.ts:312` is green for the wrong reason.** "The winning branch does not heal"
   asserts an *absence*, so it passes even when the fork is never detected at all — which is exactly the
   state the codebase was in until this branch fixed it. Give it a positive companion: something that
   distinguishes "the fork was detected and correctly ignored" from "no fork was detected". If nothing
   observable at the peer can tell those apart, say so — that is a finding about the peer's surface, not
   a test to force.

5. **`fake-crypto.frameEpoch` invents an epoch for garbage** (`fake-crypto.ts:104-109`): anything ≥2
   bytes yields a plausible little-endian epoch, where the port requires `null` for bytes that are not a
   readable sealed frame. Make it refuse. The case that matters is garbage whose leading bytes read as a
   justified future epoch, which pins the cursor.

6. **The durable store doubles never fail and never refuse a backwards write** (`journal.ts`,
   `anchor.ts`, `app-cursor.ts`). Lowest priority of the six. `app-cursor.save` accepting a position
   older than the one it holds is the specific gap: the advance rule lives entirely in `peer.ts`, so no
   store can catch a regression in it. Add the refusal if it is cheap; if it reddens something, that is a
   finding.

## Done when

1. Each of 1–5 is either fixed with a test that reddens on deletion (paste each red), or reported as a
   finding with the reason it cannot be.
2. Item 6 done or explicitly deferred with a reason.
3. **No existing test weakened or deleted to make any of this pass.** A test that has to be weakened is a
   finding — report it.
4. Whole suite green (rpc 266+, mls 311, 30/30 turbo, integration 23/23).

## Scope boundary

Tests, fixtures, and the minimum `src` needed to make a guard observable. **Do not** change app-lane
behaviour, `classify.ts`, `readCommitHeader`, `hub-mux.ts`, or the hub doubles' new conformance
behaviour. If a test cannot be written without a `src` change beyond making something observable, STOP
and report it.

## Known and accepted — do NOT close, do NOT report

The `processCommit`→anchor-`save` crash window; the laggard publisher; a fresh joiner's empty ts-mls
window; `oldest > cursor` over-reporting; the commit-topic storm and external-commit replay (filed); the
live lane's missing read position (filed, blocked); the RPC receive binding mid-rotation (filed).

## Conventions

`kigu:conventions` + repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`; capital
`ID`; `#fields`; never edit `lib/`. Comments state the invariant, never a finding or phase number.

## Verify (repo root, paste real output)

`pnpm run build && rtk proxy pnpm run lint && pnpm test`

## Report contract

Full report → `docs/superpowers/probes/test-quality-report.md`. Return ONLY: status, uncommitted-changes
note, one-line test summary, and which items were fixed versus reported. No full diff.
