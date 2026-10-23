import { createControllerResolver, type SignedEvent } from '@kokuin/controller'
import type { DIDMethodResolver } from '@kokuin/token'

import { asControllerLog, hasLegacyRevoke } from './controller-log.js'

const EMPTY: ReadonlySet<string> = new Set()

/**
 * A `did:kokuin:` resolver whose log is the prefix EMBEDDED in an MLS leaf — never fetched
 * externally. `loadLog` answers only for `controllerID`, returning the embedded `prefix`, and
 * `undefined` for any other DID, so no code path can reach a sidecar. `resolveDenySet` is overridden
 * to answer from the injected group-folded set (freshness), rather than the prefix's frozen head.
 *
 * Member grants are unsupported: the prefix carries no epoch events, so members could only come
 * from a stale snapshot.
 *
 * A per-leaf, one-shot instance: the prefix is small, verification is single-pass, and no `history`
 * store is configured. This is the adapter the Slice 1 spike verified to run with zero external I/O.
 */
export function createEmbeddedControllerResolver(params: {
  controllerID: string
  prefix: Array<SignedEvent>
  denySet?: ReadonlySet<string>
}): DIDMethodResolver {
  const base = createControllerResolver({
    loadLog: async (did) =>
      did === params.controllerID && !hasLegacyRevoke(params.prefix)
        ? asControllerLog(params.prefix)
        : undefined,
  })
  // Forward only what verification needs: anything else kokuin adds is not passed through unseen.
  const { method, resolve, resolveHistoric, resolveAgreementKey } = base
  return {
    method,
    resolve,
    resolveHistoric,
    resolveAgreementKey,
    async resolveDenySet(_did: string): Promise<ReadonlySet<string>> {
      return params.denySet ?? EMPTY
    },
  }
}
