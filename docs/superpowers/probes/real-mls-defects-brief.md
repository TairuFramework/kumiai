# Probe brief — make the app lane actually deliver over real MLS

Implementation probe in `/Users/paul/dev/yulsi/kumiai`, branch `feat/app-lane-delivery`. Do NOT switch
branches, do NOT commit. Leave changes uncommitted.

**Never run `git checkout`, `git restore`, or `git stash` on a file with uncommitted work.**

## Why this exists

The first end-to-end run of this branch against real MLS found that **not one app frame reaches a
handler**, and that commit-carried ledger entries never resolve. Both defects are invisible to all 288
existing tests because the fake crypto's `unwrap` is a pure XOR: free to call twice, free to call
re-entrantly. Real MLS is neither.

Read `docs/superpowers/probes/e2e-report.md` first. The two blocked scenarios are already written and
skipped in `tests/integration/test/app-lane-delivery.test.ts`, naming these defects. **Un-skipping them
is the deliverable.**

## Defect A — every inbound frame is unwrapped twice

`packages/rpc/src/peer.ts:619` and `:628` each construct `segmentBoundTransport(name, topicID)` on the
**same** topic — one for the `BroadcastClient`, one for the bus server. Both unwrap every inbound frame.
Real MLS consumes the ratchet key on the first open, so the second gets `Desired gen in the past`. The
handler is on the losing transport:

```
UNWRAP OK   at epoch 1n from did:key:z6Mkkuy8... len 71
UNWRAP FAIL at epoch 1n Desired gen in the past
seen []
```

**Approved approach: one inbound path per topic.** Unwrap each frame exactly once and fan the opened
result out to both consumers. State in a comment that opening is a *consuming* operation on the real
port and therefore cannot be duplicated — that is the invariant, and it is what the fake could not
express.

## Defect B — entries are opened inside the apply

`peer.ts:1665` passes `createLedgerEntryResolver(commitFrame.sealedEntries, crypto.unwrap)` into
`port.processCommit`, so the port calls `unwrap` while holding the handle mutex.
`ledger-entries.ts:87`'s `catch { return [] }` then swallows the failure, which is why the peer reports
itself converged at a dead epoch instead of raising.

Locking is not the whole problem: **`unwrap` mutates ratchet state**, so opening a blob mid-apply is
unsound however it is scheduled.

**Approved approach: stop sealing entry blobs as MLS application messages.** Seal them under a key
derived from the epoch's exporter secret. Then opening is pure, idempotent, re-entrant, and consumes no
ratchet generation — the re-entrancy question disappears rather than being managed.

Constraints the derived key must satisfy, and each needs a test:
- **Per-epoch.** A different epoch derives a different key. The removal boundary depends on this exactly
  as the anchor does.
- **Every member at that epoch derives the same key**, with nothing exchanged.
- **Pure.** Opening twice gives the same answer and changes no handle state.

The apply-time property that makes this work: a commit is applied at the epoch it is framed at, and the
author sealed its entries at that same epoch, so the applying peer always holds the right secret —
including a returning member replaying commits in order. Say so in a comment; it is the load-bearing
argument.

Decide and argue the port surface (a generic derive-and-seal on `GroupCrypto`, or a purpose-named entry
seal). This is a **format change** to the entry blob: if anything persists or transports the old format,
say what happens to it rather than assuming nothing does.

## Done when (all required)

1. **Both skipped integration scenarios pass** over real hub-server, real MLS, real crypto — un-skipped,
   not rewritten to expect less.
2. **The full thesis passes end to end:** a member goes offline, the others exchange logged messages and
   change the roster (add AND remove), more messages follow on the new segment, and the returning member
   receives every missed message, in order, exactly once, each opened at its sealing epoch.
3. **A frame is unwrapped exactly once** — assert it, do not infer it from the scenario passing.
4. **The derived entry key is per-epoch, agreed, and pure** — three tests.
5. **Mutation checks (required, paste each):** restore the second transport's unwrap → (1) or (3) goes
   red; make the entry key epoch-independent → (4) goes red. Invert by hand.
6. Whole suite green: `pnpm run build`, `rtk proxy pnpm run lint`,
   `pnpm exec turbo run test:types test:unit --force` 36/36, integration 27/27 with nothing skipped.

## Also fix, since you are here

The fake crypto's `unwrap` doc claims it is **"STRICTER THAN REAL MLS, deliberately"**. The e2e run shows
the real port also opens strictly at the current epoch, so the documented four-epoch safety margin does
not exist. Correct the comment to state what is true. The architecture doc's ts-mls retention note may
need the same correction — check it.

## Warning

Five tests this session passed for reasons unrelated to what they claimed; one was written by the
reviewer. **Watch every new test fail first.** For (3) especially: a test that counts unwraps must be
seen counting two before it counts one.

## Scope boundary

`packages/rpc/src/peer.ts`, `ledger-entries.ts`, `crypto.ts`, `packages/mls-rpc/`, `packages/mls/`, the
rpc fakes, and `tests/integration/`. Do NOT change `classify.ts`, the hub packages, the anchor seam, or
the conformance suite. If the real run shows one of those is wrong, report it — do not fix it here.

## Known and accepted — do NOT close, do NOT report

The `processCommit`→anchor-`save` crash window; the laggard publisher; a fresh joiner's empty ts-mls
window; `oldest > cursor` over-reporting; the commit-topic storm and external-commit replay (filed); the
RPC receive binding mid-rotation (filed); `createMemoryBus` lacking sender identity (filed); the five
unexercised `@kumiai/mls-rpc` recovery methods (noted).

## Conventions

`kigu:conventions` + repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`; capital
`ID`; `#fields`; never edit `lib/`. Comments state the invariant, never a finding or phase number.

## Report contract

Full report → `docs/superpowers/probes/real-mls-defects-report.md`. Return ONLY: status,
uncommitted-changes note, one-line test summary, whether the full thesis now passes over real crypto, and
concerns.
