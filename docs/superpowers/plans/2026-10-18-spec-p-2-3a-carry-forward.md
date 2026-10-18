# Plan 2.3a carry-forward (rulings, deferred minors, obligations)

Plan 2.3a (registry crypto core: exact CAS, commit authoring permit, `openBatch`/`pending`, registry `createGroupCrypto`, app work off the commit queue, departing topics, Lane C cleanups) complete on `feat/spec-p-phase-2` (range `5613a4e5..HEAD`, not pushed). Lanes B and C merged locally at `d0456a53` and `c08e7a89`. Final reviews: Opus 0C/2I/4M and blind Codex 0C/5I/2M, fixed in `d65dcd88`, `0f494055`, `6ca6bcb6`. Ephemeral: delete with the other phase-2 plans.

## Obligations for later sub-plans

1. Merge held until phase 2 complete (user decision). Do not merge or push after 2.3a alone.
2. **Test double commit authentication (schedule, recurring 3 rounds).** The sealed-memory double's control-validation path (`sealedMemoryValidation`) and the shared rpc memory model's `processCommit` apply untagged or sibling-branch commits; synthetic authors (`rpc/test/fixtures/commits.ts` `publishCommit`) key the tag with `FAKE_BASE_SECRET`. Make the model verify the source-epoch commit tag before mutation and migrate every synthetic author. Only the handle `processMessage` path is mirrored today. Until then double-mode control-validation tests can pass on commits real MLS refuses.
3. **Past-retention catch-up loss (user decision pending).** A peer catching up across more than `retainKeysForEpochs` commits ratchets past frames its app pull has not reached; those refuse `past-epoch` and are marked done with no notice (spec:1068 sanctions non-delivery). Options: a settled notice for past-epoch refusals, a departing-pull window tied to retention, or a walk that yields before passing retention while departing pulls are outstanding.
4. **Uncancellable hub fetches.** `@enkaku/client` applies abort only after `sent` settles and `@enkaku/http-fetch` awaits the response while sending, so four withheld HTTP app fetches exhaust rpc's absolute ceiling of four unsettled app requests until one settles. Root fix upstream in enkaku (abort before `sent`).
5. Transport-level hub response decode bound (hub-protocol/hub-client) is not bounded by rpc's page-size prefix check.
6. Raw-key holders can restore unrestricted handles (journal `sourceState`, `GroupHandle.state`): accepted Q3 trusted-code exception; a hardening task if the boundary must become key-secret.
7. 2.3b: `receive`, `seal`, leases, ephemeral. 2.3c: resync/retirement drain of opened records, `drainOpened`, `switch-blocked`; N3 and O1/O3/O4 settlement. 2.3d: `HandlerCompletion`, handler metadata, frame-ref migration, poison removal (rows persist until then, user-accepted bound).
8. Out-of-scope crypto obligations unchanged: ts-mls chain-secret skipped cache; commit-creation retained own handshake secret.
9. Hosts must wire the peer's `appCursorStore` to the registry incarnation cursor (`ports(key).cursor`) or `openBatch`'s cursor-duplicate refusal does not apply (documented in the mls-rpc README).
10. Release: `.changeset/spec-p-storage-foundation.md` carries the 2.3a paragraph. Versions stay in the band.

## Rulings worth re-checking

- `GroupUnwrapResult.epoch` is the locked handle epoch that opened the frame; pending records keep the seal epoch (`715fdf1b`).
- `openBatch` refuses `frame.id !== frameID(topicID, ciphertext)` before decryption.
- Spent-set-corrupt latch refuses manual recovery admission without implicit reset (lane C `55a50245`, test `57a2b9e1`). Revert both if manual recovery must bypass the latch.
- `HostBuilt.bodies` stay trusted host output; the receipt binds commit, candidate and Welcome.
- Hub pages are sorted by `compareLogPositions` before the watermark moves (spec permits hub reordering).

## Final review minors (deferred)

- `GroupUnavailableError` `deleted`/`invalid` still retried as storage (60 s backoff, repeated blocked notices).
- Held `unsupported-version` would map to a terminal error (never produced today).
- In-batch inputs at the same topic and position with different ids both open.
- Pull rate is bounded only by continuation backoff (100 ms–1 s without progress).
- `frameID` hashed for every sealed frame each deliver pass.
- Spec text: :1366 `open` vs A5, :1065-1066 stale poison wording, :1371 overridden by A4.
- Test gaps: Task 4 retained-epoch branches, Task 11 redeliver "once" check, Task 5b concurrent builders on one permit.
