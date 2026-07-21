import { isPeer4, type OwnIdentity } from '@kokuin/token'
import { type Credential, defaultCredentialTypes, generateKeyPackageWithKey } from 'ts-mls'

import { controlCapabilities } from './anchor.js'
import type { MLSCredentialIdentity } from './credential.js'
import { resolveMlsContext } from './group-context.js'
import type { GroupOptions, KeyPackageBundle } from './types.js'

export function makeMLSCredential(identity: OwnIdentity): Credential {
  const id = identity.id
  const isPeer = isPeer4(id)
  if (
    isPeer &&
    !('longForm' in identity && typeof (identity as { longForm?: unknown }).longForm === 'string')
  ) {
    throw new Error(
      'peer:4 identity is missing longForm; only identities from createIdentity can be used as MLS members',
    )
  }
  const payload: MLSCredentialIdentity = { v: 1, id }
  if (isPeer) {
    payload.longForm = (identity as unknown as { longForm: string }).longForm
  }
  return {
    credentialType: defaultCredentialTypes.basic,
    identity: new TextEncoder().encode(JSON.stringify(payload)),
  }
}

/** Generate a key package for joining groups. */
export async function createKeyPackageBundle(
  identity: OwnIdentity,
  options?: GroupOptions,
): Promise<KeyPackageBundle> {
  const { cipherSuite } = await resolveMlsContext(options)
  const result = await generateKeyPackageWithKey({
    credential: makeMLSCredential(identity),
    signatureKeyPair: { signKey: identity.privateKey, publicKey: identity.publicKey },
    cipherSuite,
    // An invitee leaf must advertise the control extension types or ts-mls
    // refuses to add it to an anchored group. An explicit override still wins.
    capabilities: options?.capabilities ?? controlCapabilities(),
  })
  return { ...result, ownerDID: identity.id }
}
