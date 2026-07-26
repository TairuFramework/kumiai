# Reserved namespaces

What a host may not define. kumiai reserves two string prefixes and three MLS extension types, and
explains one it uses without reserving. Both prefixes name kumiai, so a host can tell at a glance
what is not theirs.

**Application entry types and topic labels must not start with either prefix.** Everything else is
yours, including `group.` — reserved until 2026-07-20, now application space.

## `kumiai.` — control-ledger entry types

`kumiai.role`, `kumiai.recovery-request`, `kumiai.recovery-groupinfo`.

The envelope fold **fails closed** on an unknown `kumiai.*` type: it rejects the whole commit rather
than surfacing the entry unread. An entry in a reserved, authority-bearing namespace that no one
understands must never be passed on.

## `kumiai/` — labels and domain separators

Three different kinds of string share this prefix. They are not interchangeable, and the grouping
below is by *what the string is used for*, not by which package holds it.

### Topic labels

Fed to `deriveTopicID` as the `label` argument. All live in `packages/rpc/src/topic.ts`.

| Label | Constant | Lane |
| --- | --- | --- |
| `kumiai/app-topic/v1` | `APP_TOPIC_LABEL` | App |
| `kumiai/inbox/v1` | `INBOX_LABEL` | Inbox (directed 1:1 RPC) |
| `kumiai/commit/v1` | `COMMIT_LABEL` | Commit |
| `kumiai/rendezvous/v1` | `RENDEZVOUS_LABEL` | Rendezvous |
| `kumiai/discovery/v1` | `DISCOVERY_PREFIX` | Discovery |

### Exporter labels

Passed as the caller-supplied `label` to `GroupCrypto.exportSecret`, which is why they are reserved
rather than merely conventional — a host passing one of these would be handed key material that is
not its to hold.

| Label | Constant | Purpose |
| --- | --- | --- |
| `kumiai/recovery/v1` | `RECOVERY_LABEL` (`packages/mls-rpc/src/mls.ts:27`) | The lifelong recovery secret |
| `kumiai/ledger-entries/v1` | `ENTRY_SEAL_LABEL` (`packages/mls-rpc/src/crypto.ts:14`) | Sealing a commit's ledger-entry blob |

`@kumiai/mls-rpc`'s `exportSecret` **refuses `kumiai/ledger-entries/v1` outright**
(`packages/mls-rpc/src/crypto.ts:130-135`) — a caller passing it would otherwise be handed the
ledger-entry key.

### Derivation domain separators

Internal to the derivation they name; never passed by a caller. Listed because they occupy the
reserved prefix and a host must not collide with them.

| String | Where | Role |
| --- | --- | --- |
| `kumiai/topic/v1` | `packages/broadcast/src/topic.ts:5` (`TOPIC_INFO_PREFIX`) | HKDF `info` prefix inside `deriveTopicID` |
| `kumiai/mls/ledger-head/v1` | `packages/mls/src/head.ts:14` (`DOMAIN`) | Ledger-head domain separator |
| `kumiai/mls/recovery/v1` | `packages/mls/src/recovery.ts:73` | Recovery HPKE `info` |
| `kumiai/mls/recovery-aad/v1` | `packages/mls/src/recovery.ts:74` | Recovery AAD domain |
| `kumiai/mls/recovery-ledger/v1` | `packages/mls/src/recovery.ts:80` | Recovery-ledger HPKE `info` |
| `kumiai/mls/recovery-ledger-aad/v1` | `packages/mls/src/recovery.ts:81` | Recovery-ledger AAD domain |

> `kumiai/topic/v1` was previously documented as a topic label. It is not one — it is the HKDF `info`
> prefix that *every* topic derivation is built on, one level below the labels in the first table.

`kumiai/conformance/export-a` and `kumiai/conformance/export-b` also exist, in
`@kumiai/rpc-conformance` only, as arbitrary distinct labels for asserting that two labels derive
two different secrets. They are test fixtures, not part of the reserved surface a host must respect.

## MLS GroupContext extension types

A reservation of a different kind. Three type numbers in `packages/mls/src/anchor.ts`, advertised by
every member leaf from the moment it joins:

| Number | Constant | Carries |
| --- | --- | --- |
| `0xf100` | `GROUP_ANCHOR_EXTENSION_TYPE` | The genesis anchor |
| `0xf101` | `LEDGER_HEAD_EXTENSION_TYPE` | The control-ledger head |
| `0xf102` | `RESERVED_EXTENSION_TYPE` | Reserved, unused today |

RFC 9420 requires a leaf to advertise a custom extension type before it can be installed, and leaves
cannot be rewritten — so a type introduced after members have already joined can never be installed
into their group, and the only remedy is re-admitting everyone. `0xf102` is reserved now, for that
reason, before anything needs it.

**What the reservation does and does not buy.** It buys the extension *type* surviving into existing
groups' extension lists and every member's capabilities. It does **not** buy a data channel that can
be opened later without a flag day: `packages/mls/src/policy.ts:99-118` admits the added entry only
when it is not already installed, the list grew by exactly one, and its data is a zero-length
`Uint8Array` — then strips it before the positional compare. *Populating* `0xf102` remains a policy
change every peer must ship before any peer can commit it.

## The one MLS extension type kumiai uses but does not reserve

`0x000A` (`LAST_RESORT_EXTENSION_TYPE`, `packages/mls/src/group-credential.ts`) is not in the
`0xf10x` reserved block, because kumiai did not define it: it is `last_resort_key_package` from
draft-ietf-mls-extensions, and the number is the draft's.

**The rule above does not apply to it.** A leaf must advertise a custom extension type before it can
be installed — that is what makes the reserved GroupContext types work — but `last_resort` is a
**KeyPackage** extension (`Message(s): KP`), and RFC 9420's capabilities rule binds leaf-node
extensions only. ts-mls follows the RFC here, checking a peer's declared capabilities against leaf
extensions alone. So `controlCapabilities()` does not list `0x000A`, and that is correct rather than
an omission. Neither draft -05 nor -08 adds an advertisement requirement of its own.

**Version drift to watch.** Draft -08 moved the feature out of the extension registry entirely: it
is now MLS Component Type `0x00000004`, carried inside the `app_data_dictionary` extension. `0x000A`
is nonetheless what deployed implementations use (OpenMLS `main`: `ExtensionType::LastResort => 10`),
so it stays. Whoever migrates to the component form must revisit `controlCapabilities()` at the same
time, because -08 *does* ask clients to advertise `app_data_dictionary` support in their LeafNodes.
