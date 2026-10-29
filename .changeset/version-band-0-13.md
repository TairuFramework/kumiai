---
'@kumiai/broadcast': minor
'@kumiai/hub-client': minor
'@kumiai/hub-conformance': minor
'@kumiai/hub-http': minor
'@kumiai/hub-protocol': minor
'@kumiai/hub-server': minor
'@kumiai/hub-store': minor
'@kumiai/hub-tunnel': minor
'@kumiai/hub-wake': minor
'@kumiai/mls': minor
'@kumiai/mls-hub': minor
'@kumiai/mls-rpc': minor
'@kumiai/rpc': minor
'@kumiai/rpc-conformance': minor
---

The group moves from the 0.12 band to the 0.13 band for crash-safe control. Every publishable
package shares one meaningful version — the minor while pre-1.0, the major after — so a matched
band is a coherent set. Trailing segments still diverge freely: a package taking a patch release
on its own does not move anyone else.

This band introduces durable operation queues and outcomes, co-committed adoption writes,
Welcome obligations and epoch-based re-admission, fork-aware replay, and durable rejoin records
with explicit recovery keys. All fourteen publishable packages move together.

Recovery restores the durable rejoin record and its candidate and request key. Confirmed adoption
co-commits the required `AdoptionWrite` with MLS state; binding, lapse and floor refusals retry
renewal within the same recovery attempt and original deadline.

Breaking host migrations are detailed in the package intents for `mls-rpc`, `rpc`,
`rpc-conformance` and `mls-hub`: durable operation requests replace callback commits and journals,
adoption writes must co-commit with MLS state, recovery keys are explicit, and Welcome opening
is separated from post-save consumption.

Host migration:

- Remove calls to `GroupHandle.reserveHandshakeGeneration` and `consumeHandshakeReservation`.
  `HandshakeWindowError`, `HandshakeWindowConfigError` and `HandshakeReservationError` are removed.
- Replace `GroupMLS.prepareCommitBuild` and `commitBuildFramed` hooks with the control-build port.
  `CommitBuildHooksError` is removed.
- Registry-issued handles, control-build `restoreSource` permit clones, `restoreCandidate` results and recovery/adoption candidates deny application sends with `ApplicationSendRefusedError`.
  Send through registry `seal` instead.
- Operation ID reuse throws `OperationRejectedError('Operation ID is retained')` while an outcome, Welcome obligation, build or matching spent marker retains it.
  Retrying a durable intent remains idempotent.
- Custom `RegistryHandleAccess` implementations require `seal`, `receive`, `onAdmissionChanged` and `onRotationRequired`.
  `GroupHandleRegistry` requires `effectiveNext`.
- Host `createPeer` adapters must forward `internalOperations` to enable automatic rotation.
  Candidate adapters must decode the library rotation envelope through `decodeAutoRotationCandidate`.
- Ordinary MLS callers have a `maximumForwardRatchetSteps` floor of 500, including explicit lower overrides.
  Higher values remain effective. Registry callers require at least 1000.

RPC exports `INTERNAL_OPERATION_PREFIX`, `InternalOperations`, `migrateLegacyControl`, `closeControlBuild`,
`consumeOwnOccurrence`, `executableOperations`, `SavedControlCompatibilityError` and control-store helpers.
The `kumiai/internal/` operation-ID prefix is reserved.
Cold ephemeral seals refuse until committed warm-up. The first log seal waits for bounded maintenance.
`ApplicationLeaseUnavailableError` distinguishes `cold`, `exhausted` and `deferred` availability.
