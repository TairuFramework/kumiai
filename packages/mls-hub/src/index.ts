/**
 * Key-package provisioning between `@kumiai/mls` and a kumiai hub, and joining from what gets
 * provisioned: the ordinary key-package pool and the last-resort slot, each generated, uploaded,
 * retained, and pruned; and `processWelcomeFromSources`, which joins from whichever of them the
 * Welcome names and releases the bundle it used.
 *
 * Does not depend on `ts-mls` — every MLS wire form it needs is reached through `@kumiai/mls`.
 *
 * @module mls-hub
 */

export {
  type BundleSource,
  type ProcessWelcomeFromSourcesParams,
  type ProcessWelcomeFromSourcesResult,
  processWelcomeFromSources,
} from './join.js'
export {
  createKeyPackagePool,
  type KeyPackagePool,
  type KeyPackagePoolParams,
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
} from './provisioner.js'
export {
  createMemoryLastResortStore,
  type LastResortRecord,
  type LastResortStore,
} from './store.js'
