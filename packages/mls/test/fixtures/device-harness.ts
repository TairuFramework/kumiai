import { createFullIdentity, type OwnIdentity, randomIdentity } from '@kokuin/token'
import { defaultCredentialTypes, generateKeyPackageWithKey } from 'ts-mls'

import { controlCapabilities } from '../../src/anchor.js'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  type GroupHandle,
  processWelcome,
} from '../../src/group.js'
import { resolveMlsContext } from '../../src/group-context.js'
import { addDevice } from '../../src/group-device.js'
import { ledgerEntryDigest } from '../../src/ledger.js'
import type { GroupOptions, KeyPackageBundle } from '../../src/types.js'
import { type BoundLeaf, buildBoundLeaf } from './bound-leaf.js'
import { buildManagementCapability } from './management-capability.js'

const GROUP = 'device-write-group'

/**
 * Real, end-to-end group-assembly harnesses for the did:kokuin device write path, shared across
 * device-write.test.ts, device-authority.test.ts, and device-attacks.test.ts. Kept in a plain
 * (non-`.test.ts`) module deliberately: a `.test.ts` file re-executes its own top-level
 * describe/test registrations on import, so importing helpers FROM a test file would silently
 * double-run that file's own suite wherever it's imported.
 */

/** A resolver backed by a mutable token map, filled as writes are published (see
 *  `publishTokens`) — lets a second existing member's `processMessage` resolve ledger entries
 *  named by a commit's envelope that it never saw directly. */
export function mapResolver(tokens: Map<string, string>): GroupOptions['resolveLedgerEntries'] {
  return async (ids) => ids.map((id) => tokens.get(id)).filter((t): t is string => t != null)
}

/** Publish every ledger token `group` currently holds into the shared resolver map. Call after a
 *  write's sender-side `newGroup` has applied its token, before a receiver processes the commit. */
export function publishTokens(tokens: Map<string, string>, group: GroupHandle): void {
  for (const token of group.ledgerTokens) {
    tokens.set(ledgerEntryDigest(token), token)
  }
}

/** Build a key package presenting `leaf`'s bound-leaf credential, ready for an Add/Welcome —
 *  the exact shape `joinBoundDevice` and `addDevice`-driven co-device joins both need. */
export async function buildBoundKeyPackageBundle(
  leaf: BoundLeaf,
  deviceSeed: Uint8Array,
): Promise<KeyPackageBundle> {
  const context = await resolveMlsContext()
  const keyPackage = await generateKeyPackageWithKey({
    credential: { credentialType: defaultCredentialTypes.basic, identity: leaf.identity },
    signatureKeyPair: { signKey: deviceSeed, publicKey: leaf.deviceKey },
    cipherSuite: context.cipherSuite,
    capabilities: controlCapabilities(),
  })
  return { ...keyPackage, ownerDID: leaf.deviceID }
}

/**
 * Assembles a real group in which a bound device D (of profile P) is a member: the creator
 * makes the group, invites D by its own device DID, D's key package carries the bound-leaf
 * credential (controller = P), and D processes the resulting Welcome. Mirrors the
 * createGroup + createInvite + commitInvite/processWelcome shape used throughout group.test.ts,
 * with a hand-built key package (via `buildBoundLeaf` + `generateKeyPackageWithKey`) in place of
 * `createKeyPackageBundle`, since that helper only ever mints an unbound (id-only) credential.
 */
export async function joinBoundDevice(): Promise<{
  deviceGroup: GroupHandle
  deviceIdentity: OwnIdentity
  deviceID: string
  controllerID: string
  /** The raw bound-leaf fixture D joined with — its `.identity` re-decodes to the leaf-embedded
   *  authenticate capability (e.g. for an attack that misuses it as a management capability). */
  leaf: BoundLeaf
  /** The creator's own identity — an admin able to sign further ledger entries (e.g. a role
   *  grant to the profile), distinct from `creatorGroup`'s committer-only surface. */
  creatorIdentity: OwnIdentity
  /** The creator's own group handle, post-invite-commit — a SECOND existing member distinct
   *  from the device leaf, used to exercise the real receive path (`processMessage`). */
  creatorGroup: GroupHandle
  /** The resolver map backing `creatorGroup`'s (AND `deviceGroup`'s) `resolveLedgerEntries` —
   *  publish a write's token into it (via `publishTokens`) before having the other side process
   *  that write's commit; shared so either direction of receive-path sync works. */
  tokens: Map<string, string>
}> {
  const tokens = new Map<string, string>()
  const creator = randomIdentity()
  const { group: creatorGroup } = await createGroup(creator, GROUP, {
    resolveLedgerEntries: mapResolver(tokens),
  })

  const deviceSeed = new Uint8Array(32).fill(41)
  const leaf = await buildBoundLeaf({ deviceSeed })
  const deviceIdentity: OwnIdentity = { ...createFullIdentity(deviceSeed), privateKey: deviceSeed }

  const { invite } = await createInvite({
    group: creatorGroup,
    identity: creator,
    recipientDID: leaf.deviceID,
    permission: 'member',
  })

  const keyPackageBundle = await buildBoundKeyPackageBundle(leaf, deviceSeed)

  const { welcomeMessage, newGroup: updatedCreatorGroup } = await commitInvite(
    creatorGroup,
    keyPackageBundle.publicPackage,
    invite,
  )

  const { group: deviceGroup } = await processWelcome({
    identity: deviceIdentity,
    invite,
    welcome: welcomeMessage,
    keyPackageBundle,
    ratchetTree: updatedCreatorGroup.state.ratchetTree,
    options: { resolveLedgerEntries: mapResolver(tokens) },
  })

  return {
    deviceGroup,
    deviceIdentity,
    deviceID: leaf.deviceID,
    controllerID: leaf.controllerID,
    leaf,
    creatorIdentity: creator,
    creatorGroup: updatedCreatorGroup,
    tokens,
  }
}

/**
 * Assembles a group with TWO devices of the same profile P: a MANAGER device (bound, per
 * `joinBoundDevice`, holding P's management capability with `aud` = the manager) and a TARGET
 * device of the same profile, brought in via `addDevice` itself. Using `addDevice` (rather than a
 * plain invite) is load-bearing: `addDevice` folds a `kumiai.device` `add` entry that records
 * `target -> P` in the registry, so `controllerOf(target)` resolves for `revokeDevice`'s gate
 * (Task 5's `verifyDeviceEntry`, revoke branch reads the folded registry, never the leaf's own
 * credential binding). A target that merely joined as a bound member leaf, without ever being
 * recorded by a device entry, would have `controllerOf(target) === undefined` and revoke would be
 * rejected.
 */
export async function twoDeviceProfileGroup(): Promise<{
  managerGroup: GroupHandle
  managerIdentity: OwnIdentity
  controllerID: string
  targetDeviceID: string
  capability: string
  /** The creator's own identity — see `joinBoundDevice`. */
  creatorIdentity: OwnIdentity
  /** The creator's group handle, already advanced past the addDevice commit below (processed via
   *  the real receive path) — a second existing member ready to receive a further write's commit,
   *  e.g. revokeDevice's. */
  creatorGroup: GroupHandle
  /** The raw addDevice commit bytes that brought the target device in, for receive-path tests. */
  addCommitMessage: Uint8Array
  /** The resolver map backing `creatorGroup`'s `resolveLedgerEntries` — publish a further write's
   *  token into it (via `publishTokens`) before having `creatorGroup` process that write's commit. */
  tokens: Map<string, string>
}> {
  const {
    deviceGroup,
    deviceIdentity,
    deviceID,
    controllerID,
    creatorIdentity,
    creatorGroup,
    tokens,
  } = await joinBoundDevice()
  const { capability } = await buildManagementCapability({
    managerDID: deviceID,
    managerKey: deviceIdentity.publicKey,
  })

  const targetSeed = new Uint8Array(32).fill(43)
  const targetIdentity: OwnIdentity = {
    ...createFullIdentity(targetSeed),
    privateKey: targetSeed,
  }
  const targetKeyPackageBundle = await createKeyPackageBundle(targetIdentity)

  const { newGroup: managerGroup, commitMessage: addCommitMessage } = await addDevice(
    deviceGroup,
    deviceIdentity,
    {
      keyPackage: targetKeyPackageBundle.publicPackage,
      device: targetIdentity.id,
      controller: controllerID,
      capability,
    },
  )

  // Advance the creator's own group past the add via the real receive path, so it is a member
  // in good standing ready to receive the next write's commit (e.g. revokeDevice's) too.
  publishTokens(tokens, managerGroup)
  await creatorGroup.processMessage(addCommitMessage)

  return {
    managerGroup,
    managerIdentity: deviceIdentity,
    controllerID,
    targetDeviceID: targetIdentity.id,
    capability,
    creatorIdentity,
    creatorGroup,
    addCommitMessage,
    tokens,
  }
}
