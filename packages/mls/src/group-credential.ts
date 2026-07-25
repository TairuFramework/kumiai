import { isPeer4, type OwnIdentity } from '@kokuin/token'
import {
  type Credential,
  type CustomExtension,
  defaultCredentialTypes,
  generateKeyPackageWithKey,
  greaseExtensions,
  makeCustomExtension,
} from 'ts-mls'

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

/**
 * Shared key-package construction. An invitee leaf must advertise the control extension types or
 * ts-mls refuses to add it to an anchored group. An explicit `options.capabilities` override still
 * wins.
 *
 * `extensions` is left genuinely absent (not passed as `extensions: undefined`) when the caller
 * supplies none, so `generateKeyPackageWithKey`'s own `params.extensions ?? greaseExtensions(...)`
 * default still applies for the ordinary path.
 */
async function buildBundle(
  identity: OwnIdentity,
  options?: GroupOptions,
  extensions?: Array<CustomExtension>,
): Promise<KeyPackageBundle> {
  const { cipherSuite } = await resolveMlsContext(options)
  const result = await generateKeyPackageWithKey({
    credential: makeMLSCredential(identity),
    signatureKeyPair: { signKey: identity.privateKey, publicKey: identity.publicKey },
    cipherSuite,
    capabilities: options?.capabilities ?? controlCapabilities(),
    // Omitted entirely for the ordinary path, so ts-mls applies its own default GREASE.
    ...(extensions != null ? { extensions } : {}),
  })
  return { ...result, ownerDID: identity.id }
}

/** Generate a key package for joining groups. */
export async function createKeyPackageBundle(
  identity: OwnIdentity,
  options?: GroupOptions,
): Promise<KeyPackageBundle> {
  return buildBundle(identity, options)
}

/**
 * The `last_resort` KeyPackage extension from draft-ietf-mls-extensions (NOT RFC 9420, which has
 * no such extension). Its presence marks a key package as reusable by design; its data is empty.
 *
 * This is a KeyPackage extension, not a leaf-node one, so it needs no entry in the leaf's
 * capabilities and `controlCapabilities()` is unaffected.
 */
export const LAST_RESORT_EXTENSION_TYPE = 0x000a

/**
 * Generate a reusable last-resort key package for joining groups.
 *
 * A hub may serve this one repeatedly without consuming it, so the owner stays addable to a group
 * even after their ordinary single-use packages have been drained. Upload it through the hub's
 * last-resort slot, never through the ordinary pool.
 *
 * **The caller must retain `privatePackage` after processing a Welcome** rather than deleting it
 * as it would for an ordinary bundle: the same package can be handed to another inviter later.
 * `@kumiai/mls` never owns private packages — `processWelcome` takes the bundle as a parameter —
 * so nothing here can enforce that for you.
 */
export async function createLastResortKeyPackageBundle(
  identity: OwnIdentity,
  options?: GroupOptions,
): Promise<KeyPackageBundle> {
  // Supplying `extensions` at all suppresses ts-mls's own default of
  // `greaseExtensions(defaultGreaseConfig)`. `defaultGreaseConfig` is not exported, so its 0.1
  // probability is restated here — dropping the spread would silently cost the stack its GREASE.
  return buildBundle(identity, options, [
    ...greaseExtensions({ probabilityPerGreaseValue: 0.1 }),
    makeCustomExtension({
      extensionType: LAST_RESORT_EXTENSION_TYPE,
      extensionData: new Uint8Array(0),
    }),
  ])
}
