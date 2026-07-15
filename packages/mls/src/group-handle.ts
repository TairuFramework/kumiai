import { type DIDCache, type DIDResolver, normalizeDID } from '@kokuin/token'
import {
  type ClientState,
  contentTypes,
  createApplicationMessage,
  decode,
  encode,
  type IncomingMessageCallback,
  type MlsContext,
  mlsMessageDecoder,
  mlsMessageEncoder,
  processMessage as mlsProcessMessage,
  nodeTypes,
  type ProposalWithSender,
  senderTypes,
  wireformats,
} from 'ts-mls'

import { type GroupAnchor, readGroupAnchor } from './anchor.js'
import {
  type GroupMember,
  type MemberCredential,
  parseMLSCredentialIdentity,
} from './credential.js'
import { decodeControlEnvelope } from './envelope.js'
import { foldEnvelope } from './envelope-fold.js'
import type { FoldInput } from './fold.js'
import {
  assertHeadMatches,
  computeHead,
  decodeLedgerHead,
  encodeLedgerHead,
  extendHead,
  headsMatch,
  readLedgerHead,
  readLedgerHeadExtension,
} from './head.js'
import { ledgerEntryDigest, type VerifiedLedgerEntry, verifyLedgerEntry } from './ledger.js'
import { createMutex, type Mutex } from './mutex.js'
import {
  type CommitPolicyContext,
  defaultCommitPolicy,
  MissingLedgerEntriesError,
} from './policy.js'
import { foldRoster, type RoleValue, type RosterState } from './roster.js'

/** One serializer per live handle, so its state-mutating operations run one at a
 *  time in issue order. Keyed weakly: the entry is collected with the handle, and
 *  the handle carries no reference back to it. */
const MUTEXES = new WeakMap<GroupHandle, Mutex>()

export function mutexFor(handle: GroupHandle): Mutex {
  let mutex = MUTEXES.get(handle)
  if (mutex === undefined) {
    mutex = createMutex()
    MUTEXES.set(handle, mutex)
  }
  return mutex
}

/** Overwrite retired secret buffers ts-mls hands back as `consumed`, so key
 *  material does not linger in the heap after the state that used it is replaced. */
function zeroAll(buffers: Array<Uint8Array>): void {
  for (const buffer of buffers) buffer.fill(0)
}

/** Thrown by GroupHandle.processMessage when the commit policy rejects an incoming
 *  commit. The handle is left at its pre-commit epoch. */
export class CommitRejectedError extends Error {
  #proposals: Array<ProposalWithSender>
  #senderLeafIndex?: number

  constructor(proposals: Array<ProposalWithSender>, senderLeafIndex?: number) {
    super('Commit rejected by group commit policy')
    this.name = 'CommitRejectedError'
    this.#proposals = proposals
    this.#senderLeafIndex = senderLeafIndex
  }

  get proposals(): Array<ProposalWithSender> {
    return this.#proposals
  }

  get senderLeafIndex(): number | undefined {
    return this.#senderLeafIndex
  }
}

type RejectedCommit = { proposals: Array<ProposalWithSender>; senderLeafIndex?: number }

/**
 * Wrap a consumer commit policy to capture a rejected commit's proposals for
 * CommitRejectedError. ts-mls does not surface them on its result, so record them
 * from the callback's own argument on the 'reject' path. Undefined when no policy.
 */
function wrapCommitPolicy(
  callback: IncomingMessageCallback | undefined,
  capture: { rejected?: RejectedCommit },
): IncomingMessageCallback | undefined {
  if (callback == null) return undefined
  return (incoming) => {
    const action = callback(incoming)
    if (action === 'reject' && incoming.kind === 'commit') {
      capture.rejected = {
        proposals: incoming.proposals,
        senderLeafIndex:
          incoming.senderLeafIndex == null ? undefined : Number(incoming.senderLeafIndex),
      }
    }
    return action
  }
}

/**
 * Read a PrivateMessage commit's cleartext `authenticatedData`, available before
 * any epoch secret. Returns undefined for anything that is not a PrivateMessage of
 * contentType commit (those keep the pre-envelope path). Narrows the `unknown`
 * frame structurally, not by cast.
 */
function readPrivateCommit(decoded: unknown): { authenticatedData: Uint8Array } | undefined {
  if (decoded == null || typeof decoded !== 'object') return undefined
  const frame = decoded as { wireformat?: unknown; privateMessage?: unknown }
  if (frame.wireformat !== wireformats.mls_private_message) return undefined
  const pm = frame.privateMessage as
    | { contentType?: unknown; authenticatedData?: unknown }
    | undefined
  if (pm == null || pm.contentType !== contentTypes.commit) return undefined
  const data = pm.authenticatedData
  return { authenticatedData: data instanceof Uint8Array ? data : new Uint8Array() }
}

/**
 * Read the DID an external-join commit proves control of. An external join is a
 * PublicMessage from a joining non-member (senderType new_member_commit) carrying a
 * commit; the committer holds no pre-commit leaf, so its DID rides the commit's own
 * UpdatePath leaf credential. Returns undefined for anything else (keeps the
 * pre-envelope path). Returns `{ did: undefined }` when the UpdatePath is absent or
 * the leaf credential does not resolve to a basic-credential DID — cannot be a valid
 * resync, so the caller rejects it. Narrows structurally.
 */
function readExternalCommit(decoded: unknown): { did: string | undefined } | undefined {
  if (decoded == null || typeof decoded !== 'object') return undefined
  const frame = decoded as { wireformat?: unknown; publicMessage?: unknown }
  if (frame.wireformat !== wireformats.mls_public_message) return undefined
  const pm = frame.publicMessage as { senderType?: unknown; content?: unknown } | undefined
  if (pm == null || pm.senderType !== senderTypes.new_member_commit) return undefined
  const content = pm.content as { contentType?: unknown; commit?: unknown } | undefined
  if (content == null || content.contentType !== contentTypes.commit) return undefined
  const commit = content.commit as { path?: unknown } | undefined
  const path = commit?.path as { leafNode?: unknown } | undefined
  if (path == null) return { did: undefined }
  const leafNode = path.leafNode as { credential?: unknown } | undefined
  const credential = leafNode?.credential as { identity?: unknown } | undefined
  if (credential == null || !(credential.identity instanceof Uint8Array)) {
    return { did: undefined }
  }
  try {
    return { did: parseMLSCredentialIdentity(credential.identity).id }
  } catch {
    return { did: undefined }
  }
}

/**
 * A control-ledger entry as a handle holds it: the signed token (canonical
 * persistent/wire form, the only thing forwardable to another party) paired with
 * its verified form. The verified form is a one-way derivation, so keeping only it
 * would leave a handle unable to forward its ledger.
 */
export type HeldLedgerEntry = {
  token: string
  verified: VerifiedLedgerEntry
}

/** A held entry paired with its content id — one position in the ledger log. */
export type LedgerLogEntry = HeldLedgerEntry & { entryID: string }

/**
 * Project a held ledger into the roster. foldRoster drops every non-`group.role`
 * entry by type, so the mixed-type log is fed in whole. Replayed in order, repeats
 * and all: a claim re-enacted at a later position must undo what came between.
 */
function foldLedgerRoster(
  ledger: ReadonlyArray<LedgerLogEntry>,
  anchor: GroupAnchor,
  groupID: string,
): RosterState {
  const entries = ledger.map(
    ({ verified, entryID }) => ({ verified, entryID }) as FoldInput<RoleValue>,
  )
  return foldRoster(entries, anchor, groupID)
}

export type GroupHandleParams = {
  state: ClientState
  credential: MemberCredential
  context: MlsContext
  /** The control-ledger log this handle starts from, in enactment order. A handle
   *  derived from another (commitInvite/removeMember) inherits the parent's, so the
   *  roster it folds does not revert to the anchor alone. */
  ledger?: ReadonlyArray<LedgerLogEntry>
  cache: DIDCache
  resolver?: DIDResolver
  /** Default commit policy applied by processMessage. */
  commitPolicy?: IncomingMessageCallback
  /** Fetch control-ledger entry bodies the local ledger lacks (commit pre-pass). */
  resolveLedgerEntries?: (ids: Array<string>) => Promise<Array<string>>
  /** Surface an accepted commit's notarized non-`group.role` entries to the consumer. */
  onLedgerEntries?: (entries: Array<VerifiedLedgerEntry>) => void
}

/** Mutable wrapper around MLS group state + Enkaku credential. */
export class GroupHandle {
  #state: ClientState
  #credential: MemberCredential
  #context: MlsContext
  #cache: DIDCache
  #resolver?: DIDResolver
  #commitPolicy?: IncomingMessageCallback
  #resolveLedgerEntries?: (ids: Array<string>) => Promise<Array<string>>
  #onLedgerEntries?: (entries: Array<VerifiedLedgerEntry>) => void
  #anchor: GroupAnchor
  /** The ordered log of enactments — the ledger as the head chains it. A content id
   *  may appear more than once: re-enacting a claim at a later position undoes what
   *  came between, which is how a demotion back to a previously-held role works. */
  #ledger: Array<LedgerLogEntry>
  /** Entry bodies by content id, for resolving the ids an envelope names. A body is
   *  the same wherever it appears in the log, so this store is keyed. */
  #entryBodies: Map<string, HeldLedgerEntry>
  #roster: RosterState

  constructor(params: GroupHandleParams) {
    this.#state = params.state
    this.#credential = params.credential
    this.#context = params.context
    this.#cache = params.cache
    this.#resolver = params.resolver
    this.#commitPolicy = params.commitPolicy
    this.#resolveLedgerEntries = params.resolveLedgerEntries
    this.#onLedgerEntries = params.onLedgerEntries
    // Seed control state from the genesis anchor in the group's GroupContext. Reading
    // it here makes the constructor the single choke no anchorless handle slips
    // through: an absent anchor fails closed rather than installing a permissive roster.
    const anchor = readGroupAnchor(this)
    if (anchor == null) {
      throw new Error('group has no anchor extension; cannot seed a control roster')
    }
    this.#anchor = anchor
    this.#ledger = [...(params.ledger ?? [])]
    this.#entryBodies = new Map(
      this.#ledger.map(({ entryID, token, verified }) => [entryID, { token, verified }]),
    )
    this.#roster = foldLedgerRoster(this.#ledger, anchor, this.groupID)
  }

  get groupID(): string {
    return this.#credential.groupID
  }

  get epoch(): bigint {
    return this.#state.groupContext.epoch
  }

  get treeHash(): Uint8Array {
    return this.#state.groupContext.treeHash
  }

  get credential(): MemberCredential {
    return this.#credential
  }

  get state(): ClientState {
    return this.#state
  }

  get context(): MlsContext {
    return this.#context
  }

  get cache(): DIDCache {
    return this.#cache
  }

  get resolver(): DIDResolver | undefined {
    return this.#resolver
  }

  /** The commit policy enforced by processMessage, if any. Carried onto
   *  handles derived from this one (commitInvite/removeMember). */
  get commitPolicy(): IncomingMessageCallback | undefined {
    return this.#commitPolicy
  }

  /** The ledger-entry resolver, carried onto handles derived from this one. */
  get resolveLedgerEntries(): ((ids: Array<string>) => Promise<Array<string>>) | undefined {
    return this.#resolveLedgerEntries
  }

  /** The accepted-commit entry sink, carried onto handles derived from this one. */
  get onLedgerEntries(): ((entries: Array<VerifiedLedgerEntry>) => void) | undefined {
    return this.#onLedgerEntries
  }

  /** The genesis anchor seeded into this handle at construction. */
  get anchor(): GroupAnchor {
    return this.#anchor
  }

  /** The control-ledger log this handle holds, in enactment order, repeats and
   *  all. Carried onto handles derived from this one (commitInvite/removeMember). */
  get ledger(): ReadonlyArray<LedgerLogEntry> {
    return this.#ledger
  }

  /** The ordered signed tokens this handle holds, repeats included — the ledger's
   *  canonical persistent/wire form, and the list the authenticated head folds over.
   *  Feeds createInvite, restoreGroup, and host persistence. The verified entries are
   *  a derived cache with no export form: the only way in is applyLedgerEntries,
   *  which re-verifies. */
  get ledgerTokens(): Array<string> {
    return this.#ledger.map(({ token }) => token)
  }

  /** The control roster folded from the anchor and every applied ledger entry. */
  get roster(): RosterState {
    return this.#roster
  }

  /**
   * Verify signed ledger tokens, append the valid ones in the order given, and
   * refold the roster. Tokens that fail verification or whose groupID mismatches are
   * dropped (defensive — the strict admin-issuer enforcement is the commit pre-pass).
   * Every token is re-verified on the way in: no entry enters a ledger unverified,
   * whatever the import path.
   *
   * A token the log already holds is appended again, not skipped: the log records
   * what each commit enacted, not a set of claims, and a repeat is the only way to
   * express a demotion back to a previously-held role. Nothing replays a commit into
   * it (MLS applies each once, restoreGroup replays a token list once, processWelcome
   * folds an invite once). Serialized on the handle's mutex.
   */
  async applyLedgerEntries(tokens: Array<string>): Promise<void> {
    return mutexFor(this).run(async () => {
      for (const token of tokens) {
        const verified = await verifyLedgerEntry(token)
        if (verified == null || verified.entry.groupID !== this.groupID) continue
        const entryID = ledgerEntryDigest(token)
        this.#ledger.push({ entryID, token, verified })
        this.#entryBodies.set(entryID, { token, verified })
      }
      this.#roster = foldLedgerRoster(this.#ledger, this.#anchor, this.groupID)
    })
  }

  /**
   * Whether the ledger this handle holds is the whole ledger its GroupContext
   * attests to: the head folded from the ids it holds, in order, against the
   * authenticated `ledger_head`.
   *
   * Purely local — reads this handle's ledger and GroupContext, consults no peer.
   * False means incomplete (e.g. an external-commit rejoin arrives with an *empty*
   * ledger against a live, non-genesis head), and {@link bootstrapLedger} must run
   * before the handle can be trusted to fold a roster or judge a commit.
   *
   * A group with no entries reads true, non-vacuously: the empty fold is the genesis
   * head (a real 32-byte digest bound to this group), which matches only a head that
   * has never moved — exactly a genuinely empty ledger.
   */
  async isLedgerComplete(): Promise<boolean> {
    return mutexFor(this).run(async () => {
      const authenticated = readLedgerHead(this)
      if (authenticated == null) {
        // No head extension attests to no ledger, so nothing can be shown complete.
        // Report incomplete and let bootstrap fail loudly.
        return false
      }
      return headsMatch(
        authenticated.head,
        computeHead(
          this.groupID,
          this.#ledger.map(({ entryID }) => entryID),
        ),
      )
    })
  }

  /**
   * The whole ordered ledger this handle holds, as signed tokens — what a responder
   * serves to a bootstrapping peer. Order is load-bearing: the head is a chain
   * digest, so a permuted list folds to a different head and is rejected.
   */
  async getLedger(): Promise<Array<string>> {
    return mutexFor(this).run(async () => this.ledgerTokens)
  }

  /**
   * Install a gathered ledger, verified against the authenticated head before a
   * single entry is folded.
   *
   * The gathered list is the group's WHOLE ledger from genesis, not a delta: a list
   * that reproduces the head this GroupContext carries *is* the entire ledger, in
   * order, and replaces whatever this handle held.
   *
   * Check before fold, structurally: the head is recomputed over the incoming
   * `tokens` while the handle's ledger, entry bodies, and roster are untouched, and
   * the fold's results are installed in one assignment at the end. A rejected ledger
   * writes nothing — no half-applied window, no rollback.
   *
   * Signatures alone do not cover this: a lying responder can hand back genuinely
   * signed, correctly scoped tokens with one demotion omitted or two transposed —
   * every signature verifies, yet the folded roster contains an admin the group
   * demoted. Omission and reordering are exactly what the head chain protects and
   * signatures do not. The bound: **a lying responder can withhold, never rewrite.**
   *
   * Throws {@link LedgerIncompleteError} on a head mismatch; the caller drops that
   * responder and tries the next.
   */
  async bootstrapLedger(tokens: Array<string>): Promise<void> {
    return mutexFor(this).run(async () => {
      const authenticated = readLedgerHead(this)
      if (authenticated == null) {
        throw new Error('bootstrapLedger: the group has no ledger head extension')
      }

      // The gate. Nothing below touches the handle until the last three statements,
      // and nothing above reads the tokens except for their content ids.
      const entryIDs = tokens.map(ledgerEntryDigest)
      assertHeadMatches(authenticated.head, computeHead(this.groupID, entryIDs))

      const log: Array<LedgerLogEntry> = []
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index] as string
        const verified = await verifyLedgerEntry(token)
        if (verified == null || verified.entry.groupID !== this.groupID) {
          // Unreachable past the gate — the chain digests the token bytes, so an
          // unverifiable or cross-group token cannot sit at a position the head
          // covers. Fails closed anyway.
          throw new Error(
            'bootstrapLedger: the gathered ledger holds an unverifiable or cross-group entry',
          )
        }
        log.push({ entryID: entryIDs[index] as string, token, verified })
      }

      this.#ledger = log
      this.#entryBodies = new Map(
        log.map(({ entryID, token, verified }) => [entryID, { token, verified }]),
      )
      this.#roster = foldLedgerRoster(log, this.#anchor, this.groupID)
    })
  }

  get memberCount(): number {
    return this.#state.ratchetTree.filter(
      (node) => node != null && node.nodeType === nodeTypes.leaf,
    ).length
  }

  *#iterateMembers(): Generator<GroupMember> {
    const tree = this.#state.ratchetTree
    for (let i = 0; i < tree.length; i++) {
      const node = tree[i]
      if (node != null && node.nodeType === nodeTypes.leaf) {
        const credential = node.leaf.credential
        if ('identity' in credential) {
          let parsed: ReturnType<typeof parseMLSCredentialIdentity>
          try {
            parsed = parseMLSCredentialIdentity(credential.identity)
          } catch {
            continue
          }
          yield { leafIndex: i / 2, id: parsed.id }
        }
      }
    }
  }

  findMemberLeafIndex(id: string): number | undefined {
    const targetNorm = normalizeDID(id)
    for (const member of this.#iterateMembers()) {
      if (normalizeDID(member.id) === targetNorm) return member.leafIndex
    }
    return undefined
  }

  /**
   * The group's current members from the ratchet tree, in ascending leaf-index
   * order. Leaves whose credential identity fails to parse are skipped (like
   * findMemberLeafIndex). Reflects current #state — call before and after
   * processMessage to diff a commit's membership change.
   */
  listMembers(): Array<GroupMember> {
    return [...this.#iterateMembers()]
  }

  /**
   * Encrypt an application message for the group at this handle's current epoch,
   * returning framed wire bytes. A handle a commit has already superseded (see
   * {@link commitInvite}, {@link removeMember}, {@link commitLedgerEntries}) must not
   * be reused to send — it silently emits at the now-stale epoch. Adopt the commit's
   * `newGroup` and encrypt on that.
   */
  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    return mutexFor(this).run(async () => {
      const { newState, message, consumed } = await createApplicationMessage({
        context: this.#context,
        state: this.#state,
        message: plaintext,
      })
      this.#state = newState
      zeroAll(consumed)
      return encode(mlsMessageEncoder, message)
    })
  }

  /**
   * The async pre-pass feeding the synchronous ts-mls commit callback, run before
   * mlsProcessMessage. For anything that is not a PrivateMessage commit it just
   * resolves the caller policy, wraps it for rejected-proposal capture, and applies
   * nothing on accept.
   *
   * For a PrivateMessage commit it decodes the control envelope, resolves and
   * verifies the entry bodies it names, folds a candidate roster off the pre-commit
   * state, and precomputes the pure inputs the sync callback reads. That callback is
   * a pure lookup: decode/fold failure is a hard reject; else a caller policy wins,
   * and with none the anchored default policy runs. Missing entry bodies with no
   * resolver throw MissingLedgerEntriesError HERE — before mlsProcessMessage — so the
   * handle stays at its pre-commit epoch.
   */
  async #prepareCommitPipeline(
    decoded: unknown,
    opts?: { commitPolicy?: IncomingMessageCallback },
  ): Promise<{
    callback: IncomingMessageCallback | undefined
    capture: { rejected?: RejectedCommit }
    applyOnAccept: () => void
  }> {
    const callerPolicy = opts?.commitPolicy ?? this.#commitPolicy
    const capture: { rejected?: RejectedCommit } = {}

    const commit = readPrivateCommit(decoded)
    let externalCommitDID: string | undefined
    let isCommitMessage = commit != null
    if (commit == null) {
      const external = readExternalCommit(decoded)
      if (external != null) {
        externalCommitDID = external.did
        isCommitMessage = true
      }
      // else: a standalone by-reference Proposal (or an application message / a
      // frame ts-mls will not call back on). Fall through with the roster unchanged
      // so `combined` judges a kind:'proposal' incoming under the same
      // defaultCommitPolicy rows applied to a commit's proposals; a non-admin's
      // authority-bearing proposal is rejected on receipt and never stored.
      // Application messages never reach the callback, so this is inert for them.
    }

    let precomputedReject = false
    let candidateRoster: RosterState = this.#roster
    let surfaced: Array<VerifiedLedgerEntry> = []
    let acceptedEntries: Array<LedgerLogEntry> = []
    let envelopeIDs: Array<string> = []

    if (isCommitMessage) {
      if (commit == null) {
        // An external-join commit carries no control envelope: resolves nothing,
        // folds nothing, never moves the head; candidate roster is unchanged. Its
        // only precomputed reject is an unresolvable committer DID (no UpdatePath /
        // bad credential), which cannot be a valid resync.
        precomputedReject = externalCommitDID === undefined
      } else {
        const env = decodeControlEnvelope(commit.authenticatedData)
        if (!env.ok) {
          precomputedReject = true
        } else {
          const ids = env.envelope.entries ?? []
          envelopeIDs = ids
          const resolved = new Map<string, LedgerLogEntry>()
          const missing: Array<string> = []
          for (const id of ids) {
            const held = this.#entryBodies.get(id)
            if (held != null) {
              resolved.set(id, { ...held, entryID: id })
            } else {
              missing.push(id)
            }
          }
          if (missing.length > 0) {
            if (this.#resolveLedgerEntries == null) {
              throw new MissingLedgerEntriesError(missing)
            }
            const tokens = await this.#resolveLedgerEntries(missing)
            for (const token of tokens) {
              const id = ledgerEntryDigest(token)
              // Content-addressing binds the untrusted body to the requested id.
              if (resolved.has(id) || !missing.includes(id)) continue
              const verified = await verifyLedgerEntry(token)
              if (verified == null) continue
              resolved.set(id, { token, verified, entryID: id })
            }
            const stillMissing = missing.filter((id) => !resolved.has(id))
            if (stillMissing.length > 0) {
              throw new MissingLedgerEntriesError(stillMissing)
            }
          }
          const ordered: Array<LedgerLogEntry> = ids.map((id) => {
            const input = resolved.get(id)
            if (input == null) throw new MissingLedgerEntriesError([id])
            return input
          })

          const foldResult = foldEnvelope(this.#roster, ordered, this.groupID)
          if (!foldResult.ok) {
            precomputedReject = true
          } else {
            candidateRoster = foldResult.roster
            surfaced = foldResult.surfaced
            acceptedEntries = ordered
          }
        }
      }
    }

    const context = buildCommitPolicyContext(this, {
      baseRoster: this.#roster,
      candidateRoster,
      entryIDs: envelopeIDs,
      ...(externalCommitDID !== undefined && { externalCommitDID }),
    })

    const combined: IncomingMessageCallback = (incoming) => {
      // A decode/fold failure is a hard reject even under a caller policy: the
      // ledger the commit depends on is unresolvable or malformed.
      if (precomputedReject) return 'reject'
      if (callerPolicy != null) return callerPolicy(incoming)
      return defaultCommitPolicy(incoming, context)
    }

    const applyOnAccept = () => {
      // Appended, never deduped: the log records what this commit enacted, at the
      // position the head chained it.
      for (const { token, verified, entryID } of acceptedEntries) {
        this.#ledger.push({ entryID, token, verified })
        this.#entryBodies.set(entryID, { token, verified })
      }
      this.#roster = candidateRoster
      if (surfaced.length > 0) this.#onLedgerEntries?.(surfaced)
    }

    return { callback: wrapCommitPolicy(combined, capture), capture, applyOnAccept }
  }

  /**
   * Process a received MLS message (Commit, Proposal, or application). Accepts
   * wire-form bytes (preferred, e.g. from commitInvite/removeMember) or a pre-decoded
   * ts-mls object (legacy). Param widens to `unknown` because `Uint8Array | unknown`
   * collapses to `unknown`; the runtime `instanceof` selects the decode path.
   */
  async processMessage(
    message: Uint8Array | unknown,
    opts?: { commitPolicy?: IncomingMessageCallback },
  ): Promise<Uint8Array | null> {
    let decoded: unknown = message
    if (message instanceof Uint8Array) {
      const parsed = decode(mlsMessageDecoder, message)
      if (parsed == null) {
        throw new Error('processMessage: failed to decode MLSMessage')
      }
      decoded = parsed
    }
    return mutexFor(this).run(async () => {
      const { callback, capture, applyOnAccept } = await this.#prepareCommitPipeline(decoded, opts)
      const result = await mlsProcessMessage({
        context: this.#context,
        state: this.#state,
        message: decoded as Parameters<typeof mlsProcessMessage>[0]['message'],
        ...(callback != null && { callback }),
      })
      this.#state = result.newState
      zeroAll(result.consumed)
      if (result.kind === 'newState' && result.actionTaken === 'reject') {
        throw new CommitRejectedError(
          capture.rejected?.proposals ?? [],
          capture.rejected?.senderLeafIndex,
        )
      }
      if (result.kind === 'applicationMessage') {
        return result.message
      }
      applyOnAccept()
      return null
    })
  }
}

/** Build the CommitPolicyContext both the receive gate and the send-side pending
 *  filter judge against, so the two always agree. `entryIDs` are the ledger entry
 *  ids this commit enacts (drives the expected head); `candidateRoster` is the
 *  post-fold roster receivers install. */
export function buildCommitPolicyContext(
  handle: GroupHandle,
  args: {
    baseRoster: RosterState
    candidateRoster: RosterState
    entryIDs: Array<string>
    externalCommitDID?: string
  },
): CommitPolicyContext {
  const leafToDID = new Map<number, string>()
  for (const member of handle.listMembers()) leafToDID.set(member.leafIndex, member.id)
  const headExt = readLedgerHeadExtension(handle)
  const currentHead =
    headExt != null && headExt.extensionData instanceof Uint8Array
      ? decodeLedgerHead(headExt.extensionData)
      : null
  const expectedHeadExtensionData =
    currentHead == null
      ? new Uint8Array()
      : encodeLedgerHead(extendHead(currentHead.head, args.entryIDs))
  return {
    baseRoster: args.baseRoster,
    candidateRoster: args.candidateRoster,
    didOfLeaf: (leafIndex: number) => leafToDID.get(leafIndex),
    currentExtensions: handle.state.groupContext.extensions,
    expectedHeadExtensionData,
    commitEnactsEntries: args.entryIDs.length > 0,
    ...(args.externalCommitDID !== undefined && { externalCommitDID: args.externalCommitDID }),
  }
}

/** Build the handle a commit hands back: the post-commit state, everything else inherited. */
export function deriveGroup(group: GroupHandle, state: ClientState): GroupHandle {
  return new GroupHandle({
    state,
    credential: group.credential,
    context: group.context,
    ledger: group.ledger,
    cache: group.cache,
    resolver: group.resolver,
    commitPolicy: group.commitPolicy,
    resolveLedgerEntries: group.resolveLedgerEntries,
    onLedgerEntries: group.onLedgerEntries,
  })
}
