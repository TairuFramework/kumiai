# Probe report — the branch's thesis against real crypto and a real hub

**Status: BLOCKED on the full end-to-end thesis.** Steps 1 and 2 of the brief are done and
green. Step 3 is blocked by **two defects in `packages/rpc/src`**, both found by this run, both
structurally invisible to all 288 existing tests, and both outside this probe's scope to fix.

One half of the thesis — the claim the XOR fake could not carry — **does pass end to end
against real MLS and a real hub for the first time.**

All work is uncommitted.

---

## What was built

### 1. The exporter secret (`packages/mls/`)

`GroupHandle.exportSecret(label, context, length = 32)` — RFC 9420 §8.5 over ts-mls's
`mlsExporter`, fed from `state.keySchedule.exporterSecret`. Not a reimplementation of the KDF.

Watched failing first (`expected 2n to be 3n`, then `aliceGroup.exportSecret is not a
function`), then made green. `packages/mls/test/exporter.test.ts` proves both required
properties: every member at an epoch derives the same bytes, a member at another epoch does
not, and a removed member keeps the old value for life without being able to follow it forward.
Label and context each separate the output.

### 2. `GroupHandle.decrypt` — a gap that had to be closed first

`GroupCrypto.unwrap` must return the authenticated sender. **ts-mls's `processMessage` returns
an application message's plaintext with no sender at all**, and `@kumiai/mls` exposed no way to
recover one: `readSenderLeafIndex` existed but `readPrivateCommitFrame` narrowed to
`contentType === commit` only.

`decrypt` reads the sender-data (epoch-level, consumes no ratchet key), then opens the body.
The sender is authenticated rather than claimed: the body only opens under the ratchet key
derived at the leaf the sender-data named, so a leaf that survives to be returned is one the
AEAD vouched for. Tested in `packages/mls/test/app-message.test.ts`.

### 3. The real ports — a new package, `@kumiai/mls-rpc`

**Where it lives, and why.** `@kumiai/rpc` does not depend on `@kumiai/mls` and must not — its
whole design is that group-rpc never imports MLS, which is why `GroupCrypto`/`GroupMLS` exist
as consumer ports at all. `@kumiai/mls` must not depend on `@kumiai/rpc` either; it is the
crypto core, and importing an RPC package's types would invert the stack. So the
implementation belongs above both.

Putting it in `mls/src` structurally-typed was considered and rejected: it would mean writing
the port shape from memory with **nothing checking it against the real one**, which is the exact
failure mode the seam already had. The new package imports the port types from `@kumiai/rpc`
and the handle from `@kumiai/mls`, so the compiler checks the seam. That check is most of the
value.

`createGroupCrypto` and `createGroupMLS` implement all of `GroupCrypto` and all twelve
`GroupMLS` methods. 7 unit tests in `packages/mls-rpc/test/crypto.test.ts` (these passed on
first write — no red was manufactured; they were written after the implementation).

### 4. The end-to-end test (`tests/integration/`)

- `log-hub-over-wire.ts` — a `LogHub` over the **real `hub-server`, reached over the real
  Enkaku wire**. Every publish, subscribe, fetch and delivery crosses `hub/publish`,
  `hub/subscribe`, `hub/topic/fetch`, `hub/receive`. It substitutes no hub behaviour; the only
  work is the base64 the protocol carries payloads as. Covered by `wire-hub-smoke.test.ts`,
  including the peer's own ordering (receive opened before subscribe).
- `app-lane-e2e.ts` — real MLS handles, real ports, real peers. The only in-memory pieces are
  the **host's** anchor store, cursor store, commit journal and state store, which a host has
  to put somewhere and which are not doubles of anything under test.
- `app-lane-delivery.test.ts` — the three scenarios. One passes; two are `test.skip` with the
  blocking defects named in place.

---

## The two defects

### Defect A — `unwrap` is called twice per live app frame, and real MLS refuses the second

`peer.ts` builds **two** `segmentBoundTransport(name, topicID)` instances on the **same**
protocol topic: one for the `BroadcastClient` (`peer.ts:619`) and one for
`createGroupBusServer` (`peer.ts:628`). Each is a `createBroadcastTransport` registering its own
listener, and each calls `crypto.unwrap` on every inbound frame.

Real MLS consumes the per-message ratchet key on the first open. Observed, one published frame:

```
alice PUBLISH ASUdEntIoLlObLVZRPfCiJG5yfDE4sR5TazFPTGed94 retain log bytes 322
bob   RECV    ASUdEntIoLlObLVZRPfCiJG5yfDE4sR5TazFPTGed94 000000000001
UNWRAP OK   at epoch 1n from did:key:z6Mkkuy8j8AWwpy3sNuy5JyjsD981PR95tPG5azshFmVAZZs len 71
UNWRAP FAIL at epoch 1n Desired gen in the past
seen []
```

The handler lives on the bus-server transport, so the frame is delivered to nobody. **Not one
app frame reaches a handler over real MLS.**

The fake's `unwrap` is a pure XOR, so double-unwrapping is free against it and every one of the
288 tests passes with the peer opening each frame twice. Pinned at the port level by
`packages/mls-rpc/test/crypto.test.ts` — *"unwrap is SINGLE-USE per frame"*.

### Defect B — the two ports deadlock against a single real handle

`CommitContext.resolveLedgerEntries` opens the entry blob with `GroupCrypto.unwrap`, and the
port calls it **from inside `GroupMLS.processCommit`**. Against one real `GroupHandle` these are
the same object: `processMessage` already holds the handle mutex when its commit pre-pass
invokes the resolver, and the resolver's `unwrap` waits forever on that same lock. The commit
never applies, no error is raised, and the peer reports itself converged at a dead epoch.

Confirmed by substituting a resolver that does not re-enter the handle. With the deadlock
removed, the whole rotation works:

```
PROCESSCOMMIT called at 2n
PROCESSCOMMIT done before 2n after 3n advanced true      <- the add
after invite alice 3n bob 3n
PROCESSCOMMIT called at 2n
PROCESSCOMMIT done before 2n after 3n advanced true      <- the absent member walks
PROCESSCOMMIT called at 3n
PROCESSCOMMIT done before 3n after 4n advanced true      <- across the remove
carol epoch 4n roster 3
```

**The mutex is not the whole problem.** `unwrap` mutates handle state, so opening a blob
mid-commit-apply would be unsound even if the lock allowed it. The two ports as specified
cannot both be served by one handle: the fix has to move the resolve out of the apply — either
`@kumiai/mls` resolving entries before it takes the mutex, or `@kumiai/rpc` handing bodies over
pre-opened rather than as a resolver called mid-apply.

The memory double has no mutex and no mutating decrypt, so it never sees this.

---

## What passes end to end, for real

**`a removed member cannot derive the group topic the group rotated onto`** — real hub-server
over the wire, real MLS, real `GroupCrypto`. Bob is removed by a commit that goes through the
peer's own commit lane; the group rotates. Bob then enumerates every topic he can name — his
exporter secret at epochs 0-8, the secret he held while a member at epochs 0-8, and the
lifelong recovery secret at epochs 0-8. The enumeration is proved real (it finds the topic he
was on) and it **cannot reach the topic the group moved to**.

This is the claim the XOR fake is structurally incapable of carrying, and the reason the
exporter surface mattered. It is now real.

Also verified against real MLS and the real hub, on the way to the blockage: a late peer walks
the commit log and applies commits carrying no ledger entries (2n -> 3n, roster shrinks), and
the removed member's handle correctly never advances.

---

## Other divergences found between a double and its port

3. **`exportRecoverySecret` cannot be a secret.** The double returns an opaque value handed to
   it, which reads as though it were confidential. MLS has no lifelong group secret — every key
   schedule secret rotates with the epoch, and a member who joined at epoch 5 never held epoch
   0's — so the real implementation derives it from the group's **genesis anchor, which is
   public to anyone who has seen a GroupInfo**. The port is right that it must be
   epoch-independent and that a removed member keeps it; it is the *appearance* of secrecy that
   is wrong. A host must not put anything on the rendezvous topic that confidentiality depends
   on. Documented on `createGroupMLS`.

4. **`wrap` is not pure.** The fake's is. The real one consumes a ratchet key, so the same
   plaintext seals to different bytes each time. Nothing in group-rpc depends on purity today,
   but a test asserting byte equality between two seals would pass against the fake and fail
   here. Pinned in `packages/mls-rpc/test/crypto.test.ts`.

5. **The per-commit resolver has nowhere to be installed.** `processCommit` is handed a
   resolver scoped to one commit's frame, but `GroupHandle` takes its resolver **once**, in
   `GroupOptions`, with no way to change it afterwards. A host cannot honour the per-commit
   contract with a plain handle — it must install an indirection when it *builds* the group and
   hand the same slot to the ports. `createLedgerEntrySlot` exists only because of this, and it
   is a seam a host will get wrong silently: pass anything else and every commit resolves
   against whatever resolver the handle happened to be born with.

6. **`processCommit` advances the handle in place for a received commit.** ts-mls's
   `processMessage` replaces the handle's own state, so there is nothing to adopt. The double
   models every commit as a value adopted separately, which is true only for a commit this
   member *authored*. A host that carried the double's shape across would double-apply every
   received commit.

7. **The fake's `unwrap` is described as "STRICTER THAN REAL MLS, deliberately" — it is not.**
   The real implementation opens strictly at the current epoch too, because
   `GroupHandle.decrypt` delegates to ts-mls's `processMessage`, which resolves against the
   current epoch's secret tree only. The documented four-epoch window is not reachable through
   this surface. The fake's comment claims a safety margin that does not exist; the conclusion
   it draws ("anything that passes against this fake passes against a real handle") happens to
   survive, but not for the stated reason.

---

## Verification (real output)

```
$ pnpm run build
 Tasks:    9 successful, 9 total

$ rtk proxy pnpm run lint
Checked 245 files in 169ms. No fixes applied.

$ pnpm exec turbo run test:types test:unit --force
@kumiai/hub-protocol:test:unit:       Tests  8 passed (8)
@kumiai/broadcast:test:unit:          Tests  35 passed (35)
@kumiai/hub-tunnel:test:unit:         Tests  69 passed (69)
@kumiai/hub-server:test:unit:         Tests  80 passed (80)
@kumiai/hub-client:test:unit:         Tests  5 passed (5)
@kumiai/mls-rpc:test:unit:            Tests  7 passed (7)
@kumiai/mls:test:unit:                Tests  317 passed (317)
@kumiai/rpc:test:unit:                Tests  277 passed (277)
 Tasks:    36 successful, 36 total

$ cd tests/integration && pnpm exec vitest run
 Test Files  6 passed (6)
      Tests  25 passed | 2 skipped (27)
```

No existing test was weakened. mls went 311 -> 317; rpc unchanged at 277; integration 23 -> 25
passing plus the 2 blocked scenarios, left written out and skipped with the defects named in
place rather than deleted — they are the shape the fix has to satisfy.

---

## Concerns

- **The blockage is in the port contracts, not in a line of code.** Defect B is not a bug that
  can be patched inside `processCommit`; the rpc port asks the MLS port to open sealed bytes on
  the same handle it is mid-apply on. Whoever fixes it is changing one of the two contracts.
- **Defect A is a silent data-loss path in production shape.** It is not a test artefact: a
  real host wiring a real handle today loses every app message on the live lane, with nothing
  raised anywhere. That is exactly the failure mode this branch exists to stop.
- **Nothing here proves the drain path.** With defect A live, no live delivery works at all, so
  the seed-pull/drain ordering, the durable cursor and mid-walk restart behaviour remain
  unexercised against real crypto. Those are the parts of the thesis still untested for real.
- `@kumiai/mls-rpc` is new and unreviewed. Its `GroupMLS` recovery methods (`applyRecovery`,
  `sealGroupInfo`, `sealLedger`, `openSealedLedger`, `bootstrapLedger`) are wired to the
  package's existing tested functions but **no test in this probe exercised them** — the peers
  never stranded. Treat those five as unverified.
- The `REQUEST_TTL_MS` bound on retained recovery keys is a guess (120s). The port makes
  retention the implementation's problem and gives no signal to key it off.
