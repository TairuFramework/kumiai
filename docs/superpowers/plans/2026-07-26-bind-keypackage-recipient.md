# Bind a Key Package's Credential DID to the Invite Recipient — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** executing
**Mode:** tasks
**Spec:** `docs/superpowers/specs/2026-07-26-bind-keypackage-recipient-design.md`

**Goal:** Make `commitInvite` refuse a key package whose credential DID is not the identity the invite's enacted role entry grants a role to, so the MLS membership and the roster cannot silently disagree.

**Architecture:** One new guard inside `commitInvite`, placed after `entriesAddedByInvite` and before the Add proposal is built. It verifies the invite's newly-enacted ledger tokens, requires exactly one `kumiai.role` entry for this group, and compares that entry's `subject` against the DID parsed out of the key package's basic credential — both sides folded through `normalizeDID`. A mismatch throws a new exported `InviteRecipientMismatchError`; malformed shapes throw bare `Error`s. Nothing else in the package changes.

**Tech Stack:** TypeScript (ES2025, strict), ts-mls, `@kokuin/token`, Vitest, Biome, pnpm + turbo.

## Global Constraints

- Conventions are the `kigu:conventions` skill. Notably: `type` not `interface`; `Array<T>` not `T[]`; never `any`; **never the TypeScript `readonly`, `private`, or `protected` modifiers** — use `#field` plus a getter; class constructors take a single `ClassNameParams` object; capital `ID`/`DID` in names; `import type` for type-only imports; comments terse and about *why*.
- No plan labels, task numbers, or ticket IDs in code, comments, or `describe`/`test` names.
- Do not edit generated files (`packages/*/lib/`).
- Do not modify `package.json` scripts, lint config, or build config.
- Surgical changes only: `packages/mls/src/group-commit.ts`, `packages/mls/src/group.ts`, `packages/mls/src/index.ts`, and one new test file. Nothing else.
- Lint must be run as `rtk proxy pnpm run lint` — a shim intercepts the plain form and reports fake results.
- Getters on the new error are named `expectedDID`/`actualDID`, never bare `expected`/`actual`. `packages/mls/src/head.ts:41` records why: a test runner's diff formatter assigns those properties on any thrown Error, and a getter-only pair turns an unexpected throw into a `Cannot set property` TypeError that masks the real failure.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/mls/src/group-commit.ts` | Hosts `commitInvite` and the new guard; declares `InviteRecipientMismatchError` beside the function that throws it (matching how every other mls error lives with its thrower) | Modify |
| `packages/mls/src/group.ts` | Re-exports the group surface from `group-commit.js` | Modify (2 lines) |
| `packages/mls/src/index.ts` | Package entry point; re-exports the `group.js` block | Modify (2 lines) |
| `packages/mls/test/invite-recipient-binding.test.ts` | All tests for the new guard and error | Create |

---

## Task 1: The error class and its exports

**Files:**
- Modify: `packages/mls/src/group-commit.ts` (add after the imports, before `CreateInviteParams` at line 28)
- Modify: `packages/mls/src/group.ts` (the `./group-commit.js` export block, lines 1-9)
- Modify: `packages/mls/src/index.ts` (the large `./group.js` export block starting at line 56)
- Test: `packages/mls/test/invite-recipient-binding.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `InviteRecipientMismatchError` (class) and `InviteRecipientMismatchErrorParams` (type), both exported from `@kumiai/mls`. Constructor signature: `new InviteRecipientMismatchError({ groupID: string, expectedDID: string, actualDID: string })`. Getters: `groupID: string`, `expectedDID: string`, `actualDID: string`. `error.name === 'InviteRecipientMismatchError'`. Task 2 throws it.

- [ ] **Step 1: Write the failing test**

Create `packages/mls/test/invite-recipient-binding.test.ts`:

```ts
import { describe, expect, test } from 'vitest'

import { InviteRecipientMismatchError } from '../src/index.js'

describe('InviteRecipientMismatchError', () => {
  test('carries the group and both DIDs, and names both in its message', () => {
    const error = new InviteRecipientMismatchError({
      groupID: 'g-1',
      expectedDID: 'did:key:zBob',
      actualDID: 'did:key:zAlice',
    })

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('InviteRecipientMismatchError')
    expect(error.groupID).toBe('g-1')
    expect(error.expectedDID).toBe('did:key:zBob')
    expect(error.actualDID).toBe('did:key:zAlice')
    expect(error.message).toContain('did:key:zBob')
    expect(error.message).toContain('did:key:zAlice')
  })

  test('exposes its fields as getters, so an assignment cannot rewrite the report', () => {
    const error = new InviteRecipientMismatchError({
      groupID: 'g-1',
      expectedDID: 'did:key:zBob',
      actualDID: 'did:key:zAlice',
    })

    expect(() => {
      ;(error as unknown as { expectedDID: string }).expectedDID = 'did:key:zMallory'
    }).toThrow(TypeError)
    expect(error.expectedDID).toBe('did:key:zBob')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kumiai/mls exec vitest run test/invite-recipient-binding.test.ts`
Expected: FAIL — `InviteRecipientMismatchError` is not exported from `../src/index.js`.

- [ ] **Step 3: Add the error class**

In `packages/mls/src/group-commit.ts`, immediately after the import block and before `export type CreateInviteParams`:

```ts
export type InviteRecipientMismatchErrorParams = {
  groupID: string
  expectedDID: string
  actualDID: string
}

/**
 * Thrown by {@link commitInvite} when the supplied key package's credential DID is not the
 * identity the invite's enacted role entry grants a role to.
 *
 * Distinct from an ordinary rejection on purpose: the reachable trigger is a key-package store
 * that served the wrong owner's package, and adding the package anyway would put a different
 * identity in the group than the one the roster grants the role to. A host should alert on this.
 */
export class InviteRecipientMismatchError extends Error {
  #groupID: string
  #expectedDID: string
  #actualDID: string

  constructor(params: InviteRecipientMismatchErrorParams) {
    super(
      `commitInvite: the key package presents ${params.actualDID}, but the invite grants a role to ${params.expectedDID}`,
    )
    this.name = 'InviteRecipientMismatchError'
    this.#groupID = params.groupID
    this.#expectedDID = params.expectedDID
    this.#actualDID = params.actualDID
  }

  get groupID(): string {
    return this.#groupID
  }

  /** DID the invite's enacted role entry grants to. */
  get expectedDID(): string {
    return this.#expectedDID
  }

  /** DID the supplied key package presents. */
  get actualDID(): string {
    return this.#actualDID
  }
}
```

- [ ] **Step 4: Re-export from `group.ts`**

In `packages/mls/src/group.ts`, add the two names to the existing `from './group-commit.js'` block, keeping the block's existing ordering (uppercase names first, then lowercase, alphabetically within each):

```ts
export {
  type CommitInviteResult,
  type CommitLedgerEntriesResult,
  type CreateInviteParams,
  type CreateInviteResult,
  InviteRecipientMismatchError,
  type InviteRecipientMismatchErrorParams,
  commitInvite,
  commitLedgerEntries,
  createInvite,
} from './group-commit.js'
```

- [ ] **Step 5: Re-export from `index.ts`**

In `packages/mls/src/index.ts`, inside the large export block that ends with `} from './group.js'`, add both names in the block's existing order — after `inspectGroupInfo` and before `type JoinGroupExternalParams`:

```ts
  InviteRecipientMismatchError,
  type InviteRecipientMismatchErrorParams,
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @kumiai/mls exec vitest run test/invite-recipient-binding.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @kumiai/mls run test:types`
Expected: exit 0, no output.

- [ ] **Step 8: Lint**

Run: `rtk proxy pnpm run lint`
Expected: no errors. It may reformat; re-run the test after any reformat.

- [ ] **Step 9: Commit**

```bash
git add packages/mls/src/group-commit.ts packages/mls/src/group.ts packages/mls/src/index.ts packages/mls/test/invite-recipient-binding.test.ts
git commit -m "feat: add InviteRecipientMismatchError"
```

---

## Task 2: The binding check

**Files:**
- Modify: `packages/mls/src/group-commit.ts` — inside `commitInvite`, after the `entriesAddedByInvite` call (currently line 295)
- Test: `packages/mls/test/invite-recipient-binding.test.ts` (append)

**Interfaces:**
- Consumes: `InviteRecipientMismatchError` from Task 1.
- Produces: `commitInvite` throws `InviteRecipientMismatchError` when the key package's credential DID is not the enacted role entry's subject. Task 3 adds the malformed-shape refusals to the same guard; Task 4 adds a `did:peer:4` regression test against it.

Background the implementer needs:

- `commitInvite(group, keyPackage, invite)` lives at `packages/mls/src/group-commit.ts:285`. Its body runs inside `mutexFor(group).run(...)`; throwing from inside is fine.
- `entriesAddedByInvite(group, invite)` returns the invite's ledger tokens beyond the ones the group already holds. For an invite built by `createInvite` that is exactly one token: the invitee's role entry.
- `verifyLedgerEntry(token)` (`./ledger.js`, already imported by this file) returns `{ issuer, entry }` or `null` when the signature does not verify. `entry` is `{ type, groupID, subject, value, ord? }`.
- `ROLE_ENTRY_TYPE` is `'kumiai.role'`, exported from `./roster.js` and already imported by this file.
- `normalizeDID` (`@kokuin/token`, already imported) folds a `did:peer:4` long form to its short form and passes every other DID through unchanged. Both sides must go through it — see Task 4.
- `parseMLSCredentialIdentity` (`./credential.js`, **not yet imported by this file** — add the import) turns the credential's `identity` bytes into `{ id, longForm? }` and throws a descriptive bare `Error` on malformed bytes. Let that throw propagate; do not wrap it.
- A key package's credential is at `keyPackage.leafNode.credential`, typed as ts-mls's `Credential` union. Narrow it with `credential.credentialType !== defaultCredentialTypes.basic` (`defaultCredentialTypes` is already imported from `ts-mls`? — it is **not**; add it to the existing `ts-mls` import). After the narrow, `credential.identity` is a `Uint8Array`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/mls/test/invite-recipient-binding.test.ts`, and extend the top import block to match:

```ts
import { randomIdentity } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import { controlCapabilities } from '../src/anchor.js'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  InviteRecipientMismatchError,
  processWelcome,
} from '../src/index.js'
```

```ts
describe('commitInvite binds the key package to the invite recipient', () => {
  test('refuses a key package belonging to someone other than the invite recipient', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const mallory = randomIdentity()

    const { group } = await createGroup(alice, 'g-substitution')
    const { invite } = await createInvite({
      group,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })

    // What a key-package store that dropped its owner predicate would serve.
    const malloryBundle = await createKeyPackageBundle(mallory, {
      capabilities: controlCapabilities(),
    })

    await expect(commitInvite(group, malloryBundle.publicPackage, invite)).rejects.toThrow(
      InviteRecipientMismatchError,
    )

    const error = await commitInvite(group, malloryBundle.publicPackage, invite).catch(
      (thrown: unknown) => thrown as InviteRecipientMismatchError,
    )
    expect(error.groupID).toBe('g-substitution')
    expect(error.expectedDID).toBe(bob.id)
    expect(error.actualDID).toBe(mallory.id)
  })

  test('the refusal leaves the group at its pre-commit epoch', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const mallory = randomIdentity()

    const { group } = await createGroup(alice, 'g-no-advance')
    const epochBefore = group.epoch
    const { invite } = await createInvite({
      group,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const malloryBundle = await createKeyPackageBundle(mallory, {
      capabilities: controlCapabilities(),
    })

    await expect(commitInvite(group, malloryBundle.publicPackage, invite)).rejects.toThrow(
      InviteRecipientMismatchError,
    )
    expect(group.epoch).toBe(epochBefore)
  })

  test('the honest path still commits and the recipient joins', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()

    const { group } = await createGroup(alice, 'g-honest')
    const bobBundle = await createKeyPackageBundle(bob, { capabilities: controlCapabilities() })
    const { invite } = await createInvite({
      group,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })

    const { welcomeMessage, newGroup } = await commitInvite(group, bobBundle.publicPackage, invite)

    const { group: bobGroup } = await processWelcome({
      identity: bob,
      invite,
      welcome: welcomeMessage,
      keyPackageBundle: bobBundle,
    })

    expect(bobGroup.groupID).toBe('g-honest')
    expect(newGroup.roster.roles.get(bob.id)).toBe('member')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kumiai/mls exec vitest run test/invite-recipient-binding.test.ts`
Expected: the two refusal tests FAIL (`commitInvite` resolves instead of rejecting, or rejects with some later ts-mls error rather than `InviteRecipientMismatchError`). The honest-path test PASSES already — it is the guard against a blanket refusal, and it must stay green through this task.

- [ ] **Step 3: Add the imports**

In `packages/mls/src/group-commit.ts`, add `defaultCredentialTypes` to the existing `ts-mls` import (Biome sorts the member list on lint) and add a new import of `parseMLSCredentialIdentity`:

```ts
import {
  createCommit,
  type DefaultProposal,
  defaultCredentialTypes,
  defaultProposalTypes,
  encode,
  type GroupContextExtension,
  type KeyPackage,
  mlsMessageEncoder,
} from 'ts-mls'
```

```ts
import { parseMLSCredentialIdentity } from './credential.js'
```

- [ ] **Step 4: Add the guard**

In `commitInvite`, replace this:

```ts
    const enacted = entriesAddedByInvite(group, invite)
    const addProposal: DefaultProposal = {
```

with this:

```ts
    const enacted = entriesAddedByInvite(group, invite)

    // Bind the leaf that joins to the role this same commit grants. Without it the joining
    // identity is decided by whoever supplied the key package bytes — a store that served the
    // wrong owner's package admits that owner while the roster names someone else, and neither
    // side can see the disagreement from its own state.
    const roleSubjects: Array<string> = []
    for (const token of enacted) {
      const verified = await verifyLedgerEntry(token)
      if (verified?.entry.type === ROLE_ENTRY_TYPE && verified.entry.groupID === group.groupID) {
        roleSubjects.push(verified.entry.subject)
      }
    }
    // Exactly one, so the binding is unambiguous by construction rather than by an ordering rule.
    // createInvite always produces exactly one; anything else is a hand-built invite.
    if (roleSubjects.length !== 1) {
      throw new Error(
        `commitInvite: the invite must enact exactly one ${ROLE_ENTRY_TYPE} entry for this group, got ${roleSubjects.length}`,
      )
    }
    // biome-ignore lint/style/noNonNullAssertion: length checked directly above
    const expectedDID = normalizeDID(roleSubjects[0]!)

    const credential = keyPackage.leafNode.credential
    if (credential.credentialType !== defaultCredentialTypes.basic) {
      throw new Error(
        'commitInvite: the key package carries a non-basic credential, which names no DID to bind',
      )
    }
    const actualDID = normalizeDID(parseMLSCredentialIdentity(credential.identity).id)
    if (actualDID !== expectedDID) {
      throw new InviteRecipientMismatchError({
        groupID: group.groupID,
        expectedDID,
        actualDID,
      })
    }

    const addProposal: DefaultProposal = {
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @kumiai/mls exec vitest run test/invite-recipient-binding.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Mutation-check the guard**

Temporarily change the mismatch condition from `if (actualDID !== expectedDID) {` to `if (false) {`.

Run: `pnpm --filter @kumiai/mls exec vitest run test/invite-recipient-binding.test.ts`
Expected: the two refusal tests FAIL. If either still passes, the test is not exercising the guard — fix the test before continuing.

Restore `if (actualDID !== expectedDID) {` and re-run. Expected: PASS, 5 tests.

- [ ] **Step 7: Run the whole mls suite**

Run: `pnpm --filter @kumiai/mls exec vitest run`
Expected: all pass. Existing invite tests across `anchor.test.ts`, `group.test.ts`, `external-rejoin.test.ts`, `ledger-bootstrap.test.ts`, and others all go through `createInvite` with the matching bundle, so the guard should be invisible to them. If any fails, it has found a real honest path the guard rejects — report it rather than loosening the guard.

- [ ] **Step 8: Typecheck and lint**

Run: `pnpm --filter @kumiai/mls run test:types`
Expected: exit 0.

Run: `rtk proxy pnpm run lint`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/mls/src/group-commit.ts packages/mls/test/invite-recipient-binding.test.ts
git commit -m "fix: bind the invitee's key package to the role the invite grants"
```

---

## Task 3: The malformed-invite refusals

**Files:**
- Test: `packages/mls/test/invite-recipient-binding.test.ts` (append)
- Modify: `packages/mls/src/group-commit.ts` only if a test proves the guard from Task 2 does not already cover a case

**Interfaces:**
- Consumes: the guard from Task 2. No production change is expected — Task 2's code already throws all three bare `Error`s. This task proves each branch is reachable and stays reachable.
- Produces: nothing new.

Background the implementer needs:

- `signLedgerEntry(identity, entry)` is exported from `packages/mls/src/ledger.js` and returns a signed token string. `entry` is `{ type, groupID, subject, value }`.
- `group.ledgerTokens` is the group's own signed ledger, in order. An `Invite` is `{ groupID, inviterID, ledgerEntries }`, and `entriesAddedByInvite` requires `ledgerEntries` to *begin with* `group.ledgerTokens` — so hand-built invites must spread it first or they fail with a different error.
- To build a key package with a non-basic credential, take a real bundle and override the leaf credential. The resulting package has an invalid signature, which is fine: the guard runs before anything validates it.

- [ ] **Step 1: Write the failing tests**

Extend the test file's imports:

```ts
import type { KeyPackage } from 'ts-mls'
import { defaultCredentialTypes } from 'ts-mls'

import { signLedgerEntry } from '../src/ledger.js'
import { ROLE_ENTRY_TYPE } from '../src/roster.js'
import type { Invite } from '../src/index.js'
```

Append:

```ts
describe('commitInvite refuses an invite it cannot bind', () => {
  test('refuses an invite that enacts no role entry for this group', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()

    const { group } = await createGroup(alice, 'g-no-role')
    const bobBundle = await createKeyPackageBundle(bob, { capabilities: controlCapabilities() })

    const noteToken = await signLedgerEntry(alice, {
      type: 'app.note',
      groupID: 'g-no-role',
      subject: bob.id,
      value: 'not a role grant',
    })
    const invite: Invite = {
      groupID: 'g-no-role',
      inviterID: alice.id,
      ledgerEntries: [...group.ledgerTokens, noteToken],
    }

    await expect(commitInvite(group, bobBundle.publicPackage, invite)).rejects.toThrow(
      /exactly one kumiai\.role entry for this group, got 0/,
    )
  })

  test('refuses an invite that enacts two role entries', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const carol = randomIdentity()

    const { group } = await createGroup(alice, 'g-two-roles')
    const bobBundle = await createKeyPackageBundle(bob, { capabilities: controlCapabilities() })

    const { invite } = await createInvite({
      group,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const carolToken = await signLedgerEntry(alice, {
      type: ROLE_ENTRY_TYPE,
      groupID: 'g-two-roles',
      subject: carol.id,
      value: 'member',
    })
    const twoRoles: Invite = {
      ...invite,
      ledgerEntries: [...invite.ledgerEntries, carolToken],
    }

    await expect(commitInvite(group, bobBundle.publicPackage, twoRoles)).rejects.toThrow(
      /exactly one kumiai\.role entry for this group, got 2/,
    )
  })

  test('refuses a key package whose credential is not a basic credential', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()

    const { group } = await createGroup(alice, 'g-x509')
    const bobBundle = await createKeyPackageBundle(bob, { capabilities: controlCapabilities() })
    const { invite } = await createInvite({
      group,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })

    // Signature is now invalid, which is the point: the guard must refuse before anything
    // reaches a signature check, because a non-basic credential names no DID to bind.
    const x509Package: KeyPackage = {
      ...bobBundle.publicPackage,
      leafNode: {
        ...bobBundle.publicPackage.leafNode,
        credential: { credentialType: defaultCredentialTypes.x509, certificates: [] },
      },
    }

    await expect(commitInvite(group, x509Package, invite)).rejects.toThrow(
      /non-basic credential, which names no DID to bind/,
    )
  })
})
```

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter @kumiai/mls exec vitest run test/invite-recipient-binding.test.ts`
Expected: PASS, 8 tests. These exercise branches Task 2 already wrote, so they should pass immediately.

If the two-role-entries test reports `got 1` instead of `got 2`, the group's own ledger already carried the extra token — check that `entriesAddedByInvite` is slicing as expected before changing the guard.

If any test fails for a reason other than the assertion text, that branch is unreachable as written and the guard needs fixing. Report what you found before editing.

- [ ] **Step 3: Mutation-check the shape guard**

Temporarily change `if (roleSubjects.length !== 1) {` to `if (false) {`.

Run: `pnpm --filter @kumiai/mls exec vitest run test/invite-recipient-binding.test.ts`
Expected: both shape tests FAIL. Restore and re-run — PASS, 8 tests.

- [ ] **Step 4: Mutation-check the credential-type guard**

Temporarily change `if (credential.credentialType !== defaultCredentialTypes.basic) {` to `if (false) {`. TypeScript will now reject `credential.identity`; that compile error is itself the signal the branch is load-bearing, so instead run only the test:

Run: `pnpm --filter @kumiai/mls exec vitest run test/invite-recipient-binding.test.ts -t 'not a basic credential'`
Expected: FAIL. Restore and re-run — PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm --filter @kumiai/mls run test:types`
Expected: exit 0.

Run: `rtk proxy pnpm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/mls/test/invite-recipient-binding.test.ts
git commit -m "test: cover commitInvite's malformed-invite refusals"
```

---

## Task 4: The did:peer:4 long-form honest path, and the full gate

**Files:**
- Test: `packages/mls/test/invite-recipient-binding.test.ts` (append)

**Interfaces:**
- Consumes: the guard from Task 2.
- Produces: nothing new. This task locks in the `normalizeDID` on both sides and runs the whole-repo gate.

Why this test exists: `createInvite` signs whatever `recipientDID` the caller passes, so a caller holding a `did:peer:4` identity may pass its **long form**. `makeMLSCredential` writes `identity.id`, which for `did:peer:4` is the **short form** (`kokuin/packages/token/src/identity.ts:442`). Comparing those two strings raw fails. `normalizeDID` folds peer:4 to its short form (`kokuin/packages/token/src/did.ts:195`), which is why both sides go through it — and this test is what stops someone removing one of them.

- [ ] **Step 1: Write the test**

Extend the test file's imports:

```ts
import { createIdentity, randomIdentity } from '@kokuin/token'
```

Append:

```ts
describe('commitInvite normalizes both DIDs before comparing', () => {
  test('a did:peer:4 recipient invited by long form still commits', async () => {
    const alice = await createIdentity({
      keys: [{ purpose: 'sig', alg: 'EdDSA' }],
      didMethod: 'peer:4',
    })
    const bob = await createIdentity({
      keys: [{ purpose: 'sig', alg: 'EdDSA' }],
      didMethod: 'peer:4',
    })

    const { group } = await createGroup(alice, 'g-peer4-longform')
    const bobBundle = await createKeyPackageBundle(bob, { capabilities: controlCapabilities() })

    // The credential carries bob's short form; the invite names his long form. Both must
    // normalize to the same DID or this honest path breaks.
    expect(bob.longForm).not.toBe(bob.id)
    const { invite } = await createInvite({
      group,
      identity: alice,
      recipientDID: bob.longForm,
      permission: 'member',
    })

    const { welcomeMessage } = await commitInvite(group, bobBundle.publicPackage, invite)
    const { group: bobGroup } = await processWelcome({
      identity: bob,
      invite,
      welcome: welcomeMessage,
      keyPackageBundle: bobBundle,
    })

    expect(bobGroup.groupID).toBe('g-peer4-longform')
  })
})
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @kumiai/mls exec vitest run test/invite-recipient-binding.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 3: Mutation-check the normalization**

Temporarily drop the `normalizeDID` on the expected side: change

```ts
const expectedDID = normalizeDID(roleSubjects[0]!)
```

to

```ts
// biome-ignore lint/style/noNonNullAssertion: length checked directly above
const expectedDID = roleSubjects[0]!
```

Run: `pnpm --filter @kumiai/mls exec vitest run test/invite-recipient-binding.test.ts -t 'long form'`
Expected: FAIL with `InviteRecipientMismatchError`. Restore and re-run — PASS.

- [ ] **Step 4: Whole-repo gate**

Run: `rtk proxy pnpm run lint`
Expected: no errors.

Run: `pnpm exec turbo run test:types test:unit --force`
Expected: all tasks successful, and the summary line must read `Cached: 0 cached` — a cached run proves nothing. Do not use `pnpm test -- --force`; the flag does not reach turbo.

Run: `pnpm exec turbo run build:types --force`
Expected: all successful.

- [ ] **Step 5: Add a changeset**

Run: `pnpm changeset`

Select `@kumiai/mls`, bump **patch** (pre-1.0 hardening of an existing function; no API is removed and the new export is additive). Summary:

```
commitInvite now refuses a key package whose credential DID is not the identity the invite's enacted role entry grants a role to, throwing the new InviteRecipientMismatchError. Previously the joining identity was decided by whoever supplied the key package bytes, so a store that served the wrong owner's package would admit that owner while the roster named someone else.
```

- [ ] **Step 6: Commit**

```bash
git add packages/mls/test/invite-recipient-binding.test.ts .changeset
git commit -m "test: cover did:peer:4 long-form invites, add changeset"
```

- [ ] **Step 7: Retire the source item**

```bash
git rm docs/agents/plans/next/2026-07-26-bind-keypackage-to-invite-recipient.md
git commit -m "docs: retire the key-package binding item, now implemented"
```

---

## Done when

- `commitInvite` refuses a substituted key package with `InviteRecipientMismatchError` carrying the right `expectedDID`/`actualDID`, and the mutation check confirms the test bites.
- The honest path, including a `did:peer:4` recipient named by long form, still commits and the invitee joins.
- Malformed invites (zero or two-plus role entries) and non-basic credentials are refused with bare `Error`s, each mutation-checked.
- `rtk proxy pnpm run lint` clean; `pnpm exec turbo run test:types test:unit --force` green with `Cached: 0`.
- A patch changeset for `@kumiai/mls` exists, and the `next/` item is removed.
