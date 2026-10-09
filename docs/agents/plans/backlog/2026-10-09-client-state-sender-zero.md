# Client-state codec drops a pending proposal's sender at leaf index 0

**Priority:** backlog — kubun carries a local workaround today (see "Consumer workaround" below).
Fixing it here lets kubun delete that workaround.
**Found:** 2026-10-09, by kubun's own-agents leave work (self-removal proposals from leaf 0).

## The defect

`encodeClientState` (`packages/mls/src/codec.ts`) delegates to ts-mls `clientStateEncoder`. For
`unappliedProposals`, ts-mls `2.0.0-rc.13` encodes each entry with
`proposalWithSenderEncoder = [proposalEncoder, optionalEncoder(uint32Encoder)]`
(`dist/src/unappliedProposals.js`). `optionalEncoder` (`dist/src/codec/optional.js:4`) tests
`if (t)`, so a `senderLeafIndex` of `0` is written as "absent" and decodes as `undefined`.

Effect: after a save/restore round-trip, a pending proposal sent by leaf 0 has no sender. Any
check keyed on the sender, such as the self-removal filter in `group-lifecycle.ts:57-62`
(`proposal.remove.removed === senderLeafIndex`), stops matching. A member that restarts after
ingesting leaf 0's self-removal can no longer commit it.

## Fix in kumiai

Work around it in `encodeClientState`/`decodeClientState`, not in callers:

- When encoding, record the sender of each `unappliedProposals` entry whose `senderLeafIndex === 0`
  in a sidecar written after the ts-mls body, keyed by proposal ref.
- When decoding, restore `senderLeafIndex: 0` for those refs.
- Bump `CLIENT_STATE_VERSION` (currently `1`). Decide whether to still accept version 1 bytes,
  where a missing sender stays ambiguous between "none" and "leaf 0".
- Round-trip test: a pending proposal from leaf 0, encode then decode, sender still `0`. It must
  fail against the current codec.
- Audit the other `optionalEncoder` uses in the client state that can hold `0` or another falsy
  value: leaf indexes, epochs, counters. The same `if (t)` drops each of them.

## Upstream

File a ts-mls issue: `optionalEncoder` should test `t !== undefined`. Once a fixed release lands,
remove the sidecar (see `ts-mls-upstream.md`).

## Consumer workaround (kubun)

kubun's plugin-p2p stores the senders of pending proposals in a JSON envelope inside its own
`ledger_entries` snapshots. It still accepts the old token-array format. Once kumiai ships this
fix, kubun can drop the envelope and rely on `decodeClientState`.
