# A restarted member that authors a commit could seal at a stale, pre-adopt handle

**Priority:** medium — untested contract on exactly the failure mode `crypto.ts` names in its own
doc comment. Not confirmed broken; the shape that would hide it is real and reachable, and no test
in the repo can currently catch it.
**Origin:** surfaced 2026-07-31 during `test/close-medium-test-gaps` Task 8, investigating
`next/2026-07-07-test-gaps.md`'s "encrypt from a restored handle after an epoch change" entry. That
entry's own shape (a restarted member only *receiving* commits) turned out unable to reach this
risk — see `docs/agents/plans/completed/` once that branch lands, or the SDD ledger at
`.superpowers/sdd/2026-07-31-close-medium-test-gaps/progress.md`, Task 8, for the full trail.

## The gap

`GroupCryptoParams.handle` (`packages/mls-rpc/src/crypto.ts:45-48`) is a function, not a value, and
the doc comment says why: "the handle is replaced when the peer adopts its own commit, and closing
over a fixed handle would silently seal at a dead epoch." That is a real bug shape — a `wrap` call
that captured `handle()`'s return once, before an `adopt()`, would keep sealing against the
pre-commit epoch's secrets forever, silently, since nothing about a successful seal reveals which
epoch it targeted.

Nothing in the repo exercises this. The receive-only catch-up path (`processCommit`,
`packages/mls-rpc/src/mls.ts:146-171`) applies received commits via `group.processMessage(commit)`,
which mutates the handle **in place** — there is no `adopt()` call on that path, so there is only
ever one mutable object and no stale reference to close over. `tests/integration/test/app-lane-delivery.test.ts:604`
walks a restored member through several receive-side commits and proves it decrypts correctly at
each epoch, but by construction it cannot separate "decrypt right, seal wrong": both draw on the
same object.

## The mechanism that makes it reachable

A member that **authors** a commit takes a different path. `tests/integration/test/app-lane-e2e.ts`'s
`build()` functions (`buildInviteCommit:298`, `buildRemoveCommit:323`, `buildLedgerCommit:355`) each
compute the commit against the *current* handle, hold the *new* group state (`committed.newGroup`)
in a closure, and only call `member.adopt(committed.newGroup)` from `onAccepted` — after the hub
accepts the commit. `adopt` (`app-lane-e2e.ts:169`) reassigns the closed-over `handle` binding that
`getHandle`/`createGroupCrypto`'s `handle: getHandle` reads (`:168,175`). That reassignment is
exactly the "handle is replaced" event the doc comment warns about, and it is a genuine new object
reference each time — something a test can freeze a stale copy of and check against.

So: a **restarted** member that goes on to **author** its own commit (rather than only catching up
on others') reaches `onAccepted` → `adopt()` post-restore, which is what makes it able to isolate
"a component captured `handle()`'s pre-adopt return and kept sealing against it."

**It is not the only route.** `adoptJournalled` (`app-lane-e2e.ts:195-209`) is a second `adopt()`
caller (`:201`), reassigning the same closed-over `handle` binding `getHandle` reads and producing
a genuine new object reference via `restoreGroup(...)` — the same freezable event. It is reachable
post-restore because `makeMember` carries `restartOf?.journal` forward (`:165`), so a restarted
member replaying an un-merged journalled commit takes it. Whichever route is chosen, the property
under test is the same; the author path is written up below because its trigger is explicit
(`peer.commit(...)`) where the journal-replay path needs a commit staged in the journal and left
un-merged before the restart. Check both before assuming the author path is cheapest.

## What would close it

A test that:

1. Restarts a member the same way `app-lane-delivery.test.ts:604` does (persist, kill, restore via
   `restoreMemberHandle`, rebuild the peer with `restartOf`).
2. Has the **restored** member author a commit (invite or remove) that changes the epoch, rather
   than only receiving one.
3. Immediately after `onAccepted` fires, has that same member `encrypt`/seal a message and asserts
   the recipient opens it at the **new** epoch.
4. Mutation-verifies by making `GroupCrypto`'s `wrap` (or an equivalent point in the built peer)
   snapshot `handle()`'s return once at construction instead of calling it fresh each time — the
   real bug shape the doc comment names. A correct test fails on that mutation; today, no test in
   the repo does.

If step 4 does not bite for a reason discovered only during implementation, record why rather than
discarding the test — this entry exists because Task 8 on `test/close-medium-test-gaps` already
found one plausible-looking route (fixture-only mutation, receive-side) that could not isolate it,
and that dead end is exactly what motivated writing this down precisely instead of re-guessing it.
