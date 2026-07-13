# Probe report — Question 3.2

**Do bodies ride the commit frame, and is classification before unwrap?**

**Status: DONE_WITH_CONCERNS.** The frame carries the blob, the three-member test lands with no
gather, and the G11 test fails against the wrong implementation exactly as predicted (92 of 93 tests
still pass under it — only the late joiner's own add-commit catches the lie). The concerns are at the
end; the load-bearing one is that **D3 cannot be built on apply-then-announce**: sealing the bodies
under the *pre-commit* epoch secret forces D1's commit-path inversion, so `localCommitted` had to
become announce-then-adopt now, not in 3.3.

---

## 1. The frame's wire shape

`packages/rpc/src/commit-frame.ts` — a new module, and the whole of the codec.

```
handshake frame:  [ MAGIC(2) | VERSION(1) | KIND=commit(1) | commit frame... ]
commit frame:     [ commitLength(4, LE) | commit bytes | sealed entry blob... ]
sealed blob:      wrap( [ count(2, LE) | (tokenLength(4, LE) | token utf8)... ] )
```

- `encodeCommitFrame(commit, sealedEntries)` — `commit-frame.ts:32`.
- `decodeCommitFrame(frame)` — `commit-frame.ts:45`. Length-delimited: the commit is
  `frame.subarray(4, 4 + commitLength)` and the blob is *everything after it*, so the two halves are
  unambiguous and neither needs the other to be read.
- The blob's plaintext is the signed tokens: `encodeLedgerEntries` / `decodeLedgerEntries`
  (`ledger-entries.ts:22`, `:38`).
- The seal is `GroupCrypto.wrap` under the epoch the commit is **framed at** — the pre-commit epoch
  (`peer.ts:480`).

**How the commit half is read without the blob being touched:** `decodeCommitFrame` reads a `u32` and
takes two `subarray`s. That is the entire function. It never looks *inside* `sealedEntries` — it does
not decode it, does not decrypt it, and has no way to: **nothing in `commit-frame.ts` imports
crypto.** A blob of pure garbage decodes as happily as a real one, which is asserted directly:
*"the commit half is read from a frame whose blob is bytes nobody can open"* (`commit-frame.test.ts:22`).

A commit with no entries still carries a blob — an empty, sealed list — so the frame's shape is
uniform and the hub cannot tell a body-bearing commit from a bare one by its size class.

---

## 2. Where the unwrap happens, and how parse and unwrap are kept apart

**One place: `createLedgerEntryResolver` (`ledger-entries.ts:79`).** It is the only call of
`crypto.unwrap` on a commit frame anywhere in the package, and it is not a function that returns
bodies — it is a function that returns *a resolver*:

```ts
// peer.ts:386–390, inside pullCommits
const { advanced } = await port.processCommit(commitFrame.commit, {
  senderDID: message.senderDID,
  resolveLedgerEntries: createLedgerEntryResolver(commitFrame.sealedEntries, crypto.unwrap),
})
```

The lane hands the port **a closure over the sealed bytes**, never the bodies. The blob is opened only
if the port *asks* — and the port asks only while applying a commit, i.e. a commit framed at the epoch
this peer is at, which is the epoch the blob is sealed under. A frame the peer cannot apply never has
its blob touched, so a blob it cannot open is never opened, and never *looks* like anything.

That is the mapping onto the real MLS handle, and it is exact: `GroupHandle.#prepareCommitPipeline`
(`packages/mls/src/group.ts:706–720`) calls `resolveLedgerEntries` only after `readPrivateCommit`
has decoded the commit — which requires the handle's *current* epoch secrets. A commit from an epoch
the handle is not at never reaches the resolver call at all.

**How much of this is structural, and how much is discipline — plainly:**

- **Structural:** the codec module has no crypto in scope, so "decode a frame" *cannot* decrypt
  anything. There is no eager-unwrap variant to reach for; `decodeCommitFrame` returns
  `sealedEntries: Uint8Array` and that is all it can return.
- **Structural:** the blob leaves `pullCommits` as a resolver, not a value. Nothing downstream of the
  lane can open it except by asking for entries, and the only thing that asks is a commit being
  applied.
- **Structural:** a blob that will not open yields **no entries**, not an error
  (`ledger-entries.ts:88–94`, the `catch { return [] }`). There is no code path on which a failed
  decryption can be *reported* as anything, so it cannot be reported as corruption.
- **Discipline only:** nothing stops a future edit from `await`ing that resolver inside `pullCommits`
  before calling the port. That is precisely the mutation in §5, and the G11 test is what holds the
  line. The type system does not.

---

## 3. The three-member test — the deliverable

`packages/rpc/test/peer-ledger-bodies.test.ts:75`.

```ts
test('a member that has never seen a body applies the commit that enacts it, first time, with no gather', async () => {
  const alice = makeMLSPeer(hub, 'alice', recoverySecret)
  const bob = makeMLSPeer(hub, 'bob', recoverySecret)
  const carol = makeMLSPeer(hub, 'carol', recoverySecret)
  await flush()

  const token = 'signed-token: carol is an admin'
  const commit = alice.mls.buildCommit([token])
  await alice.peer.localCommitted(commit, {
    ledgerEntries: [token],
    adopt: () => alice.mls.adopt(commit),
  })
  await flush()

  const entryID = memoryEntryID(token)
  expect(carol.mls.ledgerIDs()).toEqual([entryID])   // enacted, on first delivery
  expect(carol.mls.epoch()).toBe(2)
  expect(bob.mls.ledgerIDs()).toEqual([entryID])
  expect(alice.mls.ledgerIDs()).toEqual([entryID])

  expect(asksOnTheWire(hub, recoverySecret)).toEqual([])                                  // no gather
  expect(hub.published.filter((m) => m.topicID === commitTopic(recoverySecret))).toHaveLength(1)
  expect(leakedBody(hub, token)).toBe(false)                                              // no body at the hub
})
```

**The no-gather assertion is over the wire, not over internals.** `asksOnTheWire`
(`peer-ledger-bodies.test.ts:49`) is *every message any peer published on any topic that is not the
commit topic* — an app-lane gather, a rendezvous recovery request, a directed inbox ask, all of them
land in it. It must be empty. Combined with "the commit topic carries exactly one frame", the whole
of what this group put on the hub to enact a ledger entry a member had never seen is: one commit.

`leakedBody` scans every published payload for the token's bytes. The hub carried the body and never
saw it.

```
 ✓ test/peer-ledger-bodies.test.ts > the bodies ride the commit > a member that has never seen a body applies the commit that enacts it, first time, with no gather 77ms
 ✓ test/peer-ledger-bodies.test.ts > the bodies ride the commit > a late joiner walks the commit that added it — a frame it can never open — and calls none of it malformed 31ms
 ✓ test/peer-ledger-bodies.test.ts > the bodies ride the commit > a commit whose bodies are not in its frame does not advance the cursor, and is read again 94ms
 ✓ test/peer-ledger-bodies.test.ts > the bodies ride the commit > the hub is handed a frame it cannot read, and a peer is handed one it can 32ms
 ✓ test/peer-ledger-bodies.test.ts > the bodies ride the commit > a consumer that adopts before it announces cannot seal the bodies, and is told so 31ms

 Test Files  19 passed (19)
      Tests  93 passed (93)
```

---

## 4. The G11 test — the late joiner walking its own add-commit

`packages/rpc/test/peer-ledger-bodies.test.ts:113`.

```ts
test('a late joiner walks the commit that added it — a frame it can never open — and calls none of it malformed', async () => {
  // The group at epoch 0. Alice adds dave: the commit enacting his role entry is framed at
  // epoch 0, and its bodies are sealed under epoch 0's secret.
  const daveRole = 'signed-token: dave is a member'
  await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 0, entries: [daveRole] })
  // Then, at epoch 1, she enacts another entry. Dave was a member for this one.
  const laterEntry = 'signed-token: dave is an admin'
  await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 1, entries: [laterEntry] })

  // Dave joins from the Welcome at epoch 1, holding the history it carried. What he does NOT
  // hold is the epoch-0 secret: the blob on the commit that ADDED HIM is sealed under the
  // epoch before he was a member, and he can never open it. He reads the whole log anyway.
  const dave = makeMLSPeer(hub, 'dave', recoverySecret, { epoch: 1, ledger: [daveRole] })
  await flush()

  expect(dave.mls.seen()).toBe(2)      // both frames were READ AS COMMITS and handed to MLS
  expect(dave.mls.commits()).toBe(1)   // only the one he was at the epoch for was applied
  expect(dave.mls.epoch()).toBe(2)
  expect(dave.mls.ledgerIDs()).toEqual([memoryEntryID(laterEntry)])  // from that commit's own frame
  expect(asksOnTheWire(hub, recoverySecret)).toEqual([])             // no heal, no gather
})
```

**`seen()` is the assertion that has teeth.** The `MemoryGroupMLS` double counts two things now
(`memory-group-mls.ts:8–13`): `seen()` — every commit the lane handed to `processCommit`, applied or
not — and `commits()` — the ones it applied. A frame dropped as malformed reaches **neither**. So
`seen() === 2` says *the frame that created this peer was read as a commit and delivered to MLS*,
which is the only thing that distinguishes "history I cannot apply" from "poison". Epoch, commit
count and ledger are all identical under both implementations; `seen()` is not.

To make "cannot open" a real property rather than a claim, two doubles were made faithful about the
thing this question turns on:

- **`createFakeCrypto` is now epoch-keyed** (`test/fixtures/fake-crypto.ts:24`): `wrap` seals under
  the current epoch's key and stamps the epoch; `unwrap` **throws** for bytes sealed under any other
  epoch. A member holds the secret of the epoch it is at — including none of the epochs before it
  joined.
- **`MemoryGroupMLS`'s commits are epoch-framed** (`memory-group-mls.ts:65`): a commit carries the
  epoch it was framed at and the ids it enacts, and a member applies only a commit framed at the
  epoch it is at — because real MLS cannot even *decrypt* one that is not. That is modelling, not
  classification: nothing in `peer.ts` looks at an epoch.

Both changes made every pre-existing commit-lane test strictly stronger, and all of them were
migrated to epoch-framed commits (`test/fixtures/commits.ts` builds a real `[commit][wrap(bodies)]`
frame the way `localCommitted` does).

---

## 5. The mutation check — unwrap in parse

Replaced the read path at `peer.ts:376` with the obvious shape: decode the frame, and you have a
commit and some bodies.

```ts
// MUTATION (the wrong-but-passing shape): unwrap the blob as part of parsing the
// frame. Decode the frame, and you have a commit and some bodies. Reverted below.
let commitFrame: CommitFrame
let entries: Array<string>
try {
  commitFrame = decodeCommitFrame(frame.payload)
  const opened = await crypto.unwrap(commitFrame.sealedEntries)
  entries = decodeLedgerEntries(opened instanceof Uint8Array ? opened : opened.payload)
} catch {
  reconciledHead = position // malformed: dropped, and the cursor still steps over it
  continue
}
const { advanced } = await port.processCommit(commitFrame.commit, {
  senderDID: message.senderDID,
  resolveLedgerEntries: async () => entries,
})
```

Result — **92 of 93 pass**. The three-member deliverable passes. Every catch-up, reconnect,
double-apply and lifecycle test passes. The cursor advances on both rows, so nothing stalls and
nothing diverges. **One test fails:**

```
PASS (92) FAIL (1)

1. the bodies ride the commit a late joiner walks the commit that added it — a frame it can never open — and calls none of it malformed
   AssertionError: expected 1 to be 2 // Object.is equality
       at packages/rpc/test/peer-ledger-bodies.test.ts:146:29
```

`expected 1 to be 2` is `seen()`: dave was handed **one** commit instead of two. The frame that
*created him* never reached MLS — it was caught in the `catch` and logged as malformed, because the
blob on it is sealed under the epoch before he was a member and his `unwrap` threw. Every number a
user or a test would look at — his epoch, his ledger, his commit count, the absence of a heal — is
**identical**. The only trace of the lie is in the log, which is exactly the day this costs someone.

Reverted; suite back to 93/93.

---

## 6. `getLedgerEntries` on `GroupMLS`

`packages/rpc/src/crypto.ts:87`:

```ts
getLedgerEntries(ids: Array<string>): Promise<Array<string>>
```

Served by the double from the bodies it holds (`memory-group-mls.ts:189`), omitting any id it does
not hold — it can fail to answer, never invent. Tested at `group-mls.test.ts:63`. **The requester's
gather loop is not built** (3.5's), per the brief: this is the responder half only, so a gather *can*
be served when 3.5 asks.

The content-addressing that makes a lying responder harmless is modelled and tested on the port's own
resolution path: *"a body that does not hash to the id it was asked for is ignored"*
(`group-mls.test.ts:50`) — the commit fails to resolve rather than enacting the injected body.

---

## 7. The resolver miss

`peer-ledger-bodies.test.ts:160`. A commit that names an entry whose body is in neither the peer's
ledger nor the frame — the shape a rejoin-by-external-commit leaves behind, whose GroupInfo carries no
ledger. The resolver serves nothing, the port raises its missing-entries error, `processCommit`
throws, and the lane **does not advance the cursor**: no crash, no drop, and the frame is read again
on the next wakeup (asserted: `seen()` climbs, `epoch` does not). That is 3.1's retry rule doing its
job unmodified. What *answers* the miss is 3.5's gather.

---

## 8. Can a peer be made to log ordinary history as poison by any other route?

The four cursor-advance paths in `pullCommits` are unchanged from 3.1; two of them can print
"malformed", and I walked both:

1. **`decodeHandshakeFrame` throws** (`peer.ts:338`) — bad magic, wrong version, unknown kind. A peer
   running a *newer wire version* would call every frame from an older one poison, and vice versa.
   `HANDSHAKE_VERSION` is still `1` while the commit payload's shape changed under it, so a frame
   published by a pre-3.2 peer now decodes as a **truncated commit frame** rather than as a version
   mismatch. Pre-1.0 with no deployed peers this is moot, but it is the one route left where ordinary
   history reads as corruption, and the fix is a version bump at the first release that ships both.
2. **`decodeCommitFrame` throws** (`peer.ts:378`) — too short, or a length that runs past the end.
   Only reachable from bytes that are genuinely not a frame, since it never touches the blob.
3. The two remaining paths (`selfCommitted`, `kind !== commit`) do not classify anything as
   malformed, and the epoch is not consulted anywhere in `peer.ts` — nothing here classifies a fork,
   a heal or a stale frame, per the brief.

**The route that does *not* exist, and must not:** a peer never learns that a blob failed to open.
`createLedgerEntryResolver` swallows the failure into "no entries", and there is no channel by which
that can be surfaced as corruption. When 3.4 adds diagnostics, that catch is the one place tempted to
grow a `console.warn` — and it must not.

---

## 9. What 3.3–3.7 will need that this does not have

**1. D3 forced D1's commit-path inversion, and it could not be deferred (the finding).** The bodies
must be sealed under the epoch the commit is *framed* at, because the receiver resolves them
*before* it applies the commit — the mls pre-pass runs ahead of `mlsProcessMessage`. A committer that
has already adopted its own commit has rotated past that epoch and can seal them **for nobody**. So
`localCommitted(commit)` — "a Commit the consumer just produced *and already applied locally*" — is
not a contract D3 can be built on. It is now:

```ts
localCommitted: (commit: Uint8Array, options?: LocalCommitOptions) => Promise<void>
type LocalCommitOptions = {
  ledgerEntries?: Array<string>       // sealed into the frame under the pre-commit epoch secret
  adopt?: () => void | Promise<void>  // run once the hub has the frame; then the app lane rebuilds
}
```

The peer seals, publishes, calls `adopt()`, then rebuilds (`peer.ts:471–500`). A consumer that adopts
first is **told**, not silently allowed to publish a blob nobody can open (`peer.ts:475`, tested:
*"a consumer that adopts before it announces cannot seal the bodies, and is told so"*). This is a
strict subset of D1's `commit(build)`: `adopt` **is** `onAccepted`, and `ledgerEntries` **is**
`PendingCommit.bodies`. 3.3 should absorb it, not re-derive it.

**2. 3.3's journal must survive the seal.** Replay republishes a journalled commit with the same
`publishID`. The peer can only *re-seal* the bodies if it is still at the pre-commit epoch — which it
is, since adoption happens in `onAccepted` and a crash before acceptance means no adoption. That
holds, but it holds by an argument, not by construction: journalling the **sealed frame** rather than
the raw `bodies` would make it hold by construction, at the cost of the journal holding ciphertext
it cannot re-key. Worth a deliberate decision in 3.3 rather than an accident.

**3. 3.4's classification table must not let the port *throw* on an inapplicable frame.** The lane's
rule is "a throw leaves the cursor put and the frame is read again". So a real `GroupMLS` adapter that
lets ts-mls throw on a commit from an epoch it is not at will **wedge the late joiner on its own
add-commit forever** — the failure mode next door to the one this question is about, and worse. The
adapter must return `{ advanced: false }` for a frame it cannot apply, and only throw for one it
*should* have been able to apply and could not (the resolver miss). The double already draws exactly
that line (`memory-group-mls.ts:169` vs `:182`); the table in 3.4 has to make it explicit.

**4. The resolver closes over live `crypto.unwrap`, so the port must resolve *before* it advances.**
If a port advanced the epoch and then asked for entries, the unwrap would run under the new epoch's
secret and open nothing. Real MLS resolves in the pre-pass, so this is true today, but it is an
unwritten invariant of `CommitContext.resolveLedgerEntries` that 3.7's epoch/mailbox interlock will
be standing next to. It is documented on the type (`crypto.ts:33–45`); it is not enforced.

**5. Still open from 3.1, untouched:** `selfCommitted` is in-memory (3.3's journal), no stale-epoch
classification (3.4), the trimmed-backlog gap is undetected (3.5), no retry timer, no CAS.

---

## 10. Verify

```
$ rtk proxy pnpm run build
 Tasks:    7 successful, 7 total
  Time:    633ms

$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 178 files in 230ms. No fixes applied.

$ rtk proxy pnpm test
@kumiai/broadcast:test:unit:        Tests  35 passed (35)
@kumiai/mls:test:unit:              Tests  283 passed (283)
@kumiai/hub-protocol:test:unit:     Tests  8 passed (8)
@kumiai/hub-tunnel:test:unit:       Tests  63 passed (63)
@kumiai/hub-server:test:unit:       Tests  56 passed (56)
@kumiai/hub-client:test:unit:       Tests  5 passed (5)
@kumiai/rpc:test:unit:         Test Files  19 passed (19)
@kumiai/rpc:test:unit:              Tests  93 passed (93)
 Tasks:    27 successful, 27 total

$ cd tests/integration && rtk proxy pnpm test
$ tsc --noEmit --skipLibCheck && vitest run
 Test Files  4 passed (4)
      Tests  23 passed (23)
```

`rpc` went 77 → 93: 16 new (7 codec + 5 lane + 4 port), none removed. `mls` 283 and integration 23
unchanged. Not committed.
