import {
  createInMemoryDIDCache,
  type DIDCache,
  type DIDResolver,
  isPeer4,
  normalizeDID,
  type OwnIdentity,
  type SigningIdentity,
} from '@kokuin/token'
import {
  type Capabilities,
  type CiphersuiteName,
  type ClientState,
  type Credential,
  contentTypes,
  createApplicationMessage,
  createCommit,
  createGroupInfoWithExternalPubAndRatchetTree,
  type DefaultProposal,
  decode,
  defaultCapabilities,
  defaultCredentialTypes,
  defaultProposalTypes,
  encode,
  type GroupContextExtension,
  generateKeyPackageWithKey,
  getCiphersuiteImpl,
  type IncomingMessageCallback,
  type KeyPackage,
  type MlsContext,
  type MlsGroupInfo,
  type MlsPublicMessage,
  createGroup as mlsCreateGroup,
  joinGroup as mlsJoinGroup,
  joinGroupExternal as mlsJoinGroupExternal,
  mlsMessageDecoder,
  mlsMessageEncoder,
  processMessage as mlsProcessMessage,
  nodeTypes,
  type ProposalWithSender,
  protocolVersions,
  senderTypes,
  wireformats,
} from 'ts-mls'

import {
  buildCurrentGroupAnchorExtension,
  controlCapabilities,
  decodeGroupAnchor,
  GROUP_ANCHOR_EXTENSION_TYPE,
  type GroupAnchor,
  LEDGER_HEAD_EXTENSION_TYPE,
  readGroupAnchor,
} from './anchor.js'
import { createDIDAuthenticationService } from './authentication.js'
import { sanitizeRatchetTree } from './codec.js'
import {
  type GroupMember,
  type MemberCredential,
  type MLSCredentialIdentity,
  parseMLSCredentialIdentity,
} from './credential.js'
import { nobleCryptoProvider } from './crypto.js'
import { decodeControlEnvelope, encodeControlEnvelope } from './envelope.js'
import { foldEnvelope } from './envelope-fold.js'
import type { FoldInput } from './fold.js'
import {
  assertHeadMatches,
  buildLedgerHeadExtension,
  computeHead,
  decodeLedgerHead,
  encodeLedgerHead,
  extendHead,
  genesisHead,
  headsMatch,
  readLedgerHead,
  readLedgerHeadExtension,
} from './head.js'
import {
  ledgerEntryDigest,
  signLedgerEntry,
  type VerifiedLedgerEntry,
  verifyLedgerEntry,
} from './ledger.js'
import { createMutex, type Mutex } from './mutex.js'
import {
  type CommitPolicyContext,
  defaultCommitPolicy,
  MissingLedgerEntriesError,
} from './policy.js'
import {
  foldRoster,
  type GroupPermission,
  ROLE_ENTRY_TYPE,
  type RoleValue,
  type RosterState,
} from './roster.js'
import type { GroupOptions, Invite, KeyPackageBundle } from './types.js'

const DEFAULT_CIPHERSUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const

/** One serializer per live handle, so its state-mutating operations run one at a
 *  time in issue order. Keyed weakly: the entry is collected with the handle, and
 *  the handle carries no reference back to it. */
const MUTEXES = new WeakMap<GroupHandle, Mutex>()

function mutexFor(handle: GroupHandle): Mutex {
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

async function resolveMlsContext(options?: GroupOptions): Promise<MlsContext> {
  const name = (options?.ciphersuiteName ?? DEFAULT_CIPHERSUITE) as CiphersuiteName
  const cipherSuite = await getCiphersuiteImpl(name, options?.cryptoProvider ?? nobleCryptoProvider)
  const authService = createDIDAuthenticationService()
  return { cipherSuite, authService }
}

export function makeMLSCredential(identity: OwnIdentity): Credential {
  const id = identity.id
  const isPeer = isPeer4(id)
  if (
    isPeer &&
    !('longForm' in identity && typeof (identity as { longForm?: unknown }).longForm === 'string')
  ) {
    throw new Error(
      'peer:4 identity is missing longForm; only identities from createIdentity can be used as MLS members',
    )
  }
  const payload: MLSCredentialIdentity = { id }
  if (isPeer) {
    payload.longForm = (identity as unknown as { longForm: string }).longForm
  }
  return {
    credentialType: defaultCredentialTypes.basic,
    identity: new TextEncoder().encode(JSON.stringify(payload)),
  }
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

// ---------------------------------------------------------------------------
// Lifecycle functions
// ---------------------------------------------------------------------------

/**
 * Build the leaf-node capabilities for a member joining or creating a group. RFC
 * 9420 requires a leaf to advertise every non-default GroupContext extension type
 * the group uses; derive that set from the group's extensions so it cannot desync.
 * A leaf advertising only defaults is rejected by ts-mls ("client does not support
 * every extension in the GroupContext"). An explicit `override` wins verbatim.
 */
function buildLeafCapabilities(
  extensions: ReadonlyArray<GroupContextExtension>,
  override?: Capabilities,
): Capabilities {
  if (override != null) return override
  const base = defaultCapabilities()
  const types = new Set<number>([...base.extensions, ...extensions.map((e) => e.extensionType)])
  return { ...base, extensions: [...types] }
}

export type CreateGroupResult = {
  group: GroupHandle
  credential: MemberCredential
}

/** Create a new MLS group. The identity becomes the sole member and admin. */
export async function createGroup(
  identity: OwnIdentity,
  groupID: string,
  options?: GroupOptions,
): Promise<CreateGroupResult> {
  const cache = options?.cache ?? createInMemoryDIDCache()
  const context = await resolveMlsContext(options)

  // Every group is anchored at creation: creator is the epoch-0 admin, ledger head
  // starts at genesis. A caller-supplied anchor is left untouched (the caller owns
  // its contents); its `creatorDID` coupling to the creating identity is validated
  // below. A decode failure here is left to the fail-closed decode in the constructor.
  const extensions = [...(options?.extensions ?? [])]
  const suppliedAnchorExtension = extensions.find(
    (ext) => ext.extensionType === GROUP_ANCHOR_EXTENSION_TYPE,
  )
  if (suppliedAnchorExtension != null) {
    const suppliedAnchorData = suppliedAnchorExtension.extensionData
    const suppliedAnchor =
      suppliedAnchorData instanceof Uint8Array ? decodeGroupAnchor(suppliedAnchorData) : null
    if (
      suppliedAnchor != null &&
      normalizeDID(suppliedAnchor.creatorDID) !== normalizeDID(identity.id)
    ) {
      throw new Error(
        `createGroup: the anchor's creatorDID (${suppliedAnchor.creatorDID}) must be the creating identity (${identity.id})`,
      )
    }
  }
  if (!extensions.some((ext) => ext.extensionType === GROUP_ANCHOR_EXTENSION_TYPE)) {
    extensions.push(buildCurrentGroupAnchorExtension(identity.id))
  }
  if (!extensions.some((ext) => ext.extensionType === LEDGER_HEAD_EXTENSION_TYPE)) {
    extensions.push(buildLedgerHeadExtension(genesisHead(groupID)))
  }
  const statePromise = generateKeyPackageWithKey({
    credential: makeMLSCredential(identity),
    signatureKeyPair: { signKey: identity.privateKey, publicKey: identity.publicKey },
    cipherSuite: context.cipherSuite,
    capabilities: buildLeafCapabilities(extensions, options?.capabilities),
  }).then((keyPackage) => {
    return mlsCreateGroup({
      context,
      groupId: new TextEncoder().encode(groupID),
      keyPackage: keyPackage.publicPackage,
      privateKeyPackage: keyPackage.privatePackage,
      extensions,
    })
  })
  const state = await statePromise

  const credential: MemberCredential = {
    id: identity.id,
    groupID,
  }
  const group = new GroupHandle({
    state,
    credential,
    context,
    cache,
    resolver: options?.resolver,
    commitPolicy: options?.commitPolicy,
    resolveLedgerEntries: options?.resolveLedgerEntries,
    onLedgerEntries: options?.onLedgerEntries,
  })

  return { group, credential }
}

export type RestoreGroupParams = {
  state: ClientState
  credential: MemberCredential
  /** Signed ledger tokens the host persisted, replayed to rebuild the roster. */
  ledgerEntries?: Array<string>
  options?: GroupOptions
}

export async function restoreGroup(params: RestoreGroupParams): Promise<GroupHandle> {
  const cache = params.options?.cache ?? createInMemoryDIDCache()
  // Construction reseeds `{creator: 'admin'}` from the anchor in the restored state;
  // an anchorless state throws (the same fail-closed guard).
  const group = new GroupHandle({
    state: params.state,
    credential: params.credential,
    context: await resolveMlsContext(params.options),
    cache,
    resolver: params.options?.resolver,
    commitPolicy: params.options?.commitPolicy,
    resolveLedgerEntries: params.options?.resolveLedgerEntries,
    onLedgerEntries: params.options?.onLedgerEntries,
  })
  await group.applyLedgerEntries(params.ledgerEntries ?? [])
  return group
}

export type CreateInviteParams = {
  group: GroupHandle
  identity: SigningIdentity
  recipientDID: string
  permission: GroupPermission
}

export type CreateInviteResult = {
  invite: Invite
}

/**
 * Create an invite for a new member. Does NOT add them — call commitInvite with
 * their key package for that.
 *
 * Only an admin may invite: a role entry from a non-admin issuer is dropped by every
 * receiver's fold, so refusing here turns a silent downstream rejection into a local
 * error.
 */
export async function createInvite(params: CreateInviteParams): Promise<CreateInviteResult> {
  const { group, identity, recipientDID, permission } = params
  if (group.roster.roles.get(normalizeDID(identity.id)) !== 'admin') {
    throw new Error('createInvite: the inviter must be an admin in the group roster')
  }

  // The role entry naming the invitee. Its issuer is the inviter (authenticated by
  // the token signature) and its value is the permission granted.
  const roleToken = await signLedgerEntry(identity, {
    type: ROLE_ENTRY_TYPE,
    groupID: group.groupID,
    subject: recipientDID,
    value: permission,
  })

  const invite: Invite = {
    groupID: group.groupID,
    inviterID: identity.id,
    // The whole log, new role entry last: a joiner handed only its own entry would
    // never learn of earlier role changes and would reject every commit by an admin
    // promoted since — a permanent fork nothing re-sends. The new entry must fold
    // after the history it depends on, hence last. Re-granting a role the log already
    // carries appends it again (a legal re-enactment). The joiner still folds from the
    // anchor, so padding this list cannot promote anyone.
    ledgerEntries: [...group.ledgerTokens, roleToken],
  }

  return { invite }
}

/**
 * The GroupContext extension list a commit installs when it enacts `entryIDs`: the
 * current list with only the ledger-head extension replaced by the head extended by
 * those ids, in envelope order. Every other extension — the anchor above all — is the
 * verbatim object from the current GroupContext, never a re-encode: the receiving
 * policy byte-compares the anchor.
 */
function extensionsWithHead(
  group: GroupHandle,
  entryIDs: Array<string>,
): Array<GroupContextExtension> {
  const current = readLedgerHead(group)
  if (current == null) {
    throw new Error('group has no ledger head extension; it cannot enact ledger entries')
  }
  const next = buildLedgerHeadExtension(extendHead(current.head, entryIDs))
  return group.state.groupContext.extensions.map((ext) =>
    ext.extensionType === LEDGER_HEAD_EXTENSION_TYPE ? next : ext,
  )
}

/** Build the CommitPolicyContext both the receive gate and the send-side pending
 *  filter judge against, so the two always agree. `entryIDs` are the ledger entry
 *  ids this commit enacts (drives the expected head); `candidateRoster` is the
 *  post-fold roster receivers install. */
function buildCommitPolicyContext(
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

/**
 * The one place a commit carrying control-ledger entries is built: `commitInvite`,
 * `removeMember`, and `commitLedgerEntries` all route through it, so envelope and
 * head never drift apart.
 *
 * `enacted` is exactly what this commit enacts, and only the caller can decide it:
 * entries are enacted by *position*, so one whose content the log already carries is
 * a legitimate re-enactment (e.g. a demotion back to a previously-held role) and must
 * not be filtered by content.
 *
 * The envelope names only what this commit enacts, never the whole history: replaying
 * history would re-judge every past entry against the present roster, and a grant by
 * a since-demoted admin would read as a non-admin's — freezing every group that ever
 * rotated admins.
 *
 * When `enacted` is non-empty the commit also carries a group-context-extensions
 * proposal advancing the head by exactly those ids, in envelope order. An empty list
 * moves no head and carries no envelope.
 */
async function commitWithEntries(
  group: GroupHandle,
  extraProposals: Array<DefaultProposal>,
  enacted: Array<string>,
  ratchetTreeExtension = false,
): Promise<Awaited<ReturnType<typeof createCommit>>> {
  // Same reason createInvite guards the inviter: a non-admin's commit is rejected by
  // every receiver, so fail here rather than emitting a commit nobody will apply.
  if (group.roster.roles.get(normalizeDID(group.credential.id)) !== 'admin') {
    throw new Error('the committer must be an admin in the group roster')
  }

  // Fold the entries exactly as every receiver will; refuse to author a commit the
  // group would reject. Without this the write path fails *open*: the committer
  // advances its own log and head while every receiver rejects the commit, forking
  // itself off. Being an admin is not enough — an entry's own issuer must hold
  // authority at the position it lands, so a token signed by a since-demoted admin is
  // dead paper no matter who commits it.
  const inputs: Array<FoldInput> = []
  for (const token of enacted) {
    const verified = await verifyLedgerEntry(token)
    if (verified == null) {
      throw new Error('cannot enact a ledger entry whose signature does not verify')
    }
    inputs.push({ verified, entryID: ledgerEntryDigest(token) })
  }
  const fold = foldEnvelope(group.roster, inputs, group.groupID)
  if (!fold.ok) {
    throw new Error(`cannot enact ledger entry ${fold.entryID}: ${fold.reason}`)
  }

  const entryIDs = enacted.map(ledgerEntryDigest)

  // Filter the pending-proposal set the committer would otherwise absorb: ts-mls folds
  // every unappliedProposal into the commit, so a non-admin's pending proposal would
  // ride it and every peer would reject the whole thing — one member could stall the
  // group. Judge each against the same defaultCommitPolicy and context receivers build,
  // dropping any the group would reject.
  const filterContext = buildCommitPolicyContext(group, {
    baseRoster: group.roster,
    candidateRoster: fold.roster,
    entryIDs,
  })
  const keptPending: typeof group.state.unappliedProposals = {}
  for (const [ref, pws] of Object.entries(group.state.unappliedProposals)) {
    if (defaultCommitPolicy({ kind: 'proposal', proposal: pws }, filterContext) !== 'reject') {
      keptPending[ref] = pws
    }
  }
  const commitState = { ...group.state, unappliedProposals: keptPending }

  const proposals = [...extraProposals]
  if (entryIDs.length > 0) {
    proposals.push({
      proposalType: defaultProposalTypes.group_context_extensions,
      groupContextExtensions: { extensions: extensionsWithHead(group, entryIDs) },
    })
  }

  return await createCommit({
    context: group.context,
    state: commitState,
    extraProposals: proposals,
    ...(ratchetTreeExtension && { ratchetTreeExtension: true }),
    ...(entryIDs.length > 0 && {
      authenticatedData: encodeControlEnvelope({ v: 1, entries: entryIDs }),
    }),
  })
}

/**
 * The entries an invite adds beyond the committer's own log: everything past the
 * log's length. Positional, never by content — a re-granted role is a token the log
 * already carries earlier, and content-narrowing would drop the very entry the invite
 * exists to enact.
 *
 * Positional narrowing is sound only when the invite's list *begins with* the
 * committer's log, so that is asserted, not assumed: an invite against a different
 * history would mis-slice and move the head by ids that do not follow the group's own,
 * corrupting the chain for every receiver.
 */
function entriesAddedByInvite(group: GroupHandle, invite: Invite): Array<string> {
  const held = group.ledgerTokens
  if (
    invite.ledgerEntries.length < held.length ||
    held.some((token, index) => invite.ledgerEntries[index] !== token)
  ) {
    throw new Error("commitInvite: the invite's ledger does not extend this group's own")
  }
  return invite.ledgerEntries.slice(held.length)
}

/** Build the handle a commit hands back: the post-commit state, everything else inherited. */
function deriveGroup(group: GroupHandle, state: ClientState): GroupHandle {
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

export type CommitLedgerEntriesResult = {
  /** Framed MLSMessage bytes. Broadcast to existing members via the DS. */
  commitMessage: Uint8Array
  newGroup: GroupHandle
  /** Post-commit epoch the group is now at (== newGroup.epoch). */
  epoch: bigint
}

/**
 * The admin write path for the control ledger: a commit carrying no membership
 * proposal, only the entries it enacts and the head move covering them. An entry that
 * never rides a commit is invisible to the head, and a joiner recomputing the head
 * would read the history as doctored.
 *
 * Enacts exactly `tokens` at the end of the log — including one whose content the log
 * already carries (how an admin is demoted back to a previously-held role). Rejects an
 * empty `tokens` list.
 *
 * Reads `group` and returns a NEW derived handle (`newGroup`); it never advances
 * `group`. The caller MUST adopt `newGroup` — never reuse `group` — before the next
 * commit: two commits from the same source handle both frame at its epoch and diverge.
 * The mutex only serializes concurrent calls against one handle; it does not make a
 * second commit from a superseded handle safe.
 */
export async function commitLedgerEntries(
  group: GroupHandle,
  tokens: Array<string>,
): Promise<CommitLedgerEntriesResult> {
  return mutexFor(group).run(async () => {
    if (tokens.length === 0) {
      throw new Error('commitLedgerEntries: no ledger entries to commit')
    }
    const result = await commitWithEntries(group, [], tokens)
    const newGroup = deriveGroup(group, result.newState)
    await newGroup.applyLedgerEntries(tokens)
    return {
      commitMessage: encode(mlsMessageEncoder, result.commit),
      newGroup,
      epoch: newGroup.epoch,
    }
  })
}

export type CommitInviteResult = {
  /** Framed MLSMessage bytes. Broadcast to existing members via the DS. */
  commitMessage: Uint8Array
  /** Framed MLSMessage(Welcome) bytes. Delivered to the new member. */
  welcomeMessage: Uint8Array
  newGroup: GroupHandle
  /** Post-commit epoch (== newGroup.epoch). NOT the commit's wire-header epoch: a
   *  commit is framed at the sender's pre-commit epoch (== epoch - 1n), which is what
   *  receivers compare against their own handle.epoch for ordering (see
   *  readMessageEpoch). */
  epoch: bigint
}

/**
 * Commit an invite by adding the invitee's key package. Produces an MLS Commit +
 * Welcome.
 *
 * The invite's ledger entries are enacted here: their content ids ride the commit's
 * control envelope and advance the head by exactly those ids, so every receiver folds
 * the invitee's role entry as it applies the Add. The envelope carries ids, not
 * bodies — a receiver holding neither the entry nor a `resolveLedgerEntries` resolver
 * throws MissingLedgerEntriesError.
 *
 * The invite carries the group's whole history (a joiner has nothing to fold it onto),
 * but only the entries beyond that history ride the commit — see
 * {@link entriesAddedByInvite} and {@link commitWithEntries}.
 *
 * Reads `group` and returns a NEW derived handle (`newGroup`); it never advances
 * `group`. The caller MUST adopt `newGroup` — never reuse `group` — before the next
 * commit: two commits from the same source handle both frame at its epoch and diverge.
 * The mutex only serializes concurrent calls against one handle; it does not make a
 * second commit from a superseded handle safe.
 */
export async function commitInvite(
  group: GroupHandle,
  keyPackage: KeyPackage,
  invite: Invite,
): Promise<CommitInviteResult> {
  return mutexFor(group).run(async () => {
    if (invite.groupID !== group.groupID) {
      throw new Error(`commitInvite: invite is for group ${invite.groupID}, not ${group.groupID}`)
    }

    const enacted = entriesAddedByInvite(group, invite)
    const addProposal: DefaultProposal = {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage },
    }
    const result = await commitWithEntries(group, [addProposal], enacted, true)

    const newGroup = deriveGroup(group, result.newState)

    if (result.welcome == null) {
      throw new Error('commitInvite: expected a Welcome message for the add proposal')
    }
    // The entries this commit enacts are now part of the group's ledger.
    await newGroup.applyLedgerEntries(enacted)
    return {
      commitMessage: encode(mlsMessageEncoder, result.commit),
      welcomeMessage: encode(mlsMessageEncoder, result.welcome),
      newGroup,
      epoch: newGroup.epoch,
    }
  })
}

export type ProcessWelcomeResult = {
  group: GroupHandle
  credential: MemberCredential
}

export type ProcessWelcomeParams = {
  identity: OwnIdentity
  invite: Invite
  /** Wire-form framed MLSMessage(Welcome) bytes (preferred), or a pre-decoded
   *  ts-mls Welcome object (legacy). `Uint8Array | unknown` collapses to
   *  `unknown` in TypeScript; the runtime `instanceof` check selects the path. */
  welcome: Uint8Array | unknown
  keyPackageBundle: KeyPackageBundle
  ratchetTree?: unknown
  options?: GroupOptions
}

/**
 * Process a Welcome message to join a group.
 */
export async function processWelcome(params: ProcessWelcomeParams): Promise<ProcessWelcomeResult> {
  const { identity, invite, welcome, keyPackageBundle, ratchetTree, options } = params
  const cache = options?.cache ?? createInMemoryDIDCache()
  const context = await resolveMlsContext(options)

  // A Welcome is only this member's when the invite carries a role entry naming
  // them: an invite minted for someone else is not an invitation to join.
  const selfDID = normalizeDID(identity.id)
  let namesSelf = false
  for (const token of invite.ledgerEntries) {
    const verified = await verifyLedgerEntry(token)
    if (
      verified != null &&
      verified.entry.type === ROLE_ENTRY_TYPE &&
      verified.entry.groupID === invite.groupID &&
      normalizeDID(verified.entry.subject) === selfDID
    ) {
      namesSelf = true
      break
    }
  }
  if (!namesSelf) {
    throw new Error('processWelcome: the invite carries no role entry naming this identity')
  }

  let resolvedWelcome: unknown = welcome
  if (welcome instanceof Uint8Array) {
    const decoded = decode(mlsMessageDecoder, welcome)
    if (decoded == null || decoded.wireformat !== wireformats.mls_welcome) {
      throw new Error('processWelcome: expected a framed MLSMessage(Welcome)')
    }
    resolvedWelcome = decoded.welcome
  }

  type JoinGroupParams = Parameters<typeof mlsJoinGroup>[0]
  const sanitizedTree = Array.isArray(ratchetTree) ? sanitizeRatchetTree(ratchetTree) : ratchetTree
  const state = await mlsJoinGroup({
    context,
    welcome: resolvedWelcome as JoinGroupParams['welcome'],
    keyPackage: keyPackageBundle.publicPackage as JoinGroupParams['keyPackage'],
    privateKeys: keyPackageBundle.privatePackage as JoinGroupParams['privateKeys'],
    ...(sanitizedTree != null && {
      ratchetTree: sanitizedTree as JoinGroupParams['ratchetTree'],
    }),
  })

  const credential: MemberCredential = {
    id: identity.id,
    groupID: invite.groupID,
  }

  const group = new GroupHandle({
    state,
    credential,
    context,
    cache,
    resolver: options?.resolver,
    commitPolicy: options?.commitPolicy,
    resolveLedgerEntries: options?.resolveLedgerEntries,
    onLedgerEntries: options?.onLedgerEntries,
  })
  // The head authenticated in the joined GroupContext is the fold from genesis over the
  // group's entries, in order. Recompute it over the inviter's supplied entries: an
  // omitted, reordered, or truncated list cannot reproduce it. Checked before folding,
  // so an incomplete ledger never reaches the roster.
  const authenticated = readLedgerHead(group)
  if (authenticated == null) {
    throw new Error('processWelcome: the group has no ledger head extension')
  }
  assertHeadMatches(
    authenticated.head,
    computeHead(invite.groupID, invite.ledgerEntries.map(ledgerEntryDigest)),
  )

  // Fold the invite's entries: the roster is seeded from the anchor and the fold grants
  // authority only to an admin-so-far, so a member-signed entry cannot promote anyone
  // even though applyLedgerEntries itself is the permissive primitive.
  await group.applyLedgerEntries(invite.ledgerEntries)

  return { group, credential }
}

export type ProcessWelcomeOnceParams = ProcessWelcomeParams & {
  /** The group ids this member already holds a handle for. */
  joined: Iterable<string>
}

/**
 * Join from a Welcome, unless this member already joined that group — then return
 * `null` and keep the existing handle.
 *
 * A Welcome is delivered AT LEAST ONCE by design (a sender re-delivers on a crash
 * between journaling its commit and delivering, or it would strand an invitee never
 * told it was added), so the receiver must absorb the repeat. {@link processWelcome}
 * does NOT — it is a pure function with no registry of joined groups, so a repeat
 * succeeds silently and hands back a second handle frozen at the join epoch.
 * **Adopting that handle rolls the member back: every member added since is gone from
 * its roster, it can no longer read traffic, and nothing raises an error.** This
 * function exists to remove that hazard.
 *
 * The check cannot be hoisted above `processWelcome`: a Welcome's group id is
 * encrypted to the joiner's key, so there is nothing to check until the handle exists.
 * So this joins, compares the resulting group id against `joined`, and drops the stale
 * handle (a local falling out of scope — nothing zeroizes its key material) rather than
 * returning it. Dedup keys on the group id alone; a Welcome for an id absent from
 * `joined` is an ordinary first join.
 */
export async function processWelcomeOnce(
  params: ProcessWelcomeOnceParams,
): Promise<ProcessWelcomeResult | null> {
  const { joined, ...welcomeParams } = params
  const held = new Set(joined)
  const result = await processWelcome(welcomeParams)
  if (held.has(result.group.groupID)) {
    return null
  }
  return result
}

export type RemoveMemberResult = {
  /** Framed MLSMessage bytes. Broadcast to existing members via the DS. */
  commitMessage: Uint8Array
  newGroup: GroupHandle
  /** Post-commit epoch (== newGroup.epoch). NOT the commit's wire-header epoch: a
   *  commit is framed at the sender's pre-commit epoch (== epoch - 1n), which is what
   *  receivers compare against their own handle.epoch for ordering (see
   *  readMessageEpoch). */
  epoch: bigint
}

/**
 * Remove a member. Advances the epoch and rotates keys.
 *
 * Removal must demote: a receiver rejects a Remove whose target is still `admin` in
 * the folded roster. So removing an admin means riding the demotion entry on the same
 * commit — pass it as `ledgerEntries`. The caller signs the entry; this only carries it.
 *
 * Reads `group` and returns a NEW derived handle (`newGroup`); it never advances
 * `group`. The caller MUST adopt `newGroup` — never reuse `group` — before the next
 * commit: two commits from the same source handle both frame at its epoch and diverge.
 * The mutex only serializes concurrent calls against one handle; it does not make a
 * second commit from a superseded handle safe.
 */
export async function removeMember(
  group: GroupHandle,
  leafIndex: number,
  ledgerEntries?: Array<string>,
): Promise<RemoveMemberResult> {
  return mutexFor(group).run(async () => {
    const removeProposal: DefaultProposal = {
      proposalType: defaultProposalTypes.remove,
      remove: { removed: leafIndex },
    }

    const enacted = ledgerEntries ?? []
    const result = await commitWithEntries(group, [removeProposal], enacted)

    const newGroup = deriveGroup(group, result.newState)
    await newGroup.applyLedgerEntries(enacted)

    return {
      commitMessage: encode(mlsMessageEncoder, result.commit),
      newGroup,
      epoch: newGroup.epoch,
    }
  })
}

/**
 * Read the MLS epoch from a framed message's cleartext header without decrypting.
 * Advisory only — the header epoch is unauthenticated; use it to drop stale / buffer
 * future messages before the authenticated processMessage. Returns undefined for
 * non-message or undecodable bytes.
 *
 * Total by contract (a safe pre-filter over untrusted Delivery Service bytes): never
 * throws. ts-mls `decode` throws on some malformed inputs (e.g. oversized); that is
 * caught and treated as "not a message".
 */
export function readMessageEpoch(bytes: Uint8Array): bigint | undefined {
  const message = (() => {
    try {
      return decode(mlsMessageDecoder, bytes)
    } catch {
      return undefined
    }
  })()
  if (message == null) return undefined
  if (message.wireformat === wireformats.mls_private_message) {
    return message.privateMessage.epoch
  }
  if (message.wireformat === wireformats.mls_public_message) {
    return message.publicMessage.content.epoch
  }
  return undefined
}

export type InspectGroupInfoResult = {
  /** The GroupInfo's epoch, read from its groupContext. */
  epoch: bigint
  /** The GroupInfo's ratchet-tree hash, read from its groupContext. Compare for
   *  equality against a known post-commit state's treeHash to confirm canonical
   *  convergence (same epoch + same treeHash ⟺ same group state). */
  treeHash: Uint8Array
}

/**
 * Read a framed MLSMessage(GroupInfo)'s epoch and ratchet-tree hash without joining
 * or mutating state. Used to confirm an external-resync Commit was canonically
 * accepted: compare the returned (epoch, treeHash) against the rejoiner's own
 * post-commit state. Equal ⟹ this device's Commit won the epoch; unequal ⟹ another
 * won and the rejoin must retry.
 *
 * Structural read only — does NOT verify the GroupInfo signature; the caller obtains
 * the bytes over the group's authorized channel. Unlike readMessageEpoch, this THROWS
 * on malformed input: an already-trusted malformed GroupInfo is a programming error.
 */
export function inspectGroupInfo(groupInfoBytes: Uint8Array): InspectGroupInfoResult {
  const message = decode(mlsMessageDecoder, groupInfoBytes)
  if (message == null) {
    throw new Error('Invalid groupInfo: failed to decode MLSMessage')
  }
  if (message.wireformat !== wireformats.mls_group_info) {
    throw new Error(
      `Invalid groupInfo: expected wireformat mls_group_info, got ${String(message.wireformat)}`,
    )
  }
  const { groupContext } = message.groupInfo
  return { epoch: groupContext.epoch, treeHash: groupContext.treeHash }
}

export type GroupInfoBinding = {
  /** The group id the GroupInfo's GroupContext names, decoded from its bytes. */
  groupID: string
  /** The genesis-anchor GroupContext extension's raw data, or null when absent.
   *  Byte-compared against the requester's own immutable anchor, never re-encoded. */
  anchorExtensionData: Uint8Array | null
}

/**
 * Read a framed MLSMessage(GroupInfo)'s group-identifying bindings without joining:
 * the group id its GroupContext names and the raw genesis-anchor extension bytes. A
 * recovering peer compares both against the group it believes it is healing, so a
 * GroupInfo for another group or with a different anchor is refused before it can
 * steer an external join. Structural read only; does not verify the signature. Throws
 * on malformed input, like {@link inspectGroupInfo}.
 */
export function readGroupInfoBinding(groupInfoBytes: Uint8Array): GroupInfoBinding {
  const message = decode(mlsMessageDecoder, groupInfoBytes)
  if (message == null) {
    throw new Error('Invalid groupInfo: failed to decode MLSMessage')
  }
  if (message.wireformat !== wireformats.mls_group_info) {
    throw new Error(
      `Invalid groupInfo: expected wireformat mls_group_info, got ${String(message.wireformat)}`,
    )
  }
  const { groupContext } = message.groupInfo
  const anchor = groupContext.extensions.find(
    (ext) => ext.extensionType === GROUP_ANCHOR_EXTENSION_TYPE,
  )
  return {
    groupID: new TextDecoder().decode(groupContext.groupId),
    anchorExtensionData: anchor?.extensionData instanceof Uint8Array ? anchor.extensionData : null,
  }
}

/** Generate a key package for joining groups. */
export async function createKeyPackageBundle(
  identity: OwnIdentity,
  options?: GroupOptions,
): Promise<KeyPackageBundle> {
  const { cipherSuite } = await resolveMlsContext(options)
  const result = await generateKeyPackageWithKey({
    credential: makeMLSCredential(identity),
    signatureKeyPair: { signKey: identity.privateKey, publicKey: identity.publicKey },
    cipherSuite,
    // An invitee leaf must advertise the control extension types or ts-mls
    // refuses to add it to an anchored group. An explicit override still wins.
    capabilities: options?.capabilities ?? controlCapabilities(),
  })
  return { ...result, ownerDID: identity.id }
}

// ---------------------------------------------------------------------------
// External rejoin (RFC 9420 §11.2.1 — stale device self-recovery)
// ---------------------------------------------------------------------------

export type ExportGroupInfoParams = {
  group: GroupHandle
}

export type ExportGroupInfoResult = {
  /** Framed MLSMessage(GroupInfo) bytes. Self-describing with protocol
   *  version + wireformat + GroupInfo (external_pub + ratchet tree embedded). */
  groupInfo: Uint8Array
}

export async function exportGroupInfo(
  params: ExportGroupInfoParams,
): Promise<ExportGroupInfoResult> {
  const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(
    params.group.state,
    [],
    params.group.context.cipherSuite,
  )
  const framed: MlsGroupInfo = {
    version: protocolVersions.mls10,
    wireformat: wireformats.mls_group_info,
    groupInfo,
  }
  return { groupInfo: encode(mlsMessageEncoder, framed) }
}

export type JoinGroupExternalParams = {
  identity: OwnIdentity
  /** Framed MLSMessage(GroupInfo) bytes from exportGroupInfo. */
  groupInfo: Uint8Array
  /** Caller's cached credential (from prior processWelcome). Reused as-is,
   *  not re-validated. */
  credential: MemberCredential
  /** Stale-recovery only: atomically removes prior leaf for same identity. */
  resync: true
  options?: GroupOptions
  authenticatedData?: Uint8Array
}

export type JoinGroupExternalResult = {
  /** Framed MLSMessage(PublicMessage) bytes. Broadcast to existing members. */
  commitMessage: Uint8Array
  /** New GroupHandle at post-commit epoch. */
  group: GroupHandle
}

export async function joinGroupExternal(
  params: JoinGroupExternalParams,
): Promise<JoinGroupExternalResult> {
  const {
    identity,
    groupInfo: groupInfoBytes,
    credential,
    resync,
    options,
    authenticatedData,
  } = params

  // Resync replaces the caller's own prior leaf, so the rejoining identity must match
  // the presented credential. A friendly precheck, not the security boundary: on a
  // mismatch ts-mls rejects the external commit downstream anyway. Eviction
  // completeness rests on ts-mls requiring a matching prior leaf in the resynced tree,
  // which a removed member no longer has.
  if (normalizeDID(identity.id) !== normalizeDID(credential.id)) {
    throw new Error(
      `joinGroupExternal: identity.id (${identity.id}) must match credential.id (${credential.id}) for resync`,
    )
  }

  const cache = options?.cache ?? createInMemoryDIDCache()
  const context = await resolveMlsContext(options)

  const message = decode(mlsMessageDecoder, groupInfoBytes)
  if (message == null) {
    throw new Error('Invalid groupInfo: failed to decode MLSMessage')
  }
  if (message.wireformat !== wireformats.mls_group_info) {
    throw new Error(
      `Invalid groupInfo: expected wireformat mls_group_info, got ${String(message.wireformat)}`,
    )
  }
  // Discriminated-union narrow via the literal wireformat tag — no cast needed.
  const { groupInfo } = message

  // A resync must target the group this credential names. The returned handle reports
  // `credential.groupID` whatever group it joins, so without this a caller steered onto
  // a GroupInfo for another group would hold a handle that lies about its identity.
  const offeredGroupID = new TextDecoder().decode(groupInfo.groupContext.groupId)
  if (offeredGroupID !== credential.groupID) {
    throw new Error(
      `joinGroupExternal: groupInfo names group ${offeredGroupID}, not credential.groupID (${credential.groupID})`,
    )
  }

  // The rejoining leaf must advertise every GroupContext extension the group uses, or
  // ts-mls rejects the external join. Derive them from the GroupInfo being resynced
  // against, honoring an explicit capabilities override.
  const keyPackage = await generateKeyPackageWithKey({
    credential: makeMLSCredential(identity),
    signatureKeyPair: { signKey: identity.privateKey, publicKey: identity.publicKey },
    cipherSuite: context.cipherSuite,
    capabilities: buildLeafCapabilities(groupInfo.groupContext.extensions, options?.capabilities),
  })

  const { publicMessage, newState } = await mlsJoinGroupExternal({
    context,
    groupInfo,
    keyPackage: keyPackage.publicPackage,
    privateKeys: keyPackage.privatePackage,
    resync,
    ...(authenticatedData != null && { authenticatedData }),
  })

  const framedCommit: MlsPublicMessage = {
    version: protocolVersions.mls10,
    wireformat: wireformats.mls_public_message,
    publicMessage,
  }
  const commitMessage = encode(mlsMessageEncoder, framedCommit)

  const group = new GroupHandle({
    state: newState,
    credential,
    context,
    cache,
    resolver: options?.resolver,
    commitPolicy: options?.commitPolicy,
    resolveLedgerEntries: options?.resolveLedgerEntries,
    onLedgerEntries: options?.onLedgerEntries,
  })

  return { commitMessage, group }
}
