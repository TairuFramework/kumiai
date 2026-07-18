# Probe report — the app lane delivers over real MLS

**Status: DONE.** Both skipped integration scenarios are un-skipped and pass over the real
`hub-server` on the real Enkaku wire, real `@kumiai/mls` handles, and the real
`GroupCrypto`/`GroupMLS` from `@kumiai/mls-rpc`. Neither was rewritten to expect less; the only
change to either is a comment and one line in the restart scenario (below).

All work is uncommitted.

---

## Defect A — every inbound frame was unwrapped twice

`peer.ts` built two `segmentBoundTransport(name, topicID)` instances on one protocol topic, each
registering its own `mux.onInbound` listener and each calling `crypto.unwrap`. On a real handle the
first open spends the frame's per-message ratchet key and the second gets `Desired gen in the past`,
so whichever transport lost the race dropped the frame — and the handler was on the losing one.

**Fixed as approved: one inbound path per topic.** `createInboundPath(name, topicID)` subscribes to
the mux once, takes the log-position note, opens the frame ONCE, and fans the opened
`UnwrapResult` out to every registered consumer. Each transport's own `unwrap` is now a pure lookup
of that result (`openedFrames`, a `WeakMap` keyed by the plaintext). The mux subscription is
refcounted and released with the last consumer, so a rotation's teardown leaves no listener behind.

The invariant is stated where the path is built: **opening is a consuming operation on the real
port and therefore cannot be duplicated.**

### The assertion (requirement 3)

`packages/rpc/test/peer-app-single-open.test.ts` — one published frame, counted at the port:

```
$ pnpm exec vitest run test/peer-app-single-open.test.ts   # second transport's unwrap restored
PASS (0) FAIL (1)

1. the app lane opens each live frame once one published frame costs the receiver exactly one unwrap
   AssertionError: expected [ 79, 79 ] to have a length of 1 but got 2
       at /Users/paul/dev/yulsi/kumiai/packages/rpc/test/peer-app-single-open.test.ts:51:19
```

Two opens of the same 79 bytes. With the fix restored:

```
$ pnpm exec vitest run test/peer-app-single-open.test.ts
PASS (1) FAIL (0)
```

That is mutation check 5a: the inversion was made by hand (restore
`mux.onInbound` + `unwrap: crypto.unwrap` on the transport) and inverted back by hand.

---

## Defect B — entries were opened inside the apply

`peer.ts` passed `createLedgerEntryResolver(commitFrame.sealedEntries, crypto.unwrap)` into
`port.processCommit`, so the port opened the blob with the handle it was mid-apply on.

**Fixed as approved: entry blobs are no longer MLS application messages.** They are sealed under a
key derived from the epoch's exporter secret.

### Port surface — a purpose-named entry seal, argued

`GroupCrypto` gains `sealEntries(bytes)` / `openEntries(sealed)` rather than a generic
derive-and-seal, for two reasons:

- A generic `deriveSecret(label)` would hand group-rpc raw key material and make it the
  cryptographic implementer — choosing the AEAD, the nonce policy, the blob layout — for a key it
  must not hold. `wrap`/`unwrap` already establish that sealing lives *behind* the port; this
  follows that line rather than crossing it.
- The name carries the contract. `openEntries` is documented as pure and per-epoch because the one
  caller opens it from inside an apply; a generic seal would have to state that constraint
  nowhere in particular, and the next consumer would reach for it with a ratchet-backed handle.

The two seals are deliberately not interchangeable, and the `GroupCrypto` doc now says so.

### The real implementation (`packages/mls-rpc/src/crypto.ts`)

Key: `handle().exportSecret('kumiai/ledger-entries/v1', <empty>, 32)` — a different label from the
app-topic secret, required rather than tidy: sharing one export between a topic *name* and a
*key* would make every holder of the name a reader of the bodies. Blob:
`[nonce(24)][XChaCha20-Poly1305 ciphertext+tag]`, nonce random per seal (two members can frame a
commit at the same epoch, so the key alone does not bound how many blobs it seals).

`exportSecret` does not take the handle mutex and consumes no ratchet key, so `openEntries` is
re-entrant by construction — the deadlock the earlier probe found does not have to be scheduled
around, it stops existing.

The load-bearing apply-time argument is stated in `GroupCrypto.sealEntries` and again at the peer's
call site: **a Commit is applied at the epoch it is framed at, and its author sealed the blob at
that same epoch, so the applying peer always holds the right secret — including a returning member
replaying commits in order, which reaches each commit at its own framed epoch.**

### The three properties (requirement 4)

`packages/mls-rpc/test/crypto.test.ts`, against real MLS:

- *is PER-EPOCH*: a removed member at epoch 1 opens the epoch-1 blob and is refused the epoch-2
  one; the handle that ratcheted forward is refused the epoch-1 one too.
- *is AGREED*: alice opens what bob sealed and bob opens what alice sealed, at the same epoch,
  with nothing exchanged.
- *is PURE*: opening twice gives the same bytes, and an application frame sealed afterwards still
  opens — nothing on the ratchet was spent.

Mutation check 5b — entry key made epoch-independent
(`const key = new Uint8Array(32).fill(0x11)` in both `sealEntries` and `openEntries`):

```
PASS (9) FAIL (1)

1. createGroupCrypto the ledger-entry seal is PER-EPOCH: a member at another epoch cannot open the blob
   Error: promise resolved "Uint8Array[ 101, 110, 116, 114, …(-90) ]" instead of rejecting
       at /Users/paul/dev/yulsi/kumiai/packages/mls-rpc/test/crypto.test.ts:171:49
```

Inverted back by hand; 10/10 green.

### The format change — what happens to old blobs

Asked rather than assumed. Two places could hold one:

- **The commit journal does NOT.** `JournalEntry` persists the commit bytes, the *plaintext*
  bodies and the framed epoch; `replayJournal` calls `frameCommit` again, so a journalled commit
  is re-sealed in the new format on replay. Nothing to migrate.
- **The hub's commit-topic log DOES.** Frames published by an older build carry an
  application-message blob. A new build calls `openEntries` on it, the AEAD refuses, the resolver
  answers `[]`, the port raises missing-entries, and the lane files the frame as POISON: cursor
  advances, never re-read, no heal, no crash. So a mixed-version group does not wedge — but **an
  old-format commit that named ledger entries never has those entries enacted by a new-build
  peer**, and vice versa (an old build meets a derived-key blob and reads it the same way). Commits
  carrying no entries (invites, removes) are unaffected: the port never asks for bodies, so the
  blob is never touched. Pre-1.0 with no deployed groups, this is a non-event; it is not
  self-healing, and a live group would need its commit-log retention to lapse across the upgrade.

---

## Also fixed

The rpc fake crypto's `unwrap` doc claimed it was **"STRICTER THAN REAL MLS, deliberately"** with a
four-epoch safety margin beneath it. It is not: the real port opens strictly at the current epoch
too, because `GroupHandle.decrypt` delegates to ts-mls's `processMessage`, which resolves against
the current epoch's secret tree alone. The comment now states parity and says there is no margin
underneath. `docs/agents/architecture.md`'s ts-mls retention note carried the same claim and is
corrected the same way — the window exists in ts-mls and is simply not reachable through this port.

---

## One harness gap found, and fixed in `tests/integration/`

The restart scenario was still red after both defects were fixed, and not for a reason either
caused. `hub-server` binds **one receive writer per DID** and refuses a second
(`receive writer already bound for DID …`). The harness modelled a process death as
`peer.dispose()` alone, leaving the dead process's socket up, so the restarted peer's `hub/receive`
was refused, its backlog arrived by pull, and **it then silently received nothing live**. The hub is
right to refuse; the harness was wrong to keep the connection.

`WireHub.connect` now returns a `WireConnection` with `disconnect()`, `Member` exposes it, and the
restart scenario drops the connection with the process. That is the only line added to the scenario;
no assertion was touched.

Worth noting on its own terms: **a real host that reconnects without the old channel being torn
down gets no push lane and no error** — the rejection lands on a channel promise nobody awaits.
That is hub/host territory, out of scope here, and reported rather than fixed.

---

## Verification (real output)

```
$ pnpm run build
 Tasks:    9 successful, 9 total

$ rtk proxy pnpm run lint
Checked 247 files in 168ms. No fixes applied.

$ pnpm exec turbo run test:types test:unit --force
@kumiai/hub-protocol:test:unit:       Tests  8 passed (8)
@kumiai/broadcast:test:unit:          Tests  35 passed (35)
@kumiai/hub-tunnel:test:unit:         Tests  69 passed (69)
@kumiai/hub-server:test:unit:         Tests  80 passed (80)
@kumiai/hub-client:test:unit:         Tests  5 passed (5)
@kumiai/mls-rpc:test:unit:            Tests  10 passed (10)
@kumiai/mls:test:unit:                Tests  317 passed (317)
@kumiai/rpc:test:unit:                Tests  279 passed (279)
 Tasks:    36 successful, 36 total

$ cd tests/integration && pnpm exec vitest run
PASS (27) FAIL (0)
```

Integration 25 passing + 2 skipped → **27 passing, nothing skipped**. rpc 277 → 279 (the unwrap
count, and a resolver-called-twice case). mls-rpc 7 → 10 (the three seal properties). mls unchanged
at 317. No existing test was weakened.

---

## Concerns

- **The drain and the live lane now both work, so the ordering between them is exercised for the
  first time — and only lightly.** The restart scenario covers pull-then-resume-live once. The
  seed-pull/drain interleave under a rotation, and a mid-walk restart, still rest on the fake.
- **`@noble/ciphers` and `@sozai/runtime` are new dependencies of `@kumiai/mls-rpc`.** The AEAD
  choice (XChaCha20-Poly1305, random 24-byte nonce) is mine and is not tied to the group's
  ciphersuite. A group negotiating a different suite still seals entries with this one. Defensible
  — the key comes from the negotiated exporter — but it is a second cipher in the stack and worth a
  reviewer's eye.
- **`ENTRY_SEAL_LABEL` is now protocol.** Two members disagreeing on it cannot apply each other's
  entry-carrying commits, and the failure presents as poison rather than as a version mismatch.
- The five unexercised `@kumiai/mls-rpc` recovery methods are still unexercised; nothing in this
  probe stranded a peer.
- The mailbox/ephemeral live path and the directed-inbox acceptor still call `crypto.unwrap`
  directly. The acceptor is on its own topic and unwraps each frame once, so it is correct today —
  but the single-open invariant lives in `peer.ts`'s app-lane path only, and a third consumer added
  to a protocol topic without going through `createInboundPath` would reintroduce Defect A.
