# Spec P: transactional persistence — design

Date: 2026-10-08
Status: draft r15 (2026-10-09)
Parent: [client host, messaging protocol and multi-device e2e](2026-10-08-client-messaging-e2e-design.md)
Control baseline: [Spec P2a](2026-10-08-spec-p2a-crash-safe-control-design.md), superseded where amended here.

## Model

**Trust (r14 decision).** Use a strongly consistent delivery service: trust the hub for commit ordering
(compare-and-set) and availability, never confidentiality or authenticity.
Clients detect faults and forks; fork evidence halts the group durably and requires manual recovery.
A device stranded without fork evidence automatically resyncs. Consistent split views require out-of-band
comparison of epoch authenticators; in-log detection cannot expose them.
See [RFC 9750 §5.2–5.2.1](https://www.rfc-editor.org/rfc/rfc9750.html#section-5.2).

1. **Incarnation monotonicity (r14 decision).** Key local state by `(groupID, incarnation)`.
   Epochs never decrease or change same-number authenticator; recovery atomically installs `n+1` and tombstones `n`.
   This removes in-place rollback, lineage/floors, recovery progress merges and anchor ordinals.
2. **Commit-once (r14 decision).** Durably save exact control bytes, publishID and candidate before publication.
   Head-only retries reuse them. Build again only after the epoch changes.
   This removes handshake reservations, burn budgets, baseline readers and staging-clone rules.
3. **One transaction per transition (r14 decision).** All affected group namespaces share one provider transaction.
   Bounded adaptive batches amortise commits and release the group scope between batches.
   This removes internal cross-store ordering seams and chat-specific coordination.

This is a proposed contract, not an implementation claim. Phase 2 supplies memory doubles and conformance;
phase 3 supplies database providers. P2a remains the control stage machine, with the amendments below.

## Decisions

### D1. Detection, durable halt and recovery

Keep `onStrand` observations and their confidence. Classify evidence before selecting recovery:

| Observation | Action |
|---|---|
| Past-epoch digest divergence, on either classifier branch | durable fork halt; no winner continues automatically |
| Host reports different authenticators for the same group/epoch | durable fork halt |
| `own-unmerged` | settle the exact saved build before walking it; unexplained own commit halts as ordering evidence |
| `ahead`, retention gap or unprocessable gap, without fork evidence | catch up if possible; otherwise durable stranded state and automatic resync |
| Unknown frame version | hold sends/control and expose the diagnostic; do not skip it or resync to bypass unsupported semantics |
| Lost local MLS state, with recoverable identity/lifetime metadata | stranded; automatic resync |

Past-epoch divergence is observed evidence, not an authenticated proof of the competing commit or a divergence epoch.
The 64-epoch applied window remains: missing retained evidence can miss a fork.
Strand signals alone do not prove a fork. Fork evidence takes precedence over stranded recovery and survives restart.

**Fork halt (r14 decision).** Immediately hold the runtime while committing the halt, evidence and a stable-ID
machine-readable `group:fork` event in one group transaction. Failure/ambiguity keeps the runtime held.
After proven commit emit the event; replay until acknowledged. Event acknowledgement never clears the halt.
Block durable and ephemeral sends, new opens, control enqueue/build/adoption/publication and automatic recovery, live and after restart.
Already opened handlers may finish; storage-only outcomes/events and certified settlement remain serviceable.
Keep local history. Do not choose a winning branch, erase evidence or automatically reenact fork-touched operations.
Already handed-off network bytes cannot be recalled. Restart loads the halt before enabling any network work.

Expose the current committed `{groupID, incarnation, epoch, authenticator}` as defensive copies to the host.
Only compare authenticators for the same MLS group/epoch; differing epochs alone are not fork evidence.
The host supplies out-of-band comparison and may report a mismatch through the durable halt API.
A hub serving each client a consistent isolated view can evade every local log check.

**Automatic stranded resync (r14 decision).** Obtain an authenticated, member-signed GroupInfo through the existing
sealed reply. Verify its group, signature/tree, credentials, binding/holder evidence and replacement policy.
Create a fresh leaf and external commit with `Remove(own old leaf) + ExternalInit`, using
[RFC 9420 §12.4.3.2](https://www.rfc-editor.org/rfc/rfc9420.html#section-12.4.3.2).
A reused leaf index does not reuse secrets: the candidate has a fresh secret tree, generations from zero and no old history.
A removed device cannot use resync to bypass admission; absence of its matching old leaf requires a new invitation.
Lost MLS bytes are not a resync input. Retain/restore the device credential and host policy.
Surviving stores retain lifetime metadata. Total loss and backup restore follow the distinct rules below.

**GroupInfo capture head (r15 decision).** The responder reconciles a complete commit-log prefix before capturing its reply.
Under its group owner gate, capture the committed MLS snapshot and that prefix's cursor together.
`captureHead: string | null` names this commit topic's log position where the exported GroupInfo epoch is current.
Null means an empty prefix. Neither a delivery cursor nor an unreconciled hub head qualifies.

Add required `captureHead` to the signed responder attestation's JWT payload.
Its encoding is a JSON string containing the exact log position, or explicit JSON null.
The JWT payload uses base64url-encoded canonical UTF-8 JSON, with `captureHead` sorted before `groupID`
(`node_modules/@kokuin/token/lib/utils.js:11`, `node_modules/@sozai/codec/lib/index.js:183`).
It lives inside the length-framed UTF-8 attestation token, before GroupInfo in the sealed plaintext.
Existing framing remains: `u32(tokenLength) || token || GroupInfo`, or lifecycle `u32(tokenLength) || token || u32(GroupInfoLength) || GroupInfo || ledger`.
Lengths remain big-endian. The existing signature binds the field, group, request and exact GroupInfo digest together.
HPKE seals that signed token using the existing group/member/request authentication boundary (`packages/mls/src/recovery.ts:261`, `:566`, `:618`).
This recovery-reply wire change stays within the 0.x band and requires coordinated producer/consumer updates.
Use GroupInfo reply version 2 and HPKE info/AAD domains `kumiai/mls/recovery/v2` / `kumiai/mls/recovery-aad/v2`.
The outer frame remains `u8(version) || enc(32 bytes) || ciphertext`. Ledger-only replies keep their existing format.
Refuse v1, missing/wrong-type `captureHead`, invalid positions and failed attestation verification before building any external attempt.

Persist `captureHead` with the exact external bytes/ID, candidate, request key and target before publication.
Initial publication MUST set `expectedHead = captureHead`, including explicit null. Search for exact acceptance before any retry.
On mismatch with proven absence, reconcile `(captureHead, currentHead]` completely using normal MLS validation.
If no valid commit advanced the epoch, update only `expectedHead` and republish identical bytes/ID/candidate (commit-once).
Non-commit, invalid and poison frames alone do not invalidate GroupInfo. Repeat reconciliation after every further mismatch.
If a valid commit advanced the epoch, discard the attempt unadopted and request fresh authenticated GroupInfo.
Under r14's honest ordering assumption, this refuses stale-epoch publication/adoption. It cannot defeat a split-view hub.
See [RFC 9750 §5.3](https://www.rfc-editor.org/rfc/rfc9750.html#section-5.3).

**Reconciliation limit (r15 decision).** Proof requires validation state for the capture epoch, including necessary secrets and referenced proposals.
GroupInfo supplies no old receiver secrets. The external candidate has only fresh post-commit secrets and empty history
(`packages/mls/src/group-welcome.ts:226`, `node_modules/ts-mls/dist/src/createCommit.js:291`).
After losing those secrets, a well-formed encrypted commit cannot generally be distinguished from an invalid encrypted frame.
Do not infer poison-only absence. If the prefix is incomplete, unsupported or unclassifiable, and absence of the exact attempt is proven,
discard the attempt unadopted and request fresh authenticated GroupInfo (r15 decision). This is safe at the same epoch:
external commits are publicly framed (no handshake ratchet), and each attempt derives every secret from its own fresh
KeyPackage and ExternalInit (`node_modules/ts-mls/dist/src/createCommit.js:234`), so a new attempt reuses no key material.
Never discard while acceptance is unknown (gap/unresolved search): hold until proven accepted or absent.
Keep bound confirmation/refusal of the exact external commit's application and normal MLS validation.
A responder verdict does not choose a fork or authorise replacement of the old record in place.
Remove P2a's separate lower-epoch candidate-admission/source-prefix algorithm.
Persisted accepted/confirmed stages replay the same attempt; an adopted stage never reinstalls its candidate.
Policy refusal remains durable until host action; transport/no-responder failures retry with backoff while stranded.

**Total database loss (r15 decision).** Losing the spent set is safe only when all prior Welcome-decryption material is also lost.
KeyPackage init/HPKE private keys MUST share group state's provider, transaction scope and loss/restore boundary, or derive only from it.
This includes ordinary packages, retained last-resort packages and every recoverable copy. A separately surviving store is forbidden.
A new empty store may start without the spent set only under this condition. Old Welcomes then remain undecryptable.
Retained signing credentials alone cannot recreate these independently generated keys (`node_modules/ts-mls/dist/src/keyPackage.js:62`).
Recover through fresh external resync, or a fresh invitation when replacement admission refuses. Partial metadata loss still refuses.

Today ordinary `KeyPackageRecord.privatePackage` and `LastResortRecord.privatePackage` hold `encodePrivateKeyPackage` output
(`packages/mls-hub/src/pool-store.ts:24`, `packages/mls-hub/src/store.ts:21`, `packages/mls/src/key-package-codec.ts:91`).
The pool/provisioner writes host-injected stores before upload (`packages/mls-hub/src/pool.ts:117`, `packages/mls-hub/src/provisioner.ts:135`).
MLS generates bundles and accepts private material at Welcome processing. It does not persist those packages itself
(`packages/mls/src/group-credential.ts:71`, `packages/mls/src/group-welcome.ts:95`).
These source ports currently impose no shared provider scope. Phase 2/3 MUST add that contract and shared-provider adapters.
Separate source namespaces and consume transactions may remain, but their provider/loss boundary MUST match group persistence.

**Backup restore (r15 decision).** The host MUST call `declareRestoredFromBackup()` before registry access, peer startup or network work.
Persist the declaration before processing restored groups. An unfinished declaration keeps startup held across restart.
Every restored group remains held until external-commit resync installs a new incarnation and fresh leaf before any send, including ephemeral sends.
Restored MLS state is recovery metadata, never a send source. Preserve fork halts and replacement/admission policy.
Fork-halted groups still require manual recovery authorisation. Removed devices still require a fresh invitation.
Discard all restored unused KeyPackages and all retained last-resort private packages, then mint fresh replacements before advertising availability.
Never resume an old pending package upload. Revoke their hub copies where supported and persist retries for failed revocation.
The current hub offers upload/fetch/status, without revocation (`packages/hub-protocol/src/protocol.ts:193`, `:241`, `:262`).
Replace its last-resort slot. Old ordinary copies can remain until fetched/expired, and already fetched copies cannot be recalled.
Welcomes built from those copies fail because local private keys were discarded. This leaves an invitation availability residual.

Each group transaction records its restore hold and fails every restored outbox entry with a stable-ID `database-restored` event.
This includes restored settlement obligations. This restore-specific failure rule supersedes D6's normal settlement exception.
Failure describes local abandonment, not proof of remote non-delivery.
Events retain original entry data and replay until acknowledged. No restored entry is published or automatically resealed.
Declaration completion requires proven package invalidation and every group hold/failure transaction. Failure/ambiguity keeps startup held.
Each successful resync clears only its group's restore hold in the D2 switch transaction. Other groups remain held.
Normal installations initialise `restorePending` to false. Ordinary seed/adopt cannot clear a declared restore hold.
An undeclared backup restore is outside the model: rolled-back spent sets and ratchets cannot reveal their own lost future.
They can admit old Welcomes or reuse keys/generations. This rollback rule applies
[RFC 9750 §6.6's state-loss reinitialisation guidance](https://www.rfc-editor.org/rfc/rfc9750.html#section-6.6).

**Manual fork recovery (r14 decision).** Only a host invocation authorises resync onto a chosen hub/commit topic,
or retirement in favour of an already admitted successor group. Persist that authorisation/target so restart can resume
only the selected attempt. Failed/refused recovery leaves the old halt intact. Same-group success uses D2's incarnation switch.
For a successor, the application first creates/joins it through normal admission, then retires the halted source in its own group
transaction; these are separate group transitions. Copy no epoch state or messages between groups.
The application coordinates routing and membership; kumiai neither chooses a destination nor migrates peers automatically.
[RFC 9420 ReInit](https://www.rfc-editor.org/rfc/rfc9420.html#section-12.1.5) carries no hub/topic routing.

### D2. Incarnations, admission and local order

One live process owns the database; one registry owns each active incarnation and its non-reentrant group gate.
Every epoch-keyed value belongs to that incarnation: MLS state, application key ceilings/progress, control rows,
anchors, pending/opened records, outbox/meta, cursors, occurrences and local watermarks.
Administrative pointers/revisions/transaction markers locate records; they do not carry epoch state.
Stale owners/ports cannot silently follow a new incarnation and throw `DisplacedGroupHandleError`.

**Spent set.** The only cryptographic state carried between incarnations is the group-level spent-epoch-authenticator set.
Genesis, Welcome, own/received commit and resync append each installed authenticator in its installation transaction.
Progress saves, tombstones and deletion retain the sorted, unique defensive byte copies.
Missing sets in surviving/restored stores refuse. Only D1's total-loss condition permits a new empty set (r15 decision).
Welcome/seed/resync admission refuses spent authenticators before epoch comparison, including a valid alternate
Welcome representation with different bytes but the same authenticator. Completed mutation replay resolves its marker,
not candidate admission. No silent empty-set fallback or current-identity reinstall exception.

**Welcome admission (r14 decision).** Derive groupID/epoch/authenticator from the verified joined handle.
After the spent check: absent lifetime joins incarnation 1; a live incarnation at/above the Welcome epoch returns
`alreadyJoined`; a strictly newer authenticated Welcome may explicitly readmit after peer stop/drain; a tombstone may
admit any unspent valid Welcome into `latestIncarnation+1`. No highest-ever epoch floor exists.
A fork-halted group refuses ordinary readmission; only manual recovery can retire its halt.
Seed rechecks lifetime/revision/admission inside the transaction. Genesis requires absent lifetime, epoch zero and null joinRef.
Ordinary package receipts only short-circuit already-consumed Welcomes; a receipt never resurrects a group.
Last-resort sources consume nothing and always require spent admission.

**Switch (r14 decision).** Block new source work, settle in-flight publications and drain previously opened handlers.
One transaction validates the expected source incarnation/revision/version and exact resync acceptance, tombstones `n`,
installs fresh `n+1`, appends its authenticator, creates its anchor/control/cursor and records failed old outbox statuses/events.
Candidate epochs may differ from old epochs because these are different records. Within a record, lower epochs or
same-number different authenticators always refuse. No same-epoch replacement exception.
Copy no source progress, ceilings, cursor, applied row or anchor into the new incarnation.
Old unsettled operations become `unknown`; old outcomes and owed Welcomes remain addressable under `n` until ack/delivery.
Storage-only workers serve those obligations without starting an old peer. Old applied rows cannot mask new self-removal.
Resync bootstrap reports missing ledger tokens as `reenact`; only the host decides to enqueue them again.

Unpublished old outbox entries fail with `incarnation-abandoned` and durable events carrying the original entry and destination
incarnation. Programmatic retry may enqueue a fresh send. No automatic reseal/migration.
Certified settlement obligations finish as `published`, retaining their original occurrence/topicID.
History already written to host stores survives the switch; kumiai does not delete or reorder it.

**Order (r14 decision).** Use `(incarnation, anchorEpoch, position)` lexicographically within a durable lane.
`anchorEpoch` is the authenticated MLS capture epoch, not a local counter. Positions compare numerically only within that topic.
This extra epoch component is necessary because different anchor topics have independent position spaces.
Keep/restore preserves anchorEpoch; capture at an epoch has one identity. Resync recapture starts a new incarnation.
Late old-anchor frames retain their original epoch. Retired incarnations accept no new opens.
Host message dedup is `(groupID, author, id)`; the first occurrence keeps its order and persisted topicID.
Local read watermarks include incarnation; peer receipts remain `(authenticated topicID, position)` with no local incarnation on wire.
Different topics' receipt positions are incomparable. No lineage, admissionFloor, ordinal counter or topic-to-ordinal map remains.

### D3. Group transactions, adaptive batching and handlers

**Atomic transitions (r14 decision).** Welcome install, open/accept, adoption, switch, removal/terminal clearing,
publication settlement and outbox enqueue/attempt/status each write all affected kumiai namespaces in one group transaction.
Supplied host effects use that same transaction. Root facades share the coordinator; transaction-bound methods never nest it.
Prepare crypto outside the provider transaction under the group owner gate; the short transaction validates identity/version
and writes the prepared result. Publish runtime state, plaintext, acknowledgements, events and transport bytes only after proven commit.
Control build/publish/fetch/confirm and Welcome delivery always run outside transactions.

**Adaptive group commit (r14 decision).** Take whatever compatible work is ready; flush at the first applicable cap/bound:

| Host option | Default | Meaning |
|---|---|---|
| `maxBatchFrames` | 64 | maximum streaming opens/completions/settlements per transaction |
| `maxBatchDelayMs` | 2 ms | maximum coalescing delay once work is ready, excluding an already active transition |
| `maxBatchWorkMs` | 8 ms | stop adding work at the next operation boundary after this staging/work budget |

An idle group starts immediately: a lone frame waits for neither a timer nor a full batch.
Arrivals during active work coalesce for the next batch. Bursts of hundreds–thousands split into bounded transactions;
steady streams and interleaved low-rate commands use the same scheduler. One transaction may open/settle N frames.
Mid-batch crash/failure commits all state, pending records and transactional effects or none; expose no partial output.
Size/work bounds are finite and positive; delay is finite and non-negative. Provider calls and individual operations cannot be pre-empted.
Do not split an atomic install/switch/terminal transition; prepare values outside storage and bulk-write them.

**Fairness (r14 decision).** Release the group transaction and owner scope between batches, including catch-up.
At each boundary service ready control adoption, then round-robin other lanes and enqueue/completion work before another burst-lane batch.
Each ready source gets at most one capped batch per round. During lane A's sustained burst, ready lane B work and control adoption
complete before a second further A batch; with only A/B/control ready, both finish within three total batches including the active A batch.
The bound assumes protocol prerequisites, available storage and short/settling handlers. Enqueue cannot wait for backlog exhaustion.
Self-removal/switch additionally await their opened-record drain. Groups have independent gates/queues;
SQLite's physical writer limit does not authorise a global application mutex.

**Durable lanes only (r14 decision).** Only log-retained events use outbox/pending/cursor/completion persistence.
Ephemeral RPC requests/responses, streams/channels and signals perform no persistence and initiate no provider transaction.
Use memory-only receive progress and pre-reserved send leases (D5). Exhaustion rejects/holds the ephemeral call without storage work;
separately scheduled maintenance refills. A later independent durable transition may save current same-identity progress.
Ephemeral handlers have no replay/completion guarantee. Host `markRead` is a separate durable host action.

**Common handler boundary (r14 decision).** Default durable delivery is at least once. The open transaction persists plaintext,
authenticated sender/epoch, frame identity and stable idempotency key with consumed keys. After commit, invoke the handler outside
both gate and transaction. Success schedules one completion transaction removing pending and advancing the contiguous topic cursor.
Handler/completion failure leaves pending for retry. A failed record blocks its lane, not other lanes.
Only completed/dead frames advance a cursor; duplicate completion is harmless.

Opt-in transactional completion passes the group transaction to the handler. Effect, pending completion and cursor commit together:
exactly-once durable effect when the host shares the provider/DB, not exactly-once callback invocation.
These handlers stay short, perform no network I/O and use only supplied transaction stores. Every other handler runs outside a transaction.
No transaction callback awaits a root store, another group's gate or a timer. Multiple handlers declare one completion policy.
The frame key is JSON of `['kumiai/frame/v1', groupID, incarnation, topicID, position, protocol, procedure]`, stable across restart/redelivery.
Different occurrences have different keys; applications also dedup semantic message identity.
Chat MessageStore and outgoing status effects use this same transactional-or-idempotent model; no D7 special case.

**Terminal drain.** Commit self-removal's terminal flag and applied/control changes even without epoch advancement.
Block new opens/seals/publication, restore all already opened records and await their handlers/completion transactions.
Drain persisted plaintext without decrypting/fetching/opening more frames. Starting workers is not awaiting completion.
Then one clearing transaction settles certified entries, fails others and clears transport rows.
Failure delays clearing; disposal/timeouts never authorise pending erasure. Restart follows the same order.

### D4. Commit-once control

P2a retains FIFO intents, durable outcomes, revoke holds, Welcome obligations and exact external-attempt replay.
Pull to head before build. Build non-mutatingly and frame once, outside a provider transaction.
The built-save transaction revalidates source incarnation/epoch/authenticator and queue head, then saves exact full payload,
publishID, candidate/journal, required proposal/key material and complete Welcome before anything leaves the device.
A source move prevents publication. Retry a rolled-back save with the already prepared bytes.
Death before any built-save commit permits preparation again because no payload could have escaped.

**One source-epoch slot (r14 decision).** All private control/rotation builders share one durable commit-once slot per incarnation/epoch.
Direct calls, queue changes, outcome ack and deadline expiry cannot free it or create a second same-epoch build.
Retain it until epoch advancement or incarnation retirement. This avoids reusing ts-mls's discarded protection-tree generation.

**Mismatch/restart (r14 decision).** Search from the immutable original build head for the full payload digest, including bodies.
Found: record acceptance/Welcome obligation and adopt the saved candidate before walking our own frame.
Complete absence: reconcile intervening frames; unchanged incarnation, epoch and authenticator means refresh only expectedHead
and republish identical payload/ID. A head, proposal or stateVersion change alone never permits rebuild.
Epoch advancement permits a fresh build from the fresh handshake chain after intent revalidation.
Same-number authenticator divergence halts; incarnation retirement settles old work rather than rebuilding in the new owner.
Gaps/unresolved acceptance give `unknown`, not guessed absence. Fork evidence invokes D1, never automatic rejoin.

Retain candidate/journal and needed proposals/decryption keys. Missing references/keys hold the build and yield unknown at deadline.
Extra proposals do not invalidate saved bytes; omitted proposals are cleared on adoption and require reproposal.
Control builders pass `pendingProposals: {}`; rotation uses empty proposals/entries and refuses local pending proposals.
Reconciliation and ordinary adoption preserve current sender/receive ratchet progress in matching retained history, including after restart.
Never resurrect evicted epochs. Incarnation switches carry no progress.

**Deadline/outcomes.** Persist `enqueuedAt + operationTimeoutMs` (default 30 s), unchanged by restart/retry.
Before expiry retry transport failures with backoff. At expiry stop new publication handoffs and settle any in-flight acceptance.
Found exact payload becomes accepted/landed even after expiry; accepted work completes adoption/settlement.
Complete absence at expiry gives `lost`; gaps, uncertain acceptance or fork-touched work give `unknown`.
Expired never-built intent loses without building. Outcomes persist until ack; none releases the source-epoch slot.
An unknown build cannot be automatically replaced, including by a new operation ID. Other intents wait for epoch change;
a host may manually resync/readmit if no survivor advances. Once ordering trust fails, outcomes assert only locally observed facts.

**Adoption.** One transaction installs state/spent authenticator, applied row, external response when relevant, control cursor/outcome,
anchor changes and coupled settled outbox work. Recheck expected incarnation/identity/version inside the gate.
Already committed mutation/matching applied payload is idempotent; hub acknowledgement alone writes no applied row/cursor.
The current incarnation's terminal flag governs self-removal, independent of old epoch sorting.

### D5. Codecs, registry and application keys

**State codec.** Preserve `encodeClientState(state)` / `decodeClientState(bytes)` signatures.
V2 is `u8(2) || u32(bodyLength) || ts-mls body || u32(refCount) || refs`, big-endian;
each sorted ref is `u32(UTF8Length) || UTF8(proposalRef)` and names exactly a pending proposal with sender zero.
Decode a copied body, then restore zero. Duplicate/unknown refs, non-absent body sender, invalid lengths/UTF-8/trailing bytes refuse.
Empty/truncated input returns undefined; unsupported versions throw. Refuse every v1 blob: absence and lost zero are indistinguishable.

Recovery candidate v2 uses AAD `kumiai/recovery-candidate/v2` and complete
`sourceState = encodeClientState({...snapshot.state, ratchetTree: snapshot.sourceTree})`.
Decode it separately; never splice private-state bytes by envelope offsets. Refuse v1 candidates.
Keep requestKey, binding/holder evidence and bound exact-external-commit confirmation tuple.

**Registry.** Await shared cold load/restore/configuration validation before access. Validate groupID, epoch, credential and authenticator;
missing/tombstoned/invalid records expose no fabricated handle. Host supplies context/policy/resolvers and ordered tokens including repeats.
Only proven commits install runtime snapshots/notifications. Snapshots contain incarnation, epoch/authenticator, version, membership and
availability; publish defensive copies and contain listener failures. Simple access remains available.

**Application leases.** Scoped to incarnation/epoch/authenticator: reserve 16 generations, renew below 4, ceiling 500.
Pre-reserve the first lease with state installation; refill via independent durable work or coalesce with a ready transition.
Restore skips the committed ceiling before sealing. Failed/unpublished seals and unused skipped generations count.
Same-identity saves retain maximum ceiling/current progress; new epoch resets its ceiling; new incarnation inherits neither.
Lapsed/removed/suspended/pending-proposal restore permits control/pending replay; defer actual burn until encryption is allowed.
Every eligible seal discharges its burn obligation. At effective next generation 500, reject new durable acceptance, hold accepted entries
and schedule one rotation outside the gate. Lapse takes precedence. Directed replies/tunnels obey the same bound.

Registry-backed hosts/receivers require generation retention and forward steps at least 1000 through create/restore/Welcome/external join/
derive/recovery. Doubles obey that real window; ordinary MLS callers keep their defaults.
Non-admin rotation passes lifecycle checks, includes an update path, empty proposals/entries and unchanged roster/ledger;
it keeps the app anchor unless membership changes. No handshake HWM/reservation/budget exists.

### D6. Application publication and settlement

Outbox stores immutable plaintext, not application ciphertext or acknowledgement proof.
Each seal gets a fresh publishID and attempt containing incarnation, seal epoch, anchor epoch, floor and exact topicID.
Attempt/state/lease writes commit together before transport handoff. Failed/null in-process handoff retries prepared bytes/ID from memory.
Restart reseals only unproven active-incarnation entries. Epoch/authenticator or anchor-topic change invalidates prepared bytes;
a head-only move does not. Incarnation retirement fails entries without resealing.

Both proof paths and acknowledgements bind incarnation/epoch/authenticator, sealVersion and acknowledgement cutoff.
Snapshot before/after sealing/walking; suspend snapshots during uncertainty. A crossed walk, stale ack or no-new-head probe cannot
certify a replacement identity. The client result remains `{sequenceID}`; HTTP adds no `deduped` field.

**Durable settlement.** Before freezing proof persist `{sequenceID, attemptID, topicID, outcome: 'published'}`.
Capture expected identity/stateVersion/attemptID before queuing; inside the acquired gate/transaction reread live state and entry.
Require exact identity/version/attempt and stored topicID. Mismatch returns `recorded: false` with reason and changes nothing,
including hooks/markers/evidence. Gate-first certification commits before queued terminal/switch work; adoption-first invalidates stale proof.
Rollback retries retain the gate; ambiguity uses D7's completion barrier. Test both proof paths and both acquisition orders.

Obligated attempts cannot change. Identical obligation is idempotent; conflicting outcome rejects.
Removal co-deletes entry/obligation and writes published status/effects in one transaction.
Generic remove/terminal/switch clearing honours certified obligations; only unproven entries fail.
Frozen occurrence retains original incarnation/anchor epoch/position/sealed topicID after restart.
Disposal retains a storage-only finaliser; lifecycle drain waits for it. Restore obligations before sends/clearing.
Statuses are `pending → accepted → published`, or `accepted → failed`. Acceptance resolves after enqueue commit.
Transactional effects co-write host status; other hosts consume durable stable-ID events idempotently until ack.
Correlate host messages by semantic identity, not incarnation-scoped outbox sequence.

Unknown/repeated remove succeeds without another effect. Protocol/procedure/data are immutable.
Decode fatal UTF-8 JSON, broadcast v2, event type and matching procedure; invalid input rolls back acceptance.
Return `{procedure: entry.prc, payload: decoded.payload.data ?? {}}`.
Memory hub dedup becomes `(topicID, publishID)`, with original acceptance time and SQL's inclusive 365-day purge cutoff;
trim/ack/retries do not refresh it. Refused CAS claims no durable ID; accepted retry returns its original position.

### D7. At-rest protection, completion and external seams

Every factory requires host `AtRestCodec.seal/open(bytes, aad)`. Host owns all key lifecycle; kumiai stores no at-rest key.
Seal every persisted namespace, including lifetime/spent set, state, control, anchors/secrets, pending, cursors, outbox/meta,
events/obligations, recovery targets and topicIDs, including retained retired records.
KeyPackage private material and backup-restore declarations/holds also require at-rest protection in the shared provider (r15 decision).
Queryable group/incarnation/sequence keys, revisions/locks/mutation markers may remain clear.
Topic locator is a digest; actual topicID exists only inside sealed values.
AAD is UTF-8 JSON of `['kumiai/at-rest/v1', groupID, incarnationOrNull, namespace, recordID]`:
lifetime uses null; state/control/anchor use fixed slots; pending uses frame ID; cursor uses topic digest;
outbox uses String(seq); metadata/event IDs use tagged tuples. Physical duplicates retain logical AAD identity.
Device-scoped KeyPackage/declaration records use ownerDID, null incarnation, distinct namespaces and sourceID/ref or declaration ID (r15 decision).
Seal failure rolls back the whole transition; open failure exposes no handle/payload or plaintext fallback.
Memory persists sealed bytes without a plaintext shadow map. Provider encryption alone cannot satisfy this contract.

**Ambiguity.** Rejected COMMIT can still commit. One mutationID/revision and coordinator own completion across all namespaces.
Keep the group gate, sequence reservation and both hook queues until proof. Never release payload/state/callers on raw negative reads.
State-free P2a apply may throw canonical `StorageOutcomeUnknownError`; `lastMutation()` first performs the same completion barrier.
Each transaction unconditionally upserts/updates retained `groupOwner(groupID)`. After uncertainty, a fresh root transaction takes
that lock, then reads markers in subsequent statements. Postgres READ COMMITTED waits on the original owner-row writer.
SQLite/Expo require completed COMMIT/ROLLBACK or a clean connection plus first-write writer-lock barrier.
Quarantine uncertain connections. Acquisition/timeouts alone prove nothing. Retry barrier/read failures from 100 ms doubling to 15 s,
outside transactions; other groups continue. Matching mutation proves the whole commit; exact previous revision proves rollback only
after the barrier. Unexpected marker is ownership conflict. Marker survives deletion/switch to prevent late resurrection.

Known completion settles its commit/rollback hooks before caller release. Unknown completion retains both queues and a settlement token;
marker proof settles exactly one queue before state installation/release. Repetition is idempotent; contradiction is ownership error.
Contain hook exceptions. After process death durable events/status/obligations supply replay.
Phase 3 requires `StoreProvider.scope: 'root' | 'transaction'`; factories reject non-root providers with `NonRootProviderError`.
Use only supplied transaction stores, await every started write, CAS through plain UPDATE affected counts including Expo.
Nested inline transactions cannot supply completion boundaries.

**Remaining external seams.** Welcome installation co-writes state/spent set/joinRef/control/anchor;
then ordinary package consume deletes the package and writes its receipt in a source-namespace transaction on that same provider (r15 decision).
After successful consume/receipt, clear the exact sourceID/ref through a group transition. Different non-null ref conflicts;
already-null clear succeeds. Last-resort consume remains a no-op. Installation and consume remain separate transactions.
Control publication/confirmation and Welcome delivery remain network seams. Deliver Welcomes at least once and delete obligations
only after transport acceptance. Revoke holds cover retained submissions; D1 fork halt additionally covers ephemeral sends.

Deletion blocks owner creation, stops/disposes peer and awaits opened handlers, completion, submitted network work, finalisers and
ambiguity resolvers outside the gate. One transition tombstones/clears transport state with optional host effects.
Unsettled control in any incarnation refuses with canonical `GroupControlUnsettledError`; explicit abandon/ack is the escape.
Host history/spent set survive. No timeout/rejected save authorises lifecycle handoff.

Lift authenticated opened epoch metadata on durable replay/live/ephemeral, anycast and all directed invocation kinds.
Optional broadcast transit metadata carries epoch; group adapters require it, with no current-epoch fallback.
Transport sender/epoch overrides spoofed wire/header fields. Directed `kumiai/epoch` describes the invoking frame.
Extract MLSEncryptor over loaded registry access/committed snapshots; receive reports exact successful-open counts.
Sequential epoch advance with unchanged incarnation/surviving membership keeps a tunnel; unavailable membership, removal, jumps or switch
close it once. Keep sender checks, stale-reply retirement and disposal unsubscribe.
Hub-client buffer injects inspectEpoch/currentEpoch/onEpochChanged: unauthenticated prefilter, malformed/unknown frames pass through,
notifications wake work, disposal unsubscribes and reconnect/retry preserves retention.
Automatic origin `/info` integration remains blocked; phase-2 HTTP smoke injects server DID.

## Interfaces

Types in this section are normative. Existing P2a types retain unlisted fields.
Incarnation-scoped adapters cannot silently substitute the active incarnation for a stale caller.
Conformance mirrors reproduce these fields and signatures without importing implementation packages.

### Group persistence and transactions

```ts
export type GroupKey = { groupID: string; incarnation: number }
export type EpochIdentity = GroupKey & { epoch: number; authenticator: Uint8Array }
export type JoinRef = { sourceID: string; ref: string }
export type GroupLifetime = {
  groupID: string; latestIncarnation: number; activeIncarnation: number | null
  revision: number; mutationID: string; spentEpochAuthenticators: Array<Uint8Array>
  restorePending: boolean // (r15 decision) cleared only by fresh-incarnation resync
}
export type GroupStateRecord = GroupKey & { version: number } & (
  | { deleted: true }
  | {
      deleted: false; terminal: boolean; epoch: number; epochAuthenticator: Uint8Array
      state: Uint8Array | null; credential: { id: string; groupID: string }; ledger: Array<string>
      senderHWM: number; joinRef: JoinRef | null
    }
)
export type GroupTransaction = {
  groupID: string; onCommit(fn: () => void): void; onRollback(fn: () => void): void
}
export type IncarnationStores = {
  state: {
    load(): Promise<GroupStateRecord | null>
    save(record: GroupStateRecord): Promise<void>
  }
  control: {
    load(): Promise<ControlSnapshot>
    apply(changes: ControlChanges, mutationID: string): Promise<void>
  }
  anchor: { load(): Promise<AnchorSlot | null>; save(slot: AnchorSlot | null): Promise<void> }
  pending: {
    list(): Promise<Array<PendingAppFrame>>
    put(records: Array<PendingAppFrame>): Promise<void>
    complete(ids: Array<string>): Promise<void>
  }
  cursor: { load(topicID: string): Promise<string | null>; save(topicID: string, position: string): Promise<void> }
  outbox: {
    list(): Promise<Array<AppOutboxEntry>>
    put(entries: Array<AppOutboxEntry>): Promise<void>
    remove(seqs: Array<number>): Promise<void>
    clear(): Promise<void>
  }
  meta: {
    loadSettlement(seq: number): Promise<AppSettlementObligation | null>
    putSettlement(seq: number, value: AppSettlementObligation | null): Promise<void>
    events(): Promise<Array<PersistenceEvent>>
    putEvents(events: Array<PersistenceEvent>): Promise<void>
    ackEvent(id: string): Promise<void>
  }
  clearTransport(): Promise<void> // preserves owed outcomes/Welcomes, fork evidence and unacked events
}
export type GroupStores<TTx extends GroupTransaction> = {
  tx: TTx
  lifetime: { load(): Promise<GroupLifetime | null>; save(value: GroupLifetime): Promise<void> }
  incarnation(incarnation: number): IncarnationStores
}
export type GroupTransition = {
  groupID: string; mutationID: string
  expected: { revision: number; activeIncarnation: number | null } | null
}
export type GroupPersistence<TTx extends GroupTransaction> = {
  load(groupID: string): Promise<GroupLifetime | null>
  loadState(key: GroupKey): Promise<GroupStateRecord | null>
  list(): Promise<Array<GroupLifetime>>
  ports(key: GroupKey): GroupPersistencePorts
  transition<TValue>(change: GroupTransition,
    work: (stores: GroupStores<TTx>) => Promise<TValue>): Promise<TValue>
  resolve(groupID: string, mutationID: string): Promise<'committed' | 'rolled-back'>
}
export type GroupPersistencePorts = {
  key: GroupKey; control: ControlStore; outbox: AppOutbox
  anchor: AnchorStore; cursor: AppCursorStore
}
export type AtRestCodec = {
  seal(plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>
  open(ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>
}
export type TransactionHookSettlement = { settle(outcome: 'committed' | 'rolled-back'): void }
export type OutcomeAwareTransactionOptions = {
  onUnknown(settlement: TransactionHookSettlement): void
}
export type GroupBatchOptions = {
  maxBatchFrames?: number; maxBatchDelayMs?: number; maxBatchWorkMs?: number
}
export type GroupMutationGate = {
  run<TValue>(groupID: string, work: () => Promise<TValue>): Promise<TValue>
  holdUntil(groupID: string, completion: Promise<void>): void
}
```

Transition-bound methods never transact/acquire the gate; the coordinator owns validation/sealing/hooks and completion proof.
Expected null means absent lifetime, never a tombstone. Lifetime revision advances per transition; state version per state/metadata change.
Enforce incarnation/epoch/authenticator/spent rules independently of CAS. Stores are group-bound and expire with the callback.

### Registry, control and handlers

```ts
export type GroupRuntimeSnapshot = EpochIdentity & {
  stateVersion: number; members: ReadonlySet<string>; available: boolean
}
export type GroupEpochRuntime = {
  snapshot(): GroupRuntimeSnapshot | null
  onEpochChanged(listener: (value: GroupRuntimeSnapshot | null) => void): () => void
}
export type SendAdmission =
  | { epoch: number; admissible: true }
  | { epoch: number; admissible: false; reason: 'lapsed' | 'rotation-required' | 'stranded' | 'fork-halted' | 'terminal' | 'backup-restored' }
export type RegistryHandleAccess = {
  key: GroupKey
  runtime: GroupEpochRuntime
  epoch(): number
  stateVersion(): number
  admission(): SendAdmission
  read<TValue>(fn: (handle: GroupHandle) => TValue | Promise<TValue>): Promise<TValue>
  seal<TValue>(fn: (handle: GroupHandle) => Promise<TValue>): Promise<TValue>
  receive<TValue>(fn: (handle: GroupHandle) => Promise<{ result: TValue; accepted: number }>): Promise<TValue>
  openBatch(frames: Array<{ frame: AppFrameRef; ciphertext: Uint8Array }>): Promise<Array<PendingAppFrame>>
  adopt(next: GroupHandle, expected: EpochIdentity, write: AdoptionWrite): Promise<'installed' | 'noop' | 'moved'>
  pending: PendingAppFrames
}
export type GroupHandleRegistry = {
  declareRestoredFromBackup(): Promise<void> // (r15 decision) before access/startup, durable holds and package invalidation
  access(groupID: string): Promise<RegistryHandleAccess>
  seed(group: GroupHandle, params: { replace?: boolean; joinRef: JoinRef | null }): Promise<GroupKey>
  switchIncarnation(candidate: GroupHandle, params: {
    source: GroupKey; stateVersion: number; sourceIdentity: EpochIdentity | null
    rejoinID: string; proof: ResyncProof; write: AdoptionWrite
  }): Promise<GroupKey>
  clearJoinRef(key: GroupKey, expected: JoinRef): Promise<void>
  delete(key: GroupKey): Promise<void>
  dispose(): Promise<void>
}
export function createGroupHandleRegistry<TTx extends GroupTransaction>(params: {
  persistence: GroupPersistence<TTx>
  restore: (record: GroupStateRecord & { deleted: false; state: Uint8Array }) => Promise<GroupHandle>
  batch?: GroupBatchOptions
}): GroupHandleRegistry
export type AppFrameRef = {
  id: string; groupID: string; incarnation: number; protocol: string
  topicID: string; segment: number; position: string; procedure: string // segment = anchor epoch
}
export type PendingAppFrame = {
  frame: AppFrameRef; payload: Uint8Array; senderDID: string
  epoch: number; idempotencyKey: string
}
export type PendingAppFrames = {
  list(): Promise<Array<PendingAppFrame>>
  complete(id: string): Promise<void> // completion and contiguous cursor share the transaction
}
export type GroupHandlerMetadata = {
  epoch: number; incarnation: number; frame?: AppFrameRef; idempotencyKey?: string
}
export type DurableHandler<TContext, TTx extends GroupTransaction> =
  | { mode?: 'at-least-once'; handle(context: TContext & GroupHandlerMetadata & {
      frame: AppFrameRef; idempotencyKey: string
    }): Promise<void> }
  | { mode: 'transactional'; handle(context: TContext & GroupHandlerMetadata & {
      frame: AppFrameRef; idempotencyKey: string; tx: TTx
    }): Promise<void> }
export type CommitKeyRotationResult = {
  commitMessage: Uint8Array; newGroup: GroupHandle; epoch: bigint
}
export function commitKeyRotation(group: GroupHandle): Promise<CommitKeyRotationResult>
```

`seal` consumes an already committed application lease. Durable attempt persistence belongs to its caller's transition.
`receive` never writes for ephemeral traffic. `accepted` is an exact non-negative successful-open count.
`openBatch` owns atomic state/pending persistence and returns plaintext only after commit.
Registry crypto owns pending; simple access remains. Recovery uses switchIncarnation, never ordinary adopt/replace.
Null state permits only metadata/safety access and resync, not a handle.

```ts
export type BuiltCommit = {
  incarnation: number; epoch: number; authenticatorBefore: Uint8Array
  publishID: string; searchFrom: LogPosition | null; expectedHead: LogPosition | null
  payload: Uint8Array; payloadDigest: string; digest: string; bodies: Array<string>
  journal: Uint8Array; welcome: { bytes: Uint8Array; recipients: Array<string> } | null
}
export type HostBuilt = Pick<BuiltCommit,
  'incarnation' | 'epoch' | 'authenticatorBefore' | 'digest' | 'bodies' | 'journal' | 'welcome'
> & { commit: Uint8Array }
```

`RejoinRecord.source` is `{key: GroupKey; stateVersion: number; identity: EpochIdentity | null}`;
its target is `{targetID: string; topicID: string; groupInfoEpoch: number; groupInfoAuthenticator: Uint8Array; captureHead: LogPosition | null}` (r15 decision).
The authenticated `captureHead` and original search origin never change. Only a proven head-only retry refreshes `expectedHead`.
MLS `SealGroupInfoParams` requires `captureHead: string | null`; `RecoveryGroupInfo` returns it after authentication (r15 decision).
The GroupMLS responder port becomes `sealGroupInfo(request: Uint8Array, captureHead: LogPosition | null)`.
Its pending recovery result carries `captureHead` through framing, persistence and replay, without importing rpc types into MLS.
Drop conflictEpoch and the source-prefix scan; retain exact payload, requestKey, candidate and bound external verdict stages.
RejoinRecord adds `trigger: 'automatic' | 'manual'` and `authorisationID: string | null`; a manual attempt requires its matching durable authorisation.
`StagedAdoption` adds incarnation. Control adapters, applied rows/responses/cursor and outcomes bind GroupKey.
ControlSnapshot adds `commitOnce: BuiltCommit | null`, `forkHalt: ForkHalt | null`, and
`strand: {reason: StrandedReason | 'unsupported-version'} | null`, and `manualRecovery: ManualRecoveryRecord | null`.
ControlChanges carries optional values for these fields; halt evidence is immutable on retirement.
The commit-once slot survives operation outcome/ack. `deleteAppliedFrom` fork repair is removed; prune only within the incarnation.
`searchFrom` is immutable. Updating expectedHead never changes payload or ID.
No private builder exports a handshake reservation API or generation budget.

### Safety and manual recovery (r14 decision)

```ts
export type StrandedReason = 'retention-gap' | 'unprocessable-gap' | 'lost-state' | 'ahead'
export type GroupForkEvidence =
  | { kind: 'digest-divergence'; epoch: number; position: string; localDigest: string; remoteDigest: string }
  | { kind: 'epoch-authenticator'; epoch: number; local: Uint8Array; remote: Uint8Array }
  | { kind: 'unexplained-own-commit'; epoch: number; position: string; digest: string }
export type ForkHalt = { eventID: string; evidence: GroupForkEvidence; detectedAt: number }
export type GroupSafetyEvent = GroupKey & { id: string; kind: 'group:fork'; halt: ForkHalt }
export type PersistenceEvent = AppStatusEvent | GroupSafetyEvent
export type RecoveryTarget = { id: string; commitTopicID: string; hub: LogHub & MailboxHub }
export type ResyncProof = {
  targetID: string; topicID: string; groupInfoEpoch: number
  captureHead: LogPosition | null // (r15 decision) authenticated reply's immutable head
  position: LogPosition; payloadDigest: string; verdict: Uint8Array
}
export type ManualRecovery =
  | { mode: 'resync'; targetID: string }
  | { mode: 'successor'; successor: GroupKey }
export type ManualRecoveryRecord = { id: string; source: GroupKey; choice: ManualRecovery; stage: 'authorised' | 'completed' }
export type GroupSafety = {
  epochAuthenticator(key: GroupKey): Promise<EpochIdentity | null>
  reportFork(key: GroupKey, evidence: GroupForkEvidence): Promise<void>
  recover(key: GroupKey, choice: ManualRecovery): Promise<GroupKey>
  events(key: GroupKey): Promise<Array<GroupSafetyEvent>>
  ackEvent(key: GroupKey, id: string): Promise<void>
}
export function createGroupSafety<TTx extends GroupTransaction>(params: {
  registry: GroupHandleRegistry; persistence: GroupPersistence<TTx>; mls: GroupMLS
  resolveTarget: (targetID: string) => Promise<RecoveryTarget>
}): GroupSafety
```

`recover` validates the source key, durably authorises only this choice, then returns the installed/successor key after completion.
A successor must already be normally admitted/available; resolve it before retiring the source, without acquiring both group gates.
The application owns target registration, URLs, topic selection and successor creation/admission; GroupMLS supplies configured identity/policy. Persist opaque target ID and sealed topicID;
resolve transport objects again on restart. Acknowledgement never lifts a halt. No public clear-halt/reset flag exists.
`ResyncProof` must verify exact external-commit application under the existing bound-verdict rules; it is not an arbitrary candidate approval.

### Welcome, outbox and host effects

```ts
export type OpenWelcomeParams = Omit<ProcessWelcomeParams, 'keyPackageBundle'>
export type JoinedWelcome = {
  group: GroupHandle; credential: MemberCredential; sourceErrors?: Array<Error>
}
export type OpenWelcomeResult =
  | { joined: JoinedWelcome; joinRef: JoinRef }
  | { alreadyJoined: string }
export function openWelcome(sources: Array<BundleSource>, welcome: OpenWelcomeParams): Promise<OpenWelcomeResult>
export type WelcomeAdmissionParams = {
  held: { incarnation: number; epoch: number | null; deleted: boolean; forkHalted: boolean } | null
  spentEpochAuthenticators: Array<Uint8Array>
  welcome: { epoch: number; epochAuthenticator: Uint8Array }
}
export function judgeWelcomeAdmission(params: WelcomeAdmissionParams): 'join' | 'alreadyJoined' | 'replace' | 'refused'
export type AppAttempt = {
  incarnation: number; epoch: number; floor: string | null; attempts: number
  publishID: string; segment: number; topicID: string
}
export type AppOutboxEntry = {
  seq: number; protocol: string; prc: string; data: Uint8Array; lastAttempt: AppAttempt | null
  status: 'accepted' | 'failed'
}
export type AppPublicationOutcome = { incarnation: number; segment: number; topicID: string; position: string }
export type AppSettlementObligation = {
  sequenceID: string; attemptID: string; topicID: string; outcome: 'published'
}
export type AppSettlementExpected = { identity: EpochIdentity; stateVersion: number; attemptID: string }
export type AppSettlementResult =
  | { recorded: true }
  | { recorded: false; reason: 'identity-changed' | 'state-version-changed' | 'attempt-changed' | 'entry-missing' }
export type AppStatusEvent = GroupKey & { id: string; entry: AppOutboxEntry } & (
  | { kind: 'accepted' }
  | { kind: 'published'; occurrence: AppPublicationOutcome }
  | { kind: 'failed'; reason: 'incarnation-abandoned' | 'removed' | 'deleted' | 'database-restored'; nextIncarnation?: number }
)
export type AppOutbox = {
  put(entry: AppOutboxEntry): Promise<void>
  list(): Promise<Array<AppOutboxEntry>>
  recordSettlement(seq: number, obligation: AppSettlementObligation,
    expected: AppSettlementExpected): Promise<AppSettlementResult>
  loadSettlement(seq: number): Promise<AppSettlementObligation | null>
  remove(seq: number, outcome?: AppPublicationOutcome): Promise<void>
  clear(): Promise<void>
  events(): Promise<Array<AppStatusEvent>>
  ackEvent(id: string): Promise<void>
}
export type TransactionalGroupEffects<TTx extends GroupTransaction> = {
  outbox?(tx: TTx, event: AppStatusEvent): Promise<void>
  delete?(tx: TTx, key: GroupKey): Promise<void>
}
export function decodeAppEntry(entry: AppOutboxEntry): { procedure: string; payload: unknown }
export type MlsContextOptions = { keyRetention?: Partial<KeyRetentionConfig> }
export function createMlsContext(
  cipherSuite: MlsContext['cipherSuite'], anchor?: GroupAnchor, options?: MlsContextOptions
): MlsContext
```

Outbox facades share the coordinator and reject stale active writers; retired ports only serve owed records/events/frozen settlement.
TransactionalGroupEffects is host opt-in with handler restrictions; other hosts consume stable-ID events outside transactions.
Unknown complete/remove succeeds; byte/nested values are defensive copies.
```ts
export class GroupStateConflictError extends Error { override name = 'GroupStateConflictError' }
export class GroupStateUncertainError extends Error { override name = 'GroupStateUncertainError' }
export class DisplacedGroupHandleError extends Error { override name = 'DisplacedGroupHandleError' }
export class OutboxReplacementError extends Error { override name = 'OutboxReplacementError' }
export class InvalidAppEntryError extends Error { override name = 'InvalidAppEntryError' }
export class NonRootProviderError extends Error { override name = 'NonRootProviderError' }
```

These inherit `(message?: string, options?: ErrorOptions)`.
Re-export canonical rpc StorageOutcomeUnknownError and GroupControlUnsettledError. Do not redeclare them.

### Factories, lifted ports and test support

```ts
export type MemoryStoreRows = Record<string, Map<string, unknown>>
export type MemoryTransaction = GroupTransaction & { rows: MemoryStoreRows }
export type MemoryDatabase = {
  mutationGate: GroupMutationGate
  transact<TValue>(groupID: string, fn: (tx: MemoryTransaction) => Promise<TValue>,
    options?: OutcomeAwareTransactionOptions): Promise<TValue>
  completionBarrier(groupID: string): Promise<void>
  snapshot(): MemoryStoreRows
}
export function createMemoryTransaction(params: { rows: MemoryStoreRows }): MemoryDatabase
export function createMemoryGroupPersistence(params: {
  db: MemoryDatabase; atRest: AtRestCodec; effects?: TransactionalGroupEffects<MemoryTransaction>
}): GroupPersistence<MemoryTransaction>
// Phase 3. GroupProviderTransaction forwards this root callback's StoreProvider.
export type GroupProviderTransaction = StoreProvider & GroupTransaction
export function createGroupPersistence(params: {
  db: HozonDB; atRest: AtRestCodec; effects?: TransactionalGroupEffects<GroupProviderTransaction>
}): GroupPersistence<GroupProviderTransaction>
export type BufferedEpochInspection = {
  inspectEpoch(ciphertext: Uint8Array): bigint | undefined
  currentEpoch(): number | null
  onEpochChanged(listener: () => void): () => void
}
export function createBufferedPeerHubView(params: {
  hub: MailboxHub; peerDID: string; groupID: string; epochs: BufferedEpochInspection
  reconnectTimeoutMs?: number
  logger?: { warn(message: string, context?: Record<string, unknown>): void }
}): MailboxHub & { dispose(): void }
export type MLSEncryptorParams = {
  access: Pick<RegistryHandleAccess, 'seal' | 'receive' | 'runtime'>
  peerDID: string; role: 'dialer' | 'listener'
}
export class MLSEncryptor implements Encryptor {
  constructor(params: MLSEncryptorParams)
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>
  decrypt(ciphertext: Uint8Array): Promise<Uint8Array>
  trackPublish(hub: MailboxHub): MailboxHub
  clear(): void
  watchPeerRemoval(dispose: () => Promise<void>): () => void
}
export type RawStoredRecord = {
  groupID: string; incarnation: number | null; namespace: string
  recordID: string; key: string; bytes: Uint8Array
}
export type PendingCommitFault = {
  rejected: Promise<void>; barrierWaiting: Promise<void>
  finish(outcome: 'commit' | 'rollback'): Promise<void>
}
export type PersistenceFixture<TPorts> = {
  ports: TPorts
  reopen(): Promise<TPorts>
  failNext(point: 'after-first-write' | 'before-commit' | 'status-read'): void
  commitThenReject(): void
  rejectCommitPending(): PendingCommitFault
  inspectRows(): Promise<MemoryStoreRows>
  inspectRawBytes(): Promise<Array<RawStoredRecord>>
  inspectSideRow(key: string): Promise<Uint8Array | null>
  mutateStoredRecord(namespace: string, key: string,
    mutate: (bytes: Uint8Array) => Uint8Array): Promise<void>
  swapStoredRecords(namespace: string, keyA: string, keyB: string): Promise<void>
  setTime(now: number): void
  advanceTime(ms: number): Promise<void>
  close(): Promise<void>
}
export type PersistenceConformanceParams<TPorts, TTx extends GroupTransaction> = {
  label: string
  writeSideRow(tx: TTx, key: string, bytes: Uint8Array): Promise<void>
  createFixture(id: string, effects?: TransactionalGroupEffects<TTx>): Promise<PersistenceFixture<TPorts>>
}
export function testGroupPersistenceConformance<TPorts, TTx extends GroupTransaction>(
  params: PersistenceConformanceParams<TPorts, TTx>
): void
```

Memory transactions snapshot/commit only the target group plus supplied side rows; concurrent group commits preserve both.
Reject reentrant transactions and global queues. Snapshots expose only committed sealed rows, including during unfinished backend completion.
Late commit/rollback faults retain private rows, the group owner lock and both hook queues after the caller promise rejects.

Physical mutation/swaps change only addressed ciphertext, preserving keys/markers; missing keys/throwing callbacks change nothing.
Use idle resolvers, reopen to discard caches, inspect every physical copy before opening. Side rows use the supplied transaction;
assert visibility and hook counts, including independent postgres reads.
Existing ControlStore, AppOutbox, AnchorStore, pending-crypto and cursor cases remain in the unified persistence fixture.
Standalone legacy memory control factories may remain for isolated tests, but never satisfy shared persistence conformance.

## Source checks

Reverified for r15 on 2026-10-09, feat/spec-p-phase-2. These are implementation boundaries, not r15 completion claims.

| Boundary | Current source |
|---|---|
| Pull/build/save; absent mismatch currently returns to intent | `packages/rpc/src/control/operations.ts:144`, `:194` |
| Head is separate publication metadata; MLS AAD binds no log position | `packages/rpc/src/peer.ts:2106`, `packages/hub-client/src/client.ts:94`, `node_modules/ts-mls/dist/src/messageProtection.js:69` |
| Discarded protection tree; empty control proposals | `node_modules/ts-mls/dist/src/createCommit.js:77`, `packages/mls/src/group-commit.ts:279` |
| Referenced proposals required; omitted proposals cleared | `node_modules/ts-mls/dist/src/clientState.js:398`, `node_modules/ts-mls/dist/src/processMessages.js:219` |
| SQL mismatch rolls back ID claim; memory needs topic-scoped dedup | `packages/hub-store/src/store.ts:226`, `:310`, `packages/hub-server/src/memoryStore.ts:216` |
| Divergence/ahead/own-unmerged classifier and strand observations | `packages/rpc/src/classify.ts:255`, `:282`, `packages/rpc/src/peer-types.ts:112` |
| Losing forks currently heal; shared automatic recovery trigger | `packages/rpc/src/peer.ts:1512`, `:3053` |
| Existing resync wrapper, producer, sealed reply and replacement gate | `packages/mls/src/group-welcome.ts:203`, `packages/mls-rpc/src/recovery.ts:144`, `packages/mls/src/recovery.ts:538`, `packages/mls/src/lifecycle.ts:445` |
| Current reply v1, attestation layout/authentication and missing captureHead | `packages/mls/src/recovery.ts:35`, `:251`, `:261`, `:566`, `:618`, `:711`, `packages/rpc/src/peer.ts:1092`, `packages/mls-rpc/src/mls.ts:397` |
| KeyPackage secrets generated independently, encoded and held in host source stores | `node_modules/ts-mls/dist/src/keyPackage.js:62`, `packages/mls/src/group-credential.ts:71`, `packages/mls/src/key-package-codec.ts:91`, `packages/mls-hub/src/pool.ts:117`, `packages/mls-hub/src/provisioner.ts:135`, `packages/mls-hub/src/pool-store.ts:24`, `packages/mls-hub/src/store.ts:21` |
| Welcome private-key input and restored bundles | `packages/mls/src/group-welcome.ts:95`, `packages/mls-hub/src/records.ts:161` |
| Hub KeyPackage surface has no revocation, last-resort upload replaces its slot | `packages/hub-protocol/src/protocol.ts:193`, `:241`, `:262`, `packages/hub-client/src/client.ts:186` |
| Fresh resync tree/history and zero generations | `node_modules/ts-mls/dist/src/createCommit.js:289`, `node_modules/ts-mls/dist/src/secretTree.js:241` |
| Ordinary adoption progress carry | `packages/mls/src/group-handle.ts:910` |
| Current v1 codec and recovery source-tree splice | `packages/mls/src/codec.ts:25`, `packages/mls-rpc/src/recovery-codec.ts:36` |
| Sender-zero encoding loss | `node_modules/ts-mls/dist/src/unappliedProposals.js:8`, `node_modules/ts-mls/dist/src/codec/optional.js:4` |
| Separate pending completion/cursor; terminal startup precedes pending restore | `packages/rpc/src/app-lane.ts:498`, `:513`, `packages/rpc/src/peer.ts:3111`, `:3137` |
| Provider lacks explicit scope and ambiguous-completion hook retention | `../hozon/packages/db/src/db.ts:31`, `:275`, `:286` |

Supplied Probe Resync reports a fresh generation-zero replacement accepted by a real member; its assembled integration run was blocked.
Probe C reports identical-byte retry/application with real ts-mls and memory/SQL hubs. D4 applies its proposal/key/progress conditions,
using incarnation for source ownership. Neither probe was rerun for this documentation rewrite.
Neither exercised capture-head binding or database-loss recovery. R15 specifies their contracts and required conformance, without claiming implementation.
Capture-epoch secret loss prevents classifying encrypted poison; with proven absence the attempt is discarded and fresh GroupInfo requested (r15 decision).

## Crash seams

Wrap providers/hub clients only in tests. Phase 2 reconstructs runtime. Phase 3 faults real providers.
Phase 6 kills children. After means proven transaction commit, never callback completion.

| Seam | Recovery assertion |
|---|---|
| Inside a group transition/batch, after its first logical write | all affected namespaces and transactional effects commit together or remain unchanged |
| Built-save/manual authorisation committed, before publish or after remote acceptance | only the selected recovery target resumes; exact saved bytes/ID/candidate survive; discover acceptance before own-log adoption |
| Open batch committed, before default handler; default effect before completion commit | every opened frame redelivers with the same key until completion; no cursor-only loss |
| Transactional completion before/after COMMIT | host effect, pending completion and cursor all roll back or all persist |
| Self-removal committed, before opened handlers drain | terminal restart drains persisted records without new crypto/network work before clearing |
| Certification committed, before removal/terminal/switch | frozen obligation survives; original sealed topicID reports published exactly once |
| Fork-halt committed before notification, or recovery switch/Welcome committed before peer restart/consume | halt/event survive without automatic recovery; a completed switch isolates/tombstones records and replays failures; consume resumes from joinRef |
| COMMIT rejected while backend unfinished | raw negative reads release nothing; barrier selects final rows and one hook queue |
| Application lease committed, before seal | restart skips its entire reserved range; no sender generation repeats |
| Welcome transport accepted, before obligation deletion | delivery repeats at least once; consume receipt/spent admission prevents reinstall |
| Restore declaration committed, before package invalidation or group failure transactions finish | startup remains held after reconstruction. Resume invalidation/holds/events before resync or any send (r15 decision). |

There is no pending-complete/cursor seam, state/control/anchor split seam or handshake-reservation seam.
Remaining external P2a publish/confirm/bootstrap/Welcome seams use its stage replay; fork-healing seams are replaced by durable halt/manual recovery.

## Conformance

Run both contract suites against real implementations and every affected double.
Keep each meaningful existing case. Replace cases tied solely to removed mechanisms with the equivalent invariant below.

| Suite / phase | Case | Required assertion |
|---|---|---|
| codec / 2 | lossless sender | zero/one/absent clone/save/reopen, malformed sidecar and v1 refusal. Zero regression fails against current codec. |
| recovery codec / 2 | complete sourceState | differing source/candidate trees, empty proposals and zero/one/absent senders. Persisted candidate/key restores bound verdict. V1 refuses. |
| recovery reply / 2 | authenticated captureHead (r15 decision) | Responder exports the reconciled snapshot/cursor pair. String/null round-trip in attestation; missing/wrong-type head, tampering, invalid position and v1 refuse before build. Restart retains original captureHead and initial CAS head. |
| persistence / 2,3 | CAS and monotonicity | Stale revision/version, tombstone-as-absent, lower epoch, same-number different authenticator or same-identity progress/ceiling regression reject unchanged. Non-root factories refuse. |
| | incarnation switch atomicity/isolation | Source A4 in n to accepted external-resync state in n+1. Mid-write rollback changes neither record. Commit tombstones n and installs n+1 with fresh progress/anchor/cursors/control. Old applied rows cannot mask new-incarnation self-removal. |
| | source/candidate guards | stale incarnation/version/source, unaccepted/refused/spent resync result reject. Ambiguous successful switch resolves once. Adopted replay never reinstalls. |
| | spent authenticators across incarnations | A3 to A4 to fresh resync in n+1, reconstruct, exact and alternate valid A3 both refuse for ordinary/last-resort sources. Same authenticator/different bytes cannot evade admission. |
| | lifetime/tombstone admission | every installation appends once. Rollback spends nothing. Delete/reopen keeps set. Unspent Welcome below an abandoned incarnation's epoch can create the next incarnation. Receipt-only replay never installs. |
| | total database loss (r15 decision) | Lose group/spent state and all ordinary/last-resort private records together. Exact/alternate old Welcomes cannot decrypt/install, despite retained signing identity and hub copies. Fresh resync/invitation succeeds. Separately surviving key stores violate/refuse the provider-scope contract. |
| | declared backup restore (r15 decision) | Restore an older snapshot, declare before startup. All groups hold durable/ephemeral sends across restart; discard/rotate restored ordinary and retained last-resort keys. Only fresh-leaf external resync switches each group once and enables sends. Missing old leaf refuses. Test revocation support/failure and current-hub residual. |
| | restore outbox/crash (r15 decision) | All restored entries, including certified obligations, fail with database-restored events retaining data. Mid-write rollback exposes none; committed events replay until ack. Crash during declaration/invalidation/holds keeps startup blocked. No restored publish/reseal. Undeclared rollback is explicitly outside the guarantee. |
| | failed-outbox event | switch atomically fails each unproven old entry/status and persists incarnation-abandoned event. Restart replays same ID/data until ack. No automatic reseal. Certified entries remain published. |
| | order/read isolation | A4 occurrence (n,4,10) precedes resynced occurrence (n+1,2,20). Prior local watermark leaves it unread. Host history stays. Old-anchor peer receipt covers no new anchor. |
| | open N, crash mid-batch | all N key advances/pending records commit or none. Rollback leaves keys usable and emits no plaintext/ack. Duplicate frame creates one pending record. |
| | batching latency/fairness | idle lone frame commits without advancing batching timer. Sustained lane A burst allows low-rate B and ready control adoption within three total A/B/control batches, including active A. Enqueue also receives service. |
| | group independence | held/pending group A transition does not block B. Concurrent memory group commits preserve both groups' rows. |
| | completion/cursors | pending completion and contiguous cursor atomic. Unknown/double completion harmless. Future/unopenable records cannot advance cursor. Numeric position ordering survives reopen. |
| | transactional exactly-once effect | side-row effect plus completion/cursor rolls back mid-transaction. Commit then crash/redelivery leaves one effect and no handler invocation for completed record. |
| | stable idempotency key | default handler effect before completion crash causes redelivery with byte-identical key/sender/epoch/incarnation. Semantic chat dedup keeps first content on conflicting reuse. |
| | terminal opened drain | opened batch, self-removal, kill before handlers. Restart awaits all handlers/completions before clear. Failures retain pending. No decrypt/publish. Live path matches. |
| | transition visibility/hooks | state/control/anchor/pending/outbox/cursor and supplied side row share commit/rollback. Unknown queues remain zero until proof. Exactly one matching hook queue before caller release. |
| | late completion/barrier | insert/open/Welcome/switch/delete and control-only/anchor/cursor/outbox transitions reject before backend completion. Initially absent owner covered. Late commit/rollback settles all rows before lifecycle handoff. |
| | at-rest all namespaces | inspect every physical byte copy for plaintext/spans, anchor secrets and topicIDs. Same-codec reopen succeeds. Wrong group/incarnation/namespace/record AAD, mutations and swaps reject through adapters. |
| | deletion/lifecycle | stopped/drained owner, unsettled-control refusal, atomic tombstone/effects, no late writes. Retired outcomes/Welcomes/events remain serviceable until ack/delivery. |
| control / 2,3 | commit-once poison head | refused/poison frame changes head without epoch move. Retry has identical payload/ID/handshake generation. Real receiver processes the poison prefix then applies the saved commit and matches candidate authenticator. Extra pending proposal is omitted, missing referenced proposal refuses. |
| | commit-once restart | reconstruct after built-save/mismatch and after remote acceptance. Saved bytes/candidate survive. Refresh expectedHead only. No same-epoch build after deadline/outcome ack or from a second queued intent. |
| | epoch move/deadline | complete absent range plus epoch advancement permits fresh build before deadline. Found-after-deadline lands. Complete absence loses. Gap/uncertain acceptance yields unknown. Lost slot persists until epoch change. |
| | adoption/removal/resync | full-payload poison, moved, accepted-before-walk, refusal/holder evidence, exact-external-commit confirmation, revoke-hold/two-revoke and Welcome cases remain; source guard is incarnation/version. Remove automatic fork healing/source-prefix/row-retirement assertions. |
| safety / 2,3 | fork halt live/restart | either divergence branch and host same-epoch authenticator mismatch co-write halt/evidence/event; no sends (including ephemeral), opens, control or automatic resync after commit/restart. Ack does not clear halt. Rollback/ambiguity releases nothing. History stays. |
| | strand signals / detection limits | ahead/gap/own-unmerged/unknown-version preserve confidence; settle saved own commit first. Missing history/consistent split view does not claim local detection; host can compare exposed authenticator and report divergence. |
| | stranded automatic resync | retention gap/lost MLS state with no fork obtains sealed authenticated GroupInfo; Remove+ExternalInit accepted, one matching fresh leaf, generation 0 and new incarnation after restart. Unknown version is held, not skipped. |
| | stale GroupInfo (r15 decision) | Valid commit lands after capture, before external publish. expectedHead=captureHead refuses. Reconcile, discard unadopted and request fresh GroupInfo. Old candidate never installs, including after restart. |
| | capture-head poison retry (r15 decision) | Poison/non-commit/invalid frames after capture change head without valid epoch advancement. Proven complete reconciliation republishes identical payload/ID/candidate at refreshed head. Real member applies it; bound confirmation installs a fresh incarnation. Unclassifiable encrypted prefix with proven absence: attempt discarded unadopted, fresh GroupInfo requested, new attempt (fresh KeyPackage) lands; unknown acceptance holds. |
| | manual recovery | no automatic action while halted; chosen target/authorisation reopens across restart, validated resync switches once, refused attempt preserves halt. Already admitted successor permits source retirement without copying state or coordinating routing. |
| registry / 2 | cold access/leases | concurrent cold load validated before access. Lease reserve/restart/failed seal never reuse generation. Lapsed/removed/suspended/proposals defer burn without blocking control. |
| | rotation/retention | 500 bound, rejection/hold/resume, non-admin empty rotation, 1000 retention/window through every constructor/derive/recovery. Real/double forward-window parity. Ordinary adoption preserves sender/receive history, no evicted epoch resurrection. |
| handlers / 2 | all metadata paths | original authenticated epoch/incarnation on durable/live/anycast/directed kinds. Spoofed wire/header metadata loses. |
| ephemeral / 2 | persists nothing | warmed pre-reserved lease, requests/responses/signals and decrypt batches: zero outbox/pending/cursor rows and zero transaction calls. Exhausted lease rejects without a transaction. |
| outbox / 2,3 | attempt/settlement | all required topicIDs/identity/version round-trip. Inside-gate mismatch changes nothing. Test both proof paths and both queued orderings, attempt changes and version-only changes. |
| | frozen result/restart | remove rollback then terminal/switch/restart reports original published occurrence/topicID once. Obligations co-delete, cannot change attempt, conflicting result rejects. Others fail. |
| | retries/decoder | same-process bytes/ID retry, active-incarnation restart new app ID, immutable entry, unknown removal, invalid UTF-8/version/type/procedure and side-row rollback. |
| lifted runtimes / 2 | encryptor/buffer | exact receive counts, ephemeral memory-only batches, sequential rotation keeps tunnel, committed membership/incarnation change closes once. Buffered wake, unsubscribe and retention reconnect/retry. |
| hub-conformance / 2,3 | dedup scope/expiry | same ID on two topics, rejected ID reusable, accepted ID original position, inclusive 365-day cutoff and no timestamp refresh. Memory and SQL. |
| integration / 2 then 3 | real HTTP smoke | injected server DID, real MLS/registry, invite/join, durable send/epoch/proof, rotation, fork halt, stranded/manual resync and reconstruction. Providers replace memory in 3. |
| client/messaging / 4,5 | host integration | consume sweep, lifecycle, failure events/programmatic retry, transactional/idempotent MessageStore and receipt order. |
| e2e / 6 | every listed seam | child SIGKILL evidence, including N-frame batch, transactional effect and incarnation switch. Reconstruction alone does not satisfy this row. |

## Phase split

| Phase | Deliverable / gate |
|---|---|
| 2 | MLS state/recovery v2 codecs first. Memory group coordinator, registry/incarnations/spent admission, durable fork halt/manual recovery and automatic stranded resync with authenticated captureHead, commit-once runner, fair adaptive batching and handler metadata/policies. Shared-provider KeyPackage contract, total-loss/declared-restore holds and conformance (r15 decision). Application leases/rotation, encrypted namespaces, durable settlements/events and mutation/side-row/fault fixtures. hub-client lifts and mls-rpc encryptor. Both contract suites on real MLS and doubles. Real HTTP smoke with injected DID. |
| 3 | rpc-store sqlite/postgres providers and Expo support or explicit blocked reason. Explicit group transaction scope, root discriminator and outcome-aware Hozon hooks. Provider CAS/barrier/late-COMMIT/raw-encryption/side-row tests. SQLite device reconstruction. |
| 4 | client ownership, identity/Spec I, Spec H/hub policy, inventory/consume, lifecycle and rotation scheduling. |
| 5 | messaging protocols/MessageStore, transactional or idempotent handlers, durable status events, programmatic failed-send retry and per-anchor receipts. Expo bundle CI. |
| 6 | Child-process driver and SIGKILL at every external/transaction seam. |

Phase 2 creates no client/messaging/MessageStore/Hozon provider/child driver; use opaque side rows for handler/status conformance.
Run affected package/integration tests and `pnpm turbo run test:types`. Provider isolation/failure evidence belongs to phase 3.

## History

- r1: adoptable journal, proof versus acknowledgement, application leases and coordinated status.
- r2: current-record CAS, retention/rotation, publication positions and mutation markers.
- r3: save-before-consume, recovery identity, separate Welcome obligations and deletion hooks.
- r4: review findings fed the control split. No separate r4 model remains normative.
- r5: P2a took control, adoption co-commit, source joinRef and unsettled-delete refusal.
- r6: lossless v2 codec, registry/access, metadata, retries, decoding and shared memory contracts.
- r7: completion barriers, identity-bound proof, recovery floor and owner-mediated persistence.
- r8: recovery codec, asynchronous access, terminal proof drain and outcome-aware hooks.
- r9: Welcome replay guard and host at-rest codec. Artifact digests were superseded.
- r10: spent authenticators, handshake reservations, anchor encryption and explicit Welcome ports.
- r11: handshake budget/window parity and physical mutation/side-row conformance.
- r12: local anchor ordinals, durable certified obligations and handshake baseline reader.
- r13: opened terminal drain, displaced control retirement, settlement revalidation and persisted topicID.

**r14 restructure (r14 decision).** Three root causes drove repeated patches: in-place lower-epoch recovery,
same-epoch commit rebuilding, and transitions split across stores.
New incarnations remove lineage/admissionFloor rules, recovery HWM/progress merging, same-epoch replacement exceptions,
displaced-row retirement, responder-selected lower-epoch adoption and local anchor ordinal machinery.
Commit-once removes handshake reservation/HWM, HANDSHAKE_BURN_BUDGET, HandshakeBudgetExhaustedError,
baseline readers and build staging clone rules.
Group transactions remove internal cross-store ordering and the chat-only D7 special case.
The strongly consistent DS decision replaces automatic fork healing with durable halt/manual recovery; stranded devices still resync automatically.
Spent authenticators, authenticated at-rest storage, publication obligations, provider ambiguity and external replay seams remain.

- r15 (r15 decision): authenticated GroupInfo captureHead, stale-epoch CAS refusal and proven identical-byte poison retry. Total-loss KeyPackage co-storage and explicit backup-restore resync/rotation/outbox failure. Unclassifiable encrypted prefix: discard on proven absence, request fresh GroupInfo.
