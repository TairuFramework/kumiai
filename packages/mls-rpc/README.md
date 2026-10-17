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

- `simpleHandleAccess({ handle, adopt, stateVersion, key, persist? })` — serialised access to a live handle; the
  `HandleAccess` type for a host that brings its own.
- `createGroupCrypto({ access, entryLabel?, runtime?, pending? })` — `GroupCrypto` over that access.
- `createGroupMLS({ access, control, readRecoverySource, identity, entrySlot, recoverySecret?, recoveryBinding? })` — `GroupMLS`
  over the same access.
- `createGroupSafety({ registry, persistence, mls, resolveTarget })` — incarnation safety reports,
  retained epoch authenticators and durable safety events over the registry's shared coordinator.
- `applyCommit({ handle, commit, entrySlot, ownDID, persist?, ... })` — apply a received Commit inside the host's own
  transaction (see below).
- `createLedgerEntrySlot()` — the per-commit ledger-entry resolver seam (see below).
- `deriveEntryKey`, `sealEntries`, `openEntries`, `ENTRY_SEAL_LABEL` — the ledger-entry seal.
- `createCheckpointService({ registry, key, identity, onForkNotice? })` — checkpoints, fork notices and portable export/import
  (see below); `createCheckpointPort` is its read/sign half.
- `recordOwnBranchMessage`, `incrementOthersSeen` — the branch journal writes a non-memory provider makes inside its group transaction.
- `deriveRecoverySecret`, `RECOVERY_LABEL` — the default recovery secret.
  `GroupMLS.createRecoveryRequest` returns explicit request keys. `applyRecovery` creates candidates,
  and `restoreRecovery(candidate, requestKey)` restores them.

## Share one access instance

Both factories take the same `access` instance. The adapter reads the current handle through
`handle: () => GroupHandle`, because authored commits and recovery replace it wholesale. A host
adopts an authored commit through `access.replace(next, adoption, prepare)` after acceptance.
The `prepare(current)` callback checks source identity and carries ratchet progress under the
replacement gate. The adapter saves before publishing the replacement and publishes its synchronous
epoch hint after a successful save.

For a *received* commit there is nothing to adopt: ts-mls's `processMessage` advances the handle in
place. A host that treated every commit as adopt-later would double-apply received ones.

Migrating from 0.9: build one adapter and pass it to both factories. Replace the old one-argument
`persist(handle)` callback with one that forwards the adoption write:

```ts
const access = simpleHandleAccess({
  key: store.control.key,
  handle: () => handle,
  stateVersion: () => store.loadVersion(groupID),
  adopt,
  persist: (current, write) => store.save(current, write),
})
const crypto = createGroupCrypto({ access, pending })
const mls = createGroupMLS({
  access,
  control: store.control,
  readRecoverySource: () => access.readControl(async ({ source }) => source),
  identity,
  entrySlot,
})
```

`store.save(current, write)` must use one root transaction to save the encoded MLS state and
ledger entries, apply `write.changes`, record `write.mutationID` as the control store's last
mutation, and mark the matching pending anchor landed using `write.anchorLanded`. A failed
transaction leaves all of these unchanged. Ordinary saves can omit `write`; ignoring a supplied
write loses adoption bookkeeping on restart even if the MLS state was saved.

The required `stateVersion` callback reads the host's stored version for this handle.
Serialise its state writes through the same access. Every write, including seals, opens and proposal changes, advances that version.
An epoch is not a state version. Reopening loads the stored version. Reads and searches leave it unchanged.
The required `key: GroupKey` identifies the host's stored group incarnation and remains fixed for that access.
Supply incarnation 1 explicitly only for a single-incarnation host.
Simple access forwards this key to source reads and adoption writes.

`createGroupMLS` requires the same keyed `control` store and an identity-only `readRecoverySource` callback.
The callback returns `AdoptionExpected`, including a nullable identity, without trust or lifetime metadata.
Use `createRegistryGroupMLS` for captured recovery with retained trust and registry adoption.
Plain construction preserves ordinary operations and the explicit legacy recovery path without `recoveryAdoption`.

### A host's own `HandleAccess`

A host with its own handle store implements the port instead:

- `readControl(fn)` owns the existing access gate and supplies a coherent handle and `AdoptionExpected` source.
  Its `refresh()` repeats the owned read without entering the gate again.
  A transactional host waits for issued storage writes, then restores one row's state and version together.
  It never pairs a live handle with a newer row's version or waits for open publication while owning that gate.
  An open may have committed its consumed receive state before publishing its handle.
- `read(fn)` lends the handle for the callback only. `mutate(fn, adoption?)` serialises with every other
  operation and resolves after the state is stored. `fn`'s `persist` argument goes to
  `processMessage` and `bootstrapLedger`. `replace(next, adoption?, prepare?)` stores before publishing.
  A transactional host may restore a fresh handle per mutation, discard it on rollback, and publish on commit.
- An `AdoptionWriteFactory` receives `{ incarnation, epochAfter, removed, epochAuthenticator }` from the staged handle.
  Invoke it before saving, including self-removal. Commit its `AdoptionWrite` atomically with the state.
  `processCommit(commit, context)` supplies it as `context.adoption`. Live and restored recovery candidates require
  `onAccepted(adoption)` and reject calls without a factory.
- `replace` runs `prepare(current)` under the same gate as persistence. A false result skips saving and publishing.
- `epoch()` is a synchronous hint. Publish it only after the outermost successful commit, and restore
  it on rollback. No port decision reads it: every one uses an epoch read under the lock.
- `admission()` publishes synchronous send admission with the epoch after mutation, open or replacement resolves.
  During adoption it describes the epoch being left.
- `open(fn, persistOpened)` is the durable open. `fn` stages the open and hands its state and record
  to the callback it is given. A host may capture them, release its lock, and then call
  `persistOpened` to write both in one transaction guarded by the state row's revision, publishing
  the working handle only after that commits, and only if no newer write was published meanwhile.
  On a revision conflict it retries from a fresh handle. Faults from `persistOpened`, from the staging
  callback the adapter hands `fn`, and from anything the adapter raises around `fn` come back as
  `AppFrameStorageError`, which the lane retries.

## Durable logged app delivery

Pass a `pending` adapter to `createGroupCrypto` to opt in. Its `persistOpened(stagedState, record)`
must write the encoded post-open `ClientState` as the group's handle state **and** insert the
`PendingAppFrame` in one atomic transaction. `list()` returns all uncompleted records after a
restart, ordered by `(frame.segment, frame.position)` by this port. `complete(id)` clears one
record and resolves for an unknown id. Deduplicate inserts by `record.frame.id`.

```ts
const access = simpleHandleAccess({
  key: store.control.key,
  handle: () => handle,
  stateVersion: () => store.loadVersion(groupID),
  adopt: (next) => { handle = next },
  persist: (current, write) => store.save(current, write),
})
const crypto = createGroupCrypto({
  access,
  pending: {
    persistOpened: async (stagedState, record) => {
      await store.transaction(async (tx) => {
        await tx.saveHandleState(groupID, stagedState)
        await tx.insertPendingIfAbsent(record.frame.id, record)
      })
    },
    list: () => store.listPending(groupID),
    complete: (id) => store.completePending(id),
  },
})
```

The example's `saveHandleState` must also enforce the host's save ordering and same-epoch
monotonic version rule. Saves issued before `persistOpened` must finish before it; a delayed
older state at the same epoch must be rejected. `persistOpened` runs under the handle mutex and
the peer's commit mutex: it must not call either object. Never hold a transaction or the sole
database connection while awaiting a peer or handle call; a handler should commit its own
transaction before awaiting `commit()` or `dispatch()`. A single-connection host that reverses
this order can deadlock. Hosts adopting this in Kubun must first remove transaction-then-registry
waits on paths overlapping app opens and prove the lock order against SQLite.

With `pending`, `unwrap(bytes, { expectedAAD, frame })` calls `GroupHandle.decryptStaged` and
resolves only after the atomic write. A persistence failure becomes `AppFrameStorageError` for
the RPC lane to retry; an unopenable frame is classified dead. Without `pending`, the adapter saves
the post-open ratchet state without a pending record, so a crash after `unwrap` and before the
handler finishes loses that frame: `pending` is the at-least-once path. `frameAAD(bytes)` exposes
the cleartext AAD as a routing hint. The full `expectedAAD` on open authenticates it.
The 0.10 app AAD carries version and log intent. Older bare-topic app frames cannot interoperate
with 0.10 peers. See the `@kumiai/rpc` README for the delivery and retention boundary.

## `createLedgerEntrySlot` is mandatory, and must be installed where the handle is built

`GroupMLS.processCommit` is handed a `resolveLedgerEntries` scoped to **one** commit's frame — the
signed ledger-entry bodies ride that frame and nowhere else. But `GroupHandle` takes its resolver
once, in `GroupOptions`, and offers no way to change it afterwards. So the indirection has to be
installed when the group is *built*:

```ts
import { createGroupCrypto, createGroupMLS, createLedgerEntrySlot, simpleHandleAccess } from '@kumiai/mls-rpc'

const entrySlot = createLedgerEntrySlot()
// Every construction site: createGroup / processWelcome / restoreGroup.
const { group } = await createGroup(identity, groupID, {
  resolveLedgerEntries: entrySlot.resolve,
})

let handle = group
const access = simpleHandleAccess({
  key: store.control.key,
  handle: () => handle,
  stateVersion: () => store.loadVersion(groupID),
  adopt: (next) => { handle = next },
  persist: (current, write) => store.save(current, write),
})
const crypto = createGroupCrypto({ access })
const mls = createGroupMLS({
  access,
  control: store.control,
  readRecoverySource: () => access.readControl(async ({ source }) => source),
  identity,
  entrySlot,
})
```

Passing anything else means a commit resolves its entries against whatever resolver the handle
happened to be born with.

The optional adapter `persist(current, write?)` callback receives the staged handle and any
`AdoptionWrite`. An adoption requires persistence. `simpleHandleAccess` rejects an adoption factory
without `persist` using `ControlWriteNotCommittedError`.
Ordinary ratchet and bootstrap saves can omit the write.

An adoption's root transaction saves the state, `write.changes`, and `write.mutationID` as the
control store's last mutation.
It also marks the pending anchor landed when `write.anchorLanded` matches its advance.
A known failed transaction leaves storage and the live handle unchanged. Notifications follow successful persistence.
Received-message and bootstrap persistence runs under the handle mutex. It must not call back into that handle.
Recovery saves the rejoined handle before publishing it. If publishing fails, restart loads the stored handle.

The host registry owns ambiguous adoption saves. Use `mutationID` as the state save's write identity
and mark the group uncertain. Block opens, seals and bootstrap until read-back settles the save.
Reload the committed handle before returning a settled result to the peer.
`simpleHandleAccess` supplies serialisation and write forwarding. The host supplies this ambiguity
resolution in its persistence and registry layer. The peer resolves only state-free
`ControlStore.apply` ambiguity through `lastMutation()`, with backoff capped at 15 seconds.

## Applying a commit inside a host transaction

`processCommit` is `applyCommit` inside `access.mutate`, plus entry resolution before the lock. A host
that projects commits into its own tables calls `applyCommit` inside its own transaction instead, from
its own `GroupMLS.processCommit`, so the peer still sees each result and rotates its anchor:

```ts
const result = await applyCommit({
  handle,
  commit,
  senderDID,
  resolveLedgerEntries: (ids) => resolved(ids), // must not take the handle lock
  entrySlot,
  ownDID: identity.id,
  persist: async (staged) => {
    const write = adoption?.({
      incarnation: key.incarnation,
      epochAfter: Number(staged.epoch),
      removed: !staged.listMembers().some(
        (member) => member.leafIndex === staged.state.privatePath.leafIndex,
      ),
      epochAuthenticator: staged.state.keySchedule.epochAuthenticator.slice(),
    })
    await store.save(staged, write)
  },
})
if (result.applied) {
  // write result.rosterAfter, result.surfacedEntries, ... and commit
}
```

Here `adoption` is the incoming `CommitContext.adoption` factory. `store.save` participates in the
host's root transaction. It commits the state and adoption write together with any projections.
The host publishes only after that transaction settles.

It refuses non-Commit bytes, a frame at another epoch, and this member's own authenticated commit
before any resolver or mutation runs. `applied` means the handle took the commit's state; `advanced`
means the epoch moved. A commit removing this member is applied without advancing. The result
carries both rosters, the ledger length before, the committer, and the verified non-`kumiai.*`
entries the commit appended, repeats kept. `MissingLedgerEntriesError`, resolver faults and store
faults propagate: map them to a throw from `processCommit`, never to `advanced: false`, which the peer
steps over as a commit it will never apply.

## Recovery secret

`exportRecoverySecret` defaults to `deriveRecoverySecret`, the anchor KDF. A host whose groups
already rendezvous on another secret passes `recoverySecret: (handle) => ...` for every restore of
those groups: both the commit and the rendezvous topic follow it. A result under 16 bytes or a throw
is refused; the default is never tried as a fallback.

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

- **`unwrap` opens only at the current epoch.** A readable frame at any other epoch throws
  `FrameEpochError` before decryption, under the handle lock. ts-mls could open a few past epochs,
  but `GroupHandle.decrypt` resolves senders at the current epoch, so such a frame never had a
  sender.
- **`exportSecret` derives from MLS exporter state.** The fake uses HMAC to model epoch separation,
  while the real port derives from the handle's exporter secret.
- **`wrap` mutates.** It consumes a per-message ratchet key, so sealing the same plaintext twice
  gives different bytes.
- **`exportRecoverySecret` is derived from the group's genesis anchor, which is public.** MLS has no
  lifelong group secret, so there is nothing confidential and epoch-independent to derive it from.
  Anyone who has seen a `GroupInfo` for the group can compute the rendezvous topic. That is tolerable
  for what the topic is for — a stranded peer, and a removed one, must both be able to name it — but
  a host must put nothing on it that confidentiality depends on.

## Validated registry cold access

`createGroupHandleRegistry({ persistence, providerID, recovery, restore, restoreCandidate })`
provides `start()` and `access(groupID)` over device persistence. The provider ID must match
`persistence.providerID`, and the recovery identity must own the device. `start()` checks device
restore work and lifetime restore flags; this core refuses pending restore work. Access restores
and validates active state with the supplied recovery options, including exact policy/resolver
callbacks and key retention of at least 1000 generations and forward ratchet steps. Hosts must
apply those options in their `restore` callback. `restoreCandidate` decodes host-serialised control
journal candidates; cold access never uses candidates as a substitute for stored state.

Providers must register the internal entry capability and an equivalent shared coordinator
binding token for all root group wrappers on the same database ownership boundary. The registry
owns that token: a second live registry is rejected synchronously before any load, restoration or
subscription. Separately constructed memory devices over one database share the token, even
though their `groups` objects differ. Spreading or copying a wrapper does not inherit registration.

Cold access shares in-flight validation and caches validated records rather than mutable handles.
Every `read` and `readControl` guarded-opens current stored state and restores an isolated handle;
callback mutations are not persisted. Control refresh stays in the same Read entry and expires
when its callback ends. Keys, runtime authenticators and membership sets are defensive copies.
Runtime identity comes from current installed trust, while administrative initial identity stays
historical. Safety holds, terminal/removed state, persisted strand and MLS lapse determine send admission.
Missing or retired runtime returns null. The access exposes retirement-hook registration for
subsequent lifetime operations.

`GroupUnavailableError.reason` distinguishes `absent`, `deleted`, `state-unreadable`, `invalid`,
`restore-pending` and `recovery-unavailable`. A surviving lifetime with missing metadata is invalid.
Missing, corrupt or empty-spent retained trust records `recovery-unavailable`.
Null or corrupt state cannot use cached bytes, including at an unchanged state version, and failed
restorations are never cached. Pure reads advance no persistence revision or state version.

## Durable group safety

`GroupSafety.epochAuthenticator(key)` reads a defensive copy of active installed trust without writing.
`reportFork(key, evidence)` validates the active incarnation and committed identity before latching and atomically storing evidence with its event.
`recover(key, choice)` persists a resync choice before any network use, then moves or rejoins (see Hub migration). A successor choice retires the source (see Successor retirement).
`status(key)` returns `{ hold, condition, evidence, manualRecovery }`. `clearHold(key)` and `clearTombstone(groupID)` are the only release operations;
there is no floor reset or general hold clear.
The factory requires a registered registry and persistence sharing its coordinator binding, plus `resolveTarget(targetID)` for registered targets.

`forkHalt` and `recoveryUnavailable` are immutable incarnation fields.
Deletion and replacement preserve old-incarnation evidence and events, including fork-halted tombstones.
`events(key)` supplies the complete durable safety event list, including host and registry diagnoses.
`ackEvent(key, id)` removes only the event, never either safety field.
Identical field reapplication preserves the original body and does not recreate an acknowledged event.

`AppOutbox.ackEvent` rejects stored safety events with `TypeError`. Absent IDs are no-ops.

Registry mutation, replacement, adoption and direct crypto refuse either safety reason with `GroupSafetyHeldError`.
Registry safety sinks immediately update MLS admission and hold live peers before durable writes complete.
Restart loads committed fields before network work.
Already opened handlers, stored outcomes/events, committed Welcome delivery and existing live certified settlement remain serviceable.
Restart publication of frozen settlement under a safety hold remains a 2.3 obligation.

Hosts derive `judgeWelcomeAdmission`'s `held.forkHalted` from `forkHalt` alone.
`recoveryUnavailable` alone permits an otherwise admissible Welcome into the next incarnation when retained trust is valid.
Missing, unreadable or empty-spent trust refuses seed as unavailable without changing admission state.
Neither Welcome nor GroupInfo reconstructs the spent set. Ordinary readmission refuses a fork-halted tombstone.
After lost spent trust, retirement to an already admitted successor group (another groupID) remains the explicit exit.
After total key and database loss there is nothing to corrupt: the app re-invites the device into the same group.

A validated latch survives failed or ambiguous writes in the current process. Only proven commits survive restart.
A crash before durable writing can lose volatile host evidence.

## Checkpoints and fork notices

The registry peer creates its own checkpoint service and forwards it as `options.checkpoints`.
Apps read notices and exchange frames through a service of their own over the same registry:

```ts
const checkpoints = createCheckpointService({
  registry,
  key,
  identity,
  onForkNotice: (event) => app.notify(event.kind, event.notice),
})
// Unacknowledged events replay after restart.
for (const event of await checkpoints.events(key.groupID)) app.notify(event.kind, event.notice)
for (const notice of await checkpoints.forkNotices(key.groupID)) {
  if (notice.closedAt === null) app.review(notice.splitEpoch, notice.branches, notice.atRisk, notice.coverage)
  await checkpoints.ackForkNotice(key.groupID, notice.id, notice.revision)
}

// Portable exchange: signed frames out, frames from another device in.
const frames = await checkpoints.exportCheckpoints(key, [epoch])
await checkpoints.importCheckpoint(key, theirFrame)
const fact = await checkpoints.checkpointFact(key, epoch)
const ours = frames[0]
if (fact !== null && ours !== undefined) {
  const comparison = await verifyCheckpointPair({ first: ours, second: theirFrame, localRosterFact: fact })
  app.notify(comparison.kind)
}
const coverage = await checkpoints.checkpointCoverage(key.groupID)
app.notify(coverage.effectiveFloor, coverage.gaps)
```

`exportCheckpoints`, `checkpointFact` and `checkpointCoverage` return defensive copies. Imports carry no provenance: they compare like received frames.
`verifyCheckpointPair` (`@kumiai/mls`) verifies two frames against a local roster fact without any store.
`onForkNotice` runs once per event per service after the proven write, outside the owner gate; a throw is ignored.
Coverage lists `retained` ranges, `gaps` (`pre-join`, `skipped`, `expired`) and the `effectiveFloor` across incarnations.
Format, budgets, retention and detection limits are in the `@kumiai/rpc` README.

## Branch abandonment

`branch-abandoned` events arrive through `GroupSafety.events(key)` and are acknowledged with `ackEvent`:

```ts
for (const event of await safety.events(key)) {
  if (event.kind !== 'branch-abandoned') continue
  // Resend own messages from the app's copy; plaintext is not retained.
  await app.resend(event.ownMessages.map((message) => message.id), event.coverage.ownMessages)
  app.redoMembership(event.membersAdded, event.membersRemoved, event.epochs)
  await safety.ackEvent(key, event.id)
}
```

## Group conditions

`status(key).condition` is `not-member`, `spent-set-corrupt` or `null`; `evidence` is the latest `NotMemberEvidence`.
`registryPeer.status()` reports the same conditions per peer:

```ts
const { hold, condition, evidence, manualRecovery } = await safety.status(key)
app.notify(hold, condition, evidence, manualRecovery)
const status = registryPeer.status()
if (status.kind === 'not-member') {
  // Diagnostic: status.retrying is true and recovery continues.
  const corroborated = status.evidence.responderDIDs.length > 1
  const persisted = Date.now() - status.evidence.observedAt > app.persistenceWindowMs()
  app.showNotMember(status.evidence.responderCount, status.pendingReason)
  if (corroborated || persisted) app.offerReinvite(key)
} else if (status.kind === 'spent-set-corrupt') {
  app.showSpentSetCorrupt(status.eventID)
} else if (status.kind === 'pending') {
  app.showPending(status.reason)
}
```

The `not-member` arm carries `retrying: true` and an optional `pendingReason` (`no-reply`, `no-eligible-responder`, `target-behind`, `target-unresolved`).
`responderDIDs` and `responderCount` count distinct responder DIDs and survive restart. Events emit once per new evidence, coalesced like notices.
One not-member row stays active per incarnation; superseded evidence keeps at most eight inactive summaries (oldest pruned with
their events). Rows store no sealed reply.
Do not dispose or delete on first evidence: wait for another responder DID or for the condition to persist.
That wait is app policy, not a protocol threshold; disposal, deletion and re-invitation stay with the app.

Seed and trust reads throw `SpentSetCorruptError` (the `@kumiai/rpc` class, re-exported; optional `key`); `reportFork` under corruption records the condition and throws `GroupSafetyHeldError`.
`not-member` never refuses sends or admission. While a manual recovery is authorised, resume does not stop on spent-set corruption: movement is rejoin-only.
If that rejoin's start finds corruption, `recover()` rejects with `SpentSetCorruptError`; the condition stays persisted.
The condition is reported again once no manual recovery is pending.

## Clearing reported halts

```ts
await safety.reportFork(key, evidence)
// Later, once the app has resolved its own report:
await safety.clearHold(key)
```

`clearHold` lifts only an app-reported halt (`producer: 'app-report'`) on the active incarnation; anything else is a no-op.
It never touches spent-set corruption, `not-member`, unsupported-version holds, internal latches or legacy halts (no `producer`).
Evidence and events stay as history. Live peers resume only after the clear is proven, through the ordinary commit walk; a stranded peer then recovers. No resync is forced.
Legacy and internal halts leave through manual recovery: resync rejoins (never a current move) or successor retirement.

## Hub migration

```ts
const safety = createGroupSafety({
  registry,
  persistence,
  mls,
  resolveTarget: async (targetID: string) => {
    const target = targets.get(targetID)
    if (target === undefined) throw new Error(`Unknown target ${targetID}`)
    return target
  },
})
// Call-time target, for example a new hub while the old one is down.
const installed = await safety.recover(key, {
  mode: 'resync',
  target: { targetID: 'hub-b', hub: newHub, commitTopicID: newCommitTopicID },
})
app.route(installed)
// Or a registered target through resolveTarget; allowOpenFork overrides only the open-notice check.
await safety.recover(key, { mode: 'resync', targetID: 'hub-b', allowOpenFork: true })
```

`recover(key, { mode: 'resync', target: { targetID, hub, commitTopicID }, allowOpenFork })` moves a group to a destination the app selects.
kumiai never chooses destinations or creates successors. The selected binding is saved before the source peer stops.
The destination commit topic is the binding's `commitTopicID`; rendezvous and checkpoint topics stay derived from the recovery secret.

A device moves current only when `canMoveCurrent` holds against the saved record inside one owner transaction.
That requires readable state, a complete ledger, no known lag (strand, stranded or incomplete cursor, cursor epoch behind state, `recoveryEpochFloor` above state),
no commit slot, operation, Welcome, unresolved app publication or settlement, and zero other pending owner work.
It also requires no hard hold, no `not-member` or `spent-set-corrupt` condition and no active rejoin.
Active rejoin covers ordinary X, a pending fork recovery intent (including one this authorisation abandoned) and a saved manual candidate.
An open fork notice refuses too, unless the saved `allowOpenFork` is true; that override touches nothing else.
Freshness is the absence of known lag. It proves nothing against a hub that withheld frames.

A current move keeps the GroupKey, MLS state and every hold. It resets hub positions (commit cursor, checkpoint receive cursor)
and re-queues retained checkpoint publications with their exact frames. The peer restarts on the destination only after the move is proven.
The first device publishing on an empty topic starts its log at its current state; others compare-and-set after it.
A current move does not reset app-topic cursors: hosts must reset their app-topic cursors after a current move.

Every other device rejoins through captured recovery from destination responders, checked against retained trust.
It publishes nothing to the destination log before an authenticated reply. A confirmed rejoin installs a fresh incarnation without holds.
Source holds and evidence stay as history. A failed attempt leaves source state, routing and holds intact.
A device that arrives ahead of the destination's responders stays pending with `target-behind` unless R2/R7 fork-floor evidence applies.
Apps must move every device. Separate hubs cannot exchange checkpoint evidence, so a partial migration can split undetectably.
Restart resumes only the saved destination; an unresolved binding, or a resolved hub missing a transport method, pauses with `target-unresolved`.
Only `targetID` and the sealed `commitTopicID` persist. After restart, `resolveTarget(targetID)` must rebuild that exact binding; a mismatch pauses without fallback.
`status(key).manualRecovery` shows `pending`, `paused` or `completed`. A pending fork recovery counts as active rejoin; authorising manual recovery abandons it.
Expired fork evidence or a head in a retained-range hole leaves automatic healing `target-behind`; manual resync is the exit.
Manual resync proceeds under fork halts (app-reported, internal or legacy) by rejoining; it never moves current while held.

## Successor retirement

```ts
const successor = await safety.recover(key, { mode: 'successor', successor: successorKey })
// Optional: allow a later Welcome to readmit the retired group.
await safety.clearTombstone(key.groupID)
app.route(successor)
```

`recover(key, { mode: 'successor', successor })` retires the source in favour of a group the app already created or joined through normal admission.
The successor must be a different, available group admitted at exactly that key; otherwise `ManualRecoveryUnavailableError` refuses before any write.
kumiai checks the successor through its own gate only, persists the choice, drains source work and retirement hooks (stopping the source peer), then commits in one transaction:
the source lifetime becomes a tombstone, abandoned operations and superseded manual candidates become `unknown` outcomes, uncertified outbox entries fail with events,
the choice completes and a `SuccessorTombstone` row records `source`, `successor`, `authorisationID` and `retiredAt`. It returns the successor key.
Nothing is copied: no state, ratchets, messages or roster. Owed outcomes, Welcomes, certified settlements, events and halt evidence stay serviceable as history.
Retirement reads no private state or retained trust, so corrupt source state or trust is no obstacle. Failure leaves the source, its routing and any halt intact.
A successor choice supersedes a pending resync, and a later successor choice replaces an unexecuted one in place; a resync never supersedes, and an executed choice is final.
Restart resumes only the saved successor when the app calls `recover` again. A group cannot be its own successor.
A pending successor choice blocks a resync of the same source, but not automatic or fork recovery: until it executes,
the source heals as an ordinary peer.

An open tombstone refuses every Welcome into the source group with `SeedAdmissionRefusedError` reason `successor-tombstone`, including newer or unspent ones after restart.
`clearTombstone(groupID)` releases only that block. Spent-authenticator checks, fork halts and other safety latches still apply to later admissions.
Hard-held devices never answer recovery requests, and manual resync never opens that lane. When every device is halted, successor retirement is the exit.
Application code owns successor creation, admission, routing and member migration.

## Captured registry recovery

`createRegistryGroupMLS` constructs asynchronously from retained trust and stored identity, without restoring private MLS state.
Missing or corrupt private state permits recovery. Missing or unreadable retained trust produces `recovery-unavailable` and requires manual re-invite.
The public `RecoverySource<TTrust>` and `ResyncProof` types come from `@kumiai/rpc`.
`RegistryRecoverySource` narrows trust to `GroupRecoveryTrust`. `RegistrySwitchWrite` restricts the incarnation switch write.

```ts
const registryPeer = await createRegistryPeer({
  registry,
  key,
  recovery,
  target,
  continuation: createRecoveryContinuationPort({ registry, persistence }),
  createMLS: (current) => createRegistryGroupMLS({
    registry,
    key: current,
    recovery,
    target,
    identity,
    entrySlot: createLedgerEntrySlot(),
  }),
  createPeer: createPeerForIncarnation,
})
await registryPeer.ready
```

`registryPeer.status()` reports `starting`, `running`, `switching`, `pending`, `spent-set-corrupt`, `not-member`, `failed` or `disposed`.
`failed` includes the terminal `error`, available without disposing the owner. `drained()` still rethrows that error after disposal.
Pass `onRecovery` to receive coordinator failures through the existing rpc `RecoveryEvent` shape (`phase: 'failed'`, `reason: 'error'`).
The event identifies the saved attempt and uses `target.topicID` as `groupID`. Callback failures cannot replace the coordinator error.
Use the same callback for the incarnation peer's `onRecovery` to observe both recovery stages.
An unresolved switch proof exposes `pending`, with no peer. Initial `ready` keeps waiting while that proof remains unresolved.
Retries have no count or elapsed-time bound. Their backoff caps at 15 seconds, and disposal stops retries.

The host's `createPeerForIncarnation(key, options)` supplies the actual incarnation's control, crypto, anchor, cursor and outbox ports.
It spreads `options` into `createGroupPeer`, preferring `options.hub` and `options.control` over its own.
That forwards `mls`, `checkpoints`, `manualRecovery`, `recoveryTarget`, `onNotMember`, `recoveryOnly`, `onConfirmedRecovery`, `settleAcceptedRecovery`,
both reconciliation callbacks, `continuation` and `completion`.
`onConfirmedRecovery` requires `settleAcceptedRecovery`. Direct construction without the settlement callback throws `TypeError`.
The coordinator supplies both callbacks and waits for source completion and drainage before restoring the raw candidate.
It never retains the host-bound pending proxy.

`createRecoverySwitchFactory` uses the saved `switchMutationID`. `toRegistrySwitchWrite` accepts only the adopted source record and destination cursor.
A `RegistrySourceMovedError` permits a fresh-counter retry of the same identity, trust, target, key and switch ID.
Uncertain saved-ID proof resolves before source movement. Local rollback preserves remotely accepted X and all source obligations.
`createRecoveryContinuationPort` discovers the installed continuation after destination epoch advancement and settles source operations idempotently.
Bootstrap verifies the destination ledger before computing missing reenact tokens. Source outcomes and owed Welcomes remain accessible after retirement.

Captured replies use version 2 and `kumiai/mls/recovery/v2` / `kumiai/mls/recovery-aad/v2`.
The attestation binds the exact capture head and committed epoch authenticator. Ledger-only replies retain version 1.
Candidate v3 (`kumiai/recovery-candidate/v3`) saves the authenticated reply, immutable origin, target, search origin and existing confirmation tuple.
ClientState codec v2 and ordinary control journals retain their formats.

Authenticated recapture recognises the exact fresh LeafNode, never identity or index alone.
A current bound confirmation permits adoption. Later accepted state without that proof produces compact accepted-unadoptable settlement before a fresh leaf-replacing attempt.
Unconfirmed later leaf absence permits policy-gated discard with cumulative obligations and a durable epoch floor.
Regressing hub heads remain usable. Stale authenticated epochs preserve the saved attempt. Backoff is capped at 15 seconds.
Fresh attempts below the durable floor emit `below-epoch-floor`. Recaptures behind saved X or its floor emit `target-behind`.
Equal-epoch authenticator disagreement emits `capture-authenticator-disagreement`, preserving X without a halt.
Unanswered or ineligible captures retain their existing generic diagnostics. These reasons grant no floor-lowering authority.
Request keys transfer to durable ownership only after proven save. Earlier failures zeroise the owned buffer.
Proven settlement zeroises live owned buffers. Cumulative settlement retains every owed ledger token in its existing single row.

Hub delivery faults never create new durable halts or authorise adverse settlement.
Own copies use MLS-message recognition and receiver reference checks. Blob failures and unproven negatives remain advisory.
Only host reports and genuine local invariants retain halt authority. Existing persisted halts and legacy record holds remain immutable.
Origin-authorised signers removed after origin retain attestation authority, including possible signed floor inflation.
This signer-authority residual lies outside the hub threat model; manual resync and successor retirement are its exits.
Busy responders can also cause accepted-unadoptable churn.

Custom `recoverySecret` requires equivalent `recoverySecretFromTrust` at construction. Missing equivalence throws before requests or hold writes.
`RecoveryCandidateError`, `RegistryResyncRefusedError`, `RegistryRetiringError`, `RegistryRetireHookError` and `RegistryRecoveryReplacementError` expose actionable failures.
`SeedAdmissionRefusedError` reports Welcome admission refusal. Existing conflict, uncertainty, movement and safety errors remain exported.
Unadopted legacy attempts retry with `legacy-recovery-record`, preserving saved bytes; successor retirement is the explicit exit.
Full registry crypto, leases, batching, package burn and restore remain 2.3; phase-3 providers are excluded.
The integration witnesses reconstruct memory persistence. They do not provide phase-6 child-process SIGKILL evidence.
