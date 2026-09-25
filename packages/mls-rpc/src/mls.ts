import type { OwnIdentity } from '@kokuin/token'
import {
  createRecoveryRequest,
  encodeGroupAnchor,
  type GroupHandle,
  joinGroupExternal,
  ledgerEntryDigest,
  MissingLedgerEntriesError,
  openSealedGroupInfo,
  openSealedLedger,
  readCommitEntryIDs,
  readMessageEpoch,
  sealGroupInfo,
  sealLedger,
} from '@kumiai/mls'
import type {
  CommitContext,
  CommitHeader,
  GroupMLS,
  PendingRecovery,
  RosterEntry,
} from '@kumiai/rpc'

import type { HandleAccess } from './access.js'

const utf8 = new TextEncoder()

/**
 * The label the non-rotating recovery secret is derived under. This secret is the root of
 * BOTH the commit topic and the rendezvous topic — everything downstream of it depends on
 * this one label.
 *
 * **This secret is NOT epoch-bound and must never be used for anything that a removed
 * member has to be cut off from.** The port asks for exactly that — a value stable for the
 * group's whole life, so a peer stranded at any epoch can still name the topic it heals on —
 * and a removed member keeps it for life by design.
 */
export const RECOVERY_LABEL = 'kumiai/recovery/v1'

/**
 * A per-commit ledger-entry resolver, installed at handle-construction time and swapped
 * per commit.
 *
 * WHY THIS EXISTS, and it is a seam rather than a nicety: {@link GroupMLS.processCommit}
 * is handed a `resolveLedgerEntries` scoped to ONE commit's frame — the bodies ride that
 * frame and nowhere else — but `@kumiai/mls`'s `GroupHandle` takes its resolver once, in
 * `GroupOptions`, and offers no way to change it afterwards. So a host cannot honour the
 * per-commit contract with a plain handle: it must install this indirection when it BUILDS
 * the group (createGroup / processWelcome / restoreGroup) and hand the same slot to the
 * ports. Passing anything else means a commit resolves entries against whatever resolver
 * the handle happened to be born with.
 */
export type LedgerEntrySlot = {
  /** Pass as `GroupOptions.resolveLedgerEntries` wherever the handle is built. */
  resolve: (ids: Array<string>) => Promise<Array<string>>
  /** Install the resolver riding one commit's frame, for that commit's duration. */
  install: (resolver: ((ids: Array<string>) => Promise<Array<string>>) | undefined) => void
}

export function createLedgerEntrySlot(): LedgerEntrySlot {
  let current: ((ids: Array<string>) => Promise<Array<string>>) | undefined
  return {
    resolve: async (ids) => {
      if (current == null) {
        // No frame is being applied, or the frame carried no resolver. The handle's
        // pre-pass reads this as "the bodies are not reachable", which is the truth.
        throw new MissingLedgerEntriesError(ids)
      }
      return await current(ids)
    },
    install: (resolver) => {
      current = resolver
    },
  }
}

export type GroupMLSParams = {
  access: HandleAccess
  /** This member's signing identity: recovery requests and attestations are signed with it. */
  identity: OwnIdentity
  /** The slot the handle was built with. See {@link LedgerEntrySlot}. */
  entrySlot: LedgerEntrySlot
}

/** The private half of a recovery request, retained until the reply opens or the TTL passes. */
type PendingRequest = {
  ephemeralPrivateKey: Uint8Array
  mintedAt: number
  timer: ReturnType<typeof setTimeout>
}

/**
 * How long a minted recovery request's private half is kept. The port makes retention the
 * implementation's problem — the lane has no release hook and drops its `requestID` on
 * timeout without saying so — so this bounds it off the mint time.
 */
const REQUEST_TTL_MS = 120_000

/**
 * {@link GroupMLS} over a live {@link GroupHandle} — the real lifecycle port.
 *
 * ## Where this diverges from the memory double in `@kumiai/rpc`'s fixtures
 *
 * 1. **`processCommit` advances the handle IN PLACE for a received commit.** ts-mls's
 *    `processMessage` replaces the handle's own state, so there is nothing to adopt: the
 *    double models a commit as a value that is adopted separately, which is only true for a
 *    commit this member AUTHORED (those really do produce a fresh handle, and the peer
 *    adopts it in `onAccepted`). A host that treated every commit as adopt-later would
 *    double-apply received ones.
 *
 * 2. **`rosterEntries` reads the ratchet tree, so a leaf with an unparsable credential is
 *    simply absent** rather than present-with-a-placeholder. The double's roster is a set of
 *    strings it was handed.
 *
 * 3. **`exportRecoverySecret` is derived from the group's GENESIS ANCHOR, which is public.**
 *    MLS has no lifelong group secret — every key schedule secret rotates with the epoch, and
 *    a member who joined at epoch 5 never held epoch 0's — so there is nothing secret and
 *    epoch-independent to derive it from. The double returns an opaque secret handed to it,
 *    which reads as though the value were confidential. It is not: anyone who has seen a
 *    GroupInfo for this group can compute the rendezvous topic. That is tolerable for what the
 *    topic is for (a stranded peer must be able to name it, and so must a removed one) but a
 *    host must not put anything on it that confidentiality depends on.
 */
export function createGroupMLS(params: GroupMLSParams): GroupMLS {
  const { access, identity, entrySlot } = params
  const pending = new Map<string, PendingRequest>()

  const sweep = (): void => {
    const cutoff = Date.now() - REQUEST_TTL_MS
    for (const [id, request] of pending) {
      if (request.mintedAt < cutoff) {
        clearTimeout(request.timer)
        request.ephemeralPrivateKey.fill(0)
        pending.delete(id)
      }
    }
  }

  return {
    async rosterEntries(): Promise<Array<RosterEntry>> {
      return await access.read((group) =>
        group.listMembers().map((member) => ({
          did: member.id,
          leafIndex: member.leafIndex,
          longForm: member.longForm,
        })),
      )
    },

    async readCommitHeader(commit: Uint8Array): Promise<CommitHeader | null> {
      const header = await access.read((group) => group.readCommitHeader(commit))
      if (header == null) return null
      return {
        epoch: Number(header.epoch),
        ...(header.committerDID != null && { committerDID: header.committerDID }),
        ...(header.external === true && { external: true }),
      }
    },

    async processCommit(
      commit: Uint8Array,
      context: CommitContext,
    ): Promise<{ advanced: boolean }> {
      const frameEpoch = readMessageEpoch(commit)
      const eligible = await access.read(async (group) => {
        const header = await group.readCommitHeader(commit)
        return header != null && frameEpoch === group.epoch
      })
      if (!eligible) return { advanced: false }
      const ids = readCommitEntryIDs(commit)
      const tokens = ids.length === 0 ? [] : await context.resolveLedgerEntries?.(ids)
      const resolved = new Map<string, string>()
      for (const token of tokens ?? []) resolved.set(ledgerEntryDigest(token), token)
      const ignored = Symbol('ignored commit')
      try {
        return await access.mutate(async (group, persist) => {
          if (group.epoch !== frameEpoch) {
            throw new Error('commit epoch changed during entry resolution')
          }
          const before = group.epoch
          let persistFailed = false
          entrySlot.install(async (requested) =>
            requested.flatMap((id) => {
              const token = resolved.get(id)
              return token == null ? [] : [token]
            }),
          )
          try {
            try {
              await group.processMessage(commit, {
                persist: async (current) => {
                  try {
                    await persist(current)
                  } catch (error) {
                    persistFailed = true
                    throw error
                  }
                },
              })
            } catch (error) {
              if (error instanceof MissingLedgerEntriesError || persistFailed) throw error
              if (group.epoch === before) throw ignored
              return { advanced: true }
            }
            if (group.epoch === before) throw ignored
            return { advanced: true }
          } finally {
            entrySlot.install(undefined)
          }
        })
      } catch (error) {
        if (error === ignored) return { advanced: false }
        throw error
      }
    },

    async createRecoveryRequest(requestID: string): Promise<Uint8Array> {
      sweep()
      const { request, ephemeralPrivateKey } = await access.read((group) =>
        createRecoveryRequest({
          group,
          identity,
          requestID,
        }),
      )
      const previous = pending.get(requestID)
      if (previous != null) {
        clearTimeout(previous.timer)
        previous.ephemeralPrivateKey.fill(0)
      }
      const timer = setTimeout(() => {
        const held = pending.get(requestID)
        if (held?.ephemeralPrivateKey !== ephemeralPrivateKey) return
        ephemeralPrivateKey.fill(0)
        pending.delete(requestID)
      }, REQUEST_TTL_MS)
      const nodeTimer = timer as unknown as { unref?: () => void }
      nodeTimer.unref?.()
      pending.set(requestID, { ephemeralPrivateKey, mintedAt: Date.now(), timer })
      return utf8.encode(request)
    },

    async sealGroupInfo(request: Uint8Array): Promise<Uint8Array> {
      // Throws for a request this member refuses — a removed requester holds no leaf in
      // this member's tree — and the peer stays silent. Roster-intrinsic, not a check here.
      return await access.read((group) =>
        sealGroupInfo({
          group,
          identity,
          request: new TextDecoder().decode(request),
        }),
      )
    },

    async applyRecovery(sealed: Uint8Array, requestID: string): Promise<PendingRecovery | null> {
      const held = pending.get(requestID)
      if (held == null) return null
      let groupInfo: Uint8Array
      try {
        groupInfo = await access.read((group) =>
          openSealedGroupInfo({
            group,
            sealed,
            requestID,
            ephemeralPrivateKey: held.ephemeralPrivateKey,
          }),
        )
      } catch {
        // Bytes this peer cannot open OR cannot trust: a forged reply that merely decrypts
        // fails the membership attestation, and both are `null`.
        return null
      }
      const rejoined = await access.read((group) =>
        joinGroupExternal({
          identity,
          groupInfo,
          credential: group.credential,
          resync: true,
        }),
      )
      return {
        commit: rejoined.commitMessage,
        // Adopted ONLY if the hub accepts the commit. A peer that adopted first would sit
        // on a branch of its own the moment it lost the compare-and-set.
        onAccepted: async () => {
          await access.replace(rejoined.group)
          held.ephemeralPrivateKey.fill(0)
          clearTimeout(held.timer)
          if (pending.get(requestID) === held) pending.delete(requestID)
        },
      }
    },

    async isLedgerComplete(): Promise<boolean> {
      return await access.read((group) => group.isLedgerComplete())
    },

    async getLedger(): Promise<Array<string>> {
      return await access.read((group) => group.getLedger())
    },

    async sealLedger(request: Uint8Array): Promise<Uint8Array> {
      return await access.read((group) =>
        sealLedger({ group, request: new TextDecoder().decode(request) }),
      )
    },

    async openSealedLedger(sealed: Uint8Array, requestID: string): Promise<Array<string> | null> {
      const held = pending.get(requestID)
      if (held == null) return null
      try {
        // The key is NOT consumed: every responder answers, and the requester must open the
        // next reply after dropping one.
        return await access.read((group) =>
          openSealedLedger({
            group,
            sealed,
            requestID,
            ephemeralPrivateKey: held.ephemeralPrivateKey,
          }),
        )
      } catch {
        return null
      }
    },

    async bootstrapLedger(tokens: Array<string>): Promise<void> {
      // Throws for a list whose recomputed head does not match the authenticated one — a
      // lying responder can withhold, never rewrite.
      await access.mutate(async (group, persist) => {
        await group.bootstrapLedger(tokens, { persist })
      })
    },

    async exportRecoverySecret(): Promise<Uint8Array> {
      // Epoch-INDEPENDENT by construction: the genesis anchor never changes, so a peer
      // stranded at any epoch derives the same rendezvous. See the class doc — this is not
      // a confidential value.
      return await access.read(async (group) => {
        const { cipherSuite } = group.context
        return await cipherSuite.kdf.expand(
          await cipherSuite.kdf.extract(
            utf8.encode(group.groupID),
            encodeGroupAnchor(group.anchor),
          ),
          utf8.encode(RECOVERY_LABEL),
          32,
        )
      })
    },
  }
}
