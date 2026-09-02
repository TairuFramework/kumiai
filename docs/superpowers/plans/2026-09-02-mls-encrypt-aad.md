# AAD on the group application-message crypto — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** planning
**Mode:** tasks

**Goal:** Thread MLS `authenticated_data` (AAD) through `GroupHandle.encrypt`/`decrypt` and the `@kumiai/rpc` `GroupCrypto` `wrap`/`unwrap` port, and bind every app frame to the topicID it is published on, so a frame sealed for one topic cannot be opened on another.

**Architecture:** `encrypt` binds the topicID as ts-mls `authenticatedData`; `decrypt` compares an `expectedAAD` against the frame's cleartext `authenticatedData` *before* `mlsProcessMessage` (no ratchet consumption on mismatch) and always returns the frame's `AAD`. The rpc port forwards these; every rpc wrap/unwrap site binds the topicID it already uses. No topic derivation changes.

**Tech Stack:** TypeScript (ES2025, strict), ts-mls, vitest, turbo, biome, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-02-mls-encrypt-aad-design.md` (Spec A of three; B and C are in `docs/agents/plans/next/`).

## Global Constraints

- Conventions per `kigu:conventions`: `type` not `interface`; `Array<T>`; ES private `#field`; capital acronyms (`AAD`, `expectedAAD`, `DID`, `ID`); single params-object for many args; British spelling in prose/comments; terse comments (why, not what).
- Acronym casing is fixed: the field/param is `AAD` and `expectedAAD` — never `aad`/`Aad`, except ts-mls's own identifiers (`authenticatedData`, its result's `aad`), which stay verbatim.
- Do not edit generated `lib/`. Cross-repo deps via workspace catalog as published `^`; internal `@kumiai/*` deps `workspace:^`.
- Lint/verify: `rtk proxy pnpm run lint` for real biome output before staging (an `rtk` shim otherwise fakes it). Force tests — `pnpm test` reports cached turbo results; confirm `Cached: 0`. Every vitest step is paired with `test:types` because vitest strips types.
- Changing a port means running **both** `@kumiai/rpc-conformance` against the real implementation (`@kumiai/mls-rpc`) **and** the double (`fake-crypto`).
- Verify-only decision: `GroupUnwrapResult` stays `{ payload, senderDID }`; the rpc port never echoes AAD.
- Rollout is unconditional enforcement: pre-upgrade retained app frames (empty AAD) are rejected and their durable cursor advanced — retained history is deliberately invalidated on upgrade. No legacy empty-AAD acceptance path.

---

### Task 1: `GroupHandle.encrypt`/`decrypt` AAD in `@kumiai/mls`

**Files:**
- Modify: `packages/mls/src/sender-data.ts:14-20` (add `authenticatedData` to `PrivateCommitFrame`)
- Modify: `packages/mls/src/group-handle.ts:180-208` (`readPrivateFrame` surfaces `authenticatedData`), `:759-770` (`encrypt`), `:796-822` (`decrypt`)
- Test: `packages/mls/test/group.test.ts` (new describe near the existing encrypt/decrypt tests)

**Interfaces:**
- Produces:
  - `encrypt(plaintext: Uint8Array, opts?: { AAD?: Uint8Array }): Promise<Uint8Array>`
  - `decrypt(message: Uint8Array, opts?: { expectedAAD?: Uint8Array }): Promise<{ payload: Uint8Array; senderDID?: string; AAD: Uint8Array }>`
  - `PrivateCommitFrame` gains `authenticatedData: Uint8Array`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/mls/test/group.test.ts` (use the file's existing group-setup helpers; mirror the nearest existing encrypt/decrypt test for group construction):

```ts
describe('encrypt/decrypt AAD', () => {
  test('round-trips AAD and returns it on decrypt', async () => {
    const { alice, bob } = await twoMemberGroup() // existing helper
    const AAD = new TextEncoder().encode('topic-x')
    const sealed = await alice.encrypt(new TextEncoder().encode('hi'), { AAD })
    const opened = await bob.decrypt(sealed, { expectedAAD: AAD })
    expect(new TextDecoder().decode(opened.payload)).toBe('hi')
    expect(opened.AAD).toEqual(AAD)
  })

  test('decrypt throws on expectedAAD mismatch, distinct from not-my-epoch', async () => {
    const { alice, bob } = await twoMemberGroup()
    const sealed = await alice.encrypt(new TextEncoder().encode('hi'), {
      AAD: new TextEncoder().encode('topic-a'),
    })
    await expect(
      bob.decrypt(sealed, { expectedAAD: new TextEncoder().encode('topic-b') }),
    ).rejects.toThrow(/authenticated data|expected AAD/i)
  })

  test('pre-open compare preserves the ratchet: same ciphertext opens after a rejected wrong-AAD attempt', async () => {
    const { alice, bob } = await twoMemberGroup()
    const AAD = new TextEncoder().encode('topic-x')
    const sealed = await alice.encrypt(new TextEncoder().encode('hi'), { AAD })
    await expect(
      bob.decrypt(sealed, { expectedAAD: new TextEncoder().encode('wrong') }),
    ).rejects.toThrow()
    const opened = await bob.decrypt(sealed, { expectedAAD: AAD })
    expect(new TextDecoder().decode(opened.payload)).toBe('hi')
  })

  test('no-AAD default round-trips (empty AAD)', async () => {
    const { alice, bob } = await twoMemberGroup()
    const sealed = await alice.encrypt(new TextEncoder().encode('hi'))
    const opened = await bob.decrypt(sealed)
    expect(new TextDecoder().decode(opened.payload)).toBe('hi')
    expect(opened.AAD).toEqual(new Uint8Array())
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm --filter @kumiai/mls test -- group.test.ts -t "encrypt/decrypt AAD"`
Expected: FAIL (encrypt/decrypt reject the second arg / `AAD` absent on result).

- [ ] **Step 3: Add `authenticatedData` to `PrivateCommitFrame` and surface it in `readPrivateFrame`**

`sender-data.ts` — extend the type:

```ts
export type PrivateCommitFrame = {
  groupId: Uint8Array
  epoch: bigint
  contentType: number
  encryptedSenderData: Uint8Array
  ciphertext: Uint8Array
  authenticatedData: Uint8Array
}
```

`group-handle.ts` `readPrivateFrame` — add to the narrowed `pm` shape and the guard/return (widen the `pm` cast to include `authenticatedData?: unknown`, guard `pm.authenticatedData instanceof Uint8Array`, and include it in the returned object). This is safe: `readSenderLeafIndex` ignores extra fields and the commit path (`contentTypes.commit`) does not read it.

- [ ] **Step 4: Implement `encrypt` AAD**

`group-handle.ts:759-769`:

```ts
async encrypt(plaintext: Uint8Array, opts?: { AAD?: Uint8Array }): Promise<Uint8Array> {
  return mutexFor(this).run(async () => {
    const { newState, message, consumed } = await createApplicationMessage({
      context: this.#context,
      state: this.#state,
      message: plaintext,
      authenticatedData: opts?.AAD ?? new Uint8Array(),
    })
    this.#state = newState
    zeroAll(consumed)
    return encode(mlsMessageEncoder, message)
  })
}
```

- [ ] **Step 5: Implement `decrypt` pre-open compare + AAD return**

`group-handle.ts:796-822` — after `readPrivateFrame` and BEFORE `mlsProcessMessage`, compare; return `AAD` from the result:

```ts
async decrypt(
  message: Uint8Array,
  opts?: { expectedAAD?: Uint8Array },
): Promise<{ payload: Uint8Array; senderDID?: string; AAD: Uint8Array }> {
  const decoded = decode(mlsMessageDecoder, message)
  if (decoded == null) throw new Error('decrypt: failed to decode MLSMessage')
  return mutexFor(this).run(async () => {
    const pm = readPrivateFrame(decoded, contentTypes.application)
    if (pm == null) throw new Error('decrypt: not a PrivateMessage application frame')
    // Pre-open: reject a wrong-topic frame from its CLEARTEXT authenticatedData before
    // mlsProcessMessage consumes a ratchet generation. Same lane as the sender-leaf read below.
    if (opts?.expectedAAD != null && !bytesEqual(pm.authenticatedData, opts.expectedAAD)) {
      throw new Error('decrypt: frame authenticated data does not match expected AAD')
    }
    const leafIndex = await readSenderLeafIndex(
      this.#context,
      this.#state.keySchedule.senderDataSecret,
      pm,
    )
    const result = await mlsProcessMessage({
      context: this.#context,
      state: this.#state,
      message: decoded as Parameters<typeof mlsProcessMessage>[0]['message'],
    })
    this.#state = result.newState
    zeroAll(result.consumed)
    if (result.kind !== 'applicationMessage') {
      throw new Error('decrypt: frame was not an application message')
    }
    const senderDID = leafIndex == null ? undefined : this.#didOfLeaf(leafIndex)
    return { payload: result.message, AAD: result.aad, ...(senderDID != null && { senderDID }) }
  })
}
```

Add a small `bytesEqual` helper if none exists in the module (constant-time not required — AAD is not secret):

```ts
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
```

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm --filter @kumiai/mls test -- group.test.ts -t "encrypt/decrypt AAD"` → PASS
Run: `pnpm --filter @kumiai/mls test:types` → PASS

- [ ] **Step 7: Commit**

```bash
git add packages/mls/src/sender-data.ts packages/mls/src/group-handle.ts packages/mls/test/group.test.ts
git commit -m "feat(mls): AAD on GroupHandle.encrypt/decrypt with pre-open verify"
```

---

### Task 2: `GroupCrypto` port gains AAD in `@kumiai/rpc`

**Files:**
- Modify: `packages/rpc/src/crypto.ts:62-69` (`wrap`/`unwrap` signatures + doc)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `wrap(bytes: Uint8Array, opts?: { AAD?: Uint8Array }): Uint8Array | Promise<Uint8Array>`
  - `unwrap(bytes: Uint8Array, opts?: { expectedAAD?: Uint8Array }): GroupUnwrapResult | Promise<GroupUnwrapResult>`
  - `GroupUnwrapResult` unchanged (`{ payload, senderDID }`).

- [ ] **Step 1: Change the port types**

`crypto.ts` — replace the `wrap`/`unwrap` members:

```ts
  wrap(bytes: Uint8Array, opts?: { AAD?: Uint8Array }): Uint8Array | Promise<Uint8Array>
  unwrap(
    bytes: Uint8Array,
    opts?: { expectedAAD?: Uint8Array },
  ): GroupUnwrapResult | Promise<GroupUnwrapResult>
```

Update the surrounding doc comment: `wrap` is no longer literally broadcast's `ByteTransform` (it takes an optional second arg); note that fixed-topic lanes adapt it to a `ByteTransform` closure and directed lanes call the two-arg form, and that `expectedAAD` is compared pre-open so a wrong-topic frame costs no ratchet generation.

- [ ] **Step 2: Typecheck (expected to surface downstream break sites)**

Run: `pnpm --filter @kumiai/rpc test:types`
Expected: PASS for the type itself (optional params keep existing callers valid). Note any implementor errors for Tasks 3–4.

- [ ] **Step 3: Commit**

```bash
git add packages/rpc/src/crypto.ts
git commit -m "feat(rpc): GroupCrypto wrap/unwrap accept AAD/expectedAAD"
```

---

### Task 3: `@kumiai/mls-rpc` delegates AAD to the handle

**Files:**
- Modify: `packages/mls-rpc/src/crypto.ts:100` (`wrap`), `:131-144` (`unwrap`)

**Interfaces:**
- Consumes: `GroupHandle.encrypt`/`decrypt` (Task 1), `GroupCrypto` port (Task 2).
- Produces: real `GroupCrypto` `wrap`/`unwrap` forwarding AAD.

- [ ] **Step 1: Forward AAD in `wrap` and `unwrap`**

```ts
    wrap: (bytes, opts) => handle().encrypt(bytes, opts),
```

```ts
    unwrap: async (bytes, opts) => {
      const { payload, senderDID } = await handle().decrypt(bytes, opts)
      if (senderDID == null) {
        throw new Error('unwrap: opened frame has no authenticated sender')
      }
      return { payload, senderDID }
    },
```

(`opts` is `{ AAD? }` for `wrap` and `{ expectedAAD? }` for `unwrap`; both pass straight through. The returned `AAD` is dropped — verify-only.)

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @kumiai/mls-rpc test:types` → PASS

- [ ] **Step 3: Commit**

```bash
git add packages/mls-rpc/src/crypto.ts
git commit -m "feat(mls-rpc): forward AAD through wrap/unwrap to the handle"
```

---

### Task 4: `fake-crypto` double carries and verifies AAD

**Files:**
- Modify: `packages/rpc/test/fixtures/fake-crypto.ts:152-164` (`wrap`), `:191-202` (`frameEpoch`), `:204-234` (`unwrap`)

**Interfaces:**
- Consumes: `GroupCrypto` port (Task 2).
- Produces: a double whose frame carries the AAD, whose tag covers it, and whose `unwrap` rejects a mismatched `expectedAAD` **before** marking the generation spent.

Frame layout becomes `[epoch(2)][ xor( [generation(4)][didLen(2)][aadLen(4)][did][aad][payload] , epoch ) ]`. The XOR keystream over the whole framed body is the stand-in AEAD tag: a tampered AAD (or one opened at the wrong epoch) de-XORs to garbage, exactly as the real tag fails. `expectedAAD` is compared against the recovered `aad` before `spent.add`.

- [ ] **Step 1: Extend the conformance test to require pre-open AAD rejection (fails first)**

This step is covered by Task 5's new clauses; run them against the fake here after implementing. Proceed to implement, then Task 5 gates both implementations.

- [ ] **Step 2: Implement `wrap` with carried AAD**

```ts
const wrap: GroupCrypto['wrap'] = (bytes, opts) => {
  const did = fromUTF(localDID)
  const aad = opts?.AAD ?? new Uint8Array()
  const framed = new Uint8Array(FRAMED_HEADER_BYTES + AAD_LEN_BYTES + did.length + aad.length + bytes.length)
  const framedView = new DataView(framed.buffer)
  framedView.setUint32(0, generation++, true)
  framedView.setUint16(GENERATION_BYTES, did.length, true)
  framedView.setUint32(FRAMED_HEADER_BYTES, aad.length, true)
  let at = FRAMED_HEADER_BYTES + AAD_LEN_BYTES
  framed.set(did, at); at += did.length
  framed.set(aad, at); at += aad.length
  framed.set(bytes, at)
  const sealed = new Uint8Array(2 + framed.length)
  new DataView(sealed.buffer).setUint16(0, epoch, true)
  sealed.set(xor(framed, epoch), 2)
  return sealed
}
```

Add `const AAD_LEN_BYTES = 4` beside the other byte-width constants, and update `FRAMED_HEADER_BYTES` usage: the header is still `generation(4)+didLen(2)`; the `aadLen(4)` sits after it, before the did.

- [ ] **Step 3: Update `frameEpoch` for the new layout**

`frameEpoch` only reads `sealedAt` and validates `didLen` fits; extend the well-formedness bound to include `AAD_LEN_BYTES` and `aadLen`:

```ts
const didLen = new DataView(framed.buffer).getUint16(GENERATION_BYTES, true)
const aadLen = new DataView(framed.buffer).getUint32(FRAMED_HEADER_BYTES, true)
return FRAMED_HEADER_BYTES + AAD_LEN_BYTES + didLen + aadLen <= framed.length ? sealedAt : null
```

- [ ] **Step 4: Implement `unwrap` with pre-spent AAD compare**

```ts
const unwrap: GroupCrypto['unwrap'] = (bytes, opts) => {
  if (bytes.length < 2 + FRAMED_HEADER_BYTES + AAD_LEN_BYTES) {
    throw new Error('cannot open: not sealed bytes')
  }
  const sealedAt = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0, true)
  if (sealedAt !== epoch) {
    throw new Error(`cannot open bytes sealed at epoch ${sealedAt}: this member is at ${epoch}`)
  }
  const framed = xor(bytes.subarray(2), sealedAt)
  const framedView = new DataView(framed.buffer, framed.byteOffset, framed.byteLength)
  const sealedGeneration = framedView.getUint32(0, true)
  const didLen = framedView.getUint16(GENERATION_BYTES, true)
  const aadLen = framedView.getUint32(FRAMED_HEADER_BYTES, true)
  const headerEnd = FRAMED_HEADER_BYTES + AAD_LEN_BYTES
  if (headerEnd + didLen + aadLen > framed.length) {
    throw new Error('cannot open: not a well-formed sealed frame')
  }
  const senderDID = toUTF(framed.subarray(headerEnd, headerEnd + didLen))
  const aad = framed.subarray(headerEnd + didLen, headerEnd + didLen + aadLen)
  // Pre-spent: reject a wrong-topic frame before consuming the generation, mirroring the real
  // handle's pre-open compare.
  if (opts?.expectedAAD != null && !bytesEqual(aad, opts.expectedAAD)) {
    throw new Error('cannot open: frame authenticated data does not match expected AAD')
  }
  const key = `${sealedAt}:${senderDID}:${sealedGeneration}`
  if (spent.has(key)) {
    throw new Error(
      `cannot open: the message key for generation ${sealedGeneration} from ${senderDID} at epoch ${sealedAt} is spent`,
    )
  }
  spent.add(key)
  const payload = framed.subarray(headerEnd + didLen + aadLen)
  return { payload, senderDID }
}
```

Add a `bytesEqual` helper local to the fixture if none is imported.

- [ ] **Step 5: Run existing conformance against the fake (no regression)**

Run: `pnpm --filter @kumiai/rpc test -- ports-conformance.test.ts`
Expected: PASS (existing wrap/unwrap/frameEpoch clauses still green with the new layout).

- [ ] **Step 6: Commit**

```bash
git add packages/rpc/test/fixtures/fake-crypto.ts
git commit -m "test(rpc): fake-crypto carries and verifies AAD pre-spent"
```

---

### Task 5: `rpc-conformance` AAD clauses (real + double)

**Files:**
- Modify: `packages/rpc-conformance/src/group-crypto.ts` (new tests in the `wrap / unwrap` describe, ~after line 324)

**Interfaces:**
- Consumes: `GroupCrypto` port (Task 2), the real impl (Task 3) and fake (Task 4).

- [ ] **Step 1: Add the AAD clauses**

Follow the file's existing `withGroup`/`memberAt`/`opened`/`text`/`refuses` helpers:

```ts
describe('wrap / unwrap AAD', () => {
  test('round-trips AAD: wrap with AAD, unwrap with matching expectedAAD', async () => {
    await withGroup(2, 'aad-roundtrip', async ({ members }) => {
      const alice = memberAt(members, 0)
      const bob = memberAt(members, 1)
      const AAD = utf8.encode('topic-x')
      const sealed = await alice.crypto.wrap(utf8.encode('hi'), { AAD })
      const out = await bob.crypto.unwrap(sealed, { expectedAAD: AAD })
      expect(text(out.payload)).toBe('hi')
      expect(out.senderDID).toBe(alice.did)
    })
  })

  test('unwrap throws when expectedAAD does not match the frame', async () => {
    await withGroup(2, 'aad-mismatch', async ({ members }) => {
      const alice = memberAt(members, 0)
      const bob = memberAt(members, 1)
      const sealed = await alice.crypto.wrap(utf8.encode('hi'), { AAD: utf8.encode('topic-a') })
      await refuses(() => bob.crypto.unwrap(sealed, { expectedAAD: utf8.encode('topic-b') }))
    })
  })

  test('mismatch is PRE-OPEN: the same bytes still open with the correct expectedAAD', async () => {
    await withGroup(2, 'aad-preopen', async ({ members }) => {
      const alice = memberAt(members, 0)
      const bob = memberAt(members, 1)
      const AAD = utf8.encode('topic-x')
      const sealed = await alice.crypto.wrap(utf8.encode('hi'), { AAD })
      await refuses(() => bob.crypto.unwrap(sealed, { expectedAAD: utf8.encode('wrong') }))
      const out = await bob.crypto.unwrap(sealed, { expectedAAD: AAD })
      expect(text(out.payload)).toBe('hi')
    })
  })

  test('no-AAD round-trips (empty default) both ways', async () => {
    await withGroup(2, 'aad-none', async ({ members }) => {
      const alice = memberAt(members, 0)
      const bob = memberAt(members, 1)
      const sealed = await alice.crypto.wrap(utf8.encode('hi'))
      expect(text((await opened(bob.crypto, sealed)).payload)).toBe('hi')
    })
  })
})
```

- [ ] **Step 2: Run against BOTH implementations**

Run: `pnpm --filter @kumiai/rpc test -- ports-conformance.test.ts` (fake)
Run: `pnpm --filter @kumiai/mls-rpc test` (real impl conformance harness; confirm `Cached: 0`)
Expected: PASS on both. Also `pnpm --filter @kumiai/rpc-conformance test:types` → PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/rpc-conformance/src/group-crypto.ts
git commit -m "test(rpc-conformance): AAD round-trip, pre-open mismatch, empty default"
```

---

### Task 6: bind AAD on the directed lanes

**Files:**
- Modify: `packages/rpc/src/directed.ts:90` (`wrap` param type), `:96-100` (client publish), `:205-210` (acceptor session publish)

**Interfaces:**
- Consumes: `GroupCrypto['wrap']` (Task 2).
- Produces: directed publishes seal with `AAD = fromUTF(publishParams.topicID)`.

- [ ] **Step 1: Write the failing integration test**

Add to the rpc directed integration test suite (mirror an existing directed request/reply test): assert a round-trip still works AND that a frame sealed for one inbox topic is refused when opened expecting another. Use the two-peer harness the directed tests already use.

```ts
test('directed frame binds its destination topic as AAD', async () => {
  // ... existing two-peer directed setup ...
  const reply = await clientA.someProc({ ping: 1 }) // exercises request+reply round-trip
  expect(reply).toEqual(/* expected */)
})
```

- [ ] **Step 2: Run, verify current behavior passes (round-trip) — this is a regression guard**

Run: `pnpm --filter @kumiai/rpc test -- directed` (existing behavior). Expected: PASS before change; the change must keep it PASS.

- [ ] **Step 3: Widen the `wrap` param type**

In `directed.ts`, change the destructured `wrap` type from `ByteTransform` to `GroupCrypto['wrap']` (import the type from `./crypto.js`). Both `DirectedClientParams` and the acceptor params carry `wrap`.

- [ ] **Step 4: Bind AAD at both publish sites**

Client publish (`:96-100`):

```ts
      return mux.mailbox.publish({
        senderDID: publishParams.senderDID,
        topicID: publishParams.topicID,
        payload: await wrap(publishParams.payload, { AAD: fromUTF(publishParams.topicID) }),
      })
```

Acceptor session publish (`:205-210`):

```ts
      async publish(publishParams) {
        const sealed = await wrap(publishParams.payload, { AAD: fromUTF(publishParams.topicID) })
        return mux.mailbox.publish({
          senderDID: publishParams.senderDID,
          topicID: publishParams.topicID,
          payload: sealed,
        })
      },
```

Import `fromUTF` from `@sozai/codec` if not already imported.

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @kumiai/rpc test -- directed` → PASS
Run: `pnpm --filter @kumiai/rpc test:types` → PASS

- [ ] **Step 6: Commit**

```bash
git add packages/rpc/src/directed.ts packages/rpc/test
git commit -m "feat(rpc): bind directed frames to their destination topic as AAD"
```

---

### Task 7: bind AAD on the app live lane + inbox receive

**Files:**
- Modify: `packages/rpc/src/peer.ts:503-523` (`createInboundPath` unwrap adapter), `:566-576` (inbox path unwrap adapter), `:660-669` (`sealForSegment` builds topic before wrap + binds AAD)

**Interfaces:**
- Consumes: `GroupCrypto` `wrap`/`unwrap` (Task 2), `protocolTopic`, `inboxTopic` (unchanged), `fromUTF`.

- [ ] **Step 1: `sealForSegment` — compute the topic before wrapping and bind it**

```ts
  const sealForSegment = async (
    name: string,
    bytes: Uint8Array,
  ): Promise<{ topicID: string; payload: Uint8Array }> => {
    while (true) {
      const at = anchor
      const topicID = protocolTopic(at.secret, at.epoch, name)
      const payload = await crypto.wrap(bytes, { AAD: fromUTF(topicID) })
      if (anchor === at) return { topicID, payload }
    }
  }
```

(The pre-existing anchor/epoch seal race is out of scope here — Spec C. This only binds the topic computed pre-wrap.)

- [ ] **Step 2: `createInboundPath` — bind `expectedAAD` on the live open**

`createInboundPath(name, topicID)` has `topicID` in scope. Replace `unwrap: crypto.unwrap` with a topic-bound adapter:

```ts
    return createOpenOncePath<Uint8Array>({
      mux,
      topicID,
      unwrap: (b) => crypto.unwrap(b, { expectedAAD: fromUTF(topicID) }),
      retainOnFailure,
      // ... project / note unchanged ...
    })
```

- [ ] **Step 3: inbox path — bind `expectedAAD` to the inbox topic**

At `buildEpoch`'s inbox lane (`:572-576`), the inbox path's `unwrap` binds the inbox topic:

```ts
    inboxLane = {
      topicID: selfInbox,
      path: createInboxPath({
        mux,
        topicID: selfInbox,
        unwrap: (b) => crypto.unwrap(b, { expectedAAD: fromUTF(selfInbox) }),
        retainOnFailure,
      }),
    }
```

(The acceptor's `wrap: crypto.wrap` stays the raw two-arg form — its publish path is the directed session from Task 6, which supplies the AAD.)

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @kumiai/rpc test` (confirm `Cached: 0`) → PASS
Run: `pnpm --filter @kumiai/rpc test:types` → PASS

- [ ] **Step 5: Commit**

```bash
git add packages/rpc/src/peer.ts
git commit -m "feat(rpc): bind app live lane and inbox receive to their topic as AAD"
```

---

### Task 8: bind AAD on the app retained drain + cross-topic integration test

**Files:**
- Modify: `packages/rpc/src/app-lane.ts:427-437` (drain unwrap binds `expectedAAD = cursor.topicID`)
- Test: `packages/rpc/test` (new integration test for cross-topic rejection + retained invalidation)

**Interfaces:**
- Consumes: `GroupCrypto.unwrap` (Task 2), `cursor.topicID` (already computed at `:226-229`), `fromUTF`.

- [ ] **Step 1: Write the failing integration test**

```ts
test('a frame sealed for one topic does not open on another lane', async () => {
  // Seal an app frame on protocol A's topic, place its bytes on protocol B's retained lane,
  // drain B, and assert the frame is dropped (not delivered) — using the existing app-lane
  // test harness and its cursor/drain entry points.
})

test('a pre-upgrade empty-AAD retained frame is rejected and the cursor advances (invalidation)', async () => {
  // Seal a frame with NO AAD (legacy), drain with expectedAAD bound, assert it is marked dead
  // and the durable cursor advances past it.
})
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm --filter @kumiai/rpc test -- app-lane` → FAIL (drain currently opens without expectedAAD).

- [ ] **Step 3: Bind `expectedAAD` on the drain**

The drain must have `cursor` in scope (from `laneFor(name)`). Bind the cursor's topic:

```ts
        try {
          opened = await crypto.unwrap(sealed, { expectedAAD: fromUTF(cursor.topicID) })
        } catch {
          // Claimed this epoch and the handle refused it — OR its AAD did not match this topic
          // (a wrong-topic frame, or a pre-upgrade empty-AAD frame). Either way, dead: the handle
          // never returns to this epoch and the topic binding never changes.
          frame.sealed = null
          continue
        }
```

Ensure `cursor` (with `.topicID`) is threaded into the drain loop; if the drain currently only has `frames`, fetch the lane's cursor via the existing `laneFor(name)` / `cursors.get(name)` path and pass `cursor.topicID`. Import `fromUTF` from `@sozai/codec`.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @kumiai/rpc test` (confirm `Cached: 0`) → PASS
Run: `pnpm --filter @kumiai/rpc test:types` → PASS

- [ ] **Step 5: Full gate — both conformance suites + whole-package tests + lint**

Run: `pnpm --filter @kumiai/mls test && pnpm --filter @kumiai/mls-rpc test && pnpm --filter @kumiai/rpc test` (each `Cached: 0`)
Run: `pnpm --filter @kumiai/rpc-conformance test:types`
Run: `rtk proxy pnpm run lint`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/rpc/src/app-lane.ts packages/rpc/test
git commit -m "feat(rpc): bind app retained drain to cursor topic as AAD"
```

---

### Task 9: changeset + rollout note

**Files:**
- Create: `.changeset/<name>.md`

- [ ] **Step 1: Record the intent**

`pnpm change` (or write the intent file) for the affected packages (`@kumiai/mls`, `@kumiai/rpc`, `@kumiai/mls-rpc`, `@kumiai/rpc-conformance`) at `minor`. Body (normal prose, for humans): AAD binding on the group app-message crypto; **breaking**: pre-upgrade retained app history is invalidated on upgrade because the drain now enforces the topic AAD and advances past legacy empty-AAD frames. No topic-ID or durable commit/recovery change.

- [ ] **Step 2: Commit**

```bash
git add .changeset
git commit -m "chore: changeset for AAD app-message binding (minor)"
```

---

## Self-Review

**Spec coverage:** mls AAD + pre-open + readPrivateFrame (Task 1); rpc port (Task 2); mls-rpc (Task 3); fake (Task 4); conformance clauses incl. pre-open ratchet + empty default (Task 5); directed binding (Task 6); app live + inbox (Task 7); app retained drain + cross-topic + invalidation (Task 8); rollout changeset (Task 9). All Spec A sections mapped. Per-protocol inbox / deriveTopicID / DID / seal-race are Spec B/C, out of scope.

**Placeholder scan:** integration-test bodies in Tasks 6 and 8 describe the assertion with harness-specific entry points rather than full code, because the rpc directed/app-lane harness helpers must be read at execution time; every crypto/port/fake edit carries exact code. Executors: read the neighbouring existing test in each suite for the harness shape before writing these two.

**Type consistency:** `AAD`/`expectedAAD` used identically across mls, port, mls-rpc, fake, conformance; `GroupUnwrapResult` never widened; `wrap` two-arg form consumed by directed (Task 6) and adapted to `Unwrap`/`ByteTransform` closures in peer/app-lane (Tasks 7–8) as the port defines in Task 2.
