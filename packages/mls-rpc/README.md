# @kumiai/mls-rpc

The two consumer ports of `@kumiai/rpc` — `GroupCrypto` and `GroupMLS` — implemented over a live
`@kumiai/mls` `GroupHandle`. This is what a host wires when it wants group RPC over real MLS.

## Why it is its own package

`@kumiai/rpc` does not depend on `@kumiai/mls` and must not: it owns transport and orchestration,
and the two ports exist precisely so the consumer supplies the crypto half. `@kumiai/mls` does not
depend on `@kumiai/rpc` either — a crypto core that imported an RPC package's types would invert
the stack. So the implementation of one package's ports over the other's handle belongs above both.

It is a real implementation, not a fixture. Until it existed, both ports had exactly one
implementation apiece — a test double — and nothing had ever run them against MLS. This is also the
only place a compiler checks the two contracts against each other, and the only package that may
depend on both.

## Exports

- `createGroupCrypto({ handle, entryLabel? })` — `GroupCrypto` over a live handle.
- `createGroupMLS({ handle, adopt, identity, entrySlot, persist? })` — `GroupMLS` over the same.
- `createLedgerEntrySlot()` — the per-commit ledger-entry resolver seam (see below).
- `RECOVERY_LABEL` — the exporter label `exportRecoverySecret` derives under.

## The handle is a function, not a value

Both factories take `handle: () => GroupHandle`, and that is not a convenience. A peer's handle is
replaced wholesale when it adopts a commit it authored, or rejoins by external commit; a port
closing over the handle it was constructed with would seal at a dead epoch forever. `createGroupMLS`
takes `adopt` as the one place that replacement happens.

For a *received* commit there is nothing to adopt: ts-mls's `processMessage` advances the handle in
place. A host that treated every commit as adopt-later would double-apply received ones.

## `createLedgerEntrySlot` is mandatory, and must be installed where the handle is built

`GroupMLS.processCommit` is handed a `resolveLedgerEntries` scoped to **one** commit's frame — the
signed ledger-entry bodies ride that frame and nowhere else. But `GroupHandle` takes its resolver
once, in `GroupOptions`, and offers no way to change it afterwards. So the indirection has to be
installed when the group is *built*:

```ts
import { createGroupCrypto, createGroupMLS, createLedgerEntrySlot } from '@kumiai/mls-rpc'

const entrySlot = createLedgerEntrySlot()
// Every construction site: createGroup / processWelcome / restoreGroup.
const { group } = await createGroup(identity, groupID, {
  resolveLedgerEntries: entrySlot.resolve,
})

let handle = group
const crypto = createGroupCrypto({ handle: () => handle })
const mls = createGroupMLS({
  handle: () => handle,
  adopt: (next) => {
    handle = next
  },
  identity,
  entrySlot,
  persist: async (current) => await store.save(current),
})
```

Passing anything else means a commit resolves its entries against whatever resolver the handle
happened to be born with.

## Two seals, one exporter

`wrap`/`unwrap` carry app traffic and are ratchet-backed: each open consumes a message key and
mutates the handle. `sealEntries`/`openEntries` carry a commit's ledger-entry blob under a key
exported from the epoch, so opening is **pure** and may run from inside the apply of the commit that
carries it — which is the only place it does run, and which the ratchet-backed pair cannot serve.
The two use different exporter labels deliberately: the topic secret names a topic and is handed to
anything that derives one, while the entry key opens the group's control-ledger bodies.

The sealed blob is `[ VERSION(1) | NONCE(24) | CIPHERTEXT ]`, XChaCha20-Poly1305. The version byte
sits inside the blob rather than in the frame header so that an unknown version fails the *open* —
survivable, the commit is filed as poison and stepped over — rather than the *decode*, which would
leave a peer stepping over frames without ever classifying one and never learning the group moved on.

## Where this diverges from the doubles

Documented on the factories themselves; the conformance suite in `@kumiai/rpc-conformance` pins each
one. The ones a host is most likely to trip on:

- **`unwrap` opens a bounded window below the current epoch.** ts-mls retains a few epochs of key
  material, so a frame sealed at epoch 3 opens against a handle carried to epoch 4, and the same read
  six transitions later is refused. The window is spent by epoch *transitions*, not by time, so
  nothing may depend on it — and `@kumiai/rpc` does not. An implementation opening strictly at the
  current epoch is a correct implementation of the port.
- **`exportSecret` is one-way.** The fake XORs the epoch into a fixed base, so any member holding one
  epoch's bytes computes every other's. This exports from the epoch's exporter secret, which a
  removed member cannot reach forward from. That difference is the entire security property the
  app-lane topic rests on, and it is real only here.
- **`wrap` mutates.** It consumes a per-message ratchet key, so sealing the same plaintext twice
  gives different bytes.
- **`exportRecoverySecret` is derived from the group's genesis anchor, which is public.** MLS has no
  lifelong group secret, so there is nothing confidential and epoch-independent to derive it from.
  Anyone who has seen a `GroupInfo` for the group can compute the rendezvous topic. That is tolerable
  for what the topic is for — a stranded peer, and a removed one, must both be able to name it — but
  a host must put nothing on it that confidentiality depends on.
