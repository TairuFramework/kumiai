# Forward compatibility — the escape hatches that must ship before they are needed

**Status:** complete. Nine tasks, landed on `feat/app-lane-delivery` (PR #7).

## Goal

Four API-surface audits over all ten packages found roughly thirty things that cannot change after
1.0 without breaking a consumer. This work took only the handful where deferring does not make the
later fix *breaking* — it makes it **impossible** — and left the rest until something actually needs
them.

## The rule that selected the work

> For most of these, deferring does not make the later fix breaking. It makes it impossible.

Each item is a mechanism that must exist in the code shipping *before* the code that needs it. A
version byte only helps if old readers already know to respect it. An extension type only installs if
every existing leaf already advertises it. Three strengths, and the gradation matters:

- **Unreachable.** No later version works. The reserved extension type (every existing leaf must
  already advertise it), and the handshake and commit-frame versions (old readers must already know
  to fail *correctly* — a peer that silently mis-parses cannot be taught to stop).
- **Degraded.** Possible later, but permanently uglier: the fix must carry a sniffing rule for the
  unversioned era. The client-state and credential-identity formats.
- **Silent.** Possible later, and it type-checks — which is the danger, because existing
  implementations satisfy the new signature while ignoring the new argument. The `exportSecret` label
  and the required sender on `unwrap`.

This is not "the breaking changes we want". It is what converts future changes from breaking to
additive, so the standing ruling — *do not pile up breaking changes with every follow-up doc; address
necessary changes as they are discovered* — stays possible.

## What was built

Hub procedures gained a `v1` segment. The handshake version is now returned rather than thrown, so an
unknown version reaches the classifier instead of being discarded. A third GroupContext extension type
is reserved and advertised in every member's capabilities. Version bytes landed on the client-state
and credential-identity formats. `GroupCrypto.exportSecret` takes the caller's label and an optional
length. `unwrap` returns a required authenticated sender. `AuthorizeHook` takes a discriminated
six-variant request and a structured decision. Broadcast reply identity moved from a self-asserted
field to the authenticated sender.

## Decisions worth keeping

**Kind before version, on the handshake frame.** Stronger than "keep `commit === 0`": the kind must
be readable before the version is interpreted, or a version bump makes the frame's own type
unreadable.

**An unknown frame version classifies `ahead`, never `poison`.** This is the single most important
outcome. Poison is the dangerous answer here and uniquely so: every other poison frame sits among
readable ones, so a peer heals off the next one — but after a version bump *every* frame is
unreadable, so there is no next. The peer steps over the group's entire future, drains to the end of
the log, and reports itself fully reconciled at a dead epoch, permanently and silently. The cost is
that anything able to publish to the commit topic can forge one and trigger a heal; nothing can forge
one that *suppresses* a heal, and that asymmetry is why the trade is accepted.

**A widened `exportSecret` needed a guard, not just a doc.** Passing the ledger-entry seal label
would otherwise hand back that key under another name. Refused loudly at the implementation.

**`AuthorizeRequest` ships all six variants although only two are enforced.** The union is the
exhaustive-switch surface a host closes over, so adding a seventh later is exactly the break the type
exists to avoid. A host's switch should default-allow an unrecognized action. **The enforcement for
the other four does not exist yet** — a host refusing `keypackage/fetch` today refuses nothing.

**Broadcast's `from` field was deleted rather than cross-checked against the authenticated sender.**
The rename is the break: a consumer reading the asserted field stops compiling, which is the only way
to tell it the meaning moved from asserted to authenticated.

## Correction to the spec

The spec claimed both halves of the reserved-extension work were load-bearing — "both land or the
reservation is worthless". That overstates it. The **leaf advertisement** is the irreplaceable half,
since leaves are signature-covered and can never be rewritten. The policy allowance only permits
installing the type *empty*; when a real feature arrives carrying data, the positional compare
rejects it and every peer needs a policy change anyway. That half is a two-phase-rollout convenience,
not the difference between possible and impossible.

## What the process caught

Six tests on this branch passed for the wrong reason, each found by asking "what if the guarded line
were deleted?" — including a reserved-extension guard where every call site passed empty data, so
deleting two of its three conjuncts left the suite green while an admin could inject arbitrary bytes
under the reserved type. The delete-the-guard inversion is what found all six.

The whole-branch review then caught a Critical that nine per-task reviews structurally could not see:
the handshake lane had been taught to heal from an unreadable frame, but twenty lines below, an
unreadable *commit frame* still hit a bare catch that advanced the cursor — reproducing the exact
dead-epoch failure the work existed to prevent, one layer down.

One regression escaped to the branch because the repo gate could not reach `tests/integration`: that
package had a `test` script and no `test:types` one, so a breaking signature change landed fully
green while an integration test still called the old shape. The package gained a `test:types` script;
the suite is now type-checked by the gate, though still not executed by it.

Deferred items from the audits are recorded in `docs/agents/plans/next/2026-07-20-deferred-api-findings.md`.
