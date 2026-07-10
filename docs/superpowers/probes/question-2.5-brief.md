# Probe brief — Question 2.5: Does the roster subsume the capability chain?

**Read-only research.** Do not modify any source file. A throwaway spike test is permitted only
if a question cannot be settled by reading; say so if you write one.

Two agents share this brief. Each owns one part and writes one report. Neither decides the
outcome — you gather evidence with `file:line` citations and state what it implies. The user
decides.

## The question

`@kumiai/mls` is gaining a control ledger: an anchor baked into the MLS GroupContext at group
creation (`{creatorDID, version, app?}`, extension type `0xf100`, authenticated by the GroupInfo
signature), plus signed `group.role` entries folded into a roster
`Map<normalizedDID, 'admin' | 'member'>` seeded `{creatorDID: 'admin'}`. Authority for every
commit is checked against that roster.

Once every member holds an admin-signed, anchor-rooted `group.role` entry, the invite's
`capabilityChain` looks like a *second* membership proof — one with strictly worse properties:
unbounded depth (it grows one link per relay hop), no total order, and no revocation primitive.

**If the roster subsumes it,** `Invite` drops `capabilityChain` / `capabilityToken`, and the two
open requirements of `docs/agents/plans/next/2026-07-10-member-relay-invite.md` — bound the chain
depth, design transitive revocation so revoking `A→R` invalidates `R→B` — dissolve rather than
needing designs.

**If it does not,** we learn precisely what the chain establishes that a fold cannot, the chain
stays, gains a depth cap, and transitive revocation goes to `backlog/mls-capability-revocation.md`.

Read `docs/superpowers/specs/2026-07-09-mls-permission-enforcement-design.md` first — the whole
spec, not an excerpt. Then your part below.

Repos: `/Users/paul/dev/yulsi/kumiai` and `/Users/paul/dev/yulsi/kubun`.

Conventions: `AGENTS.md` and the `kigu:conventions` skill. Code, comments, and test names never
reference plan questions, decision numbers, or phase labels.

---

## Part A — What does the capability chain establish, and can `processWelcome` fold instead?

Write your report to `docs/superpowers/probes/question-2.5-report-a.md`.

### A1. What does `validateGroupCapability` actually establish?

Read `packages/mls/src/capability.ts` end to end, and `@kokuin/capability`'s
`checkDelegationChain` / `assertValidDelegation` / `assertCapabilityToken` (in `node_modules`).

Enumerate every property the chain proves. At minimum, work out how each of these is established
and whether a signed `group.role` entry could carry it:

- `aud` binding — the capability names the joiner. (The role entry has `subject`. Is `subject`
  as strong? The role entry is signed by an admin, so its `iss` is the grantor and `subject` the
  grantee. What's missing?)
- `res` / `act` scoping — what does a group capability authorize *beyond* membership?
- `exp` — expiry. Do role entries need it? The spec puts capability expiry out of scope; say
  whether that's tenable if the chain goes away.
- `jti`, revocation cross-checks, anything else you find.

For each property: **does the roster already carry it, could it trivially, or is it lost?**

### A2. Can `processWelcome` fold a roster before it trusts anything?

The roster seeds from the anchor. The anchor lives in the GroupContext, which is carried by the
Welcome's GroupInfo.

Today `processWelcome` (`packages/mls/src/group.ts:578-639`) validates the capability chain
*before* calling `mlsJoinGroup`. If the chain goes away, the joiner must instead fold a roster
from `Invite.ledgerEntries` seeded by the anchor, and assert it appears in that roster.

**Establish whether the anchor is readable before `mlsJoinGroup`, or only after.** Look at
`packages/mls/src/group.ts`'s existing `inspectGroupInfo` helper (there is a
`test/inspect-group-info.test.ts`) and at what ts-mls exposes on a decoded Welcome. A Welcome's
GroupInfo is encrypted to the joiner's key package — determine what it actually takes to reach
the GroupContext extensions, and whether that is available at the point `processWelcome` currently
validates.

If it is only readable after `mlsJoinGroup`, say what that costs: the joiner would apply the
Welcome before verifying it was legitimately invited. Is that acceptable given the Welcome is
itself authenticated? Reason it through; don't guess.

### A3. If the chain stays, where does a depth cap go?

`checkDelegationChain` is in `@kokuin/capability`, a different repo. Can kumiai enforce a cap
without changing that package? What is a defensible maximum, and what breaks at it?

---

## Part B — Who consumes a group capability, and for what?

Write your report to `docs/superpowers/probes/question-2.5-report-b.md`.

### B1. Trace every consumer

Start from `createGroupCapability` and `delegateGroupMembership` in
`packages/mls/src/capability.ts`. Find every call site and every reader of the resulting token,
across:

- `/Users/paul/dev/yulsi/kumiai/packages/`
- `/Users/paul/dev/yulsi/kubun/packages/plugin-p2p/`

Also trace `rootCapability` and `credential.capabilityChain` — who reads them, who persists them
(`kubun/packages/plugin-p2p/src/groups/mls-state.ts` serializes both), who would break if
`Invite.capabilityChain` disappeared.

For each consumer: **is it using the capability as a membership proof, or for something else?**

### B2. Are per-document grants a separate axis?

`kubun/packages/plugin-p2p/src/groups/store-received-grant.ts` handles `document/write` grants.
The kumiai spec asserts these are "a different capability axis" that does not chain from the group
root. **Verify or refute that.** Read the grant's `res`, its `parentCapability` (if any), and
where it is minted. If any `document/*` grant chains from a group capability, the chain is
load-bearing for something other than membership and cannot be dropped.

Check `access-default-token.ts`, `broadcast.ts`, `invite-payload.ts` too — the spec claims their
`'read' | 'write'` is per-document access, unrelated to `GroupPermission`.

### B3. What breaks in kubun if `Invite` loses `capabilityChain`?

Read `kubun/packages/plugin-p2p/src/context/join.ts` and `context/group.ts` around the invite and
join paths. Report the concrete edits kubun would need. Note that kubun already ships ledger
entries in the invite (`context/join.ts:91`).

---

## Rules for both agents

- **Cite `file:line` for every claim.** A claim without a citation is a guess, and a guess here is
  worse than an unknown.
- If a question cannot be settled by reading, say `UNRESOLVED` and state exactly what experiment
  would settle it. Do not speculate past the evidence.
- Report `BLOCKED` if you cannot read something you need (missing repo, unreadable dependency).
- Do not modify source. Do not commit.
- No conclusions about whether to drop the chain — evidence and implications only. Two agents are
  looking at different halves; neither can see the whole.

## Report contract

Write the full report to your assigned file. Return to the caller **only**: status
(`DONE` / `DONE_WITH_CONCERNS` / `UNRESOLVED` / `BLOCKED`), a one-line answer per sub-question,
and anything that surprised you. Not the report body.
