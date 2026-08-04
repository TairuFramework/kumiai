# Pinning the rpc dispose guards — and the claims that came with them

**Status:** complete
**Date:** 2026-08-04
**Branch:** `test/pin-dispose-lane-guards`

## What this was

Residuals 1 and 2 from the `test/close-medium-test-gaps` review. `@kumiai/rpc`'s group peer gained
`assertLive()` at eight entry points on that branch, three of them on the lane calls — `commit`,
`replay`, `recover`. Deleting all three at once left the whole rpc suite green at 390/390, so two of
the three shipped unverified. A fourth path, `onCommitDelivery`, had no guard at all.

## The residual's premise was wrong, and correcting it changed the work

The residual assumed `replay` and `recover` were read-and-heal paths whose post-dispose cost was
smaller than `commit`'s. Reading the source disproved it — **both publish**. `replay` republishes a
journalled commit and then publishes a ledgerRequest to the rendezvous topic; `recover` is not
stopped by its early return, because `teardownEpoch` never nulls `commitTopicID` or
`rendezvousTopicID`, so it pulls the commit topic and publishes a recoveryRequest, and on a reply
would publish an external commit rotating the ratchet tree for the whole group.

What actually kept the suite green under guard deletion was simpler and worse: **no test called
either after dispose.** `mux.publish` carries no disposed check of its own, so nothing downstream
stopped any of it.

## What shipped

**1. The two lane guards are pinned** (`packages/rpc/test/peer-dispose-race.test.ts`). Each test
asserts both the refusal and that the peer wrote nothing to the hub. Each carries two independent
bites: `replay()` and `recover()` both *resolve* with their guards deleted, so the
`rejects.toThrow(/disposed/i)` assertion fails on its own regardless of what the recorder saw.

`recover()`'s test needed one ordering decision worth keeping: unguarded, it does not reject
promptly — no reply can reach a peer whose rendezvous subscription is gone, so it waits out
`requestGroupInfo`'s timeout and resolves. Assert hub traffic first, own the returned promise
immediately, await the rejection last; otherwise "it published" degrades into a bare timeout that
names nothing.

**2. `onCommitDelivery` got the guard it never had** (`packages/rpc/src/peer.ts`, the branch's only
production change, +7 −2). A silent `if (disposed) return` rather than `assertLive()`: an inbound
delivery has no caller to reject, and the surrounding `.catch(() => {})` would swallow a throw.

Staging its test took two attempts, and the failed one is the more useful record. **Gating subscribes
to hold `ready` pending does not work** — `retain` is synchronous and fires `void attemptSubscribe(...)`,
so `buildEpoch` never awaits a subscribe. The working mechanism is the commit mutex: `onCommitDelivery`
puts its `await ready` *inside* the `runSerial` callback, so a held mutex stops the callback starting
at all. The holder must be hub-silent or its own traffic lands in the recording, and `replay()` over
an empty journal with a complete ledger is exactly that — so the gate goes on `journal.get()`, and the
assertion stays a bare `toEqual([])` with no filtering.

**3. A shared recording-hub fixture** (`packages/rpc/test/fixtures/recording-hub.ts`), reversing two
earlier rulings against extracting one. Those rulings guarded against a shared recorder gaining a
parameter per caller; all three tests here need the *same* wrapper, so it takes none. The package's
three pre-existing inline wrappers stay as they are — they record different fields.

## What the process caught, worth remembering

- **Every guard was verified by mutation, and every mutation re-run independently** rather than taken
  from an implementer's report. Deleting `replay`'s guard produced one rendezvous `publish`;
  `recover`'s, three commit-topic fetches plus a rendezvous publish; `onCommitDelivery`'s, three
  post-dispose commit-log fetches.
- **The in-flight-subscribe test did not depend on the hole.** Its comment named `onCommitDelivery`'s
  unguarded rebuild as load-bearing, and the plan reserved a reshape/re-point/retire decision for the
  user. With the guard removed that test still *passed* — proving the claim false — so only the
  comment was rewritten. Nothing was patched to make anything pass.
- **The final review's two findings were both false claims this branch itself wrote**, which is the
  same failure that produced the work. The `assertLive` doc block said the inbound side was refused
  when only the commit lane is; the shared fixture justified its one-peer rule with a `receive` loop
  that does not exist (`hub.receive` is called once, at mux construction). Both corrected.
- **A comment edit reflows every line citation below it.** Growing the `assertLive` doc block by one
  line staled a citation in the test file, one in a persistent residuals doc this branch was editing,
  and then — in the fix wave — the new residual's own handler citations. Three rounds of the same
  drift.
- **Two of the plan's own gate commands were broken, and both failed silently.**
  `pnpm run test -- --filter X --force` forwards both flags to each package's vitest and tsc, which
  die on unrelated packages while filtering nothing; scope with
  `pnpm exec turbo run test:types test:unit --filter=@kumiai/rpc --force` instead. And `vitest -t`
  treats its argument as a regex, so `-t 'replay() after dispose'` matched nothing and reported a
  vacuous pass.

## Follow-on

**Residual 5**, opened by this branch's own final review and briefly filed as its own section in
`docs/agents/plans/next/2026-07-31-close-medium-test-gaps-residuals.md`: the rendezvous responder
lane still publishes after dispose. A reply timer that has already fired deleted itself from its
pending set before `dispose()`'s `clearTimeout` sweep walked it, and is then several MLS awaits from
a `mux.publish` — a sealed GroupInfo or the group's whole sealed ledger, from a torn-down peer. Out
of scope here (this branch's scope was residuals 1 and 2) and needs its own mutation-checked test.
Closed on `fix/rendezvous-dispose-guard`, 2026-08-04; that section is now removed from the residuals
doc.

Residuals 3 and 4 remain in the same file, untouched and not renumbered.

## Scope

One production change of 7 lines; everything else is tests, fixtures and records. Patch-level for
`@kumiai/rpc` — intent recorded in `.changeset/`.

Verified at completion: 44/44 unit and type tasks with `Cached: 0`, 58 files / 394 tests, lint clean
over 315 files.

Bookkeeping note: the plan's step checkboxes were never ticked. The work is evidenced by the commit
series, the per-task reviews and the forced gate, not by the checkboxes.
