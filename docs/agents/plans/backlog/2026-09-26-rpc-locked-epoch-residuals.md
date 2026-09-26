# Locked-epoch residuals after host handle access

**Kind:** hardening and test gaps. Low priority: each needs a host that moves the handle outside the peer, or costs time rather than correctness.

## Races between two locked reads

`@kumiai/rpc` takes every commit-path and app-lane decision from an epoch read under the host's handle lock, but some decisions combine two separate locked reads. A host that moves the handle between them (outside the peer, which serialises its own movers) can mislead the peer:

- The commit walk reads `GroupMLS.readEpoch()` and `readCommitHeader()` under separate locks (`packages/rpc/src/peer.ts`, ordinary classifier). An epoch move in between can classify an applicable frame as `ahead`, causing a spurious strand and heal.
- `captureAnchor` pairs secret and epoch from one `exportSecret`, but does not compare that epoch with the applied `epochAfter`, and the roster before/after reads are separate. A concurrent move anchors at a later epoch than the rest of the group.

Fix direction: one locked read that returns both facts (for example `readCommitHeader` also reporting the handle epoch), and an anchor capture that refuses when its export epoch differs from `epochAfter`.

## Faults read as refusals

- `openEntries`'s resolver (`packages/rpc/src/ledger-entries.ts`) turns every error into missing bodies. The resolver now reads through `HandleAccess.read`, a host-owned boundary, so a transient store or lock fault becomes `MissingLedgerEntriesError` and the peer steps over a valid commit as poison. It recovers only when the next commit is framed ahead. Fix direction: let faults other than a failed open escape, so the lane re-reads the frame.
- A commit the handle rejects spends a handshake-ratchet generation in memory before throwing (`GroupHandle.processMessage`), and `processCommit` then skips the save. Under the simple adapter the live handle and the stored state differ by that one generation. Harmless today, since a replay of the same frame is rejected either way.

## Cost

Every past or future frame now goes through `unwrap` on each drain. Under a transactional adapter that is a lock and a restore per frame, indefinitely for a forged future frame pinning the cursor. No key is consumed and nothing is written.

## Test gaps

- The peer's `retainOnFailure` wiring is pinned only at the open-once level: a direct hub publish on the test fixture's app topic never reaches the open-once path, so a mutation of the peer's one-line wiring is not caught.
- `applyCommit`'s own-commit check normalises DIDs, but no test uses a `did:peer:4` long form, the only form `normalizeDID` rewrites.

## Related

Past-epoch sender resolution: `GroupHandle.decrypt` resolves senders with the current epoch's sender-data secret, so an RPC call or reply in flight across a commit is lost. Strict `FrameEpochError` refusal kept that behaviour rather than causing it.
