# Probe report — Question 2.1

**Does a commit rotate the committer's leaf HPKE key? YES** — and the pre-commit private key is
useless against the rotated one, and cannot be recovered from anything the committer still holds.
The premise stands. The ephemeral-key machinery in 2.2 is warranted.

One correction to the spec's wording is required (see *Caveat* below): it is **not** true that
"every Commit carries an UpdatePath". A Commit whose proposals are *only* Add / PSK / ReInit legally
omits the path and rotates nothing. Every commit **this repo** can produce carries a path, so the
hazard is universal *here*, but the sentence as written is false about MLS in general.

## The mechanism, in ts-mls

Version: `ts-mls@2.0.0-rc.13` (no source ships; line numbers are into `node_modules/ts-mls/dist/src/`).

**Where the fresh leaf key is minted and installed.** `createUpdatePath` draws a *fresh random*
path secret, derives a leaf keypair from it, and signs it into a new `LeafNode` with
`leafNodeSource: commit`:

- `updatePath.js:26-28` — `const pathSecret = cs.rng.randomBytes(cs.kdf.size)` → `deriveSecret(…, "node")`
  → `cs.hpke.deriveKeyPair(leafNodeSecret)`. The new leaf key descends from **fresh randomness**, not
  from the group's key schedule, not from the committer's prior state. Nothing already in hand
  predicts it.
- `updatePath.js:35-49` — the new `hpkePublicKey` (RFC 9420's leaf `encryption_key`) goes into the
  `LeafNodeTBS`, is signed (`signLeafNodeCommit`), and is written into the committer's own leaf slot
  of the tree the commit carries.
- `updatePath.js:60` — `// we have to remove the leaf secret since we don't send it to anyone` — the
  leaf secret is sliced off the list of path secrets that get HPKE-encrypted to the copath. **The
  private half is transmitted to no one, ever.**
- `updatePath.js:133-135` (`applyUpdatePath`, the *receive* side) — a receiver **rejects** a path
  whose leaf key equals the committer's current one:
  `ValidationError("Public key in the LeafNode is the same as the committer's current leaf node")`.
  So when a path is present, rotation is not merely conventional; it is enforced by every receiver.

**Where the committer's own private half is replaced.**

- `createCommit.js:57-62` — the new private key returned by `createUpdatePath` is exported and
  written over the committer's leaf slot in its private key path:
  `updateLeafKey(state.privatePath, await cipherSuite.hpke.exportPrivateKey(newPrivateKey))`.
- `privateKeyPath.js:19-21` — `updateLeafKey` replaces `privateKeys[leafToNodeIndex(leafIndex)]` —
  a *new object*; the old `ClientState` is untouched (ts-mls is functional here).
- `createCommit.js:85-90` — that path lands only in `newState.privatePath`, on the **returned**
  state.

That last point is the whole hazard: `createCommit` never mutates the state it was given. The new
leaf private key exists **only** inside the returned `newState`. A committer that dies before
persisting/adopting that value has destroyed it — while the group, which has applied its commit, has
moved to the matching **public** key.

## Can the committer recover its own private key from anything it still holds? **No.**

Three independent doors, all closed:

1. **From its own state** — the key is fresh randomness (`updatePath.js:26`), not derived from the
   old epoch's secrets. Nothing in the pre-commit `ClientState` determines it.
2. **From the commit bytes it sent** — the UpdatePath carries the leaf's **public** key and path
   secrets encrypted to the *copath* resolution. The author's own subtree is excluded by
   construction (`updatePath.js:60`). Replaying its own commit into its own stale state throws
   `InternalError: No overlap between provided private keys and update path`
   (`createCommit.js:210-220`, `applyUpdatePathSecret`) — asserted in the test.
3. **From the group** — no member ever receives the committer's leaf secret, so no peer can hand it
   back.

The only recovery is to obtain a *new* leaf, i.e. a fresh external join / resync — which is exactly
the operation `recover()` exists to bootstrap, and which is why the reply cannot be sealed to the
leaf key the group sees.

## Caveat: "every Commit carries an UpdatePath" is false as stated

`clientState.js:443-447` (`applyProposals`):

```js
const needsUpdatePath = allProposals.length === 0 ||
    allProposals.some(({ proposal }) => {
        const t = proposal.proposalType;
        return t !== defaultProposalTypes.add && t !== defaultProposalTypes.psk && t !== defaultProposalTypes.reinit;
    });
```

and `createCommit.js:57-59` — when `needsUpdatePath` is false, `createUpdatePath` is **not called**:
the commit ships with `path: undefined`, `newPrivateKey: undefined`, and the committer's leaf key is
**not** rotated. This is RFC 9420 §12.4 behaviour (an Add-only commit may omit the path), not a
ts-mls quirk. `processMessages.js:183` enforces the converse on receive (`"Update path is required"`).

**Why it does not weaken the premise here.** Every commit this repo builds routes through
`commitWithEntries` (`packages/mls/src/group.ts:961-1029`), which appends a
`group_context_extensions` proposal (advancing the ledger head) whenever the commit enacts entries:

- `commitLedgerEntries` (`group.ts:1095`) — refuses an empty token list, so always ≥1 entry → GCE
  proposal → path.
- `commitInvite` (`group.ts:1149`) — `createInvite` (`group.ts:854-883`) *always* appends a role
  token, so `entriesAddedByInvite` is non-empty → GCE proposal → path. (The add proposal alone would
  not have been enough.)
- `removeMember` (`group.ts:1313-1320`) — a remove proposal → path.
- `joinGroupExternal` — external commit, `needsUpdatePath: true` unconditionally
  (`clientState.js:480`).

So in kumiai today, **every** commit rotates its author's leaf. The dependency is worth naming
because it is load-bearing and invisible: if a future caller ever hand-builds an `Invite` whose
`ledgerEntries` add nothing (making `enacted` empty), `commitInvite` would emit an **Add-only,
path-less** commit whose author's leaf key does *not* rotate. Nothing in the spec's phrasing
("every Commit") would warn them.

Recommended spec edit: *"every Commit that carries an UpdatePath — which, in this codebase, is every
commit, because each one carries a group-context-extensions proposal advancing the ledger head —
installs a fresh leaf HPKE key for its author."*

## The test

`packages/mls/test/leaf-key-rotation.test.ts` (new file; **no `src/` change**). It drives the real
repo API (`createGroup` / `createInvite` / `commitInvite` / `processWelcome` / `processMessage`), and
seals with the group's own HPKE — `group.context.cipherSuite.hpke.seal/open`, the ciphersuite impl
backed by `nobleCryptoProvider` (`packages/mls/src/crypto.ts:385-407`). No second HPKE was
introduced.

Setup: Alice (admin, leaf 0) + Bob (member, leaf 1) at epoch 1. Alice then commits (adds Carol) and
**never adopts** the returned handle — she keeps only her pre-commit one. Bob applies the commit, so
Bob's tree is the post-commit tree a responder would seal against.

**Test 1 — the committer (the case that breaks leaf-sealing):**

- half one: `leafPublicKey(bobGroup.state, 0)` (post-commit, as the *responder* sees it) `!==`
  Alice's pre-commit leaf public key;
- half two: seal a plaintext to that post-commit public key, then `hpke.open` it with Alice's
  **pre-commit private key** → **rejects**;
- soundness of the seal: the post-commit private key (the one Alice dropped) **does** open the same
  ciphertext, so the failure is the stale key, not a malformed seal;
- and Alice cannot replay her own commit to get that key back → rejects with `No overlap between
  provided private keys and update path`; her handle stays at epoch 1 with the old key.

**Test 2 — the negative control (the case leaf-sealing handles):** Bob commits nothing. Alice's
commit leaves Bob's leaf `encryption_key` **byte-identical** in the post-commit tree, and a seal made
to Bob's leaf *as the group sees it* opens with the private key Bob was already holding.

```
$ rtk proxy pnpm exec vitest run test/leaf-key-rotation.test.ts --reporter=verbose

 RUN  v4.1.10 /Users/paul/dev/yulsi/kumiai/packages/mls

 ✓ test/leaf-key-rotation.test.ts > leaf HPKE key rotation on commit > a commit rotates its author leaf HPKE key, stranding the pre-commit private key 116ms
 ✓ test/leaf-key-rotation.test.ts > leaf HPKE key rotation on commit > someone else commit leaves a non-committing member leaf HPKE key intact 62ms

 Test Files  1 passed (1)
      Tests  2 passed (2)
```

## Surprising, and worth carrying into 2.2

1. **A stale committer cannot even apply its own commit.** Not "it declines to" — ts-mls throws an
   `InternalError` (`applyUpdatePathSecret`, `createCommit.js:210-220`): the UpdatePath has no
   ciphertext the author can decrypt, because the author's subtree is excluded from every path
   secret's recipient set. A recovery design must not assume "just re-feed it the commit it sent".
   Its only route back into the group is a fresh leaf.
2. **The first rejection you hit is the wrong one.** Feeding the commit back to a handle that lacks a
   `resolveLedgerEntries` resolver fails at the *ledger policy* ("ledger entries could not be
   resolved") long before MLS gets a look. An earlier draft of this test "passed" for that shallow
   reason. The test now provisions the resolver so the throw it asserts is the genuine MLS one — a
   trap for anyone writing recovery tests against a resolver-less handle.
3. **`createCommit` is functional, so the stale handle stays fully usable at the old epoch.** It can
   still decrypt old-epoch traffic and will happily frame *another* commit at that epoch (the
   `group.ts` doc comments already warn about this). The stale committer is not inert — it is
   *silently* diverged, which is precisely the state `recover()` must rescue it from.

## Verify

```
$ rtk proxy pnpm run build
 Tasks:    7 successful, 7 total
Cached:    4 cached, 7 total
  Time:    1.312s

$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 168 files in 141ms. No fixes applied.

$ rtk proxy pnpm test
@kumiai/broadcast:test:unit:  Test Files  8 passed (8)      /  Tests  35 passed (35)
@kumiai/mls:test:unit:        Test Files  19 passed (19)    /  Tests  267 passed (267)
@kumiai/hub-protocol:test:unit: Test Files  1 passed (1)    /  Tests  8 passed (8)
@kumiai/hub-tunnel:test:unit: Test Files  20 passed (20)    /  Tests  63 passed (63)
@kumiai/hub-server:test:unit: Test Files  5 passed (5)      /  Tests  56 passed (56)
@kumiai/rpc:test:unit:        Test Files  16 passed (16)    /  Tests  68 passed (68)
@kumiai/hub-client:test:unit: Test Files  1 passed (1)      /  Tests  5 passed (5)

 Tasks:    27 successful, 27 total
```

**The known flake did appear, once, on the first full run**, exactly as the brief predicted:
`test/ledger.test.ts:175` — `await expect(verifyLedgerEntry(flipped)).resolves.toBeNull()` —
`1 failed | 266 passed (267)`. Per instructions it was not investigated. Re-run in isolation:

```
$ cd packages/mls && rtk proxy pnpm exec vitest run
 Test Files  19 passed (19)
      Tests  267 passed (267)

$ cd packages/mls && rtk proxy pnpm exec vitest run test/ledger.test.ts
 Test Files  1 passed (1)
      Tests  12 passed (12)
```

and the subsequent full `rtk proxy pnpm test` runs were green (27/27 tasks). It does not reproduce
outside parallel load and is unrelated to this probe (it touches signature verification, not the
tree).

## Files

- `/Users/paul/dev/yulsi/kumiai/packages/mls/test/leaf-key-rotation.test.ts` — new, the only change.
- Zero `src/` changes; nothing committed.
