# Reserved namespaces say `kumiai`

**Status:** complete. Landed on `feat/app-lane-delivery` (PR #7), by ruling — one coordinated break
for the host to migrate against once.

## Goal

kumiai reserved two namespaces and neither was named after kumiai. `group.*` control-ledger entry
types are a generic English prefix a host app naturally reaches for; `enkaku/*` topic labels borrowed
a different layer's name while living in this repo.

The `group.*` case was live, not theoretical: an unknown `group.*` type did not get ignored, it
**rejected the whole commit**. A host defining `group.settings` hit exactly that wall.

## Rulings that scoped it

Both namespaces, not `group.*` alone. Hard cutover — no shim, no compatibility window — which is what
kept the change small, and rests entirely on there being no persistent state to survive the rename
(dev and test groups only, recreated at will). No tripwire keeping the old spellings rejected:
`group.*` becomes host space entirely.

## What changed

`group.` became `kumiai.` for entry types; the five `enkaku/*` topic labels became `kumiai/*`. Every
value sat behind a named constant and **the constant names did not change — only their values.**

Semantically, exactly one thing changed: **`group.*` stopped failing closed and became application
space.** Everything else was a value substitution with no behavioural consequence. Because that is
the change the host was blocked on, it got a positive test — a host-defined `group.settings` entry is
*surfaced* — rather than resting on the absence of a rejection. A rename proved only by tests that
stopped failing is a rename proved by nothing.

The fail-closed behaviour itself is correct and was kept. An unknown entry in a reserved,
authority-bearing namespace must never be surfaced unread. The defect was the choice of prefix, not
the strictness.

`docs/agents/architecture.md` gained a reserved-namespace section. It had none, which is why the host
discovered the reservation by hitting a wall.

## Accepted risks, still standing

**The type checker stays silent through a wire-format break.** Constant names are unchanged, so a
host importing the constants keeps compiling; a host that hardcoded `'group.role'` breaks with no
diagnostic. The changesets say this in prose because nothing else will.

**`group.role` inverts meaning silently.** After the rename it is a legal application entry type,
surfaced unread, where before it was authority-bearing and failed closed — so the one string whose
meaning inverts is the one governing the roster. A tripwire was declined: it would cost three strings
to remove later and forbid hosts a name they may want.

**Topic-label renames partition silently.** Members deriving labels out of lockstep land on different
topic IDs with no error — the exact failure class PR #7 was opened to fix.

All three are safe only while the hard-cutover assumption holds. If any deployment turns out to span
this change, they are live.

## Follow-up after the rename

The rename made the MLS exporter label and a topic label byte-identical (`kumiai/rendezvous/v1`). No
crypto issue — separate KDF domains — but a future deduplication could couple them. Resolved by
splitting them: the recovery secret's HKDF info label became `kumiai/recovery/v1`, which was the
correct name on its own terms, since that secret roots both the commit and rendezvous topics and the
constant's own name already said so.
