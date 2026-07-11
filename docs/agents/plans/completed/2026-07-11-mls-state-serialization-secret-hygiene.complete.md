# GroupHandle state serialization + secret hygiene — complete

**Status:** complete.
**Origin:** 2026-07-02 repo audit (commit `bb343d9`), milestone `../milestones/2026-07-audit-remediation.md`
Phase 1 item 3. Folded into `feat/mls-permission-enforcement` so the whole `@kumiai/mls` surface
settled in one release — see `2026-07-11-mls-permission-enforcement.complete.md`.

## Goal

Four related defects on `GroupHandle`'s state-mutating operations, all forward-secrecy or
correctness holes:

1. **State races.** `encrypt`, `decrypt`, and `processMessage` each did
   `read #state → await ts-mls → write #state` with no serialization. Two concurrent `encrypt`s
   both read epoch N, both advanced the secret-tree generation, and one clobbered the other —
   reusing a generation/nonce. Concrete, not theoretical.
2. **Retired secrets never zeroed.** ts-mls returns `consumed` buffers precisely so the caller can
   wipe them; they were dropped on the floor or handed to the caller unwiped.
3. **`encrypt`'s return shape** was a pre-encode ts-mls object, unlike every other producer.
4. **`decrypt` mutate-then-throw.** An accepted commit reaching `decrypt` advanced the group, then
   threw — the caller saw an error while the state had changed underneath it.

## What was built

- A **per-handle FIFO mutex**. Every async operation that reads-or-writes a handle's state —
  `encrypt`, `processMessage`, `applyLedgerEntries`, and the `commitInvite` / `removeMember` /
  `commitLedgerEntries` producers — runs its whole `read → await → write` body through one
  serializer per handle, held in a module-private `WeakMap`. Constructors are excluded (no prior
  state to protect).
- **`encrypt` returns framed wire `Uint8Array`**, like every other producer.
- **`decrypt` is deleted.** `processMessage` is the single receive path: plaintext bytes for an
  application message, `null` for an accepted handshake, `CommitRejectedError` for a rejected
  commit. The mutate-then-throw bug has no path left to exist on.
- **Retired `consumed` buffers are zeroed** on the state-advancing paths.

## Key design decisions (rationale preserved)

- **FIFO, not a priority queue.** Operations are never reordered: *when* a message is sent, at
  which epoch, is causally load-bearing in MLS.
- **Getters stay synchronous.** JS is single-threaded, so a getter reads the last fully-assigned
  state in one tick and can never observe a half-applied mutation. Queueing them would have forced
  them `async` — a large breaking change — for zero safety gain.
- **A rejection must not poison the queue.** The chain advances on both fulfilment and rejection,
  surfacing the real result to the actual caller while the next operation still runs.
- **The commit-producer path deliberately does *not* zero `consumed`.** This is the subtle one, and
  the first implementation got it wrong. The producers do not advance the source handle: they read
  its state and fork a *derived* handle, leaving the source live and reusable (the suite authors two
  alternate commits off one base). ts-mls's `createCommit` `consumed` alias into that still-live
  source secret tree — they are not retired — so zeroing them corrupts the source and the next
  commit off it fails with an AEAD tag error. There is no safe eager-wipe point on a fork, because
  the library never observes when the source handle is done; those secrets are collected with the
  handle. Zeroing is therefore applied *only* where `#state = newState` provably abandons the old
  state first.
- **The serializer is a standalone, dependency-free `Mutex`** rather than a promise chain inlined
  across the methods, so it can move to `@sozai/async` unchanged — see
  `../backlog/sozai-async-mutex-extraction.md`.

## Verification

Concurrency is proven against real behavior, not bookkeeping: two `encrypt`s fired without awaiting
between them both decrypt on the peer (the pre-fix code reuses a generation and one fails), and a
`processMessage` racing an `encrypt` on one handle asserts the ciphertext is framed at the
*post-commit* epoch — so the encrypt provably ran after the commit applied, not against a stale
snapshot concurrently read. Retired buffers are asserted zero via a captured reference to the real
ts-mls `consumed` array. Suite: 265 passing.

## Consumers

Breaks kubun's `plugin-p2p/src/groups/mls-codec.ts` a second time (`encrypt` → framed bytes,
`decrypt` → `processMessage`, whose `null` return means "an accepted handshake" and must be handled
rather than treated as plaintext). Bundled into the same release as the permission change so that
file migrates once; recorded in the kubun migration item.
