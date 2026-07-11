# @kumiai/mls

Credential-aware MLS (RFC 9420) group lifecycle for enkaku. Wraps [`ts-mls`](https://github.com/LukaJCB/ts-mls) with DID-based identity and a signed control ledger, giving every member a `MemberCredential` that ties their MLS leaf to their DID, and a group-wide roster that decides who may add, remove, and rotate.

## Capabilities

- `createGroup` — creator opens a new group as its sole member and first admin
- `createInvite` + `commitInvite` — an admin signs the invitee's role entry and produces the MLS Commit + Welcome
- `processWelcome` — invitee joins after folding the ledger the invite carries and checking its head
- `commitLedgerEntries` — an admin promotes or demotes by committing signed `group.role` entries
- `removeMember` — an admin evicts a leaf and rotates keys
- `restoreGroup` — rehydrate a `GroupHandle` from persisted `ClientState` and the stored ledger tokens
- `exportGroupInfo` + `joinGroupExternal` — stale-device self-rejoin (see below)

## Authority model

Authority is a **roster**, folded from a signed **control ledger** and rooted at a genesis anchor installed in the GroupContext when the group is created. There is no capability chain: a member's right to act is decided by the roster every peer computes independently, not by a token the member carries.

- **The ledger is an ordered log of enactments.** Each entry is a token signed by its issuer (a `group.role` entry names a subject DID and grants `admin` or `member`). The log is replayable and position-dependent: the same claim recurring later is meaningful — a demotion back to a previously-held role is exactly that.
- **The roster is the fold.** `foldRoster` applies each entry only if its issuer was an admin *in the state so far, at that entry's own position*. A token signed by a since-demoted admin is dead paper whoever carries it. The fold starts from the anchor (`{creator: 'admin'}`), so no one can promote themselves by padding an invite.
- **Enactment is admin-only, structurally.** Entries reach the group inside a commit, and a commit that enacts entries must extend the GroupContext ledger-head extension by exactly those ids, in order. Moving the head needs a `group_context_extensions` proposal, which needs admin. A plain member's only permitted proposal is `update`; attaching an envelope to it fails for want of a head move. The write path runs the receivers' own fold before authoring, so it never builds a commit the group would reject.
- **`GroupPermission` is `'admin' | 'member'` — there is no read-only tier.** It cannot exist: a group member holds the epoch secrets, which is what membership *is* in MLS. A `read` member derives the same application keys as any other member and can decrypt everything. Read-only observers do not belong in the group; gate them outside MLS, at the transport or storage layer.

The invite carries the full ordered ledger plus the invitee's new role entry last, so a joiner folds the same roster the group holds and cannot fork from a role change made before it joined.

## External rejoin (stale device recovery)

Each device owns its MLS leaf and ratchet state. A device that stays offline long enough for the group to advance epochs (adds, removes, key rotations) can no longer decrypt current application messages. Replaying every missed commit sequentially is expensive and may be impossible if intermediate commits are no longer available.

RFC 9420 §11.2.1 defines an external commit: a non-member (or stale member) builds a Commit using only the group's `GroupInfo` (carrying an `external_pub` key). `@kumiai/mls` wraps this for the stale-member case — same DID, cached `MemberCredential`, `resync: true` so the joiner's old leaf is removed in the same commit.

```ts
// On any healthy member (online, current epoch):
import { exportGroupInfo } from '@kumiai/mls'
const { groupInfo } = await exportGroupInfo({ group: aliceGroup })
// groupInfo is a Uint8Array framed as MLSMessage(GroupInfo). Ship it to the stale device.

// On the stale device:
import { joinGroupExternal } from '@kumiai/mls'
const { commitMessage, group } = await joinGroupExternal({
  identity: bob,                    // OwnIdentity from @kokuin/token
  groupInfo,                        // bytes received from the healthy member
  credential: bobStoredCredential,  // cached from the original processWelcome
  resync: true,
})
// Broadcast commitMessage (Uint8Array) to the other members; each decodes and calls
// group.processMessage(decoded). The returned `group` is already at the post-commit
// epoch — ready to encrypt/decrypt.
```

### Trust model

An external commit is enforced as a **resync of an existing roster member**, never a new join. Every receiver runs the commit policy on it: the committing DID (resolved from the commit's own UpdatePath leaf credential) must be in the roster, and the commit's proposals must be exactly one `external_init` plus one `remove` of the leaf whose DID equals that committer — nothing else. A stranger in no roster who obtains a leaked `GroupInfo` is rejected; a legitimate member rejoining is accepted. New members never arrive this way — they join through Welcome.

### Transport

`@kumiai/mls` ships bytes, not channels. Callers own:
- Delivering `groupInfo` bytes from a healthy member to the stale device (e.g. via a hub, directory service, or DM).
- Broadcasting `commitMessage` bytes to every other member.
- Rebuilding application state (message backlog, per-member projections) — enkaku does not replay missed application messages.

### Not yet supported

- **Fresh external join by a new DID.** Requires deciding how a non-member acquires a `MemberCredential` without a live inviter.
- **Member-proposed external add.** `proposeAddExternal` is not wrapped yet.
- **Non-resync external join.** `joinGroupExternal` accepts only `resync: true` (enforced via a literal type in `JoinGroupExternalParams`). Non-resync external join requires a separate API.

### ⚠️ Security: removal is not revocation

MLS has no cryptographic member revocation. `removeMember` evicts a leaf; it does not erase the removed DID's `group.role` grant, which lives in the roster independently of MLS membership. So a device that retains its `MemberCredential` can rejoin via `joinGroupExternal` **even after being removed** — its DID is still a roster member, so the external-commit policy admits the resync — provided it can still obtain a fresh `GroupInfo`. (The policy stops *strangers*, who are in no roster; it does not stop a removed member.) Consumers must assume a removed member can rejoin until role revocation lands in a follow-up spec. Mitigations available today:

- Rotate the group: create a new group, migrate non-removed members via fresh invites, abandon the old group.
- Enforce access control outside MLS: block the removed device at the transport layer (e.g. hub auth).

The follow-up revocation work will introduce a ledger entry that removes a DID's role from the roster, synced through the same GroupContext ledger-head extension the roster already rides. Once a revoked DID is no longer a roster member, the external-commit policy rejects its resync exactly as it rejects a stranger today.
