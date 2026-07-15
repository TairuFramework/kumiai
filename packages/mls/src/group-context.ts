import {
  type Capabilities,
  type CiphersuiteName,
  defaultCapabilities,
  type GroupContextExtension,
  getCiphersuiteImpl,
  type MlsContext,
} from 'ts-mls'

import { createDIDAuthenticationService } from './authentication.js'
import { nobleCryptoProvider } from './crypto.js'
import type { GroupOptions } from './types.js'

const DEFAULT_CIPHERSUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const

export async function resolveMlsContext(options?: GroupOptions): Promise<MlsContext> {
  const name = (options?.ciphersuiteName ?? DEFAULT_CIPHERSUITE) as CiphersuiteName
  const cipherSuite = await getCiphersuiteImpl(name, options?.cryptoProvider ?? nobleCryptoProvider)
  const authService = createDIDAuthenticationService()
  return { cipherSuite, authService }
}

/**
 * Build the leaf-node capabilities for a member joining or creating a group. RFC
 * 9420 requires a leaf to advertise every non-default GroupContext extension type
 * the group uses; derive that set from the group's extensions so it cannot desync.
 * A leaf advertising only defaults is rejected by ts-mls ("client does not support
 * every extension in the GroupContext"). An explicit `override` wins verbatim.
 */
export function buildLeafCapabilities(
  extensions: ReadonlyArray<GroupContextExtension>,
  override?: Capabilities,
): Capabilities {
  if (override != null) return override
  const base = defaultCapabilities()
  const types = new Set<number>([...base.extensions, ...extensions.map((e) => e.extensionType)])
  return { ...base, extensions: [...types] }
}
