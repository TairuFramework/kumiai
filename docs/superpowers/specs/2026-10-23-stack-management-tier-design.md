# Stack management tier — design (draft)

**Co-owned:** Kubun stack adoption session (kubun, sakui sections), kumiai-90 (kumiai sections).
Ephemeral working doc: every decision also lands in kubun `docs/agents/plans/milestones/stack-adoption.md`,
kumiai's backlog `docs/agents/plans/backlog/2026-10-23-kokuin-management-tier.md`, and Sakui's plans.
**Status:** draft — flows and custody decided; Codex review (2026-10-23) applied to kokuin/kubun/sakui sections; kumiai section pending its findings.

## Intent

A user's identity (`did:kokuin:` controller) is managed day to day by their devices, not by a seed
sitting on one of them. The root seed lives cold (hardware wallet or mnemonic) and comes out rarely;
devices act for the controller as management members, never beyond root's authority. Every layer of
the stack (kokuin log, kumiai MLS groups, kubun engine and records, Sakui product) agrees on who may do
what, and verifies it from the same log.

## Decided (user, 2026-10-23)

1. **Custody.** Root seed = hardware wallet or mnemonic, mostly offline. Root comes out for: setup,
   member adds, settling/fixing the log, reset recovery. Desktop and phone are both management members;
   neither holds the seed day to day.
2. **Migration.** Sakui's seed-on-desktop is an MVP state. The design includes the move: root goes
   cold, the desktop becomes a member.
3. **Flows.** Recovery = reset from the cold root. Lost or hostile managing device = another member
   `rmv`s its incarnation; root denies its DID at the next settle.
4. **Stolen member (N3).** A lapsed-lease member keeps log authority until removed (can remove honest
   members or saturate the epoch → `EPOCH_SATURATED` until root settles). Accepted: root can fix the
   log. No further mitigations.
5. **kokuin 0.3** is acceptable if the stack needs semantic changes (cost: token/capability release
   cascade through enkaku, mokei, kumiai).
6. **Records lane.** The kubun controller-owned credential record defect is fixed by the tier: a
   co-member resolves a delegate's authority from the owner's log (`resolveMember`), not from carried
   tokens (`kubun docs/agents/plans/backlog/2026-10-23-controller-owned-credential-record-carriage.md`).
7. **Forks.** Log arbitration is kokuin's `authoritativeLog`; a root-chain fork is refused and the prior
   log kept, nothing persisted (kubun step 1.5).

## Flows (each states who holds the root seed)

A device has one identity, its `did:peer:4` (MLS member, delegate). Root may add it as a management member (its member pin, long form, distinct from root keys, `members.ts:124-134`); see the device-binding decision. Effects are separate: `rmv` ends a member's
log authority and invalidates every grant rooted in it (`mbr` roots); an epoch `rev` denies a distinct
edge audience (`aud`), e.g. the lost device's DID; neither touches root-issued grants, which only a
root settlement or reset ends.

| Flow | Root seed | Actors | Log effect | Offline from root? |
|---|---|---|---|---|
| Setup (first device) | cold, used once | root + D1 | `icp`; `add` D1 | no |
| Pair a member device | cold, used | root + D2 (D1 assists) | `add` D2 | no (decided: member adds are a root occasion) |
| Pair an edge-only device | cold, unused | member D1 | none; D1 mints an `mbr` edge grant | yes |
| Day-to-day grants | cold, unused | members | none; `mbr` grants, `exp ≤ lease` | yes |
| Renewal (≥ 2 effective members) | cold, unused | members renew each other | `ren` | yes; log authority is clock-free, so two members with lapsed leases can still renew each other |
| Renewal (1 effective member) | cold, used | root | root `ren` | no; self-renewal is forbidden, root must renew before the member's grant lease runs out |
| (e) Lost/hostile device | cold, unused until settle | surviving member; root at settle | member: `rmv` its member pin (ends its log authority, every `mbr` grant rooted in it, and its MLS leaf by member-root cascade); `rev` of other members' edge audiences only. Root: deny the device DID at its next settle | yes |
| Concurrent mutual `rmv` | cold, then used | both | both removed (union) | no; falls to recovery |
| (c) Recovery (no effective member) | cold, used | root | blind `reset` (clears members and denials, kills prior-generation grants) → re-`add` → re-mint grants | no |
| Settle / fix log | cold, used | root | merge all available authenticated epoch state, then `rot` with `snapshotOf(head)`; unseen epoch effects are lost (N4, disclosed) | no |
| Root-chain fork (seed duplicity) | cold, used | root | higher-generation reset (a rotate cannot settle a chain fork, `supersede.ts:125-131`) | no |
| Migration from MVP | seed on desktop → cold | desktop, phone | see Migration order | n/a |

### Migration order (MVP seed-on-desktop → cold root)
1. Upgrade every participating peer (kumiai 0.12 band, kubun and Sakui releases that accept `mbr`).
2. Ensure desktop and phone each have their long-form `did:peer:4`; those become the member pins (no separate member key, no binding statement).
3. Root (still on the desktop) `add`s desktop and phone.
4. Install and verify member-issued grants and record authority on both; leaves re-mint as `mbr`.
5. Export and verify the recovery material (mnemonic or hardware wallet) with a test reset derivation.
6. Remove the seed from the desktop keystore.
Each step is retryable and idempotent; an interrupted migration leaves the seed on the desktop
(steps 1–5 change nothing a seed-holding desktop cannot redo). Member removal never substitutes for
ending legacy root-issued grants: those end by expiry or by a root settlement. After the seed leaves the desktop, denying a lost managing device's DID also waits for a root
settlement: members only `rmv` it.

## Layers — open design

### kokuin (controller log)
- **Ingestion contract (mandatory, every layer).** Stored epoch events are not re-verified
  (`history.ts:189-197,251-255`), so a forged stored `add` would take effect. Every writer (peer fetch,
  handoff, embedded proofs, recovery, service ingest) persists only the same DID's
  `authoritativeLog(...).log`, never raw candidates or `mergeLogs` output; arbitration and persistence
  are atomic per DID; a refusal keeps the prior log. Regression tests for forged and pending events in
  each layer. (kokuin follow-on #1 becomes a requirement here, not a follow-on.)
- Shared definitions exported from kokuin: the root-rotate device revoke (`deviceRevokeIndex`,
  `createDeviceRevoke` — kubun step 1.5, kokuin `feat/device-revoke`) and an event proof/closure
  builder (N5 `closureOf`) so producers and verifiers agree.
- Consumers read deny and member state from `head`, never `states.at(-1)` (N1).

### kumiai (MLS groups) — kumiai-90
Today (0.11, `packages/mls/src`): a bound leaf carries `controller = { id, prefix, capability,
holderGrant? }`. `prefix` is the root chain only. The leaf capability (≤ `MAX_LEAF_LIFETIME`, 7 d;
groups default to 1 d) is either root-signed or chained from a holder whose own root-signed grant
(≤ `MAX_TRUSTED_GRANT_LIFETIME`, 1 y) rides as `holderGrant`. Verification is pinned at the token's
`iat` against the embedded prefix (`authentication.ts` `verifyPinnedCapability`). Freshness is not
the prefix's job: denials come from the group-folded device registry, and a leaf lapses against the
group's tree time (`lifecycle.ts` `isLapsed`). Under cold custody every root-signed grant here
becomes member-signed (`mbr`). That is the whole kumiai change.

- **Leaf binding.** `assertControllerGrant` (iss === sub) widens to also accept an `mbr` root,
  checked through `resolveMember` on one `frozen()` view. This applies to the leaf capability, the
  holder grant and the registry's `manage` capability (`verifyManagementCapability`). The direct arm
  today only calls `verifyToken` (`authentication.ts:172-181`), so a direct `mbr` grant needs the
  full member-root check there (`assertMemberRoot`: membership under add digest and `g`, exact pin,
  `exp ≤ lease`, lifetime bound), not only on the chained arm. A longer holder grant does not
  lengthen a leaf: the leaf capability stays under `MAX_LEAF_LIFETIME` and the group's
  `leafLifetime` (`capability.ts:20-21,168`).
- **A managing device's own leaf: membership binding, no grant.** This is option (a); follows
  OQ-device-binding (the device's `did:peer:4` is the member pin). A third binding form,
  `controller = { id, prefix, events, member: { add, g } }` with no `capability`, authenticates a
  leaf when all of these hold:
  - The leaf's DID, compared canonically, is the member that `resolveMember(id, { did, add, g })`
    returns as effective on the embedded log.
  - The MLS signature key equals the pinned key exactly. `matchesLeafKey` has already tied the long
    form to the short form.
  - Its registry member root is effective at acceptance, under the current-state rule below.

  Expiry is the lease end the embedded log reports, judged against tree time like any leaf `exp`. A
  renewal reaches the leaf on the device's next Update, which carries newer events. Why (a) rather
  than a self-issued `mbr` grant (b):
  - A self-issued grant adds no proof beyond the MLS leaf signature by the same pinned key.
  - (b) would carve an exception into the `self-issued` refusal that every other path relies on.
  - A membership leaf attests no `iat`, so it takes no part in tree time. This narrows the
    tree-time inflation risk below to leaves a member mints for others.

  The member root of such a leaf is its own incarnation, so its `rmv` cascades it with no special
  case. A member cannot `rev` its DID: kokuin refuses a member-authored `rev` targeting any member of
  its causal past, removed ones included (`MEMBER_REVOKES_MEMBER`, members leave through remove), which
  keeps root able to re-add it. Root denies the DID at its next settle. Wire: `controller.capability`
  becomes optional only when `member` is present. A 0.11 peer rejects this form, which is already
  covered by band 0.12. Rotating a managing device's key is a new pin and a new incarnation, so it
  is a root occasion.
- **Member identity.** Each bound leaf records its **member root**: the `(member DID, add digest,
  g)` that signed the root of its chain, read from the leaf capability (direct `mbr`), its parent,
  or its holder grant, or the leaf's own `member` for a membership binding. Root-signed roots record the controller. Every cascade, survivor and freshness
  rule below keys on the member root (incarnation), not on the immediate `iss`.
- **Leaf events.** Required, held once per group in the device registry, not per leaf. A member's
  renewals (`ren`), and its `add` until root settles, live only in epoch events; a chain-only prefix
  alone would report the lease from the last snapshot. Per-leaf epoch events were measured out: a
  6-month, 3-member epoch is about 755 KB of history at 50 leaves, past `HISTORY_HORIZON` (393 216).
  So bound leaves keep the chain-only prefix, and each controller's current epoch lives once per group
  in the registry (`recordedLog: ControllerLog`), fed by signed `kumiai.device` `log` entries carrying
  event deltas. A delta is accepted only if it merges into a fold where every delta digest is applied,
  and the registry stores the pruned fold (the ingestion contract). About 34 KB at 50 leaves. A Welcome
  joiner validates leaves against registry state. Settlement policy for this workload: cap 32 events,
  prompt at 24, so the cold root settles about every 6 months.
- **Proof form.** A member revoke (`rev` of an edge) or removal (`rmv`) is a log event with no chain
  position. The registry proof becomes `{ chain, events }`: the chain plus the event's causal
  closure. Its effect is read from the folded `head` (`head.deny`, removed members), never
  `states.at(-1)` (N1). It is keyed by the event digest, not `logPosition`. After root settles, a
  stored proof is upgraded to chain form, where the effect is in the snapshot `d`/`m`.
  `revokesSubject` keeps the root-rotate case. Both shapes want one shared definition (kokuin export,
  open Q2 of the kokuin section, plus N5 `closureOf`).
- **Registry and cascade.** `recordedLog` becomes a `ControllerLog`. Today the cascade records an
  issuer only for chained capabilities and follows only the immediate issuer
  (`lifecycle-proof.ts:198-202,255-259`), so a direct `mbr` leaf, or a member root behind a holder
  grant, would never cascade. New rule: a member removal (`rmv`) cascades every leaf whose member
  root is that incarnation, across all three evidence slots (leaf capability, parent, holder grant).
  An edge `rev` keeps today's shape: the denied DID plus the leaves it chained. `isEvidencedChild`
  keeps a leaf only when its holder grant's member root is still effective, or is root.
  Producer (`proofFor`) and verifier (`effectsMatch`) compute the same set from the same rule.
- **Removed issuers against current state.** kokuin authorises causally: an event concurrent with
  its signer's removal stays authentic and its effects apply (`epoch.ts:266-275`, "events concurrent
  with the denial are not voided"). kumiai does not take that as acceptance. A member-authored
  registry entry, leaf or `manage` grant is accepted only if its member root is effective in the
  registry's current authenticated head (the fold of `recordedLog` plus the proof), checked at
  acceptance. A removal that lands first therefore refuses the removed member's later-arriving
  concurrent actions in kumiai, even where the log fold keeps them. This follows the
  applied-state-over-delivered-bytes rule.
- **Sole-survivor.** Needs changes on both sides; "no conflict" was premature. kubun's survivor
  check requires `iss === sub === controller` (kubun backlog `2026-10-21-...-adoption.md:84`), so it
  refuses member-minted survivors until it accepts an `mbr` root with the member-root check. kumiai
  needs:
  - **Producer:** a surviving member mints a direct leaf grant (`mbr`) for each leaf whose member
    root is the removed incarnation.
  - **Verifier:** the revoke entry's `effectsMatch` excludes leaves covered by a survivor grant whose
    member root is effective and is not the removed incarnation.
  - **Survivor check (`checkSurvivors`):** the same rule over the post-commit tree.
  A survivor minted by a member concurrently removed in the same commit window is refused by the
  current-state rule above.
- **Freshness.** A leaf authenticates at its token's `iat` against the embedded log
  (`authentication.ts:174-178,224-228`). It lapses when authenticated tree time passes its `exp`.
  Tree time is the maximum attested issuance across bound leaves, floored by the ledger
  `timeFloor` (`lifecycle.ts:73-104`). A removal or revoke applies once its ledger commit is received
  and processed. Current registry state overrides stale embedded member evidence: a leaf whose
  embedded log shows its member root effective is refused when the registry's head says removed.
  The same must hold on Welcome: the joiner judges tree leaves through `checkSurvivors` with
  `origin: welcome` (`lifecycle.ts:334`), so the registry it uses there must already include the
  ledger's removals. Not yet verified for 0.11; to check in the kumiai plan. A lease end bounds every member grant at mint
  (`exp ≤ lease`), so a lapsed lease stops new leaves, and existing ones lapse within the leaf
  lifetime by tree time. A peer that has not processed the removing commit still accepts the
  removed member's grants until its lease end (N3, accepted).
- **Tree time under member attestation.** Tree time takes the maximum `iat` bound leaves attest.
  Under the tier any member attests, bounded only by `iat ≤ exp ≤ lease`, so one buggy-clock or
  hostile member could advance tree time by up to its lease and lapse every other leaf. Decided
  (kumiai plan): an attested time counts once two distinct effective member roots agree (the
  second-highest attested time), or the sole member's when there is only one. Root-only attestation
  was rejected: it would freeze tree time while the root is cold.
- **Saturation.** An `EPOCH_SATURATED` embedded or recorded log means no new bound leaf, no registry
  entry for that controller, and existing leaves untouched until root settles. It is never read as
  "nothing denied".
- **Size.** Leaves grow with the unsettled epoch. Each event is ≤ 8192 B (`MAX_EVENT_BYTES`),
  typically a few hundred. Re-run `history-size` against `HISTORY_HORIZON` (393 216) with a realistic
  epoch: 2–3 members renewing every few weeks, a few edge revokes. A stack policy is needed on the
  settle cadence. Either root settles at least every N months, or kumiai caps embedded events and
  fails closed past the cap. The second turns "root comes out rarely" into an explicit product
  prompt.
- **Band.** A 0.11 peer rejects `mbr` leaves and the new proof form, which in MLS diverges the group.
  So this is band 0.12, with every peer of a group on 0.12 before the first member-issued leaf. The
  persisted registry format breaks; that is accepted (no legacy-data compat).
- **Contracts.** `rpc-conformance` and `hub-conformance` against the real implementation and the
  doubles. The doubles must model `mbr` and saturation at least as strictly as the real code.

kumiai's read on open Q1/Q2:
- **Q1 (member-issued adds).** Not needed for kumiai, and decision 1 already lists member adds as a
  root occasion. Adding a member grants log authority, which is a root power ("never beyond root's
  authority"). Pairing a device that only needs grants is offline-root already: a member mints it an
  edge grant. Pairing a device that must act for the controller (renew, remove, revoke) is a root
  occasion; the migration and setup flows bring root out anyway. Recommend no kokuin 0.3 for this.
- **Q2 (12 h vs 30-day phone).** 12 h is a verifier default (`checkCapability` max member-grant
  lifetime), not a log rule. Each verifier sets it. For MLS, kumiai has ledger freshness, so it can
  bound member holder grants at `min(lease, MAX_TRUSTED_GRANT_LIFETIME)` and keep leaf capabilities
  short. A 30-day offline phone that is a member is bounded by its lease (90 d default) and its
  renewals, not by grant lifetime. As an edge it needs a ≥ 30 d member grant, which kumiai can
  accept. The records lane has no ledger, so kubun may want shorter there. That is a kubun choice,
  and it is why Q2 is per-verifier, not stack-wide.

### kubun (engine, own-agents, records)
- Controller head and store on `{ chain, events }` (stage B with `@kokuin/store-controller`) under
  the ingestion contract; deny and member reads from `head`.
- Membership leaves (kumiai option a): a managing device's leaf carries `controller.member = { add, g }` and no capability. Kubun code reading `binding.capability` unconditionally (own-agents effective-leaf and survivor checks, records) branches on `member`.
- Own-agents: pairing as root-assisted `add` (member device) or `mbr` edge grant (edge device);
  departure/loss of a managing device as `rmv` of its incarnation (root denies the DID at settle; a
  member never `rev`s a member DID), loss of an edge device as `rev` of its edge audience; revocation verified from epoch events; a
  member-lease renewal loop. Survivor validation changes from `iss === sub === controller`
  (backlog `2026-10-21-kokuin-management-tier-adoption.md:84`) to "effective member root of the current
  generation, not the removed incarnation".
- **Records lane** (fixes the carriage defect). `actsFor` for a kokuin owner resolves the record
  signer as a member via `resolveMember({ did, add, gen })`. Requirements:
  - the signed op carries the member incarnation (`add` digest) and generation, and the signing key
    is bound to that member pin;
  - the owner's log must be available to the receiver (from the record peer or controller-log fetch);
  - `resolveMember` answers only current effectiveness, so historical acceptance needs an explicit
    policy per outcome: lease lapsed, member removed, member re-added (new incarnation), generation
    reset — open OQ-record-history;
  - key-branch checks that re-verify the original key author (`record-types.ts:628-630`) and re-ships
    (A→B, then B→C serving A's evidence) follow the same policy; restore Topology-3/4 e2e coverage.

### sakui (product)
- Custody migration per Migration order above: seed export to mnemonic/hardware wallet, verified
  recovery, desktop and phone become members.
- Pairing: root-assisted member add for a managing device; member-minted edge grant otherwise.
- Cap-refresh lane becomes member renewal plus member-minted grants. Grant lifetimes are set per
  verifier (kokuin's member-grant lifetime is a `checkCapability` option, default 12 h,
  `capability/src/member.ts:139-156`), always `exp ≤ lease`; see OQ-offline.

## Decided (user, 2026-10-23, round 2)

- **OQ-offline → local + MLS sync.** A phone offline ~30 days keeps working locally and keeps participating in groups (MLS leaf/holder grants up to its lease, 90 d default, per kumiai); issuing new grants to other devices may pause until it reconnects. The records lane picks its own, possibly shorter, member-grant limit.
- **OQ-record-history → valid if signed while effective.** A record a member signed keeps verifying after its lease lapses and after the member is removed, as long as it was signed while the member was effective (proved by its incarnation and the owner's log); only a reset or an explicit revoke of that member's grants invalidates it.
- **OQ-settle → size-triggered prompt.** Devices prompt the user to settle with the cold root when the unsettled epoch passes a size threshold; past a hard cap, new member-issued MLS leaves fail closed until root settles.
- **OQ-device-binding → the device DID is the member pin.** Every app instance (desktop, phone, agent) has its own `did:peer:4` identity and is an MLS group member as itself. Root MAY add that same `did:peer:4` (long form) as a management member; a device that is not a member is a plain participant holding a root- or member-issued grant (e.g. desktop managing, phone not). No separate member key and no binding statement. Consequences: (1) a managing device's own leaf/holder grant is self-issued — kumiai must let effective membership authorise the member's own leaf, or accept a self-issued `mbr` grant only from an effective member; (2) rotating a managing device's key is a new member pin, hence a root occasion; (3) member pins are long-form `did:peer:4` and every layer compares DIDs canonically (as kokuin's `deviceRevokeIndex`). Losing a managing device = a member `rmv`s its incarnation; denying its DID is a root action at the next settle (user, 2026-10-23: kokuin's `MEMBER_REVOKES_MEMBER`). Grants other members issued *to* that DID stay valid until they expire (≤ lease).

## Open questions (stable IDs)

- **OQ-offline.** What must a 30-day-offline phone keep: local operation only, fresh MLS
  participation, or the ability to issue grants? This sets per-verifier member-grant lifetimes (MLS
  holder grants up to `min(lease, 1 y)` per kumiai; records lane possibly shorter).
- **OQ-record-history.** Should records a delegate signed keep verifying after its lease lapses,
  after removal, and after a reset — separately — and what evidence must a new receiver require?
- **OQ-settle.** Acceptable cold-root settle cadence, or a size-triggered prompt (kumiai embedded-event
  cap failing closed)?

Answered / not open: member-issued adds (decided: root occasion, no kokuin 0.3 for it); sole-survivor
(an implementation requirement in kubun and kumiai sections); adoption order (dependency sequencing:
kokuin exports → kumiai 0.12 → kubun → Sakui).
