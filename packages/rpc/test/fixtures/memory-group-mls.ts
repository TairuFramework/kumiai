import { x25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromB64U, fromUTF, toB64U, toUTF } from '@sozai/codec'

import type { CommitContext, CommitHeader, GroupMLS, PendingRecovery } from '../../src/crypto.js'

export type MemoryGroupMLS = GroupMLS & {
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
  /**
   * The ledger folded, last-write-wins by position: `subject=value` tokens reduced in the
   * order the ledger holds them. It is the whole reason re-enactment is filtered — the fold
   * has no dedup, so an entry appended a second time WINS, whatever it said the first time.
   */
  fold: () => Map<string, string>
  /** The members this handle's ratchet tree holds a leaf for, one entry per leaf. */
  leaves: () => Array<string>
  /**
   * Produce a Commit at this member's CURRENT epoch, enacting these signed tokens. Like
   * the real thing it is non-mutating: the group advances when the commit is adopted,
   * so the bodies can still be sealed under the epoch every receiver is at.
   *
   * The Commit carries its committer, as a real one does — the author is authenticated by
   * the Commit's own signature, not by whoever handed it to the hub.
   */
  buildCommit: (tokens?: Array<string>) => Uint8Array
  /** Adopt a Commit this member produced: enact its entries and advance. */
  adopt: (commit: Uint8Array) => void
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

export type MemoryGroupMLSOptions = {
  recoverySecret?: Uint8Array
  epoch?: number
  /** This member's DID — the committer stamped into the Commits it builds, and the modelled
   *  recipient of GroupInfo sealed to its leaf. */
  localDID?: string
  /** Signed tokens whose BODIES this member holds — a joiner's Welcome carries them, and a
   *  member that resolved them from a commit frame keeps them. Holding a body is not the
   *  same as having enacted it: the ledger is what a commit enacted, and it starts empty. */
  bodies?: Array<string>
  /** The members this handle's tree holds a leaf for. Defaults to this member alone. */
  members?: Array<string>
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
 * Both the epoch and the committer live INSIDE the commit, and both are what make the double
 * faithful about the things this lane turns on. A real MLS Commit can only be applied by a
 * member AT the epoch it was framed at, and cannot even be decrypted by one that is not. And
 * a real MLS Commit authenticates its own author, with the Commit's own signature — so a
 * peer asking "did I write this?" reads the commit, and never the frame's transport sender,
 * which is only the hub's word about who handed it over.
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
    ...(head != null ? { head } : {}),
    ...(options.external === true ? { external: true } : {}),
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
      typeof value?.epoch !== 'number' ||
      typeof value?.committerDID !== 'string' ||
      (value.head != null && typeof value.head !== 'string') ||
      (value.external != null && typeof value.external !== 'boolean') ||
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
type MemoryGroupInfo = { to: string; requestID: string; epoch: number; head: string }

/**
 * The request a peer publishes to ask the group for its state. The requester's DID and the
 * ephemeral PUBLIC key its reply must be sealed to ride inside it — modelling the signed
 * token the real port mints, whose signature covers both.
 */
type MemoryRecoveryRequest = { requestID: string; requesterDID: string; ephemeralKey: string }

/**
 * What a sealed reply answers. The two answers are NOT interchangeable, and the separation is
 * in the seal rather than in a field a reader could forget to compare: the label goes into the
 * key derivation and into the tag, so a GroupInfo does not open as a ledger even when the
 * group, the member, the request id and the ephemeral key are all the same.
 */
const SEAL_DOMAIN = {
  groupInfo: 'kumiai/memory-recovery/group-info/v1',
  ledger: 'kumiai/memory-recovery/ledger/v1',
} as const

/** enc(32) + tag(16): the shortest well-formed sealed reply. */
const MIN_SEALED_LENGTH = 32 + 16

function concatBytes(parts: Array<Uint8Array>): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** SHA-256 in counter mode: enough keystream for a payload of any length. */
function keystream(seed: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let offset = 0, counter = 0; offset < length; offset += 32, counter++) {
    const block = sha256(concatBytes([seed, fromUTF(`/${counter}`)]))
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
 * The bytes a reply is bound to: the KIND of answer, the group member it is for, and the
 * request it answers. Bound into the key and into the tag, so a reply for another member, for
 * another request, or to another question does not open at all — it is never a field compared
 * after decryption.
 */
function sealContext(domain: string, requesterDID: string, requestID: string): Uint8Array {
  return fromUTF(`${domain}|${requesterDID}|${requestID}`)
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
  const ct = xorWith(payload, keystream(concatBytes([shared, enc, context]), payload.length))
  const tag = sha256(concatBytes([shared, context, ct])).subarray(0, 16)
  return concatBytes([enc, tag, ct])
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
  const expected = sha256(concatBytes([shared, context, ct])).subarray(0, 16)
  for (let i = 0; i < 16; i++) {
    if (tag[i] !== expected[i]) return null
  }
  return xorWith(ct, keystream(concatBytes([shared, enc, context]), ct.length))
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
  const recoverySecret = options.recoverySecret ?? new Uint8Array(32).fill(0x33)
  const localDID = options.localDID
  const acceptsCommitter = options.acceptsCommitter ?? (() => true)
  const serveLedger = options.serveLedger ?? ((ledger: Array<string>) => ledger)
  let epoch = options.epoch ?? 0
  let commits = 0
  let seen = 0
  let lastSender: string | undefined
  /** The entries this handle has ENACTED, in order. A rejoined handle holds none. */
  let ledger: Array<string> = []
  /** The head this handle's group state attests to. Genesis until a commit moves it. */
  let ledgerHead = memoryLedgerHead([])
  /** Entry bodies by content id — what this member can serve, and what it can enact. */
  const bodies = new Map<string, string>()
  for (const token of options.bodies ?? []) bodies.set(memoryEntryID(token), token)
  const leaves: Array<string> = [...(options.members ?? (localDID != null ? [localDID] : []))]
  /**
   * Ephemeral PRIVATE keys, keyed by requestID: minted with the request, retained by the port
   * until the reply is opened, and never on the wire. It is the whole of what makes a reply
   * openable by this peer and by nobody else — the hub holds every other input.
   */
  const ephemeralKeys = new Map<string, Uint8Array>()
  let failRecoveryAdopt = false

  const advance = (to: number): void => {
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
  const authorize = (request: Uint8Array, label: string): MemoryRecoveryRequest => {
    let parsed: MemoryRecoveryRequest
    try {
      parsed = JSON.parse(toUTF(request)) as MemoryRecoveryRequest
    } catch {
      throw new Error(`${label}: the request does not parse`)
    }
    if (
      typeof parsed?.requesterDID !== 'string' ||
      typeof parsed?.requestID !== 'string' ||
      typeof parsed?.ephemeralKey !== 'string'
    ) {
      throw new Error(`${label}: the request is malformed`)
    }
    if (!leaves.includes(parsed.requesterDID)) {
      throw new Error(`${label}: ${parsed.requesterDID} has no leaf in the current tree`)
    }
    return parsed
  }

  const sealReply = (domain: string, to: MemoryRecoveryRequest, payload: Uint8Array): Uint8Array =>
    sealToKey(
      fromB64U(to.ephemeralKey),
      sealContext(domain, to.requesterDID, to.requestID),
      payload,
    )

  const openReply = (domain: string, sealed: Uint8Array, requestID: string): Uint8Array | null => {
    const privateKey = ephemeralKeys.get(requestID)
    if (privateKey == null) return null
    return openWithKey(privateKey, sealContext(domain, localDID ?? '', requestID), sealed)
  }

  const open = (sealed: Uint8Array, requestID: string): MemoryGroupInfo | null => {
    const opened = openReply(SEAL_DOMAIN.groupInfo, sealed, requestID)
    if (opened == null) return null
    let info: MemoryGroupInfo
    try {
      info = JSON.parse(toUTF(opened)) as MemoryGroupInfo
    } catch {
      return null
    }
    if (typeof info?.to !== 'string' || typeof info?.epoch !== 'number') return null
    if (info.requestID !== requestID) return null
    return info
  }

  const enact = (parsed: MemoryCommit): void => {
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
      for (const did of parsed.removes) {
        for (let i = leaves.length - 1; i >= 0; i--) {
          if (leaves[i] === did) leaves.splice(i, 1)
        }
      }
    }
    if (parsed.adds != null) {
      for (const did of parsed.adds) {
        if (!leaves.includes(did)) leaves.push(did)
      }
    }
    if (parsed.external) {
      // `resync: true`: the rejoining member's prior leaf is atomically removed, so a peer
      // that rejoined twice — an orphaned external commit, then a fresh one — leaves one leaf
      // behind and not two.
      for (let i = leaves.length - 1; i >= 0; i--) {
        if (leaves[i] === parsed.committerDID) leaves.splice(i, 1)
      }
      leaves.push(parsed.committerDID)
    }
    advance(epoch + 1)
  }

  const ledgerTokens = (): Array<string> =>
    ledger.flatMap((id) => {
      const token = bodies.get(id)
      return token == null ? [] : [token]
    })

  return {
    epoch: () => epoch,
    commits: () => commits,
    seen: () => seen,
    lastSender: () => lastSender,
    ledgerIDs: () => [...ledger],
    leaves: () => [...leaves],
    async rosterDIDs() {
      return [...leaves]
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
    buildCommit(tokens: Array<string> = []) {
      const entryIDs = tokens.map((token) => {
        const id = memoryEntryID(token)
        bodies.set(id, token)
        return id
      })
      return encodeMemoryCommit(epoch, localDID ?? '', entryIDs, {
        head: memoryLedgerHead([...ledger, ...entryIDs]),
      })
    },
    adopt(commit: Uint8Array) {
      const parsed = decodeMemoryCommit(commit)
      if (parsed == null || parsed.epoch !== epoch) {
        throw new Error("adopt: not a commit framed at this member's current epoch")
      }
      enact(parsed)
    },
    evict(did: string) {
      for (let i = leaves.length - 1; i >= 0; i--) {
        if (leaves[i] === did) leaves.splice(i, 1)
      }
    },
    async readCommitHeader(commit: Uint8Array): Promise<CommitHeader | null> {
      // Reads the commit's own bytes and nothing else: no epoch secret, no blob, no state.
      // `external` included: a real one is structural too — a public message from a non-member
      // carrying a commit — and it is the ONLY thing a rejoin changes that a reader can see.
      const parsed = decodeMemoryCommit(commit)
      return parsed == null
        ? null
        : {
            epoch: parsed.epoch,
            committerDID: parsed.committerDID,
            ...(parsed.external === true ? { external: true } : {}),
          }
    },
    async processCommit(commit: Uint8Array, context: CommitContext) {
      lastSender = context.senderDID
      seen += 1
      const parsed = decodeMemoryCommit(commit)
      if (parsed == null) {
        return { advanced: false }
      }
      // A Commit framed at another epoch is not this member's to apply: real MLS cannot
      // decrypt it at all. Ordinary history for a member walking the log — the late
      // joiner's own add-commit is exactly this — and NOT corruption. The blob riding it
      // is never opened, because the entries are never resolved.
      if (parsed.epoch !== epoch) {
        return { advanced: false }
      }
      // A Commit that REMOVES this member is one it can never apply: the commit's path excludes
      // the leaf it drops, so the removed member is handed nothing to derive the new epoch's
      // secrets from. Its handle stops here, at the last epoch it holds — and that is what
      // cutting a member off means. It keeps every secret it ever exported and every topic it
      // ever derived; the per-epoch secret is what it cannot follow.
      //
      // `{ advanced: false }`, not a throw: the frame is well-formed and there is nothing to
      // retry. The tree is left alone too — a member that cannot apply the commit does not learn
      // its roster from it, so it goes on holding the stale view it had.
      if (localDID != null && parsed.removes?.includes(localDID)) {
        return { advanced: false }
      }
      // A member can never apply the frame that is its OWN commit: MLS merges a pending
      // commit, it does not process one, and the pending state is the only thing that could
      // have carried it. A member that meets its own commit in the log has lost that state,
      // and no amount of processing will get it back. An external commit is the exception
      // that proves it — the rejoining member adopts the handle its own rejoin derived.
      if (localDID != null && parsed.committerDID === localDID) {
        return { advanced: false }
      }
      // Well-formed, and refused: the group's policy does not accept commits from this
      // committer. A refusal is NOT a throw — the peer read the commit, judged it, and
      // declined it, and there is nothing to retry.
      if (!acceptsCommitter(parsed.committerDID)) {
        return { advanced: false }
      }
      const missing = parsed.entryIDs.filter((id) => !bodies.has(id))
      if (missing.length > 0) {
        const tokens = (await context.resolveLedgerEntries?.(missing)) ?? []
        for (const token of tokens) {
          const id = memoryEntryID(token)
          // Content-addressed: a body binds to the id it hashes to, or it is ignored.
          if (missing.includes(id)) bodies.set(id, token)
        }
        const stillMissing = parsed.entryIDs.filter((id) => !bodies.has(id))
        if (stillMissing.length > 0) {
          throw new MissingLedgerEntriesError(stillMissing)
        }
      }
      commits += 1
      enact(parsed)
      return { advanced: true }
    },
    async isLedgerComplete() {
      return memoryLedgerHead(ledger) === ledgerHead
    },
    async getLedger() {
      return ledgerTokens()
    },
    async bootstrapLedger(tokens: Array<string>) {
      // The gate, and nothing below it touches the handle until the check has passed: the
      // head is recomputed over the gathered ids IN THE ORDER GIVEN and compared against the
      // one this handle's own group state carries. A rejected ledger writes nothing.
      const entryIDs = tokens.map(memoryEntryID)
      if (memoryLedgerHead(entryIDs) !== ledgerHead) {
        throw new LedgerIncompleteError(
          'bootstrapLedger: the gathered ledger does not fold to the head this group attests to',
        )
      }
      for (const token of tokens) bodies.set(memoryEntryID(token), token)
      // A REPLACEMENT, not an append: a list that reproduces the authenticated head is the
      // group's entire ledger, in order.
      ledger = entryIDs
    },
    async createRecoveryRequest(requestID: string) {
      // The ephemeral keypair, minted per request: the private half is retained here and the
      // public half goes on the wire. It is the only key a reply is ever sealed to, and it is
      // nothing this peer's leaf can be read out of — the peers that most need a heal no
      // longer hold the leaf key the group can see.
      //
      // ONE mint serves both gathers. A rejoin and a bootstrap are the same rendezvous asking
      // two questions, and a second request format would be a second thing to get wrong.
      const requesterDID = localDID ?? ''
      const privateKey = x25519.utils.randomSecretKey()
      ephemeralKeys.set(requestID, privateKey)
      return fromUTF(
        JSON.stringify({
          requestID,
          requesterDID,
          ephemeralKey: toB64U(x25519.getPublicKey(privateKey)),
        } satisfies MemoryRecoveryRequest),
      )
    },
    async sealGroupInfo(request: Uint8Array) {
      const to = authorize(request, 'sealGroupInfo')
      return sealReply(
        SEAL_DOMAIN.groupInfo,
        to,
        fromUTF(
          JSON.stringify({
            to: to.requesterDID,
            requestID: to.requestID,
            epoch,
            // The AUTHENTICATED head, and no ledger with it. This is what the rejoined handle
            // will hold, and why its empty ledger reads incomplete rather than
            // complete-and-empty.
            head: ledgerHead,
          } satisfies MemoryGroupInfo),
        ),
      )
    },
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
    async openSealedLedger(sealed: Uint8Array, requestID: string) {
      // The key is NOT consumed: every responder answers a gather, and a requester that drops
      // a lying responder's reply must still be able to open the next honest one.
      const opened = openReply(SEAL_DOMAIN.ledger, sealed, requestID)
      if (opened == null) return null
      try {
        const tokens = JSON.parse(toUTF(opened)) as Array<string>
        if (!Array.isArray(tokens) || tokens.some((token) => typeof token !== 'string')) return null
        return tokens
      } catch {
        return null
      }
    },
    async applyRecovery(sealed: Uint8Array, requestID: string): Promise<PendingRecovery | null> {
      const info = open(sealed, requestID)
      if (info == null) return null
      ephemeralKeys.delete(requestID)
      // The external commit is framed at the epoch the GroupInfo described — the epoch the
      // group is at, which is NOT the epoch this peer is at. Every member that can apply it
      // is at that epoch, so a GroupInfo the group has already moved past builds a commit
      // nobody will apply, which is why losing the compare-and-set discards the GroupInfo
      // and not merely the commit.
      const commit = encodeMemoryCommit(info.epoch, localDID ?? '', [], {
        head: info.head,
        external: true,
      })
      return {
        commit,
        onAccepted: async () => {
          if (failRecoveryAdopt) {
            failRecoveryAdopt = false
            throw new Error('the process died in the acceptance window')
          }
          // The rejoined handle: at the group's next epoch, holding the group's
          // authenticated ledger head — and an EMPTY ledger. That is a roster reset, and it
          // stands until the ledger is bootstrapped.
          ledger = []
          ledgerHead = info.head
          for (let i = leaves.length - 1; i >= 0; i--) {
            if (leaves[i] === localDID) leaves.splice(i, 1)
          }
          if (localDID != null) leaves.push(localDID)
          advance(info.epoch + 1)
        },
      }
    },
    exportRecoverySecret() {
      return recoverySecret
    },
  }
}
