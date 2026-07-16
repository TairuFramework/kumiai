/**
 * The app-lane anchor: the per-epoch secret and the epoch it was exported at, together. Both
 * halves feed the topic derivation, so they only ever move as a pair — a secret from one epoch
 * with another epoch's number derives a topic no member is on.
 */
export type Anchor = {
  secret: Uint8Array<ArrayBufferLike>
  epoch: number
}

/**
 * The host's durable store for the app-lane anchor. One slot, overwritten on every rotation and
 * never cleared: the anchor is state a peer holds for its whole life in the group, not a record
 * of something in flight.
 *
 * It exists because the anchor is PERSISTED STATE and cannot be re-derived. The anchor sits at
 * the last roster change, the live handle runs ahead of it, and MLS ratchets forward: a rebooted
 * handle can never re-export an earlier epoch's secret. A peer that re-seeded from its live
 * handle at construction would derive different topic IDs from every member that did not restart
 * — neither would see the other's app traffic, with nothing anywhere to report it.
 *
 * `load` returning `null` means first boot and only first boot: the peer seeds the anchor from
 * its handle, as a group with no roster change yet must, and saves it.
 */
export type AnchorStore = {
  load(): Promise<Anchor | null>
  save(anchor: Anchor): Promise<void>
}
