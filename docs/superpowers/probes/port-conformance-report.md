# Probe report — one contract for `GroupCrypto` and `GroupMLS`

**Status: STOPPED on a production defect.** The suite is built, both implementations run against it,
and 23 clauses apiece are green. Making the rpc fake's `unwrap` consuming — required by the brief,
and the whole reason the suite exists — turned **three existing rpc tests red, and two of them are a
production defect in `packages/rpc/src`**: directed RPC opens every inbound frame twice on one
topic, which is Defect A again, in a lane the last probe declared correct. It is out of this probe's
scope to fix, and per the brief it is reported rather than patched.

All work is uncommitted. Nothing was committed and no branch was switched.

---

## What was built

`packages/rpc-conformance` — `@kumiai/rpc-conformance`, modelled on `@kumiai/hub-conformance` down
to the reason for its shape. `testGroupCryptoConformance` and `testGroupMLSConformance` take a
HARNESS (a group they can rotate) rather than an implementation, because a `GroupCrypto` alone
cannot be asked what happens at another epoch — moving between epochs is `GroupMLS`'s job and, on a
real handle, a whole MLS commit.

The port shapes are re-declared structurally, for hub-conformance's reason: `@kumiai/rpc`'s own
suite runs this over its fakes, so importing `@kumiai/rpc` here would put a cycle in the package
graph. The re-declaration is kept honest by an assignment check on **both** sides —
`(crypto: GroupCrypto) => ConformanceCryptoMember['crypto']` in each consumer's test file, so the
compiler fails if the structural shape drifts from the real port.

Run against:

- `packages/rpc/test/ports-conformance.test.ts` — `createFakeCrypto`, `createMemoryGroupMLS`.
- `packages/mls-rpc/test/ports-conformance.test.ts` — `createGroupCrypto`, `createGroupMLS` over
  real `@kumiai/mls` handles, via `packages/mls-rpc/test/fixtures/real-group.ts` (a real group with
  the COMMITTER outside the member list, so every commit a port is handed is a RECEIVED one — the
  case the contract is about and the case the double got wrong).

### Coverage of the brief's clauses

| Clause | Where |
| --- | --- |
| `exportSecret` per-epoch; removal boundary | `is PER-EPOCH` |
| every member at an epoch agrees, nothing exchanged | `every member ... derives the SAME secret` |
| `unwrap` consumes | `unwrap CONSUMES the frame` |
| `unwrap` opens only at the current epoch; throwing is control flow | **corrected** — see divergence 1 |
| `wrap` is not pure — what is actually guaranteed | `wrap is NOT PURE: two seals ... independently openable` |
| `frameEpoch` null for non-frames, never invents | `is TOTAL` + `reads the seal epoch from cleartext` |
| `readCommitHeader` epoch always, committer only where it authenticates, both directions | `returns the epoch for a commit framed at ANY epoch` |
| external committer only when the signature verifies | `report the rejoiner ONLY when the signature verifies` |
| `processCommit` advances in place; self-removal does not advance | `advances IN PLACE` / `a commit removing the LOCAL member` |
| `rosterDIDs` reflects an applied change, and only an applied one | `reflects an APPLIED roster change` — **partly not expressible**, see divergence 3 |

Plus, added because the two implementations disagreed about them: `entries are NOT the app seal`,
`a commit at another epoch is { advanced: false } and never a throw, in both directions`,
`exportRecoverySecret is stable across an epoch change`, and the bounded-window clause below.

Deliberately **not** covered: the recovery half of `GroupMLS` (`createRecoveryRequest`,
`sealGroupInfo`, `applyRecovery`, `sealLedger`, `openSealedLedger`, `bootstrapLedger`). It is a
multi-party rendezvous whose harness would be most of a peer, and a suite that mocked it would be
testing the harness. Those five remain unexercised, as the last probe already flagged.

---

## The production defect — STOP

### Directed RPC opens every inbound frame twice, and real MLS refuses the second

`peer.ts` builds, per protocol, an **inbox acceptor** listening on
`inboxTopic(anchor.secret, anchor.epoch, localDID)` with `unwrap: crypto.unwrap` (`peer.ts:692-700`),
and `to(memberDID)` builds a **directed client** whose tunnel receives on
`inboxTopic(secret, epoch, localDID)` — *the same topic* — with its own `unwrap`
(`directed.ts:45`, via `sealDirectedHub`). The mux fires `onInbound` listeners before it pushes to
receive sinks, so the acceptor opens first and spends the frame's ratchet key; the directed client's
tunnel is then refused, and the reply reaches nobody.

Observed, instrumenting `unwrap` at the port, one directed request alice → bob:

```
OK   bob   len=249 epoch=1
OK   alice len=226 epoch=1
FAIL alice len=226 epoch=1 :: cannot open: the message key for generation 0 from bob at epoch 1 is spent
result: "NEVER ANSWERED"
```

The request does not time out — it never settles. Two existing tests hang on it:

```
FAIL test/peer.test.ts > createGroupPeer > directed request via .to(memberDID)
FAIL test/integration.test.ts > group-rpc end-to-end (3 members over one hub)
     > bus, anycast, gather, and directed request/stream/channel all work
```

This is **Defect A, in the directed lane**, and `docs/superpowers/probes/real-mls-defects-report.md`
closes by asserting the opposite: *"the directed-inbox acceptor still calls `crypto.unwrap`
directly. The acceptor is on its own topic and unwraps each frame once, so it is correct today."*
It is on its own topic; it is not the only consumer of it. A real host calling
`peer.protocol(x).to(did).request(...)` over real MLS gets no reply, ever, with nothing raised.

The fix is presumably the one already applied to the app lane — one inbound path per topic, opened
once, fanned out — but it is `packages/rpc/src/**`, out of scope, and it is a design decision about
where the directed lane's single-open seam belongs. **Not attempted.**

---

## Divergences found, and which side was wrong

### 1. `unwrap` DOES reach ts-mls's past-epoch window. The last probe's "correction" made three docs false. — *the clause was wrong*

The brief's clause "`unwrap` opens only at the current epoch" is not true of the real port, and I
proved it from behaviour rather than from a comment:

```
epochs before 3n 3n
epochs after  4n 4n
BELOW-EPOCH UNWRAP SUCCEEDED: before          <- frame sealed at epoch 3, opened at epoch 4

epoch now 8n
frame 0 refused: Cannot process message, epoch too old   <- six transitions on, all refused
... (frames 1-5 the same)
```

A handle advanced by `processMessage` keeps the previous epochs' key material and opens below
itself. A handle **replaced wholesale** — a member adopting the derived handle of a commit it
authored — starts with no history and does not. That second case is the one
`packages/mls-rpc/test/crypto.test.ts`'s *"unwrap refuses every epoch but the handle current one"*
exercises (`alice.adopt(removed.newGroup)`), so that test passes for a reason other than the one it
states. It was not weakened; it is simply narrower than its name.

**`packages/rpc/src/crypto.ts` is right** and says so explicitly: a real handle "also opens a few
epochs BELOW the current one — ts-mls keeps four", group-rpc must not depend on it, and "an
implementation that opens strictly at the current epoch is a correct implementation of this port".
No production change needed.

**Three doc comments asserting the opposite were corrected** (all introduced by the previous probe's
"Also fixed" section, which reasoned from `GroupHandle.decrypt`'s delegation rather than from a
measurement):

- `packages/rpc/test/fixtures/fake-crypto.ts` — claimed parity and "no safety margin underneath".
- `packages/mls-rpc/src/crypto.ts` — *"The fake is not stricter than the real port here. It is the
  same."*
- `docs/agents/architecture.md:112` — *"There is no past-epoch window here ... measured against real
  MLS, not assumed."*

The suite now asserts the two things both implementations must do — open at the current epoch, and
**refuse** an epoch not yet reached — plus a new clause, *"a frame sealed FAR below the current
epoch is gone for good"*, six transitions on. That is the fact that makes the window unusable: it is
spent by epoch **transitions**, not time.

### 2. The rpc fake's `unwrap` did not consume. — *the fake was wrong; fixed*

`createFakeCrypto` was a pure XOR: every frame opened forever, for free. `wrap` now writes a
per-sender generation into the sealed region and `unwrap` spends it per receiver
(`epoch:senderDID:generation`), which is MLS's own per-sender chain modelled. The frame layout grew
by four bytes and `frameEpoch`'s structural check moved with it.

This is what surfaced the directed-lane defect above, and it is what the clause exists for.

### 3. Real `rosterDIDs` shrinks on a commit the member could NOT apply. — *the double was stricter; not expressible*

A member handed the commit that removes it answers `{ advanced: false }` on both sides. But the real
port's roster moves anyway:

```
carol own did did:key:z6MkrMsmExq4XpyQh9J9w4jB6J7Zzg2E7EzehatJrmcX7A4t
lost [ 'did:key:z6MkrMsmExq4XpyQh9J9w4jB6J7Zzg2E7EzehatJrmcX7A4t' ]
epoch 3n                                   <- unchanged; the roster went 4 -> 3
```

ts-mls's `processMessage` returns a state with the member's own leaf gone and
`GroupHandle.processMessage` assigns `this.#state = result.newState` unconditionally. The memory
double deliberately does the opposite — *"a member that cannot apply the commit does not learn its
roster from it"*.

**This reaches production.** `peer.ts:1574-1577` diffs `rosterDIDs()` around every advance and
captures a new anchor if it moved, **without regard to whether the advance advanced**. So a removed
member re-anchors at the epoch it is stranded on and, in `captureAnchor`, clears `appSegment`,
`appCursors` and `appStaged` — discarding undelivered app frames it could still have opened at that
epoch. `peer-removed-blind.test.ts` runs against the double and cannot see it.

Not fixed (`packages/rpc/src`, `packages/mls/src` — both out of scope). The clause is **not
expressible against both implementations**, so the suite asserts only what both must do (the member
does not advance; the commit is applicable by everyone else) and names the divergence in place.

### 4. An existing rpc test expects a duplicate delivery real MLS cannot produce. — *a conflict, reported not weakened*

```
FAIL test/peer-app-drain-integrity.test.ts > a member's own frame in the log is not delivered back to it
AssertionError: expected [ { text: 'alice said this' }, …(1) ] to deeply equal [ …(2) ]
```

The test asserts that a restart re-delivers a frame the live lane already handed the host. With a
consuming `unwrap` and a crypto that survives the restart (the fixture's `restartOf?.crypto`, which
correctly models persisted handle state) the frame cannot be re-opened, so it arrives once. The
observed behaviour is what real MLS does and is arguably better; the expectation was the fake's.
The test was **not** changed — per the brief, a conflicting test is a finding.

### 5. `peer-app-retention.test.ts` opened a frame the peer had already opened. — *test instrumentation; fixed*

The test verified retention by calling `bob.crypto.unwrap` on a payload bob's own peer had already
opened live. Now opened by an independent reader at the same epoch, which is exactly the claim
(the frame is retained and openable) with none of the second-open assumption. No assertion changed.

### 6. `unwrap` may be SYNCHRONOUS, and one side of the port is. — *the suite was wrong; fixed*

`Unwrap` returns `Uint8Array | UnwrapResult | Promise<...>`, so a synchronous implementation refuses
by throwing rather than rejecting — the fake does, the real port does not. Five clauses were red for
that reason alone before the suite grew a `refuses()` helper. Both are conformant, and `peer.ts`
tolerates either (the mux catches a listener's throw at `hub-mux.ts:372-378`; every read path awaits
inside a `try`). A suite that only accepted a rejection would have been testing which of the two an
implementation happened to pick.

---

## The promoted scenarios (requirement 4)

`tests/integration/` now runs all four of the brief's scenarios against real `hub-server` over the
real Enkaku wire, real `@kumiai/mls` handles, and the real ports. Two already existed; two are new:

- **a frame published mid-walk** — hung off the delivery of the first frame, so it lands strictly
  after the walk's segment pull and strictly before the walk ends, sealed at an epoch the walking
  peer has not reached. Delivered in order, exactly once, with both deliverers live.
- **a restart mid-walk** — the process dies *inside* its handler (peer disposed and the socket
  dropped with it), then resumes over its persisted state. It delivers the epoch-one frame **twice**
  and that is asserted as correct: the first process never confirmed it, so the read position never
  passed it, and the lane is at-least-once across a crash mid-delivery. The repeat is only possible
  because the restored MLS state predates the open — a peer that persisted after opening could not
  re-open it.

Both need a roster-neutral advance so the anchor holds still and the log grows under one topic:
`buildLedgerCommit` (`app-lane-e2e.ts`) over `signLedgerEntry` + `commitLedgerEntries`, which also
exercises the entry seal end to end.

---

## Mutation checks (requirement 5) — real output

Each inverted by hand afterwards; `git diff` confirms the mutated files back at their committed
state.

**1 — fake `unwrap` made non-consuming again** (`if (false && spent.has(key))`):

```
× GroupCrypto conformance — createFakeCrypto > wrap / unwrap
  > unwrap CONSUMES the frame: the second open of the same bytes does not succeed
  → promise resolved "{ …(2) }" instead of rejecting

Tests  1 failed | 22 passed (23)

=== and the REAL side, unchanged ===
PASS (23) FAIL (0)
```

**2 — memory `GroupMLS` reports a committer at any epoch** (`if (false && parsed.epoch !== epoch)`):

```
× GroupMLS conformance — createMemoryGroupMLS > readCommitHeader
  > returns the epoch for a commit framed at ANY epoch, and the committer only at this member own
  → expected 'did:key:committer' to be undefined
```

**3 — memory `GroupMLS` reports an unverified external committer** (signature check disabled):

```
× GroupMLS conformance — createMemoryGroupMLS > external commits
  > report the rejoiner ONLY when the signature verifies, and the flag either way
  → expected 'did:key:alice' to be undefined
```

**4 — the REAL `frameEpoch` invents an epoch for unreadable bytes** (`return epoch == null ? 0 : …`):

```
× GroupCrypto conformance — createGroupCrypto over a real GroupHandle > frameEpoch
  > is TOTAL: null for bytes that are not a readable sealed frame, and never throws
  → expected +0 to be null

=== rpc fake side, unaffected ===
PASS (23) FAIL (0)
```

Every clause reported here was watched red against an implementation that violated it — divergences
1, 3 and 4 above were each first seen as a red clause, not written to a known answer.

---

## Verification (real output)

```
$ pnpm run build
 Tasks:    10 successful, 10 total

$ rtk proxy pnpm run lint
Checked 256 files in 167ms. No fixes applied.

$ pnpm exec turbo run test:types test:unit --force
@kumiai/hub-protocol:test:unit:       Tests  8 passed (8)
@kumiai/broadcast:test:unit:          Tests  35 passed (35)
@kumiai/hub-tunnel:test:unit:         Tests  69 passed (69)
@kumiai/hub-server:test:unit:         Tests  80 passed (80)
@kumiai/hub-client:test:unit:         Tests  5 passed (5)
@kumiai/mls:test:unit:                Tests  317 passed (317)
@kumiai/mls-rpc:test:unit:            Tests  33 passed (33)
@kumiai/rpc:test:unit:                Tests  3 failed | 299 passed (302)
  FAIL test/integration.test.ts > bus, anycast, gather, and directed request/stream/channel all work
  FAIL test/peer-app-drain-integrity.test.ts > a member's own frame in the log is not delivered back to it
  FAIL test/peer.test.ts > createGroupPeer > directed request via .to(memberDID)
 Tasks:    38 successful, 39 total

$ cd tests/integration && pnpm exec vitest run
PASS (29) FAIL (0)
```

mls-rpc 10 → 33 (+23 conformance). rpc 279 → 302 (+23 conformance), 3 red. integration 27 → 29,
nothing skipped. mls unchanged at 317.

**Requirement 6 is not met, and cannot be met from inside this probe's scope.** The three red tests
are the deliverable: two are the directed-lane defect and one is a test whose expectation real MLS
cannot satisfy. Closing them means either changing `packages/rpc/src/**` (forbidden here, and the
right call for a reviewer) or making the double lenient again (forbidden, and it is what hid the
defect for 288 tests).

---

## Concerns

- **The directed lane is the app lane's defect, unfixed, in a lane nothing tests over real crypto.**
  No integration scenario exercises directed RPC against real MLS; if one had existed, this would
  have been found when the app lane was. Adding one belongs with the fix.
- **The removed-member anchor rotation (divergence 3) has no test on either side.** The suite names
  it but cannot assert it, `peer-removed-blind.test.ts` runs against the double, and no integration
  scenario removes a member that is still running a peer with an unread app segment.
- **A doc comment was treated as a contract twice now, in opposite directions.** The retention-window
  claim was wrong, then "corrected" to something also wrong, and both survived review because the
  reasoning looked sound. The clause in `packages/rpc/src/crypto.ts` was right the whole time. The
  new suite measures instead, which is the only reason this turned up.
- **The conformance harness has to be able to rotate a group**, which makes writing one for a new
  implementation non-trivial — `real-group.ts` is 190 lines. That is inherent (an epoch boundary is
  a commit), but it is friction a host will feel.
- **The structural re-declaration can still drift** in ways the assignment check does not catch: it
  is one-directional (real port → conformance shape), so a clause could be written against a method
  the real port does not have as long as the harness supplies it. Both consumers make the check, so
  a *removed* or *retyped* port method fails the build; a spurious one would not.
- The `@kumiai/rpc-conformance` package is new and unreviewed, and unlike `hub-conformance` it has
  no `test:unit` of its own — it is exercised only through its two consumers.
