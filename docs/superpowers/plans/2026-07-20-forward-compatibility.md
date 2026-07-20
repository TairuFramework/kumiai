# Forward Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the forward-compatibility mechanisms that only work if they exist in the code running *before* the code that needs them — version discriminants old readers already respect, an MLS extension type every leaf already advertises, and port signatures whose later widening would otherwise type-check while implementations ignored it.

**Architecture:** Eight independent changes across six packages. Most are small; the risk is in the two that change how an unreadable frame is treated (Task 3) and the one that removes a trusted-but-forgeable identity from the wire (Task 6). No enforcement logic lands here — surfaces and discriminants only.

**Tech Stack:** TypeScript, pnpm, turbo, vitest, biome, changesets.

**Spec:** `docs/superpowers/specs/2026-07-20-forward-compatibility-design.md` — read it for *why*; this plan carries *what*.

## Global Constraints

- Lands on the current branch `feat/app-lane-delivery` (PR #7). Do not create a new branch.
- **Never run `git checkout`, `git restore`, or `git stash` on a file with uncommitted work.** That has destroyed work on this branch twice. To revert an edit, invert it by hand.
- `pnpm run <script>` is intercepted by an `rtk` shim on this machine. Use `pnpm exec ...` directly; for lint use `rtk proxy pnpm run lint` — plain `pnpm run lint` and `pnpm exec biome` both report nothing useful here.
- `pnpm test -- --force` is broken. The repo gate is `pnpm exec turbo run test:types test:unit --force` — confirm `Cached: 0`, since a nonzero `Cached:` means the run was replayed and proved nothing.
- Integration suite: `pnpm exec vitest run --root tests/integration` (currently 32 passing).
- Conventions: `type` not `interface`, `Array<T>` not `T[]`, never `any`, capital `ID`/`HTTP`/`JWT`, ES `#fields` never `private`/`readonly`. Do not edit generated `lib/` output.
- All packages are 0.x, so `minor` is the breaking bump in changesets. Never `major`.
- **Nothing persistent needs to survive these changes** — dev/test groups only, recreated at will. This is the ruling that makes hard cutover acceptable throughout. If it turns out false, stop and escalate.
- Every version byte added is `1`, and every unknown version is **rejected distinguishably** — never silently mis-parsed. Task 3 is the one exception to what "rejected" means; see it.

## File Structure

| File | Change | Task |
| --- | --- | --- |
| `packages/mls/src/anchor.ts` | Reserve + advertise `0xf102` | 1 |
| `packages/mls/src/policy.ts` | Permit installing a reserved type | 1 |
| `packages/mls/src/codec.ts` | Client-state version byte | 2 |
| `packages/mls/src/credential.ts` | Credential-identity `v` field | 2 |
| `packages/rpc/src/handshake.ts` | `decodeHandshakeFrame` returns version | 3 |
| `packages/rpc/src/peer.ts`, `classify.ts` | Unknown version on commit topic ⇒ heal | 3 |
| `packages/rpc/src/commit-frame.ts`, `ledger-entries.ts` | Version bytes | 3 |
| `packages/rpc/src/crypto.ts` (port), `packages/mls-rpc/src/crypto.ts`, `packages/rpc-conformance/` | `exportSecret(label, length?)` | 4 |
| `packages/rpc/src/crypto.ts` (port), `packages/broadcast/src/transport.ts`, `packages/mls-rpc/src/crypto.ts` | `wrap`/`unwrap` context + required sender | 5 |
| `packages/broadcast/src/{client,responder,event-frame}.ts`, `packages/rpc/src/bus-server.ts` | Reply identity + wire version | 6 |
| `packages/hub-server/src/handlers.ts` | `AuthorizeHook` reshape | 7 |
| `packages/hub-protocol/src/protocol.ts` + consumers | `hub/v1/*` rename | 8 |

Tasks 1–3 are self-contained per package. Tasks 4–5 change consumer ports, so they touch `rpc`, `mls-rpc`, and `rpc-conformance` together — a port change that does not update the conformance suite is not done. Tasks 6–8 are independent of each other.

**Order matters only in one place:** Task 5 changes `UnwrapResult`, which Task 6 consumes. Do 5 before 6.

---

### Task 1: Reserve the third GroupContext extension type

**Files:**
- Modify: `packages/mls/src/anchor.ts:19` (add constant), `:106` (`controlCapabilities`)
- Modify: `packages/mls/src/policy.ts:92-125` (group-context-extensions proposal rule)
- Test: `packages/mls/test/policy.test.ts`, `packages/mls/test/anchor.test.ts`

**Interfaces:**
- Produces: `RESERVED_EXTENSION_TYPE = 0xf102` exported from `packages/mls/src/anchor.ts`, advertised by `controlCapabilities()`.

**Why both halves or neither:** reserving the type without the policy rule passes a naive test and is worthless — `policy.ts` pins the extension list positionally, so a commit *installing* the reserved type is rejected by every peer. Read the spec's A3 before starting.

- [ ] **Step 1: Write the failing test — installing a reserved-but-empty extension is accepted**

In `packages/mls/test/policy.test.ts`, following the existing group-context-extensions cases. Model the new test on whichever existing test builds a group-context-extensions proposal; reuse that file's helpers rather than inventing new ones.

The assertion: a proposal whose extension list equals the current list **plus** an entry of type `0xf102` with empty data is accepted (`'accept'`). A proposal adding any *unreserved* type is still rejected, and that second half must be in the same test file — the rule must permit exactly one new thing, not open the gate.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /Users/paul/dev/yulsi/kumiai/packages/mls && pnpm exec vitest run test/policy.test.ts
```

Expected: FAIL — today's positional pin rejects any list that is not equal to the current one.

- [ ] **Step 3: Reserve and advertise the type**

`packages/mls/src/anchor.ts`, after `LEDGER_HEAD_EXTENSION_TYPE` at `:19`:

```ts
/**
 * Reserved for a future control extension, carrying no data today.
 *
 * Reserved and advertised BEFORE it carries anything, for the same reason
 * {@link LEDGER_HEAD_EXTENSION_TYPE} was: RFC 9420 requires every member leaf to advertise
 * each custom GroupContext extension type, and leaves cannot be rewritten. A type introduced
 * after members have joined cannot be installed in their group at all — the only remedy is
 * re-admitting every member. Reserving costs one line now and is unavailable forever after.
 */
export const RESERVED_EXTENSION_TYPE = 0xf102
```

And in `controlCapabilities()` at `:106`, alongside the existing two:

```ts
  extensions.add(RESERVED_EXTENSION_TYPE)
```

- [ ] **Step 4: Permit installing a reserved type in the commit policy**

`packages/mls/src/policy.ts:92-125`. The existing rule requires the proposed extension list to equal the current one, with only `ledger_head` permitted to differ. Widen it so an entry whose type is `RESERVED_EXTENSION_TYPE` may be **added** when it carries empty data, leaving every other difference rejected exactly as today.

Do not relax the rule further. The fail-closed posture on unknown extension types is deliberate and is not what this task changes — read the surrounding doc comment before editing and keep its voice.

- [ ] **Step 5: Run the test and confirm it passes**

```bash
cd /Users/paul/dev/yulsi/kumiai/packages/mls && pnpm exec vitest run test/policy.test.ts
```

Expected: PASS, including the still-rejected unreserved-type case.

- [ ] **Step 6: Run the mls suite**

```bash
cd /Users/paul/dev/yulsi/kumiai/packages/mls && pnpm exec vitest run
```

Expected: PASS. A red test here means the policy widening caught more than intended — narrow it, do not adjust the test.

- [ ] **Step 7: Commit**

```bash
cd /Users/paul/dev/yulsi/kumiai
git add packages/mls
git commit -m "feat(mls)!: reserve and advertise a third control extension type"
```

---

### Task 2: Version the client-state and credential-identity formats

**Files:**
- Modify: `packages/mls/src/codec.ts:12-18`
- Modify: `packages/mls/src/credential.ts:20` and its parse path
- Test: `packages/mls/test/codec.test.ts`, `packages/mls/test/credential.test.ts`

**Interfaces:**
- Produces: `encodeClientState` output gains a leading version byte `1`; `decodeClientState` returns `undefined` for an unknown version, distinguishably from a decode failure. `MLSCredentialIdentity` gains `v?: 1`; absent reads as `1` permanently.

- [ ] **Step 1: Write the failing tests**

Two, in their respective files:

- `codec.test.ts`: a round trip still works, **and** a blob whose first byte is `2` is refused — not silently mis-parsed. Assert on the distinguishable outcome, not merely on falsiness.
- `credential.test.ts`: an identity encoded today parses; an identity JSON with no `v` still parses as v1 (this is the permanent tolerance rule — old leaves cannot be rewritten); an identity with `v: 2` is refused.

- [ ] **Step 2: Run both and confirm they fail**

```bash
cd /Users/paul/dev/yulsi/kumiai/packages/mls && pnpm exec vitest run test/codec.test.ts test/credential.test.ts
```

Expected: FAIL on the version cases; the round-trip cases should already pass.

- [ ] **Step 3: Add the client-state version byte**

`packages/mls/src/codec.ts`. Prepend a version byte on encode; on decode, read it, and **throw a descriptive error** for anything other than `1`. Other decode failures (malformed or truncated bytes) keep returning `undefined`.

Follow the pattern already established at `packages/mls-rpc/src/crypto.ts:144-152` — read its comment first, since it argues this exact case ("it buys diagnosis, not compatibility") and this code should say the same thing the same way. That pattern throws `` `openEntries: unsupported blob version ${sealed[0]}` ``; returning a bare `undefined` here would be indistinguishable from any other decode failure, since `ts-mls`'s `decode<T>()` is itself typed `T | undefined`.

> **Corrected mid-execution.** This step originally said "return `undefined` for anything other than `1`", which contradicted the Global Constraint that an unknown version be rejected distinguishably and never merely falsy. Task 2's review caught it; the human ruled that the constraint governs.

- [ ] **Step 4: Add the credential-identity version field**

`packages/mls/src/credential.ts`. `MLSCredentialIdentity` gains `v?: 1`. `makeMLSCredential` writes `v: 1`. The parser treats **absent `v` as 1** and refuses any other value.

The tolerance is not a courtesy — it is mandatory. A credential identity is baked into a leaf and covered by its signature, so identities written before this change exist in leaves that can never be rewritten.

- [ ] **Step 5: Run both tests and confirm they pass**

```bash
cd /Users/paul/dev/yulsi/kumiai/packages/mls && pnpm exec vitest run test/codec.test.ts test/credential.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the mls suite and the repo gate**

```bash
cd /Users/paul/dev/yulsi/kumiai/packages/mls && pnpm exec vitest run
cd /Users/paul/dev/yulsi/kumiai && pnpm exec turbo run test:types test:unit --force
```

Expected: all pass, `Cached: 0`.

- [ ] **Step 7: Commit**

```bash
cd /Users/paul/dev/yulsi/kumiai
git add packages/mls
git commit -m "feat(mls)!: version the client-state and credential-identity formats"
```

---

### Task 3: Make the handshake version usable, and version the two rpc payloads

The highest-risk task in the plan. Read the spec's A2 and A4 before starting.

**Files:**
- Modify: `packages/rpc/src/handshake.ts:70-90` (`decodeHandshakeFrame`), `:31` (the `HANDSHAKE_VERSION` doc)
- Modify: `packages/rpc/src/peer.ts` around `:1667-1673` (the commit-lane decode)
- Modify: `packages/rpc/src/classify.ts` if a new disposition input is needed
- Modify: `packages/rpc/src/commit-frame.ts:30,43`, `packages/rpc/src/ledger-entries.ts:21,37`
- Test: `packages/rpc/test/handshake.test.ts`, `packages/rpc/test/commit-frame.test.ts`, `packages/rpc/test/ledger-entries.test.ts`, plus a new lane-level test

**Interfaces:**
- Produces: `decodeHandshakeFrame` returns the frame's version rather than throwing on an unknown one. Commit-lane treatment of an unknown-version frame on the commit topic becomes **heal**, not poison. `encodeCommitFrame` and `encodeLedgerEntries` gain leading version bytes.

**The crux, stated precisely because the existing doc gets it half right.** `handshake.ts:25-31` argues that a format change belongs inside a payload, where an old peer "fails the OPEN — which it already survives, by filing the commit as poison and healing from the next frame." That reasoning holds only while *some* frames remain readable. After a version bump **every** frame is unreadable, so there is never a next frame to heal from: the peer files the group's entire future as poison, drains to the end of the log, and reports itself fully reconciled at a dead epoch. That is why the rule has to change, and why it has to change in the code shipping now.

**The safety argument for healing instead.** An attacker forging an unknown-version frame can only *trigger* a heal, never suppress one — the same asymmetry `classify.ts` already documents for the `ahead` row on a cleartext epoch. Treating an unreadable frame as poison is the dangerous direction; treating it as "the group moved on" is not.

- [ ] **Step 1: Write the failing lane-level test**

The important one, and it must be lane-level rather than a unit test of the decoder: a peer that meets a frame with an unrecognised handshake version **on the commit topic** heals, rather than advancing its cursor past it and reporting itself reconciled.

Put it beside the existing commit-lane tests (`packages/rpc/test/peer-cursor-table.test.ts` and `peer-failed-heal-strand.test.ts` show the shape). Assert on the heal actually happening — a responder being asked, or the epoch moving — not merely on the absence of an error. Assert also that the cursor did **not** silently advance past the frame as poison.

- [ ] **Step 2: Run it and confirm it fails for the right reason**

```bash
cd /Users/paul/dev/yulsi/kumiai/packages/rpc && pnpm exec vitest run test/<your-new-file>.test.ts
```

Expected: FAIL, with the peer having stepped over the frame and reported itself reconciled. Confirm that is the observed failure — if it fails some other way, the test is not yet reproducing the defect.

- [ ] **Step 3: Return the version from `decodeHandshakeFrame`**

`packages/rpc/src/handshake.ts:75-90`. Keep throwing on a short frame, a bad magic, and an unknown *kind* — those are genuinely not this protocol. Stop throwing on an unknown **version**: return it, so the caller can decide.

Update the `HANDSHAKE_VERSION` doc at `:25-31`. It currently forbids ever bumping the constant and explains why; that prohibition is what this task lifts, so the comment must now describe the new rule instead — an old peer meeting a newer version heals rather than filing poison. Leave the "put format changes inside the payload" guidance, which is still good advice.

- [ ] **Step 4: Route an unknown version to heal on the commit lane**

`packages/rpc/src/peer.ts` around `:1667-1673`, where the decode is caught and the cursor advanced. An unknown-version frame on the **commit topic** must reach the classifier as evidence the group moved on, taking the same path as `ahead`.

Scope this narrowly to the commit lane. An unreadable frame on another lane is not evidence of anything and keeps its current treatment.

- [ ] **Step 5: Run the lane test and confirm it passes**

```bash
cd /Users/paul/dev/yulsi/kumiai/packages/rpc && pnpm exec vitest run test/<your-new-file>.test.ts
```

Expected: PASS.

- [ ] **Step 6: Version the commit frame and the ledger-entries blob**

`packages/rpc/src/commit-frame.ts` — prepend a version byte to `encodeCommitFrame`; `decodeCommitFrame` rejects an unknown one. This is the format whose current failure mode is the worst in the repo: a v2 frame decodes v1-*successfully*, with any new section silently swallowed into `sealedEntries`.

`packages/rpc/src/ledger-entries.ts` — the same, for `encodeLedgerEntries`/`decodeLedgerEntries`.

Add a unit test per format asserting an unknown version is refused distinguishably.

- [ ] **Step 7: Run the rpc suite**

```bash
cd /Users/paul/dev/yulsi/kumiai/packages/rpc && pnpm exec vitest run
```

Expected: PASS. Several tests construct frames directly; those need the new byte. A test that fails because it hand-built a frame is a fixture to update. A test that fails on lane *behaviour* is a real finding — report it rather than adjusting it.

- [ ] **Step 8: Repo gate and integration**

```bash
cd /Users/paul/dev/yulsi/kumiai && pnpm exec turbo run test:types test:unit --force && pnpm exec vitest run --root tests/integration
```

Expected: all pass, `Cached: 0`, integration 32.

- [ ] **Step 9: Commit**

```bash
cd /Users/paul/dev/yulsi/kumiai
git add packages/rpc
git commit -m "feat(rpc)!: heal on an unknown frame version, and version the commit and entry payloads"
```

---

### Task 4: `GroupCrypto.exportSecret` takes a label

**Files:**
- Modify: `packages/rpc/src/crypto.ts:36` (the port)
- Modify: `packages/mls-rpc/src/crypto.ts:126` (the implementation)
- Modify: `packages/rpc-conformance/src/group-crypto.ts` (the structural port copy and its clauses)
- Modify: every caller in `packages/rpc/src/` and both fakes (`packages/rpc/test/fixtures/fake-crypto.ts`)

**Interfaces:**
- Produces: `exportSecret(label: string, length?: number): Uint8Array | Promise<Uint8Array>` on `GroupCrypto`. `label` is **required**.

**Why required.** An optional `label` type-checks against every existing implementation, and those implementations ignore it — returning identical bytes for every label. That is silent cross-domain key reuse in the one method whose plan doc already calls its failure mode silent. Required is the only shape that fails loudly.

- [ ] **Step 1: Write the failing conformance clause**

In `packages/rpc-conformance/src/group-crypto.ts`, beside the existing per-epoch clause: **two different labels at the same epoch derive different secrets.** This is the property the signature exists to provide, and it is the one a lazy implementation would violate.

- [ ] **Step 2: Run conformance against both sides and confirm it fails**

```bash
cd /Users/paul/dev/yulsi/kumiai && pnpm exec vitest run --root packages/rpc packages/mls-rpc
```

Expected: FAIL — the current zero-argument signature cannot express the clause.

- [ ] **Step 3: Widen the port**

`packages/rpc/src/crypto.ts:36`:

```ts
  exportSecret(label: string, length?: number): Uint8Array | Promise<Uint8Array>
```

Update the surrounding doc: it currently describes "an epoch-bound topic-derivation secret" as though there were one. There are now as many as there are labels, each epoch-bound, each domain-separated. Say why the label is required rather than optional — the next reader will otherwise helpfully make it optional.

- [ ] **Step 4: Update the real implementation**

`packages/mls-rpc/src/crypto.ts:126` currently closes over a fixed label. Pass the caller's label through to `handle().exportSecret(label, EXPORT_CONTEXT, SECRET_LENGTH)` instead. The label it closed over becomes the label its callers pass.

- [ ] **Step 5: Update callers and fakes**

Every `exportSecret()` call site in `packages/rpc/src/` passes the label it means. The fake at `packages/rpc/test/fixtures/fake-crypto.ts` must derive **differently per label** — a fake that ignores the label is exactly the divergence the conformance clause exists to catch, and this repo has been bitten seven times by a double answering where its port refuses.

- [ ] **Step 6: Run both suites and confirm they pass**

```bash
cd /Users/paul/dev/yulsi/kumiai && pnpm exec vitest run --root packages/rpc packages/mls-rpc
```

Expected: PASS on both sides — the same clause, both implementations.

- [ ] **Step 7: Repo gate, integration, commit**

```bash
cd /Users/paul/dev/yulsi/kumiai && pnpm exec turbo run test:types test:unit --force && pnpm exec vitest run --root tests/integration
git add packages/rpc packages/mls-rpc packages/rpc-conformance
git commit -m "feat(rpc,mls-rpc)!: exportSecret takes the label it derives under"
```

---

### Task 5: `wrap`/`unwrap` bind context and require the sender

**Files:**
- Modify: `packages/rpc/src/crypto.ts:37-38` (the port)
- Create or modify: an rpc-owned unwrap result type (do not reuse `@kumiai/broadcast`'s optional-sender `UnwrapResult`)
- Modify: `packages/mls-rpc/src/crypto.ts`, `packages/rpc-conformance/src/group-crypto.ts`, `packages/rpc/test/fixtures/fake-crypto.ts`

**Interfaces:**
- Produces: `wrap`/`unwrap` each take a context argument; rpc's unwrap result carries a **required** `senderDID`.

**Note on the AAD half.** The spec flags it as the most speculative item in scope, included only because it shares the same signature change as the required-sender half. If it proves awkward, report that rather than forcing it — the required-`senderDID` half is the part that must land.

- [ ] **Step 1: Write the failing conformance clauses**

Two: unwrapping a frame yields a `senderDID` that is present and correct (not merely present); and bytes sealed under one context do not open under another.

- [ ] **Step 2: Run and confirm they fail**

```bash
cd /Users/paul/dev/yulsi/kumiai && pnpm exec vitest run --root packages/rpc packages/mls-rpc
```

- [ ] **Step 3: Define the rpc-owned result and widen the port**

`packages/rpc/src/crypto.ts`. rpc's app lane is always MLS-sealed, so there is no identity-less case for it to accommodate — the optional `senderDID` it inherits from broadcast's type is a permission it does not need and should not grant. Give rpc its own result type with a required `senderDID`, and add the context argument to both halves.

- [ ] **Step 4: Update the implementation, the fake, and callers**

`packages/mls-rpc/src/crypto.ts` and `packages/rpc/test/fixtures/fake-crypto.ts`. The fake must honour the context — sealing under one and opening under another must fail there too, or the clause passes for the wrong reason.

- [ ] **Step 5: Run both suites, the repo gate, and integration**

```bash
cd /Users/paul/dev/yulsi/kumiai && pnpm exec vitest run --root packages/rpc packages/mls-rpc
cd /Users/paul/dev/yulsi/kumiai && pnpm exec turbo run test:types test:unit --force && pnpm exec vitest run --root tests/integration
```

- [ ] **Step 6: Commit**

```bash
cd /Users/paul/dev/yulsi/kumiai
git add packages/rpc packages/mls-rpc packages/rpc-conformance
git commit -m "feat(rpc,mls-rpc)!: bind sealed bytes to a context and require an authenticated sender"
```

---

### Task 6: Broadcast reply identity

Do this **after** Task 5 — it consumes the sender type that task settles.

**Files:**
- Modify: `packages/broadcast/src/client.ts:9,13,130-134`, `packages/broadcast/src/responder.ts:27,75,80`, `packages/broadcast/src/event-frame.ts`
- Modify: `packages/rpc/src/bus-server.ts:14,19` (the hand-copied duplicate)
- Test: `packages/broadcast/test/`, `packages/rpc/test/`

**Interfaces:**
- Produces: `ReplyData` loses `from` → `{ kind: 'res'; rid: string; ok?: unknown; err?: string }`. `GatheredReply` becomes `{ senderDID: string; value: unknown }`. Broadcast wire gains `v: 1`.

**Rename, do not redefine.** `GatheredReply.from` must become `senderDID`, not stay `from` with new meaning. Keeping the name would let every consumer compile while none is told the semantics moved from asserted to authenticated. The rename is what makes the break loud, which is the entire point of doing it now.

- [ ] **Step 1: Write the two failing tests**

The attribution half is the obvious one. **The dedup half is the one that matters more** and is easy to skip: `seen` is keyed on the reply identity, so a member can suppress another member's real reply by racing a forgery under that DID, or inflate a quorum by replying N times under N names. Write a test proving a forged identity can no longer displace a real reply from `seen` — a `quorum` that counts forgeries is not a quorum, and only this test says so.

- [ ] **Step 2: Run and confirm both fail**

```bash
cd /Users/paul/dev/yulsi/kumiai/packages/broadcast && pnpm exec vitest run
```

- [ ] **Step 3: Take `from` off the wire and key on the authenticated sender**

`ReplyData` loses `from`. `BroadcastClient` keys `seen` on `msg.senderDID` and drops any reply whose `senderDID` is absent on an authenticating transport. No new plumbing is needed — `createBroadcastTransport` already attaches `senderDID` from `crypto.unwrap`, so the authenticated sender is in scope one variable away from where the self-asserted one was being read.

`BroadcastResponderParams.from` survives only for buses with no authenticated sender (the memory bus), and feeds the transport-level `senderDID` rather than the reply body — so the two paths converge on one field instead of two.

- [ ] **Step 4: Add the wire version discriminant**

`v: 1` on the broadcast frame, rejected distinguishably when unknown. Broadcast is loose JSON, so additions were already safe; what the version buys is the ability to *remove* and *reinterpret* — which is exactly what Step 3 just did.

- [ ] **Step 5: Update the duplicate in rpc**

`packages/rpc/src/bus-server.ts:14,19` hand-copies this shape. It changes with it.

- [ ] **Step 6: Run broadcast, rpc, the repo gate, and integration**

```bash
cd /Users/paul/dev/yulsi/kumiai && pnpm exec vitest run --root packages/broadcast packages/rpc
cd /Users/paul/dev/yulsi/kumiai && pnpm exec turbo run test:types test:unit --force && pnpm exec vitest run --root tests/integration
```

- [ ] **Step 7: Commit**

```bash
cd /Users/paul/dev/yulsi/kumiai
git add packages/broadcast packages/rpc
git commit -m "feat(broadcast,rpc)!: attribute replies by authenticated sender, not a self-asserted field"
```

---

### Task 7: `AuthorizeHook` takes a discriminated request

**Files:**
- Modify: `packages/hub-server/src/handlers.ts:14-20` (the type), `:119` and `:182` (the two call sites)
- Modify: `packages/hub-server/src/hub.ts:45` if the param type needs it
- Test: `packages/hub-server/test/`

**Interfaces:**
- Produces, exactly as specced:

```ts
export type AuthorizeRequest =
  | { action: 'publish'; did: string; topicID: string; retain: 'log' | 'mailbox'; payloadSize: number }
  | { action: 'subscribe'; did: string; topicID: string; retention?: number }
  | { action: 'unsubscribe'; did: string; topicID: string }
  | { action: 'topic/fetch'; did: string; topicID: string }
  | { action: 'keypackage/upload'; did: string; count: number }
  | { action: 'keypackage/fetch'; did: string; targetDID: string; count: number }

export type AuthorizeDecision =
  | boolean
  | { allow: boolean; reason?: string; code?: string; retryAfterMs?: number }

export type AuthorizeHook = (req: AuthorizeRequest) => AuthorizeDecision | Promise<AuthorizeDecision>
```

**All six variants ship even though only `publish` and `subscribe` are enforced.** The union is itself an exhaustive-switch surface, so adding a variant later is precisely the break this exists to avoid. **Enforcement is out of scope** — no quotas, no publish gating. Surface only.

**An unknown action defaults to allow**, so a host's existing hook does not silently begin refusing procedures that were previously ungated. This was a deliberate call; do not invert it.

- [ ] **Step 1: Write the failing tests**

A hook receiving a `publish` request sees `retain` and `payloadSize`. A hook returning `{ allow: false, reason }` refuses, and the reason reaches the error. A hook that returns `true` for everything permits everything, as today.

- [ ] **Step 2: Run and confirm they fail**

```bash
cd /Users/paul/dev/yulsi/kumiai/packages/hub-server && pnpm exec vitest run
```

- [ ] **Step 3: Replace the type and both call sites**

`handlers.ts:14-20` for the type; `:119` and `:182` for the calls. Keep the existing default (`params.authorize ?? (() => true)`) behaviourally identical.

- [ ] **Step 4: Run hub-server, the repo gate, and commit**

```bash
cd /Users/paul/dev/yulsi/kumiai/packages/hub-server && pnpm exec vitest run
cd /Users/paul/dev/yulsi/kumiai && pnpm exec turbo run test:types test:unit --force
git add packages/hub-server
git commit -m "feat(hub-server)!: AuthorizeHook takes a discriminated request and a rich decision"
```

---

### Task 8: Rename hub procedures to `hub/v1/*`

The smallest task, and purely a naming change. **Do not open any schema** — every `additionalProperties: false` stays exactly as it is.

**Files:**
- Modify: `packages/hub-protocol/src/protocol.ts` (seven procedure keys)
- Modify: every consumer — `packages/hub-server/src/handlers.ts`, `packages/hub-client/src/client.ts`, `packages/hub-tunnel/src/`, and any test naming a procedure

**Interfaces:**
- Produces: `hub/v1/publish`, `hub/v1/subscribe`, `hub/v1/unsubscribe`, `hub/v1/topic/fetch`, `hub/v1/receive`, `hub/v1/keypackage/upload`, `hub/v1/keypackage/fetch`.

**Why:** left alone, the first change to `hub/publish` must be called `hub/publish/v2` — an irregular series where v1 alone is unmarked. Starting at `hub/v1/*` makes it regular forever, and renaming procedures is a wire change that is free only while nothing is deployed.

- [ ] **Step 1: Find every occurrence**

```bash
cd /Users/paul/dev/yulsi/kumiai && grep -rn "hub/publish\|hub/subscribe\|hub/unsubscribe\|hub/topic/fetch\|hub/receive\|hub/keypackage" packages tests --include="*.ts" | grep -v node_modules | grep -v "/lib/"
```

Record the count before editing so you can confirm none was missed.

- [ ] **Step 2: Rename in the protocol and every consumer**

Insert `v1/` after `hub/` in all seven keys and every reference. Add a short note in `protocol.ts` stating the evolution path: a shape change ships as a new versioned procedure, which is additive, rather than by widening an existing schema.

- [ ] **Step 3: Confirm none was missed**

Re-run the Step 1 grep. Expected: no output. Any surviving unversioned name is a client that will call a procedure the hub no longer serves.

- [ ] **Step 4: Run the repo gate, integration, and commit**

```bash
cd /Users/paul/dev/yulsi/kumiai && pnpm exec turbo run test:types test:unit --force && pnpm exec vitest run --root tests/integration
git add packages
git commit -m "feat(hub-protocol)!: version the procedure namespace as hub/v1/*"
```

---

### Task 9: Release notes

**Files:**
- Create: `.changeset/forward-compatibility.md`
- Modify: `docs/agents/architecture.md` if the reserved-namespace section should mention `0xf102`
- Create: a backlog entry for the deferred findings

- [ ] **Step 1: Write the changeset**

Packages, all `minor`: `@kumiai/mls`, `@kumiai/mls-rpc`, `@kumiai/rpc`, `@kumiai/broadcast`, `@kumiai/hub-protocol`, `@kumiai/hub-server`. Add `@kumiai/hub-client` and `@kumiai/hub-tunnel` if Task 8 changed their published behaviour.

The body must say what this release *is*, because it will not be obvious from a list of signature changes: most of it is not a feature but forward-compatibility machinery, taken now because these mechanisms only work if they ship before the things that need them. Name the three consequences a consumer will actually hit — `exportSecret` now requires a label, `GatheredReply.from` is now `senderDID` and is authenticated, and hub procedures moved to `hub/v1/*`.

- [ ] **Step 2: File the deferred findings**

Create `docs/agents/plans/next/2026-07-20-deferred-api-findings.md` listing what the audits found and this plan deliberately did not do — a third `GroupPermission`, leaf identity on `rosterDIDs`, a typed `ProtocolSurface`, `HubStore` headroom and its positional methods, `deduped`/`head` on the publish result, `KeyPackageLimits` renaming, nested `HubRateLimits`, hub port types moving out of `hub-tunnel`, the `urn:enkaku:` schema `$id`s, `deriveTopicID` NUL-injectivity, the dead `GroupSyncScope` export, `hub-client`'s `rawClient` leak and pre-base64 `payload`.

For each, one line on what it is and why it was deferred. State plainly at the top that each will cost a breaking change when taken, and that this was accepted deliberately rather than overlooked.

- [ ] **Step 3: Full gate, lint, commit**

```bash
cd /Users/paul/dev/yulsi/kumiai && pnpm exec turbo run test:types test:unit --force && pnpm exec vitest run --root tests/integration && rtk proxy pnpm run lint
git add -A
git commit -m "docs: release notes for the forward-compatibility work, and the findings it defers"
```
