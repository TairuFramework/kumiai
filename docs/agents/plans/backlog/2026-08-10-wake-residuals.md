# Wake notification residuals

Left over from `feat/hub-wake-notifications` (see
`docs/agents/plans/completed/2026-08-10-hub-wake-notifications.complete.md`). The schema-`pattern`
item is higher priority and lives in `docs/agents/plans/next/2026-08-10-wake-topicid-pattern.md`.

## Platform pieces, out of scope by design

- **The iOS Notification Service Extension.** Swift, reached through an Expo config plugin, needs an
  EAS development build, never works in Expo Go. It is what turns the sealed hint into visible text.
  **It must never unwrap an MLS frame** — opening one consumes the per-message ratchet key that
  `packages/rpc/src/open-once.ts` exists to protect. Notification text comes from the hint's
  `topicID` mapped to a locally stored alias: "New message in Foo", never the message. The
  decryption key lives in the Keychain behind a shared App Group so app and extension both reach it.
- **A device-level check in `tests/e2e-expo`.** The harness exists, but `xcrun simctl push` injects a
  payload without exercising APNs, and the Android emulator needs Play Services for FCM. Real
  delivery stays a manual check on hardware.
- **A durable `WakeRegistry`.** Only the in-memory one ships. `testWakeRegistryConformance` is what a
  host runs against its own — and it now pins the cases a plausible SQL registry gets wrong: a
  `delete` missing `WHERE did = ?`, an `expiresAt` comparison using `<`, and put/get returning
  references rather than clones.
- **APNs and FCM senders**, for a host that wants them without Expo in the path.

## Deferred minors

- **`allowEndpoint` guards the Web Push sender only.** The Expo sender POSTs to a constant URL and
  never treats `registration.endpoint` as a URL, so it has no equivalent hole — but a host writing
  its own APNs/FCM sender inherits the responsibility, and the `WakeSender` port doc does not say so.
  One line at the port.
- **Test harness duplication has hit its third copy** — `hub-server`'s `createTestHub` and
  `createTestHubPair`, plus `hub-client`'s `createTestHub`. That was the stated trigger to extract a
  shared helper.
- **Two inaccurate comments in `packages/hub-client/src/client.ts`**, at the `expiresAt` and
  `notAfter` guards. Both claim an explicit `undefined` fails the wire schema's `integer` check;
  empirically false. The guards' real job is keeping a spurious key out of the stored entry. Fix both
  together — they are twins.
- **`onError` cannot distinguish a `retry` verdict from a thrown sender** except by matching the
  synthesized message.
- **`hub-conformance`'s `test` script is `test:types` only**, with no `test:unit`. Pre-existing, not
  introduced here.
