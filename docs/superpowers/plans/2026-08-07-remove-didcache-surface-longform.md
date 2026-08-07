# Remove `DIDCache` from `GroupHandle`, surface `longForm` on `GroupMember` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the never-read `DIDCache`/`DIDResolver` plumbing from `@kumiai/mls` and replace it
with the thing consumers actually need — the resolvable long form each MLS leaf already carries.

**Architecture:** `GroupHandle.#iterateMembers` already parses every leaf's credential identity,
which carries `longForm` for `did:peer:4`, and throws that field away. Task 1 keeps it on
`GroupMember`. Task 2 adds a by-DID lookup beside `findMemberLeafIndex`. Task 3 deletes the cache
and resolver from every entry point, since no document a consumer can reach lives anywhere but a
signed artifact.

**Tech Stack:** TypeScript, pnpm workspaces, turbo, vitest, biome, ts-mls, `@kokuin/token`.

**Spec:** `docs/superpowers/specs/2026-08-07-remove-didcache-surface-longform-design.md`

## Global Constraints

- pnpm only. Never npm or yarn.
- Never edit generated files under `packages/*/lib/`. They are rebuilt from `src/`.
- Internal `@kumiai/*` deps are `workspace:^`; cross-repo deps go through the workspace catalog as
  published `^` ranges.
- Run repo scripts as `rtk proxy pnpm run <script>`, or invoke the tool directly
  (`pnpm --filter <pkg> exec <tool>`). A bare `pnpm run <script>` may be intercepted by a local
  shim and run the wrong tool. Every command in this plan is already written in the safe form —
  use them verbatim.
- `@kumiai` is pre-1.0 and all eleven publishable packages share one minor
  (`scripts/check-versions.mjs`, enforced by `tests/integration/test/version-band.test.ts`). A minor
  bump is therefore a group act: the changeset in Task 3 lists every publishable package.
- Public API doc comments carry the non-obvious *why* and nothing else. Do not restate what a
  signature already says.

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/mls/src/credential.ts` | MLS credential identity types + parsing | Add `longForm` to `GroupMember` (Task 1); delete `populateCacheFromCredential` (Task 3) |
| `packages/mls/src/group-handle.ts` | The group handle | Fill `longForm` in `#iterateMembers` (Task 1); add `findMemberLongForm` (Task 2); drop cache/resolver params, fields, getters, passthrough (Task 3) |
| `packages/mls/src/types.ts` | `GroupOptions` | Drop `cache`/`resolver` (Task 3) |
| `packages/mls/src/group-create.ts` | `createGroup` | Drop cache defaults and args (Task 3) |
| `packages/mls/src/group-welcome.ts` | `processWelcome`, `restoreGroup` | Drop cache defaults and args (Task 3) |
| `packages/mls/src/index.ts` | Public surface | Drop `populateCacheFromCredential` export (Task 3) |
| `packages/mls/test/member-long-form.test.ts` | **New.** Covers the long-form field and lookup | Created in Task 1, extended in Task 2 |
| `packages/mls/test/credential.test.ts` | Credential unit tests | Delete the `populateCacheFromCredential` block (Task 3) |
| `packages/mls/test/recovery-forgery.test.ts` | Forged-reply tests; builds a `GroupHandle` directly | Drop the `cache` parameter and its three call sites (Task 3) |

---

### Task 1: `GroupMember.longForm`

**Files:**
- Create: `packages/mls/test/member-long-form.test.ts`
- Modify: `packages/mls/src/credential.ts:33-38` (the `GroupMember` type)
- Modify: `packages/mls/src/group-handle.ts:526-543` (`#iterateMembers`)

**Interfaces:**
- Consumes: `createGroup(identity, groupID, options?)` from `../src/group.js`, returning
  `{ group: GroupHandle, credential: MemberCredential }`. `createIdentity` and `randomIdentity`
  from `@kokuin/token`.
- Produces: `GroupMember.longForm: string` — non-optional, read by Task 2 and by the consumer in
  kubun.

- [ ] **Step 1: Write the failing test**

Create `packages/mls/test/member-long-form.test.ts`:

```ts
import { createIdentity, randomIdentity } from '@kokuin/token'
import { describe, expect, it } from 'vitest'

import { createGroup } from '../src/group.js'

/** A did:peer:4 identity carrying the signing and agreement keys a real member holds. */
function peer4Identity() {
  return createIdentity({
    keys: [
      { purpose: 'sig', alg: 'EdDSA' },
      { purpose: 'kem', alg: 'X25519' },
    ],
    didMethod: 'peer:4',
  })
}

describe('GroupMember.longForm', () => {
  it('reports the leaf long form for a did:peer:4 member', async () => {
    const identity = await peer4Identity()
    const { group } = await createGroup(identity, 'long-form-peer4')

    const member = group.listMembers()[0]
    expect(member?.id).toBe(identity.id)
    expect(member?.longForm).toBe(identity.longForm)
    // Asserted separately from the equality above, and deliberately: the short form is NOT
    // resolvable — kokuin's resolveX25519Key refuses one outright — so a member reported with
    // `longForm === id` would be silently useless to the consumer this field exists for.
    expect(member?.longForm).not.toBe(member?.id)
  })

  it('reports `id` as the long form for a did:key member, where the two are the same string', async () => {
    const identity = randomIdentity()
    const { group } = await createGroup(identity, 'long-form-didkey')

    const member = group.listMembers()[0]
    expect(member?.id).toBe(identity.id)
    expect(member?.longForm).toBe(identity.id)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @kumiai/mls exec vitest run test/member-long-form.test.ts
```

Expected: both tests FAIL. `member?.longForm` is `undefined` because `GroupMember` has no such
field yet.

- [ ] **Step 3: Run the type check to verify it also fails**

```bash
pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
```

Expected: FAIL — `Property 'longForm' does not exist on type 'GroupMember'`. vitest strips types, so
the unit run alone proves nothing about whether the test compiles. Both gates must go red before
either goes green.

- [ ] **Step 4: Add the field to `GroupMember`**

In `packages/mls/src/credential.ts`, replace the `GroupMember` type:

```ts
export type GroupMember = {
  /** MLS leaf index (ratchet-tree array position / 2, matching findMemberLeafIndex). */
  leafIndex: number
  /** DID parsed from the leaf's MLS credential identity. */
  id: string
  /**
   * The resolvable form of `id`: the leaf's `longForm` for did:peer:4, and `id` itself for
   * did:key, where long form and short form are the same string. Never absent.
   *
   * This is why `@kumiai/mls` holds no DID cache. Every document a consumer can reach is
   * already inside a signed artifact — a current member's in this leaf, which is signed and
   * can never be rewritten, and a ledger author's in their own token, which `signLedgerEntry`
   * gives `{ embedLongForm: true }` for exactly that reason. A cache alongside those would be
   * an unsigned second copy of authenticated state.
   */
  longForm: string
}
```

- [ ] **Step 5: Fill the field in `#iterateMembers`**

In `packages/mls/src/group-handle.ts`, in `#iterateMembers`, replace the `yield`:

```ts
          // `?? parsed.id` is the did:key case, where long form IS the id. It is unreachable
          // for peer:4: makeMLSCredential refuses to build a peer:4 identity without a long
          // form, and validateCredential rejects any peer:4 leaf lacking one before it can
          // enter a ratchet tree.
          yield { leafIndex: i / 2, id: parsed.id, longForm: parsed.longForm ?? parsed.id }
```

- [ ] **Step 6: Run both gates to verify they pass**

```bash
pnpm --filter @kumiai/mls exec vitest run test/member-long-form.test.ts
pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
```

Expected: 2 tests PASS, type check exits 0.

- [ ] **Step 7: Mutation-check the peer:4 test**

Temporarily change the yield in `group-handle.ts` to `longForm: parsed.id`, then run:

```bash
pnpm --filter @kumiai/mls exec vitest run test/member-long-form.test.ts
```

Expected: the `did:peer:4` test FAILS (the did:key one still passes — correct, `id` is the answer
there). **Restore `parsed.longForm ?? parsed.id` and re-run to confirm green before continuing.** A
test that passes against a broken implementation is not a test.

- [ ] **Step 8: Lint and commit**

```bash
rtk proxy pnpm run lint
git add packages/mls/src/credential.ts packages/mls/src/group-handle.ts packages/mls/test/member-long-form.test.ts
git commit -m "feat(mls): report each member's resolvable long form on GroupMember"
```

---

### Task 2: `GroupHandle.findMemberLongForm`

**Files:**
- Modify: `packages/mls/test/member-long-form.test.ts` (append a describe block)
- Modify: `packages/mls/src/group-handle.ts:545-552` (add a method after `findMemberLeafIndex`)

**Interfaces:**
- Consumes: `GroupMember.longForm: string` from Task 1; the `peer4Identity()` helper and the
  `createGroup` / `randomIdentity` imports already at the top of `member-long-form.test.ts` from
  Task 1 — this task appends to that file, so all four are in scope; `normalizeDID` from
  `@kokuin/token`, already imported at `group-handle.ts:1`. `createIdentity` types `longForm` as a
  non-optional `DIDString`, so it can be passed straight to a `string` parameter.
- Produces: `findMemberLongForm(id: string): string | undefined` on `GroupHandle`.

- [ ] **Step 1: Write the failing test**

Append to `packages/mls/test/member-long-form.test.ts`:

```ts
describe('GroupHandle.findMemberLongForm', () => {
  it('resolves a did:peer:4 member given their short form', async () => {
    const identity = await peer4Identity()
    const { group } = await createGroup(identity, 'lookup-short')

    expect(group.findMemberLongForm(identity.id)).toBe(identity.longForm)
  })

  it('resolves the same member given their long form', async () => {
    const identity = await peer4Identity()
    const { group } = await createGroup(identity, 'lookup-long')

    // normalizeDID truncates a peer:4 long form to its short form, so a caller holding either
    // form finds the member. A consumer that has just read `longForm` off one member and wants
    // another's should not have to normalize first.
    expect(group.findMemberLongForm(identity.longForm)).toBe(identity.longForm)
  })

  it('resolves a did:key member to their id', async () => {
    const identity = randomIdentity()
    const { group } = await createGroup(identity, 'lookup-didkey')

    expect(group.findMemberLongForm(identity.id)).toBe(identity.id)
  })

  it('returns undefined for a DID that is not a member', async () => {
    const identity = await peer4Identity()
    const stranger = await peer4Identity()
    const { group } = await createGroup(identity, 'lookup-stranger')

    // undefined means "no such member", and only that. It never means "this member has no
    // long form" — every member has one.
    expect(group.findMemberLongForm(stranger.id)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run both gates to verify they fail**

```bash
pnpm --filter @kumiai/mls exec vitest run test/member-long-form.test.ts
pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
```

Expected: the four new tests FAIL, and the type check FAILS with
`Property 'findMemberLongForm' does not exist on type 'GroupHandle'`.

- [ ] **Step 3: Implement the method**

In `packages/mls/src/group-handle.ts`, immediately after `findMemberLeafIndex`:

```ts
  /**
   * The resolvable form of a member's DID — the string to hand a DID resolver or a JWE
   * recipient — or `undefined` when the group has no such member. `undefined` carries that one
   * meaning: every member has a long form.
   *
   * Accepts either form of `id`, normalizing both sides exactly as {@link findMemberLeafIndex}
   * does, so a caller holding a long form read off another leaf need not truncate it first.
   */
  findMemberLongForm(id: string): string | undefined {
    const targetNorm = normalizeDID(id)
    for (const member of this.#iterateMembers()) {
      if (normalizeDID(member.id) === targetNorm) return member.longForm
    }
    return undefined
  }
```

- [ ] **Step 4: Run both gates to verify they pass**

```bash
pnpm --filter @kumiai/mls exec vitest run test/member-long-form.test.ts
pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
```

Expected: 6 tests PASS, type check exits 0.

- [ ] **Step 5: Mutation-check the long-form lookup**

Temporarily change the first line of the method body to `const targetNorm = id`, then run:

```bash
pnpm --filter @kumiai/mls exec vitest run test/member-long-form.test.ts
```

Expected: `resolves the same member given their long form` FAILS; the short-form tests still pass.
**Restore `normalizeDID(id)` and re-run to confirm green.**

- [ ] **Step 6: Lint and commit**

```bash
rtk proxy pnpm run lint
git add packages/mls/src/group-handle.ts packages/mls/test/member-long-form.test.ts
git commit -m "feat(mls): add findMemberLongForm to look a member's resolvable DID up by either form"
```

---

### Task 3: Remove `DIDCache` and `DIDResolver` from the package

**Files:**
- Modify: `packages/mls/src/types.ts:1,56-59`
- Modify: `packages/mls/src/group-handle.ts:1,250-251,265-266,284-285,328-334,1059-1060`
- Modify: `packages/mls/src/group-create.ts:1,28,82-83,101,108-109`
- Modify: `packages/mls/src/group-welcome.ts:1,49,101-102,212,267-268`
- Modify: `packages/mls/src/credential.ts:1,74-90`
- Modify: `packages/mls/src/index.ts:30-36`
- Modify: `packages/mls/test/credential.test.ts:1,9,67-99`
- Modify: `packages/mls/test/recovery-forgery.test.ts:259,265,297,345,407`
- Create: `.changeset/remove-didcache-surface-longform.md`
- Delete: `docs/agents/plans/next/2026-08-07-didcache-inert-end-to-end.md`

**Interfaces:**
- Consumes: nothing from Tasks 1 and 2 at the code level; they are sequenced first so the
  replacement reader exists on the branch before the removal lands.
- Produces: a `GroupOptions` and `GroupHandleParams` with no `cache` or `resolver`, and a package
  index with no `populateCacheFromCredential`.

- [ ] **Step 1: Delete the `populateCacheFromCredential` tests**

In `packages/mls/test/credential.test.ts`, delete the whole
`describe('populateCacheFromCredential', ...)` block (lines 67-99), and update the imports:

```ts
import { createIdentity } from '@kokuin/token'
```

(dropping `createInMemoryDIDCache`; `createIdentity` is still used by the `makeMLSCredential`
block), and

```ts
import {
  didFromCredential,
  type MemberCredential,
  parseMLSCredentialIdentity,
} from '../src/credential.js'
```

(dropping `populateCacheFromCredential`).

- [ ] **Step 2: Run the type check to see it go red on the source that still exists**

```bash
pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
```

Expected: exits 0. Deleting tests cannot fail a type check — this step exists to confirm the file
still compiles after the import edit, before you start cutting source. If it fails, the import
edit is wrong; fix it before Step 3.

- [ ] **Step 3: Delete `populateCacheFromCredential` and its export**

In `packages/mls/src/credential.ts`, delete lines 74-90 (the doc comment and the whole function),
and change the first import to drop `DIDCache`:

```ts
import { decodePeer4, isPeer4, normalizeDID } from '@kokuin/token'
```

Then check whether `decodePeer4` and `isPeer4` are still used in that file. They are not — the
deleted function was their only consumer — so the import becomes:

```ts
import { normalizeDID } from '@kokuin/token'
```

In `packages/mls/src/index.ts`, remove `populateCacheFromCredential` from the `./credential.js`
export block, leaving:

```ts
export {
  type GroupMember,
  type MemberCredential,
  type MLSCredentialIdentity,
  parseMLSCredentialIdentity,
} from './credential.js'
```

- [ ] **Step 4: Drop `cache` and `resolver` from `GroupOptions`**

In `packages/mls/src/types.ts`, delete line 1 (`import type { DIDCache, DIDResolver } from '@kokuin/token'`)
and delete these four lines from `GroupOptions`:

```ts
  /** Optional DID cache for resolving did:peer:4 issuers when verifying ledger entries. Default: in-memory. */
  cache?: DIDCache
  /** Optional resolver for did:peer:4 short forms not in cache. */
  resolver?: DIDResolver
```

- [ ] **Step 5: Drop them from `GroupHandle`**

In `packages/mls/src/group-handle.ts`:

- line 1: change `import { type DIDCache, type DIDResolver, normalizeDID } from '@kokuin/token'` to
  `import { normalizeDID } from '@kokuin/token'`
- lines 250-251: delete `cache: DIDCache` and `resolver?: DIDResolver` from `GroupHandleParams`
- lines 265-266: delete the `#cache` and `#resolver` field declarations
- lines 284-285: delete `this.#cache = params.cache` and `this.#resolver = params.resolver`
- lines 328-334: delete the `get cache()` and `get resolver()` accessors, including their doc
  comments
- lines 1059-1060: delete `cache: group.cache,` and `resolver: group.resolver,` from the
  `new GroupHandle({ ... })` in `deriveGroup`

- [ ] **Step 6: Drop them from the group entry points**

In `packages/mls/src/group-create.ts`:

- line 1: change to `import { normalizeDID, type OwnIdentity } from '@kokuin/token'`
- line 28: delete `const cache = options?.cache ?? createInMemoryDIDCache()`
- lines 82-83: delete `cache,` and `resolver: options?.resolver,`
- line 101: delete `const cache = params.options?.cache ?? createInMemoryDIDCache()`
- lines 108-109: delete `cache,` and `resolver: params.options?.resolver,`

In `packages/mls/src/group-welcome.ts`:

- line 1: change to `import { normalizeDID, type OwnIdentity } from '@kokuin/token'`
- line 49: delete `const cache = options?.cache ?? createInMemoryDIDCache()`
- lines 101-102: delete `cache,` and `resolver: options?.resolver,`
- line 212: delete `const cache = options?.cache ?? createInMemoryDIDCache()`
- lines 267-268: delete `cache,` and `resolver: options?.resolver,`

- [ ] **Step 7: Fix the one test that builds a `GroupHandle` directly**

In `packages/mls/test/recovery-forgery.test.ts`, remove the parameter at line 259 and the argument
at line 265, leaving:

```ts
async function exportForged(
  state: ClientState,
  creator: OwnIdentity,
  groupID: string,
  context: MlsContext,
): Promise<Uint8Array> {
  const handle = new GroupHandle({
    state,
    credential: { id: creator.id, groupID },
    context,
  })
  return (await exportGroupInfo({ group: handle })).groupInfo
}
```

Then remove the trailing `carolGroup.cache,` argument from all three `exportForged(...)` call sites
(around lines 297, 345, 407 before the edits shift them). Search for `carolGroup.cache` to be sure
none remain.

- [ ] **Step 8: Verify nothing references the removed API**

```bash
grep -rn 'DIDCache\|DIDResolver\|createInMemoryDIDCache\|populateCacheFromCredential' packages/mls/src packages/mls/test
```

Expected: **no output.** Matches under `packages/mls/lib/` are stale generated files and are not a
failure — do not edit them; they are rebuilt from `src/`.

- [ ] **Step 9: Run the full test suite, uncached**

```bash
pnpm exec turbo run test:types test:unit --force
```

Expected: all tasks successful, and the summary line reads `Cached: 0`. A run reporting cached
results proves nothing about the code you just changed — check that line explicitly.

- [ ] **Step 10: Write the changeset**

A breaking removal on a pre-1.0 band is a group act: every publishable package takes the minor, or
`scripts/check-versions.mjs` fails the next release. Create
`.changeset/remove-didcache-surface-longform.md`:

```markdown
---
'@kumiai/broadcast': minor
'@kumiai/hub-client': minor
'@kumiai/hub-conformance': minor
'@kumiai/hub-protocol': minor
'@kumiai/hub-server': minor
'@kumiai/hub-tunnel': minor
'@kumiai/mls': minor
'@kumiai/mls-hub': minor
'@kumiai/mls-rpc': minor
'@kumiai/rpc': minor
'@kumiai/rpc-conformance': minor
---

**Breaking (`@kumiai/mls`):** `GroupOptions.cache`, `GroupOptions.resolver`, the matching
`GroupHandle` params and getters, and the exported `populateCacheFromCredential` are gone. Nothing
in the package ever read or wrote either one, so a consumer passing a cache was getting a
passthrough that would report a miss for a document it had been told would be there.

`GroupMember` now carries `longForm`, the resolvable form of `id` — the leaf's long form for
did:peer:4, `id` itself for did:key — and `GroupHandle.findMemberLongForm(id)` looks it up by
either form. That is what a consumer needing a member's DID document should use: it reads the
signed leaf rather than an unsigned copy beside it.

The rest of the band takes the minor because all eleven packages share one pre-1.0 version band.
```

- [ ] **Step 11: Delete the superseded plan document**

```bash
git rm docs/agents/plans/next/2026-08-07-didcache-inert-end-to-end.md
```

If git reports the file is untracked, use `rm` instead. It posed the question this work answers and
nothing in it survives the answer, so it is deleted rather than archived.

- [ ] **Step 12: Lint and commit**

```bash
rtk proxy pnpm run lint
git add -A packages/mls .changeset docs/agents/plans
git commit -m "feat(mls)!: remove the inert DIDCache and DIDResolver from GroupHandle

Both were accepted, stored, exposed and carried onto derived handles, and
never read or written. Every DID document a consumer can reach already lives
in a signed artifact, so the replacement is GroupMember.longForm and
findMemberLongForm rather than a cache."
```

---

## Follow-up outside this plan

kubun's `plugin-p2p` threads a `DIDCache` into `createGroup` via
`MLSGroupHandleParams.cache` (`kubun/packages/plugin-p2p/src/groups/mls-group-handle.ts:37`, spread
at `:61`) and `GroupHandleRegistry.#didCache` (`.../groups/group-handle-registry.ts:106,137,146`).

The spread is `...(params.cache != null ? { cache: params.cache } : {})`, and **TypeScript does not
excess-property-check spreads** — so kubun will keep compiling green against a `GroupOptions` that
no longer declares the field. That cleanup has to be done deliberately in kubun; no build will
report it. It is tracked from kubun's credential-store spec
(`kubun/docs/superpowers/specs/2026-08-07-credential-store-design.md`) and is out of scope here.
