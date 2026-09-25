# Probe report: Question 2.1

**Status: BLOCKED**

## Findings

The approved `HandleAccess` surface cannot preserve the existing in-commit ledger-entry open path without re-entering its own mutex. `processCommit` must use `access.mutate`. A real commit with ledger entries calls the installed `LedgerEntrySlot.resolve` while `GroupHandle.processMessage` runs. The frame resolver can call `GroupCrypto.openEntries` to open those entries. That operation needs the current handle's exporter key.

Once both factories receive only `access`, `openEntries` can obtain the current handle only through an access operation. `access.read` queues behind the active `access.mutate`, while that mutation awaits the resolver. Neither operation can finish. The scalar `epoch()` cannot provide the exporter key. The current direct `handle()` call avoids this cycle, but the approved factory signature removes that path. The brief explicitly requires the in-commit derivation to remain lock-free and prohibits routing it through `access.read`.

This is the brief's stop condition: avoiding re-entry requires a design change. No production API or caller migration remains in the worktree. The exploratory usage test was removed after its expected failure, leaving the baseline passing. The requested real-commit no-deadlock test could not be made to pass under the approved surface.

## Final API

No API changed. Both factories retain their existing `handle` inputs, and `createGroupMLS` retains `adopt` and `persist`. `HandleAccess`, `SimpleHandleAccessParams`, and `simpleHandleAccess` are not exported.

The proposed public surface remains the exact `HandleAccess` block in the spec. It needs an approved answer for key derivation during commit resolution before implementation can resume.

## Rationale and alternatives considered

The access mutex must serialise `read`, `mutate`, `replace`, and `open`. Letting a normal `read` bypass it inside the resolver would violate that contract. A private handle callback or an extra unsafe method would change the exact public surface. Re-entrant locking would also change the adapter contract and needs a way to distinguish the active operation from unrelated callers. Pre-resolving ledger entries before `mutate` is the approved direction for Question 3.2, but moving it into this probe would change the commit shell before its scheduled design proof. None of these alternatives was attempted after the blocker was established.

The rest of the adapter approach appears implementable: one queue can cover the four operations, mark a library-boundary save to avoid a second write, and publish the scalar after persistence. That observation does not resolve the commit resolver cycle.

## Surprises and learning

- The spec's general routing says `openEntries` derives through `access.read`, while this probe's re-entry instruction requires the in-commit derivation to stay lock-free. The existing resolver makes those requirements collide.
- `GroupHandle.processMessage` holds its internal mutex and awaits the ledger resolver. An access-level mutex is distinct from that internal mutex, but it still deadlocks when the resolver re-enters access.
- A usage test with one shared adapter passed to both factories read naturally. It failed at runtime as expected because `simpleHandleAccess` is not exported. The blocker arose from the resolver path, not the factory call shape.
- The ledger slot remains installed at every existing handle construction path. No handle construction code changed.

## Verification

The exploratory usage test ran before the API change and failed as expected: `2 tests | 2 failed`, both with `TypeError: simpleHandleAccess is not a function`. It was removed before baseline verification.

From the repository root, after removing the exploratory implementation:

```text
$ rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2
 Tasks:    49 successful, 49 total
Cached:    0 cached, 49 total
  Time:    44.1s

$ pnpm exec vitest run --root tests/integration
 Test Files  8 passed (8)
      Tests  43 passed (43)
   Duration  6.76s

$ rtk proxy pnpm run lint
Checked 396 files in 418ms. No fixes applied.
```

These are unchanged baseline results. They do not prove the proposed adapter or the no-deadlock requirement.
