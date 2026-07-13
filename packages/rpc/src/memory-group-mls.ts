import { sha256 } from '@noble/hashes/sha2.js'
import { fromUTF, toB64U, toUTF } from '@sozai/codec'

import type { CommitContext, GroupMLS } from './crypto.js'

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
   * Produce a Commit at this member's CURRENT epoch, enacting these signed tokens. Like
   * the real thing it is non-mutating: the group advances when the commit is adopted,
   * so the bodies can still be sealed under the epoch every receiver is at.
   */
  buildCommit: (tokens?: Array<string>) => Uint8Array
  /** Adopt a Commit this member produced: enact its entries and advance. */
  adopt: (commit: Uint8Array) => void
}

export type MemoryGroupMLSOptions = {
  recoverySecret?: Uint8Array
  epoch?: number
  /** This member's DID — modelled recipient of GroupInfo sealed to its leaf. */
  localDID?: string
  /** Signed tokens this member already holds — a joiner's Welcome carries the group's
   *  history, so the entries enacted before it joined are in the handle it starts from. */
  ledger?: Array<string>
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

/** The content id of a signed token: its digest. Content-addressing is what binds an
 *  untrusted body to the id a Commit names. */
export function memoryEntryID(token: string): string {
  return toB64U(sha256(fromUTF(token)))
}

type MemoryCommit = { epoch: number; entryIDs: Array<string> }

/**
 * A Commit for the memory port: the epoch it was framed at, and the content ids of the
 * ledger entries it enacts. The epoch is what makes the double faithful about the thing
 * this lane turns on — a real MLS Commit can only be applied by a member AT the epoch it
 * was framed at, and cannot even be decrypted by one that is not.
 */
export function encodeMemoryCommit(epoch: number, entryIDs: Array<string> = []): Uint8Array {
  return fromUTF(JSON.stringify({ epoch, entryIDs } satisfies MemoryCommit))
}

function decodeMemoryCommit(commit: Uint8Array): MemoryCommit | null {
  if (commit.length === 0) return null
  try {
    const value = JSON.parse(toUTF(commit)) as MemoryCommit
    if (typeof value?.epoch !== 'number' || !Array.isArray(value.entryIDs)) return null
    return value
  } catch {
    return null
  }
}

/**
 * In-memory {@link GroupMLS} for exercising peer orchestration WITHOUT real MLS —
 * the group-rpc analogue of `createMemoryBus`. It models an epoch counter and a
 * control ledger: a Commit is framed at an epoch and names the entries it enacts,
 * a member applies only Commits framed at the epoch it is at, and the bodies of the
 * entries it does not hold are resolved from the commit's own frame. GroupInfo carries
 * the epoch so a stranded peer can jump forward. The recovery secret is fixed for the
 * instance's life (epoch-independent). NOT real cryptography — a test double for
 * wiring, not a production implementation (a real port adapts a live MLS group).
 */
export function createMemoryGroupMLS(options: MemoryGroupMLSOptions = {}): MemoryGroupMLS {
  const recoverySecret = options.recoverySecret ?? new Uint8Array(32).fill(0x33)
  const localDID = options.localDID
  let epoch = options.epoch ?? 0
  let commits = 0
  let seen = 0
  let lastSender: string | undefined
  const ledger: Array<string> = []
  /** Entry bodies by content id — what this member can serve, and what it can enact. */
  const bodies = new Map<string, string>()
  for (const token of options.ledger ?? []) bodies.set(memoryEntryID(token), token)

  const advance = (to: number): void => {
    epoch = to
    options.onAdvance?.(epoch)
  }

  // Seal = [didLen(2)][requesterDID][epoch(1)]. NOT real crypto — a test double
  // that models "only the sealed-to member can open it".
  const seal = (requesterDID: string, epochByte: number): Uint8Array => {
    const did = fromUTF(requesterDID)
    const out = new Uint8Array(2 + did.length + 1)
    new DataView(out.buffer).setUint16(0, did.length, true)
    out.set(did, 2)
    out[2 + did.length] = epochByte
    return out
  }

  const open = (sealed: Uint8Array): number | undefined => {
    if (sealed.length < 3) return undefined
    const didLen = new DataView(sealed.buffer, sealed.byteOffset, sealed.byteLength).getUint16(
      0,
      true,
    )
    if (sealed.length < 2 + didLen + 1) return undefined
    const sealedTo = toUTF(sealed.subarray(2, 2 + didLen))
    // A member with a set localDID can open only bytes sealed to it. When unset,
    // the double is permissive (used by wiring tests that don't assert sealing).
    if (localDID != null && sealedTo !== localDID) return undefined
    return sealed[2 + didLen]
  }

  const enact = (parsed: MemoryCommit): void => {
    ledger.push(...parsed.entryIDs)
    advance(epoch + 1)
  }

  return {
    epoch: () => epoch,
    commits: () => commits,
    seen: () => seen,
    lastSender: () => lastSender,
    ledgerIDs: () => [...ledger],
    buildCommit(tokens: Array<string> = []) {
      const entryIDs = tokens.map((token) => {
        const id = memoryEntryID(token)
        bodies.set(id, token)
        return id
      })
      return encodeMemoryCommit(epoch, entryIDs)
    },
    adopt(commit: Uint8Array) {
      const parsed = decodeMemoryCommit(commit)
      if (parsed == null || parsed.epoch !== epoch) {
        throw new Error("adopt: not a commit framed at this member's current epoch")
      }
      enact(parsed)
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
    async getLedgerEntries(ids: Array<string>) {
      return ids.flatMap((id) => {
        const token = bodies.get(id)
        return token == null ? [] : [token]
      })
    },
    async exportGroupInfo(requesterDID: string) {
      return seal(requesterDID, epoch)
    },
    async applyRecovery(groupInfo: Uint8Array) {
      const target = open(groupInfo)
      if (target == null || target <= epoch) {
        return { advanced: false }
      }
      advance(target)
      return { advanced: true }
    },
    exportRecoverySecret() {
      return recoverySecret
    },
  }
}
