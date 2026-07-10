# Question 2.5 — Report B: Who consumes a group capability, and for what?

**Scope:** Part B (B1, B2, B3) of `docs/superpowers/probes/question-2.5-brief.md`. Read-only.
Part A (what `validateGroupCapability` proves, pre-join anchor readability, depth caps) is a
sibling report and is not covered here.

**Repos read:** `/Users/paul/dev/yulsi/kumiai`, `/Users/paul/dev/yulsi/kubun`.

---

## B1. Trace every consumer

### The producers

- `createGroupCapability(identity, groupID)` — `packages/mls/src/capability.ts:22-32`. Mints the
  root admin cap: `sub == aud == identity.id`, `act: '*'`, `res: ['group/<groupID>/*']`. Self-issued
  (`iss === sub`), no `parentCapability`.
- `delegateGroupMembership(params)` — `packages/mls/src/capability.ts:47-69`. Mints a delegated
  membership cap: `sub: identity.id`, `aud: recipientDID`, `act: [permission]`,
  `res: ['group/<groupID>/*']`, optional `exp`, optional `parentCapability`.

### Every call site of the producers

Both are called from exactly one place each, both inside `@kumiai/mls`:

- `createGroupCapability` — `packages/mls/src/group.ts:423` (inside `createGroup`). The result is
  stringified into `rootCapability` (`group.ts:426`), seeded as the sole element of the creator's
  `credential.capabilityChain` (`group.ts:429`), stored raw as `credential.capability`
  (`group.ts:430`), and passed to the `GroupHandle` as `rootCapability` (`group.ts:438`).
- `delegateGroupMembership` — `packages/mls/src/group.ts:484-490` (inside `createInvite`). The
  inviter delegates from `group.rootCapability` (`group.ts:489`) — i.e. it parents off the root, not
  off the inviter's own chain (this is the member-relay defect the spec's §"Folded in" addresses).
  The result becomes `invite.capabilityToken` (`group.ts:495`) and the second link of
  `invite.capabilityChain` (`group.ts:496`).

No other package in kumiai calls either producer. `grep` for these symbols across `packages/**`
(excluding `lib/` and tests) hits only `mls/src/{capability,group,credential,types,index}.ts`.
`rpc`, `hub-*`, and `broadcast` do not consume group capabilities.

### Every reader of the resulting token

The token/chain is read in exactly these places, all in `@kumiai/mls`:

| Reader | Location | Uses it as… |
|---|---|---|
| `createInvite` — reads `group.rootCapability` as the `parentCapability` | `group.ts:489` | membership-proof root to delegate from |
| `processWelcome` — `validateGroupCapability({ tokenData: invite.capabilityToken, delegationChain: invite.capabilityChain.slice(0,-1) })` | `group.ts:586-593` | **membership proof** (the only authorization use of the chain) |
| `processWelcome` — copies `invite.capabilityChain` into `credential.capabilityChain`, `capToken` into `credential.capability`, `invite.capabilityChain[0]` into the handle's `rootCapability` | `group.ts:618-619`, `group.ts:628-632` | seeds the joiner's stored credential + handle root |
| `joinGroupExternal` — `credential.capabilityChain[0]` → `rootCapability` | `group.ts:832-835`, `group.ts:895` | just needs *a* root string to construct the handle; does **not** re-validate the chain |

`validateGroupCapability` (`capability.ts:93-124`) is the only reader that treats the chain as an
authorization proof. Every other read is plumbing: it moves the root string onto the handle or into
stored state. `GroupHandle.rootCapability` getter (`group.ts:196-197`) is read internally by
`createInvite` and re-plumbed by `commitInvite`/`removeMember`/`joinGroupExternal` when they clone
the handle (`group.ts:541`, `674`, `895`); none of those re-validate it.

### `rootCapability` and `credential.capabilityChain` in kubun

kubun never reads `invite.capabilityToken` or `invite.capabilityChain` directly. `grep` across
`kubun/packages/plugin-p2p` for those two names returns **zero** hits. kubun treats the kumiai
`Invite` as an opaque blob: it constructs it via `createInvite` inside `inviteToGroup`
(`kubun/.../groups/manager.ts:258-263`), embeds it as `invite: result.invite` in the `InvitePayload`
(`kubun/.../context/group.ts:649`, type at `kubun/.../groups/invite-payload.ts:56-60`), and on the
join side hands it straight back to `processWelcome` via `joinGroup`
(`kubun/.../groups/manager.ts:294-300`).

kubun **does** read and persist `rootCapability` and the whole credential (which contains
`capabilityChain`):

- `serializeMLSGroupState` writes `group.rootCapability` to a column and `JSON.stringify(group.credential)`
  (the credential JSON includes `capabilityChain`, per `mls/src/credential.ts:11-12`) —
  `kubun/.../groups/mls-state.ts:28-35`.
- `deserializeMLSGroupState` reads them back (`kubun/.../groups/mls-state.ts:47-58`),
  `fromMLSStateRow`/`toMLSStateInsert` map the DB row (`mls-state.ts:68-94`, column `root_capability`).
- `restoreMLSGroupHandle` passes `rootCapability` to `restoreGroup`
  (`kubun/.../groups/mls-group-handle.ts:10-11`).
- A test asserts the round-trip: `kubun/.../test/group-handle-registry.test.ts:40`.

**Who would break if `Invite.capabilityChain` disappeared?** Only the kumiai `mls` package. kubun
reads neither field, so kubun code compiles unchanged against a slimmer `Invite`. But kubun *persists*
`credential.capabilityChain` and `rootCapability` transitively (via `JSON.stringify(credential)` and
the `root_capability` column), so those fields must keep coming from *somewhere* — under the spec they
would be seeded from the anchor instead of the chain. See B3.

**Verdict for B1:** Every consumer uses the capability as a **membership proof** or as inert plumbing
for the root string. The single authorization consumer is `validateGroupCapability` in
`processWelcome` (`group.ts:587`). No consumer uses a group capability to authorize anything other
than group membership.

---

## B2. Are per-document grants a separate axis?

**Confirmed — per-document grants do not chain from any group capability.**

### `document/write` grants (the write axis)

Minted by `grantWriteCapability` — `kubun/.../context/group.ts:1344-1357`:

```
createCapability(deps.identity, {
  sub: deps.identity.id,   // self-issued
  aud: to,                 // the recipient
  act: 'document/write',
  res,                     // a document resource string, caller-supplied
  iat, exp, jti,
})
```

- **No `parentCapability`.** The `createCapability` call passes only `deps.identity` and the payload —
  no fourth `parentCapability` argument (contrast `mls/src/capability.ts:63-68`, which does). It is a
  root, self-issued grant, not a link off a group cap.
- **`res` is a document resource, not `group/...`.** Supplied by the GraphQL `res: String!` arg
  (`kubun/.../schema.ts:431`, `schema.ts:849`), e.g. `urn:kubun:user:<did>` per the reader side
  (`kubun/.../sync/authorize.ts:27-31`). It is never `group/<groupID>/*`.
- **`act: 'document/write'`**, disjoint from `GroupPermission` (`'admin' | 'member' | 'read'`,
  `mls/src/capability.ts:11`).

`store-received-grant.ts` (the receiver) verifies only the token's own signature
(`kubun/.../groups/store-received-grant.ts:60-67`) and its `aud`/`jti`/`exp`
(`store-received-grant.ts:70-77`). It does **not** walk a `parentCapability` chain and never
references a group capability. The group linkage is a flat DB edge (`jti → group_id`) written by
`addGroupDelegation` (`store-received-grant.ts:94`), purely for revoke-broadcast targeting — not an
authorization parent.

### `document/read` grants (the read axis)

`checkSyncDelegation` (`kubun/.../sync/authorize.ts:15-66`) authorizes reads with
`act: 'document/read'`, `sub: ownerDID`, `res ∈ {'*', 'urn:kubun:user:*', 'urn:kubun:user:<ownerDID>'}`.
These delegation tokens **can** themselves form an A→B→C chain (`cap: delegationTokens`,
`authorize.ts:41`), but the chain roots at the **document owner** (`sub: ownerDID`), not at a
`group/` capability. Different root, different `res` namespace, different `act`.

### The `'read' | 'write'` in the named files is per-document access

- `access-default-token.ts`: `permissionType: 'read' | 'write'` (`kubun/.../groups/access-default-token.ts:22`,
  `:28-29`) tags a *model access-default rule* — a sharing policy over a `modelID` — signed by the
  model owner (`iss`). Unrelated to `GroupPermission`; never `res: group/...`.
- `invite-payload.ts`: `InviteAccessDefault.permissionType: 'read' | 'write'`
  (`kubun/.../groups/invite-payload.ts:19`) is the same access-default rule carried as an invite seed.
- `broadcast.ts`: the `delegation:share` frame carries a `document/write` token verbatim
  (`kubun/.../groups/broadcast.ts:118-132`); the doc-comment is explicit it is the
  `document/write` capability, not a group role.

**Verdict for B2:** The spec's claim holds. No `document/*` grant chains from a group capability. The
write axis is self-issued off the grantor identity; the read axis chains off the document owner. Both
are orthogonal to `GroupPermission`. The group capability chain is **not** load-bearing for
document access.

---

## B3. What breaks in kubun if `Invite` loses `capabilityChain`?

kubun's own source needs **no edits to its invite/join call paths** — it never reads
`capabilityToken` or `capabilityChain`. The concrete impact is confined to what kumiai must supply so
kubun's *persistence* still has values to store.

### The invite path (`context/group.ts` → `manager.ts`)

- `invite` context handler: `kubun/.../context/group.ts:615-673`. Calls
  `deps.groupManager.inviteToGroup(...)` (`group.ts:620-627`) and embeds `result.invite` opaquely
  (`group.ts:649`). No field of `invite` is read here. **No edit needed** beyond whatever shape
  `createInvite` returns.
- `inviteToGroup`: `kubun/.../groups/manager.ts:254-290`. Calls kumiai `createInvite`
  (`manager.ts:258-263`) and returns `invite` untouched. **No edit needed.**
- kubun already ships the ledger bootstrap the roster fold needs: `collectInviteSeeds` →
  `ledgerEntries` in the payload (`kubun/.../context/group.ts:638-654`, applied at
  `context/join.ts:88-100` / `context/group.ts:719-731`). The brief's note that "kubun already ships
  ledger entries in the invite (`context/join.ts:91`)" is confirmed — `invite.ledgerEntries` at
  `context/join.ts:91`.

### The join path (`context/join.ts` / `context/group.ts` → `manager.ts`)

- `join` handlers: `kubun/.../context/join.ts:40-109` and `kubun/.../context/group.ts:675-738`. Both
  pass `invite.invite` into `joinGroup` (`join.ts:59`, `group.ts:691`) without reading its capability
  fields. **No edit needed.**
- `joinGroup`: `kubun/.../groups/manager.ts:292-300`. Forwards `params.invite` to `processWelcome`.
  **No edit needed in kubun** — the change lands inside kumiai's `processWelcome`.

### The persistence path — the one place kubun is materially affected

kubun persists two values that today originate from the chain:

1. `rootCapability` (column `root_capability`) — `kubun/.../groups/mls-state.ts:33`, `73`, `92`.
2. `credential.capabilityChain` — inside `JSON.stringify(group.credential)`
   (`kubun/.../groups/mls-state.ts:31`), because `MemberCredential` carries it
   (`mls/src/credential.ts:11-12`).

If `Invite.capabilityChain`/`capabilityToken` disappear, `processWelcome` can no longer populate
`credential.capabilityChain` (`group.ts:618`) or the handle `rootCapability` (`group.ts:628-632`)
from the invite. Two sub-cases:

- **If `MemberCredential.capabilityChain` and `GroupHandle.rootCapability` also go away** (the chain
  is removed end-to-end), then `mls-state.ts` must stop serializing `rootCapability` and the
  `root_capability` column becomes dead. That is a kubun schema/serialization edit
  (`mls-state.ts:16-94`) plus the round-trip test (`group-handle-registry.test.ts:40`), **and**
  `joinGroupExternal`'s `credential.capabilityChain[0]` read (`group.ts:832`) needs a replacement
  source for its handle root (the anchor's `creatorDID`, or a synthesized root). This is the load-
  bearing consequence and is a kumiai-side decision that ripples into kubun persistence.
- **If those fields are retained but merely no longer travel in `Invite`** (seeded from the anchor at
  join instead), kubun's persistence is unchanged; only kumiai's `processWelcome` changes to derive
  them from the anchor + `Invite.ledgerEntries`. kubun needs **no edits at all**.

Which sub-case applies is a kumiai design choice outside Part B's evidence (it depends on whether
`joinGroupExternal`/`createInvite` keep needing a `rootCapability` string). **UNRESOLVED here** —
settling it requires deciding whether `GroupHandle.rootCapability` and
`MemberCredential.capabilityChain` survive the chain's removal, which is Part A / spec-authoring
territory, not readable from current kubun source.

### Summary of concrete kubun edits

- **Guaranteed:** none to the invite/join call paths — kubun reads neither field.
- **Conditional (only if kumiai drops `rootCapability`/`credential.capabilityChain` too):**
  - `kubun/.../groups/mls-state.ts` — drop `rootCapability` from `SerializedMLSGroupState`,
    `serialize`/`deserialize`, `fromMLSStateRow`/`toMLSStateInsert`, and the `root_capability` column
    (lines 20, 33, 40, 56, 73, 92).
  - `kubun/.../groups/mls-group-handle.ts:10-11` — stop passing `rootCapability` to `restoreGroup`.
  - `kubun/.../test/group-handle-registry.test.ts:40` — update the round-trip assertion.
  - A store migration to drop/ignore the `root_capability` column.

---

## Answers (one line each)

- **B1 — every consumer:** Only `@kumiai/mls` consumes group capabilities; the single authorization
  reader is `validateGroupCapability` in `processWelcome` (`group.ts:587`) using it as a membership
  proof — every other read is inert plumbing of the root string; kubun reads neither
  `capabilityToken` nor `capabilityChain`.
- **B2 — per-document grants:** Confirmed a separate axis — `grantWriteCapability` mints self-issued
  `document/write` caps with no `parentCapability` (`context/group.ts:1349-1357`), read grants chain
  off the document owner not a group cap (`sync/authorize.ts:33`, `sub: ownerDID`), and no `document/*`
  grant chains from a group capability; the `'read'|'write'` in the named files is per-document access,
  unrelated to `GroupPermission`.
- **B3 — kubun breakage:** kubun's invite/join call paths need **no edits** (it treats `Invite`
  opaquely and already ships `ledgerEntries`); the only material impact is persistence of
  `rootCapability`/`credential.capabilityChain`, and whether that requires kubun edits is UNRESOLVED —
  it hinges on whether kumiai keeps `GroupHandle.rootCapability` after the chain goes.

## Notes / surprises

- kubun does **not** read the capability chain anywhere — `grep` for
  `capabilityToken`/`capabilityChain` in `plugin-p2p` returns zero hits. The chain is entirely a
  kumiai-internal proof; kubun only persists it because it lives inside the serialized credential.
- The `root_capability` value kubun persists is never re-validated after join — `restoreGroup` and
  `joinGroupExternal` (`group.ts:832`, `895`) treat it as an opaque string needed only to construct a
  handle. Its authorization value is spent entirely at the single `validateGroupCapability` call in
  `processWelcome`.
