# Committer Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a real MLS host an implementable `GroupMLS.readCommitHeader` by exposing a handle-bound, MLS-authenticated committer reader in `@kumiai/mls` and making the `@kumiai/rpc` port method async.

**Architecture:** Add `GroupHandle.readCommitHeader` in `@kumiai/mls` that resolves a Commit's committer against the live handle without advancing state — decrypting PrivateMessage sender-data with the epoch secret for a member commit, reading the UpdatePath leaf for an external commit. The sender-data decrypt is a small self-contained reimplementation of RFC 9420 §6.3.2, because ts-mls does not re-export its own `decryptSenderData`. Then relax `@kumiai/rpc`'s port method to `Promise<CommitHeader | null>` and `await` it at the two lane call sites.

**Tech Stack:** TypeScript (ESM, NodeNext), ts-mls `2.0.0-rc.13`, vitest, biome, turbo. pnpm only.

## Global Constraints

- Conventions (kigu `conventions` skill): `type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID`/`HTTP`/`JWT`/`DID`; ES `#fields`, never `private`/`readonly`. Do not edit generated `lib/`.
- `@kumiai/mls` is the ONLY package that may import `ts-mls`. `@kumiai/rpc` never imports MLS.
- ts-mls is reachable ONLY through its package root (`ts-mls`). Its `exports` map exposes only `.` — no deep imports (`ts-mls/dist/...`) exist. Everything the sender-data reimpl needs comes off the live `MlsContext.cipherSuite` (`.kdf.expand`, `.kdf.size`, `.hpke.decryptAead`, `.hpke.keyLength`, `.hpke.nonceLength`) or is reproduced locally.
- Lint/type before committing. Run repo scripts as `rtk proxy pnpm run <script>` (the `rtk` shim otherwise fakes both `pnpm run lint` and `pnpm exec biome`).
- Run tests from the package directory: `cd packages/<pkg> && pnpm run test:unit`. Type-check: `pnpm run build:types`.
- Commit on branch `feat/committer-reader` (already created).

---

## File Structure

- `packages/mls/src/sender-data.ts` — **new.** Self-contained RFC 9420 §6.3.2 sender-data decrypt: derive the sender-data key/nonce from the epoch secret and open the encrypted sender-data, returning the sender leaf index. The only reimplemented crypto; isolated so it is trivially deletable once ts-mls re-exports its own.
- `packages/mls/src/group-handle.ts` — **modify.** Add the public `readCommitHeader` method and a private `#didOfLeaf` helper; add a `readPrivateCommitFrame` structural narrower alongside the existing `readPrivateCommit`/`readExternalCommit`.
- `packages/mls/test/commit-header.test.ts` — **new.** Member-commit, external-commit, non-commit, and non-mutation coverage.
- `packages/rpc/src/crypto.ts` — **modify.** Port method → `Promise<CommitHeader | null>`; relax the doc comment.
- `packages/rpc/src/peer.ts` — **modify.** `await` the two `readCommitHeader` call sites (lines ~704, ~1370).
- `packages/rpc/test/fixtures/memory-group-mls.ts` — **modify.** `readCommitHeader` becomes `async`.
- `packages/rpc/test/group-mls.test.ts` — **modify.** `await` the direct `readCommitHeader` calls (lines ~42–44, ~139).

Backlog note (`docs/agents/plans/backlog/ts-mls-v2-stable-upgrade.md`) and the spec are already committed — no task here.

---

## Task 1: sender-data decrypt + member-commit `readCommitHeader`

The observable deliverable is `GroupHandle.readCommitHeader` returning the authenticated committer DID for a member (PrivateMessage) commit. That path exercises the entire sender-data reimplementation, so the two are built and tested together.

**Files:**
- Create: `packages/mls/src/sender-data.ts`
- Modify: `packages/mls/src/group-handle.ts`
- Test: `packages/mls/test/commit-header.test.ts`

**Interfaces:**
- Consumes: `MlsContext` (ts-mls) — `context.cipherSuite.{kdf,hpke}`. `GroupHandle` internals `#state.keySchedule.senderDataSecret`, `#context`, `#iterateMembers`.
- Produces:
  - `readSenderLeafIndex(context: MlsContext, senderDataSecret: Uint8Array, pm: PrivateCommitFrame): Promise<number | null>` and `type PrivateCommitFrame = { groupId: Uint8Array; epoch: bigint; contentType: number; encryptedSenderData: Uint8Array; ciphertext: Uint8Array }` — from `sender-data.ts`.
  - `GroupHandle.readCommitHeader(commit: Uint8Array): Promise<{ epoch: bigint; committerDID: string } | null>` — returns the committer for a member commit, `null` for everything else (external handled in Task 2).

- [ ] **Step 1: Write `sender-data.ts`**

Reproduces RFC 9420 §6.3.2 exactly (verified against ts-mls `sender.js`/`crypto/kdf.js`). No ts-mls import except the `MlsContext` type.

```ts
import type { MlsContext } from 'ts-mls'

/**
 * PrivateMessage sender-data decrypt, reimplemented from RFC 9420 §6.3.2.
 *
 * ts-mls ships `decryptSenderData` but does not re-export it (its `exports` map exposes
 * only `.`), so this package reproduces the derivation from primitives the live
 * `CiphersuiteImpl` does expose. Frozen wire format — see the backlog note
 * `ts-mls-v2-stable-upgrade.md`: delete this module and delegate to ts-mls once stable
 * re-exports its own.
 */

/** The PrivateMessage fields sender-data decrypt reads, narrowed off a decoded frame. */
export type PrivateCommitFrame = {
  groupId: Uint8Array
  epoch: bigint
  contentType: number
  encryptedSenderData: Uint8Array
  ciphertext: Uint8Array
}

const LABEL_PREFIX = new TextEncoder().encode('MLS 1.0 ')

function concat(parts: Array<Uint8Array>): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function uint16(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff])
}

function uint64(n: bigint): Uint8Array {
  const out = new Uint8Array(8)
  let value = n
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(value & 0xffn)
    value >>= 8n
  }
  return out
}

/** RFC 9420 opaque<V>: QUIC-style variable-length prefix (RFC 9000 §16), then the bytes. */
function varLen(data: Uint8Array): Uint8Array {
  const len = data.length
  let prefix: Uint8Array
  if (len < 64) {
    prefix = new Uint8Array([len & 0x3f])
  } else if (len < 16384) {
    prefix = new Uint8Array([((len >> 8) & 0x3f) | 0x40, len & 0xff])
  } else if (len < 0x40000000) {
    prefix = new Uint8Array([
      ((len >> 24) & 0x3f) | 0x80,
      (len >> 16) & 0xff,
      (len >> 8) & 0xff,
      len & 0xff,
    ])
  } else {
    throw new Error('sender-data: length too large to encode')
  }
  return concat([prefix, data])
}

/**
 * MLS `ExpandWithLabel(Secret, Label, Context, Length)`: `KDF.Expand` over the KDFLabel
 * struct `{ uint16 length; opaque label<V> = "MLS 1.0 " + Label; opaque context<V> }`.
 */
function expandWithLabel(
  context: MlsContext,
  secret: Uint8Array,
  label: string,
  labelContext: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const kdfLabel = concat([
    uint16(length),
    varLen(concat([LABEL_PREFIX, new TextEncoder().encode(label)])),
    varLen(labelContext),
  ])
  return context.cipherSuite.kdf.expand(secret, kdfLabel, length)
}

/** The ciphertext sample the sender-data key/nonce derive from: the first `KDF.Nh` bytes. */
function sample(context: MlsContext, ciphertext: Uint8Array): Uint8Array {
  const size = context.cipherSuite.kdf.size
  return ciphertext.length < size ? ciphertext : ciphertext.subarray(0, size)
}

/**
 * Decrypt a PrivateMessage's sender-data and return the committer's leaf index, or `null`
 * if the AEAD refuses the bytes or the plaintext is malformed. Non-mutating: the
 * sender-data secret is epoch-level and consumes no per-message ratchet key.
 */
export async function readSenderLeafIndex(
  context: MlsContext,
  senderDataSecret: Uint8Array,
  pm: PrivateCommitFrame,
): Promise<number | null> {
  const { hpke } = context.cipherSuite
  const sampled = sample(context, pm.ciphertext)
  const key = await expandWithLabel(context, senderDataSecret, 'key', sampled, hpke.keyLength)
  const nonce = await expandWithLabel(context, senderDataSecret, 'nonce', sampled, hpke.nonceLength)
  // SenderDataAAD = { opaque group_id<V>; uint64 epoch; ContentType content_type (uint8) }.
  const aad = concat([varLen(pm.groupId), uint64(pm.epoch), new Uint8Array([pm.contentType & 0xff])])
  let plaintext: Uint8Array
  try {
    plaintext = await hpke.decryptAead(key, nonce, aad, pm.encryptedSenderData)
  } catch {
    return null
  }
  // SenderData = { uint32 leaf_index; uint32 generation; opaque reuse_guard[4] }.
  if (plaintext.length < 4) return null
  return new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength).getUint32(0)
}
```

- [ ] **Step 2: Write the failing test**

Add `packages/mls/test/commit-header.test.ts`. Alice creates a group and invites Bob; Bob joins. Alice then authors a second member commit (inviting Carol) at Bob's current epoch — a PrivateMessage commit whose committer is Alice. Bob's handle reads its committer.

```ts
import { randomIdentity } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import { controlCapabilities } from '../src/anchor.js'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  processWelcome,
} from '../src/group.js'

async function twoMemberGroup() {
  const alice = randomIdentity()
  const bob = randomIdentity()
  const { group: aliceGroup } = await createGroup(alice, 'g', {
    capabilities: controlCapabilities(),
  })
  const bobBundle = await createKeyPackageBundle(bob, { capabilities: controlCapabilities() })
  const { invite } = await createInvite({
    group: aliceGroup,
    identity: alice,
    recipientDID: bob.id,
    permission: 'member',
  })
  const { welcomeMessage, commitMessage, newGroup: aliceAfterBob } = await commitInvite(
    aliceGroup,
    bobBundle.publicPackage,
    invite,
  )
  const { group: bobGroup } = await processWelcome({
    identity: bob,
    invite,
    welcome: welcomeMessage,
    keyPackageBundle: bobBundle,
  })
  // Bob applies Alice's add-commit is unnecessary — the Welcome lands him at the post-invite
  // epoch. Return the handles at that shared epoch.
  void commitMessage
  return { alice, bob, aliceAfterBob, bobGroup }
}

describe('GroupHandle.readCommitHeader — member commit', () => {
  test('returns the MLS-authenticated committer DID and epoch', async () => {
    const { alice, aliceAfterBob, bobGroup } = await twoMemberGroup()
    const carol = randomIdentity()
    const carolBundle = await createKeyPackageBundle(carol, {
      capabilities: controlCapabilities(),
    })
    const { invite: carolInvite } = await createInvite({
      group: aliceAfterBob,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    // Alice authors this commit at the epoch Bob is at, so Bob can read it.
    const { commitMessage } = await commitInvite(
      aliceAfterBob,
      carolBundle.publicPackage,
      carolInvite,
    )

    const header = await bobGroup.readCommitHeader(commitMessage)
    expect(header).not.toBeNull()
    expect(header?.committerDID).toBe(alice.id)
    expect(header?.epoch).toBe(bobGroup.epoch)
    // The committer the reader resolved is the DID at that sender leaf in Bob's tree.
    expect(bobGroup.findMemberLeafIndex(alice.id)).toBeDefined()
  })

  test('is non-mutating — the handle epoch is unchanged after a read', async () => {
    const { alice, aliceAfterBob, bobGroup } = await twoMemberGroup()
    const carol = randomIdentity()
    const carolBundle = await createKeyPackageBundle(carol, {
      capabilities: controlCapabilities(),
    })
    const { invite: carolInvite } = await createInvite({
      group: aliceAfterBob,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    const { commitMessage } = await commitInvite(
      aliceAfterBob,
      carolBundle.publicPackage,
      carolInvite,
    )
    const before = bobGroup.epoch
    await bobGroup.readCommitHeader(commitMessage)
    expect(bobGroup.epoch).toBe(before)
  })
})
```

> Note: confirm the exact names `controlCapabilities`, `commitInvite`'s result field `newGroup`, and `createInvite`/`processWelcome` params against `packages/mls/test/anchor.test.ts` and `packages/mls/src/group.ts` before running — mirror that file's imports verbatim. If `commitInvite` returns the advanced group under a different field name, adjust `aliceAfterBob`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/mls && pnpm exec vitest run test/commit-header.test.ts`
Expected: FAIL — `bobGroup.readCommitHeader is not a function`.

- [ ] **Step 4: Add `readPrivateCommitFrame` and the method to `group-handle.ts`**

Add the import near the other `./` imports:

```ts
import { readMessageEpoch } from './group-info.js'
import { readSenderLeafIndex } from './sender-data.js'
```

Add a structural narrower next to `readPrivateCommit` (which stays as is — it returns only `authenticatedData`; this one returns the fields sender-data decrypt needs):

```ts
/**
 * Narrow a decoded frame to the PrivateMessage-commit fields sender-data decrypt reads.
 * Returns undefined for anything that is not a PrivateMessage of contentType commit.
 */
function readPrivateCommitFrame(decoded: unknown): PrivateCommitFrame | undefined {
  if (decoded == null || typeof decoded !== 'object') return undefined
  const frame = decoded as { wireformat?: unknown; privateMessage?: unknown }
  if (frame.wireformat !== wireformats.mls_private_message) return undefined
  const pm = frame.privateMessage as
    | {
        groupId?: unknown
        epoch?: unknown
        contentType?: unknown
        encryptedSenderData?: unknown
        ciphertext?: unknown
      }
    | undefined
  if (pm == null || pm.contentType !== contentTypes.commit) return undefined
  if (
    !(pm.groupId instanceof Uint8Array) ||
    typeof pm.epoch !== 'bigint' ||
    !(pm.encryptedSenderData instanceof Uint8Array) ||
    !(pm.ciphertext instanceof Uint8Array)
  ) {
    return undefined
  }
  return {
    groupId: pm.groupId,
    epoch: pm.epoch,
    contentType: pm.contentType,
    encryptedSenderData: pm.encryptedSenderData,
    ciphertext: pm.ciphertext,
  }
}
```

Add the `PrivateCommitFrame` type to the `sender-data.js` import:

```ts
import { type PrivateCommitFrame, readSenderLeafIndex } from './sender-data.js'
```

Add the private leaf→DID helper and the public method to the `GroupHandle` class (place the method near `processMessage`):

```ts
/** The DID at a ratchet-tree leaf index, or undefined if that leaf is empty/unparsable. */
#didOfLeaf(leafIndex: number): string | undefined {
  for (const member of this.#iterateMembers()) {
    if (member.leafIndex === leafIndex) return member.id
  }
  return undefined
}

/**
 * Read a Commit's MLS-authenticated committer against this handle, WITHOUT advancing
 * state. `null` for bytes that are not a Commit.
 *
 * A member commit (PrivateMessage) has its committer encrypted under the epoch's
 * sender-data secret: decrypt it to the sender leaf index and resolve that against this
 * handle's ratchet tree — the same leaf->DID the commit policy sees as
 * `didOfLeaf(senderLeafIndex)`. An external commit's committer rides its UpdatePath leaf
 * (see {@link readExternalCommit}) — added in the external-commit path.
 *
 * Runs on the handle mutex so the epoch secret, tree, and epoch are one snapshot against a
 * concurrent processMessage. Non-mutating: sender-data decrypt is epoch-level and consumes
 * no per-message key. Async only because the KDF and AEAD are.
 */
async readCommitHeader(
  commit: Uint8Array,
): Promise<{ epoch: bigint; committerDID: string } | null> {
  return mutexFor(this).run(async () => {
    const decoded = decode(mlsMessageDecoder, commit)
    if (decoded == null) return null
    const epoch = readMessageEpoch(commit)
    if (epoch == null) return null

    const pm = readPrivateCommitFrame(decoded)
    if (pm == null) return null // external + non-commit handled next task
    const leafIndex = await readSenderLeafIndex(
      this.#context,
      this.#state.keySchedule.senderDataSecret,
      pm,
    )
    if (leafIndex == null) return null
    const committerDID = this.#didOfLeaf(leafIndex)
    return committerDID == null ? null : { epoch, committerDID }
  })
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/mls && pnpm exec vitest run test/commit-header.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Type-check**

Run: `cd packages/mls && pnpm run build:types`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/mls/src/sender-data.ts packages/mls/src/group-handle.ts packages/mls/test/commit-header.test.ts
git commit -m "feat(mls): read a member commit's authenticated committer without advancing state"
```

---

## Task 2: external-commit and non-commit paths

**Files:**
- Modify: `packages/mls/src/group-handle.ts`
- Test: `packages/mls/test/commit-header.test.ts`

**Interfaces:**
- Consumes: `readExternalCommit(decoded)` (existing helper in `group-handle.ts`), `joinGroupExternal` (from `../src/group.js`).
- Produces: `readCommitHeader` now also returns `{ epoch, committerDID }` for an external commit and `null` for non-commit frames.

- [ ] **Step 1: Write the failing tests**

Append to `packages/mls/test/commit-header.test.ts`. Reuse the `twoMemberGroup` helper. Add imports `exportGroupInfo`, `joinGroupExternal`, `makeMLSCredential` (mirror `packages/mls/test/external-rejoin.test.ts` for the exact credential/rejoin setup — copy its imports and the `bobCred` construction verbatim).

```ts
import { exportGroupInfo, joinGroupExternal } from '../src/group.js'

describe('GroupHandle.readCommitHeader — external commit and non-commit', () => {
  test('returns the rejoiner as committer for an external commit', async () => {
    const { bob, aliceAfterBob, bobGroup } = await twoMemberGroup()
    // Advance Alice past Bob so Bob is stale and must rejoin externally.
    // (Mirror external-rejoin.test.ts: build bobCred, exportGroupInfo, joinGroupExternal.)
    const { groupInfo } = await exportGroupInfo({ group: aliceAfterBob })
    const bobCred = bobGroup.credential // the member credential Bob rejoins with
    const { commitMessage } = await joinGroupExternal({
      identity: bob,
      groupInfo,
      credential: bobCred,
      resync: true,
    })

    const header = await aliceAfterBob.readCommitHeader(commitMessage)
    expect(header).not.toBeNull()
    expect(header?.committerDID).toBe(bob.id)
    // External commit's header epoch is the pre-commit (sending) epoch.
    expect(header?.epoch).toBe(aliceAfterBob.epoch)
  })

  test('returns null for a non-commit frame and for garbage bytes', async () => {
    const { aliceAfterBob, bobGroup } = await twoMemberGroup()
    // An application message is a PrivateMessage that is NOT a commit.
    const appMessage = await aliceAfterBob.encrypt(new TextEncoder().encode('hi'))
    expect(await bobGroup.readCommitHeader(appMessage)).toBeNull()
    expect(await bobGroup.readCommitHeader(new Uint8Array([0xff, 0xff]))).toBeNull()
    expect(await bobGroup.readCommitHeader(new Uint8Array())).toBeNull()
  })
})
```

> Note: `bobGroup.credential` returns the `MemberCredential` — confirm `joinGroupExternal`'s `credential` param expects exactly that type; if `external-rejoin.test.ts` constructs `bobCred` differently (e.g. via `makeMLSCredential`), copy that construction. Do not invent a credential shape.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/mls && pnpm exec vitest run test/commit-header.test.ts -t "external commit and non-commit"`
Expected: FAIL — the external test returns `null` (external path not yet added). The non-commit test may already pass; that is fine.

- [ ] **Step 3: Add the external-commit branch**

In `readCommitHeader`, insert the external-commit check between the epoch read and the member-commit narrow:

```ts
    const epoch = readMessageEpoch(commit)
    if (epoch == null) return null

    // External-join commit: the committer holds no pre-commit leaf, so its DID rides the
    // commit's own UpdatePath leaf. No tree lookup, no sender-data decrypt.
    const external = readExternalCommit(decoded)
    if (external != null) {
      return external.did == null ? null : { epoch, committerDID: external.did }
    }

    const pm = readPrivateCommitFrame(decoded)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/mls && pnpm exec vitest run test/commit-header.test.ts`
Expected: PASS (all four tests).

- [ ] **Step 5: Full mls suite + type-check**

Run: `cd packages/mls && pnpm run test:unit && pnpm run build:types`
Expected: no failures (nothing else calls `readCommitHeader`; existing tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add packages/mls/src/group-handle.ts packages/mls/test/commit-header.test.ts
git commit -m "feat(mls): resolve the external committer and null non-commits in readCommitHeader"
```

---

## Task 3: async, handle-bound `GroupMLS.readCommitHeader` in `@kumiai/rpc`

**Files:**
- Modify: `packages/rpc/src/crypto.ts`
- Modify: `packages/rpc/src/peer.ts` (lines ~704, ~1370)
- Modify: `packages/rpc/test/fixtures/memory-group-mls.ts`
- Modify: `packages/rpc/test/group-mls.test.ts` (lines ~42–44, ~139)

**Interfaces:**
- Consumes: `CommitHeader` (unchanged shape `{ epoch: number; committerDID: string }`), `classifyCommit(header, sequenceID, state)` (unchanged — still synchronous over an already-resolved header).
- Produces: `GroupMLS.readCommitHeader(commit: Uint8Array): Promise<CommitHeader | null>`.

- [ ] **Step 1: Update the fixture to async, and the direct test calls to await (the failing test)**

In `packages/rpc/test/fixtures/memory-group-mls.ts`, change the method signature to async (the body is unchanged — it reads cleartext JSON and holds no handle):

```ts
    async readCommitHeader(commit: Uint8Array): Promise<CommitHeader | null> {
      // Reads the commit's own bytes and nothing else: no epoch secret, no blob, no state.
      const parsed = decodeMemoryCommit(commit)
      return parsed == null ? null : { epoch: parsed.epoch, committerDID: parsed.committerDID }
    },
```

In `packages/rpc/test/group-mls.test.ts`, make the enclosing test functions `async` and await the calls at lines ~42–44 and ~139:

```ts
    expect(await reader.readCommitHeader(commit)).toEqual({ epoch: 4, committerDID: 'admin' })
    expect(await reader.readCommitHeader(new Uint8Array([0xff, 0xff]))).toBeNull()
    expect(await reader.readCommitHeader(new Uint8Array())).toBeNull()
```

```ts
    expect(await stranded.readCommitHeader(pending?.commit as Uint8Array)).toEqual({
      // ...unchanged expected object...
    })
```

- [ ] **Step 2: Run to verify the type/call mismatch fails**

Run: `cd packages/rpc && pnpm run build:types`
Expected: FAIL — the port type still declares the sync return, so `async` fixture and `await`ed calls mismatch `readCommitHeader(commit): CommitHeader | null`.

- [ ] **Step 3: Relax the port type and doc comment in `crypto.ts`**

Change the `GroupMLS.readCommitHeader` declaration and its doc comment:

```ts
  /**
   * Read what a Commit says about itself — epoch and committer — WITHOUT advancing state.
   * `null` for bytes that are not a Commit. Lets the lane classify a frame (epoch = this
   * peer's to apply? committer = this peer's own?) before touching it; neither question may
   * be answered by trying and failing.
   *
   * Async and handle-bound: a real host recovers a member commit's committer by decrypting
   * its sender-data with the epoch secret (an open, not an apply) and mapping the sender leaf
   * to a DID against the ratchet tree — both reachable only on the handle the host already
   * holds. The port reaches its own handle internally; the lane awaits.
   */
  readCommitHeader(commit: Uint8Array): Promise<CommitHeader | null>
```

- [ ] **Step 4: Await the two lane call sites in `peer.ts`**

Line ~704:

```ts
        const disposition = classifyCommit(
          await port.readCommitHeader(commitFrame.commit),
          position,
          { localDID, epoch: crypto.epoch(), appliedByEpoch },
        )
```

Line ~1370:

```ts
        const rejoinedAtEpoch = (await port.readCommitHeader(pending.commit))?.epoch
```

Both call sites are already inside `async` functions (they use `await` elsewhere) — no signature change to the enclosing functions. `classifyCommit` itself is untouched.

- [ ] **Step 5: Run type-check and the rpc suite**

Run: `cd packages/rpc && pnpm run build:types && pnpm run test:unit`
Expected: PASS. The lane behavior is unchanged — only the read is now awaited; the fixture returns the same values.

- [ ] **Step 6: Commit**

```bash
git add packages/rpc/src/crypto.ts packages/rpc/src/peer.ts packages/rpc/test/fixtures/memory-group-mls.ts packages/rpc/test/group-mls.test.ts
git commit -m "feat(rpc): make GroupMLS.readCommitHeader async and handle-bound"
```

---

## Task 4: full-workspace verification

**Files:** none (verification only).

- [ ] **Step 1: Lint the workspace**

Run: `rtk proxy pnpm run lint`
Expected: no findings on the changed files. Fix any and amend the relevant commit.

- [ ] **Step 2: Type-check every package**

Run: `pnpm exec turbo run build:types`
Expected: all packages pass.

- [ ] **Step 3: Run the mls and rpc unit suites**

Run: `cd packages/mls && pnpm run test:unit && cd ../rpc && pnpm run test:unit`
Expected: all green.

- [ ] **Step 4: Confirm no stray sync `readCommitHeader` callers remain**

Run: `grep -rn "readCommitHeader" packages --include=*.ts | grep -v "await\|Promise<CommitHeader\|async readCommitHeader\|readCommitHeader(commit: Uint8Array): Promise"`
Expected: no call site that invokes `readCommitHeader` without `await` (declarations/types are fine).

---

## Acceptance (from the spec)

- A member PrivateMessage commit at the handle's epoch → the committer DID the commit authenticates, equal to `didOfLeaf(senderLeafIndex)` (Task 1).
- An external commit → its UpdatePath committer; non-commit bytes → `null` (Task 2).
- `classifyCommit` discriminates own-authored commits by the authenticated committer, not the transport sender — unchanged, now fed an obtainable header (Task 3).
- Downstream (kubun `plugin-p2p`) can implement the port by delegating to `GroupHandle.readCommitHeader` and narrowing `bigint`→`number`. Not verifiable in this repo; the async, handle-bound signature is the enabling change.

## Self-Review notes

- **Spec coverage:** R1 → Tasks 1–2. R2 → Task 3. Sender-data reimpl → Task 1. Tests → Tasks 1–2 (mls), Task 3 (rpc). Backlog/doc-comment → already committed / Task 3 Step 3. All covered.
- **Type consistency:** `readCommitHeader` returns `Promise<{ epoch: bigint; committerDID: string } | null>` in mls, `Promise<CommitHeader | null>` (`epoch: number`) in rpc — the host narrows; the two are deliberately different and documented. `PrivateCommitFrame`, `readSenderLeafIndex`, `#didOfLeaf` names are used identically where referenced.
- **Open verification points flagged inline:** exact mls test-helper names (`controlCapabilities`, `commitInvite` result field, `joinGroupExternal` credential shape) must be confirmed against `anchor.test.ts` / `external-rejoin.test.ts` / `group.ts` before running — mirror those files rather than guessing.
