import type { ProtocolDefinition } from '@enkaku/protocol'
import type { LogHub } from '@kumiai/hub-tunnel'

import type { PendingCommit } from '../../src/commit.js'
import { createGroupPeer, type GroupPeer } from '../../src/peer.js'
import { createMemoryAnchorStore, type MemoryAnchorStore } from './anchor.js'
import { createFakeCrypto, type FakeCrypto } from './fake-crypto.js'
import { createMemoryCommitJournal, type MemoryCommitJournal } from './journal.js'
import {
  createMemoryGroupMLS,
  decodeMemoryCommit,
  type MemoryGroupMLS,
} from './memory-group-mls.js'

export const chat = {
  'chat/changed': { type: 'event', data: { type: 'object' } },
} as const satisfies ProtocolDefinition

export type Protocols = { chat: typeof chat }

/**
 * The host's opaque journal blob, modelled: the serialized post-commit handle. For the
 * memory port that is just the commit bytes — a fixed value that can be adopted from
 * nothing but itself, which is exactly the property the real blob has.
 *
 * Adopting it is IDEMPOTENT, as the contract demands: a handle already past that commit's
 * epoch has adopted it, and a repeat is a no-op. Replay cannot tell an entry whose
 * `onAccepted` ran from one whose process died before it, and it runs both.
 */
export function adoptJournalledBlob(mls: MemoryGroupMLS, blob: Uint8Array): void {
  const parsed = decodeMemoryCommit(blob)
  if (parsed == null || parsed.epoch !== mls.epoch()) return
  mls.adopt(blob)
}

export type TestPeer = {
  peer: GroupPeer<Protocols>
  crypto: FakeCrypto
  mls: MemoryGroupMLS
  journal: MemoryCommitJournal
  anchorStore: MemoryAnchorStore
  /** Every Welcome this host delivered, in order. Records the at-least-once repeats too. */
  welcomes: Array<string>
}

export type MakeMLSPeerOptions = {
  epoch?: number
  /** Entry bodies this member already holds — a Welcome carries them. Not an enacted ledger. */
  bodies?: Array<string>
  /** The members this handle's tree holds a leaf for. A responder seals only to those. */
  members?: Array<string>
  /**
   * A RESTART: a new peer over everything a dead one left behind — its handle, its crypto, its
   * journal, its anchor store, its Welcome record — carried as one.
   *
   * It is one option and not four because a restart needs ALL of them and a host cannot be told
   * which: hand-copying the list is how a piece goes missing, and each piece goes missing
   * quietly. A journal left behind loses the commit whose process died in the acceptance window.
   * An anchor store left behind re-seeds the anchor at the live epoch and partitions the peer
   * from its own group — it derives its own topics, sees nobody, and nothing reports it. Naming
   * the dead peer instead of its parts is what makes those unwritable.
   *
   * Any option below still overrides what this carries — a restart onto a DIFFERENT journal is a
   * real scenario, and saying so explicitly is the point.
   */
  restartOf?: TestPeer
  /** Reuse an existing group state without a restart — a peer built over a handle made here. */
  mls?: MemoryGroupMLS
  crypto?: FakeCrypto
  /** Reuse an existing journal — durability across a restart is exactly this. */
  journal?: MemoryCommitJournal
  /**
   * Reuse an existing anchor store. The store must OUTLIVE the peer: the anchor is persisted
   * state a rebooted handle can never re-export, so a restart that does not carry the store
   * forward is a peer that partitions from its own group.
   */
  anchorStore?: MemoryAnchorStore
  /**
   * The host's adoption of a journalled post-commit handle, overridden. The default adopts
   * the blob and nothing else, which is the whole of what a `ledger` commit's handle carries.
   * A `remove`'s handle carries one thing more — the member's leaf is already gone from it —
   * and only a host that models that can tell an eviction that happened from one that did not.
   */
  adoptJournalled?: (blob: Uint8Array) => void
  welcomes?: Array<string>
  /** The host's own app-protocol handlers. Without them the app lane delivers to nobody. */
  handlers?: Record<string, unknown>
  commitDeadlineMs?: number
  /** The group's commit policy: a committer this refuses is well-formed and not applied. */
  acceptsCommitter?: (committerDID: string) => boolean
  recovery?: { timeoutMs?: number; getDelayMs?: () => number; deadlineMs?: number }
}

/** A member of the group at `epoch`, wired with a durable journal, as a host must be. */
export function makeMLSPeer(
  hub: LogHub,
  localDID: string,
  recoverySecret: Uint8Array,
  options: MakeMLSPeerOptions = {},
): TestPeer {
  const epoch = options.epoch ?? 1
  const restartOf = options.restartOf
  const crypto = options.crypto ?? restartOf?.crypto ?? createFakeCrypto({ epoch, localDID })
  const mls =
    options.mls ??
    restartOf?.mls ??
    createMemoryGroupMLS({
      recoverySecret,
      epoch,
      // The member's own identity: it is what the commits it BUILDS are signed by, and what
      // it compares a commit's author against. A double with no identity cannot model the
      // one question this lane asks of a frame — "did I write this?".
      localDID,
      ...(options.bodies != null ? { bodies: options.bodies } : {}),
      ...(options.members != null ? { members: options.members } : {}),
      ...(options.acceptsCommitter != null ? { acceptsCommitter: options.acceptsCommitter } : {}),
      onAdvance: (e) => crypto.setEpoch(e),
    })
  const journal = options.journal ?? restartOf?.journal ?? createMemoryCommitJournal()
  const anchorStore = options.anchorStore ?? restartOf?.anchorStore ?? createMemoryAnchorStore()
  const welcomes = options.welcomes ?? restartOf?.welcomes ?? []
  const peer = createGroupPeer<Protocols>({
    hub,
    crypto,
    mls,
    journal,
    anchorStore,
    // The restart half of onAccepted, over the same blob — and idempotent, as it must be.
    adoptJournalled: async (blob) => {
      if (options.adoptJournalled != null) {
        options.adoptJournalled(blob)
        return
      }
      adoptJournalledBlob(mls, blob)
    },
    localDID,
    protocols: { chat },
    handlers: { chat: options.handlers ?? {} } as never,
    ...(options.commitDeadlineMs != null ? { commitDeadlineMs: options.commitDeadlineMs } : {}),
    ...(options.recovery != null ? { recovery: options.recovery } : {}),
  })
  return { peer, crypto, mls, journal, anchorStore, welcomes }
}

export type LedgerCommitOptions = {
  /** Records the epoch each attempt framed at: a rebased retry must frame at the new one. */
  framedAt?: Array<number>
  /** Runs inside build(), before the commit is produced. */
  onBuild?: () => void | Promise<void>
}

/**
 * A host's `build()` for a ledger commit: produce a commit against the CURRENT handle and
 * adopt NOTHING. It is a closure over the live handle, so a retry after a rebase frames at
 * the epoch the rebase reached.
 */
export function buildLedgerCommit(
  member: TestPeer,
  tokens: Array<string>,
  options: LedgerCommitOptions = {},
): () => Promise<PendingCommit> {
  return async () => {
    await options.onBuild?.()
    options.framedAt?.push(member.mls.epoch())
    const commit = member.mls.buildCommit(tokens)
    return {
      commit,
      bodies: tokens,
      kind: 'ledger',
      journal: commit,
      onAccepted: async () => {
        adoptJournalledBlob(member.mls, commit)
      },
    }
  }
}

/**
 * A host's `build()` for a remove. The eviction happens when — and only when — the host
 * adopts the post-commit handle, which it does in `onAccepted` and nowhere else. A remove
 * that never lands therefore leaves the member exactly where they were, and the notice the
 * peer hands back is the ONLY thing that tells the admin so.
 */
export function buildRemoveCommit(
  member: TestPeer,
  victimDID: string,
  options: LedgerCommitOptions = {},
): () => Promise<PendingCommit> {
  return async () => {
    await options.onBuild?.()
    options.framedAt?.push(member.mls.epoch())
    const commit = member.mls.buildCommit([])
    return {
      commit,
      bodies: [],
      kind: 'remove',
      journal: commit,
      onAccepted: async () => {
        adoptJournalledBlob(member.mls, commit)
        member.mls.evict(victimDID)
      },
    }
  }
}

/**
 * A host's `build()` for an invite. Its Welcome lives in `onAccepted` and nowhere else —
 * it is not in `bodies`, and the peer has no way to produce one.
 */
export function buildInviteCommit(
  member: TestPeer,
  inviteeDID: string,
  options: LedgerCommitOptions = {},
): () => Promise<PendingCommit> {
  return async () => {
    await options.onBuild?.()
    options.framedAt?.push(member.mls.epoch())
    const commit = member.mls.buildCommit([])
    return {
      commit,
      bodies: [],
      kind: 'invite',
      journal: commit,
      onAccepted: async () => {
        adoptJournalledBlob(member.mls, commit)
        member.welcomes.push(inviteeDID)
      },
    }
  }
}
