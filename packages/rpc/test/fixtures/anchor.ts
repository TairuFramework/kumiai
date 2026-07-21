import type { Anchor, AnchorStore } from '../../src/anchor.js'

export type MemoryAnchorStore = AnchorStore & {
  /** What the store holds right now, or null. A restart keeps it: that is the whole point. */
  stored: () => Anchor | null
  /** How many rotations were written. One per capture — genesis seed included. */
  saves: () => number
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
  let anchor: Anchor | null = options.anchor ?? null
  let saves = 0

  return {
    async load() {
      return anchor
    },
    async save(next: Anchor) {
      saves += 1
      anchor = next
    },
    stored: () => anchor,
    saves: () => saves,
  }
}
