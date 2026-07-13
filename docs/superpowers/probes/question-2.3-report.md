# Probe report — Question 2.3

**Does head-verified ledger bootstrap reject a doctored ledger?**

**Status: DONE.** The assumption holds. `computeHead` + `assertHeadMatches` wire onto the rejoin
path unchanged — no second head computation was written — and `isLedgerComplete()` is purely local:
it reads the handle's own ledger and the handle's own GroupContext, and consults no peer, no
network, and no memory of how the handle got where it is. The doctored-ledger attack (every token
genuinely signed, one demotion omitted) is rejected with nothing folded, and the same test **fails**
against a signature-only implementation.

---

## 1. The three methods

All three are methods on `GroupHandle`, with the signatures the spec's `GroupMLS` port declares, so
the port is a straight delegation.

| Method | `file:line` |
|---|---|
| `isLedgerComplete(): Promise<boolean>` | `packages/mls/src/group.ts:472` |
| `getLedger(): Promise<Array<string>>` | `packages/mls/src/group.ts:497` |
| `bootstrapLedger(tokens: Array<string>): Promise<void>` | `packages/mls/src/group.ts:527` |

One supporting change: `headsMatch(expected, actual): boolean` at `packages/mls/src/head.ts:191`,
exported from `index.ts`. `assertHeadMatches` (`head.ts:199`) now calls it. This is the *predicate*
form of the comparison that already existed (`bytesEqual` was module-private) — **one comparison,
two entry points**: a gate that must fail closed throws, a local invariant check reads the boolean.
`isLedgerComplete` needed a boolean, and the alternative was either a second byte comparison or
`try { assertHeadMatches(…) } catch { return false }` — exception-as-control-flow over a security
primitive. No head computation was duplicated: `computeHead` is called, never reimplemented.

Nothing else about `processWelcome`'s call site (`group.ts:1383`, formerly 1272) changed. Its
behaviour is byte-identical.

### What the rejoin path needed that `processWelcome`'s call does not have

Only one thing, and it is a difference in *what is being installed*, not in the check:

- `processWelcome` runs the check on a **brand-new handle** whose ledger is empty by construction,
  then calls `applyLedgerEntries` to append. `bootstrapLedger` runs on a **live handle** that may
  already hold entries, so appending is wrong — it must *install* the gathered ledger. That is
  sound precisely because the check is a fold **from genesis**: a list that reproduces the
  authenticated head *is* the group's entire ledger, in order, so replacement is the only correct
  semantics. Documented on the method.
- Consequently `bootstrapLedger` cannot reuse `applyLedgerEntries` — and must not, for two
  independent reasons. (a) `applyLedgerEntries` takes the same per-handle mutex, and the mutex is a
  FIFO chain, not reentrant (`src/mutex.ts`) — calling it from inside `bootstrapLedger`'s critical
  section deadlocks. (b) `applyLedgerEntries` *silently drops* a token that fails verification
  (correct for its role as the permissive low-level primitive); a bootstrap must fail closed, or a
  responder could hand back a list whose folded ledger differs from the one the head attests to.
  `bootstrapLedger` throws instead. (That throw is unreachable for any list that passed the gate —
  the chain digests the token *bytes*, so an unverifiable token cannot sit at a position whose id
  the authenticated head covers — but it fails closed regardless.)

## 2. How `bootstrapLedger` guarantees check-before-fold *structurally*

`group.ts:527-561`. The shape, not the statement order, is what carries it:

1. The head check reads **only** the `tokens` argument and the handle's own GroupContext
   (`readLedgerHead(this)`). It writes nothing.
2. `assertHeadMatches(authenticated.head, computeHead(this.groupID, entryIDs))` — `group.ts:538` —
   **throws** on mismatch. Everything after it is unreachable for a doctored ledger.
3. The fold builds **locals only**: a `log: Array<LedgerLogEntry>` accumulated in a local, verified
   entry by entry.
4. The handle is mutated in **one block of three assignments at the tail** (`group.ts:556-560`):
   `#ledger`, `#entryBodies`, `#roster`, all from that local. Nothing before it touches `this`.

So there is no half-applied state to roll back, because a rejected ledger writes nothing — and *a
partial verification failure* mid-loop also writes nothing, which a fold-as-you-verify shape would
not give you. `bootstrapLedger` runs on the handle's mutex, so a concurrent `processMessage` cannot
interleave into that window.

**Can a future edit slide a fold above the check?** Only by deliberately moving the mutating
assignments above line 538, which would mean moving them above the `const entryIDs` they depend on
— they consume `log`, which consumes `entryIDs`. The data dependency makes the ordering
load-bearing rather than stylistic. It is *not* structurally impossible in the type system: a future
edit that reintroduced `await this.applyLedgerEntries(...)` inside the method would fold before
checking (and deadlock, which is at least loud). The comment on the method names the invariant
directly.

## 3. The security test

`packages/mls/test/ledger-bootstrap.test.ts` — the `bootstrapping a ledger from an untrusted
responder` suite.

**How the doctored ledger was built.** No token was hand-forged. A real group is built: Alice
creates it (creator ⇒ genesis admin), invites Bob and Carol (each invite enacts a `group.role`
entry), then **promotes Bob to admin** and **demotes him back to member** — two real
`commitLedgerEntries` calls. The group's ledger is therefore, in order:

```
0  role(bob,   member)   — his invite
1  role(carol, member)   — her invite
2  role(bob,   admin)    — the promotion
3  role(bob,   member)   — the demotion   ← what the lying responder omits
```

Carol then rejoins by external commit (`joinGroupExternal({ resync: true })`), so she holds a live
MLS state and an **empty ledger** — the bootstrapping peer's exact state. The doctored ledger is
`aliceGroup.getLedger()` **with entry 3 dropped**. That is it. The reorder variant is the same four
tokens with 2 and 3 transposed.

**Every token in it genuinely verifies** — asserted in the test, not assumed:

```ts
for (const token of doctored) {
  const verified = await verifyLedgerEntry(token)
  expect(verified).not.toBeNull()
  expect(verified?.entry.groupID).toBe(groupID)
  expect(verified?.issuer).toBe(normalizeDID(alice.id))   // signed by the real admin
}
```

**The attack is demonstrated, not asserted.** Before checking that bootstrap rejects it, the test
folds the doctored ledger the way a signature-verifying implementation would (`restoreGroup` over
the same MLS state — which is exactly *verify-then-fold*) and shows the outcome:

```ts
expect(folded.roster.roles.get(normalizeDID(bob.id))).toBe('admin')   // the demoted admin, back
```

**Then the assertions the brief demands:**

```ts
await expect(carolRejoined.bootstrapLedger(doctored)).rejects.toThrow(LedgerIncompleteError)

// Nothing was folded — not "the throw happened".
expect(carolRejoined.ledger).toHaveLength(0)
expect(carolRejoined.ledgerTokens).toEqual([])
expect([...carolRejoined.roster.roles.entries()]).toEqual([[normalizeDID(alice.id), 'admin']])
expect(carolRejoined.roster.roles.get(normalizeDID(bob.id))).toBeUndefined()   // the demoted admin is absent
expect(carolRejoined.roster.roles.get(normalizeDID(carol.id))).toBeUndefined()
await expect(carolRejoined.isLedgerComplete()).resolves.toBe(false)            // still degraded; try the next responder
```

The roster is checked **exhaustively** (`toEqual` over the whole entry list), not just "Bob is not
admin": a fold-then-check implementation throws in the same place and fails this half, because the
demoted admin would be present.

The reorder test is identical in shape. Output:

```
 ✓ test/ledger-bootstrap.test.ts > bootstrapping a ledger from an untrusted responder > rejects a genuinely-signed ledger with one demotion omitted, and folds nothing 224ms
 ✓ test/ledger-bootstrap.test.ts > bootstrapping a ledger from an untrusted responder > rejects a reordered ledger — every entry present, every signature valid 159ms
 ✓ test/ledger-bootstrap.test.ts > bootstrapping a ledger from an untrusted responder > accepts the honest ledger and rebuilds the roster the group actually has 144ms
```

The third test is the counterweight to the first two: the **honest** ledger bootstraps, the roster
comes back as the group actually has it (Alice admin, **Bob member — demoted**, Carol member), and
`isLedgerComplete()` flips to `true`.

## 4. The mutation check — the test fails against the wrong implementation

The head check at `group.ts:538` was replaced with the wrong-but-passing implementation: **verify
each token's signature and call it done** (the per-token `verifyLedgerEntry` loop below it already
does exactly that, so the mutation is literally deleting the head assertion).

```ts
const entryIDs = tokens.map(ledgerEntryDigest)
// MUTATION (temporary): the wrong-but-passing implementation — verify every
// token's signature (the loop below does) and call it done.
void authenticated
```

Both security tests fail:

```
 × test/ledger-bootstrap.test.ts > … > rejects a genuinely-signed ledger with one demotion omitted, and folds nothing 220ms
   → promise resolved "undefined" instead of rejecting
 × test/ledger-bootstrap.test.ts > … > rejects a reordered ledger — every entry present, every signature valid 161ms
   → promise resolved "undefined" instead of rejecting
 ✓ … > accepts the honest ledger and rebuilds the roster the group actually has 146ms
 ✓ … > an empty-ledger peer rejects the promoted admin’s commit; a bootstrapped one applies it 286ms
 ✓ … > a genesis-only group is complete against a real, group-bound head 3ms
 ✓ … > true for a healthy handle, false for a rejoined one, and it consults no peer 45ms
 ✓ … > the ledger a responder serves is the ordered token log 141ms

 Test Files  1 failed (1)
      Tests  2 failed | 5 passed (7)

AssertionError: promise resolved "undefined" instead of rejecting
 ❯ test/ledger-bootstrap.test.ts:215:57
    215|     await expect(carolRejoined.bootstrapLedger(doctored)).rejects.toTh…
```

Note that the **liveness test and the honest-path test still pass under the mutation** — which is
the point of having them: they cannot distinguish the two implementations, and only the head check
does.

A throwaway probe (run under the mutation, then deleted) confirmed the mutated `bootstrapLedger`
does not merely fail to throw — it **installs the doctored roster**:

```
mutated bootstrapLedger resolved. resulting roster: [
  [ 'did:key:z6MktRgRKqthwaKo4pLidtmLBQvsCzqjXFE5vJEVTWoKHnW7', 'admin' ],   ← the creator
  [ 'did:key:z6MktPBquJy37eAZnTTqdLB2R5FeoGoHs21sHEeoADvVwVjJ', 'admin' ]    ← the DEMOTED admin
]
ledger length after bootstrap: 2
demoted admin role: admin
```

The mutation was reverted (`assertHeadMatches` restored at `group.ts:538`) and the probe file
deleted; the full verify below is against the reverted tree.

## 5. The liveness test

`packages/mls/test/ledger-bootstrap.test.ts` — `a rejoined peer's empty ledger is a roster reset`.

The world: Alice creates the group and invites Bob and Carol; **Alice promotes Bob to admin after
genesis** (nothing but the ledger says so); Carol rejoins by external commit (empty ledger); **Bob,
the promoted admin, authors a commit** (he writes `role(carol, admin)`). A control asserts a
complete-ledger peer (Alice) accepts that commit.

The test runs the world **twice**, differing in exactly one act — whether Carol bootstraps:

- **Leg 1, no bootstrap.** `carolRejoined.ledger` is empty, `isLedgerComplete()` is `false`, and
  the promoted admin is **not in her roster at all** (`toBeUndefined()`). She **rejects** his
  commit: `rejects.toThrow(CommitRejectedError)` — `foldEnvelope` refuses an entry whose issuer is
  not an admin in state-so-far, and in her reset roster Bob is not one. This is the assertion that
  makes an empty ledger a *roster reset* rather than a blank slate: she does not merely lack
  history, she actively rejects the live group's commits and re-strands herself.
- **Leg 2, bootstrapped from an honest responder.** `bootstrapLedger(honestLedger)` →
  `isLedgerComplete()` is `true`, Bob is `admin` in her roster, and the **same commit applies**:
  her epoch advances by 1 and Carol's role folds to `admin`.

```
 ✓ test/ledger-bootstrap.test.ts > a rejoined peer's empty ledger is a roster reset > an empty-ledger peer rejects the promoted admin’s commit; a bootstrapped one applies it 287ms
```

**Why two worlds rather than one handle doing both legs:** processing an MLS commit consumes its
secret-tree key (and `processMessage` zeroes the consumed material), so the same frame cannot be
replayed into the same handle after a rejection — that failure would be about MLS key deletion, not
about bootstrap. The two worlds are built by one function and are identical up to Carol's bootstrap,
so the A/B still isolates bootstrap as the only difference.

## 6. Can `isLedgerComplete()` be fooled?

**The genesis-only group reads `true`, and it is not vacuous.** This is the case the brief asks to
name explicitly. The comparison is *not* "both sides are empty":

- the left side is `readLedgerHead(handle).head` — the head extension **MLS-authenticates inside the
  GroupContext**, a 32-byte digest;
- the right side is `computeHead(groupID, [])`, which is `genesisHead(groupID)` =
  `SHA-256(DOMAIN ‖ groupID)` — also a real 32-byte digest, domain-separated and **bound to this
  group's id**.

The test asserts all of that concretely: the head is 32 bytes, equals `genesisHead(groupID)`, is
**not** equal to `genesisHead('some-other-group')`, and is not the all-zero buffer. So an empty
ledger reads complete only against a head that has never moved — which is exactly the group whose
ledger is genuinely empty. A rejoined peer's empty ledger against a *live* head reads `false`
(asserted: the rejoined handle's head is not the genesis head).

**Other ways both sides could be trivially equal — none survive:**

- *An attacker suppressing the head extension* so both sides are "absent". `readLedgerHead` returns
  `null` only when the extension is genuinely absent, and the GroupContext is MLS-authenticated — an
  extension cannot be removed without a commit every member validates. `isLedgerComplete` returns
  **`false`** on `null` (fail-safe: nothing it holds can be shown complete), which routes the peer
  into bootstrap, where `bootstrapLedger` throws loudly. A present-but-undecodable extension throws
  from `readLedgerHead` (existing behaviour) rather than reading as absent.
- *Winding the head back to genesis.* The head is a chain digest extended forward by every commit's
  enacted ids; it cannot return to genesis without a preimage.
- *A doctored ledger that folds to the right head.* That is a SHA-256 collision on the chain.

The invariant **consults no peer**: the test wires a `resolveLedgerEntries` resolver that counts
calls (and, for the genesis-only group, one that *throws* if invoked) and asserts the call count is
unchanged across `isLedgerComplete()` on both a healthy and a rejoined handle.

## 7. What a caller can hold wrong that the types do not prevent

1. **The mutex is not reentrant, and all three methods take it.** A host that calls
   `handle.getLedger()` or `handle.isLedgerComplete()` from *inside* a callback that already runs
   under the handle's mutex — `resolveLedgerEntries` and `onLedgerEntries` both do, they fire inside
   `processMessage` — **deadlocks**. The types say `Promise<…>` and nothing more. (They take the
   mutex on purpose: `applyLedgerEntries` awaits per-token verification *inside* its critical
   section, so a lock-free read can observe a half-applied ledger — a torn `getLedger()` would be
   served to another peer and fail *its* head check, and a torn `isLedgerComplete()` would
   false-negative into a spurious bootstrap.) This is the one hazard worth a line in the port's
   docs.
2. **`bootstrapLedger` replaces the ledger; it is not an append.** A caller that hands it a *delta*
   ("the entries I'm missing") gets `LedgerIncompleteError`, which is the safe direction — but the
   name does not say "whole log", and the `Array<string>` type is the same shape as
   `applyLedgerEntries`'s. Mixing them up cannot corrupt anything; it just always throws.
3. **Throwing is the whole contract, and the retry loop is the caller's.** The primitive does not
   remember which responder lied, does not retry, and does not mark the handle degraded. A caller
   that catches `LedgerIncompleteError` and carries on holds a handle with a reset roster that will
   reject the group's next commit. The spec is explicit that an incomplete ledger is a *persistent,
   retryable, degraded state* and that a peer must not report `advanced: true` over one — but
   nothing in these three signatures enforces it. `isLedgerComplete()` is the check that catches
   such a caller at the next lane operation.
4. **`getLedger()` on an incomplete handle serves an incomplete ledger.** A rejoined peer that has
   not yet bootstrapped will happily answer another peer's gather with its empty ledger — and that
   reply is *correctly rejected* by the requester's head check, so it is a liveness cost (a wasted
   responder), not a soundness hole. But a responder should gate on `isLedgerComplete()` before
   answering. The type does not.
5. **Not enforced here, by design:** "a responder that fails the head check is not asked again" is
   the caller's loop, per the brief's scope. The primitive's job is to throw, and it does.

## 8. Full verify output

From the repo root, with the `rtk proxy` prefix.

```
$ rtk proxy pnpm run build
@kumiai/mls:build:js: Successfully compiled: 17 files with swc (50.3ms)
@kumiai/hub-server:build:js: Successfully compiled: 6 files with swc (29.24ms)
@kumiai/hub-client:build:js: Successfully compiled: 2 files with swc (25.32ms)

 Tasks:    7 successful, 7 total
Cached:    4 cached, 7 total
  Time:    1.244s
```

```
$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 171 files in 140ms. No fixes applied.
```

```
$ rtk proxy pnpm test          # turbo run test:types test:unit
@kumiai/mls:test:unit:  ✓ test/policy.test.ts (35 tests) 5ms
@kumiai/mls:test:unit:  ✓ test/external-rejoin.test.ts (8 tests) 776ms
@kumiai/hub-server:test:unit:  ✓ test/hub.test.ts (13 tests) 1119ms
@kumiai/hub-server:test:unit:  Test Files  5 passed (5)
@kumiai/hub-server:test:unit:       Tests  56 passed (56)
@kumiai/mls:test:unit:  ✓ test/recovery.test.ts (9 tests) 1054ms
@kumiai/mls:test:unit:  ✓ test/ledger-bootstrap.test.ts (7 tests) 1265ms
@kumiai/mls:test:unit:      ✓ rejects a genuinely-signed ledger with one demotion omitted, and folds nothing 412ms
@kumiai/mls:test:unit:  ✓ test/group.test.ts (85 tests) 4035ms
@kumiai/mls:test:unit:  Test Files  21 passed (21)
@kumiai/mls:test:unit:       Tests  283 passed (283)

 Tasks:    27 successful, 27 total
Cached:    20 cached, 27 total
  Time:    5.717s
```

`test:types` (`tsc --noEmit -p tsconfig.test.json`) is part of `pnpm test` and passed for every
package, so the new test file typechecks under the strict config. No flakes observed; `ledger.test.ts`
passed on every run.

## 9. Files touched

- `packages/mls/src/group.ts` — the three methods (+111 lines), and one import.
- `packages/mls/src/head.ts` — `headsMatch` extracted as the predicate form of the existing
  comparison; `assertHeadMatches` now calls it (+11/-1).
- `packages/mls/src/index.ts` — export `headsMatch` (+1).
- `packages/mls/test/ledger-bootstrap.test.ts` — new, 7 tests.

Nothing in `@kumiai/rpc` was touched; no `GroupMLS` port, no gather transport, no responder
selection. Not committed.
