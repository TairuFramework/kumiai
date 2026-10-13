/**
 * Key-package provisioning between `@kumiai/mls` and a kumiai hub, and joining from what gets
 * provisioned: the ordinary key-package pool and the last-resort slot, each generated, uploaded,
 * retained, and pruned; and `openWelcome`, which validates a Welcome without consuming its bundle.
 * The host saves the joined group before consuming the source and recording its receipt.
 *
 * Does not depend on `ts-mls` — every MLS wire form it needs is reached through `@kumiai/mls`.
 *
 * @module mls-hub
 */

export { judgeWelcomeAdmission, type WelcomeAdmissionParams } from './admission.js'
export {
  type HubCallStage,
  HubRefusedError,
  HubRetryableError,
} from './errors.js'
export {
  type BundleSource,
  type JoinedWelcome,
  type OpenWelcomeParams,
  type OpenWelcomeResult,
  openWelcome,
} from './join.js'
export {
  createKeyPackagePool,
  type KeyPackagePool,
  type KeyPackagePoolParams,
  type StockResult,
} from './pool.js'
export {
  createMemoryKeyPackagePoolStore,
  type KeyPackagePoolStore,
  type KeyPackageRecord,
} from './pool-store.js'
export {
  createLastResortProvisioner,
  type LastResortProvisioner,
  type LastResortProvisionerParams,
  type ProvisionResult,
} from './provisioner.js'
export {
  createMemoryLastResortStore,
  type LastResortRecord,
  type LastResortStore,
} from './store.js'
