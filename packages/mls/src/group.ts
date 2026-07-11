import {
  createInMemoryDIDCache,
  type DIDCache,
  type DIDResolver,
  isPeer4,
  normalizeDID,
  type OwnIdentity,
  type SigningIdentity,
  stringifyToken,
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
  wireformats,
} from 'ts-mls'

import {
  buildCurrentGroupAnchorExtension,
  controlCapabilities,
  GROUP_ANCHOR_EXTENSION_TYPE,
  type GroupAnchor,
  LEDGER_HEAD_EXTENSION_TYPE,
  readGroupAnchor,
  readGroupAnchorExtension,
} from './anchor.js'
import { createDIDAuthenticationService } from './authentication.js'
import {
  createGroupCapability,
  delegateGroupMembership,
  type GroupPermission,
} from './capability.js'
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
  readLedgerHead,
  readLedgerHeadExtension,
} from './head.js'
import {
  ledgerEntryDigest,
  signLedgerEntry,
  type VerifiedLedgerEntry,
  verifyLedgerEntry,
} from './ledger.js'
import { defaultCommitPolicy, MissingLedgerEntriesError } from './policy.js'
import { foldRoster, ROLE_ENTRY_TYPE, type RoleValue, type RosterState } from './roster.js'
import type { GroupOptions, Invite, KeyPackageBundle } from './types.js'

const DEFAULT_CIPHERSUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const

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

/**
 * Thrown by GroupHandle.processMessage/decrypt when the active commit policy
 * rejects an incoming commit. The handle is left at its pre-commit epoch.
 */
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
 * Wrap a consumer commit policy so the rejected commit's proposals are captured
 * for CommitRejectedError. ts-mls's ProcessMessageResult does not surface the
 * rejected proposals on the result, so we record them from the callback's own
 * argument on the 'reject' path onto `capture.rejected`. Returns undefined when
 * no policy is set.
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
 * Read the cleartext commit fields a PrivateMessage commit exposes before any
 * epoch secret is available: its `authenticatedData` carrier. Returns undefined
 * for anything that is not a PrivateMessage of contentType commit (application
 * message, proposal, PublicMessage, or a pre-decoded non-frame) — those keep the
 * pre-envelope code path. The decoded frame is widened to `unknown` on both
 * public entry points, so this narrows structurally rather than by cast.
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
 * A control-ledger entry as a handle holds it: the signed token — the canonical
 * persistent and wire form, the only thing that can be handed to another party —
 * paired with its verified form. The verified form is a one-way derivation (the
 * token cannot be reconstructed from it), so keeping only it would leave a handle
 * unable to forward the ledger it holds.
 */
export type HeldLedgerEntry = {
  token: string
  verified: VerifiedLedgerEntry
}

/** A held entry paired with its content id — one position in the ledger log. */
export type LedgerLogEntry = HeldLedgerEntry & { entryID: string }

/**
 * Project a held ledger into the roster. foldRoster is the role projection: it
 * drops every non-`group.role` entry by type, so the mixed-type ledger is fed in
 * as role inputs and the fold filters. The log is replayed in order, repeats and
 * all: a claim re-enacted at a later position must undo what came between.
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
  /** Stringified root capability (for delegation) */
  rootCapability: string
  /** The control-ledger log this handle starts from, in enactment order. A handle
   *  derived from another (commitInvite/removeMember) inherits the parent's, so the
   *  roster it folds does not revert to the anchor alone. */
  ledger?: ReadonlyArray<LedgerLogEntry>
  cache: DIDCache
  resolver?: DIDResolver
  /** Default commit policy applied by processMessage/decrypt. */
  commitPolicy?: IncomingMessageCallback
  /** Fetch control-ledger entry bodies the local ledger lacks (commit pre-pass). */
  resolveLedgerEntries?: (ids: Array<string>) => Promise<Array<string>>
  /** Surface an accepted commit's notarized non-`group.role` entries to the consumer. */
  onLedgerEntries?: (entries: Array<VerifiedLedgerEntry>) => void
}

/**
 * Mutable wrapper around MLS group state + Enkaku credential.
 */
export class GroupHandle {
  #state: ClientState
  #credential: MemberCredential
  #context: MlsContext
  #rootCapability: string
  #cache: DIDCache
  #resolver?: DIDResolver
  #commitPolicy?: IncomingMessageCallback
  #resolveLedgerEntries?: (ids: Array<string>) => Promise<Array<string>>
  #onLedgerEntries?: (entries: Array<VerifiedLedgerEntry>) => void
  #anchor: GroupAnchor
  /** The ordered log of enactments — the ledger as the head chains it. The same
   *  content id may appear more than once: a claim re-enacted at a later position
   *  undoes what came between, which is how a demotion back to a previously-held
   *  role expresses itself at all. */
  #ledger: Array<LedgerLogEntry>
  /** Entry bodies by content id, for resolving the ids an envelope names. A body
   *  is the same body wherever it appears in the log, so this store is keyed. */
  #entryBodies: Map<string, HeldLedgerEntry>
  #roster: RosterState

  constructor(params: GroupHandleParams) {
    this.#state = params.state
    this.#credential = params.credential
    this.#context = params.context
    this.#rootCapability = params.rootCapability
    this.#cache = params.cache
    this.#resolver = params.resolver
    this.#commitPolicy = params.commitPolicy
    this.#resolveLedgerEntries = params.resolveLedgerEntries
    this.#onLedgerEntries = params.onLedgerEntries
    // Seed the control state from the genesis anchor baked into the group's own
    // GroupContext. The anchor survives every epoch, so reading it here makes the
    // constructor the single choke that no anchorless handle can slip through: an
    // absent anchor fails closed rather than installing a permissive roster.
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

  get rootCapability(): string {
    return this.#rootCapability
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

  /** The commit policy enforced by processMessage/decrypt, if any. Carried
   *  onto handles derived from this one (commitInvite/removeMember). */
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

  /** The ordered signed tokens this handle holds, including repeats — the ledger's
   *  canonical persistent and wire form, and the list the authenticated head folds
   *  over. Feeds createInvite, restoreGroup, and host persistence. The verified
   *  entries are a derived cache with no export form: the only way into a ledger is
   *  applyLedgerEntries, which re-verifies. */
  get ledgerTokens(): Array<string> {
    return this.#ledger.map(({ token }) => token)
  }

  /** The control roster folded from the anchor and every applied ledger entry. */
  get roster(): RosterState {
    return this.#roster
  }

  /**
   * Verify signed ledger tokens, append the valid ones to the log in the order
   * given, and refold the roster. Tokens that fail verification or whose groupID
   * does not match the group are dropped (defensive — this is the low-level apply
   * primitive; the commit pre-pass does the strict admin-issuer enforcement).
   * Every token is re-verified on the way in: no entry enters a ledger unverified,
   * whatever the import path.
   *
   * A token the log already holds is appended again rather than skipped. The log
   * is an ordered record of what each commit enacted, not a set of claims, and a
   * repeat is the only way to express a demotion back to a previously-held role.
   * Nothing replays a commit into it: MLS applies each commit exactly once,
   * restoreGroup replays a token list once, and processWelcome folds an invite once.
   */
  async applyLedgerEntries(tokens: Array<string>): Promise<void> {
    for (const token of tokens) {
      const verified = await verifyLedgerEntry(token)
      if (verified == null || verified.entry.groupID !== this.groupID) continue
      const entryID = ledgerEntryDigest(token)
      this.#ledger.push({ entryID, token, verified })
      this.#entryBodies.set(entryID, { token, verified })
    }
    this.#roster = foldLedgerRoster(this.#ledger, this.#anchor, this.groupID)
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
   * Enumerate the group's current members from the ratchet tree, in ascending
   * leaf-index order. Leaves whose credential identity fails to parse are skipped
   * (same tolerance as findMemberLeafIndex). Reflects the handle's current #state
   * — call before and after processMessage to diff a commit's membership change.
   */
  listMembers(): Array<GroupMember> {
    return [...this.#iterateMembers()]
  }

  /**
   * Encrypt an application message for the group.
   */
  async encrypt(plaintext: Uint8Array): Promise<{ message: unknown; consumed: Array<Uint8Array> }> {
    const { newState, message, consumed } = await createApplicationMessage({
      context: this.#context,
      state: this.#state,
      message: plaintext,
    })
    this.#state = newState
    return { message, consumed }
  }

  /**
   * The async pre-pass feeding the synchronous ts-mls commit callback. Both
   * decrypt and processMessage run this before mlsProcessMessage, since either
   * may receive a commit. For anything that is not a PrivateMessage commit
   * (application message, proposal, PublicMessage, pre-decoded non-frame) it does
   * exactly what the code did before this step — resolve the caller policy, wrap
   * it for the rejected-proposal capture, and apply nothing on accept.
   *
   * For a PrivateMessage commit it decodes the control envelope, resolves and
   * verifies the entry bodies the envelope names, folds a candidate roster off
   * the pre-commit state, and precomputes the pure inputs the sync callback
   * reads. The returned callback is a pure lookup over that precomputed state:
   * a decode/fold failure is a hard reject; otherwise a caller policy wins the
   * permission decision, and with no caller policy the anchored default policy
   * runs. Missing entry bodies with no resolver throw MissingLedgerEntriesError
   * here — before mlsProcessMessage — so the handle stays at its pre-commit epoch.
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
    if (commit == null) {
      // Not a PrivateMessage commit — preserve the pre-envelope behaviour exactly.
      return { callback: wrapCommitPolicy(callerPolicy, capture), capture, applyOnAccept: () => {} }
    }

    let precomputedReject = false
    let candidateRoster: RosterState = this.#roster
    let surfaced: Array<VerifiedLedgerEntry> = []
    let acceptedEntries: Array<LedgerLogEntry> = []
    let envelopeIDs: Array<string> = []

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

    // Precompute the pure sync inputs off the pre-commit ratchet tree.
    const leafToDID = new Map<number, string>()
    for (const member of this.#iterateMembers()) {
      leafToDID.set(member.leafIndex, member.id)
    }
    const didOfLeaf = (leafIndex: number): string | undefined => leafToDID.get(leafIndex)
    const anchorExt = readGroupAnchorExtension(this)
    const anchorExtensionData =
      anchorExt != null && anchorExt.extensionData instanceof Uint8Array
        ? anchorExt.extensionData
        : new Uint8Array()
    // The head this commit must install: the pre-commit head extended by the
    // envelope's ids, in envelope order. An unreadable head yields bytes no real
    // extension can equal, so such a group can install no head and enact nothing.
    const headExt = readLedgerHeadExtension(this)
    const currentHead =
      headExt != null && headExt.extensionData instanceof Uint8Array
        ? decodeLedgerHead(headExt.extensionData)
        : null
    const expectedHeadExtensionData =
      currentHead == null
        ? new Uint8Array()
        : encodeLedgerHead(extendHead(currentHead.head, envelopeIDs))
    const commitEnactsEntries = envelopeIDs.length > 0
    const baseRoster = this.#roster

    const combined: IncomingMessageCallback = (incoming) => {
      // A decode/fold failure is a hard reject even under a caller policy: the
      // ledger the commit depends on is unresolvable or malformed.
      if (precomputedReject) return 'reject'
      if (callerPolicy != null) return callerPolicy(incoming)
      return defaultCommitPolicy(incoming, {
        baseRoster,
        candidateRoster,
        didOfLeaf,
        anchorExtensionData,
        expectedHeadExtensionData,
        commitEnactsEntries,
        externalCommitDID: undefined,
      })
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
   * Decrypt an application message from the group.
   *
   * Accepts either wire-form bytes (framed MLSMessage `Uint8Array`) or a
   * pre-decoded ts-mls message object. The param type widens to `unknown`
   * because `Uint8Array | unknown` collapses to `unknown` in TypeScript; the
   * runtime `instanceof` check selects the decode path. Note: `encrypt`
   * currently emits objects, so the bytes path is for symmetry with
   * processMessage and future wire-form application messages.
   */
  async decrypt(
    message: Uint8Array | unknown,
    opts?: { commitPolicy?: IncomingMessageCallback },
  ): Promise<Uint8Array> {
    let decoded: unknown = message
    if (message instanceof Uint8Array) {
      const parsed = decode(mlsMessageDecoder, message)
      if (parsed == null) {
        throw new Error('decrypt: failed to decode MLSMessage')
      }
      decoded = parsed
    }
    const { callback, capture, applyOnAccept } = await this.#prepareCommitPipeline(decoded, opts)
    const result = await mlsProcessMessage({
      context: this.#context,
      state: this.#state,
      message: decoded as Parameters<typeof mlsProcessMessage>[0]['message'],
      ...(callback != null && { callback }),
    })
    if (result.kind === 'applicationMessage') {
      this.#state = result.newState
      return result.message
    }
    // On reject, ts-mls returns the pre-commit state, so the handle stays put.
    this.#state = result.newState
    if (result.kind === 'newState' && result.actionTaken === 'reject') {
      throw new CommitRejectedError(
        capture.rejected?.proposals ?? [],
        capture.rejected?.senderLeafIndex,
      )
    }
    // An accepted commit reaching decrypt still advances the group (as before);
    // apply its control-ledger effects too before reporting the type mismatch.
    applyOnAccept()
    throw new Error('Expected application message but received handshake message')
  }

  /**
   * Process a received MLS message (Commit, Proposal, or application).
   *
   * Accepts either wire-form bytes (the preferred input — framed MLSMessage
   * `Uint8Array`, e.g. from commitInvite/removeMember) or a pre-decoded ts-mls
   * message object (legacy path). The param type widens to `unknown` because
   * `Uint8Array | unknown` collapses to `unknown` in TypeScript; the runtime
   * `instanceof` check selects the decode path.
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
    const { callback, capture, applyOnAccept } = await this.#prepareCommitPipeline(decoded, opts)
    const result = await mlsProcessMessage({
      context: this.#context,
      state: this.#state,
      message: decoded as Parameters<typeof mlsProcessMessage>[0]['message'],
      ...(callback != null && { callback }),
    })
    // On reject, ts-mls returns the pre-commit state, so the handle stays put.
    this.#state = result.newState
    if (result.kind === 'newState' && result.actionTaken === 'reject') {
      throw new CommitRejectedError(
        capture.rejected?.proposals ?? [],
        capture.rejected?.senderLeafIndex,
      )
    }
    if (result.kind === 'applicationMessage') {
      return result.message
    }
    // Accepted handshake (commit or proposal): merge the commit's ledger entries,
    // adopt the folded roster, and surface its notarized entries. A no-op for a
    // non-envelope commit or a standalone proposal.
    applyOnAccept()
    return null
  }
}

// ---------------------------------------------------------------------------
// Lifecycle functions
// ---------------------------------------------------------------------------

/**
 * Build the leaf-node capabilities for a member joining or creating a group.
 * RFC 9420 requires a member's leaf to advertise every non-default GroupContext
 * extension type the group uses; we derive that set from the group's extensions
 * so it cannot desync. This applies equally to a creator (extensions from the
 * group being created) and to an external rejoiner (extensions from the
 * GroupInfo it resyncs against) — a rejoining leaf that advertises only the
 * defaults is rejected by ts-mls with "client does not support every extension
 * in the GroupContext". An explicit `override` (GroupOptions.capabilities) wins
 * verbatim.
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

/**
 * Create a new MLS group. The identity becomes the sole member and admin.
 */
export async function createGroup(
  identity: OwnIdentity,
  groupID: string,
  options?: GroupOptions,
): Promise<CreateGroupResult> {
  const cache = options?.cache ?? createInMemoryDIDCache()
  const context = await resolveMlsContext(options)

  // Every group is anchored at creation: the creator is the epoch-0 admin, and
  // the ledger head starts at genesis. A caller-supplied anchor (e.g. one
  // carrying an `app` payload) is left untouched — the caller owns its contents.
  const extensions = [...(options?.extensions ?? [])]
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
  const [state, rootCap] = await Promise.all([
    statePromise,
    createGroupCapability(identity, groupID),
  ])

  const rootCapability = stringifyToken(rootCap)
  const credential: MemberCredential = {
    id: identity.id,
    capabilityChain: [rootCapability],
    capability: rootCap,
    permission: 'admin',
    groupID,
  }
  const group = new GroupHandle({
    state,
    credential,
    context,
    rootCapability,
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
  rootCapability: string
  /** Signed ledger tokens the host persisted, replayed to rebuild the roster. */
  ledgerEntries?: Array<string>
  options?: GroupOptions
}

export async function restoreGroup(params: RestoreGroupParams): Promise<GroupHandle> {
  const cache = params.options?.cache ?? createInMemoryDIDCache()
  // Construction reseeds `{creator: 'admin'}` from the anchor in the restored
  // state — an anchorless state throws here, the same fail-closed guard.
  const group = new GroupHandle({
    state: params.state,
    credential: params.credential,
    context: await resolveMlsContext(params.options),
    rootCapability: params.rootCapability,
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
 * Create an invite for a new member.
 * Does NOT add them to the group — call commitInvite with their key package to do that.
 *
 * Only an admin may invite: a role entry from a non-admin issuer is dropped by every
 * receiver's fold, so refusing here turns a silent downstream commit rejection into a
 * local error.
 */
export async function createInvite(params: CreateInviteParams): Promise<CreateInviteResult> {
  const { group, identity, recipientDID, permission } = params
  if (group.roster.roles.get(normalizeDID(identity.id)) !== 'admin') {
    throw new Error('createInvite: the inviter must be an admin in the group roster')
  }

  const memberCap = await delegateGroupMembership({
    identity,
    groupID: group.groupID,
    recipientDID,
    permission,
    parentCapability: group.rootCapability,
  })
  const memberCapStr = stringifyToken(memberCap)

  // The role entry naming the invitee. Its issuer is the inviter (authenticated by
  // the token signature) and its value is the permission the capability grants, so
  // the two agree by construction.
  const roleToken = await signLedgerEntry(identity, {
    type: ROLE_ENTRY_TYPE,
    groupID: group.groupID,
    subject: recipientDID,
    value: permission,
  })

  const invite: Invite = {
    groupID: group.groupID,
    capabilityToken: memberCapStr,
    capabilityChain: [group.rootCapability, memberCapStr],
    permission,
    inviterID: identity.id,
    // The whole log, the new role entry last: a joiner handed only its own entry
    // would never learn of a role change made before its invite, and would reject
    // every commit by an admin promoted in the meantime — a permanent fork nothing
    // in the protocol re-sends. The new entry must fold after the history it depends
    // on, hence last. Re-granting a role the log already carries appends that entry a
    // second time, which is a legal re-enactment, not a duplicate to elide. The joiner
    // still folds from the anchor, so the inviter cannot promote anyone by padding
    // this list.
    ledgerEntries: [...group.ledgerTokens, roleToken],
  }

  return { invite }
}

/**
 * The GroupContext extension list a commit installs when it enacts `entryIDs`: the
 * group's current list with only the ledger-head extension replaced by the head
 * extended by those ids, in envelope order. Every other extension — the anchor above
 * all — is the verbatim object out of the current GroupContext, never a re-encode of
 * a decoded value, because the receiving policy byte-compares the anchor.
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

/**
 * The one place a commit carrying control-ledger entries is built: `commitInvite`,
 * `removeMember`, and `commitLedgerEntries` all route through it, so the envelope and
 * the head can never drift apart.
 *
 * `enacted` is exactly what this commit enacts — the caller decides, and the caller is
 * the only one that can: entries are enacted by *position* in the log, so an entry whose
 * content the log already carries is a legitimate re-enactment (a demotion back to a
 * previously-held role is precisely that) and must not be filtered out by content.
 *
 * The envelope names only what this commit enacts, never the whole history: replaying the
 * history would re-judge every past entry against the present roster, and a grant issued
 * by a since-demoted admin would read as coming from a non-admin, freezing every group
 * that ever rotated its admins.
 *
 * When `enacted` is non-empty the commit also carries a group-context-extensions proposal
 * advancing the ledger head by exactly those ids, in envelope order. An empty list moves
 * no head and carries no envelope.
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

  // Fold the entries exactly as every receiver will, and refuse to author a commit the
  // group would reject. Without this the write path fails *open*: the committer advances
  // its own log and head while every receiver rejects the commit, forking itself off the
  // group. Being an admin is not enough — an entry's own issuer must still hold authority
  // at the position it lands in, so a token signed by a since-demoted admin is dead paper
  // no matter who commits it.
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
  const proposals = [...extraProposals]
  if (entryIDs.length > 0) {
    proposals.push({
      proposalType: defaultProposalTypes.group_context_extensions,
      groupContextExtensions: { extensions: extensionsWithHead(group, entryIDs) },
    })
  }

  return await createCommit({
    context: group.context,
    state: group.state,
    extraProposals: proposals,
    ...(ratchetTreeExtension && { ratchetTreeExtension: true }),
    ...(entryIDs.length > 0 && {
      authenticatedData: encodeControlEnvelope({ v: 1, entries: entryIDs }),
    }),
  })
}

/**
 * The entries an invite adds beyond the committer's own log: everything past the log's
 * length. Positional, never by content — a re-granted role is the same token the log
 * already carries at an earlier position, and narrowing by content would drop the very
 * entry the invite exists to enact.
 *
 * Positional narrowing is only sound when the invite's list *begins with* the
 * committer's log, so that is asserted rather than assumed: an invite built against a
 * different history would mis-slice, and the commit would move the head by ids that do
 * not follow the group's own — corrupting the chain for every receiver.
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
    rootCapability: group.rootCapability,
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
 * The admin write path for the control ledger: a commit that carries no membership
 * proposal, only the entries it enacts and the head move that covers them. This is how
 * an admin promotes, demotes, or writes any other entry type — an entry that never
 * rides a commit is invisible to the head, and a joiner recomputing the head would
 * read the group's history as doctored.
 *
 * Enacts exactly `tokens`, at the end of the log — including one whose content the log
 * already carries, which is how an admin is demoted back to a role they previously held.
 * Rejects an empty `tokens` list: a commit that enacts nothing has no reason to be
 * authored here.
 */
export async function commitLedgerEntries(
  group: GroupHandle,
  tokens: Array<string>,
): Promise<CommitLedgerEntriesResult> {
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
}

export type CommitInviteResult = {
  /** Framed MLSMessage bytes. Broadcast to existing members via the DS. */
  commitMessage: Uint8Array
  /** Framed MLSMessage(Welcome) bytes. Delivered to the new member. */
  welcomeMessage: Uint8Array
  newGroup: GroupHandle
  /** Post-commit epoch the group is now at (== newGroup.epoch). NOTE: this is
   *  NOT the epoch carried in the commit's wire header — a commit is framed at
   *  the sender's pre-commit epoch (== epoch - 1n), which is what receivers
   *  compare against their own handle.epoch for ordering (see readMessageEpoch). */
  epoch: bigint
}

/**
 * Commit an invite by adding the invitee's key package to the group.
 * Produces an MLS Commit + Welcome.
 *
 * The invite's ledger entries are enacted by this commit: their content ids ride in
 * the commit's control envelope and the commit advances the ledger head by exactly
 * those ids, so every receiver folds the invitee's role entry into its roster as it
 * applies the Add. The envelope carries ids, not bodies — a receiver that holds
 * neither the entry nor a `resolveLedgerEntries` resolver throws
 * MissingLedgerEntriesError on this commit.
 *
 * The invite itself carries the group's whole history — a joiner has nothing to fold
 * it onto — but only the entries it adds beyond that history ride the commit; see
 * {@link entriesAddedByInvite} and {@link commitWithEntries}.
 */
export async function commitInvite(
  group: GroupHandle,
  keyPackage: KeyPackage,
  invite: Invite,
): Promise<CommitInviteResult> {
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

  // Validate the invite's capability chain before trusting it.
  // validateGroupCapability internally calls verifyToken with cache/resolver and returns the
  // verified token — reuse it instead of calling verifyToken a second time without cache/resolver.
  const { validateGroupCapability } = await import('./capability.js')
  const capToken = await validateGroupCapability({
    tokenData: invite.capabilityToken,
    groupID: invite.groupID,
    delegationChain:
      invite.capabilityChain.length > 1 ? invite.capabilityChain.slice(0, -1) : undefined,
    options: { cache, resolver: options?.resolver },
  })

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
    capabilityChain: invite.capabilityChain,
    capability: capToken as MemberCredential['capability'],
    permission: invite.permission,
    groupID: invite.groupID,
  }

  const group = new GroupHandle({
    state,
    credential,
    context,
    rootCapability:
      invite.capabilityChain[0] ??
      (() => {
        throw new Error('Invalid invite: capability chain must not be empty')
      })(),
    cache,
    resolver: options?.resolver,
    commitPolicy: options?.commitPolicy,
    resolveLedgerEntries: options?.resolveLedgerEntries,
    onLedgerEntries: options?.onLedgerEntries,
  })
  // Every ledger entry reaches the group inside a commit that extends the head by its
  // id, so the head authenticated in the joined GroupContext is the fold from genesis
  // over the group's entries, in order. Recompute it over the entries the inviter
  // supplied: an omitted, reordered, or truncated list cannot reproduce it. Checked
  // before folding, so an incomplete ledger never reaches the roster.
  const authenticated = readLedgerHead(group)
  if (authenticated == null) {
    throw new Error('processWelcome: the group has no ledger head extension')
  }
  assertHeadMatches(
    authenticated.head,
    computeHead(invite.groupID, invite.ledgerEntries.map(ledgerEntryDigest)),
  )

  // Fold the invite's entries: the roster is seeded from the anchor, and the fold
  // grants authority only to an admin-so-far, so a member-signed entry cannot
  // promote anyone even though applyLedgerEntries itself is the permissive primitive.
  await group.applyLedgerEntries(invite.ledgerEntries)

  return { group, credential }
}

export type RemoveMemberResult = {
  /** Framed MLSMessage bytes. Broadcast to existing members via the DS. */
  commitMessage: Uint8Array
  newGroup: GroupHandle
  /** Post-commit epoch the group is now at (== newGroup.epoch). NOTE: this is
   *  NOT the epoch carried in the commit's wire header — a commit is framed at
   *  the sender's pre-commit epoch (== epoch - 1n), which is what receivers
   *  compare against their own handle.epoch for ordering (see readMessageEpoch). */
  epoch: bigint
}

/**
 * Remove a member from the group. Advances the epoch and rotates keys.
 *
 * Removal must demote: a receiver rejects a Remove whose target is still `admin` in
 * the roster the commit's entries fold to. So removing an admin means riding the
 * demotion entry on the same commit — pass it as `ledgerEntries`. The entry is signed
 * by the caller, who holds the identity; this only carries it.
 */
export async function removeMember(
  group: GroupHandle,
  leafIndex: number,
  ledgerEntries?: Array<string>,
): Promise<RemoveMemberResult> {
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
}

/**
 * Read the MLS epoch from a framed handshake/application message's cleartext
 * header, without decrypting. Advisory only — the header epoch is unauthenticated;
 * use it to drop stale / buffer future messages before the authenticated
 * processMessage. Returns undefined for non-message or undecodable bytes.
 *
 * Total by contract: this is a safe pre-filter over bytes arriving from an
 * untrusted Delivery Service, so it never throws. ts-mls `decode` throws (e.g.
 * CodecError on input larger than its max size) rather than returning undefined
 * for some malformed inputs; that is caught and treated as "not a message".
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
 * Non-destructively inspect a framed MLSMessage(GroupInfo) — read its epoch and
 * ratchet-tree hash without joining or mutating any state. Used to confirm an
 * external-resync Commit was canonically accepted: compare the returned
 * (epoch, treeHash) for equality against the rejoiner's own post-commit state
 * (GroupHandle.epoch / GroupHandle.treeHash). Equal ⟹ this device's Commit won
 * the epoch; unequal ⟹ another Commit won and the rejoin must retry.
 *
 * Structural read only: it does NOT verify the GroupInfo signature. The caller
 * is expected to have obtained the bytes over the group's authorized channel.
 * Unlike readMessageEpoch (a total pre-filter over untrusted DS bytes), this
 * THROWS on malformed input — a malformed already-trusted GroupInfo is a
 * programming error, not expected traffic.
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

/**
 * Generate a key package for joining groups.
 */
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

  const rootCapability = credential.capabilityChain[0]
  if (rootCapability == null) {
    throw new Error('Invalid credential: capability chain must not be empty')
  }

  // Guard: resync requires the rejoining identity to match the leaf being
  // replaced. If `identity.id` does not match `credential.id`, ts-mls's
  // findIndex returns -1 and the downstream `removeLeafNodeMutable(tree, -1)`
  // call enters an unbounded loop (ts-mls bug; the no-match branch is not
  // guarded). Reject early with a clear error.
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

  // The rejoining leaf must advertise every GroupContext extension the group
  // uses (e.g. a genesis-anchor extension), or ts-mls rejects the external
  // join with "client does not support every extension in the GroupContext".
  // Derive them from the GroupInfo being resynced against, honoring an explicit
  // capabilities override.
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
    rootCapability,
    cache,
    resolver: options?.resolver,
    commitPolicy: options?.commitPolicy,
    resolveLedgerEntries: options?.resolveLedgerEntries,
    onLedgerEntries: options?.onLedgerEntries,
  })

  return { commitMessage, group }
}
