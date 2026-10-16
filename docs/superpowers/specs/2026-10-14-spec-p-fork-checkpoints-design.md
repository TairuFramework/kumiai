# Spec P: signed fork checkpoints

Date: 2026-10-14
Status: FOLDED INTO PLAN 2.2e with manual recovery (USER 2026-10-14; was a separate plan after 2.2d): hub-carried checkpoints catch realistic hub faults (bugs, replica divergence, selective delivery, split views); the same format later travels out-of-band. Needs review before planning.
Baseline: `feat/spec-p-phase-2`, `ebdda505e1288990746b2df345e804c0596df8e1`, Spec P r18
Binding: [rescope brief](../../../.superpowers/sdd/plan-2-2d-draft/rescope-brief.md) and user decisions of 2026-10-14.
Amendment: [checkpoint replacement blocks](../../../.superpowers/sdd/plan-2-2d-draft/r19-fork-draft.md).

## Decision and boundary

A foreign checkpoint for epoch E counts only when its signer DID and signature key occur in **our installed roster at E**.
Our sealed, retained epoch fact supplies that roster and our authenticator hash.
Two valid same-epoch checkpoints with unequal hashes constitute attributed member testimony about installed state.
At least one checkpoint must match our retained hash. Both signing DID/key pairs must occur in our roster fact.
Foreign membership is never reconstructed. Nothing about our retained roster is published.
A malicious member in our roster can sign an invented hash and durably halt us. This attributed insider DoS is accepted.

2.2d recovery owns captureHead v2, stranded resync, confirmed registry switching, live holds and legacy RejoinRecord policy.
Its competing-commit diagnostic-poison and own-slot poison/unknown rules remain binding. Commit bytes cannot establish competing installations.
The existing trusted host authenticator report still halts. Checkpoint halt is terminal. Manual recovery remains separate 2.2e work.

## Baseline findings

| Baseline source under `packages/` | Consequence |
| --- | --- |
| `rpc/src/classify.ts:249-277`, `rpc/src/peer.ts:1769-1847` | Competing commits and own-slot mismatches need recovery's poison/unknown treatment. |
| `rpc/src/control/forks.ts`, `rpc/src/control/safety.ts` | The 64-epoch applied window is separate. Extend durable evidence and reuse terminal safety. |
| `mls/src/group-handle.ts:458,470`, `mls-rpc/src/registry/trust.ts:83-100` | Capture authenticator hash and authenticated signer tuples during installation. Current trust has no historical roster accessor. |
| `mls/src/group-credential.ts:67-74`, `mls/src/authentication.ts` | Use the device's MLS/DID authentication key. Installation validates credential/key binding and historical membership policy. |
| `mls-rpc/src/registry/access.ts:392-420` | Capture facts within installation and release signing work only after coordinator proof. |
| `rpc/src/commit-frame.ts`, `rpc/src/topic.ts`, `hub-protocol/src/types.ts` | Dedicated opaque retained traffic avoids changing saved commit bytes, commit framing or the CAS head. |

## Hub transport and exact signed format

The only transport worker uses `deriveTopicID(configuredRecoverySecret, 0, 'kumiai/checkpoint/v1')`, with empty scope.
Publish unconditionally with `retain: 'log'`, without `expectedHead`. Subscribe before draining and request seven days.
Live pushes wake bounded retained fetches. Only fetched positions advance a separate persisted checkpoint cursor.
Only cleartext signed checkpoint frames travel on this topic. No new hub RPC or server-side MLS interpretation is required.

Define `LP(x) = u32be(byteLength(x)) || x` and
`H(label, ...parts) = SHA256(UTF8(label) || 0x00 || LP(part1) || ...)`.
The body is canonical UTF-8 JSON from `@sozai/codec.canonicalStringify`:

```ts
type EpochCheckpointBodyV1 = {
  v: 1; type: 'kumiai/checkpoint/v1'; groupID: string; genesisHash: string
  ciphersuite: number; epoch: number; authHash: string
  signerDID: string; leafIndex: number; keyHash: string
}
```

`genesisHash = H('kumiai/checkpoint-genesis/v1', exactGenesisAnchorExtensionBytes)`.
`authHash = H('kumiai/checkpoint-authenticator/v1', UTF8(groupID), genesisHashBytes, u64be(epoch), epochAuthenticatorBytes)`.
`keyHash = H('kumiai/checkpoint-key/v1', signaturePublicKeyBytes)`.
Sign `UTF8('kumiai/checkpoint-signature/v1') || 0x00 || LP(canonicalBodyBytes)` with the device's Ed25519 MLS signature key.
Verification uses strict Ed25519 (`zip215: false`). Other signature algorithms require a new checkpoint version.
Frame: `u8(1) || u8(1) || u32be(length) || LP(canonicalBodyBytes) || signature[64]`.
Length counts the complete payload after its length field. Maximum complete frame: 4,096 raw bytes.
Require exact lengths/full consumption, canonical 32-byte unpadded base64url hashes, normalised DIDs and recognised suites.
Reject duplicate/unknown JSON fields, noncanonical JSON/base64, malformed UTF-8 and lone surrogates.
Epochs are nonnegative safe integers. Leaf indices are unsigned 32-bit integers. Full uint64 API migration remains separate.
No raw authenticator, incarnation, timestamp, transport position, publishID or hub identity appears in the body.

## Our retained roster fact

The canonical local fact contains `{v:1, key:GroupKey, genesisHash, ciphersuite, epoch, authHash, members, installation}`.
`members` contains `{signerDID, keyHash, leafIndex, signaturePublicKey}` for each member in our authenticated installed roster.
Public keys are canonical base64url encodings of 32 Ed25519 bytes, retained solely for offline signature verification.
Each key must hash to its `keyHash`. Sort members by DID, key hash, then leaf. Reject duplicate DID/key pairs or leaves.
`installation` contains `{mutationID, stateVersion}` identifying the proven local state installation.
The fact records authenticated membership and DID/key binding from our validated installed state. It requires no later DID resolution or wall-clock revalidation.
It contains no credentials, registry export, ledger, private tree, historical raw authenticator or MLS secret.
The expanded codec and port types appear in the amendment.

Eligibility compares **DID + key hash** against this fact, never today's roster.
A checkpoint's leaf is signed testimony about its author's view. A foreign leaf number need not equal our local leaf number.
Local signing uses our captured leaf. Same DID with another key is a different signer.
Standalone verification trusts the caller's authenticated local fact. Installation provenance is local evidence, not a publicly verifiable certificate.
An imported fact cannot establish membership or replace our stored fact.

## Capture, cadence and storage

Genesis, Welcome, own/received commit and confirmed resync installations atomically capture the fact and publication obligation.
Ratchet-progress saves preserve immutable facts. Skipped/pre-join epochs have no facts.
Speculative builds, refused commits, offered GroupInfo and hub acknowledgements never create installed facts.
Self-removal retains the installed fact but publishes no checkpoint under the removed identity.

After proven installation, sign captured inputs outside the provider transaction through the installed-only checkpoint port.
The port resolves a retained factID under the bound registry/coordinator. It accepts no arbitrary candidate or authenticator.
Save exact signed bytes and publication work under the owner gate before network handoff.
Crash-before-sign resumes the fact. Ambiguous publication retries exact saved bytes/publishID. Rollback/uncertainty releases nothing.
Rapid epoch advances cannot substitute newer inputs. Signing consumes no MLS generation.

Publish once for every eligible installation. Drain at one checkpoint/second, burst eight, without coalescing retained unsent installations.
An eligible online member republishes its exact current checkpoint every 30 minutes with ±20% jitter and a fresh heartbeat publishID.
Persist the sampled deadline and in-flight publication ID across restart/reconnect. Overdue timers produce one heartbeat, never catch-up bursts.
Reschedule from actual handoff. Retry exponentially, capped at 15 seconds, within the same rate budget.
Remote input never induces new signing. Offline/suspended periods give no cadence guarantee. Transport failure never holds ordinary MLS sends.

Keep the current fact/checkpoint available for heartbeat. Current counts towards the newest 256 installations across the group.
Superseded facts expire seven days after local supersession or outside those newest 256 installations, whichever occurs first.
Retired ordinary facts obey the same bounds. Remove associated unsent work and expose the effective comparison floor on expiry.
Halt evidence stays pinned for the halt/tombstone lifetime, including after acknowledgement and clearTransport/deletion.
Checkpoint retention is independent of applied rows, MLS secret retention and the spent-authenticator set.

Seal group-level `checkpoints` records with null incarnation in AAD and GroupKey inside the value.
Record kinds are `fact`, `publication`, `cursor`. Facts include mutable supersession metadata outside their immutable canonical value.
Publication records contain exact frames, fact references, publishIDs, acceptance state and heartbeat deadlines.
The existing D8 coordinator owns all writes/proof/accounting. Generic storage cannot fabricate installation provenance.

## Byte and work budgets

At 4,096 bytes/frame, one/second with burst eight means at most 4 KiB/second and a 32 KiB burst per group.
Nominal quiet traffic is 48 frames/day/member, at most 192 KiB/day before retries and installation publications.
Seven days of quiet hub history is nominally 336 frames/member, at most 1.3125 MiB, plus installations/retries.
Our 256 retained signed frames occupy at most 1 MiB, excluding storage envelopes and pinned evidence.
Roster storage is `sum(byteLength(canonicalLocalFact))` over retained installations. It scales with actual member/DID sizes.
For 32 members with 80-byte ASCII DIDs and two-digit leaf indices, each canonical member list occupies 7,521 bytes.
At 256 installations that is about 1.84 MiB of roster lists, plus at most 1 MiB of frames and small publication metadata.
No fixed history byte cap silently truncates rosters. Storage exhaustion follows provider failure semantics and exposes lost coverage.
One halt pins two frames, at most 8 KiB, plus one complete local fact and event metadata.

Receive at most 32 frames, 128 KiB and 64 signature checks per turn. Release the owner gate between turns.
Fetch bounded pages and reject oversized input before JSON/crypto. Deduplicate by `H('kumiai/checkpoint-id/v1', exactFrameBytes)`.
Missing local epochs are coverage diagnostics and skipped. No pending foreign verification cache is required.

## Verification, evidence and terminal halt

The verifier receives exactly `{first, second, localRosterFact}` as canonical byte arrays.
It checks both frames, group/anchor/suite/epoch equality with the fact, both signatures and both DID/key memberships.
At least one hash must equal the fact's `authHash`. Equal hashes mean agreement. Unequal hashes mean conflict.
Different epochs/bindings, unsupported formats, absent membership or missing local facts never trigger resync or halt.
Stateful intake constructs the pair from our retained checkpoint and an incoming frame, using only our stored fact.

After validating an unequal foreign claim, latch the owner before competing publication. Complete our signature solely for evidence if needed.
Atomically persist the halt, stable-ID event, cursor and complete evidence under the owner gate.
Evidence is `{kind:'epoch-checkpoint', epoch, first, second, localRosterFact}`, with frames sorted by checkpoint ID.
Both exact frames and the complete canonical local fact are immutable copies. References into prunable storage are insufficient.
Same-DID/key unequal statements identify equivocation inside `group:fork` evidence. There is no additional event.
Storage failure/ambiguity keeps the runtime held. Emit only after proof. Repeated intake cannot replace evidence or recreate acknowledged events.

Terminal halt blocks durable/ephemeral sends, new opens, control build/adoption/publication, checkpoint publication and automatic resync.
It applies live and after restart. Ack removes notification only. Retain history and select no winning branch.
Previously opened handlers, certified settlement and storage-only completion may drain. Handed-off bytes cannot be recalled.
Legacy digest/own-commit halt records remain readable and terminal. They acquire no invented checkpoint provenance.

## Incarnations, portable API and privacy

A confirmed switch atomically captures n+1's fresh-leaf fact and fences n's worker. Stale handles cannot sign or follow n+1.
Lookup uses the requested GroupKey and actually installed epoch. Retired facts never substitute for n+1's facts.
There is no wire lineage discriminator. An old frame matching n+1's actual epoch and roster passes the same rule.
A missing n+1 epoch fact means insufficient trust. Ordinary Welcome/switch never clears an existing fork halt.

`exportCheckpoints(key, epochs?)` returns defensive exact frame arrays, including held/retired evidence, without any roster.
`checkpointFact(key, epoch)` gives the local host defensive canonical retained fact bytes for standalone verification.
`importCheckpoint(key, frame)` applies the same stored-fact verification and durable owner/halt path as hub delivery.
`verifyCheckpointPair({first, second, localRosterFact})` performs standalone verification without network, persistence or mutation.
The caller must authenticate the local fact independently. Import accepts frames only and never trusts host-supplied roster provenance.
These local APIs permit later out-of-band comparison. No second transport worker is included.
MLS/mls-rpc owns installed-only signing and fact verification. rpc schedules and persists opaque canonical bytes.

The hub sees group/anchor linkage, epoch, signer DID/key hash/leaf, state-hash equality, timing and topic correlation.
It receives no roster, raw authenticator, MLS secret or application plaintext. Local host fact/evidence access is not transport publication.

## Threats and limits

| Adversary action or condition | Result under our-roster rule |
| --- | --- |
| Keyless hub refuses CAS, then replays signed loser or malleable copies | No loser installation/checkpoint. Recovery yields poison/unknown, never frame-triggered halt/resync. Commit signatures cannot sign checkpoint domains. |
| Hub changes body/signature or spoofs sender/position | Canonical/signature/membership checks reject. Sender metadata and hub ordering confer no eligibility. |
| Hub withholds/reorders/replays genuine checkpoints | Matching replay is idempotent. Retained eligible historical conflict halts. Delay beyond local retention or full withholding prevents detection. |
| Malicious current member signs an invented unequal hash | Durable attributed insider DoS. Membership authorises testimony, not proof of actual installation. Accepted residual. |
| Former member/key compromise signs for retained E | Eligibility uses our E roster. Historical key compromise can fabricate testimony. Signatures supply no forward-secure timestamp. |
| Membership differs across branches | Each receiver checks its own roster independently. Detection can be one-sided. Branches sharing no members go undetected. Accepted residual. |
| Full partition, no checkpoint crosses | Undetected despite heartbeats. Accepted residual. Later comparison needs a retained local fact. |
| Missing/pre-join/skipped/expired epoch or unsupported version | Coverage gap, never inferred agreement or automatic recovery. Current roster cannot fill historical gaps. |
| Retired-incarnation replay | No cross-incarnation fact lookup. Matching an actually installed new-owner epoch/roster still counts, without any ancestry guarantee. |

## Verification and later tasks

The real split-view witness durably installs different valid E+1 commits in independent MLS registries with shared signing members.
Exchange only hub checkpoints, withhold competing commit bytes, and assert both views halt. Exported frames reverify against each receiver's local fact.
The refused-loser witness applies the CAS winner, refuses the loser, and replays it through historical/own-slot routes without halt/resync/checkpoint creation.
Cover live/restart/ack, rollback/late-COMMIT, exact evidence, member equivocation attribution, leaf-number differences and one-sided eligibility.
Cover absent shared members, full partition, retention expiry, cadence/deadline storms, publication crash seams, canonical rejection and bounded floods.
Run identical checkpoint/safety/storage rpc-conformance rows on real MLS and independent doubles.
Run hub-conformance against real stores/views and every double, checking retained fetches, separate heads/cursors and dedup.

| Later task | Reviewable result |
| --- | --- |
| 1. Apply approved amendment and capture/sign facts | Canonical vectors, local roster codec, atomic installed-only capture, exact saved frames, sealed retention and worker fencing. |
| 2. Add hub worker and comparison API | Installation publication, 30-minute heartbeat, bounded fetch/rates, frame export/import and local-fact standalone verification. |
| 3. Wire terminal evidence and prove contracts | Immutable frame pair/local fact, live/restart/ack semantics, real+doubles rows, split-view and refused-loser witnesses. |

## Open questions

None. The 2026-10-14 user decisions resolve the previous questions.

## Pending review items (controller, 2026-10-14)

- Require the host hub `authorize` hook to gate the checkpoint topic exactly like the commit topic (spec text + conformance row); the topic ID derives from the non-confidential recovery secret.
- Replace cleartext `signerDID` with `keyHash` only; verifiers resolve the signer in their own retained roster at that epoch. Avoids exposing which devices are active to non-member subscribers.
