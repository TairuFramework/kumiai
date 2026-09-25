# Probe report: Question 2.2

**Status: DONE**

## Findings

The standalone helpers preserve the existing entry blob bytes and recovery secret derivation. A fixed 32-byte key and 24-byte nonce produce the old factory layout, `[1 | nonce | XChaCha20-Poly1305 ciphertext]`. The standalone opener reads that blob; the factory seals the same bytes and opens blobs produced by the standalone sealer. Malformed and unknown-version blobs retain the exact `openEntries` error text. A standalone caller retains ownership of its key; the factory zeroes every derived key in `finally`, including after a failed seal or open.

`createRecoveryPending` owns a per-request timer and sweeps on `get`, `put`, and `delete`. The default TTL is 120,000 ms. Expiry, replacement, and deletion zero the original private-key array and cancel the relevant timer. Timers are unrefed where the runtime provides `unref`. `createGroupMLS` uses this helper. Recovery acceptance deletes only the same key it opened with, so accepting an older request cannot delete a replacement.

## Final exports

```ts
deriveEntryKey(handle: GroupHandle, label?: string): Promise<Uint8Array>
sealEntries(key: Uint8Array, entries: Uint8Array, runtime?: Runtime): Uint8Array
openEntries(key: Uint8Array, sealed: Uint8Array): Uint8Array
type RecoveryPending = {
  get(requestID: string): Uint8Array | null
  put(requestID: string, ephemeralPrivateKey: Uint8Array): void
  delete(requestID: string): void
}
createRecoveryPending(options?: { ttlMS?: number }): RecoveryPending
deriveRecoverySecret(handle: GroupHandle): Promise<Uint8Array>
```

All are exported from `@kumiai/mls-rpc`. `deriveEntryKey` calls the handle exporter with the selected label, empty context, and 32-byte output. `deriveRecoverySecret` uses the existing group ID, genesis anchor, and `RECOVERY_LABEL` KDF inputs.

## Routing changes

`GroupCrypto.sealEntries` and `GroupCrypto.openEntries` now derive through `access.read`, release access, perform the standalone byte operation, and wipe the key. `GroupMLS.exportRecoverySecret` calls `deriveRecoverySecret` inside `access.read`. `GroupMLS.createRecoveryRequest`, `applyRecovery`, and `openSealedLedger` use the new pending helper. No other handle-routing change was needed: the remaining spec-listed reads, bootstrap mutation, recovery replacement, ratchet mutation/open, and byte-only `frameEpoch`/`frameAAD` were already routed as required by Question 2.1.

## Rationale, alternatives, and learning

The blob validation remains before the factory's exporter read, preserving its early error path. The standalone opener validates the same bytes for callers outside the factory. The format and errors were copied directly from the prior factory code; changing the nonce, adding AAD, or changing error mapping would break stored blobs or diagnostics. The recovery helper retains the prior per-request timer in addition to access-time sweeping, so an unused key still expires without another call.

The pending helper returns the original key array. That lets the factory compare object identity after durable acceptance and avoid deleting a newer request with the same ID. The timer test uses Node's `hasRef()` to verify the timer does not keep the process alive. A custom short TTL also verifies sweeping before a timer callback runs. No `recoverySecret` override or epoch-bearing result was added; those belong to later questions.

## Verification

Tests were written first. The initial focused run failed because all five helper functions were absent. The completed focused helper suite passes seven tests, covering the fixed blob vector, factory interoperability, error text, key ownership and wiping, key derivation, TTL, zeroing, sweep, and timer unref. Existing recovery replacement and persist-boundary tests pass.

From the repository root (the MLS-RPC JavaScript `lib/` was rebuilt locally before integration; generated files were not committed):

```text
$ rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2
 Tasks:    49 successful, 49 total
Cached:    0 cached, 49 total
  Time:    44.369s

$ pnpm exec vitest run --root tests/integration
 Test Files  8 passed (8)
      Tests  43 passed (43)
   Duration  6.61s

$ rtk proxy pnpm run lint
Checked 400 files in 364ms. No fixes applied.
```

An earlier lint pass formatted the new test file; the output above is the final-state verification.
