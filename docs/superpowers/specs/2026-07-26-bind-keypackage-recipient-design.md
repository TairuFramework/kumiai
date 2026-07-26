# Bind a key package's credential DID to the invite recipient

**Origin:** `docs/agents/plans/next/2026-07-26-bind-keypackage-to-invite-recipient.md`, surfaced by
the whole-branch review of the last-resort key-package work landed 2026-07-26.

## Problem

`commitInvite` (`packages/mls/src/group-commit.ts:285`) hands whatever `KeyPackage` it is given
straight into the Add proposal. It validates that `invite.groupID` matches the group; it does not
check that the key package's credential DID is the identity the invite grants a role to. The
identity that actually joins is therefore decided by whoever supplied the bytes — today, the hub's
key-package store.

The failure mode is not a refusal, it is a silent success:

- A fetch for BOB that returns ALICE's key package Welcomes **ALICE** into the group, where she
  derives the epoch secrets and reads everything.
- The ledger entry the same commit enacts grants the role to **BOB**. Roster and MLS membership
  disagree, and no party can notice from its own state.

The reachable trigger is a `HubStore` whose last-resort read drops its owner predicate.
`@kumiai/hub-conformance` catches exactly that, but that makes the store layer the only check —
the layer furthest from the group's own security decision.

## Scope

`packages/mls` only.

`joinGroupExternal` needs no analogous check: it builds its own key package from `identity`
(`packages/mls/src/group-welcome.ts:240`), so nothing external picks the joining identity.

No port and no test double is affected. `commitInvite` is a `@kumiai/mls` API, not an rpc port
member; `packages/rpc/src/crypto.ts` never mentions invites and `memory-group-mls` has no invite
surface. Neither contract suite changes.

## Design

### The check

In `commitInvite`, after `entriesAddedByInvite` and before the Add proposal is built — so a wrong
package costs no commit:

1. Verify each token in `enacted`, collecting the `subject` of every entry whose type is
   `ROLE_ENTRY_TYPE` and whose `groupID` is the group's own.
2. Refuse unless exactly one such subject was collected.
3. Read the key package's credential (`keyPackage.leafNode.credential`). Refuse a credential that
   is not `basic`.
4. Parse its identity with `parseMLSCredentialIdentity` and compare `normalizeDID(parsed.id)`
   against `normalizeDID` of the one collected subject. Refuse on mismatch.

`parseMLSCredentialIdentity` already throws a descriptive bare `Error` on malformed identity
bytes; let it propagate rather than wrapping it.

```ts
const enacted = entriesAddedByInvite(group, invite)

const roleSubjects: Array<string> = []
for (const token of enacted) {
  const verified = await verifyLedgerEntry(token)
  if (verified?.entry.type === ROLE_ENTRY_TYPE && verified.entry.groupID === group.groupID) {
    roleSubjects.push(verified.entry.subject)
  }
}
if (roleSubjects.length !== 1) {
  throw new Error(
    `commitInvite: the invite must enact exactly one ${ROLE_ENTRY_TYPE} entry for this group, got ${roleSubjects.length}`,
  )
}
```

Why the subject of the enacted role entry, rather than a new `Invite.recipientDID` field: the
enacted entry is the grant this same commit applies to the roster. Binding the MLS leaf to it is
the invariant the gap describes — roster and membership cannot disagree — and it needs no type
change and no new input. An explicit field would be self-declared data that can drift from the
ledger it travels with, so it would need its own consistency check against the same entry to be
worth anything.

Why exactly one: `createInvite` produces exactly one role entry, always last. Requiring one makes
the binding unambiguous by construction rather than by an ordering rule a reader has to know.
Non-role entries may still ride along, so an invite that also carries app-domain entries stays
possible.

The `groupID` filter on the role entry is free and stops an entry for another group from supplying
the subject.

A non-`basic` credential is a refusal, not a skip. kumiai only ever issues `basic`
(`packages/mls/src/group-credential.ts:33`), so a package that is not one carries no DID to bind
and must not be added. It throws the bare shape `Error`, not the typed one — see below.

### Error

```ts
export type InviteRecipientMismatchErrorParams = {
  groupID: string
  expectedDID: string
  actualDID: string
}

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

  /** DID the enacted role entry grants to. */
  get expectedDID(): string {
    return this.#expectedDID
  }

  /** DID the supplied key package presents. */
  get actualDID(): string {
    return this.#actualDID
  }
}
```

Exported from `@kumiai/mls`, so a host can distinguish "the hub served the wrong package" from an
ordinary rejection and alert on it. That operational signal is the point of the class.

Constructor takes a params object, diverging from the four neighbouring mls error classes, which
are positional. Three same-typed strings positionally means a swapped `expectedDID`/`actualDID`
compiles clean and reports the substitution backwards.

Getters are named `expectedDID`/`actualDID`, never bare `expected`/`actual`. `head.ts:41` records
why: a test runner's diff formatter assigns those on any thrown Error, and a getter-only pair
turns that into a `Cannot set property` TypeError masking the real failure.

Two cases stay a bare `Error`, because neither is an identity substitution and hosts have no
distinct action to take on either:

- zero or two-plus role entries in `enacted` — a badly built invite;
- a non-`basic` credential — a package that is not a kumiai one at all. Reporting it through
  `InviteRecipientMismatchError` would mean inventing a stand-in string for `actualDID`, which is
  the placeholder-value anti-pattern the conventions forbid.

## Testing

In `packages/mls/test/`, against real groups (no doubles involved):

- Invite for BOB, key package generated for ALICE → `InviteRecipientMismatchError`, with
  `expectedDID` BOB and `actualDID` ALICE. **Mutation-check:** remove the check, confirm this test
  fails, restore it.
- Honest path still commits and the invitee joins — proves the check is not a blanket refusal.
- `enacted` carrying no role entry for this group → the bare shape `Error`.
- `enacted` carrying two role entries → the bare shape `Error`.
- A key package whose credential is not `basic` → the bare shape `Error`.
- `createInvite` called with a did:peer:4 recipient's **long form** still commits. `normalizeDID`
  folds peer:4 to its short form, and `makeMLSCredential` writes the short form into the
  credential `id` — so without normalizing both sides this honest path would break.

## Out of scope

- Any `Invite` type change.
- Checking that the added DID is not already a member.
- Changes to `joinGroupExternal`, the rpc ports, or either conformance suite.
