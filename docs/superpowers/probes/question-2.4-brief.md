# Probe brief — Question 2.4: the roster reducer

Create `packages/mls/src/roster.ts` and `packages/mls/test/roster.test.ts`. Export the new symbols
from `packages/mls/src/index.ts`. Also make a **small type-narrowing change** to `capability.ts` and
`credential.ts` (scoped below). Touch nothing else in `src/`.

Read `AGENTS.md` and `kigu:conventions` first. `type` not `interface`; `Array<T>` not `T[]`; never
`any`; capital `ID`/`DID`; ES `#fields`. **No plan/question/phase labels in code, comments, or test
names.** State constraints directly.

**Write the test first.** Show a caller folding a list of `group.role` entries into a roster and
reading a member's permission — before implementing. If it reads awkwardly, fix the API and say so.

## Where this comes from

`kubun/packages/plugin-p2p/src/groups/admin-roster.ts` — read its `adminRosterReducer` half (the
`seed` / `verifyAuthority` / `apply`). This is the same reducer, generalized from an
`admin`/`revoked` `Set` to a `GroupPermission` `Map`, built on the `foldLedger` and `LedgerReducer`
that landed in `packages/mls/src/fold.ts`, and the `LedgerEntry` in `packages/mls/src/ledger.ts`.

## Step 0 — narrow `GroupPermission` (prerequisite)

`capability.ts:11` is `export type GroupPermission = 'admin' | 'member' | 'read'`. The roster value
must be exactly `'admin' | 'member'`, so:

- Change it to `export type GroupPermission = 'admin' | 'member'`.
- In `credential.ts`, delete the now-dead `if (actions.includes('read')) return 'read'` branch of
  `extractPermission`. `act: '*'` and `act: 'admin'` map to `admin`; `act: 'member'` maps to
  `member`; anything else throws, unchanged.
- Fix the two `credential.test.ts` cases that reference `'read'` (lines ~98–101 and ~186–187):
  a capability whose only action is `read` no longer maps to a permission — it now **throws**
  (`extractPermission` recognizes no level). Change those assertions to reflect that `read` is not a
  permission level, rather than deleting the coverage: assert `extractPermission` throws on an
  `act: 'read'` capability.

Do **not** do the wider Phase 5.1 work (the `../kubun` grep sweep, the docs prose). Just the type,
the dead branch, and the two tests. Note in your report that you did this and why.

## What to build in `roster.ts`

```ts
import type { GroupPermission } from './capability.js'
import { type FoldDrop, type FoldInput, foldLedger, type LedgerReducer } from './fold.js'
import type { GroupAnchor } from './anchor.js'
import type { LedgerEntry, VerifiedLedgerEntry } from './ledger.js'
import { normalizeDID } from '@kokuin/token'

/** The ledger entry type the roster projects. */
export const ROLE_ENTRY_TYPE = 'group.role'

/** A role claim's value: the permission the subject is granted. */
export type RoleValue = GroupPermission

export type RosterState = { roles: ReadonlyMap<string, GroupPermission> }

export const roleReducer: LedgerReducer<RoleValue, RosterState>

export function foldRoster(
  entries: Array<FoldInput<RoleValue>>,
  anchor: GroupAnchor,
  onDrop?: (drop: FoldDrop) => void,
): RosterState
```

Semantics, from the spec's "Roster and authority rules":

- **Seed** from the anchor: `roles = { normalizeDID(anchor.creatorDID): 'admin' }`. Keys are always
  normalized DIDs.
- **`verifyAuthority`**: the issuer must be an admin in the state so far —
  `stateSoFar.roles.get(normalizeDID(verified.issuer)) === 'admin'`. This is kubun's rule unchanged;
  any admin may promote or demote any member or admin.
- **`groupID` scoping**: `verifyAuthority` (or the reducer's type check) must **drop** an entry
  whose `entry.groupID` does not match the group being folded. But the reducer does not know the
  group id by itself — decide how it learns it. Two options, pick one and justify it in the report:
  (a) `foldRoster` takes an explicit `groupID` and closes over it in the reducer; (b) the reducer
  reads it from the anchor if the anchor carries the group id. **The anchor does not carry a group
  id today** (it is `{creatorDID, version, app?}`), so (a) is likely the honest choice — but look
  before deciding, and if you add anything to the anchor, stop and report rather than doing it.
- **`apply`**: set `roles.get(normalizeDID(subject)) = value`. A demotion is `value: 'member'`.
  Promotion is `value: 'admin'`. The subject need not already be in the roster — an entry may name
  a DID not yet added (the roster is DID-keyed, not leaf-keyed, and an entry can precede the Add).
- **The empty-admin guard**: an entry that would leave the roster with **zero** admins is dropped
  (with an `onDrop` notice), so the group can never be bricked into a state where nobody can
  add/remove/promote. This is a fold-step guard: compute the would-be next state, and if its admin
  count is zero, drop instead of applying.

## Done when

`roster.test.ts` covers, at minimum:

1. **Seed.** An empty ledger yields a roster where the creator is `admin` and everyone else is
   absent. `foldRoster([], anchor)` — creator present as admin, a random other DID `undefined`.
2. **Promote.** An admin promotes a member to admin; the member reads back `admin`.
3. **Demote an admin.** An admin demotes *another* admin to member (any admin may demote any
   admin); reads back `member`, and the demoter is unaffected.
4. **State-so-far (rotation).** Alice (creator) promotes Bob to admin; Bob promotes Carol to admin;
   Alice demotes Bob to member. Carol remains admin — she was promoted by Bob while Bob was an
   admin. (This is the corrected form of the rotation test: the surviving grant's issuer, Bob, is
   the party later demoted; final-state evaluation would drop Carol.)
5. **Non-admin issuer dropped.** A `member` issues a role entry; it is dropped (`onDrop` notice),
   roster unchanged.
6. **Cross-group entry dropped.** An entry whose `groupID` differs from the folded group is dropped.
7. **Subject-before-Add.** An entry naming a DID that is not otherwise present still records that
   DID's role (roster is DID-keyed).
8. **Empty-admin guard.** The last admin demoting themselves (a `group.role` entry with
   `subject == issuer`, `value: 'member'`) is dropped, and the roster keeps them as admin. Also:
   a single admin demoting the only *other* admin is fine (one admin remains); only the transition
   to *zero* admins is blocked.

Define the entries with `signLedgerEntry` + `verifyLedgerEntry` from `ledger.ts` for at least the
round-trip cases, or hand-build `VerifiedLedgerEntry` values directly where signing adds nothing —
your call, but at least one test must go through real signing so the wiring is proven.

## Rules

- **Stop at the first failure of the approved approach.** Report `BLOCKED`. No alternatives without
  asking. In particular, if the `groupID`-scoping question makes you want to change the anchor
  shape, STOP and report — that is a design decision, not a probe decision.
- Paste **actual command output**.

## Verify

From repo root (`/Users/paul/dev/yulsi/kumiai`); `rtk` intercepts `pnpm run`, use `pnpm exec`:

```
pnpm --filter @kumiai/mls exec vitest run test/roster.test.ts test/credential.test.ts
pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
pnpm exec biome check ./packages ./tests
pnpm --filter @kumiai/mls exec vitest run
```

All four pass; the last proves no regression.

## Report contract

Full report to `docs/superpowers/probes/question-2.4-report.md`: what you built, the `groupID`-scoping
decision (a vs b) and why, confirmation of the `GroupPermission` narrowing and what it touched,
anything test-first changed, pasted output of all four commands, any surprise.

Return to the caller **only**: status, one-line summary, the `groupID` decision, and concerns.
