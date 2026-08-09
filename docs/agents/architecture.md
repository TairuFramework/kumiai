# Architecture

kumiai (組合, "union / cooperative") is the MLS group-messaging layer -- the top of the stack.

This file is the overview: what the packages are, what a host plugs in, and what the design does not
promise. The domain detail lives in [`docs/reference/`](../reference/), indexed below.

## Packages

mls (E2EE identity + membership via MLS -- the crypto core), broadcast (generic fan-out),
the hub subsystem (hub-protocol, hub-client, hub-server, hub-tunnel, hub-wake), and rpc. One
version band while pre-1.0 (young, tightly coupled).

Alongside them: **mls-rpc**, the real implementation of rpc's two consumer ports over a live MLS
handle — until it existed nothing had ever run the ports outside fixtures — **mls-hub**, which owns
when a peer's last-resort key package is generated, uploaded, retained, and pruned (the mechanism
shipped first and nothing decided any of it), and two contract suites, **rpc-conformance**
(`GroupCrypto`, `GroupMLS`) and **hub-conformance** (the hub store and
the log/mailbox hub views). Both suites run against every implementation AND every double, because
every serious defect this stack has had came from a double answering where its real port refuses.

## Position in the stack

Depends downward on sozai, kokuin, and enkaku; nothing depends on kumiai. See the stack
overview: https://github.com/TairuFramework/kigu/blob/main/docs/stack.md

## Reference

| Document | Covers |
| --- | --- |
| [Reserved namespaces](../reference/reserved-namespaces.md) | The `kumiai.` and `kumiai/` prefixes, and the three MLS extension type numbers. **Read this before naming anything.** |
| [Lanes and retention](../reference/lanes-and-retention.md) | `mailbox` vs `log`, the four lanes, the 28-day window, and a subscribe the hub refuses. |
| [The app lane](../reference/app-lane.md) | The anchor and why it is per-epoch, segments, the returning-member drain, the cursor and `frameEpoch`. |
| [Defining a group protocol](../reference/group-protocols.md) | Procedure kind × retention, and why only events may be `log`. |
| [Two seals](../reference/sealing.md) | `wrap`/`unwrap` vs `sealEntries`/`openEntries`, and where the version byte sits. |
| [Wake notifications](../reference/wake-notifications.md) | The push doorbell: the sealed hint, leading-edge debouncing, sender verdicts, and the iOS limits. |

## What a host wires

`createGroupPeer` takes two ports and three durable stores. **The stores are required alongside the
`mls` port and the type enforces it**, because every one of them fails *silently* when absent:

| | |
| --- | --- |
| `GroupCrypto` | `epoch`, `exportSecret`, `wrap`, `unwrap`, `frameEpoch`, `sealEntries`, `openEntries` |
| `GroupMLS` | commit lifecycle, `rosterDIDs`, `readCommitHeader` (incl. `external`) |
| `CommitJournal` | single slot; loses a commit whose process died in the acceptance window |
| `AnchorStore` | the anchor; without it a restart partitions the peer from its own group |
| `AppCursorStore` | the read position; without it the drain re-reads history forever |

`onAppWindowPruned` is **optional** — the line is whether omitting it loses messages. A host with no
cursor store partitions or re-reads; a host ignoring the pruned signal loses nothing it would not
have lost anyway. It is merely not told.

**A host implementing the ports itself owes the conformance suites.** `GroupCrypto.exportSecret` is
the method whose only failure mode is silent: get it wrong and the group still works, members still
talk, removals still remove, and the single symptom is that an evicted member can still name and
read the topic. Take `@kumiai/mls-rpc` and it is right by construction; write your own and
`@kumiai/rpc-conformance` is the only thing that will tell you.

## Stated residuals

Bounds this design has, on purpose, rather than hides:

- **A member away beyond the retention window** loses those messages — surfaced as a pruned-window
  event, never silent.
- **The `processCommit` → anchor-save window.** `processCommit` is durable; a crash before the anchor
  is persisted restores a stale anchor and misses the new segment until the next roster change.
  Closing it needs the anchor inside the same durable write as the handle, which rpc cannot reach.
- **A laggard publisher** — a member still at epoch E writing to segment E's topic after the group
  has rotated past it seals bytes nobody can open again. Inherent.
- **A fresh joiner cannot drain pre-join frames** (its ts-mls history window is empty). Correct by
  design: forward secrecy.
- **The drain is at-least-once against the live path.** The cursor tracks the drain, so a restart can
  re-deliver frames that arrived live and sit after it.
- **A wake ping tells the push provider that a device received something, and when.** The content
  is sealed and the topic never leaves the hub, but timing is inherent to waking a suspended app.
  Self-hosting the push service collapses this to the hub operator, who already saw the timing.
