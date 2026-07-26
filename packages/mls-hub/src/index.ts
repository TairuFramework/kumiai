/**
 * Key-package provisioning between `@kumiai/mls` and a kumiai hub.
 *
 * ## Why this is its own package
 *
 * `@kumiai/mls` is the crypto core and must not depend on transport — a group library that imported
 * a hub client would invert the stack. `@kumiai/hub-client` must not depend on `ts-mls`: its whole
 * character is that it never decodes MLS, matching the hub it speaks to, and every consumer would
 * otherwise pay that dependency. `@kumiai/mls-rpc` implements `@kumiai/rpc`'s consumer ports, and
 * provisioning implements no rpc port.
 *
 * So the code that joins the two belongs above both, for the same reason `@kumiai/mls-rpc` exists:
 * an implementation spanning two packages goes in a third, because putting it in either one imports
 * a dependency that package must not have. Note that this package does NOT depend on `ts-mls` —
 * every MLS wire form it needs is reached through `@kumiai/mls`.
 *
 * @module mls-hub
 */

export {
  createMemoryLastResortStore,
  type LastResortRecord,
  type LastResortStore,
} from './store.js'
