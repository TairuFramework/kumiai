# Receive-Side Add/Roster Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** qa
**Mode:** tasks
**Spec:** `docs/superpowers/specs/2026-07-26-add-proposal-roster-binding-design.md`

**Goal:** Make `defaultCommitPolicy` reject an Add proposal whose leaf credential names a DID that
holds no role in the commit's candidate roster, so a receiver — not just an honest `commitInvite` —
can see membership diverge from the roster.

**Architecture:** A new total helper `didFromCredential` in `packages/mls/src/credential.ts` extracts
a normalized DID from an MLS leaf credential and returns `undefined` rather than throwing on anything
malformed. `evaluateProposal`'s add case splits out of the shared `add | psk | reinit` arm and, after
the existing admin gate, requires that DID to hold a role in `context.candidateRoster` — a field
already on `CommitPolicyContext` and already populated by both callers. No new context field, no
caller wiring, no new error type.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `ts-mls`, `@kokuin/token`, vitest, biome,
turbo, pnpm workspaces, changesets.

## Global Constraints

- pnpm only. Never `npm` or `yarn`.
- Never edit generated files under `lib/`.
- Relative imports inside a package always carry the `.js` extension (`./credential.js`), even from
  `.ts` sources.
- Run lint as `rtk proxy pnpm run lint` — a shim intercepts the bare `pnpm run lint` and
  `pnpm exec biome` and reports fake output.
- `defaultCommitPolicy` and everything it calls must stay **pure and total**: no I/O, no thrown
  exceptions, no `Date.now()`. This is a documented contract at `packages/mls/src/policy.ts:230-236`
  and there is a test asserting it (`the policy never throws, even on an unresolvable sender`).
- Vitest strips types rather than checking them, so a green `test:unit` proves nothing about types.
  Every task that runs `test:unit` also runs `test:types`.
- Commit messages end with the two trailer lines used on this branch:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01RMPXvBqVL6yPnTSMdEFTbH
  ```

**Useful facts, verified — do not re-derive:**

- `normalizeDID` (`@kokuin/token`) never throws. It returns the peer:4 short form when
  `isPeer4(did)` (a `did:peer:4z` prefix check) and the input unchanged otherwise. So the only
  throwing call inside `didFromCredential` is `parseMLSCredentialIdentity`.
- `parseMLSCredentialIdentity` (`packages/mls/src/credential.ts:36`) throws on: non-JSON bytes, a
  non-object JSON value, a `v` that is present and not `1`, a non-string `id`, and a present
  non-string `longForm`.
- ts-mls exports `type Credential`, `isDefaultCredential`, and `defaultCredentialTypes` from its
  package root. `defaultCredentialTypes.basic === 1`, `.x509 === 2`.
- `CredentialCustom.credentialType` is a bare `number`, so `credentialType !== basic` does **not**
  narrow on its own. The `isDefaultCredential(...) || ... !== basic` two-step is required, and is
  the same shape `commitInvite` already uses at `packages/mls/src/group-commit.ts:376-379`.
- `RosterState.roles` is a `ReadonlyMap<string, GroupPermission>` keyed by **normalized** DID
  (`packages/mls/src/roster.ts:20`), so `roles.has(normalizedDID)` is a direct lookup.
- In `defaultCommitPolicy`, a proposal-level `'reject'` already rejects the whole commit
  (`packages/mls/src/policy.ts:262-266`). Nothing new is needed to propagate it.

---

## Task 1: `didFromCredential`

Add the total credential→DID helper. Nothing consumes it yet; Task 2 wires it in.

**Files:**
- Modify: `packages/mls/src/credential.ts`
- Test: `packages/mls/test/credential.test.ts`

**Interfaces:**
- Consumes: `parseMLSCredentialIdentity` (already in the same file), `normalizeDID` from
  `@kokuin/token`, `isDefaultCredential` / `defaultCredentialTypes` / `type Credential` from
  `ts-mls`.
- Produces: `didFromCredential(credential: Credential): string | undefined`, exported from
  `packages/mls/src/credential.ts`. Task 2 imports it as
  `import { didFromCredential } from './credential.js'`. It is **not** added to
  `packages/mls/src/index.ts` — deliberately internal, per the spec.

- [ ] **Step 1: Write the failing tests**

Add to `packages/mls/test/credential.test.ts`. Extend the existing import from `'../src/credential.js'`
to include `didFromCredential`, and extend the existing `'ts-mls'` import to include
`type Credential` (the file already imports `defaultCredentialTypes`):

```ts
import { type Credential, defaultCredentialTypes } from 'ts-mls'

import {
  didFromCredential,
  type MemberCredential,
  parseMLSCredentialIdentity,
  populateCacheFromCredential,
} from '../src/credential.js'
```

Then append this block at the end of the file:

```ts
/** A basic MLS credential carrying `identity` verbatim. */
function basicCredential(identity: Uint8Array): Credential {
  return { credentialType: defaultCredentialTypes.basic, identity }
}

/** A basic MLS credential whose identity is the JSON `makeMLSCredential` emits. */
function credentialFor(id: string): Credential {
  return basicCredential(new TextEncoder().encode(JSON.stringify({ id })))
}

describe('didFromCredential', () => {
  it('returns the DID a basic did:key credential names', () => {
    expect(didFromCredential(credentialFor('did:key:z6MkABC'))).toBe('did:key:z6MkABC')
  })

  it('normalizes a peer:4 long form to its short form', () => {
    // normalizeDID truncates at the separator after the peer:4 prefix, so the roster lookup
    // this feeds compares short forms on both sides.
    expect(didFromCredential(credentialFor('did:peer:4zABC:eyJ'))).toBe('did:peer:4zABC')
  })

  it('reads an identity tagged v: 1', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, id: 'did:key:z6MkABC' }))
    expect(didFromCredential(basicCredential(bytes))).toBe('did:key:z6MkABC')
  })

  it('returns undefined for an x509 credential, which names no DID', () => {
    const x509: Credential = { credentialType: defaultCredentialTypes.x509, certificates: [] }
    expect(didFromCredential(x509)).toBeUndefined()
  })

  it('returns undefined for a custom credential type', () => {
    const custom: Credential = { credentialType: 0xbeef, data: new Uint8Array([1, 2, 3]) }
    expect(didFromCredential(custom)).toBeUndefined()
  })

  it('returns undefined instead of throwing on non-JSON identity bytes', () => {
    const bytes = new TextEncoder().encode('not json at all')
    expect(() => didFromCredential(basicCredential(bytes))).not.toThrow()
    expect(didFromCredential(basicCredential(bytes))).toBeUndefined()
  })

  it('returns undefined instead of throwing on JSON with no id', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ longForm: 'did:peer:4zABC:eyJ' }))
    expect(() => didFromCredential(basicCredential(bytes))).not.toThrow()
    expect(didFromCredential(basicCredential(bytes))).toBeUndefined()
  })

  it('returns undefined instead of throwing on an unsupported identity version', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 2, id: 'did:key:z6MkABC' }))
    expect(() => didFromCredential(basicCredential(bytes))).not.toThrow()
    expect(didFromCredential(basicCredential(bytes))).toBeUndefined()
  })

  it('returns an arbitrary id string unchanged rather than rejecting it', () => {
    // Not this function's job to validate DID syntax: a well-formed identity naming a string no
    // roster ever grants is a DID the caller will fail to find, which is the correct outcome and
    // a different one from "this credential names no DID at all".
    expect(didFromCredential(credentialFor('banana'))).toBe('banana')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @kumiai/mls run test:unit -- test/credential.test.ts
```

Expected: FAIL. The import of `didFromCredential` is unresolved, so the whole file errors before any
assertion runs (vitest reports something like `No "didFromCredential" export is defined on the module`).

- [ ] **Step 3: Implement `didFromCredential`**

In `packages/mls/src/credential.ts`, extend the existing first import line and add a `ts-mls` import
below it:

```ts
import { type DIDCache, decodePeer4, isPeer4, normalizeDID } from '@kokuin/token'
import { type Credential, defaultCredentialTypes, isDefaultCredential } from 'ts-mls'
```

Then append the function at the end of the file:

```ts
/**
 * The normalized DID an MLS leaf credential names, or `undefined` when it names none.
 *
 * Total by contract. The receive-side commit policy calls this on a leaf inside an untrusted
 * commit, and {@link defaultCommitPolicy} is pure and total — a malformed credential must read as
 * "no DID", never throw past the policy boundary. Every rejection `parseMLSCredentialIdentity`
 * raises collapses to `undefined` here: non-JSON bytes, a non-object value, an unsupported `v`, a
 * non-string `id`, a non-string `longForm`.
 *
 * `credentialType !== basic` does not narrow on its own: `CredentialCustom.credentialType` is a
 * bare `number`, so the compiler cannot rule it out. ts-mls's own guard can.
 *
 * Syntax is not validated. An identity naming an arbitrary string returns that string, which no
 * roster grants — a lookup miss, and deliberately distinct from a credential that names nothing.
 *
 * Not re-exported from the package index: `policy.ts` is the only consumer today, and widening the
 * surface is cheap to do later and impossible to undo.
 */
export function didFromCredential(credential: Credential): string | undefined {
  if (
    !isDefaultCredential(credential) ||
    credential.credentialType !== defaultCredentialTypes.basic
  ) {
    return undefined
  }
  try {
    return normalizeDID(parseMLSCredentialIdentity(credential.identity).id)
  } catch {
    return undefined
  }
}
```

- [ ] **Step 4: Run the tests and the type check**

```bash
pnpm --filter @kumiai/mls run test:unit -- test/credential.test.ts
pnpm --filter @kumiai/mls run test:types
```

Expected: both PASS. `test:types` must be run — vitest strips types rather than checking them, so a
green unit run says nothing about the `Credential` annotations.

- [ ] **Step 5: Commit**

```bash
git add packages/mls/src/credential.ts packages/mls/test/credential.test.ts
git commit -F - <<'EOF'
feat(mls): add a total credential-to-DID helper

didFromCredential reads the normalized DID a basic MLS leaf credential
names, returning undefined for a non-basic credential and for every
malformed identity parseMLSCredentialIdentity would throw on.

Total by contract: its consumer is the receive-side commit policy, which
judges untrusted leaves and is documented pure and total, so a malformed
credential has to read as "no DID" rather than throw past the policy
boundary. Not re-exported from the package index — policy.ts is the only
consumer, and widening the surface later is cheap.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RMPXvBqVL6yPnTSMdEFTbH
EOF
```

---

## Task 2: The receive-side add rule

Split `add` out of the shared arm and bind the added leaf to the candidate roster.

**Files:**
- Modify: `packages/mls/src/policy.ts:153-156` (the add/psk/reinit arm of `evaluateProposal`)
- Test: `packages/mls/test/policy.test.ts`

**Interfaces:**
- Consumes: `didFromCredential(credential: Credential): string | undefined` from Task 1, imported as
  `import { didFromCredential } from './credential.js'`. No import cycle: `credential.ts` imports
  only `@kokuin/token` and `ts-mls`, never `policy.ts`.
- Produces: no new exports. `defaultCommitPolicy`'s signature is unchanged.

- [ ] **Step 1: Replace `taggedProposal` at the six Add call sites**

`taggedProposal` fabricates no payload, so once the rule reads
`proposal.add.keyPackage.leafNode.credential` every Add built with it dereferences `undefined`. Add
these two helpers to `packages/mls/test/policy.test.ts`, directly below the existing
`taggedProposal` definition (around line 65):

```ts
/**
 * An Add whose key package presents `did` in a basic MLS credential. Only the credential is
 * real — the add rule reads `proposal.add.keyPackage.leafNode.credential` and nothing else — so
 * the rest of the key package stays unfabricated for the same reason `taggedProposal` fabricates
 * no payload at all.
 */
function addProposal(did: string): Proposal {
  return addProposalWithCredential({
    credentialType: defaultCredentialTypes.basic,
    identity: new TextEncoder().encode(JSON.stringify({ id: did })),
  })
}

function addProposalWithCredential(credential: Credential): Proposal {
  return {
    proposalType: defaultProposalTypes.add,
    add: { keyPackage: { leafNode: { credential } } },
  } as unknown as Proposal
}
```

Extend the file's `ts-mls` imports to supply `Credential` and `defaultCredentialTypes`:

```ts
import type { Credential, GroupContextExtension, Proposal, ProposalWithSender } from 'ts-mls'
import { defaultCredentialTypes, defaultProposalTypes, makeCustomExtension } from 'ts-mls'
```

Now replace every `taggedProposal(defaultProposalTypes.add)` with `addProposal(...)`. There are six,
and they need different DIDs:

| Line (pre-edit) | Test | Replacement | Why |
|---|---|---|---|
| 122 | `add is admin-gated` | `addProposal(MEMBER_DID)` | `MEMBER_DID` holds a role, so the admin case must still accept and the test keeps measuring the admin gate alone. |
| 363 | `a commit that enacts entries without a group_context_extensions proposal is rejected` | `addProposal(MEMBER_DID)` | Must reject for the missing-GCE reason, not an ungranted DID. |
| 379 | `a commit enacting entries and moving the head to the expected value is accepted` | `addProposal(MEMBER_DID)` | This one is `accept`; an ungranted DID would flip it. |
| 416 | `external_init commit rejects any proposal beyond external_init and the self-remove` | `addProposal(MEMBER_DID)` | Must reject for being a third proposal on an external commit. |
| 447 | `a commit mixing a passing and a failing proposal is rejected` | `addProposal(MEMBER_DID)` | Must reject because the sender is a non-admin. |
| 488 | `the policy never throws, even on an unresolvable sender` | `addProposal(MEMBER_DID)` | Asserts no-throw; keep the payload well-formed so the assertion is about the sender. |

Use `MEMBER_DID` at all six. Four of them would pass with any DID today because an earlier check
short-circuits first, but pinning them to a granted DID keeps each test measuring the one thing its
name claims instead of silently depending on check ordering.

- [ ] **Step 2: Write the failing tests for the new rule**

Append inside the existing `describe('defaultCommitPolicy', ...)` block:

```ts
test('an add is rejected when the candidate roster grants the added DID nothing', () => {
  // The gap this rule closes: an admin — or a modified commitInvite — adding a leaf the
  // group's own roster never granted a role to. Honest paths always enact the grant in the
  // same commit, so a DID absent from the candidate roster is one nothing admitted.
  const add = addProposal(OUTSIDER_DID)
  expect(defaultCommitPolicy(commit(ADMIN_LEAF, [withSender(add, undefined)]), context())).toBe(
    'reject',
  )
})

test('an add is accepted when only the candidate roster grants the added DID', () => {
  // The honest invite shape: the invitee's grant rides the same commit as the Add, so it
  // exists in the candidate roster and not the base one. Checking baseRoster here would
  // reject every legitimate invite.
  const granted = roster([
    [ADMIN_DID, 'admin'],
    [MEMBER_DID, 'member'],
    [OUTSIDER_DID, 'member'],
  ])
  const add = addProposal(OUTSIDER_DID)
  expect(
    defaultCommitPolicy(
      commit(ADMIN_LEAF, [withSender(add, undefined)]),
      context({ candidateRoster: granted }),
    ),
  ).toBe('accept')
})

test('an add of a DID already on the roster is accepted without a fresh grant', () => {
  // A re-add — a second device, or a rejoin after removal — enacts no new entry. The rule
  // asks whether the added DID holds a role, never whether this commit granted it.
  const add = addProposal(MEMBER_DID)
  expect(defaultCommitPolicy(commit(ADMIN_LEAF, [withSender(add, undefined)]), context())).toBe(
    'accept',
  )
})

test('a non-admin add of a granted DID is still rejected', () => {
  // The admin gate runs first and is unchanged: a granted DID does not let a member add.
  const add = addProposal(MEMBER_DID)
  expect(defaultCommitPolicy(commit(MEMBER_LEAF, [withSender(add, undefined)]), context())).toBe(
    'reject',
  )
})

test('an add carrying a non-basic credential is rejected', () => {
  const add = addProposalWithCredential({
    credentialType: defaultCredentialTypes.x509,
    certificates: [],
  })
  expect(defaultCommitPolicy(commit(ADMIN_LEAF, [withSender(add, undefined)]), context())).toBe(
    'reject',
  )
})

test('an add whose credential identity is malformed is rejected without throwing', () => {
  // A receiver judging an untrusted commit cannot let a malformed credential throw past the
  // policy boundary — defaultCommitPolicy is documented pure and total.
  const add = addProposalWithCredential({
    credentialType: defaultCredentialTypes.basic,
    identity: new TextEncoder().encode('not json at all'),
  })
  const incoming = commit(ADMIN_LEAF, [withSender(add, undefined)])
  expect(() => defaultCommitPolicy(incoming, context())).not.toThrow()
  expect(defaultCommitPolicy(incoming, context())).toBe('reject')
})

test('a standalone add of an ungranted DID is rejected', () => {
  // A standalone proposal carries no entries, so its candidate roster equals the base one and
  // a not-yet-granted invitee has no grant to find. Grants land by commit; the Add follows.
  const standalone = {
    kind: 'proposal' as const,
    proposal: withSender(addProposal(OUTSIDER_DID), ADMIN_LEAF),
  }
  expect(defaultCommitPolicy(standalone, context())).toBe('reject')
})

test('psk and reinit stay admin-gated and read no leaf', () => {
  // They share the add case arm today; splitting add out must not change them. Neither
  // carries a leaf, so `taggedProposal` remains the honest fixture for both.
  for (const proposalType of [defaultProposalTypes.psk, defaultProposalTypes.reinit]) {
    const proposal = taggedProposal(proposalType)
    expect(
      defaultCommitPolicy(commit(ADMIN_LEAF, [withSender(proposal, undefined)]), context()),
    ).toBe('accept')
    expect(
      defaultCommitPolicy(commit(MEMBER_LEAF, [withSender(proposal, undefined)]), context()),
    ).toBe('reject')
  }
})
```

`OUTSIDER_DID` is already declared at `packages/mls/test/policy.test.ts:22` and is absent from the
default `context()` roster — that is exactly the ungranted DID these tests need.

- [ ] **Step 3: Run the tests to verify they fail**

```bash
pnpm --filter @kumiai/mls run test:unit -- test/policy.test.ts
```

Expected: FAIL — exactly four of the new tests, each getting `'accept'` where it expects `'reject'`,
because the current arm never looks at the leaf:

- `an add is rejected when the candidate roster grants the added DID nothing`
- `an add carrying a non-basic credential is rejected`
- `an add whose credential identity is malformed is rejected without throwing`
- `a standalone add of an ungranted DID is rejected`

The other four already pass and are there to pin behaviour the change must not disturb. If a
different set fails, the fixtures are wrong — fix them before implementing.

- [ ] **Step 4: Implement the rule**

In `packages/mls/src/policy.ts`, add the import below the existing `./anchor.js` import (biome sorts
these alphabetically, so `./credential.js` goes after `./anchor.js`):

```ts
import { LEDGER_HEAD_EXTENSION_TYPE, RESERVED_EXTENSION_TYPE } from './anchor.js'
import { didFromCredential } from './credential.js'
import type { RosterState } from './roster.js'
```

Replace the arm at lines 153-156:

```ts
    case defaultProposalTypes.add:
    case defaultProposalTypes.psk:
    case defaultProposalTypes.reinit:
      return isAdmin(context, effectiveSender) ? 'accept' : 'reject'
```

with:

```ts
    case defaultProposalTypes.add: {
      if (!isAdmin(context, effectiveSender)) {
        return 'reject'
      }
      // Bind the leaf that joins to the roster this commit produces, mirroring the binding
      // `commitInvite` enforces where the commit is authored. Without it only an honest inviter
      // refuses to admit an identity the roster never granted a role to; a receiver applies the
      // commit and Welcomes the wrong member with no way to see the disagreement.
      //
      // `candidateRoster`, not `baseRoster`: an honest invite's grant for the invitee rides the
      // same commit as the Add, so it exists only after the fold.
      //
      // Membership, not provenance: the question is whether the added DID holds a role, never
      // whether this commit granted it. A re-add — a second device, a rejoin after removal —
      // enacts no entry and must keep working.
      //
      // A credential that names no DID (non-`basic`, or malformed) is rejected rather than
      // trusted. `didFromCredential` is total, so nothing here can throw past this boundary.
      const addedDID = didFromCredential(proposal.add.keyPackage.leafNode.credential)
      if (addedDID === undefined) {
        return 'reject'
      }
      return context.candidateRoster.roles.has(addedDID) ? 'accept' : 'reject'
    }
    // Split from `add` above only so they stop sharing an arm that reads `proposal.add`.
    // Neither carries a leaf, so neither has anything to bind to the roster.
    case defaultProposalTypes.psk:
    case defaultProposalTypes.reinit:
      return isAdmin(context, effectiveSender) ? 'accept' : 'reject'
```

Then update the `evaluateProposal` doc comment (`packages/mls/src/policy.ts:143-146`) so it names the
new rule:

```ts
/**
 * Apply one proposal's row for the given effective sender. Unknown/custom types fail closed.
 * `external_init` is judged at the commit level, never here — a standalone one rejects.
 *
 * An `add` is admin-gated AND bound to the roster: the added leaf's credential must name a DID
 * the candidate roster grants a role to, so MLS membership can never diverge from the roster.
 */
```

- [ ] **Step 5: Run the tests and the type check**

```bash
pnpm --filter @kumiai/mls run test:unit -- test/policy.test.ts
pnpm --filter @kumiai/mls run test:types
```

Expected: both PASS, including every pre-existing test in the file.

- [ ] **Step 6: Prove the tests bite**

A test that passes against a broken guard is not a test. Temporarily weaken the rule — change the
last line of the add arm to `return 'accept'` — and re-run:

```bash
pnpm --filter @kumiai/mls run test:unit -- test/policy.test.ts
```

Expected: `an add is rejected when the candidate roster grants the added DID nothing` FAILS. Then
change it back to `return context.candidateRoster.roles.has(addedDID) ? 'accept' : 'reject'` and
confirm the file is green again before moving on. Do not commit the weakened version.

- [ ] **Step 7: Run the whole `@kumiai/mls` suite**

```bash
pnpm --filter @kumiai/mls run test:unit
```

Expected: one failure, and only one —
`retains an admin's pending proposal and carries it into the commit` in
`packages/mls/test/group.test.ts`. That is the deliberate behaviour change; Task 3 rewrites it. Any
other failure is unplanned: stop and report it rather than adjusting the test to match.

- [ ] **Step 8: Commit**

Commit the rule even though `group.test.ts` is red — the failure is the documented behaviour change
and Task 3 is its fix. Use `--no-verify` only if the hook blocks on it; the pre-commit hook runs lint
and `build:types`, not the unit suite, so it should pass normally.

```bash
git add packages/mls/src/policy.ts packages/mls/test/policy.test.ts
git commit -F - <<'EOF'
feat(mls): bind an Add's leaf to the candidate roster on receipt

defaultCommitPolicy's add rule accepted any Add from an admin sender
without looking at the added leaf, so the key-package/roster binding
commitInvite enforces held only where the commit was authored. A
modified or buggy write path could still Welcome an identity the roster
never granted a role to, and no receiver could see it.

The added leaf's credential DID must now hold a role in the commit's
candidate roster. Candidate rather than base, because an honest invite's
grant rides the same commit as the Add. Membership rather than
provenance, because a re-add of an already-granted DID enacts no entry
and must keep working. A credential naming no DID — non-basic, or
malformed — is rejected rather than trusted.

add splits out of the arm it shared with psk and reinit, which carry no
leaf and are otherwise unchanged.

group.test.ts's absorbed-standalone-Add test is red at this commit: it
adds a DID no entry grants, which is exactly what the rule now forbids.
The next commit rewrites it grant-first.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RMPXvBqVL6yPnTSMdEFTbH
EOF
```

---

## Task 3: Rewrite the absorbed-Add test grant-first

The rule makes MLS membership imply a roster grant. One existing test adds a DID with no grant.

**Files:**
- Modify: `packages/mls/test/group.test.ts:3184-3211` (the test
  `retains an admin's pending proposal and carries it into the commit`)

**Interfaces:**
- Consumes: nothing new. `signLedgerEntry`, `ledgerEntryDigest`, `commitLedgerEntries`,
  `normalizeDID`, `createProposal`, `addProposal`, `onlyPending`, `removeMember`, and
  `threeMemberGroup` are all already imported or defined in this file.
- Produces: nothing.

**Name collision warning.** `group.test.ts` already has its own `addProposal`
(`packages/mls/test/group.test.ts:3085`), and it takes a **key package**, not a DID:
`function addProposal(keyPackage: unknown): AddProposal`. It is unrelated to the
`addProposal(did: string)` helper Task 2 adds to `policy.test.ts`. Do not import one into the other
and do not "reconcile" them — this task uses `group.test.ts`'s existing key-package version exactly
as the surrounding tests already do.

Background the implementer needs:

- `threeMemberGroup()` (`packages/mls/test/group.test.ts:2263`) returns
  `{ alice, bob, carol, aliceGroup, bobGroup, carolGroup, groupID, tokens }`. `tokens` is the
  `Map<string, string>` behind `mapResolver`, which is how every handle in this fixture resolves an
  entry id a commit's envelope names.
- A receiver can only fold an entry it can resolve, so a token must be published into `tokens` —
  `tokens.set(ledgerEntryDigest(token), token)` — **before** any handle processes the commit
  enacting it.
- `commitLedgerEntries(group, [token])` returns `{ commitMessage, newGroup, epoch }`. It does not
  mutate `group`; the caller must adopt `newGroup`, and every subsequent proposal or commit must be
  built from that new handle or it frames at a stale epoch.
- The role-entry shape is `{ type: 'kumiai.role', groupID, subject, value }`, signed by an admin —
  see `packages/mls/test/group.test.ts:1199` for a working example.

- [ ] **Step 1: Rewrite the test**

Replace the body of `it("retains an admin's pending proposal and carries it into the commit", ...)`
with:

```ts
  it("retains an admin's pending proposal and carries it into the commit", async () => {
    const { alice, bob, aliceGroup, carolGroup, tokens } = await threeMemberGroup()
    const dave = randomIdentity()
    const daveKP = await createKeyPackageBundle(dave)

    // Dave's grant lands FIRST, in its own commit. The receive-side add rule binds an Add to
    // the roster the commit produces, so an Add absorbed by an unrelated commit — which enacts
    // no grant of its own — can only name a DID the roster already carries.
    const grantDave = await signLedgerEntry(alice, {
      type: 'kumiai.role',
      groupID: aliceGroup.groupID,
      subject: dave.id,
      value: 'member',
    })
    tokens.set(ledgerEntryDigest(grantDave), grantDave)
    const granted = await commitLedgerEntries(aliceGroup, [grantDave])
    await carolGroup.processMessage(granted.commitMessage)
    const daveNorm = normalizeDID(dave.id)
    expect(granted.newGroup.roster.roles.get(daveNorm)).toBe('member')
    expect(carolGroup.roster.roles.get(daveNorm)).toBe('member')

    // An admin's standalone add, held pending by the committer and by the receiver that must
    // resolve the by-reference proposal the commit carries. Built from the post-grant handle:
    // a proposal frames at its handle's epoch.
    const aliceAdd = await createProposal({
      context: granted.newGroup.context,
      state: granted.newGroup.state,
      proposal: addProposal(daveKP.publicPackage),
    })
    const [ref, pws] = onlyPending(aliceAdd.newState.unappliedProposals)
    granted.newGroup.state.unappliedProposals[ref] =
      pws as (typeof granted.newGroup.state.unappliedProposals)[string]
    carolGroup.state.unappliedProposals[ref] =
      pws as (typeof carolGroup.state.unappliedProposals)[string]

    const bobLeaf = granted.newGroup.findMemberLeafIndex(bob.id)
    if (bobLeaf == null) throw new Error('expected bob to be a member')
    const removal = await removeMember(granted.newGroup, bobLeaf)

    await carolGroup.processMessage(removal.commitMessage)

    // Dave, added by the retained admin proposal, is present on both sides; Bob is gone.
    expect(removal.newGroup.listMembers().some((m) => normalizeDID(m.id) === daveNorm)).toBe(true)
    expect(carolGroup.listMembers().some((m) => normalizeDID(m.id) === daveNorm)).toBe(true)
    expect(carolGroup.findMemberLeafIndex(bob.id)).toBeUndefined()
    expect(carolGroup.epoch).toBe(removal.newGroup.epoch)
  })
```

- [ ] **Step 2: Add the test that pins the new behaviour**

The old test's shape — an admin's pending Add of an **ungranted** DID — is now the thing the rule
forbids, and nothing covers it end to end. Add this immediately after the rewritten test, inside the
same `describe("the committer filters the pending set before authoring a commit", ...)` block:

```ts
  it("drops an admin's pending add of a DID the roster never granted", async () => {
    const { bob, aliceGroup, carolGroup } = await threeMemberGroup()
    const dave = randomIdentity()
    const daveKP = await createKeyPackageBundle(dave)

    // No grant for Dave anywhere. Before the receive-side add rule this add rode the eviction
    // commit and Dave joined a group whose roster named him nothing; now the committer's own
    // filter drops it, so committer and receiver still converge — on a group without him.
    const aliceAdd = await createProposal({
      context: aliceGroup.context,
      state: aliceGroup.state,
      proposal: addProposal(daveKP.publicPackage),
    })
    const [ref, pws] = onlyPending(aliceAdd.newState.unappliedProposals)
    aliceGroup.state.unappliedProposals[ref] =
      pws as (typeof aliceGroup.state.unappliedProposals)[string]
    carolGroup.state.unappliedProposals[ref] =
      pws as (typeof carolGroup.state.unappliedProposals)[string]

    const bobLeaf = aliceGroup.findMemberLeafIndex(bob.id)
    if (bobLeaf == null) throw new Error('expected bob to be a member')
    const removal = await removeMember(aliceGroup, bobLeaf)

    await carolGroup.processMessage(removal.commitMessage)

    const daveNorm = normalizeDID(dave.id)
    expect(removal.newGroup.listMembers().some((m) => normalizeDID(m.id) === daveNorm)).toBe(false)
    expect(carolGroup.listMembers().some((m) => normalizeDID(m.id) === daveNorm)).toBe(false)
    expect(carolGroup.findMemberLeafIndex(bob.id)).toBeUndefined()
    expect(carolGroup.epoch).toBe(removal.newGroup.epoch)
  })
```

- [ ] **Step 3: Run the tests and the type check**

```bash
pnpm --filter @kumiai/mls run test:unit -- test/group.test.ts
pnpm --filter @kumiai/mls run test:types
```

Expected: both PASS, whole file green.

- [ ] **Step 4: Prove the new test bites**

Temporarily change `expect(...toBe(false))` to `toBe(true)` on the `removal.newGroup` line of
`drops an admin's pending add of a DID the roster never granted` and re-run that file. Expected:
FAIL. Restore it and confirm green. This proves the assertion is measuring the drop and not just
agreeing with an empty list.

- [ ] **Step 5: Run the whole `@kumiai/mls` suite**

```bash
pnpm --filter @kumiai/mls run test:unit
```

Expected: fully green — the failure Task 2 left behind is now fixed.

- [ ] **Step 6: Commit**

```bash
git add packages/mls/test/group.test.ts
git commit -F - <<'EOF'
test(mls): order the absorbed-Add case grant-first

The receive-side add rule makes MLS membership imply a roster grant, so
an admin's standalone Add absorbed by an unrelated commit can only name
a DID the roster already carries. The pending-filter test committed
Dave's grant nowhere and relied on the eviction commit absorbing his
Add; it now commits the grant first and absorbs the Add after.

The capability is unchanged, only ordered. Adds the case the old shape
used to cover by accident: an admin's pending Add of a DID nothing ever
granted is dropped by the committer's own filter, so committer and
receiver still converge — on a group without him.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RMPXvBqVL6yPnTSMdEFTbH
EOF
```

---

## Task 4: Correct the residual claim, add the changeset, gate the branch

**Files:**
- Modify: `packages/mls/src/group-commit.ts:37-49` (the `InviteRecipientMismatchError` doc comment)
- Create: `.changeset/add-proposal-roster-binding.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

Why the doc comment is wrong: the originating `next/` item claimed a receive-side candidate-roster
check would close `commitInvite`'s ordering residual. It does not. A hand-built invite enacting
`[grant X, grant Y]` binds the key package to Y, because `commitInvite` reads the *last*
`kumiai.role` entry. The candidate roster folds **both** entries, so Y is granted in it and the new
receive check passes. X keeps a grant it never joined against, exactly as before.

- [ ] **Step 1: Correct the doc comment**

Append a paragraph to the `InviteRecipientMismatchError` doc comment in
`packages/mls/src/group-commit.ts`, after the existing final paragraph:

```ts
 * The receive-side add rule in {@link defaultCommitPolicy} does NOT close this residual, though it
 * is easy to assume it would. That rule rejects an Add whose DID the candidate roster grants
 * nothing; in the reordered case the trailing grant's subject IS granted, so the Add passes and the
 * intended invitee is left holding a grant it never joined against. Closing it needs this binding to
 * seek the enacted entry matching the key package's DID rather than reading the last one.
```

- [ ] **Step 2: Verify the claim you just wrote**

```bash
grep -n "candidateRoster" packages/mls/src/policy.ts
```

Expected: the add arm reads `context.candidateRoster.roles.has(addedDID)` — membership only, with no
reference to entry order anywhere. That is what makes the reordered case pass, and it is the whole
basis for the paragraph above.

- [ ] **Step 3: Write the changeset**

Create `.changeset/add-proposal-roster-binding.md`:

```markdown
---
'@kumiai/mls': minor
---

`defaultCommitPolicy` now rejects an Add proposal whose leaf credential names a DID that holds no
role in the commit's candidate roster. Previously an Add from an admin sender was accepted without
the added leaf being looked at, so the key-package/roster binding `commitInvite` enforces held only
where the commit was authored — a modified or buggy write path could still Welcome an identity the
roster never granted a role to, and no receiver could see the disagreement.

Two narrowings ship with it:

- An Add whose key package carries a non-`basic` credential, or a `basic` credential whose identity
  bytes do not parse, is rejected rather than accepted unread.
- MLS membership now implies a roster grant. An Add absorbed by a commit that enacts no grant for
  the added DID — an admin's standalone Add riding an unrelated eviction commit, say — is dropped by
  the committer's own pending filter and rejected by receivers. The capability is not lost, only
  ordered: commit the grant, then let a later commit absorb the Add.

Non-breaking for every honest caller: `createInvite` always enacts a `kumiai.role` entry for the
invitee and `commitInvite` already binds the key package to it, so every invite this library issues
satisfies the rule by construction. Rejection is a plain `'reject'` with no new error type —
`defaultCommitPolicy` returns ts-mls's `IncomingMessageAction`, which carries no reason, and a host
that wants to distinguish this case can read the Add off `CommitRejectedError.proposals`.
```

- [ ] **Step 4: Lint**

```bash
rtk proxy pnpm run lint
```

Expected: clean. Use `rtk proxy` — a shim intercepts the bare `pnpm run lint` and reports fake
output. Biome writes fixes in place, so re-stage anything it touches.

- [ ] **Step 5: Gate the whole branch, uncached**

Turbo replays cached results and will report a green run that tested nothing. Force it and confirm
`Cached: 0` in the summary:

```bash
pnpm exec turbo run test:types test:unit --force
```

Expected: every package green, and the summary line reads `Cached: 0 cached, N total`. If it reports
any cache hits the run did not execute — do not treat it as a pass. (`pnpm test -- --force` does not
work; the flag does not reach turbo.)

- [ ] **Step 6: Confirm both contract suites actually ran, and that the double needs no change**

`AGENTS.md` requires both suites against the real implementation and the doubles whenever a port
changes. Step 5 already executed them — `@kumiai/rpc`, `@kumiai/hub-server`, and `@kumiai/hub-client`
are in the turbo run, and `packages/rpc/test/ports-conformance.test.ts` drives `rpc-conformance`
against both the real `mls-rpc` implementation and the `memory-group-mls` double. Do not re-run them;
confirm they were in Step 5's output by name, and if any failed, stop — the change reached further
than the spec predicted.

Then confirm the double genuinely needs no change:

```bash
grep -n "adds" packages/rpc/test/fixtures/memory-group-mls.ts | head
```

Expected: adds are carried as `adds?: Array<string>` — bare DIDs, with no key package and no
credential anywhere in the fixture. A key-package/roster disagreement is therefore structurally
unrepresentable in it: the double cannot add an identity other than the DID named, which makes it
stricter than the port here. The test-doubles rule permits stricter, never more permissive, so it
stays as is. If that grep shows adds carrying a key package, the double CAN represent the
divergence and must gain the same check — stop and re-scope.

- [ ] **Step 7: Commit**

```bash
git add packages/mls/src/group-commit.ts .changeset/add-proposal-roster-binding.md
git commit -F - <<'EOF'
docs(mls): correct what the receive-side add rule closes

InviteRecipientMismatchError's doc comment pointed at the receive path as
the eventual fix for commitInvite's last-entry ordering residual. It is
not. The add rule asks only whether the candidate roster grants the added
DID a role, and in the reordered case the trailing grant's subject IS
granted, so the Add passes and the intended invitee still ends up with a
grant it never joined against. Closing that needs the send-side binding to
seek the entry matching the key package's DID instead of reading the last.

Adds the changeset for the rule.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RMPXvBqVL6yPnTSMdEFTbH
EOF
```

---

## Follow-up, not in scope

`commitInvite`'s ordering residual stays open. Closing it means binding to whichever entry in
`enacted` grants the key package's DID rather than to the last one, and it raises a separate
question the spec deliberately did not answer — what a roster grant means for a DID that never
joins. File it as a `docs/agents/plans/next/` item during the completing stage rather than folding
it in here.
