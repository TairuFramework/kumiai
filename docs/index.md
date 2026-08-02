# kumiai docs

組合 -- the stack's MLS group-messaging layer.

- **Stack overview:** https://github.com/TairuFramework/kigu/blob/main/docs/stack.md
- **Conventions & development:** the kigu `conventions` and `development` skills (auto-loaded via the kigu plugin)
- **Architecture:** [agents/architecture.md](./agents/architecture.md)
- **Planning:** [agents/plans/](./agents/plans/) — [roadmap](./agents/plans/roadmap.md)

## Reference

- [Reserved namespaces](./reference/reserved-namespaces.md) — the `kumiai.` / `kumiai/` prefixes and the MLS extension types a host must not collide with
- [Lanes and retention](./reference/lanes-and-retention.md) — `mailbox` vs `log`, the four lanes, the retention window
- [The app lane](./reference/app-lane.md) — the anchor, segments, the returning-member drain, the cursor
- [Defining a group protocol](./reference/group-protocols.md) — procedure kind × retention
- [Two seals](./reference/sealing.md) — `wrap`/`unwrap` vs `sealEntries`/`openEntries`
