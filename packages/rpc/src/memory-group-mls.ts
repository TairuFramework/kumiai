import { fromUTF, toUTF } from '@sozai/codec'

import type { CommitContext, GroupMLS } from './crypto.js'

export type MemoryGroupMLS = GroupMLS & {
  epoch: () => number
  commits: () => number
  lastSender: () => string | undefined
}

export type MemoryGroupMLSOptions = {
  recoverySecret?: Uint8Array
  epoch?: number
  /** This member's DID — modelled recipient of GroupInfo sealed to its leaf. */
  localDID?: string
  /** Called whenever the modelled epoch advances (e.g. to keep a GroupCrypto in step). */
  onAdvance?: (epoch: number) => void
}

/**
 * In-memory {@link GroupMLS} for exercising peer orchestration WITHOUT real MLS —
 * the group-rpc analogue of `createMemoryBus`. It models a single epoch counter:
 * a non-empty Commit advances it; GroupInfo carries the epoch so a stranded peer
 * can jump forward. The recovery secret is fixed for the instance's life
 * (epoch-independent). NOT real cryptography — a test double for wiring, not a
 * production implementation (a real port adapts a live MLS group).
 */
export function createMemoryGroupMLS(options: MemoryGroupMLSOptions = {}): MemoryGroupMLS {
  const recoverySecret = options.recoverySecret ?? new Uint8Array(32).fill(0x33)
  const localDID = options.localDID
  let epoch = options.epoch ?? 0
  let commits = 0
  let lastSender: string | undefined

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

  return {
    epoch: () => epoch,
    commits: () => commits,
    lastSender: () => lastSender,
    async processCommit(commit: Uint8Array, context: CommitContext) {
      lastSender = context.senderDID
      if (commit.length === 0) {
        return { advanced: false }
      }
      commits += 1
      advance(epoch + 1)
      return { advanced: true }
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
