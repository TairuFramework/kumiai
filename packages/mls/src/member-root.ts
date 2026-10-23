import { readCapability } from './capability.js'
import type { ControllerBinding } from './credential.js'
import { LeafBindingError } from './errors.js'

export type MemberRoot =
  | { kind: 'root'; controller: string }
  | { kind: 'member'; did: string; add: string; gen: number }

export type EvidenceSlot = 'capability' | 'parent' | 'holder' | 'membership' | 'survivor'

export type ProofRef =
  | { chainIndex: number }
  | { snapshot: number }
  | { event: string; epoch?: string }

export type EffectClaim =
  | { kind: 'deny'; did: string; ref: ProofRef }
  | { kind: 'remove'; member: { did: string; add: string }; ref: ProofRef }

export type RemovedMember = { did: string; gen: number; proofRef: ProofRef }
export type RemovedEffect = { did: string; cascadedFrom: string }

/** Decode only; callers authenticate the tokens and membership references. */
export function memberRootsOf(
  binding: ControllerBinding,
  leafDID: string,
): Array<{ slot: EvidenceSlot; root: MemberRoot }> {
  const tokenRoot = (raw: string): MemberRoot => {
    const { iss, mbr } = readCapability(raw).payload
    return mbr == null
      ? { kind: 'root', controller: binding.id }
      : { kind: 'member', did: iss, add: mbr.add, gen: mbr.g }
  }
  if (binding.member != null) {
    return [
      {
        slot: 'membership',
        root: { kind: 'member', did: leafDID, add: binding.member.add, gen: binding.member.g },
      },
    ]
  }
  if (binding.capability == null) throw new LeafBindingError('controller-mismatch')
  const { cap } = readCapability(binding.capability).payload
  const parent = Array.isArray(cap) ? cap[0] : cap
  const roots: Array<{ slot: EvidenceSlot; root: MemberRoot }> = [
    parent == null
      ? { slot: 'capability', root: tokenRoot(binding.capability) }
      : { slot: 'parent', root: tokenRoot(parent) },
  ]
  if (binding.holderGrant != null)
    roots.push({ slot: 'holder', root: tokenRoot(binding.holderGrant) })
  return roots
}
