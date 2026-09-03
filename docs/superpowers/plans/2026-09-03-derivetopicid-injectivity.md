# deriveTopicID Injectivity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** planning
**Mode:** tasks

**Goal:** Make topic derivation injective by rejecting inputs that break the NUL-join and reserving the framework label namespace, without rotating any existing topic ID.

**Architecture:** Two layers. `@kumiai/broadcast`'s `deriveTopicID` validates its own inputs (NUL-free + well-formed UTF-16 components, non-negative safe-integer epoch) — structural injectivity of the join, label-agnostic. `@kumiai/rpc`'s `protocolTopic` adds the semantic policy: reject host protocol labels in the reserved `kumiai/` namespace, which is where the reserved-label topic kinds live. `discoveryTopic` (a separate single-component sha256) validates well-formedness only. All other helpers inherit validation through `deriveTopicID` unchanged.

**Tech Stack:** TypeScript (ES2025), vitest, biome, pnpm, turbo. `@noble/hashes` HKDF/SHA-256, `@sozai/codec` (`fromUTF`/`toB64U`).

**Spec:** `docs/superpowers/specs/2026-09-03-derivetopicid-injectivity-design.md`

## Global Constraints

- **Rejection only.** No re-encoding, no topic-ID rotation, no migration. Every valid input must produce byte-identical output to today — proven by golden regression pins.
- **`deriveTopicID` stays label-agnostic.** It validates NUL + well-formed UTF-16 on `label` and `scope`, and `epoch` as a non-negative safe integer. It must NOT know about reserved labels.
- **Reserved-namespace policy lives ONLY in `@kumiai/rpc`'s `protocolTopic`:** reject a `protocol` that begins with `kumiai/`. All reserved labels (`INBOX_LABEL`, `COMMIT_LABEL`, `RENDEZVOUS_LABEL`) start with that prefix.
- **`discoveryTopic` validates well-formedness only.** It MUST still accept a NUL-bearing `memberDID` — a single-component prefix is injective regardless of NUL, so rejecting NUL there would be a gratuitous break.
- **`inboxTopic`/`commitTopic`/`rendezvousTopic` get NO new code.** They inherit validation via `deriveTopicID`; reserved labels and epoch `0` pass unchanged.
- **`+0` and `-0` are the same epoch** (both encode to salt `0n`) and must NOT throw — not a collision.
- **Throw a plain `Error`** whose message names the offending component and the reason.
- Use `String.prototype.isWellFormed()` (lib `es2025` is enabled — confirmed in `@kigu/dev/tsconfig.json` and `packages/broadcast/tsconfig.json`).
- pnpm only. Do not edit generated `lib/`. Extend `@kigu/dev` configs; do not touch build/lint config.
- No plan/task labels in code, comments, or `describe`/`test` names — reference the durable concept.
- Verify tests by forcing turbo (`pnpm exec turbo run test --filter=<pkg> --force`, confirm `Cached: 0`). Lint via `rtk proxy pnpm run lint`.

---

### Task 1: `deriveTopicID` input validation (`@kumiai/broadcast`)

**Files:**
- Modify: `packages/broadcast/src/topic.ts`
- Test: `packages/broadcast/test/topic.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `deriveTopicID(secret, epoch, label, scope?)` — unchanged signature and unchanged output for valid inputs; now throws `Error` for a NUL or lone surrogate in `label`/`scope`, or an `epoch` that is not a non-negative safe integer.

- [ ] **Step 1: Capture the pre-change golden (regression baseline)**

Run against the current implementation and record the exact string:

```bash
cd /Users/paul/dev/yulsi/kumiai
pnpm exec turbo run build --filter=@kumiai/broadcast >/dev/null 2>&1
node -e "const {deriveTopicID}=require('./packages/broadcast/lib/topic.js');const {fromUTF}=require('@sozai/codec');console.log(deriveTopicID(fromUTF('test-group-secret-material'),1,'control'))"
```

Use the printed value as `GOLDEN_CONTROL` in Step 2. (If the module is ESM-only and `require` fails, use a scratch `.mjs` with `import`.)

- [ ] **Step 2: Write the failing tests**

Append to `packages/broadcast/test/topic.test.ts`, inside the existing `describe('deriveTopicID', …)`. Replace `GOLDEN_CONTROL` with the value captured in Step 1.

```ts
test('valid derivations are unchanged (no rotation)', () => {
  expect(deriveTopicID(secret, 1, 'control')).toBe('GOLDEN_CONTROL')
})

test('rejects a NUL in the label', () => {
  expect(() => deriveTopicID(secret, 1, 'a\0b')).toThrow(/label/)
})

test('rejects a NUL in the scope', () => {
  expect(() => deriveTopicID(secret, 1, 'sync', 'a\0b')).toThrow(/scope/)
})

test('rejects a lone surrogate in the label', () => {
  expect(() => deriveTopicID(secret, 1, '\uD800')).toThrow(/label/)
})

test('rejects a lone surrogate in the scope', () => {
  expect(() => deriveTopicID(secret, 1, 'sync', '\uDC00')).toThrow(/scope/)
})

test('rejects a negative epoch', () => {
  expect(() => deriveTopicID(secret, -1, 'control')).toThrow(/epoch/)
})

test('rejects a non-integer epoch', () => {
  expect(() => deriveTopicID(secret, 1.5, 'control')).toThrow(/epoch/)
})

test('rejects an unsafe-integer epoch', () => {
  expect(() => deriveTopicID(secret, 2 ** 53, 'control')).toThrow(/epoch/)
})

test('treats +0 and -0 as the same epoch', () => {
  expect(deriveTopicID(secret, -0, 'control')).toBe(deriveTopicID(secret, 0, 'control'))
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec turbo run test --filter=@kumiai/broadcast --force`
Expected: the eight new tests fail (no throw yet; the golden test may pass, which is fine).

- [ ] **Step 4: Add the validation to `deriveTopicID`**

In `packages/broadcast/src/topic.ts`, add two private helpers above `deriveTopicID` and call them first thing inside it. Keep comments terse.

```ts
function assertComponent(value: string, name: string): void {
  // NUL would forge the label/scope split; a lone surrogate collapses to U+FFFD under fromUTF
  // (TextEncoder), so two distinct strings would hash identically. Both break injectivity.
  if (value.includes('\0')) {
    throw new Error(`deriveTopicID: ${name} must not contain a NUL byte`)
  }
  if (!value.isWellFormed()) {
    throw new Error(`deriveTopicID: ${name} must be well-formed UTF-16 (no lone surrogates)`)
  }
}

function assertEpoch(epoch: number): void {
  // Safe-integer floor is the real limit: two epochs at/above 2**53 round to one float before
  // BigInt, and non-integer/negative epochs have no defined encoding. Subsumes the mod-2**64 wrap.
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error(`deriveTopicID: epoch must be a non-negative safe integer, got ${epoch}`)
  }
}
```

Then at the top of `deriveTopicID`'s body, before building `info`:

```ts
  assertEpoch(epoch)
  assertComponent(label, 'label')
  assertComponent(scope, 'scope')
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec turbo run test --filter=@kumiai/broadcast --force` (confirm `Cached: 0`)
Then types: `pnpm exec turbo run test:types build:types --filter=@kumiai/broadcast --force`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/broadcast/src/topic.ts packages/broadcast/test/topic.test.ts
git commit -m "feat(broadcast): validate deriveTopicID inputs for injectivity"
```

---

### Task 2: `protocolTopic` namespace reservation + `discoveryTopic` well-formedness (`@kumiai/rpc`)

**Files:**
- Modify: `packages/rpc/src/topic.ts`
- Test: `packages/rpc/test/topic.test.ts`

**Interfaces:**
- Consumes: `deriveTopicID` (now validating, from Task 1).
- Produces: `protocolTopic(secret, epoch, protocol, scope?)` — now throws if `protocol` begins with `kumiai/`; `discoveryTopic(memberDID)` — now throws on a lone surrogate, still accepts a NUL.

- [ ] **Step 1: Write the failing tests**

Append to `packages/rpc/test/topic.test.ts`, inside the existing `describe('topic derivation', …)`.

```ts
test('protocolTopic rejects the reserved kumiai/ namespace', () => {
  expect(() => protocolTopic(SECRET, 1, 'kumiai/inbox/v1', 'did:key:zABC')).toThrow(/reserved/)
  expect(() => protocolTopic(SECRET, 0, 'kumiai/commit/v1')).toThrow(/reserved/)
  expect(() => protocolTopic(SECRET, 0, 'kumiai/rendezvous/v1')).toThrow(/reserved/)
  expect(() => protocolTopic(SECRET, 1, 'kumiai/anything')).toThrow(/reserved/)
})

test('protocolTopic still accepts ordinary host protocols unchanged', () => {
  expect(protocolTopic(SECRET, 1, 'chat')).toBe(deriveTopicID(SECRET, 1, 'chat'))
  expect(protocolTopic(SECRET, 1, 'sync', 'roomA')).toBe(deriveTopicID(SECRET, 1, 'sync', 'roomA'))
})

test('inboxTopic rejects a NUL-bearing or lone-surrogate DID (via deriveTopicID)', () => {
  expect(() => inboxTopic(SECRET, 1, 'did:key:z\0evil')).toThrow(/scope/)
  expect(() => inboxTopic(SECRET, 1, 'did:key:z\uD800')).toThrow(/scope/)
})

test('discoveryTopic rejects a lone-surrogate DID but accepts a NUL', () => {
  expect(() => discoveryTopic('did:key:z\uD800')).toThrow(/memberDID/)
  // Single-component prefix is injective regardless of NUL, so a NUL DID is accepted.
  const t = discoveryTopic('did:key:z\0x')
  expect(typeof t).toBe('string')
  expect(t).not.toBe(discoveryTopic('did:key:zx'))
})

test('deriveTopicID can intentionally reproduce a reserved rpc tuple (layering boundary)', () => {
  // The reservation lives in protocolTopic, not the label-agnostic primitive: the helpers, not
  // deriveTopicID, carry domain separation. This documents that boundary; it is not a guard.
  expect(deriveTopicID(SECRET, 1, INBOX_LABEL, 'did:key:zABC')).toBe(
    inboxTopic(SECRET, 1, 'did:key:zABC'),
  )
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec turbo run test --filter=@kumiai/rpc --force`
Expected: the reserved-namespace and discovery-surrogate tests fail (no throw yet). The inbox tests already pass if Task 1 is merged — that is expected and fine.

- [ ] **Step 3: Add the reservation and the discovery guard**

In `packages/rpc/src/topic.ts`:

Add a constant beside the reserved labels:

```ts
/** Framework label namespace. Host protocols may not derive topics under it — see {@link protocolTopic}. */
const RESERVED_LABEL_PREFIX = 'kumiai/'
```

In `protocolTopic`, before the `deriveTopicID` call:

```ts
  if (protocol.startsWith(RESERVED_LABEL_PREFIX)) {
    throw new Error(
      `protocolTopic: protocol must not use the reserved "${RESERVED_LABEL_PREFIX}" namespace`,
    )
  }
```

In `discoveryTopic`, before the `sha256` call:

```ts
  if (!memberDID.isWellFormed()) {
    throw new Error('discoveryTopic: memberDID must be well-formed UTF-16 (no lone surrogates)')
  }
```

Update the now-accurate `inboxTopic` doc-comment: replace the unenforced claim that the reserved label "never collides with an application protocol of the same name" with a pointer that `protocolTopic` enforces the separation by rejecting the `kumiai/` namespace.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec turbo run test --filter=@kumiai/rpc --force` (confirm `Cached: 0`)
Then types: `pnpm exec turbo run test:types build:types --filter=@kumiai/rpc --force`
Expected: all pass, including the pre-existing suite.

- [ ] **Step 5: Commit**

```bash
git add packages/rpc/src/topic.ts packages/rpc/test/topic.test.ts
git commit -m "feat(rpc): reserve the kumiai/ label namespace and validate discovery DIDs"
```

---

### Task 3: peer-path reachability tests (`@kumiai/rpc`)

Proves the guards sit on the real call paths a host reaches — `createGroupPeer` deriving `inboxTopic(localDID)` at init, and `.to(memberDID)` — not only the standalone helpers.

**Files:**
- Test: `packages/rpc/test/topic-reachability.test.ts` (create)

**Interfaces:**
- Consumes: `createGroupPeer` (`packages/rpc/src/peer.ts`) and the test fixtures used by `packages/rpc/test/peer-app-topic.test.ts` (`FakeHub`, `createFakeCrypto`, `createMemoryGroupMLS`, `createMemoryAnchorStore`, `createMemoryAppCursorStore`, `createMemoryCommitJournal`, `defineGroupProtocol`).

- [ ] **Step 1: Write the failing tests**

Create `packages/rpc/test/topic-reachability.test.ts`. Build the peer exactly as `peer-app-topic.test.ts` does (copy its `makeRoomPeer`-style wiring for a single member — the same `FakeHub`, `createFakeCrypto`, `createMemoryGroupMLS`, and the three memory stores, with `defineGroupProtocol({ 'room/posted': { type: 'event', retain: 'log', data: { type: 'object' } } })`). Two cases:

```ts
test('createGroupPeer rejects a malformed localDID at init', async () => {
  // A NUL-bearing localDID reaches inboxTopic during initialization (peer.ts derives the
  // member's own inbox from it). The derivation now throws, surfacing on the ready path.
  await expect(startPeerWithLocalDID('did:key:z\0evil')).rejects.toThrow()
})

test('.to() rejects a malformed target DID', async () => {
  const peer = await startPeerWithLocalDID('did:key:zalice')
  expect(() => peer.protocols.room.to('did:key:z\uD800')).toThrow()
})
```

Implement `startPeerWithLocalDID` as the local harness helper that constructs and starts one peer with the given `localDID` and returns it (mirroring `makeRoomPeer` + the ready/adopt step in `peer-app-topic.test.ts`). Match the real surface shape for `.to()` — confirm against `peer.ts` whether the malformed-DID throw is synchronous or surfaces via the returned handle, and assert accordingly (`toThrow` vs `rejects.toThrow`).

- [ ] **Step 2: Run the tests to verify they fail (or confirm they already pass)**

Run: `pnpm exec turbo run test --filter=@kumiai/rpc --force`
Expected: with Tasks 1–2 merged the guards already throw, so these may pass immediately — that is the point (they prove reachability). If a case does NOT throw, the guard is not on that path: investigate before proceeding.

- [ ] **Step 3: Run types**

Run: `pnpm exec turbo run test:types build:types --filter=@kumiai/rpc --force`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add packages/rpc/test/topic-reachability.test.ts
git commit -m "test(rpc): topic-guard reachability on the peer init and directed paths"
```

---

## Final verification

- [ ] Full forced suite green across affected packages: `pnpm exec turbo run test test:types build:types --filter=@kumiai/broadcast --filter=@kumiai/rpc --force` (confirm `Cached: 0`).
- [ ] Lint clean: `rtk proxy pnpm run lint`.
- [ ] Confirm no topic ID rotated: the golden pins in Tasks 1–2 pass, and the pre-existing topic suites are unchanged.
