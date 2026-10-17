# @kumiai/rpc

High-level, MLS-aware group RPC for Enkaku. Wraps the pub/sub hub and the
broadcast primitives so a group is a first-class messaging substrate: address
the whole group (events), a subgroup, anycast a request, gather replies, or run
directed 1:1 RPC (request/stream/channel) to a single member — all over
epoch-rotating opaque topics, with an authenticated sender on every surface.

`peer.protocol(name).gather(prc, { param, quorum?, timeoutMs?, onReply?, signal? })` resolves with
the collected replies. `onReply` runs once per accepted reply as it arrives, with its authenticated
`senderDID` and the same object stored in the result array. Treat that object as read-only. A
throwing callback is ignored. Aborting `signal` resolves with replies collected so far. A signal
already aborted resolves `[]` without sending, including while the peer waits for initial readiness.

## The two consumer ports

group-rpc never imports MLS. It owns transport and orchestration; the consumer supplies the crypto
half through two ports:

- **`GroupCrypto`** — a synchronous epoch hint, `exportSecret(label, length?)` for as many epoch-bound,
  domain-separated exported secrets as there are labels, `wrap`/`unwrap` for app traffic,
  `frameEpoch` and `frameAAD` to read a sealed frame's cleartext metadata, optional `pending`
  storage for durable app delivery, and `sealEntries`/`openEntries` for a commit's ledger-entry blob.
- **`GroupMLS`** — the lifecycle half: read a Commit's own claims before touching it, apply the ones
  this member is in a position to apply, report the roster the apply left behind, and drive the
  recovery/ledger rendezvous.

`@kumiai/mls-rpc` implements both over a live `@kumiai/mls` handle. `@kumiai/rpc-conformance` is the
contract every implementation and every double must pass.

**Taking these ports means running that suite against your implementation.** A host that uses
`@kumiai/mls-rpc` gets both ports right by construction and inherits its conformance run. A host
that writes its own does not, and one method makes that most expensive: `exportSecret` is the member
of either port whose MOST CONSEQUENTIAL failure mode is silent. Derive its bytes from anything a
removed member keeps and nothing breaks — the group works, removals remove, the health monitor is
quiet — while an evicted member can still name and read the app topic, which derives from it.
`sealEntries`/`openEntries` rest on the same per-epoch removal boundary and fail the same way: a
hand-rolled seal keyed off anything but the epoch secret round-trips, throws nothing, and lets a
removed member open the ledger-entry blobs of commits enacted after its removal.

Four constraints a port implementation is most likely to get wrong, all of which the suite pins:

- **`epoch()` is a hint; decisions use the epoch a result reports.** A host's published epoch can
  lag its handle or, after a rolled-back transaction, run ahead of it. So every port result that
  acted on the handle carries the epoch it acted at, read under the host's handle lock:
  `exportSecret` returns `{ secret, epoch }`, `sealEntries` returns `{ sealed, epoch }`, `unwrap`
  returns `epoch`, `processCommit` returns `{ advanced, epochBefore, epochAfter }`, and
  `GroupMLS.readEpoch()` answers when no operation runs. The suite's epoch clauses set the hint one
  behind and one ahead and expect the same answers.
- **`unwrap` throwing is ordinary control flow**, not an error: it is how a retained frame says "not
  my epoch". A readable frame at another epoch must throw `FrameEpochError { frameEpoch,
  handleEpoch }` before anything is decrypted. The lane retains a frame only on that error's
  "ahead" answer; any other refusal marks it dead.
- **`readCommitHeader` returning `null` means "these bytes are not a Commit at all"** — never "a
  Commit I could not read". The lane files `null` as poison and steps over it, so a port answering
  `null` for every commit framed away from its own epoch makes a peer that fell behind read the
  group's entire future as garbage, walk to the end of the log, and report itself fully reconciled at
  a dead epoch.
- **`processCommit` returns `advanced: false` for anything it cannot apply, and throws only for a
  Commit it may yet apply**: one whose named ledger entries will not resolve from the Commit's own
  frame (a `MissingLedgerEntriesError`), or a fault that says nothing about the Commit, such as a
  resolver or store failure. A commit at another epoch, including one the handle moved past while
  entries resolved, is `advanced: false` with the handle's epoch. A fault makes the lane re-read
  the frame, so a port that throws on a commit it was never in a position to apply wedges the lane
  there forever — a late joiner would wedge on its own add-commit, the first frame it reads.

`sealEntries`/`openEntries` are deliberately not `wrap`/`unwrap`. The entry blob is opened from
inside the apply of the commit that carries it, and a ratchet-backed open mutates the handle, which
is unsound there however it is scheduled. Derived-key sealing makes opening pure, so the question of
when it is safe to open stops existing rather than being managed.

## The app lane: logged events

### Durable delivery (opt-in)

Supplying `GroupCrypto.pending` enables acknowledged delivery for events declared `retain: 'log'`.
For a conforming hub that appends and retains the frame until it is durably opened, the peer
delivers these events **at least once**, in log order per protocol, across process restarts and
handler failures. A successful handler return acknowledges the event; a thrown handler or failed
`pending.complete` retries the same record with backoff, holding later events in that protocol.
An event handler that never settles holds its protocol indefinitely. Disposing the peer does not
cancel an active handler; the host must settle its work or restart the peer to retry the record.
The handler context's `frame: AppFrameRef` identifies a logged delivery. Store a deduplication
entry keyed by `frame.id` in the same transaction as the handler's effect before returning.
External effects must be idempotent or reconciled by that id. A record may be delivered again if
the process crashes after the effect but before completion.

`AppFrameRef` includes `id`, `topicID`, `protocol`, anchor `segment`, and log `position`. The id
is derived from the topic and ciphertext, so it stays stable across replay. `pending.list()`
restores records at startup in `(segment, position)` order; `pending.complete(id)` is idempotent.
The port's `unwrap(bytes, { expectedAAD, frame })` must atomically save the consumed-key handle
state and the pending record before resolving. A failed save must leave the handle openable and
throw an error recognized by `isAppFrameStorageError`; the app lane retries without advancing
past that frame. `onAppDeliveryStalled` reports a persistent storage block, a missing protocol on
restore, or a future-epoch frame once per blocking frame. A missing-protocol record stays
pending and can be delivered after that protocol is registered on a later start. An operator can
call `retryAppDelivery(topicID?)` to reset backoff and schedule an immediate retained pull and
matching delivery workers without replacing the peer. It returns when the attempt is scheduled.
`onAppDeliveryResumed` reports the same group, protocol, topic, position, and optional reason once
the reported block clears through delivery, drop, dead-frame handling, or segment rotation.
Disposal does not report a resume. An operator can
accept a frame's loss with `dropAppFrame(topicID, position)`; it can explicitly discard a
missing-protocol record, but refuses a pending frame under a registered protocol. It also refuses
to drop a sealed frame behind an earlier pending or sealed frame, because the durable cursor cannot
record that drop until the earlier frame is settled.

Without `GroupCrypto.pending`, retained event handlers run inside the peer's serial lane.
Those handlers must return before awaiting `commit()`, `replay()`, `recover()` or `drained()` on the same peer.
Schedule that follow-up work after the handler returns. The lane is not reentrant.
Durable pending delivery runs handlers outside that lane.

Durable delivery is off when `GroupCrypto.pending` is absent. Ephemeral events remain best effort;
directed traffic and anycast requests and replies keep their existing live completion or expiry
semantics. Log-intent pushes only wake a retained fetch: pushed bytes and positions never become
pending records. The hub must have appended the frame to the topic log before pushing it.
Frames pruned before a read, or lost after a failed durable open followed by retention expiry,
cannot be recovered; `onAppWindowPruned` reports a visible gap. A hub that only sends a log frame
by mailbox also gives no durable guarantee. A frame published at epoch E and first fetched after
this peer has moved past E is refused: the peer cannot authenticate its sender after that move.
A hub can withhold or omit frames. A frame claiming an epoch above this peer's current epoch remains
retained with the cursor behind it even if a commit fetch omits the matching commit. It opens when the
peer reaches that epoch, or an operator can explicitly discard it with `dropAppFrame`. A forged
far-future claim can hold delivery until that drop; `onAppDeliveryStalled` reports the wait once with
`reason: 'future-epoch'`. A frame below the current epoch remains refused.
The peer persists a pending rotation before adoption and co-commits its landed mark in the same
transaction as the new MLS state and control changes. At startup, anchor repair uses the target
epoch's exporter before replay or delivery. If a host advances past that target outside the peer,
the exporter is gone and a confirmed forced rejoin is required before app sends resume.

App-frame AAD is `[0x01, intent, ...UTF8(topicID)]`, where intent is `0x01` for log and `0x00`
for ephemeral. `frameAAD` reads this cleartext routing hint; only `unwrap` with the full expected
AAD authenticates it. Old bare-topic AAD fails to open, so mixed 0.9/0.10 app peers are
incompatible. Use `encodeAppAAD` and `decodeAppAAD` for the shared format.

An `event` procedure in a group protocol may declare `retain: 'log'`, which makes every dispatch of
it retained by the hub and pullable later, whatever the call site:

```ts
const chat = defineGroupProtocol({
  message: { type: 'event', data: { type: 'object' }, retain: 'log' },
})
```

Only `event` procedures may. `defineGroupProtocol` throws for a `retain` on anything else, and the
type rejects it too, so an erased type cannot slip one past. Correlation traffic
(`request`/`stream`/`channel`) is always ephemeral, and retaining it would be unsafe: a re-pulled
request re-fires its responder, and the rid/timeout/quorum machinery has no meaning outside its
original round.

Retention is the *protocol's* word, never the frame's. A retained frame naming an ephemeral
procedure was published `retain: 'log'` by a member whose dispatch would not do that, and the drain
drops it.

### The anchor

App-lane topics are derived from an **anchor** — a secret and the epoch it was exported at — that
sits at the last commit which changed the roster, not at the live epoch. Both constraints meet only
there: a Remove must move it, because an evicted member keeps every topic ID it derived; an Add must
move it too, because MLS ratchets forward and a member added at epoch E cannot export any earlier
epoch's secret. `max(last add, last remove)` is the only epoch that is both after every removal and
holdable by every current member, and every member reaches it by applying the same commit, so they
agree natively. A rejoin rotates it as well, on the applied commit's own external flag — a rejoining
member's effective join is its rejoin epoch, and nothing a roster diff can see moves.

`GroupPeer.anchorEpoch()` exposes where it sits.

### The returning-member drain

A peer that was away pulls each app topic's retained segment and delivers it through the *same*
handlers the live bus server is built from, so a drained frame and a pushed one reach the host by the
same door. Its own frames are not delivered — the live fan-out never echoes a publisher its own
broadcast, and a drain that did would make a returning member the only one to see its own messages
arrive.

The rule that makes the durable cursor safe: **a cursor may only pass a frame that is DELIVERED or
DEAD.** A frame sealed below the handle's epoch is dead (MLS ratchets forward — those bytes are
ciphertext forever), as is one that claims this epoch and will not open, as are bytes that are not a
sealed frame at all. A frame sealed *ahead* of the walk is neither: it opens once the walk gets
there, so the cursor stops behind it and the frame stays buffered. That distinction is what
`GroupCrypto.frameEpoch` exists for — `unwrap` throwing says "not my epoch" and cannot say which.

When the hub's retention floor has passed the position a peer had read to, the frames between them
aged out unread and the optional `onAppWindowPruned` callback says so. It is a notice, not an error:
the frames that survived are delivered either way. It over-reports (a peer whose own cursor frame has
aged out cannot prove nothing was published between it and the floor) and never stays quiet about a
real gap.

## What a host must supply for the commit lane

`mls`, `control`, `anchorStore`, `appCursorStore`, `appOutbox`, `appOutboxLimit`, `build`, `adopt`
and `deliverWelcome` arrive together — the params type requires the complete commit lane.
The stores preserve different durable state:

| | Without it |
| --- | --- |
| `control` — FIFO operations, rejoin, outcomes, Welcome obligations, applied commits, external responses and commit cursor | accepted control work and branch evidence are lost on restart |
| `anchorStore` — one slot, overwritten on every rotation, read once at construction | the peer re-seeds the anchor at its live epoch on the next restart and silently partitions from its own group, deriving topics no member that stayed up is on |
| `appCursorStore` — a read position per topic, written as each drain finishes | the peer re-reads its app history from the hub's oldest retained frame every restart, re-delivers what it already delivered, and has nowhere to notice the retention floor passing it |

Neither the anchor nor the cursor can be re-derived. The anchor sits at an epoch the live handle then
runs past, and MLS ratchets forward, so a rebooted handle can never re-export it.

The control store, MLS state and anchor slot share one host database. `build(op)` is speculative;
it returns the commit, candidate blob, entry bodies and complete invitation artifact. The peer
stores the exact framed payload before publishing and retries those same bytes after a crash.
For a permanent host build refusal, throw the exported `OperationRejectedError(reason)`.
The operation settles as `rejected`; this releases its revoke hold (other unsettled revokes
still hold sends) and lets subsequent operations run. A plain `Error` is treated as transient
and retried, leaving the intent queued and its revoke hold in place. Use that for temporary
storage or service failures, not an unauthorised operation.

`adopt(journal, expected, write)` is idempotent, compares the source identity and preserves sender
and receiver ratchet progress. It commits `AdoptionWrite.changes`, `mutationID` and any matching
anchor landed mark in the same transaction as the MLS state. Incoming and recovery adoptions use
that same transaction contract. The host resolves ambiguous state saves; the peer resolves an
ambiguous state-free `control.apply` through `lastMutation()`, pausing until read-back succeeds.

`enqueue(request)` resolves once the intent is durable. `commit(request)` also waits for a landed
outcome in the current process. `outcomes()` reads durable results; `ack(id)` removes one after the
host handles it. Operation deadlines start at `enqueuedAt`, so restarting does not extend them.
Any unsettled operation with `revokes: true` holds retained app sends. The peer retains the newest
64 epochs of applied commits and external responses for replay and confirmation.

`deliverWelcome(obligation)` resolves when the delivery transport durably accepts the complete
artifact. Delivery is at least once and independent of local adoption; an obligation survives a
rejoin. Hosts must make repeated delivery safe.

Captured recovery uses `RejoinRecord` (format 2), reply v2 and candidate codec v3.
The durable record saves exact payload, publish ID, request key, candidate, source, target and authenticated capture before publication.
`RecoverySource<TTrust>` and `ResyncProof` are portable contracts. Ordinary `readRecoverySource()` returns identity-only `AdoptionExpected`.
Registry hosts use the concrete adapters in `@kumiai/mls-rpc`.

The responder captures a committed MLS snapshot and complete reconciled log prefix together.
`captureHead` is explicit null for an empty prefix, or an opaque nonempty string of at most 64 JavaScript characters.
The signed reply binds this head and the committed epoch authenticator.
Initial `expectedHead` equals `captureHead`. Capture, target and search origin remain immutable.
Only authenticated recapture can refresh `expectedHead`, including a lower head.
Encrypt the request key and candidate at rest.

Authenticated applied state decides whether saved attempt X was accepted. Log search supplies confirmation hints.
Same capture epoch and authenticator retries identical bytes, ID and candidate at the recaptured head.
A later epoch containing X's exact fresh cryptographic LeafNode proves acceptance. Identity or leaf index alone never suffices.
Adoption still requires bound confirmation at X's saved position and epoch.
Otherwise, one transition clears X and stores compact `accepted-unadoptable` facts with cumulative owed ledger tokens.
A fresh attempt replaces X's sole identity leaf under normal admission policy.
Later leaf absence permits policy-gated replacement of unconfirmed X, preserving obligations as `not-accepted` settlement.
Confirmed X retains accepted facts even after later removal.
Its settlement keeps X's saved `epochAfter` and own leaf digest. The floor advances to the authenticated recaptured epoch.

`recoveryEpochFloor` stores the highest authenticated capture epoch through first save, settlement, discard and restart.
Head ordering never rejects authenticated recapture. Stale epochs preserve X and retry, with backoff capped at 15 seconds.
Settlement omits retired request keys, candidates and payloads. Owned secrets are zeroised after proven commit.
At most one cumulative settlement remains per source incarnation.
Busy groups can repeatedly accept attempts then advance before confirmation. This remains a liveness residual.

Hub drops, delays, replays, tampering, junk and unknown versions mean non-delivery.
They never authorise durable safety holds, adverse settlement or deletion of owed work.
Re-encoded no-entry commits ignore the blob. Named-entry recognition uses the receiver's MLS and reference-validation predicate.
Failed copy recognition preserves the saved slot and unknown acceptance. Ordinary retries reuse exact saved bytes at a fresh head.
Only refusal of the authenticated commit itself authorises a terminal negative verdict. Blob-negative verdicts remain advisory through replay and caches.

The registry coordinator drains source callbacks and peer work before restoring the raw pending candidate and switching incarnations.
`RecoveryContinuationPort` retains the adopted record in source storage while the destination bootstraps, even after destination epoch advancement.
`RecoveryCompletion` settles accepted source operations as unknown once, then records missing reenact tokens after destination ledger verification.
Source outcomes, history and owed Welcomes remain serviceable. Destination state receives no source ratchets, applied rows, anchors or app cursors.

Unadopted legacy records retain every byte and retry with `legacy-recovery-record`; successor retirement in `@kumiai/mls-rpc` is the explicit exit.
Installed legacy continuations require independent installation proof. Automatic captured attempts use null-authorisation records.
Full registry crypto, leases and batching remain 2.3.
These tests prove phase-2 memory reconstruction. Child-process SIGKILL evidence belongs to phase 6.

For an authenticated Welcome newer than held state, stop and drain the peer before replacing the
group. The host's `seed({replace: true})` compare-and-sets the stored version and, in one root
transaction, installs the joined state, applies `readmissionChanges(snapshot)` and clears the
anchor slot. Open operations and rejoin become `unknown` outcomes; applied commits, responses and
the commit cursor are cleared. Existing outcomes and Welcome obligations remain. A new peer
captures the anchor at the joined epoch. An equal or older Welcome is `alreadyJoined`.
Hosts derive `judgeWelcomeAdmission`'s `held.forkHalted` from `forkHalt`, never from `recoveryUnavailable`.
Fork-halted tombstones refuse ordinary readmission.
With valid retained trust, a recovery-unavailable field alone permits an otherwise admissible Welcome into the next incarnation.
Missing, unreadable or empty-spent trust refuses seed as unavailable. Welcome and GroupInfo cannot reconstruct the spent set.

`controlSettled(snapshot)` must be true before host deletion. `abandon()` explicitly accepts loss
of open operations, rejoin and undelivered Welcomes; outcomes still need acknowledgement.

The hub is asked to retain both the commit log and the app log for **28 days** by default. Two days
below the reference hub ceiling, deliberately, so an upward override has somewhere to go: a hub
refuses a retention above its ceiling rather than clamping it, and a default sitting exactly on the
ceiling would make every upward override an outright refusal — leaving the peer not a subscriber of
its own commit topic. The two windows are aligned so there is no span in which a returning member can
rebuild its membership but not its messages.

## Durable safety holds

`ControlSnapshot.forkHalt` and `recoveryUnavailable` hold immutable, incarnation-scoped evidence.
Their first write atomically stores a `group:fork` or `group:recovery-unavailable` event.
Retirement and deletion retain old-incarnation evidence. Acknowledgement removes an event without clearing its field.
Identical field reapplication does not recreate an acknowledged event. There is no public field-clearing API.
`ForkHalt`, `GroupForkEvidence`, `GroupSafetyEvent`, `RecoveryUnavailableEvent` and `SafetyHold` are exported here and re-exported by `@kumiai/mls-rpc`.

Under either safety reason, peer sends reject with `SendNotAdmissibleError(reason)`.
Enqueue, direct crypto, registry mutation, resync, reauthorize and consumer `recover()` refuse with `GroupSafetyHeldError(reason)`; automatic recovery stops without error.
`reauthorize()` throws synchronously. Held crypto/resolver refusals latch the reason and retain the unprocessed frame and cursor for retry.
New opens, control publication and automatic recovery stop. Already opened handlers may finish.
Stored outcomes/events, opened-record restoration, committed Welcome delivery and existing live certified settlement remain serviceable.
Restart publication of frozen settlement under a safety hold remains a 2.3 obligation.

Peers latch self-detected evidence and held port refusals immediately.
Registry safety sinks synchronously hold live consumers before durable writes finish. Restart loads committed safety fields before network work.
`GroupSafety.events(key)` in `@kumiai/mls-rpc` supplies the complete durable safety history until acknowledged.
Its `ackEvent(key, id)` leaves safety fields intact. `AppOutbox.ackEvent` rejects stored safety events and ignores absent IDs.

Optional `onSafetyEvent` fires at most once for this peer's matching halt after proven persistence, outside locks.
It contains callback failures and promises no replay or notification for another writer's evidence.
A validated latch holds the current process through failed or ambiguous writes. Only proven commits survive restart.
A crash before writing can lose volatile host evidence, despite in-process storage retries.

`canMoveCurrent(inputs)` decides whether a device may move to another hub without rejoining (see `@kumiai/mls-rpc` Hub migration).
It refuses any hold, condition, active rejoin, known lag, unresolved publication or settlement and pending owner work.
An open fork notice refuses unless `allowOpenFork` is set, which overrides that predicate only.
A current move resets commit and checkpoint positions but does not reset app-topic cursors; hosts must reset their app-topic cursors after a current move.
After lost spent trust, the exits are a successor group (new groupID) or, after total key and database loss, a fresh invite into the same group.

## Checkpoints and fork notices

Every eligible installation publishes a signed checkpoint on `checkpointTopic(recoverySecret)`.
The hub `authorize` hook must gate the checkpoint topic with the same rule as the commit topic.
Frames are at most 4096 bytes, strict Ed25519, and carry `keyHash`, `leafIndex`, `epoch`, `authHash` and `parentAuthHash`.
They name no DID: verifiers resolve the signer privately in their own retained roster fact.
Anyone who can derive the topic sees those fields, so frames reveal key hashes and epoch progress, not identities.

Publishing uses `retain: 'log'` without `expectedHead`: once per installation, then the exact current frame every 30 minutes (±20% jitter).
Drain is one frame per second, burst eight, retries capped at 15 seconds. Receive takes at most 32 frames, 128 KiB and 64 signature checks per turn.
Each group adds one checkpoint subscription and this publish traffic; no cross-group scheduler is included.
The hub's retained-log policy is the app's and hub operator's; peers request seven days.

A signer counts once per DID when its DID and key hash are in our retained roster fact before the split.
Same-key unequal statements are reported as `equivocations`. Remote input never induces signing.
Local facts cover the newest 256 installations; superseded facts expire seven days after local supersession or outside that set.

Detection limits: a fork is visible only when both branches' checkpoints reach this device within retention.
A hub that also withholds checkpoints, a split across separate hubs, or expired facts hide it. Detection never halts, switches or picks a branch.

A conflict opens or updates a `ForkNotice`: best-known `splitEpoch`, per-branch `authHash` and signers, this device's `deviceAuthHash`,
`atRisk` own messages, and `coverage` (`evidence`, `ownMessages`, `ephemeral`). Times are local clocks; hub timestamps are never used.
`fork-detected` replays until acknowledged. `fork-updated` fires only on material change, at most once per 30000 ms.
A notice closes after 86400000 ms with one branch active, or when the device switches branch.
Evidence stays within the 256-installation / seven-day bounds even while unacknowledged; acknowledgement never extends them.
Closed evidence expires at the earlier of acknowledgement plus seven days and those bounds.

### Branch abandonment

When a switch leaves epochs this device installed, `branch-abandoned` reports `epochs` (`{from, through}` or `'unknown'`),
the open `noticeID`, own message IDs (`ownMessages`), a count of others' messages (`othersSeen`), and `membersAdded`/`membersRemoved` on the abandoned branch.
Plaintext is not retained: the app resends its own messages from its copy, never others'.
Own-send IDs are journalled per epoch; others are counted, never stored. Ephemeral sends are never covered.
`coverage` marks `ancestry`, `ownMessages`, `othersSeen`, `membership` and `ephemeral` each `complete` or `partial`, with reasons `pre-journal-history`, `retention-gap`, `unknown-ancestry` or `ephemeral-uncovered`.
Unknown ancestry reports `'unknown'` without delaying the switch.

### Fork floor exception

With an open notice splitting at E, recovery may adopt the hub's branch below `recoveryEpochFloor`.
It needs an eligible, non-equivocating signer from our pre-E roster whose signed checkpoint at E differs from our fact,
a reply lineage binding that checkpoint to the offered state, and offered GroupInfo epoch F >= E whose `confirmedTranscriptHash` differs from our fact at F.
Retained facts store the installed `confirmedTranscriptHash`; checkpoints never publish it.
The check repeats for every capture, retry and restart. Only that attempt gets effective floor E; the ordinary floor never changes, and settling or abandoning it removes the exception.
F below our oldest fact, or in a retained-range hole (epochs crossed by external commit), stays `target-behind` until that branch reaches a retained epoch or passes our newest.
F >= E uses the notice's best-known split; a notice moving E earlier re-enables authorisation.
Expired evidence (seven days or the 256-installation bound) also leaves healing `target-behind`. Manual resync is the exit in every case.
No distinct-DID threshold applies, so two-member groups heal. A deliberately coherent fake GroupInfo plus checkpoint chain is an accepted insider residual:
the fake state stays the attacker's and honest members never confirm it.

Recovery requests carry `comparisonEpoch`: E for fork recovery, otherwise the newest retained epoch. It is cleartext on the rendezvous topic,
visible to the hub and subscribers with the requester DID and ephemeral key. Responders send only signed lineage from that epoch through F,
at most 256 frames, and the complete reply stays within 786432 bytes. That bound does not hold 256 maximum-size frames; a span that does not fit is not sent.

### Conditions

`GroupCondition` is `not-member` or `spent-set-corrupt`, separate from hard `SafetyHold`.
Precedence: hard holds > `spent-set-corrupt` > `not-member` > recovery-unavailable > pending.

`not-member` is diagnostic and non-terminal: an eligible responder's verified head, tree and ledger lack our DID.
It adds no send-admission refusal; recovery keeps retrying with capped backoff.
Former-member disclosure needs the requester's DID and key hash in a responder's retained earlier roster; replies carry public roster and ledger only.
That discloses history to any DID+key pair the responder once held, and nothing to never-seen or expired pairs.
A changed leaf never proves absence, so a present DID on an obsolete incarnation (old key) can stay pending.
Freshness is lineage-relative: same lineage needs a reply epoch above our newest installed epoch; a different lineage (unequal `authHash` or `confirmedTranscriptHash`) needs none.
Evidence (`NotMemberEvidence`) carries responder `responderKeyHash`, `epoch`, local `observedAt`, distinct `responderDIDs` and `responderCount`.
Any install, head-only reconcile or re-anchor clears it. Failure or a pending proof does not.
`no-reply` (nothing received) and `no-eligible-responder` (replies, none eligible) never prove removal.

`spent-set-corrupt` means a surviving store decrypted a missing or malformed spent set. An unreadable trust envelope stays recovery-unavailable.
Total key and database loss is not corruption: the app re-invites the device into the same group.

Apps should not dispose or delete on first evidence. Wait for another responder DID or for the condition to persist.
Disposal, deletion and re-invitation are app policy; corroboration is advice, not a protocol threshold.
`not-member` has no error class: it is a diagnostic condition, never thrown. `SpentSetCorruptError` (also re-exported by
`@kumiai/mls-rpc`, which throws it) carries the exact `key` when the throw site has one.

## Host notices for commit strands and recovery

`GroupPeerParams.onStrand` reports when the commit walk finds evidence that this peer is stranded.
One observation marks one stranded episode; further frames stay silent unless they provide strictly
stronger evidence. A successful recovery, including a bootstrap completed later, ends the episode.
The next strand starts a new one. A failed attempt leaves the episode open.
Ordinary strands persist in the commit cursor. Fork evidence persists in `forkHalt`, without creating a safety-derived strand or stranded cursor.
Notification deduplication is in memory, so restarting can repeat an observation.

Each `StrandObservation` names the stable commit-topic `groupID`, the frame's log `position`, the
peer's `localEpoch`, a `kind`, and a `confidence`. `claimedEpoch` comes from the cleartext header;
`commitDigest` identifies the commit bytes. Both are `null` for an unreadable future version.

| Kind | Confidence | What the evidence establishes |
| --- | --- | --- |
| `own-unmerged` | `authenticated` | Sender data identifies this device. Unrecognised copies diagnose and skip, preserving saved work and unknown acceptance. |
| `past-epoch-divergence` | `claimed` | Delivered bytes differ from local applied history. Skip without rewriting history or halting. |
| `ahead` | `claimed` | A frame's cleartext epoch is ahead of this peer. A commit-topic publisher can forge that claim. |
| `unknown-version` | `claimed` | A frame's handshake or commit-frame version cannot be read by this build. Its epoch and commit bytes are unavailable. |
| `retention-gap` | `observed` | The hub reports a gap beyond the covered commit cursor. The peer cannot prove the missing range contained no membership changes. |

Past divergence, including signed CAS losers, never creates a durable halt or frame-triggered recovery.
Unknown versions emit `upgrade-required` diagnostics and advance as poison.
Caught-up future app frames wait only within two epochs and for less than 30,000 milliseconds.
The age starts after commit-lane catch-up, so honest lag can exceed two epochs.
Host authenticator comparisons and genuine local storage invariants retain durable halt authority.
Historical halts remain immutable. Fork detection uses member-signed checkpoints (above) and never halts.

`GroupPeerParams.onRecovery` reports `started` and exactly one terminal event (`succeeded` or
`failed`) for each attempt. The event's `attemptID`, `groupID` and `trigger` (`automatic` or
`consumer`) stay the same. Failure reasons include `no-responder`, `renewal-required`, `refused`,
`unconfirmed`, `invalidated`, `deadline`, `bootstrap-failed`, `disposed`, `error`, `below-epoch-floor`,
`legacy-recovery-record`, `capture-authenticator-disagreement` and `target-behind`.
`error` includes the thrown value. Success means both the rejoin and ledger
bootstrap completed. If a rejoin landed but bootstrap failed, a later lane operation can finish it
and emit `bootstrapped` with that failed attempt's ID. This closes the stranded episode.

`invalidated` means the source re-check rejected a confirmed rejoin. Retry behaviour is unchanged.
Its `blockingPosition` identifies the blocking source-epoch frame, or is `null` for a gap or source-identity change.
Its `anchorRecovery` records whether anchor recovery held the peer at invalidation.
Repeated `invalidated` failures with `anchorRecovery: true` and the same non-null `blockingPosition` identify an anchor-gated livelock.
Captured recovery can reconcile authenticated applied state despite an unwalked source prefix.
Floor and legacy-record diagnostics preserve saved attempts and retry with backoff capped at 15 seconds.
`target-behind` identifies an authenticated recapture below X or its durable floor.
`capture-authenticator-disagreement` identifies unequal authenticators at X's capture epoch. Neither diagnostic halts the peer.
Failed requests zeroise locally owned keys. Proven attempt saves retain the key until settlement releases its live buffers.

For manual repair of an ordinary strand with valid retained trust and no fork halt, stop the peer and await `drained()`.
An authorised administrator removes the device's leaf and re-invites it with a fresh key package.
The device verifies and installs the newer Welcome through authenticated Welcome re-admission (D4).
That transaction resets control and anchor, settling open operations and the old rejoin as `unknown`.
It preserves existing outcomes and undelivered Welcome obligations. Consume the key package after persistence, then restart the peer.

`started` is dispatched asynchronously as the attempt begins, before any rendezvous reply or
terminal event is required. It can arrive while the attempt is waiting on a port call; an observer
that disposes the peer then ends the attempt with `failed` (`disposed`).

Automatic healing and calls to `recover()` share one in-flight attempt. Joiners get its result or
error; they do not start another attempt. Owed `reenact` entries are kept until the first
`recover()`, `commit()` or `replay()` that drains them. A direct `recover()` can therefore return
entries stashed by an earlier automatic heal. Durable `reenact` outcomes also retain the tokens
until the host acknowledges them.

`onStrand` and terminal `onRecovery` notices run after the producing commit-lane operation settles.
`started` is dispatched earlier. None is awaited; throws and rejections are swallowed. `onAppWindowPruned`
retains its existing behavior.
