import type { OwnIdentity } from '@kokuin/token'
import {
  createRecoveryRequest,
  encodeGroupAnchor,
  type GroupHandle,
  joinGroupExternal,
  MissingLedgerEntriesError,
  openSealedGroupInfo,
  openSealedLedger,
  sealGroupInfo,
  sealLedger,
} from '@kumiai/mls'
import type { CommitContext, CommitHeader, GroupMLS, PendingRecovery } from '@kumiai/rpc'

const utf8 = new TextEncoder()

/**
 * The label the non-rotating rendezvous secret is derived under.
 *
 * **This secret is NOT epoch-bound and must never be used for anything that a removed
 * member has to be cut off from.** The port asks for exactly that — a value stable for the
 * group's whole life, so a peer stranded at any epoch can still name the topic it heals on —
 * and a removed member keeps it for life by design.
 *
 * Spelled identically to `@kumiai/rpc`'s `RENDEZVOUS_LABEL` (topic.ts), which is a topic
 * label, not an MLS exporter label. The match is incidental — two independent KDF domains
 * at different stages of the same chain — and must not be collapsed into one constant.
 */
export const RECOVERY_LABEL = 'kumiai/rendezvous/v1'

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
  /** The handle the peer is at right now. See {@link GroupCryptoParams.handle}. */
  handle: () => GroupHandle
  /** Replace the handle — the ONLY way the peer's MLS state is swapped wholesale. */
  adopt: (handle: GroupHandle) => void | Promise<void>
  /** This member's signing identity: recovery requests and attestations are signed with it. */
  identity: OwnIdentity
  /** The slot the handle was built with. See {@link LedgerEntrySlot}. */
  entrySlot: LedgerEntrySlot
  /**
   * Persist the handle's state durably. `processCommit` must be durable before it resolves,
   * and this is where that happens; a host with no durable store passes a no-op and accepts
   * that a crash loses the epoch.
   */
  persist?: (handle: GroupHandle) => void | Promise<void>
}

/** The private half of a recovery request, retained until the reply opens or the TTL passes. */
type PendingRequest = { ephemeralPrivateKey: Uint8Array; mintedAt: number }

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
 * 2. **`rosterDIDs` reads the ratchet tree, so a leaf with an unparsable credential is
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
  const { handle, adopt, identity, entrySlot, persist } = params
  const pending = new Map<string, PendingRequest>()

  const sweep = (): void => {
    const cutoff = Date.now() - REQUEST_TTL_MS
    for (const [id, request] of pending) {
      if (request.mintedAt < cutoff) pending.delete(id)
    }
  }

  return {
    async rosterDIDs(): Promise<Array<string>> {
      return handle()
        .listMembers()
        .map((member) => member.id)
    },

    async readCommitHeader(commit: Uint8Array): Promise<CommitHeader | null> {
      const header = await handle().readCommitHeader(commit)
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
      const group = handle()
      const before = group.epoch
      entrySlot.install(context.resolveLedgerEntries)
      try {
        await group.processMessage(commit)
      } catch (error) {
        // The ONE throw the port is allowed: the commit named entries whose bodies would
        // not resolve from its own frame. Everything else — a commit at another epoch, one
        // the policy refuses, undecodable bytes — is `{ advanced: false }`, never a throw:
        // a throw makes the lane re-read the frame, and a frame this member was never in a
        // position to apply would wedge it there forever.
        if (error instanceof MissingLedgerEntriesError) throw error
        return { advanced: false }
      } finally {
        entrySlot.install(undefined)
      }
      const advanced = handle().epoch !== before
      // Durable before it resolves: the lane advances its cursor on this answer, so a crash
      // between applying and persisting would lose the commit and never re-read it.
      if (advanced) await persist?.(handle())
      return { advanced }
    },

    async createRecoveryRequest(requestID: string): Promise<Uint8Array> {
      sweep()
      const { request, ephemeralPrivateKey } = await createRecoveryRequest({
        group: handle(),
        identity,
        requestID,
      })
      pending.set(requestID, { ephemeralPrivateKey, mintedAt: Date.now() })
      return utf8.encode(request)
    },

    async sealGroupInfo(request: Uint8Array): Promise<Uint8Array> {
      // Throws for a request this member refuses — a removed requester holds no leaf in
      // this member's tree — and the peer stays silent. Roster-intrinsic, not a check here.
      return await sealGroupInfo({
        group: handle(),
        identity,
        request: new TextDecoder().decode(request),
      })
    },

    async applyRecovery(sealed: Uint8Array, requestID: string): Promise<PendingRecovery | null> {
      const held = pending.get(requestID)
      if (held == null) return null
      let groupInfo: Uint8Array
      try {
        groupInfo = await openSealedGroupInfo({
          group: handle(),
          sealed,
          requestID,
          ephemeralPrivateKey: held.ephemeralPrivateKey,
        })
      } catch {
        // Bytes this peer cannot open OR cannot trust: a forged reply that merely decrypts
        // fails the membership attestation, and both are `null`.
        return null
      }
      const rejoined = await joinGroupExternal({
        identity,
        groupInfo,
        credential: handle().credential,
        resync: true,
      })
      return {
        commit: rejoined.commitMessage,
        // Adopted ONLY if the hub accepts the commit. A peer that adopted first would sit
        // on a branch of its own the moment it lost the compare-and-set.
        onAccepted: async () => {
          pending.delete(requestID)
          await adopt(rejoined.group)
          await persist?.(rejoined.group)
        },
      }
    },

    async isLedgerComplete(): Promise<boolean> {
      return await handle().isLedgerComplete()
    },

    async getLedger(): Promise<Array<string>> {
      return await handle().getLedger()
    },

    async sealLedger(request: Uint8Array): Promise<Uint8Array> {
      return await sealLedger({ group: handle(), request: new TextDecoder().decode(request) })
    },

    async openSealedLedger(sealed: Uint8Array, requestID: string): Promise<Array<string> | null> {
      const held = pending.get(requestID)
      if (held == null) return null
      try {
        // The key is NOT consumed: every responder answers, and the requester must open the
        // next reply after dropping one.
        return await openSealedLedger({
          group: handle(),
          sealed,
          requestID,
          ephemeralPrivateKey: held.ephemeralPrivateKey,
        })
      } catch {
        return null
      }
    },

    async bootstrapLedger(tokens: Array<string>): Promise<void> {
      // Throws for a list whose recomputed head does not match the authenticated one — a
      // lying responder can withhold, never rewrite.
      await handle().bootstrapLedger(tokens)
      await persist?.(handle())
    },

    async exportRecoverySecret(): Promise<Uint8Array> {
      // Epoch-INDEPENDENT by construction: the genesis anchor never changes, so a peer
      // stranded at any epoch derives the same rendezvous. See the class doc — this is not
      // a confidential value.
      const group = handle()
      const { cipherSuite } = group.context
      return await cipherSuite.kdf.expand(
        await cipherSuite.kdf.extract(utf8.encode(group.groupID), encodeGroupAnchor(group.anchor)),
        utf8.encode(RECOVERY_LABEL),
        32,
      )
    },
  }
}
