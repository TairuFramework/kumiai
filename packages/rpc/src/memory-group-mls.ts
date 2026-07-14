import { sha256 } from '@noble/hashes/sha2.js'
import { fromUTF, toB64U, toUTF } from '@sozai/codec'

import type { CommitContext, CommitHeader, GroupMLS, PendingRecovery } from './crypto.js'

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
  /** Called whenever the modelled epoch advances (e.g. to keep a GroupCrypto in step). */
  onAdvance?: (epoch: number) => void
}

/** The port raises this when a Commit names entry bodies it cannot resolve — from the
 *  frame the commit rides in, or from any resolver the lane supplies. The lane does not
 *  classify it: a throw leaves the cursor where it was, and the frame is read again. */
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
  options: { head?: string; external?: boolean } = {},
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
  }
  return fromUTF(JSON.stringify(commit))
}

export function decodeMemoryCommit(commit: Uint8Array): MemoryCommit | null {
  if (commit.length === 0) return null
  try {
    const value = JSON.parse(toUTF(commit)) as MemoryCommit
    if (
      typeof value?.epoch !== 'number' ||
      typeof value?.committerDID !== 'string' ||
      (value.head != null && typeof value.head !== 'string') ||
      !Array.isArray(value.entryIDs)
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

type MemoryRecoveryRequest = { requestID: string; requesterDID: string }

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
  /** Ephemeral private keys, keyed by requestID — modelled as the DID a reply must be sealed
   *  to. Retained by the port between the request and the reply, exactly as the real one is. */
  const ephemeralKeys = new Map<string, string>()
  let failRecoveryAdopt = false

  const advance = (to: number): void => {
    epoch = to
    options.onAdvance?.(epoch)
  }

  const seal = (info: MemoryGroupInfo): Uint8Array => fromUTF(JSON.stringify(info))

  const open = (sealed: Uint8Array, requestID: string): MemoryGroupInfo | null => {
    let info: MemoryGroupInfo
    try {
      info = JSON.parse(toUTF(sealed)) as MemoryGroupInfo
    } catch {
      return null // hub-injected bytes: not a reply at all
    }
    if (typeof info?.to !== 'string' || typeof info?.epoch !== 'number') return null
    // The ephemeral key minted for THIS request is the only thing that opens a reply: one
    // sealed to another member, or to another request by this member, does not open at all.
    if (ephemeralKeys.get(requestID) !== info.to) return null
    if (info.requestID !== requestID) return null
    return info
  }

  const enact = (parsed: MemoryCommit): void => {
    ledger.push(...parsed.entryIDs)
    // The head is the committer's, not this receiver's: a handle whose ledger is incomplete
    // must stay visibly incomplete rather than re-anchor on its own truncated fold. A commit
    // that enacted nothing carries none, and leaves the head where it found it.
    if (parsed.head != null) ledgerHead = parsed.head
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
    readCommitHeader(commit: Uint8Array): CommitHeader | null {
      // Reads the commit's own bytes and nothing else: no epoch secret, no blob, no state.
      const parsed = decodeMemoryCommit(commit)
      return parsed == null ? null : { epoch: parsed.epoch, committerDID: parsed.committerDID }
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
      // The ephemeral key, minted per request and retained by the port: the reply is sealed
      // to it, and to nothing this peer's leaf can be read out of.
      const requesterDID = localDID ?? ''
      ephemeralKeys.set(requestID, requesterDID)
      return fromUTF(JSON.stringify({ requestID, requesterDID } satisfies MemoryRecoveryRequest))
    },
    async sealGroupInfo(request: Uint8Array) {
      let parsed: MemoryRecoveryRequest
      try {
        parsed = JSON.parse(toUTF(request)) as MemoryRecoveryRequest
      } catch {
        throw new Error('sealGroupInfo: the request does not parse')
      }
      if (typeof parsed?.requesterDID !== 'string' || typeof parsed?.requestID !== 'string') {
        throw new Error('sealGroupInfo: the request is malformed')
      }
      // Roster-intrinsic authorization: the only DIDs that can be answered are the ones this
      // responder's own tree still carries a leaf for.
      if (!leaves.includes(parsed.requesterDID)) {
        throw new Error(`sealGroupInfo: ${parsed.requesterDID} has no leaf in the current tree`)
      }
      return seal({
        to: parsed.requesterDID,
        requestID: parsed.requestID,
        epoch,
        // The AUTHENTICATED head, and no ledger with it. This is what the rejoined handle
        // will hold, and why its empty ledger reads incomplete rather than complete-and-empty.
        head: ledgerHead,
      })
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
