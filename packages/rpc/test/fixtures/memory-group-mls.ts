import { encodeMultibase, normalizeDID } from '@kokuin/token'
import { x25519 } from '@noble/curves/ed25519.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { fromB64U, fromUTF, toB64U, toUTF } from '@sozai/codec'

import type { AnchorStore } from '../../src/anchor.js'
import { digestAppliedCommit } from '../../src/classify.js'
import { encodeCommitFrame } from '../../src/commit-frame.js'
import type { SaveControlBuild } from '../../src/control/build.js'
import { controlSafetyHeld } from '../../src/control/safety.js'
import type { ControlEvidenceSnapshot } from '../../src/control/search.js'
import type {
  AdoptionExpected,
  AdoptionWrite,
  AdoptionWriteFactory,
  ControlAdoptionPort,
  ControlStore,
  EpochIdentity,
  GroupKey,
} from '../../src/control/types.js'
import type {
  CommitContext,
  CommitHeader,
  GroupMLS,
  OpenedRecoveryVerdict,
  PendingRecovery,
  RecoveryVerdict,
  RosterEntry,
} from '../../src/crypto.js'
import type { LogPosition } from '../../src/cursor.js'
import {
  ControlWriteNotCommittedError,
  GroupSafetyHeldError,
  StorageOutcomeUnknownError,
} from '../../src/errors.js'
import { encodeHandshakeFrame, HANDSHAKE_KIND } from '../../src/handshake.js'
import {
  type CapturedPendingRecovery,
  type CapturedRecoveryPort,
  copyRecoverySource,
  copyRecoveryTargetCapture,
  type RecoverySource,
  type ResyncProof,
  validateCaptureHead,
} from '../../src/recovery-types.js'
import { createMemoryHostDatabase, type MemoryHostDatabase } from './host-db.js'

export type MemoryGroupMLS = GroupMLS & {
  database(): MemoryHostDatabase
  persistInitialState(): Promise<void>
  acceptsCommitter(did: string): boolean
  credentialDID(): string | undefined
  readEvidence(): Promise<ControlEvidenceSnapshot>
  saveBuilt: SaveControlBuild
  control: () => ControlStore
  anchorStore: () => AnchorStore
  serializeState: () => Uint8Array
  restoreState: (state: Uint8Array) => void
  authenticator: () => Uint8Array
  memberSlots: () => Array<[number, string]>
  setReceiveState: (state: Uint8Array) => void
  setReceiveHistory: (history: Array<[number, { identity: string; state: Uint8Array }]>) => void
  receiveHistory: () => Array<[number, { identity: string; state: Uint8Array }]>
  carryReceiveProgress: (candidate: MemoryGroupMLS) => void
  adoptOperation: (
    blob: Uint8Array,
    expected: Parameters<ControlAdoptionPort['adopt']>[1],
    write: AdoptionWrite,
  ) => Promise<'installed' | 'noop' | 'moved'>
  epoch: () => number
  /** Commits APPLIED — the ones this member was at the epoch to apply. */
  commits: () => number
  /** Commits the lane handed to `processCommit`, applied or not. A frame read as a
   *  commit and found inapplicable is counted here and not there; a frame dropped as
   *  malformed reaches neither. */
  seen: () => number
  lastSender: () => string | undefined
  /** The content ids this member's ledger has enacted, in order. */
  ledgerIDs: () => Array<string>
  ledgerTokens: () => Array<string>
  authenticatedLedgerHead: () => string
  applyLedgerEntries: (tokens: Array<string>) => Promise<void>
  bootstrapLedger: (tokens: Array<string>, persist?: () => Promise<void> | void) => Promise<void>
  /**
   * The ledger folded, last-write-wins by position: `subject=value` tokens reduced in the
   * order the ledger holds them. It is the whole reason re-enactment is filtered — the fold
   * has no dedup, so an entry appended a second time WINS, whatever it said the first time.
   */
  fold: () => Map<string, string>
  /** The members this handle's ratchet tree holds a leaf for, one entry per leaf. */
  leaves: () => Array<string>
  /**
   * Produce a Commit at this member's CURRENT epoch, enacting these signed tokens and the roster
   * op in `options`. Like the real thing it is non-mutating: the group advances when the commit is
   * adopted, so the bodies can still be sealed under the epoch every receiver is at.
   *
   * The Commit carries its committer, as a real one does — the author is authenticated by
   * the Commit's own signature, not by whoever handed it to the hub. It carries its Add/Remove
   * the same way, and for the same reason: a roster change is a property of the commit every
   * member reads out of it, not of the author's own bookkeeping — the author adopting the
   * post-commit handle and a receiver applying the frame must land on the same roster, or the two
   * halves of one eviction disagree about who is in the group.
   */
  buildCommit: (
    tokens?: Array<string>,
    options?: { adds?: Array<string>; removes?: Array<string> },
  ) => Uint8Array
  /** Adopt a Commit this member produced: enact its entries and advance. */
  adopt: (commit: Uint8Array) => void | Promise<void>
  /**
   * Drop a member's leaf. The double has no Remove proposal, so this stands in for the one
   * effect a remove has on the tree — and it is what ADOPTING the post-commit handle of a
   * remove does, which is the only way a leaf ever goes away. A remove whose commit never
   * landed must leave the leaf exactly where it is: an admin told the eviction failed, over
   * a handle the member is already gone from, has been lied to twice.
   */
  evict: (did: string) => void
  /**
   * Make the next rejoin's `onAccepted` throw: the process dies in `recover()`'s own
   * acceptance window, after the hub took the external commit and before this handle
   * adopted it. Deliberately unjournalled, so the orphan is repaired by re-recovery.
   */
  failNextRecoveryAdopt: () => void
}

export type MemoryControlJournal = {
  source: AdoptionExpected
  sourceState: Uint8Array
  candidate: Uint8Array
}
export function encodeMemoryControlJournal(value: MemoryControlJournal): Uint8Array {
  return fromUTF(
    JSON.stringify({
      source: {
        ...value.source,
        identity:
          value.source.identity === null
            ? null
            : {
                ...value.source.identity,
                authenticator: toB64U(value.source.identity.authenticator),
              },
      },
      sourceState: toB64U(value.sourceState),
      candidate: toB64U(value.candidate),
    }),
  )
}
export function decodeMemoryControlJournal(blob: Uint8Array): MemoryControlJournal {
  const value = JSON.parse(toUTF(blob)) as {
    source: AdoptionExpected & { identity: EpochIdentity & { authenticator: string } }
    sourceState: string
    candidate: string
  }
  return {
    source: {
      ...value.source,
      identity: {
        ...value.source.identity,
        authenticator: fromB64U(value.source.identity.authenticator),
      },
    },
    sourceState: fromB64U(value.sourceState),
    candidate: fromB64U(value.candidate),
  }
}

export type MemoryRecoveryBinding = {
  id: string
  prefix: Array<unknown>
  capability: string
  holderGrant?: string
}
export type MemoryGroupMLSOptions = {
  capturedRecovery?: {
    target: { targetID: string; topicID: string }
    readSource(): Promise<RecoverySource>
    accept(
      pending: PendingRecovery,
      expected: RecoverySource,
      proof: ResyncProof,
      write: AdoptionWriteFactory,
    ): Promise<void>
  }
  storageID?: string
  hostDB?: MemoryHostDatabase
  binding?: MemoryRecoveryBinding
  recoveryBinding?: () => Promise<MemoryRecoveryBinding | null>
  groupID?: string
  recoverySecret?: Uint8Array
  epoch?: number
  /** This member's DID — the committer stamped into the Commits it builds, and the modelled
   *  recipient of GroupInfo sealed to its leaf. */
  localDID?: string
  /** Signed tokens whose BODIES this member holds — a joiner's Welcome carries them, and a
   *  member that resolved them from a commit frame keeps them. Holding a body is not the
   *  same as having enacted it: the ledger is what a commit enacted, and it starts empty. */
  bodies?: Array<string>
  ledgerEntries?: Array<string>
  entryDigest?: (token: string) => string
  computeLedgerHead?: (ids: Array<string>) => string
  validateLedgerEntries?: (tokens: Array<string>, previous: Array<string> | null) => Promise<void>
  /** The members this handle's tree holds a leaf for. Defaults to this member alone. */
  members?: Array<string>
  memberSlots?: Array<[number, string]>
  retainKeysForEpochs?: number
  /**
   * The group's commit policy, modelled: a Commit whose committer this refuses is
   * well-formed and deliberately NOT applied — a removed member's commit is exactly that.
   * A refusal is a `{ advanced: false }`, never a throw. Defaults to accepting every
   * committer.
   */
  acceptsCommitter?: (committerDID: string) => boolean
  /**
   * What this responder actually SERVES to a ledger gather, given the ledger it holds.
   * Defaults to the whole of it, in order.
   *
   * A responder that withholds, reorders or truncates an entry is serving a list in which
   * every token is perfectly well signed — which is exactly what a signature does not protect
   * and what the requester's head check does. A double that could only serve the truth could
   * not exercise the one check standing between a bootstrap and a lying member.
   */
  serveLedger?: (ledger: Array<string>) => Array<string>
  /** Called whenever the modelled epoch advances (e.g. to keep a GroupCrypto in step). */
  onAdvance?: (epoch: number) => void
}

/** The port raises this when a Commit names entry bodies it cannot resolve from the frame the
 *  commit rides in. The lane treats it as poison: it steps over the frame, advances the cursor
 *  past it, and never reads it again. */
export class MissingLedgerEntriesError extends Error {
  ids: Array<string>
  constructor(ids: Array<string>) {
    super(`missing ledger entries: ${ids.join(', ')}`)
    this.name = 'MissingLedgerEntriesError'
    this.ids = ids
  }
}

/**
 * A gathered ledger whose recomputed head does not match the one this handle's own group
 * state attests to. The responder withheld, reordered or truncated an entry — every token
 * in it can be perfectly well signed, which is exactly what the head chain catches and a
 * signature does not.
 */
export class LedgerIncompleteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerIncompleteError'
  }
}

/** The content id of a signed token: its digest. Content-addressing is what binds an
 *  untrusted body to the id a Commit names. */
export function memoryEntryID(token: string): string {
  return toB64U(sha256(fromUTF(token)))
}

/**
 * The ledger head: a chain digest over the entry ids, in order. Folded from a genesis
 * value, so a list that reproduces a group's head IS that group's whole ledger, in order —
 * which is what lets a bootstrapping peer check an untrusted responder's answer against the
 * head its own group state carries, and what makes an omitted or transposed entry detectable
 * when every signature in the list verifies.
 */
export function memoryLedgerHead(entryIDs: Array<string>): string {
  let head = fromUTF('kumiai/memory-ledger-head/v1')
  for (const id of entryIDs) head = sha256(new Uint8Array([...head, ...fromUTF(id)]))
  return toB64U(head)
}

type MemoryCommit = {
  epoch: number
  committerDID: string
  entryIDs: Array<string>
  /**
   * The ledger head AFTER this commit — the committer's own fold, carried in the commit and
   * authenticated with it, exactly as a real one carries it in the GroupContext extension it
   * proposes. A receiver TAKES it rather than recomputing it, which is why a receiver whose
   * ledger is incomplete stays visibly incomplete instead of quietly re-anchoring on its own
   * truncated fold.
   *
   * Absent on a commit that enacts nothing: it proposes no head extension, so the head it
   * found is the head it leaves.
   */
  head?: string
  /** An external commit: the committer is rejoining, and its leaf replaces any it still had. */
  external?: boolean
  /**
   * Who the key that SIGNED this commit belongs to, as distinct from `committerDID`, which is only
   * who the commit says authored it.
   *
   * The two are one field in a genuine commit and `encodeMemoryCommit` keeps them equal, because a
   * real committer signs with the key of the same leaf whose credential names it. They come apart
   * exactly where a real one does: a forger who observed a frame can rewrite the credential naming
   * the author, and cannot produce the signature that would match — leaving a frame whose claimed
   * author and actual signer disagree. Modelled as a field so a test can build that frame, since
   * the double has no real signature to break.
   */
  signerDID?: string
  /** Sender data remains readable, but tampered commit content cannot be processed. */
  invalidContent?: true
  missingProposal?: true
  branch?: string
  /**
   * The roster op this Commit enacts, applied to `leaves` when the commit ADVANCES this handle.
   * The real double has no MLS proposals, so this stands in for the one tree effect a Commit's
   * Add/Remove has — the effect adopting the post-commit handle would produce. A commit carrying
   * both is faithful to the Add+Remove-in-one-commit case a roster diff has to catch.
   *
   * Absent on a commit that touches no membership (a ledger enact, an update, a no-op): the
   * roster it found is the roster it leaves.
   */
  adds?: Array<string>
  removes?: Array<string>
}

/**
 * A Commit for the memory port: the epoch it was framed at, the member that authored it,
 * and the content ids of the ledger entries it enacts.
 *
 * Both the epoch and committer are modelled inside the commit. A real member commit names its
 * sender through PrivateMessage sender data sealed at the epoch, independently of content
 * validity; the hub's transport sender says nothing about authorship. `invalidContent` models
 * a ciphertext edit beyond the sender-data sample while keeping that sender readable.
 */
export function encodeMemoryCommit(
  epoch: number,
  committerDID: string,
  entryIDs: Array<string> = [],
  options: {
    head?: string
    external?: boolean
    adds?: Array<string>
    removes?: Array<string>
    /** Override the signer to forge: the commit claims `committerDID` but is signed by this. */
    signerDID?: string
    branch?: string
  } = {},
): Uint8Array {
  // A commit that enacts nothing proposes no head extension: the head it found is the head it
  // leaves. Only a committer that enacts entries folds a new one, and it folds it over its
  // WHOLE ledger — so a caller enacting entries onto a non-empty ledger must say what that
  // ledger was.
  const head = options.head ?? (entryIDs.length > 0 ? memoryLedgerHead(entryIDs) : undefined)
  const commit: MemoryCommit = {
    epoch,
    committerDID,
    entryIDs,
    ...(options.branch == null ? {} : { branch: options.branch }),
    ...(head != null ? { head } : {}),
    ...(options.external === true ? { external: true } : {}),
    // A genuine commit is signed by the member it names. Only a forger passes these apart.
    signerDID: options.signerDID ?? committerDID,
    ...(options.adds != null && options.adds.length > 0 ? { adds: options.adds } : {}),
    ...(options.removes != null && options.removes.length > 0 ? { removes: options.removes } : {}),
  }
  return fromUTF(JSON.stringify(commit))
}

export function decodeMemoryCommit(commit: Uint8Array): MemoryCommit | null {
  if (commit.length === 0) return null
  try {
    const value = JSON.parse(toUTF(commit)) as MemoryCommit
    const isDIDArray = (v: unknown): boolean =>
      Array.isArray(v) && v.every((did) => typeof did === 'string')
    if (
      !Number.isSafeInteger(value?.epoch) ||
      value.epoch < 0 ||
      (value.branch != null && typeof value.branch !== 'string') ||
      typeof value?.committerDID !== 'string' ||
      (value.head != null && typeof value.head !== 'string') ||
      (value.external != null && typeof value.external !== 'boolean') ||
      (value.signerDID != null && typeof value.signerDID !== 'string') ||
      (value.invalidContent != null && value.invalidContent !== true) ||
      (value.missingProposal != null && value.missingProposal !== true) ||
      !Array.isArray(value.entryIDs) ||
      (value.adds != null && !isDIDArray(value.adds)) ||
      (value.removes != null && !isDIDArray(value.removes))
    ) {
      return null
    }
    return value
  } catch {
    return null
  }
}

/** The sealed GroupInfo, modelled. It carries the group's epoch and its AUTHENTICATED
 *  ledger head — and no ledger, which is the whole reason bootstrap exists. */
type MemoryGroupInfo = {
  authenticator: string
  groupID: string
  to: string
  requestID: string
  epoch: number
  head: string
  members: Array<string>
  captureHead?: string | null
  signer?: string
  leafTokens?: Array<[string, string]>
  stateSignature?: string
  attestation?: string
}

const confirmationKeys = new Map<string, Uint8Array>()

/**
 * The request a peer publishes to ask the group for its state. The requester's DID and the
 * ephemeral PUBLIC key its reply must be sealed to ride inside it — modelling the signed
 * token the real port mints, whose signature covers both.
 */
type MemoryRecoveryRequest = {
  groupID: string
  requestID: string
  requesterDID: string
  ephemeralKey: string
}

/**
 * What a sealed reply answers. The two answers are NOT interchangeable, and the separation is
 * in the seal rather than in a field a reader could forget to compare: the label goes into the
 * key derivation and into the tag, so a GroupInfo does not open as a ledger even when the
 * group, the member, the request id and the ephemeral key are all the same.
 */
const SEAL_DOMAIN = {
  groupInfo: 'kumiai/memory-recovery/group-info/v1',
  ledger: 'kumiai/memory-recovery/ledger/v1',
  verdict: 'kumiai/memory-recovery/verdict/v1',
} as const

function isRecoveryVerdict(value: unknown): value is RecoveryVerdict {
  if (value == null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (
    ![v.groupID, v.requestID, v.position, v.commitDigest].every(
      (field) => typeof field === 'string' && field.length > 0,
    )
  )
    return false
  return (
    v.verdict === 'superseded' ||
    (v.verdict === 'confirmed' &&
      Number.isSafeInteger(v.epoch) &&
      (v.epoch as number) >= 0 &&
      typeof v.tag === 'string') ||
    (v.verdict === 'refused' &&
      ['binding', 'lapse', 'floor', 'policy', 'invalid'].includes(v.reason as string))
  )
}

/** Seal an arbitrary authenticated payload to exercise the receiver's shape checks. */
export function sealMemoryRecoveryVerdict(
  request: Uint8Array,
  signer: string,
  verdict: unknown,
): Uint8Array {
  const to = JSON.parse(toUTF(request)) as MemoryRecoveryRequest
  return sealToKey(
    fromB64U(to.ephemeralKey),
    sealContext(SEAL_DOMAIN.verdict, to.groupID, to.requesterDID, to.requestID),
    fromUTF(JSON.stringify({ signer, verdict })),
  )
}

/** Re-attest changed public bytes while retaining the original applied-state signature. */
export function reattestMemoryCapture(params: {
  request: Uint8Array
  requestKey: Uint8Array
  sealed: Uint8Array
  change: (info: Record<string, unknown>) => void
  recoverySecret?: Uint8Array
}): Uint8Array {
  const to = JSON.parse(toUTF(params.request)) as MemoryRecoveryRequest
  const context = sealContext(SEAL_DOMAIN.groupInfo, to.groupID, to.requesterDID, to.requestID)
  const bytes = openWithKey(params.requestKey, context, params.sealed)
  if (bytes === null) throw new Error('Cannot open captured fixture')
  const info = JSON.parse(toUTF(bytes)) as Record<string, unknown>
  delete info.attestation
  params.change(info)
  info.attestation = toB64U(
    hmac(
      sha256,
      params.recoverySecret ?? new Uint8Array(32).fill(0x33),
      fromUTF(JSON.stringify(info)),
    ),
  )
  return sealToKey(fromB64U(to.ephemeralKey), context, fromUTF(JSON.stringify(info)))
}

/** enc(32) + tag(16): the shortest well-formed sealed reply. */
const MIN_SEALED_LENGTH = 32 + 16

/** SHA-256 in counter mode: enough keystream for a payload of any length. */
function keystream(seed: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let offset = 0, counter = 0; offset < length; offset += 32, counter++) {
    const block = sha256(concatBytes(seed, fromUTF(`/${counter}`)))
    out.set(block.subarray(0, Math.min(32, length - offset)), offset)
  }
  return out
}

function xorWith(bytes: Uint8Array, pad: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) out[i] = (bytes[i] as number) ^ (pad[i] as number)
  return out
}

/**
 * The bytes a reply is bound to: the KIND of answer, its group and member, and the
 * request it answers. Bound into the key and into the tag, so a reply for another member, for
 * another request, or to another question does not open at all — it is never a field compared
 * after decryption.
 */
function sealContext(
  domain: string,
  groupID: string,
  requesterDID: string,
  requestID: string,
): Uint8Array {
  return fromUTF(JSON.stringify([domain, groupID, requesterDID, requestID]))
}

/**
 * Seal a payload to an ephemeral public key: an X25519 ECDH to a fresh keypair, a SHA-256
 * keystream over the shared secret, and a SHA-256 tag over the ciphertext. `[enc][tag][ct]`.
 *
 * NOT production cryptography — no HPKE, no AEAD (the real port uses both). But the TRAPDOOR
 * is real, and it is the one property the double has to have: everything the hub sees of a
 * request — the requester's DID, the request id, the ephemeral public key — is in this
 * function's inputs, and it still cannot derive the shared secret. A double that "sealed"
 * under something the hub could reconstruct would let a confidentiality test pass for the
 * wrong reason.
 */
function sealToKey(publicKey: Uint8Array, context: Uint8Array, payload: Uint8Array): Uint8Array {
  const secretKey = x25519.utils.randomSecretKey()
  const enc = x25519.getPublicKey(secretKey)
  const shared = x25519.getSharedSecret(secretKey, publicKey)
  const ct = xorWith(payload, keystream(concatBytes(shared, enc, context), payload.length))
  const tag = sha256(concatBytes(shared, context, ct)).subarray(0, 16)
  return concatBytes(enc, tag, ct)
}

/** Open a sealed reply, or `null` for bytes this key and context do not open. */
function openWithKey(
  privateKey: Uint8Array,
  context: Uint8Array,
  sealed: Uint8Array,
): Uint8Array | null {
  if (sealed.length < MIN_SEALED_LENGTH) return null
  const enc = sealed.slice(0, 32)
  const tag = sealed.slice(32, 48)
  const ct = sealed.slice(48)
  let shared: Uint8Array
  try {
    shared = x25519.getSharedSecret(privateKey, enc)
  } catch {
    return null // hub-injected bytes: not a reply at all
  }
  const expected = sha256(concatBytes(shared, context, ct)).subarray(0, 16)
  for (let i = 0; i < 16; i++) {
    if (tag[i] !== expected[i]) return null
  }
  return xorWith(ct, keystream(concatBytes(shared, enc, context), ct.length))
}

/**
 * In-memory {@link GroupMLS} for exercising peer orchestration WITHOUT real MLS —
 * the group-rpc analogue of `createMemoryBus`. It models an epoch counter and a
 * control ledger: a Commit is framed at an epoch and names the entries it enacts,
 * a member applies only Commits framed at the epoch it is at, and the bodies of the
 * entries it does not hold are resolved from the commit's own frame. GroupInfo carries
 * the epoch and the authenticated ledger head — and no entries, so a rejoined handle's
 * ledger is EMPTY and its roster is reset until bootstrap runs. The recovery secret is
 * fixed for the instance's life (epoch-independent). NOT real cryptography — a test double
 * for wiring, not a production implementation (a real port adapts a live MLS group).
 */
export function createMemoryGroupMLS(options: MemoryGroupMLSOptions = {}): MemoryGroupMLS {
  const entryDigest = options.entryDigest ?? memoryEntryID
  const computeLedgerHead = options.computeLedgerHead ?? memoryLedgerHead
  const recoverySecret = options.recoverySecret ?? new Uint8Array(32).fill(0x33)
  const localDID = options.localDID
  const acceptsCommitter = options.acceptsCommitter ?? (() => true)
  const serveLedger = options.serveLedger ?? ((ledger: Array<string>) => ledger)
  let recoveryAuthenticator: string | undefined
  let epochIdentity: string | undefined
  let receiveState: string | undefined
  let receiveHistory = new Map<number, { identity: string; state: string }>()
  const retainKeysForEpochs = options.retainKeysForEpochs ?? 4
  let epoch = options.epoch ?? 0
  let commits = 0
  let seen = 0
  let lastSender: string | undefined
  /** The entries this handle has ENACTED, in order. A rejoined handle holds none. */
  let ledger: Array<string> = (options.ledgerEntries ?? []).map(entryDigest)
  /** The head this handle's group state attests to. Genesis until a commit moves it. */
  let ledgerHead = computeLedgerHead(ledger)
  /** Entry bodies by content id — what this member can serve, and what it can enact. */
  let bodies = new Map<string, string>()
  for (const token of [...(options.bodies ?? []), ...(options.ledgerEntries ?? [])])
    bodies.set(entryDigest(token), token)
  // Hole-preserving leaf-slot model, keyed by ratchet-tree leaf index. Real ts-mls blanks a
  // removed leaf and fills the leftmost blank on add; a compact array cannot, and would hand out
  // position-indices the real port never does (more permissive — forbidden for a double).
  let slots = new Map<number, string>()
  ;(options.members ?? (localDID != null ? [localDID] : [])).forEach((did, i) => {
    slots.set(i, did)
  })

  if (options.memberSlots != null) slots = new Map(options.memberSlots)

  const lowestFreeSlot = (target = slots): number => {
    let i = 0
    while (target.has(i)) i++
    return i
  }
  const slotAdd = (did: string, target = slots): void => {
    // The double never adds a DID it already holds (matches how buildCommit models adds).
    if (![...target.values()].includes(did)) target.set(lowestFreeSlot(target), did)
  }
  const slotRemoveDID = (did: string, target = slots): void => {
    for (const [i, d] of target) if (d === did) target.delete(i)
  }
  const slotHas = (did: string): boolean => [...slots.values()].includes(did)
  const occupiedDIDs = (): Array<string> =>
    [...slots.keys()].sort((a, b) => a - b).map((i) => slots.get(i) as string)
  const rosterEntries = (): Array<RosterEntry> =>
    [...slots.keys()]
      .sort((a, b) => a - b)
      .map((i) => {
        const did = slots.get(i) as string
        return { did, leafIndex: i, longForm: did } // longForm = id fallback; fixture ids carry no long form
      })
  /**
   * Ephemeral PRIVATE keys, keyed by requestID: minted with the request, retained by the port
   * until the reply is opened, and never on the wire. It is the whole of what makes a reply
   * openable by this peer and by nobody else — the hub holds every other input.
   */
  const groupID = options.groupID ?? 'memory-group'
  const storageID = options.storageID ?? groupID
  const hostDB =
    options.hostDB ??
    createMemoryHostDatabase({
      readIdentity: (state, key) => decodeMemoryGroupIdentity(state, key, recoverySecret),
    })
  hostDB.bindIdentity(storageID, (state, key) =>
    decodeMemoryGroupIdentity(state, key, recoverySecret),
  )
  const confirmationKeyAt = (at: number, position: string, digest: string): Uint8Array =>
    sha256(concatBytes(recoverySecret, fromUTF(JSON.stringify([groupID, at, position, digest]))))
  const tagFor = (key: Uint8Array, requestID: string): string =>
    encodeMultibase(hmac(sha256, key, fromUTF(requestID)))
  let tail: Promise<void> = Promise.resolve()
  const serialise = async <TValue>(fn: () => Promise<TValue>): Promise<TValue> => {
    const previous = tail
    let release: () => void = () => {}
    tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
  let freshLeaves = new Map<string, string>()
  let failRecoveryAdopt = false
  let binding = options.binding
  let preparedBinding = binding
  let prepared = false
  let asked = false
  const unusable = new Set<string>()
  const bindingID = (value: MemoryRecoveryBinding): string =>
    JSON.stringify([value.id, value.prefix, value.capability, value.holderGrant])
  const usable = (value?: MemoryRecoveryBinding): boolean =>
    value != null && !unusable.has(bindingID(value))
  const askBinding = async (): Promise<MemoryRecoveryBinding | undefined> => {
    if (asked) return
    asked = true
    const offered = await options.recoveryBinding?.()
    return offered != null && usable(offered) ? offered : undefined
  }
  const prepare = async (): Promise<'ready' | 'renewal-required'> => {
    prepared = true
    asked = false
    preparedBinding = binding
    if (binding == null || usable(preparedBinding)) return 'ready'
    preparedBinding = await askBinding()
    return usable(preparedBinding) ? 'ready' : 'renewal-required'
  }

  const advance = (to: number): void => {
    if (to === epoch + 1 && receiveState !== undefined) {
      receiveHistory.set(epoch, { identity: toB64U(authenticator()), state: receiveState })
      while (receiveHistory.size > retainKeysForEpochs) {
        const oldest = Math.min(...receiveHistory.keys())
        receiveHistory.delete(oldest)
      }
    }
    receiveState = undefined
    recoveryAuthenticator = undefined
    epochIdentity = undefined
    epoch = to
    options.onAdvance?.(epoch)
  }

  /**
   * Verify a request and authorize it against the ROSTER: the only DIDs this responder can
   * answer are the ones its own tree still carries a leaf for. Roster-intrinsic, so a removed
   * member — and a stranger, and the hub — gets nothing from any responder that has applied
   * the removal, and there is no permission a caller can forget to check.
   *
   * It THROWS, and that is deliberate: a double that could not refuse could not model the one
   * question this rendezvous asks of a request, and every authorization test would pass.
   */
  const authorize = (
    request: Uint8Array,
    label: string,
    requireMember = true,
  ): MemoryRecoveryRequest => {
    let parsed: MemoryRecoveryRequest
    try {
      parsed = JSON.parse(toUTF(request)) as MemoryRecoveryRequest
    } catch (cause) {
      throw new Error(`${label}: the request does not parse`, { cause })
    }
    if (
      parsed?.groupID !== groupID ||
      typeof parsed?.requesterDID !== 'string' ||
      typeof parsed?.requestID !== 'string' ||
      typeof parsed?.ephemeralKey !== 'string'
    ) {
      throw new Error(`${label}: the request is malformed`)
    }
    if (requireMember && !slotHas(parsed.requesterDID)) {
      throw new Error(`${label}: ${parsed.requesterDID} has no leaf in the current tree`)
    }
    return parsed
  }

  const sealReply = (domain: string, to: MemoryRecoveryRequest, payload: Uint8Array): Uint8Array =>
    sealToKey(
      fromB64U(to.ephemeralKey),
      sealContext(domain, to.groupID, to.requesterDID, to.requestID),
      payload,
    )

  const openReply = (
    domain: string,
    sealed: Uint8Array,
    requestID: string,
    requestKey: Uint8Array,
  ): Uint8Array | null => {
    return openWithKey(requestKey, sealContext(domain, groupID, localDID ?? '', requestID), sealed)
  }

  const open = (
    sealed: Uint8Array,
    requestID: string,
    requestKey: Uint8Array,
  ): MemoryGroupInfo | null => {
    const opened = openReply(SEAL_DOMAIN.groupInfo, sealed, requestID, requestKey)
    if (opened == null) return null
    let info: MemoryGroupInfo
    try {
      info = JSON.parse(toUTF(opened)) as MemoryGroupInfo
    } catch {
      return null
    }
    if (typeof info?.to !== 'string' || typeof info?.epoch !== 'number') return null
    if (info.groupID !== groupID || info.to !== (localDID ?? '') || info.requestID !== requestID)
      return null
    return info
  }

  const validateEnactment = async (
    parsed: MemoryCommit,
    held: Map<string, string>,
  ): Promise<void> => {
    if (options.validateLedgerEntries === undefined) return
    if (
      computeLedgerHead(ledger) !== ledgerHead ||
      (parsed.head ?? ledgerHead) !== computeLedgerHead([...ledger, ...parsed.entryIDs])
    )
      throw new LedgerIncompleteError('enactment does not extend the authenticated ledger head')
    const tokens = parsed.entryIDs.map((id) => {
      const token = held.get(id)
      if (token === undefined) throw new MissingLedgerEntriesError([id])
      return token
    })
    await options.validateLedgerEntries(tokens, ledgerTokens())
  }

  const enact = (parsed: MemoryCommit, commit: Uint8Array): void => {
    const nextIdentity = toB64U(sha256(concatBytes(authenticator(), commit)))
    advance(epoch + 1)
    ledger.push(...parsed.entryIDs)
    // The head is the committer's, not this receiver's: a handle whose ledger is incomplete
    // must stay visibly incomplete rather than re-anchor on its own truncated fold. A commit
    // that enacted nothing carries none, and leaves the head where it found it.
    if (parsed.head != null) ledgerHead = parsed.head
    // The tree effect the post-commit handle would carry: a Remove drops the leaf, an Add
    // appends one. Applied together and remove-first, so a Commit that Adds and Removes at once
    // leaves the roster changed in both directions — the case a roster diff must catch and a
    // leaf count cannot.
    if (parsed.removes != null) {
      for (const did of parsed.removes) slotRemoveDID(did)
    }
    if (parsed.adds != null) {
      for (const did of parsed.adds) slotAdd(did)
    }
    if (parsed.external) {
      // `resync: true`: the rejoining member's prior leaf is atomically removed, so a peer
      // that rejoined twice — an orphaned external commit, then a fresh one — leaves one leaf
      // behind and not two.
      slotRemoveDID(parsed.committerDID)
      slotAdd(parsed.committerDID)
    }
    for (const did of [...(parsed.removes ?? []), ...(parsed.adds ?? [])]) freshLeaves.delete(did)
    if (parsed.external && parsed.branch !== undefined)
      freshLeaves.set(parsed.committerDID, parsed.branch)
    epochIdentity = nextIdentity
  }

  const durableState = (value: { epoch: number } & Record<string, unknown>): Uint8Array => {
    const { freshLeaves: nextFreshLeaves, ...fields } = value
    const history = new Map(receiveHistory)
    if (value.epoch === epoch + 1 && receiveState !== undefined) {
      history.set(epoch, { identity: toB64U(authenticator()), state: receiveState })
      while (history.size > retainKeysForEpochs) history.delete(Math.min(...history.keys()))
    }
    return fromUTF(
      JSON.stringify({
        ...fields,
        groupID,
        ownerDID: localDID,
        receiveState: value.epoch === epoch ? receiveState : undefined,
        receiveHistory: [...history],
        binding: value.binding ?? binding,
        freshLeaves: nextFreshLeaves ?? [...freshLeaves],
        ...(value.receiveHistory === undefined ? {} : { receiveHistory: value.receiveHistory }),
      }),
    )
  }
  const serializeState = (): Uint8Array =>
    durableState({
      epoch,
      slots: [...slots],
      ledger,
      ledgerHead,
      bodies: [...bodies],
      terminal: localDID !== undefined && ![...slots.values()].includes(localDID),
      recoveryAuthenticator,
      epochIdentity,
    })
  const restoreState = (state: Uint8Array): void => {
    const value = JSON.parse(toUTF(state)) as {
      groupID?: string
      ownerDID?: string
      receiveState?: string
      receiveHistory?: Array<[number, { identity: string; state: string }]>
      binding?: MemoryRecoveryBinding
      epoch: number
      slots: Array<[number, string]>
      ledger: Array<string>
      ledgerHead: string
      bodies: Array<[string, string]>
      recoveryAuthenticator?: string
      epochIdentity?: string
      freshLeaves?: Array<[string, string]>
    }
    if (value.groupID !== undefined && value.groupID !== groupID)
      throw new Error('Memory state group mismatch')
    if (localDID !== undefined && value.ownerDID !== undefined && value.ownerDID !== localDID)
      throw new Error('Memory state owner mismatch')
    // Missing bodies are allowed; held bodies must match their content-addressed IDs.
    for (const [id, token] of value.bodies) {
      if (entryDigest(token) !== id) throw new Error('Memory ledger body ID mismatch')
    }
    slots = new Map(value.slots)
    ledger = value.ledger
    ledgerHead = value.ledgerHead
    bodies = new Map(value.bodies)
    advance(value.epoch)
    recoveryAuthenticator = value.recoveryAuthenticator
    epochIdentity = value.epochIdentity
    receiveState = value.receiveState
    receiveHistory = new Map(value.receiveHistory ?? [])
    binding = value.binding
    freshLeaves = new Map(value.freshLeaves ?? [])
  }
  const authenticator = (): Uint8Array => {
    const identity = recoveryAuthenticator ?? epochIdentity
    return identity == null
      ? sha256(
          concatBytes(
            recoverySecret,
            fromUTF(groupID),
            fromUTF(JSON.stringify({ epoch, slots: [...slots], ledgerHead })),
          ),
        )
      : fromB64U(identity)
  }

  const ledgerTokens = (): Array<string> =>
    ledger.flatMap((id) => {
      const token = bodies.get(id)
      return token == null ? [] : [token]
    })

  function makePending(
    info: MemoryGroupInfo,
    requestID: string,
    requestKey: Uint8Array,
    candidateBinding?: MemoryRecoveryBinding,
    boundCommit?: { position: string; commitDigest: string; tag: string },
    freshLeaf = requestID,
  ): PendingRecovery {
    const candidateBindingID = candidateBinding == null ? undefined : bindingID(candidateBinding)
    let accepted: Promise<void> | undefined
    let tuple = boundCommit == null ? undefined : { ...boundCommit }
    // The external commit is framed at the epoch the GroupInfo described — the epoch the
    // group is at, which is NOT the epoch this peer is at. Every member that can apply it
    // is at that epoch, so a GroupInfo the group has already moved past builds a commit
    // nobody will apply, which is why losing the compare-and-set discards the GroupInfo
    // and not merely the commit.
    const commit = encodeMemoryCommit(info.epoch, localDID ?? '', [], {
      head: info.head,
      external: true,
      // Model a fresh MLS leaf per attempt, preserving bytes on candidate restore.
      branch: freshLeaf,
    })
    return {
      serialize: () =>
        sealToKey(
          // Hash before X25519 clamps bits, so every persisted key byte matters.
          x25519.getPublicKey(sha256(requestKey)),
          sealContext('candidate', groupID, localDID ?? '', groupID),
          fromUTF(JSON.stringify({ info, requestID, candidateBinding, tuple, freshLeaf })),
        ),
      commit,
      epoch: info.epoch + 1,
      markBindingUnusable: () => {
        if (candidateBindingID == null) return
        const id = candidateBindingID
        unusable.delete(id)
        unusable.add(id)
        while (unusable.size > 16) {
          const oldest = unusable.values().next().value
          if (oldest != null) unusable.delete(oldest)
        }
      },
      confirmationKey: async (position, commitDigest) => {
        if (tuple != null && (tuple.position !== position || tuple.commitDigest !== commitDigest))
          throw new Error('Pending recovery already bound to another commit')
        const key = confirmationKeyAt(info.epoch + 1, position, commitDigest)
        tuple = { position, commitDigest, tag: tagFor(key, requestID) }
        return key
      },
      judgeVerdict: ({ signer, verdict }) => {
        if (
          (localDID != null && normalizeDID(signer) === normalizeDID(localDID)) ||
          tuple == null ||
          !isRecoveryVerdict(verdict) ||
          verdict.groupID !== groupID ||
          verdict.requestID !== requestID ||
          verdict.position !== tuple.position ||
          verdict.commitDigest !== tuple.commitDigest
        )
          return 'advisory'
        if (verdict.verdict === 'confirmed')
          return verdict.epoch === info.epoch + 1 && verdict.tag === tuple.tag
            ? 'authoritative'
            : 'advisory'
        return verdict.verdict === 'refused' &&
          verdict.refusalAuthority === 'authenticated-commit' &&
          info.members.includes(signer)
          ? 'authoritative'
          : 'advisory'
      },
      onAccepted: (factory) => {
        if (typeof factory !== 'function') {
          return Promise.reject(
            new ControlWriteNotCommittedError('Recovery requires an adoption write factory'),
          )
        }
        accepted ??= serialise(async () => {
          const authenticator = sha256(concatBytes(fromB64U(info.authenticator), commit))
          const stored = await hostDB.loadState(storageID)
          if (stored != null) {
            const value = JSON.parse(toUTF(stored)) as {
              epoch: number
              slots: Array<[number, string]>
              ledger: Array<string>
              ledgerHead: string
              bodies: Array<[string, string]>
              recoveryAuthenticator?: string
              freshLeaves?: Array<[string, string]>
            }
            // This marker is saved only together with the adoption write in one transaction.
            if (value.recoveryAuthenticator === toB64U(authenticator)) {
              ledger = value.ledger
              ledgerHead = value.ledgerHead
              slots = new Map(value.slots)
              bodies = new Map(value.bodies)
              advance(value.epoch)
              recoveryAuthenticator = value.recoveryAuthenticator
              receiveHistory.clear()
              receiveState = undefined
              binding = candidateBinding
              freshLeaves = new Map(value.freshLeaves ?? [])
              return
            }
          }
          if (failRecoveryAdopt) {
            failRecoveryAdopt = false
            throw new Error('the process died in the acceptance window')
          }
          const nextSlots = new Map(info.members.map((did, index) => [index, did]))
          const nextFreshLeaves = new Map(info.leafTokens ?? [])
          if (localDID != null) {
            slotRemoveDID(localDID, nextSlots)
            slotAdd(localDID, nextSlots)
            nextFreshLeaves.set(localDID, freshLeaf)
          }
          const write = factory({
            incarnation: 1,
            epochAfter: info.epoch + 1,
            removed: false,
            epochAuthenticator: authenticator,
          })
          const state = durableState({
            epoch: info.epoch + 1,
            receiveHistory: [],
            binding: candidateBinding,
            slots: [...nextSlots],
            ledger: [],
            ledgerHead: info.head,
            bodies: [...bodies],
            recoveryAuthenticator: toB64U(authenticator),
            freshLeaves: [...nextFreshLeaves],
          })
          try {
            await hostDB.saveState(storageID, state, write)
          } catch (error) {
            if (
              !(error instanceof Error) ||
              error.name !== 'StorageOutcomeUnknownError' ||
              (await hostDB.control(storageID, { groupID, incarnation: 1 }).lastMutation()) !==
                write.mutationID
            )
              throw error
          }
          ledger = []
          ledgerHead = info.head
          slots = nextSlots
          advance(info.epoch + 1)
          recoveryAuthenticator = toB64U(authenticator)
          receiveHistory.clear()
          receiveState = undefined
          binding = candidateBinding
          freshLeaves = nextFreshLeaves
        }).catch((error: unknown) => {
          accepted = undefined
          throw error
        })
        return accepted
      },
    }
  }

  const capturedDependencies = options.capturedRecovery
  function validateSource(source: RecoverySource): RecoverySource {
    const trust = source.trust as { groupID?: string; ownerDID?: string; members?: Array<string> }
    if (
      source.key.groupID !== groupID ||
      source.key.incarnation !== 1 ||
      !Number.isSafeInteger(source.stateVersion) ||
      !Number.isSafeInteger(source.lifetimeRevision) ||
      source.stateVersion < 0 ||
      source.lifetimeRevision < 0 ||
      trust?.groupID !== groupID ||
      trust.ownerDID !== localDID ||
      !Array.isArray(trust.members) ||
      !trust.members.includes(localDID ?? '') ||
      source.trustDigest !== toB64U(sha256(fromUTF(JSON.stringify(trust)))) ||
      source.identity !== null
    )
      throw new TypeError('Invalid memory recovery source')
    return copyRecoverySource(source)
  }
  function sameSource(left: RecoverySource, right: RecoverySource): boolean {
    return encodeData(validateSource(left)) === encodeData(validateSource(right))
  }
  function encodeData(value: unknown): string {
    return JSON.stringify(value, (_key, child: unknown) =>
      child instanceof Uint8Array ? { bytes: toB64U(child) } : child,
    )
  }
  function decodeData<TValue>(bytes: Uint8Array): TValue {
    return JSON.parse(toUTF(bytes), (_key, child: unknown) => {
      if (
        child !== null &&
        typeof child === 'object' &&
        'bytes' in child &&
        typeof child.bytes === 'string'
      )
        return fromB64U(child.bytes)
      return child
    }) as TValue
  }
  function capturedInfo(
    sealed: Uint8Array,
    requestID: string,
    requestKey: Uint8Array,
    source: RecoverySource,
  ): MemoryGroupInfo | null {
    const info = open(sealed, requestID, requestKey)
    if (
      info === null ||
      info.captureHead === undefined ||
      info.signer === undefined ||
      info.attestation === undefined ||
      !Number.isSafeInteger(info.epoch) ||
      info.epoch < 0 ||
      !Array.isArray(info.leafTokens) ||
      !/^[A-Za-z0-9_-]{43}$/.test(info.authenticator) ||
      fromB64U(info.authenticator).length !== 32 ||
      toB64U(fromB64U(info.authenticator)) !== info.authenticator
    )
      return null
    try {
      validateCaptureHead(info.captureHead)
    } catch {
      return null
    }
    const { attestation, ...body } = info
    const trust = source.trust as { members: Array<string> }
    if (
      info.stateSignature !== signCapturedState(info) ||
      !trust.members.includes(info.signer) ||
      !info.members.includes(localDID ?? '') ||
      attestation !== toB64U(hmac(sha256, recoverySecret, fromUTF(JSON.stringify(body))))
    )
      return null
    return info
  }
  function signCapturedState(info: MemoryGroupInfo): string {
    return toB64U(
      hmac(
        sha256,
        recoverySecret,
        fromUTF(
          JSON.stringify([
            'mls-applied-state',
            info.groupID,
            info.epoch,
            info.authenticator,
            info.head,
            info.members,
            info.leafTokens,
          ]),
        ),
      ),
    )
  }
  type CapturedSnapshot = {
    source: RecoverySource
    target: CapturedPendingRecovery['target']
    sealed: Uint8Array
    requestID: string
    inner: Uint8Array
  }
  function wrapCaptured(
    snapshot: CapturedSnapshot,
    requestKey: Uint8Array,
    pending: PendingRecovery,
  ): CapturedPendingRecovery {
    return {
      ...pending,
      get source() {
        return copyRecoverySource(snapshot.source)
      },
      get target() {
        return copyRecoveryTargetCapture(snapshot.target)
      },
      serialize: () =>
        sealToKey(
          x25519.getPublicKey(sha256(requestKey)),
          sealContext('candidate-v3', groupID, localDID ?? '', groupID),
          fromUTF(encodeData({ ...snapshot, inner: pending.serialize() })),
        ),
      async onAccepted(expected, proof, write) {
        if (
          capturedDependencies === undefined ||
          !sameSource(snapshot.source, expected) ||
          typeof write !== 'function' ||
          proof.targetID !== snapshot.target.targetID ||
          proof.topicID !== snapshot.target.topicID ||
          proof.captureHead !== snapshot.target.captureHead ||
          proof.groupInfoEpoch !== snapshot.target.groupInfoEpoch ||
          toB64U(proof.groupInfoAuthenticator) !== toB64U(snapshot.target.groupInfoAuthenticator) ||
          proof.payloadDigest !==
            digestAppliedCommit(
              encodeHandshakeFrame(
                HANDSHAKE_KIND.commit,
                encodeCommitFrame(pending.commit, new Uint8Array()),
              ),
            )
        )
          throw new TypeError('Invalid memory captured acceptance')
        const opened = openReply(SEAL_DOMAIN.verdict, proof.verdict, snapshot.requestID, requestKey)
        const verdict =
          opened === null ? null : (JSON.parse(toUTF(opened)) as OpenedRecoveryVerdict)
        if (
          verdict === null ||
          verdict.verdict.verdict !== 'confirmed' ||
          verdict.verdict.position !== proof.position ||
          verdict.verdict.commitDigest !== digestAppliedCommit(pending.commit) ||
          pending.judgeVerdict(verdict) !== 'authoritative'
        )
          throw new TypeError('Unconfirmed memory captured acceptance')
        await capturedDependencies.accept(pending, copyRecoverySource(expected), proof, write)
      },
    }
  }
  function readCaptured(candidate: Uint8Array, requestKey: Uint8Array) {
    if (capturedDependencies === undefined) throw new TypeError('Missing captured dependencies')
    const opened = openWithKey(
      sha256(requestKey),
      sealContext('candidate-v3', groupID, localDID ?? '', groupID),
      candidate,
    )
    if (opened === null) throw new TypeError('Invalid memory captured candidate')
    const snapshot = decodeData<CapturedSnapshot>(opened)
    if (
      snapshot.target.targetID !== capturedDependencies.target.targetID ||
      snapshot.target.topicID !== capturedDependencies.target.topicID
    )
      throw new TypeError('Memory captured origin mismatch')
    const info = capturedInfo(snapshot.sealed, snapshot.requestID, requestKey, snapshot.source)
    if (
      info === null ||
      snapshot.target.groupInfoEpoch !== info.epoch ||
      snapshot.target.captureHead !== info.captureHead ||
      toB64U(snapshot.target.groupInfoAuthenticator) !== info.authenticator
    )
      throw new TypeError('Memory capture mismatch')
    const inner = openWithKey(
      sha256(requestKey),
      sealContext('candidate', groupID, localDID ?? '', groupID),
      snapshot.inner,
    )
    if (inner === null) throw new TypeError('Invalid memory recovery candidate')
    const held = JSON.parse(toUTF(inner)) as {
      info: MemoryGroupInfo
      requestID: string
      candidateBinding?: MemoryRecoveryBinding
      tuple?: { position: string; commitDigest: string; tag: string }
      freshLeaf: string
    }
    if (
      held.requestID !== snapshot.requestID ||
      JSON.stringify(held.info) !== JSON.stringify(info) ||
      !/^[A-Za-z0-9_-]{43}$/.test(held.freshLeaf) ||
      (held.tuple !== undefined &&
        held.tuple.tag !==
          tagFor(
            confirmationKeyAt(info.epoch + 1, held.tuple.position, held.tuple.commitDigest),
            held.requestID,
          ))
    )
      throw new TypeError('Memory candidate association mismatch')
    return { snapshot, info, held }
  }
  async function restoreCaptured(
    candidate: Uint8Array,
    requestKey: Uint8Array,
  ): Promise<CapturedPendingRecovery> {
    if (capturedDependencies === undefined) throw new TypeError('Missing captured dependencies')
    const { snapshot, info, held } = readCaptured(candidate, requestKey)
    if (!sameSource(await capturedDependencies.readSource(), snapshot.source))
      throw new TypeError('Memory captured origin mismatch')
    return wrapCaptured(
      snapshot,
      requestKey,
      makePending(
        info,
        held.requestID,
        requestKey,
        held.candidateBinding,
        held.tuple,
        held.freshLeaf,
      ),
    )
  }
  const capturedRecovery: CapturedRecoveryPort | undefined =
    capturedDependencies === undefined
      ? undefined
      : {
          async applyRecovery(sealed, requestID, requestKey) {
            if (
              controlSafetyHeld(
                await hostDB.control(storageID, { groupID, incarnation: 1 }).load(),
              ) !== null
            )
              return null
            if (!capturedDependencies.target.targetID || !capturedDependencies.target.topicID)
              throw new TypeError('Invalid recovery target')
            const source = validateSource(await capturedDependencies.readSource())
            const info = capturedInfo(sealed, requestID, requestKey, source)
            if (info === null) return null
            await prepare()
            if (binding !== undefined && !usable(preparedBinding)) return { renewalRequired: true }
            const target = {
              ...capturedDependencies.target,
              groupInfoEpoch: info.epoch,
              groupInfoAuthenticator: fromB64U(info.authenticator),
              captureHead: validateCaptureHead(info.captureHead),
            }
            const pending = makePending(
              info,
              requestID,
              requestKey,
              preparedBinding,
              undefined,
              toB64U(globalThis.crypto.getRandomValues(new Uint8Array(32))),
            )
            return wrapCaptured(
              { source, target, sealed: sealed.slice(), requestID, inner: pending.serialize() },
              requestKey.slice(),
              pending,
            )
          },
          restoreRecovery: restoreCaptured,
          async reconcileCapture(record, reply) {
            try {
              if (
                controlSafetyHeld(
                  await hostDB.control(storageID, { groupID, incarnation: 1 }).load(),
                ) !== null
              )
                return { kind: 'held' }
              const { snapshot: saved, held } = readCaptured(record.candidate, record.requestKey)
              const source = validateSource(await capturedDependencies.readSource())
              const commit = encodeMemoryCommit(held.info.epoch, localDID ?? '', [], {
                head: held.info.head,
                external: true,
                branch: held.freshLeaf,
              })
              const payload = encodeHandshakeFrame(
                HANDSHAKE_KIND.commit,
                encodeCommitFrame(commit, new Uint8Array()),
              )
              const text = (value: unknown): value is string =>
                typeof value === 'string' && value.length > 0
              validateCaptureHead(record.expectedHead)
              if (
                record.format !== 2 ||
                !text(record.id) ||
                !text(record.publishID) ||
                !(record.request instanceof Uint8Array) ||
                record.request.length === 0 ||
                !Array.isArray(record.ledgerBefore) ||
                !record.ledgerBefore.every((token) => typeof token === 'string') ||
                (record.position !== undefined && !text(record.position)) ||
                (record.verdict !== undefined &&
                  (!(record.verdict instanceof Uint8Array) || record.verdict.length === 0)) ||
                (record.refusal !== undefined &&
                  !['binding', 'lapse', 'floor', 'policy', 'invalid'].includes(record.refusal)) ||
                (record.switchMutationID !== null && !text(record.switchMutationID)) ||
                (record.destinationKey !== null &&
                  (record.destinationKey.groupID !== source.key.groupID ||
                    record.destinationKey.incarnation !== source.key.incarnation + 1)) ||
                (record.stage === 'adopted' && record.destinationKey === null) ||
                record.trigger !== 'automatic' ||
                record.authorisationID !== null ||
                !['built', 'published', 'confirmed', 'adopted', 'refused'].includes(record.stage) ||
                !sameSource(source, saved.source) ||
                !sameSource(record.source, saved.source) ||
                encodeData(record.target) !== encodeData(saved.target) ||
                record.captureHead !== saved.target.captureHead ||
                record.searchFrom !== saved.target.captureHead ||
                record.epochAfter !== held.info.epoch + 1 ||
                record.digest !== digestAppliedCommit(commit) ||
                record.payloadDigest !== digestAppliedCommit(record.payload) ||
                toB64U(record.payload) !== toB64U(payload) ||
                ((record.stage === 'confirmed' || record.stage === 'adopted') &&
                  (record.position !== held.tuple?.position ||
                    record.digest !== held.tuple?.commitDigest ||
                    !held.tuple?.tag ||
                    !(record.verdict instanceof Uint8Array))) ||
                record.requestID !== saved.requestID ||
                capturedInfo(saved.sealed, saved.requestID, record.requestKey, source) === null
              )
                throw new TypeError('Captured recovery record association mismatch')
              const info = capturedInfo(reply.sealed, reply.requestID, reply.requestKey, source)
              if (
                info === null ||
                info.epoch < saved.target.groupInfoEpoch ||
                (reply.epochFloor !== null && info.epoch < reply.epochFloor)
              )
                return { kind: 'retry' }
              if (info.epoch === saved.target.groupInfoEpoch)
                return info.authenticator === toB64U(saved.target.groupInfoAuthenticator)
                  ? {
                      kind: 'head-only',
                      head: validateCaptureHead(info.captureHead),
                    }
                  : { kind: 'retry' }
              return info.leafTokens?.some(
                ([did, leaf]) => did === localDID && leaf === held.freshLeaf,
              )
                ? {
                    kind: 'accepted',
                    epoch: info.epoch,
                    leafDigest: toB64U(sha256(fromUTF(JSON.stringify([localDID, held.freshLeaf])))),
                  }
                : { kind: 'unapplied-later', epoch: info.epoch }
            } catch (error) {
              if (
                error instanceof Error &&
                error.name === 'GroupUnavailableError' &&
                'reason' in error &&
                error.reason === 'recovery-unavailable'
              )
                return { kind: 'held' }
              if (
                error instanceof StorageOutcomeUnknownError ||
                (error instanceof Error &&
                  error.name === 'GroupUnavailableError' &&
                  'reason' in error &&
                  error.reason === 'restore-pending')
              )
                return { kind: 'retry' }
              throw error
            }
          },
          sealGroupInfo: (request, head) => sealInfo(request, head),
        }
  async function sealInfo(
    request: Uint8Array,
    captureHead?: LogPosition | null,
  ): Promise<Uint8Array> {
    const { to, info } = await serialise(async () => {
      if (captureHead !== undefined) {
        validateCaptureHead(captureHead)
        const control = (await hostDB.snapshot(storageID)).control
        const safety = controlSafetyHeld(control)
        if (safety !== null) throw new GroupSafetyHeldError(safety)
        if (
          (control.cursor?.position ?? null) !== captureHead ||
          (control.cursor !== null && control.cursor.epoch !== epoch) ||
          control.cursor?.stranded === true ||
          control.cursor?.incomplete === true ||
          control.strand !== null
        )
          throw new Error('Capture head does not match a complete committed cursor')
      }
      const to = authorize(request, 'sealGroupInfo')
      const info: MemoryGroupInfo = {
        authenticator: toB64U(authenticator()),
        to: to.requesterDID,
        requestID: to.requestID,
        groupID,
        epoch,
        members: occupiedDIDs(),
        head: ledgerHead,
        ...(captureHead === undefined
          ? {}
          : { captureHead, signer: localDID, leafTokens: [...freshLeaves] }),
      }
      return { to, info }
    })
    if (captureHead !== undefined) {
      info.stateSignature = signCapturedState(info)
      info.attestation = toB64U(hmac(sha256, recoverySecret, fromUTF(JSON.stringify(info))))
    }
    return sealReply(SEAL_DOMAIN.groupInfo, to, fromUTF(JSON.stringify(info)))
  }

  return {
    capturedRecovery,
    database: () => hostDB,
    persistInitialState: () =>
      serialise(async () => {
        if ((await hostDB.loadState(storageID)) === null)
          await hostDB.seed(storageID, serializeState())
      }),
    acceptsCommitter,
    credentialDID: () => localDID,
    saveBuilt: (intent, built, expected, mutationID) =>
      serialise(() =>
        hostDB.saveBuilt(
          storageID,
          { groupID, incarnation: 1 },
          intent,
          built,
          expected,
          mutationID,
        ),
      ),
    control: () => hostDB.control(storageID, { groupID, incarnation: 1 }),
    anchorStore: () => hostDB.anchorStore(storageID),
    serializeState,
    restoreState,
    authenticator,
    memberSlots: () => [...slots].sort(([a], [b]) => a - b),
    setReceiveState: (state) => {
      receiveState = toB64U(state)
    },
    setReceiveHistory: (history) => {
      const next = new Map<number, { identity: string; state: string }>()
      for (const [at, held] of history) {
        if (receiveHistory.get(at)?.identity !== held.identity)
          throw new Error('Memory retained identity changed')
        next.set(at, { identity: held.identity, state: toB64U(held.state) })
      }
      receiveHistory = next
    },
    receiveHistory: () =>
      [...receiveHistory].map(([at, held]) => [
        at,
        {
          identity: held.identity,
          state: fromB64U(held.state),
        },
      ]),
    carryReceiveProgress: (candidate) => {
      const value = JSON.parse(toUTF(candidate.serializeState())) as {
        groupID?: string
        ownerDID?: string
        epoch: number
        receiveHistory: Array<[number, { identity: string; state: string }]>
      }
      const history = new Map(value.receiveHistory)
      if (
        value.groupID !== groupID ||
        value.ownerDID !== localDID ||
        value.epoch !== epoch + 1 ||
        history.get(epoch)?.identity !== toB64U(authenticator()) ||
        receiveState === undefined
      )
        throw new Error('Memory candidate source changed')
      history.set(epoch, { identity: toB64U(authenticator()), state: receiveState })
      for (const [at, target] of history) {
        if (at >= epoch) continue
        const source = receiveHistory.get(at)
        if (source === undefined) history.delete(at)
        else {
          if (source.identity !== target.identity)
            throw new Error('Memory retained identity changed')
          history.set(at, { ...source })
        }
      }
      candidate.restoreState(
        fromUTF(
          JSON.stringify({
            ...JSON.parse(toUTF(candidate.serializeState())),
            receiveHistory: [...history],
          }),
        ),
      )
    },
    adoptOperation: (blob, expected, write) =>
      serialise(async () => {
        const journal = decodeMemoryControlJournal(blob)
        const state = journal.candidate
        const candidate = JSON.parse(toUTF(state)) as { epoch: number }
        const snapshot = await hostDB.snapshot(storageID)
        const identity = { groupID, incarnation: 1, epoch, authenticator: authenticator() }
        const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
        if (
          snapshot.control.strand !== null ||
          snapshot.control.cursor?.stranded === true ||
          controlSafetyHeld(snapshot.control) !== null ||
          (snapshot.control.controlHold !== null &&
            snapshot.control.controlHold.reason !== 'acceptance-unknown') ||
          !same(journal.source.key, expected.key) ||
          !same(expected.acceptance.source.key, expected.key) ||
          !same(expected.key, { groupID, incarnation: 1 }) ||
          !same(expected.identity, identity) ||
          expected.stateVersion !== snapshot.version ||
          !same(expected.acceptance.source.identity, journal.source.identity)
        )
          return 'moved'
        if (candidate.epoch === epoch && toB64U(state) === toB64U(serializeState())) {
          const row = snapshot.control.applied.find(
            (row) => row.epoch === journal.source.identity?.epoch,
          )
          return row?.payloadDigest === expected.acceptance.payloadDigest &&
            row.sequenceID === expected.acceptance.position
            ? 'noop'
            : 'moved'
        }
        if (
          !same(journal.source.identity, identity) ||
          snapshot.control.commitOnce?.payloadDigest !== expected.acceptance.payloadDigest ||
          !same(snapshot.control.commitOnce.journal, blob) ||
          snapshot.control.commitOnce.searchFrom !== expected.acceptance.from ||
          !same(snapshot.control.commitOnceAcceptance, expected.acceptance)
        )
          return 'moved'
        try {
          await hostDB.saveState(storageID, state, {
            ...write,
            expected: { ...expected, journal: blob },
          })
        } catch (error) {
          if (error instanceof Error && error.name === 'ControlAdoptionMovedError') return 'moved'
          if (
            !(error instanceof Error) ||
            error.name !== 'StorageOutcomeUnknownError' ||
            (await hostDB.control(storageID, { groupID, incarnation: 1 }).lastMutation()) !==
              write.mutationID
          )
            throw error
        }
        restoreState(state)
        return 'installed'
      }),
    epoch: () => epoch,
    ownCommitDigest: (commit) => {
      const parsed = decodeMemoryCommit(commit)
      if (parsed === null) return null
      // This double's authenticator binds exact JSON bytes, so recognition stays stricter.
      return toB64U(sha256(commit))
    },
    commits: () => commits,
    seen: () => seen,
    lastSender: () => lastSender,
    ledgerIDs: () => [...ledger],
    ledgerTokens,
    authenticatedLedgerHead: () => ledgerHead,
    applyLedgerEntries: (tokens) =>
      serialise(async () => {
        await options.validateLedgerEntries?.(tokens, null)
        for (const token of tokens) bodies.set(entryDigest(token), token)
        ledger.push(...tokens.map(entryDigest))
      }),
    leaves: () => occupiedDIDs(),
    async rosterEntries() {
      return rosterEntries()
    },
    fold: () => {
      const folded = new Map<string, string>()
      for (const token of ledgerTokens()) {
        const split = token.indexOf('=')
        if (split > 0) folded.set(token.slice(0, split), token.slice(split + 1))
      }
      return folded
    },
    failNextRecoveryAdopt() {
      failRecoveryAdopt = true
    },
    buildCommit(
      tokens: Array<string> = [],
      options: { adds?: Array<string>; removes?: Array<string> } = {},
    ) {
      const entryIDs = tokens.map((token) => {
        const id = entryDigest(token)
        bodies.set(id, token)
        return id
      })
      return encodeMemoryCommit(epoch, localDID ?? '', entryIDs, {
        branch: toB64U(crypto.getRandomValues(new Uint8Array(16))),
        head: computeLedgerHead([...ledger, ...entryIDs]),
        ...(options.adds != null ? { adds: options.adds } : {}),
        ...(options.removes != null ? { removes: options.removes } : {}),
      })
    },
    adopt(commit: Uint8Array) {
      const parsed = decodeMemoryCommit(commit)
      if (parsed == null || parsed.epoch !== epoch) {
        throw new Error("adopt: not a commit framed at this member's current epoch")
      }
      if (
        parsed.invalidContent ||
        parsed.missingProposal ||
        parsed.signerDID !== parsed.committerDID ||
        parsed.committerDID !== localDID ||
        !slotHas(parsed.committerDID) ||
        !acceptsCommitter(parsed.committerDID)
      )
        throw new Error('adopt: unauthorised or invalid commit')
      if (options.validateLedgerEntries != null) {
        return serialise(async () => {
          if (parsed.epoch !== epoch) throw new Error('adopt: source epoch moved')
          await validateEnactment(parsed, bodies)
          enact(parsed, commit)
        })
      }
      enact(parsed, commit)
    },
    evict(did: string) {
      slotRemoveDID(did)
    },
    readEvidence: () =>
      serialise(async () => {
        const snapshot = await hostDB.snapshot(storageID)
        const key = { groupID, incarnation: 1 }
        const identity =
          snapshot.state === null
            ? null
            : decodeMemoryGroupIdentity(snapshot.state, key, recoverySecret)
        const state =
          snapshot.state === null
            ? null
            : (JSON.parse(toUTF(snapshot.state)) as { terminal: boolean })
        return {
          source: { key, stateVersion: snapshot.version, identity },
          applied: snapshot.control.applied,
          cursor: snapshot.control.cursor,
          terminal: state?.terminal === true,
        }
      }),
    readRecoverySource: () =>
      serialise(async () => {
        const key = { groupID, incarnation: 1 }
        return {
          key,
          stateVersion: await hostDB.loadVersion(storageID),
          identity: { ...key, epoch, authenticator: authenticator() },
        }
      }),
    readEpoch: () => serialise(async () => epoch),
    prepareRecovery: prepare,
    async signRecoveryConfirmation(binding) {
      if (binding.groupID !== groupID || localDID == null)
        throw new Error('Confirmation identity mismatch')
      const signer = normalizeDID(localDID)
      let key = confirmationKeys.get(signer)
      if (key == null) {
        key = x25519.utils.randomSecretKey()
        confirmationKeys.set(signer, key)
      }
      const body = JSON.stringify([
        binding.groupID,
        binding.requestID,
        binding.position,
        binding.commitDigest,
        signer,
      ])
      return fromUTF(JSON.stringify({ body, tag: toB64U(hmac(sha256, key, fromUTF(body))) }))
    },
    async verifyRecoveryConfirmation(binding, signature, requesterDID) {
      try {
        const signer = normalizeDID(requesterDID)
        const key = confirmationKeys.get(signer)
        if (key == null || binding.groupID !== groupID) return false
        const body = JSON.stringify([
          binding.groupID,
          binding.requestID,
          binding.position,
          binding.commitDigest,
          signer,
        ])
        const value = JSON.parse(toUTF(signature))
        return value.body === body && value.tag === toB64U(hmac(sha256, key, fromUTF(body)))
      } catch {
        return false
      }
    },
    async verifyRecoveryRequest(request) {
      try {
        const verified = authorize(request, 'verifyRecoveryRequest', false)
        return { groupID, requestID: verified.requestID, requesterDID: verified.requesterDID }
      } catch {
        return null
      }
    },
    sendAdmission: () => ({ epoch, admissible: true }),
    async readCommitHeader(commit: Uint8Array): Promise<CommitHeader | null> {
      // Two facts, two availabilities — the whole point of the port's contract, modelled exactly.
      //
      // The EPOCH is cleartext in a real frame, so it is readable for a commit framed at ANY
      // epoch and is always returned. `null` is reserved for bytes that are not a commit, which
      // here is bytes that will not decode.
      //
      // The COMMITTER is what needs a key. A real handle recovers a member commit's committer by
      // decrypting the commit's sender-data with the epoch secret it holds RIGHT NOW and mapping
      // the sender leaf against its own tree, so a commit framed at an epoch it is not at
      // authenticates to nobody — in BOTH directions, since the secret for a ratcheted-past epoch
      // is as gone as one never reached. It comes back absent, and a double that answered anyway
      // would let the lane lean on an answer the real port cannot give — and did.
      //
      // `external` is NOT exempt. An external commit needs no epoch secret and no tree — its
      // committer rides its own UpdatePath leaf — but that leaf's credential is a field, and the
      // thing that binds it to an author is the commit's own signature. Verifying that signature
      // needs the group context it was signed against, which this member holds only for the epoch
      // it stands at, so the committer is available on exactly the same terms as a member commit's
      // and absent on the same terms. `external` itself is reported either way: it is structural,
      // as keyless as the epoch, and says nothing about who wrote the frame.
      const parsed = decodeMemoryCommit(commit)
      if (parsed == null) return null
      const isExternal = parsed.external === true
      if (parsed.epoch !== epoch) {
        return { epoch: parsed.epoch, ...(isExternal ? { external: true } : {}) }
      }
      // At this member's epoch sender identity is checkable separately from commit content.
      // The double uses mismatched identities to model a forged sender claim.
      if (
        (parsed.signerDID ?? parsed.committerDID) !== parsed.committerDID ||
        (parsed.committerDID === localDID && parsed.invalidContent === true)
      ) {
        return { epoch: parsed.epoch, ...(isExternal ? { external: true } : {}) }
      }
      return {
        epoch: parsed.epoch,
        committerDID: parsed.committerDID,
        ...(isExternal ? { external: true } : {}),
      }
    },
    validateRecoveryCommit: (commit) =>
      serialise(async () => {
        const parsed = decodeMemoryCommit(commit)
        if (
          parsed == null ||
          parsed.epoch !== epoch ||
          parsed.external !== true ||
          parsed.invalidContent === true ||
          parsed.missingProposal === true ||
          (parsed.signerDID ?? parsed.committerDID) !== parsed.committerDID
        )
          return { epoch }
        try {
          if (parsed.committerDID === localDID || !acceptsCommitter(parsed.committerDID))
            return {
              epoch,
              refusal: 'policy' as const,
              refusalAuthority: 'authenticated-commit' as const,
            }
          if (parsed.entryIDs.some((id) => !bodies.has(id))) return { epoch }
          await validateEnactment(parsed, new Map(bodies))
        } catch {
          return { epoch }
        }
        return { epoch, valid: true }
      }),
    processCommit: (commit: Uint8Array, context: CommitContext) =>
      serialise(async () => {
        lastSender = context.senderDID
        seen += 1
        const parsed = decodeMemoryCommit(commit)
        if (parsed == null) {
          return { applied: false, advanced: false, epochBefore: epoch, epochAfter: epoch }
        }
        // A Commit framed at another epoch is not this member's to apply: real MLS cannot
        // decrypt it at all. Ordinary history for a member walking the log — the late
        // joiner's own add-commit is exactly this — and NOT corruption. The blob riding it
        // is never opened, because the entries are never resolved.
        if (parsed.epoch !== epoch) {
          return { applied: false, advanced: false, epochBefore: epoch, epochAfter: epoch }
        }

        // Sender-data authorship and commit-content validity are separate in real MLS. A hub can
        // change ciphertext beyond the sampled prefix without breaking the sender-data read.
        if (
          parsed.invalidContent === true ||
          (parsed.signerDID ?? parsed.committerDID) !== parsed.committerDID
        ) {
          return {
            applied: false,
            advanced: false,
            epochBefore: epoch,
            epochAfter: epoch,
            refusal: 'invalid' as const,
          }
        }
        if (parsed.missingProposal === true) {
          return {
            applied: false,
            advanced: false,
            epochBefore: epoch,
            epochAfter: epoch,
            validation: 'unavailable' as const,
          }
        }
        // A member can never apply the frame that is its OWN commit: MLS merges a pending
        // commit, it does not process one, and the pending state is the only thing that could
        // have carried it. A member that meets its own commit in the log has lost that state,
        // and no amount of processing will get it back. An external commit is the exception
        // that proves it — the rejoining member adopts the handle its own rejoin derived.
        if (localDID != null && parsed.committerDID === localDID) {
          return { applied: false, advanced: false, epochBefore: epoch, epochAfter: epoch }
        }
        // Well-formed, and refused: the group's policy does not accept commits from this
        // committer. A refusal is NOT a throw — the peer read the commit, judged it, and
        // declined it, and there is nothing to retry.
        if (!acceptsCommitter(parsed.committerDID)) {
          return {
            applied: false,
            advanced: false,
            epochBefore: epoch,
            epochAfter: epoch,
            refusal: 'policy' as const,
          }
        }
        const nextBodies = new Map(bodies)
        const missing = parsed.entryIDs.filter((id) => !nextBodies.has(id))
        if (missing.length > 0) {
          const tokens = (await context.resolveLedgerEntries?.(missing)) ?? []
          for (const token of tokens) {
            const id = entryDigest(token)
            // Content-addressed: a body binds to the id it hashes to, or it is ignored.
            if (missing.includes(id)) nextBodies.set(id, token)
          }
          const stillMissing = parsed.entryIDs.filter((id) => !nextBodies.has(id))
          if (stillMissing.length > 0) {
            throw new MissingLedgerEntriesError(stillMissing)
          }
        }
        await validateEnactment(parsed, nextBodies)
        const epochBefore = epoch
        const nextSlots = new Map(slots)
        for (const did of parsed.removes ?? []) slotRemoveDID(did, nextSlots)
        for (const did of parsed.adds ?? []) slotAdd(did, nextSlots)
        if (parsed.external) {
          slotRemoveDID(parsed.committerDID, nextSlots)
          slotAdd(parsed.committerDID, nextSlots)
        }
        const removed = localDID != null && ![...nextSlots.values()].includes(localDID)
        // Self-removal adopts the tree and ledger but supplies no successor epoch secrets.
        const epochAfter = removed ? epoch : epoch + 1
        const nextIdentity = toB64U(
          removed ? authenticator() : sha256(concatBytes(authenticator(), commit)),
        )
        const nextLedger = [...ledger, ...parsed.entryIDs]
        const nextHead = parsed.head ?? ledgerHead
        const nextFreshLeaves = new Map(freshLeaves)
        for (const did of [...(parsed.removes ?? []), ...(parsed.adds ?? [])])
          nextFreshLeaves.delete(did)
        if (parsed.external && parsed.branch !== undefined)
          nextFreshLeaves.set(parsed.committerDID, parsed.branch)
        const state = durableState({
          epoch: epochAfter,
          slots: [...nextSlots],
          ledger: nextLedger,
          ledgerHead: nextHead,
          bodies: [...nextBodies],
          terminal: removed,
          epochIdentity: nextIdentity,
          freshLeaves: [...nextFreshLeaves],
        })
        const write = context.adoption?.({
          incarnation: 1,
          epochAfter,
          removed,
          epochAuthenticator: fromB64U(nextIdentity),
        })
        try {
          await hostDB.saveState(storageID, state, write)
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.name !== 'StorageOutcomeUnknownError' ||
            write == null ||
            (await hostDB.control(storageID, { groupID, incarnation: 1 }).lastMutation()) !==
              write.mutationID
          )
            throw error
          const committed = await hostDB.loadState(storageID)
          if (committed == null) throw error
          restoreState(committed)
          commits += 1
          return { applied: true, advanced: !removed, epochBefore, epochAfter }
        }
        if (!removed) advance(epochAfter)
        bodies = nextBodies
        slots = nextSlots
        ledger = nextLedger
        ledgerHead = nextHead
        commits += 1
        epochIdentity = nextIdentity
        freshLeaves = nextFreshLeaves
        return { applied: true, advanced: !removed, epochBefore, epochAfter }
      }),
    async isLedgerComplete() {
      return computeLedgerHead(ledger) === ledgerHead
    },
    async getLedger() {
      return ledgerTokens()
    },
    bootstrapLedger: (tokens: Array<string>, persist?: () => Promise<void> | void) =>
      serialise(async () => {
        // The gate, and nothing below it touches the handle until the check has passed: the
        // head is recomputed over the gathered ids IN THE ORDER GIVEN and compared against the
        // one this handle's own group state carries. A rejected ledger writes nothing.
        const entryIDs = tokens.map(entryDigest)
        if (computeLedgerHead(entryIDs) !== ledgerHead) {
          throw new LedgerIncompleteError(
            'bootstrapLedger: the gathered ledger does not fold to the head this group attests to',
          )
        }
        await options.validateLedgerEntries?.(tokens, null)
        const nextBodies = new Map(bodies)
        for (const token of tokens) nextBodies.set(entryDigest(token), token)
        const state = durableState({
          epoch,
          slots: [...slots],
          ledger: entryIDs,
          terminal: localDID !== undefined && ![...slots.values()].includes(localDID),
          ledgerHead,
          bodies: [...nextBodies],
          recoveryAuthenticator,
          epochIdentity,
        })
        if (persist === undefined) await hostDB.saveState(storageID, state)
        const previous = serializeState()
        bodies = nextBodies
        ledger = entryIDs
        try {
          await persist?.()
        } catch (error) {
          restoreState(previous)
          throw error
        }
      }),
    async createRecoveryRequest(requestID: string) {
      const requesterDID = localDID ?? ''
      const privateKey = x25519.utils.randomSecretKey()
      return {
        requestKey: privateKey,
        request: fromUTF(
          JSON.stringify({
            groupID,
            requestID,
            requesterDID,
            ephemeralKey: toB64U(x25519.getPublicKey(privateKey)),
          } satisfies MemoryRecoveryRequest),
        ),
      }
    },
    async confirmationKey(position, commitDigest) {
      return { epoch, key: confirmationKeyAt(epoch, position, commitDigest) }
    },
    async sealRecoveryVerdict(request, verdict: RecoveryVerdict) {
      const to = authorize(request, 'sealRecoveryVerdict', false)
      if (
        !isRecoveryVerdict(verdict) ||
        verdict.groupID !== groupID ||
        verdict.requestID !== to.requestID
      )
        throw new Error('Verdict does not bind request')
      return sealReply(
        SEAL_DOMAIN.verdict,
        to,
        fromUTF(JSON.stringify({ signer: localDID, verdict })),
      )
    },
    async openRecoveryVerdict(sealed, requestID, requestKey) {
      const opened = openReply(SEAL_DOMAIN.verdict, sealed, requestID, requestKey)
      if (opened == null) return null
      try {
        const value = JSON.parse(toUTF(opened)) as OpenedRecoveryVerdict
        if (
          typeof value.signer !== 'string' ||
          !isRecoveryVerdict(value.verdict) ||
          value.verdict?.groupID !== groupID ||
          value.verdict.requestID !== requestID
        )
          return null
        return value
      } catch {
        return null
      }
    },
    sealGroupInfo: sealInfo,
    async sealLedger(request: Uint8Array) {
      // The same roster check, and it is the whole authorization: the ledger is the group's
      // authority state, and the topic it goes out on is public. A responder that sealed
      // without checking would hand every role to any stranger who minted a request.
      const to = authorize(request, 'sealLedger')
      // Sealed to the requester's ephemeral key, and NOT under this responder's epoch secret:
      // the requester may be at an older epoch than this responder, and a reply it cannot open
      // is a peer left stranded with an empty ledger, reporting itself healthy.
      return sealReply(SEAL_DOMAIN.ledger, to, fromUTF(JSON.stringify(serveLedger(ledgerTokens()))))
    },
    async openSealedLedger(sealed: Uint8Array, requestID: string, requestKey: Uint8Array) {
      // The key is NOT consumed: every responder answers a gather, and a requester that drops
      // a lying responder's reply must still be able to open the next honest one.
      const opened = openReply(SEAL_DOMAIN.ledger, sealed, requestID, requestKey)
      if (opened == null) return null
      try {
        const tokens = JSON.parse(toUTF(opened)) as Array<string>
        if (!Array.isArray(tokens) || tokens.some((token) => typeof token !== 'string')) return null
        return tokens
      } catch {
        return null
      }
    },
    async applyRecovery(
      sealed: Uint8Array,
      requestID: string,
      requestKey: Uint8Array,
    ): Promise<PendingRecovery | { renewalRequired: true } | null> {
      const info = open(sealed, requestID, requestKey)
      if (info == null) return null
      if (!prepared) await prepare()
      if (binding != null && !usable(preparedBinding)) {
        preparedBinding = await askBinding()
        if (!usable(preparedBinding)) return { renewalRequired: true }
      }
      return makePending(
        info,
        requestID,
        requestKey,
        preparedBinding == null ? undefined : structuredClone(preparedBinding),
      )
    },
    async restoreRecovery(bytes, requestKey) {
      const opened = openWithKey(
        sha256(requestKey),
        sealContext('candidate', groupID, localDID ?? '', groupID),
        bytes,
      )
      if (opened == null) throw new Error('Invalid recovery candidate')
      const snapshot = JSON.parse(toUTF(opened)) as {
        info: MemoryGroupInfo
        requestID: string
        candidateBinding?: MemoryRecoveryBinding
        tuple?: { position: string; commitDigest: string; tag: string }
      }
      if (
        snapshot.info?.groupID !== groupID ||
        snapshot.info.to !== (localDID ?? '') ||
        snapshot.info.requestID !== snapshot.requestID
      )
        throw new Error('Invalid recovery candidate')
      return makePending(
        snapshot.info,
        snapshot.requestID,
        requestKey,
        snapshot.candidateBinding,
        snapshot.tuple,
      )
    },
    exportRecoverySecret() {
      return recoverySecret
    },
  }
}

export function decodeMemoryGroupIdentity(
  state: Uint8Array,
  key: GroupKey,
  recoverySecret: Uint8Array,
): EpochIdentity {
  const value = JSON.parse(toUTF(state)) as {
    epoch: number
    slots: Array<[number, string]>
    ledgerHead: string
    recoveryAuthenticator?: string
    epochIdentity?: string
  }
  const encoded = value.recoveryAuthenticator ?? value.epochIdentity
  const authenticator =
    encoded === undefined
      ? sha256(
          concatBytes(
            recoverySecret,
            fromUTF(key.groupID),
            fromUTF(
              JSON.stringify({
                epoch: value.epoch,
                slots: value.slots,
                ledgerHead: value.ledgerHead,
              }),
            ),
          ),
        )
      : fromB64U(encoded)
  return { ...key, epoch: value.epoch, authenticator }
}
