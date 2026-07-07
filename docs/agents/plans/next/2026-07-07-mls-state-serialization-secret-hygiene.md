# Serialize `GroupHandle` state mutations + zero consumed secrets

**Priority:** 3 — the two real crypto-hygiene holes.
**Origin:** 2026-07-02 audit (commit `bb343d9`), milestone
`milestones/2026-07-audit-remediation.md`.

## Findings

### High (correctness)

- **`packages/mls/src/group.ts:264-272,284-318,329-362` — `GroupHandle` state races.**
  `encrypt`/`decrypt`/`processMessage` read `this.#state`, await ts-mls, then write back
  with no serialization. Interleaved encrypts reuse the same secret-tree generation;
  interleaved decrypts clobber each other's key-schedule deletions, weakening forward
  secrecy. Fix: serialize all state-mutating operations through an internal promise-chain
  mutex.

### Medium (security)

- **`packages/mls/src/group.ts:530-556,664-685` and `:299-362` — consumed secrets never
  zeroed.** ts-mls returns `consumed` secrets explicitly so callers can zero them, but
  `commitInvite`, `removeMember`, `decrypt`, and `processMessage` drop `result.consumed`
  unwiped; `encrypt` returns them without documenting the contract. Fix: zero consumed
  buffers internally after each ts-mls call.

### Related — fold in (same surface changes)

- **`packages/mls/src/group.ts:264` — `encrypt` returns `{ message: unknown; consumed }`**
  (pre-encode ts-mls object) while `commitInvite`/`removeMember`/`joinGroupExternal`
  return framed wire bytes, forcing callers to know ts-mls encoders. Fix: return framed
  `Uint8Array` like every other producer. Zeroing `consumed` internally changes `encrypt`'s
  return contract anyway — do both in one pass. (medium, API design)
- `packages/mls/src/group.ts:305-317` — `decrypt` applies a valid incoming commit (state
  mutated, epoch advances) then throws `'Expected application message...'` — caller sees
  failure, state changed anyway. Fix: reject without mutating, or return a discriminated
  result. (medium, correctness)

## Scope

`@kumiai/mls` (`group.ts`); consumers of `encrypt`'s return shape (`@kumiai/broadcast`
transport wrap/unwrap wiring).

## Test hooks

Concurrency tests for interleaved `encrypt`/`processMessage` on one `GroupHandle`, and
`decrypt` receiving a commit (the mutate-then-throw path) — see
`next/2026-07-07-test-gaps.md`.
