/**
 * The app-lane anchor: the per-epoch secret and the epoch it was exported at, together. Both
 * halves feed the topic derivation, so they only ever move as a pair — a secret from one epoch
 * with another epoch's number derives a topic no member is on.
 */
export type Anchor = {
  secret: Uint8Array<ArrayBufferLike>
  epoch: number
}

/** One durable anchor and the advance whose rotation is still unresolved. */
export type AnchorSlot = {
  anchor: Anchor
  pending?: {
    epochBefore: number
    epochAfter: number
    rosterBefore: Array<string>
    forced: boolean
    advance: string
  }
}

/**
 * Durable single slot, owned by one live peer. Each record spans one advance and resolves before another.
 * Only the same advance retries an ambiguous record. Known-unlanded advances clear pending.
 */
export type AnchorStore = {
  load(): Promise<AnchorSlot | null>
  save(slot: AnchorSlot): Promise<void>
}
