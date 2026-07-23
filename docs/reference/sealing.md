# Two seals, and they are not interchangeable

App traffic is sealed with `wrap`/`unwrap` — MLS application messages, which **consume** a
per-message ratchet key and mutate the handle. A Commit's **ledger-entry blob** is not: it is sealed
with `sealEntries`/`openEntries` under a key derived from the epoch's MLS exporter secret
(RFC 9420 §8.5), which is epoch-level, one-way and derivable by every member at that epoch with
nothing exchanged.

The separation is forced by *where* the blob is opened. The resolver runs **inside** the MLS port's
apply of the very commit carrying the blob, so an open that spent a ratchet generation or touched
handle state would be unsound however it was scheduled. The exporter read is pure and re-entrant,
and it sees the pre-commit epoch — the epoch the blob was sealed under.

## The version byte sits inside the blob

The blob carries a leading version byte, **inside the blob, never in the frame header**.

An unknown *blob* version fails the open, which a peer survives: the commit files as poison and the
next frame strands it into a heal. An unknown *frame* version fails the decode before the frame is
ever classified — and a peer that steps over every frame without classifying one never learns the
group moved past it, so it would sit at a dead epoch forever, silently.

## Exporter labels are reserved

`sealEntries`/`openEntries` derive under `kumiai/ledger-entries/v1`, and the recovery secret under
`kumiai/recovery/v1`. Both are reserved — see
[reserved namespaces](./reserved-namespaces.md#exporter-labels). `@kumiai/mls-rpc`'s `exportSecret`
refuses the ledger-entry label outright, since a caller passing it would otherwise be handed the
ledger-entry key.
