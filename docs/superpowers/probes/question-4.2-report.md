# Question 4.2 — do the acceptance criteria hold end to end?

**Status: DONE_WITH_CONCERNS.** Eight of the nine acceptance bullets hold. Bullet 1 is a design
property and not a testable claim (argued below, with its proxies). Two bullets were PARTIAL and
now have tests. One hole was found that is **outside** the acceptance list and is **not built**:
the ledger-bootstrap gather publishes the group's whole ledger **in the clear** to the relay.

Baseline: `d19aad1`, rpc 153 + 1 skipped. After: **rpc 155 + 1 skipped, 27/27 tasks green.**
No `src/` change.

---

## The census

| # | bullet | covering test | what it actually asserts | verdict |
|---|---|---|---|---|
| 1 | A host writes no ordering / authority / integrity / body-distribution code, and **no body store**. Only new obligation is the `HubStore` migration. | — (see "Bullet 1" below) | Nothing asserts an absence. Nearest proxies: `hub-server/test/conformance.test.ts` (the reference store passes the 17-clause suite, which *is* the whole store obligation, and it is exported at `@kumiai/hub-protocol/conformance` for hosts); `peer-ledger-bodies.test.ts › the hub is handed a frame it cannot read…` (`leakedBody === false`, no rendezvous traffic — no body distribution, no body store); `peer-cursor-table.test.ts › …when the hub swears each peer sent it themselves` (authority is read from the commit, never from the host's `senderDID`). | **DESIGN PROPERTY** (proxies green) |
| 2 | Two admins enacting concurrently converge; no permanent fork, no lost entries. | `peer-commit-cas.test.ts › two admins commit at the same epoch: one wins, the loser rebases, and BOTH land` | The race is *constructed* (Bob's publish is held until Alice's lands). `bobFramedAt === [1, 2]` — he rebased onto her epoch. **No fork**: exactly 2 frames on the commit topic, consecutive epochs, both journal slots null. **No lost entries**: `alice.mls.ledgerIDs()` and `bob.mls.ledgerIDs()` both equal `[aliceToken, bobToken]` — the loser's entry is in the *winner's* ledger, not just its own. Both at epoch 3. | **COVERED** |
| 3 | Two concurrent commits **on the same device** both land. | `peer-commit-cas.test.ts › two commits on ONE device serialize: neither builds against a superseded handle` | Both `commit()` calls issued before either finishes. `framedAt === [1, 2]` — the second build saw the first adopted. `journal.putWhileOccupied() === 0`. Both entries in the ledger, epoch 3, 2 frames in the log. | **COVERED** |
| 4 | A member invited **while commits are in flight** converges by pulling, **without recovery**. | `peer-commit-lane.test.ts › a member that subscribes after commits have landed converges by pulling them` | Dave's Welcome names epoch 1; two commits land before he subscribes, so no push can ever bring them. He reaches **epoch 3** having applied **2** commits, and his app lane is rebuilt at the epoch he *reached* (subscriber count at `protocolTopic(…, 3)` is 1, at `…, 1` is 0). `recoveryRequests(hub) === []` — the "without recovery" half, asserted directly. | **COVERED** |
| 5 | A third member who has **never seen an entry body** applies the enacting commit on first delivery. | `peer-ledger-bodies.test.ts › a member that has never seen a body applies the commit that enacts it, first time, with no gather` | Three members; Carol has never held the body. After one commit: `carol.mls.ledgerIDs() === [entryID]`, epoch 2, same for Bob and Alice. **`asksOnTheWire === []`** — no gather, no rendezvous, exactly 1 frame on the wire. And `leakedBody(hub, token) === false`. | **COVERED** |
| 6 | `exportGroupInfo` implementable by a host **without leaking group state to the relay**. | `packages/mls/test/recovery.test.ts › a sealed reply does not open for another member, or for a non-member holding the bytes` | Not a round-trip test. It **models the hub as the attacker** and grants it every input it could have: the request rides the wire in the clear, so it reconstructs the exact AAD (`groupID`, requester DID, requestID) and `info`, splits `enc`/`ct` out of the sealed bytes, and calls `hpke.open` with its own keypair — **rejects**. Then a **positive control**: the same reconstructed AAD *with* the ephemeral private key **does** open it, so the failure is the missing key and not a wrong AAD that would fail against any input. Also refuses: another member's leaf key, the responder's own, and the requester's *leaf* key (the key a leaf-sealing design would have used). | **COVERED** |
| 7 | A permanently-failing commit is dropped **once** and never retried forever. | *was* `peer-cursor-table.test.ts › a removed member's policy-refused commit is poison…` / `…a frame whose bodies nobody can supply is poison…` / `peer-ledger-bodies.test.ts › a commit whose bodies are not in its frame is dropped, and never retried` | The three tests assert **dropped** (`seen() === 1`, `commits() === 0`, epoch unmoved), **does not heal** (`heals() === []`) and **does not wedge** (the next honest commit lands). None of them asserts **once**: every `seen()` check happens inside the *first* pull's window, and a cursor that never advances is only observable on the *next* pull. **Proven by mutation: deleting either cursor-advance for a permanently-failing frame leaves all 153 tests green.** Now pinned by the new test below. | **PARTIAL** → covered |
| 8 | A peer that must heal converges **even under commit pressure**: its external commit is CAS'd, and losing the race costs it **a re-request, not a wedge**. | `peer-recover-lane.test.ts › losing the race discards the GroupInfo, not just the commit, and the rejoin still lands` | The heal **does** lose the CAS — a racing hub view lands Bob's commit between Alice's GroupInfo and her external-commit publish. `recoveryRequests === 2`: she **re-requested**, she did not retry the stale GroupInfo. It landed **for the group**: `bob.mls.epoch() === alice.mls.epoch() === 4`, Bob's tree holds exactly one `alice` leaf, and Alice folded the entry the *winning* commit enacted (`fold().get('role:carol') === 'admin'`). | **COVERED** |
| 9 | A member offline for **the trim window's duration** resumes by **pulling, not healing**. | *was* `peer-commit-reconnect.test.ts › a redelivered commit is not applied twice; a missed one is caught up by the pull` | That test covers **one** missed commit, carries **no entry bodies**, and **never trims the log** — so it passes against a hub that retains everything forever. It also **never asserts the absence of a heal**, which is the bullet's second half ("not by healing"). Now covered by the new test below. | **PARTIAL** → covered |

### Bullet 1: why it is not testable, and what the proxies are

"A host writes no ordering, no authority, no integrity, and no body-distribution code, and no body
store" is a statement about the **shape of the contract surface**, not about any run. No test can
observe code a host did not write. What *can* be held down, and is:

- **The store obligation is exactly the conformance suite, and the suite is the whole of it.**
  `testHubStoreConformance` is exported at `@kumiai/hub-protocol/conformance` (17 clauses) and
  `packages/hub-server/test/conformance.test.ts` runs it against `memoryStore`, the reference host.
  The `HubStore` surface it constrains — `publish / fetch / fetchTopic / ack / purge / trim /
  subscribe / unsubscribe / getSubscribers / storeKeyPackage / fetchKeyPackages` — has **no body
  API, no ledger API, and no entry-ordering API**. It orders *frames*, which is the log.
- **No body distribution, no body store**: the bodies ride the commit frame sealed under the epoch
  secret. `peer-ledger-bodies.test.ts` asserts the hub carried the body and never saw it, that the
  only thing on the wire is the commit, and that a third member resolves the entry from the frame
  with no gather.
- **No authority code**: `peer-cursor-table.test.ts › and still nobody heals when the hub swears
  each peer sent it themselves` — the hub forges `senderDID` per reader, and the peer still reads
  the committer out of the commit's own bytes.

That is the honest ceiling. I did not invent a fourth test that counts host methods and means
nothing.

---

## Tests written

Both assert **moved state** — epochs advanced, entries present in the member's ledger, the fold
right — and never the absence of an exception.

### 1. Bullet 7 — `packages/rpc/test/peer-cursor-table.test.ts`

`a commit that can never be applied is read ONCE, and the cursor never walks back over it`

Two permanently-failing frames arrive **separately**, so each is the last frame of the pull that
reads it — a cursor that failed to step over *either* is caught, rather than covered for by the
other's advance:

1. Mallory's policy-refused commit (`processCommit` → `{ advanced: false }`) → `seen() === 1`.
2. A commit naming an entry whose body is nowhere (`MissingLedgerEntriesError`) → `seen() === 2`,
   `commits() === 0`, epoch 1.
3. An honest commit at the same epoch wakes a **second pull** — the only observation that
   distinguishes *dropped once* from *retried forever*. Final: **`seen() === 3`** (three frames,
   three reads, ever), `commits() === 1`, **epoch 2**, `ledgerIDs() === [token]`, `heals() === []`.

### 2. Bullet 9 — `packages/rpc/test/peer-commit-reconnect.test.ts`

`a member offline for the retention window resumes by pulling, and heals from nobody`

Bob applies the group's first enacting commit, then goes offline (`hub.detach`) across **three
further enacting commits**, each carrying a body he has never seen, sealed under an epoch he was
not at. The hub then **sweeps the log to its retention window**: everything older than the frames
he still needs is gone, and his backlog is the **oldest thing left** — asserted
(`hub.oldest(topicID) === backlog.sequenceID`, the frame he already had is below it, and
`hub.head(topicID)` still names the tip, outliving the sweep). Without that, the test would pass
against a hub that retains everything forever.

On reattach: `commits() === 4`, **epoch 5**, `ledgerIDs()` equals all four entries **in order**,
`fold().get('role:dave') === 'member'` (promoted then demoted — a peer that applied the two the
other way round reports him an admin), and **`heals() === []`** — he asked nobody.

Fixture support (test-only): `DurableFakeHub` gains `published`, `trim(topicID, before)`,
`oldest(topicID)` and `head(topicID)`, mirroring `FakeHub`'s. Trim does not touch the head.

---

## Mutation checks

Every mutation was applied to `src/peer.ts`, run, and reverted. `src/` is pristine —
`git diff` touches test files only.

### M1 — the cursor does not advance over an **unresolvable** frame
Deleted `reconciledHead = position` in the `isMissingLedgerEntries` branch of `pullCommits`.

- **Before the new test: all 153 tests stayed GREEN.** This is what proves bullet 7 was PARTIAL.
- **After: 1 failed, 154 passed.** Only the new test went red:
  `AssertionError: expected 4 to be 3` — the poison frame was read a second time on the next pull.
- **Nothing else went red.** Not the three "poison, and nobody heals" tests, not
  `a commit whose bodies are not in its frame is dropped, and never retried` — they all converge
  anyway, because the honest frame is right behind the dead one.

### M2 — the cursor does not advance over an **applied or refused** frame
Deleted the trailing `reconciledHead = position` after the `processCommit` block.

- **1 failed, 154 passed.** Only the new test: `AssertionError: expected 3 to be 2` — the refused
  frame was re-read on the next pull.
- **Nothing else went red**, including every test that applies a commit from the log. A peer whose
  cursor never advances at all still converges (a re-read commit at a passed epoch is a no-op) and
  still reports itself healthy — it merely re-reads the whole log on every wakeup, forever.

### M3 — the peer's epoch is read **once per page** instead of once per frame
Hoisted `crypto.epoch()` out of the per-frame loop in `pullCommits`.

- **5 failed, 150 passed.** The new bullet-9 test went red:
  `AssertionError: expected 2 to be 4` — Bob applied only the first backlog frame; the rest went
  stale mid-page, classified as *ahead*, and sent him to heal.
- **What else went red** (all pre-existing, all correctly): `a member that subscribes after commits
  have landed converges by pulling them`, `a peer that has processed nothing seeds from the log,
  not from the head`, `a Welcome joiner reading history it was never part of does not heal on
  arrival`, `a peer whose transport dropped still reads the messages sent at its epoch`.
- So bullet 9's *convergence* half was already defended by the late-joiner tests; what the new
  test adds is the **no-heal** assertion under a **trimmed** log, which nothing else had.

---

## The trim-strand gap — named, and NOT built

Bullet 9 is the member offline **for** the window: its frames are still in the log, so it resumes
by pulling. That is what the new test covers, and it is what the design promises.

**The member offline BEYOND the window is a different peer and a known unbuilt gap.** Its frames
have been trimmed away; the log can no longer tell it what it missed. The design's trigger is
`head > reconciledHead` **and** `oldest` past the cursor — and **nothing in the peer reads
`oldest`**. `HubFetchTopicResult` carries it, both fake hubs return it, `pullCommits` ignores it.
Such a peer today: fetches from a cursor whose frames are gone, gets frames it *can* still see (or
none), walks to `reconciledHead == head`, and **reports itself healthy while stuck at a dead
epoch** — the silent-failure shape this plan keeps meeting. It is deliberately **not** in the
acceptance list, it is **not** conflated with bullet 9, and I have **not** built it.

---

## Concern: the ledger-bootstrap gather leaks the whole ledger to the relay

**This is a real hole, it is outside the acceptance list, and I did not fix it.**

Bullet 6 is about `sealGroupInfo`, and `sealGroupInfo` is clean — the mls test models the hub as
the attacker and it gets nothing. But the *next step of the same heal* undoes that. `ensureLedger`
asks the group for its whole ordered ledger, and the responder answers with:

```ts
// peer.ts, handleLedgerRequest
encodeHandshakeFrame(HANDSHAKE_KIND.ledgerReply, encodeLedgerReply(requestID, await port.getLedger()))
```

`encodeLedgerReply` (`recovery.ts`) **does not seal**. The signed entry tokens go onto the
rendezvous topic **in plaintext**. Verified empirically: in a heal where the group's ledger holds
`role:carol=admin`, that exact string appears in the clear in `hub.published` on
`rendezvousTopic(rs)`. These are the *same bodies* the commit frame goes out of its way to seal
under the epoch secret, and which `peer-ledger-bodies.test.ts` asserts the hub never sees
(`leakedBody === false`). The hub learns the group's entire authority state — every role, every
promotion and demotion, in order — from one heal.

It is not what bullet 6 claims, so it does not make bullet 6 fail. It is not covered by any other
bullet either. The spec is **silent** on it: §"Ledger bootstrap" says only that the gather "rides
the rendezvous lane". A fix looks feasible without a new primitive — bootstrap runs **after** the
rejoin has landed, so the peer is a member at the current epoch and `crypto.wrap` / `crypto.unwrap`
under the epoch secret would work, exactly as the commit frame's body blob does — but that is a
design change, and this probe does not invent one.

## Smaller observations

- **Naming drift.** The acceptance list says `GroupMLS.exportGroupInfo`; the port method built in
  Phases 1–3 is `sealGroupInfo` (with `createRecoveryRequest` / `applyRecovery`). Same obligation,
  different name.
- **A stale line in the spec's `## Testing`.** "Cursor-advance. A commit with unresolvable bodies
  is **retried without advancing**; a malformed commit advances the cursor once" contradicts both
  the code and acceptance bullet 7 — G36 changed the unresolvable row to *advance and never retry*,
  and `pullCommits` implements that. The Testing line was not updated. The code is right; the line
  is stale.

---

## Verify

```
$ rtk proxy pnpm run build
 Tasks:    7 successful, 7 total
  Time:    526ms

$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 190 files in 151ms. No fixes applied.

$ rtk proxy pnpm test
@kumiai/rpc:test:unit:  Test Files  26 passed (26)
@kumiai/rpc:test:unit:       Tests  155 passed | 1 skipped (156)

 Tasks:    27 successful, 27 total
  Time:    6.039s
```

The 1 skipped is the G41 app-lane test, skipped in the tree at `d19aad1` and untouched here.
