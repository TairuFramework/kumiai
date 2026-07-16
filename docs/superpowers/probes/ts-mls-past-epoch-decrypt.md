# Probe: can a ts-mls `ClientState` at epoch N decrypt an application message sealed at an earlier epoch?

**Answer: YES — but bounded. A state at epoch N can open application messages from epochs N-1 … N-4, and no further back. The bound is a hard, structural key-deletion window (`retainKeysForEpochs: 4`), not an API limitation.**

Probed against `ts-mls@2.0.0-rc.13` as installed at `/Users/paul/dev/yulsi/kumiai/node_modules/ts-mls` (dist is the shipped JS; there is no bundled TS source).

## Evidence 1 — an executed run

A throwaway script (scratchpad, since deleted) drove ts-mls directly with the `packages/mls/test/crypto.test.ts` idiom: create group, add Bob (epoch 1), Alice seals an application message **at epoch 1**, both apply an empty commit to reach **epoch 2**, then Bob — now at epoch 2, having never read the frame — calls `processMessage` on the epoch-1 frame.

```
epoch after add: 1n 1n
epoch after commit: 2n 2n
bob historicalReceiverData epochs: [ 1n ]
RESULT kind: applicationMessage
RESULT plaintext: sealed-at-epoch-1        <-- decrypts cleanly at N-1
epoch now: 8n
bob retained epochs: [ 4n, 5n, 6n, 7n ]
OLD-EPOCH-2 ERROR: ValidationError - Cannot process message, epoch too old
```

So: a frame from epoch N-1 opens. A frame from an epoch that has fallen out of the 4-epoch window fails with `ValidationError: Cannot process message, epoch too old`. At epoch 8, the retained set is exactly `{4, 5, 6, 7}` = `{N-4 … N-1}`.

## Evidence 2 — the source

**`ClientState` carries an explicit past-epoch cache**, not just the current epoch:

`node_modules/ts-mls/dist/src/clientState.d.ts:47`
```ts
historicalReceiverData: Map<bigint, EpochReceiverData>;
```

`node_modules/ts-mls/dist/src/epochReceiverData.d.ts:6-16` — the doc comment is unambiguous about intent:
```ts
/**
 * This type contains everything necessary to receieve application messages for an earlier epoch
 */
export interface EpochReceiverData {
    resumptionPsk: Uint8Array;
    secretTree: SecretTree;      // <-- the past epoch's ratchet state
    ratchetTree: RatchetTree;
    senderDataSecret: Uint8Array;
    groupContext: GroupContext;
}
```

**The decrypt path branches on epoch** — `node_modules/ts-mls/dist/src/processMessages.js:38-60`:
```js
if (pm.epoch < state.groupContext.epoch) {
    const receiverData = state.historicalReceiverData.get(pm.epoch);
    if (receiverData !== undefined) {
        const result = await unprotectPrivateMessage(receiverData.senderDataSecret, pm, receiverData.secretTree,
            receiverData.ratchetTree, receiverData.groupContext, clientConfig.keyRetentionConfig, cipherSuite);
        // ... returns { kind: "applicationMessage", ... } with the historical secretTree advanced
        // in newState.historicalReceiverData (so per-message keys are consumed correctly)
        else throw new ValidationError("Cannot process commit or proposal from former epoch");
    } else {
        throw new ValidationError("Cannot process message, epoch too old");
    }
}
```

Two facts fall out of that branch:
1. Only **application** messages are readable from a former epoch. A commit or proposal from a past epoch throws `Cannot process commit or proposal from former epoch` — past-epoch reads cannot re-drive state.
2. The per-message key consumption is tracked *per historical epoch* (the returned `newState` re-stores the advanced `secretTree` under `pm.epoch`), so a drain reading many frames from one past epoch ratchets correctly and does not replay keys.

**The window is populated on every epoch transition and pruned by deletion** — `node_modules/ts-mls/dist/src/clientState.js:705-728`:
```js
export function addHistoricalReceiverData(state, clientConfig) {
    const withNew = addToMap(state.historicalReceiverData, state.groupContext.epoch, {
        secretTree: state.secretTree, ratchetTree: state.ratchetTree,
        senderDataSecret: state.keySchedule.senderDataSecret,
        groupContext: state.groupContext, resumptionPsk: state.keySchedule.resumptionPsk,
    });
    const epochs = [...withNew.keys()];
    return epochs.length >= clientConfig.keyRetentionConfig.retainKeysForEpochs
        ? removeOldHistoricalReceiverData(withNew, clientConfig.keyRetentionConfig.retainKeysForEpochs)
        : [withNew, []];
}
function removeOldHistoricalReceiverData(historicalReceiverData, max) {
    const sortedEpochs = [...historicalReceiverData.keys()].sort((a, b) => (a < b ? -1 : 1));
    const cutoff = sortedEpochs.length - max;
    const toBeDeleted = [];
    for (let n = 0; n < cutoff; n++) {
        appendSecretTreeValues(historicalReceiverData.get(sortedEpochs[n]).secretTree, toBeDeleted);  // <-- zeroed by caller
    }
    const map = new Map(sortedEpochs.slice(-max).map((epoch) => [epoch, historicalReceiverData.get(epoch)]));
    return [map, toBeDeleted];
}
```
Called from `processMessages.js:205` (receiving a commit) and `createCommit.js:84` (sending one) — i.e. every epoch transition snapshots the epoch being *left* and evicts the oldest. Evicted secret-tree values are returned as `consumed` and **zeroed** by the caller. This is structural, not cosmetic: past that window the key material is gone from memory.

**The window size** — `node_modules/ts-mls/dist/src/keyRetentionConfig.js:1-6`:
```js
export const defaultKeyRetentionConfig = {
    retainKeysForGenerations: 10,
    retainKeysForEpochs: 4,
    maximumForwardRatchetSteps: 200,
};
```

## Evidence 3 — the `@kumiai/mls` wrapper preserves, does not narrow

- `packages/mls/src/group-handle.ts:778-806` — `GroupHandle.processMessage` passes `state` straight to ts-mls `processMessage` and returns `result.message` for `kind === 'applicationMessage'` with no epoch check of its own. It stores `result.newState` unconditionally, so the advanced historical secret tree is retained. The past-epoch read is fully reachable through the wrapper.
- `packages/mls/src/codec.ts:13-17` — kumiai serializes the **full** `ClientState` via `clientStateEncoder`/`clientStateDecoder`, and `clientState.js:65,87-94` shows `historicalReceiverData` is inside that encoding. The window survives persistence and rehydration.
- `packages/mls/src/group-context.ts:16-21` — `resolveMlsContext` returns `{ cipherSuite, authService }` and **never sets `clientConfig`**, so `defaultClientConfig` (window = 4) always applies. `GroupOptions` (`packages/mls/src/types.ts:13-25`) exposes no knob for it. Widening the window today requires a code change in `@kumiai/mls`, not a caller option — though `MlsContext.clientConfig` is optional-and-public (`mlsContext.d.ts`), so plumbing one through is a small change if the drain wants a bigger window.

## Consequences for the `@kumiai/rpc` returning-member drain

A "apply all commits first, then read the retained frames" drain **works, but only if the peer was away by ≤4 epochs.** A peer that walks forward more than 4 commits in a burst will have zeroed the keys for the earliest epochs it passed through by the time it stops, and every frame sealed at those epochs is permanently unreadable by that state (`Cannot process message, epoch too old`).

So the safe designs are, in order of robustness:
1. **Interleave** the drain with the walk (decrypt each epoch's frames while the handle is at or within 4 epochs of that epoch). Correct for any gap length.
2. **Batch-then-read in chunks of ≤4 commits** — apply up to 3 commits, drain, repeat. Equivalent to (1) with a slack window.
3. Apply-all-then-read + raise `retainKeysForEpochs` via a plumbed `clientConfig`. Works, but trades a hard bound for a tunable one and keeps stale key material alive longer — worse forward secrecy, and still unbounded-gap-unsafe.

Also relevant to the drain:
- A **fresh joiner has an empty window**. `joinGroup` (`clientState.js:619`), the create path (`clientState.js:665`), and the external-commit path (`createCommit.js:297`) all initialize `historicalReceiverData: new Map()`. A member joining or resyncing at epoch N can read nothing sealed before N — no drain of pre-join frames is possible at all, by construction. This matters if "returning member" ever means an external-commit resync rather than a state restored from storage.
- **Within a single epoch**, out-of-order reads are also bounded: `retainKeysForGenerations: 10` (`secretTree.js:110`, `updateUnusedGenerations`) keeps only the 10 most recent skipped generations, and `maximumForwardRatchetSteps: 200` (`secretTree.js:104`) caps forward jumps with `ValidationError: Desired generation too far in the future`. A drain reading one sender's frames **in generation order** is unaffected. A drain that reads frames out of order within an epoch can lose keys more than 10 generations behind the highest generation it has already consumed.

## Surprises

- **The 4-epoch window is spent by *epoch transitions*, not by wall-clock or message count.** The drain's own catch-up walk is what destroys the keys it is trying to use. Applying commits and reading frames are not independent operations that can be freely reordered — the walk actively consumes the read budget. This is the crux of the design decision.
- **Eviction actively zeroes the key material** rather than dropping a reference (`appendSecretTreeValues` → `consumed` → `zeroAll` at `group-handle.ts:800`). There is no "the keys are technically still there, just not exposed" fallback and no recovery path once the window passes.
- ts-mls tracks per-message key consumption *inside* the historical epoch entry, re-storing the advanced `secretTree` under `pm.epoch` (`processMessages.js:42-46`). Past-epoch reading is a properly modeled first-class path, not a best-effort escape hatch — the library clearly anticipates exactly this use case.
- Past-epoch reads are **application-only by explicit design**: a past-epoch commit/proposal throws rather than being processed. The drain can never re-derive state from retained frames; it can only read payloads.
