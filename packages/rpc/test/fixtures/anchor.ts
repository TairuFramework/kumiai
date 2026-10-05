import type { Anchor, AnchorSlot, AnchorStore } from '../../src/anchor.js'

export type MemoryAnchorStore = AnchorStore & {
  /** What the store holds right now, or null. A restart keeps it: that is the whole point. */
  stored: () => Anchor | null
  /** All durable slot writes, including rotation records. */
  saves: () => number
  /** Saves carrying a newly captured anchor, genesis included. */
  captures: () => number
}

export type MemoryAnchorStoreOptions = {
  /** Pre-seed the slot: a peer that already anchored and is now booting over that state. */
  anchor?: Anchor | null
}

/**
 * A host's durable anchor store, in memory. Surviving a "restart" is just handing the same
 * instance to the new peer — which is exactly what durability buys, and the whole subject here:
 * the anchor cannot be re-derived, because a rebooted handle can never re-export the secret of
 * the epoch the anchor sits at.
 */
export function createMemoryAnchorStore(options: MemoryAnchorStoreOptions = {}): MemoryAnchorStore {
  let slot: AnchorSlot | null = options.anchor == null ? null : { anchor: options.anchor }
  let saves = 0
  let captures = 0

  return {
    async load() {
      return slot
    },
    async save(next: AnchorSlot) {
      if (next.anchor !== slot?.anchor) captures += 1
      saves += 1
      slot = next
    },
    stored: () => slot?.anchor ?? null,
    saves: () => saves,
    captures: () => captures,
  }
}
