# Probe report — Question 2.4: the roster reducer

Status: **DONE**. All four verify commands pass.

## What I built

`packages/mls/src/roster.ts` — a generalization of kubun's `adminRosterReducer`, moving from an
`admin`/`revoked` `Set<string>` to a `GroupPermission` `Map<string, GroupPermission>`:

- `ROLE_ENTRY_TYPE = 'group.role'` and `RoleValue = GroupPermission`.
- `RosterState = { roles: ReadonlyMap<string, GroupPermission> }`.
- `roleReducer: LedgerReducer<RoleValue, RosterState>` — the composable, group-agnostic core:
  - **seed**: `roles = { normalizeDID(anchor.creatorDID): 'admin' }`.
  - **verifyAuthority**: `stateSoFar.roles.get(normalizeDID(verified.issuer)) === 'admin'` — kubun's
    state-so-far rule unchanged; any admin may promote/demote any member or admin.
  - **apply**: `roles.set(normalizeDID(subject), value)`. DID-keyed, so a subject need not be present
    yet; a demotion is `value: 'member'`, a promotion `value: 'admin'`.
- `foldRoster(entries, anchor, groupID, onDrop?)` — the safe public entry point. It wraps
  `roleReducer` in a scoped reducer that adds the two concerns the plain reducer cannot own, then
  calls `foldLedger`.

Exports added to `packages/mls/src/index.ts`: `foldRoster`, `ROLE_ENTRY_TYPE`, `RoleValue`,
`RosterState`, `roleReducer`.

Test: `packages/mls/test/roster.test.ts`, covering all eight required cases (seed, promote, demote an
admin, state-so-far rotation, non-admin issuer dropped, cross-group dropped, subject-before-Add,
empty-admin guard including the "one admin remains is fine" variant).

## The `groupID`-scoping decision: (a), explicit `groupID` on `foldRoster`

I chose **(a)**. The anchor is `{ creatorDID, version, app? }` (`anchor.ts:32-43`) and carries no group
id, so option (b) — reading it from the anchor — is not available without changing the anchor shape,
which the brief forbids without stopping to report. I did **not** change the anchor. `foldRoster`
therefore takes `groupID` explicitly and closes over it in the scoped reducer's `verifyAuthority`,
which drops any entry whose `entry.groupID !== groupID`.

This means `foldRoster`'s signature gained a required `groupID` parameter versus the sketch in the
brief (`(entries, anchor, onDrop?)` → `(entries, anchor, groupID, onDrop?)`). The brief's own option
(a) — "`foldRoster` takes an explicit `groupID` and closes over it in the reducer" — requires exactly
this parameter, so the sketch was a starting point, not a constraint. `groupID` is placed before the
optional `onDrop`.

Why `groupID` scoping and the empty-admin guard both live in `verifyAuthority` rather than in `apply`
or a pre-filter: `foldLedger` only surfaces drops (`onDrop`) from its `type` and `verifyAuthority`
checks — `apply` has no way to emit a drop notice, and a pre-filter would drop cross-group entries
silently before the fold ever sees them. The brief requires both a cross-group drop and an
empty-admin drop "with an `onDrop` notice". Routing both through `verifyAuthority` (the empty-admin
guard by simulating `roleReducer.apply` on the state-so-far and rejecting when the would-be next
state has zero admins) is the honest way to get the notice while still building on `foldLedger`
unchanged. The static exported `roleReducer` deliberately does **not** carry the guard or the group
scoping — it is the reusable seed/authority/apply, mirroring how kubun exports `adminRosterReducer`
separately from `foldAdminRoster`; `foldRoster` is the bricking-safe entry point.

## `GroupPermission` narrowing (Step 0) — confirmation

Done, scoped exactly as instructed; no wider Phase 5.1 work (no `../kubun` grep sweep, no docs prose).

- `capability.ts:11`: `export type GroupPermission = 'admin' | 'member'` (dropped `| 'read'`).
- `credential.ts`: deleted the now-dead `if (actions.includes('read')) return 'read'` branch of
  `extractPermission`. `'*'`/`'admin'` → `admin`, `'member'` → `member`, anything else throws —
  unchanged. A `read`-only capability now recognizes no level and **throws**.
- `credential.test.ts`:
  - The `extracts read permission` test (which delegated a `permission: 'read'` capability and
    asserted `.toBe('read')`) became `extractPermission throws for a read-only capability`, asserting
    `extractPermission(makeSignedTokenWithAct(['read']))` throws `no recognized permission level`.
    Coverage is preserved, not deleted — it now documents that `read` is not a permission level. This
    also had to stop using `delegateGroupMembership({ permission: 'read' })`, which no longer
    type-checks now that `GroupPermission` excludes `'read'`.
  - The `_typeCheck` `MemberCredential` literal at the bottom used `permission: 'read'` (no longer
    assignable) and `act: 'read'`; both changed to `'member'`.

Grep confirmed no other `'read'` references remain in `packages/mls/src` or `packages/mls/test`.

## Did test-first change anything?

The caller-facing shape read cleanly, so the API did not need reshaping from the test's perspective —
the one adjustment surfaced by writing tests first was the `groupID` parameter, which the
cross-group-drop test (case 6) forces: without a group to fold against, there is nothing to compare
`entry.groupID` to. That confirmed decision (a) empirically rather than on paper.

Real signing is exercised in the promote test (case 2), which builds the entry through
`signLedgerEntry` + `verifyLedgerEntry` + `ledgerEntryDigest`, proving the wiring end to end; the
remaining cases hand-build `VerifiedLedgerEntry` values where signing would add nothing.

## Surprises

None material. One stale type error flashed from the PostToolUse hook: the batched `capability.ts`
and `credential.ts` edits ran the type-checker between them, so it briefly saw a narrowed
`GroupPermission` while `credential.ts` still had `return 'read'`. It cleared once the second edit
landed; the final `tsc` run is clean.

## Verify — pasted output

```
$ pnpm --filter @kumiai/mls exec vitest run test/roster.test.ts test/credential.test.ts
 Test Files  2 passed (2)
      Tests  25 passed (25)

$ pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
EXIT:0   (no output)

$ pnpm exec biome check ./packages ./tests
Lint: No issues found
EXIT:0

$ pnpm --filter @kumiai/mls exec vitest run
 Test Files  15 passed (15)
      Tests  149 passed (149)
```

The final full-suite run proves no regression from the `GroupPermission` narrowing or the new module.
