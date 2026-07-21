import { type OwnIdentity, randomIdentity } from '@kokuin/token'
import {
  type ClientState,
  commitInvite,
  commitLedgerEntries,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  decodeClientState,
  encodeClientState,
  type GroupHandle,
  type Invite,
  type KeyPackageBundle,
  ledgerEntryDigest,
  processWelcome,
  ROLE_ENTRY_TYPE,
  removeMember,
  restoreGroup,
  signLedgerEntry,
} from '@kumiai/mls'
import { createGroupCrypto, createGroupMLS, type LedgerEntrySlot } from '@kumiai/mls-rpc'
import type {
  Anchor,
  AnchorStore,
  AppCursorStore,
  CommitJournal,
  GroupPeer,
  GroupProtocolDefinition,
  JournalEntry,
  PendingCommit,
} from '@kumiai/rpc'
import { createGroupPeer } from '@kumiai/rpc'

import type { WireHub } from './log-hub-over-wire.js'

/**
 * The app protocol under test: one logged procedure, one ephemeral one beside it, and one
 * REQUEST — the directed lane's, which runs over the members' inbox topics rather than the app
 * topic. A member supplies a handler only for what it answers, so adding this costs the
 * event-lane tests nothing.
 */
export const chat = {
  'chat/changed': { type: 'event', data: { type: 'object' } },
  'chat/posted': { type: 'event', retain: 'log', data: { type: 'object' } },
  'chat/double': { type: 'request', param: { type: 'object' }, result: { type: 'object' } },
} as const satisfies GroupProtocolDefinition

export type Protocols = { chat: typeof chat }

// ---------------------------------------------------------------------------
// Host-side durable stores. These are the HOST's storage, not doubles of any
// component under test: the peer, the hub, the MLS handles and the crypto are
// all real, and a host has to put its anchor, cursor and journal somewhere.
// ---------------------------------------------------------------------------

export function createMemoryAnchorStore(): AnchorStore & { stored: () => Anchor | null } {
  let anchor: Anchor | null = null
  return {
    load: async () => anchor,
    save: async (next: Anchor) => {
      anchor = next
    },
    stored: () => anchor,
  }
}

export function createMemoryAppCursorStore(): AppCursorStore & {
  stored: (topicID: string) => string | null
} {
  const positions = new Map<string, string>()
  return {
    load: async (topicID: string) => positions.get(topicID) ?? null,
    save: async (topicID: string, position: string) => {
      const held = positions.get(topicID)
      // A read position only ever moves forward. The rule lives in the peer, so the store
      // is the only thing in a position to catch a regression that wrote one backwards.
      if (held != null && position < held) {
        throw new Error(`app cursor for ${topicID} may not move back from ${held} to ${position}`)
      }
      positions.set(topicID, position)
    },
    stored: (topicID) => positions.get(topicID) ?? null,
  }
}

export function createMemoryCommitJournal(): CommitJournal & { slot: () => JournalEntry | null } {
  let entry: JournalEntry | null = null
  return {
    put: async (next: JournalEntry) => {
      entry = next
    },
    markAccepted: async (publishID: string, sequenceID: string) => {
      if (entry?.publishID !== publishID) return
      entry = { ...entry, acceptedAs: sequenceID }
    },
    get: async () => entry,
    clear: async (publishID: string) => {
      if (entry?.publishID !== publishID) return
      entry = null
    },
    slot: () => entry,
  }
}

/**
 * The host's durable MLS state, in memory: the serialized ClientState plus the ledger
 * tokens needed to rebuild the roster. A restart is `restoreGroup` over exactly this.
 */
export type StateStore = {
  save: (handle: GroupHandle) => void
  saved: () => { state: Uint8Array; ledger: Array<string> } | null
}

export function createMemoryStateStore(): StateStore {
  let blob: { state: Uint8Array; ledger: Array<string> } | null = null
  return {
    save: (handle) => {
      blob = { state: encodeClientState(handle.state), ledger: [...handle.ledgerTokens] }
    },
    saved: () => blob,
  }
}

// ---------------------------------------------------------------------------
// A member: real MLS handle, real ports, real peer, real hub connection.
// ---------------------------------------------------------------------------

export type Member = {
  identity: OwnIdentity
  peer: GroupPeer<Protocols>
  handle: () => GroupHandle
  adopt: (handle: GroupHandle) => void
  anchorStore: ReturnType<typeof createMemoryAnchorStore>
  appCursorStore: ReturnType<typeof createMemoryAppCursorStore>
  journal: ReturnType<typeof createMemoryCommitJournal>
  stateStore: StateStore
  entrySlot: LedgerEntrySlot
  /**
   * Drop this member's hub connection — the other half of a process dying. Disposing the peer
   * stops the peer; it does not take the socket down.
   *
   * A restart no longer NEEDS this: the hub still binds one receive writer per DID, but the
   * newest channel takes the lane rather than being refused it (see `HubClientRegistry`), which
   * is what a real reconnect after a dropped connection depends on. Dropping the socket is still
   * the honest way to model a dead process, and `directed-lane`/`app-lane` use it for that.
   */
  disconnect: () => Promise<void>
}

export type MakeMemberParams = {
  hub: WireHub
  identity: OwnIdentity
  group: GroupHandle
  entrySlot: LedgerEntrySlot
  handlers?: Record<string, unknown>
  /** Carry a dead member's durable state forward — this is what a restart IS. */
  restartOf?: Member
}

export function makeMember(params: MakeMemberParams): Member {
  const { hub, identity, entrySlot, restartOf } = params
  let handle = params.group
  const anchorStore = restartOf?.anchorStore ?? createMemoryAnchorStore()
  const appCursorStore = restartOf?.appCursorStore ?? createMemoryAppCursorStore()
  const journal = restartOf?.journal ?? createMemoryCommitJournal()
  const stateStore = restartOf?.stateStore ?? createMemoryStateStore()

  const getHandle = () => handle
  const adopt = (next: GroupHandle) => {
    handle = next
    stateStore.save(next)
  }
  stateStore.save(handle)

  const crypto = createGroupCrypto({ handle: getHandle })
  const mls = createGroupMLS({
    handle: getHandle,
    adopt,
    identity,
    entrySlot,
    persist: (next) => stateStore.save(next),
  })

  const connection = hub.connect(identity)
  const peer = createGroupPeer<Protocols>({
    hub: connection,
    crypto,
    mls,
    journal,
    anchorStore,
    appCursorStore,
    localDID: identity.id,
    protocols: { chat },
    handlers: { chat: params.handlers ?? {} } as never,
    adoptJournalled: async (blob: Uint8Array) => {
      // The journalled blob is the serialized POST-commit handle. Adopting it is
      // idempotent, as the contract demands: a handle already past that commit's epoch
      // has adopted it, and a repeat is a no-op.
      const state = decodeClientState(blob)
      if (state == null || state.groupContext.epoch <= handle.epoch) return
      adopt(
        await restoreGroup({
          state,
          credential: handle.credential,
          ledgerEntries: handle.ledgerTokens,
          options: { resolveLedgerEntries: entrySlot.resolve },
        }),
      )
    },
  })

  return {
    identity,
    peer,
    handle: getHandle,
    adopt,
    anchorStore,
    appCursorStore,
    journal,
    stateStore,
    entrySlot,
    disconnect: connection.disconnect,
  }
}

/** Restore a member's handle from what its dead process persisted. */
export async function restoreMemberHandle(
  member: Member,
  entrySlot: LedgerEntrySlot,
): Promise<GroupHandle> {
  const saved = member.stateStore.saved()
  if (saved == null) throw new Error('nothing persisted')
  const state = decodeClientState(saved.state) as ClientState
  return await restoreGroup({
    state,
    credential: member.handle().credential,
    ledgerEntries: saved.ledger,
    options: { resolveLedgerEntries: entrySlot.resolve },
  })
}

// ---------------------------------------------------------------------------
// Group construction — real invites, real Welcomes, real commits.
// ---------------------------------------------------------------------------

/** The shared entry-body store every member resolves a commit's named entries against. */
export function createEntryBodies() {
  const tokens = new Map<string, string>()
  return {
    publish: (invite: Invite) => {
      for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
    },
    get: (id: string) => tokens.get(id),
    all: () => [...tokens.values()],
  }
}

export type GroupBuilder = ReturnType<typeof createEntryBodies>

export async function createFoundingGroup(
  creator: OwnIdentity,
  groupID: string,
  entrySlot: LedgerEntrySlot,
): Promise<GroupHandle> {
  const { group } = await createGroup(creator, groupID, {
    resolveLedgerEntries: entrySlot.resolve,
  })
  return group
}

export type InviteMaterial = {
  invite: Invite
  bundle: KeyPackageBundle
}

export async function mintInvite(params: {
  admin: GroupHandle
  adminIdentity: OwnIdentity
  invitee: OwnIdentity
  bodies: GroupBuilder
}): Promise<InviteMaterial> {
  const { invite } = await createInvite({
    group: params.admin,
    identity: params.adminIdentity,
    recipientDID: params.invitee.id,
    permission: 'member',
  })
  params.bodies.publish(invite)
  const bundle = await createKeyPackageBundle(params.invitee)
  return { invite, bundle }
}

/**
 * A host's `build()` for an invite commit: produce the commit against the CURRENT handle
 * and adopt NOTHING until the hub accepts it. The Welcome rides `onAccepted`, since a
 * Welcome for a commit that lost the compare-and-set names an epoch that never existed.
 */
export function buildInviteCommit(
  member: Member,
  material: InviteMaterial,
  deliverWelcome: (welcome: Uint8Array) => void,
): () => Promise<PendingCommit> {
  return async () => {
    const committed = await commitInvite(
      member.handle(),
      material.bundle.publicPackage,
      material.invite,
    )
    return {
      commit: committed.commitMessage,
      bodies: material.invite.ledgerEntries,
      kind: 'invite',
      journal: encodeClientState(committed.newGroup.state),
      onAccepted: async () => {
        member.adopt(committed.newGroup)
        deliverWelcome(committed.welcomeMessage)
      },
    }
  }
}

/** A host's `build()` for a remove. The eviction happens only when the host adopts. */
export function buildRemoveCommit(member: Member, victimDID: string): () => Promise<PendingCommit> {
  return async () => {
    const leafIndex = member.handle().findMemberLeafIndex(victimDID)
    if (leafIndex == null) throw new Error(`no leaf for ${victimDID}`)
    const committed = await removeMember(member.handle(), leafIndex)
    return {
      commit: committed.commitMessage,
      bodies: [],
      kind: 'remove',
      journal: encodeClientState(committed.newGroup.state),
      onAccepted: async () => {
        member.adopt(committed.newGroup)
      },
    }
  }
}

/**
 * A host's `build()` for a commit that is NEUTRAL FOR THE APP-LANE ANCHOR: it carries a genuine
 * `kumiai.role` entry — granting or demoting `subject`'s permission — but adds or removes no MLS
 * leaf, so the app-lane anchor, which rotates only on membership change, does not move and the
 * group stays on one topic across it.
 *
 * That is what makes it the right advance for the drain scenarios below. A commit that added or
 * removed a member would rotate the anchor, and a frame published mid-walk would land on a
 * different topic from the one the walk had already pulled — which is a different scenario, and
 * not the one where the log GROWS under a walk that has already read it.
 *
 * It also carries real ledger bodies, so the entry seal is exercised on the way: the commit's
 * blob is sealed under the epoch it is framed at and opened from inside the applying peer's own
 * apply of it.
 */
export function buildLedgerCommit(
  member: Member,
  identity: OwnIdentity,
  subject: string,
  value: string,
): () => Promise<PendingCommit> {
  return async () => {
    const token = await signLedgerEntry(identity, {
      type: ROLE_ENTRY_TYPE,
      groupID: member.handle().groupID,
      subject,
      value,
    })
    const committed = await commitLedgerEntries(member.handle(), [token])
    return {
      commit: committed.commitMessage,
      bodies: [token],
      kind: 'ledger',
      journal: encodeClientState(committed.newGroup.state),
      onAccepted: async () => {
        member.adopt(committed.newGroup)
      },
    }
  }
}

export async function joinFromWelcome(params: {
  identity: OwnIdentity
  invite: Invite
  welcome: Uint8Array
  bundle: KeyPackageBundle
  ratchetTree: GroupHandle['state']['ratchetTree']
  entrySlot: LedgerEntrySlot
}): Promise<GroupHandle> {
  const { group } = await processWelcome({
    identity: params.identity,
    invite: params.invite,
    welcome: params.welcome,
    keyPackageBundle: params.bundle,
    ratchetTree: params.ratchetTree,
    options: { resolveLedgerEntries: params.entrySlot.resolve },
  })
  return group
}

export function newIdentity(): OwnIdentity {
  return randomIdentity()
}
