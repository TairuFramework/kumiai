import { isPeer4, type OwnIdentity } from '@kokuin/token'
import {
  type Credential,
  type CustomExtension,
  defaultCredentialTypes,
  generateKeyPackageWithKey,
  greaseExtensions,
  type Lifetime,
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
 * `extensions` and `lifetime` are left genuinely absent (not passed as `undefined`) when the caller
 * supplies neither, so `generateKeyPackageWithKey`'s own `params.extensions ?? greaseExtensions(...)`
 * and `params.lifetime ?? defaultLifetime()` defaults still apply for the ordinary path.
 */
async function buildBundle(
  identity: OwnIdentity,
  options?: GroupOptions,
  overrides: { extensions?: Array<CustomExtension>; lifetime?: Lifetime } = {},
): Promise<KeyPackageBundle> {
  const { cipherSuite } = await resolveMlsContext(options)
  const result = await generateKeyPackageWithKey({
    credential: makeMLSCredential(identity),
    signatureKeyPair: { signKey: identity.privateKey, publicKey: identity.publicKey },
    cipherSuite,
    capabilities: options?.capabilities ?? controlCapabilities(),
    // Omitted entirely for the ordinary path, so ts-mls applies its own defaults.
    ...(overrides.extensions != null ? { extensions: overrides.extensions } : {}),
    ...(overrides.lifetime != null ? { lifetime: overrides.lifetime } : {}),
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
 * Needs no entry in the leaf's capabilities, so `controlCapabilities()` is unaffected: RFC 9420's
 * capabilities rule binds leaf-node extensions and this one is KeyPackage-only, and neither draft
 * -05 (which this value matches) nor -08 adds an advertisement clause.
 *
 * Draft -08 moved the feature to MLS Component Type `0x00000004` inside `app_data_dictionary`, but
 * `0x000A` is what deployed implementations ship (OpenMLS `main`: `ExtensionType::LastResort => 10`).
 * Anyone migrating must revisit `controlCapabilities()`, because -08 *does* ask clients to advertise
 * `app_data_dictionary` support. See `docs/reference/reserved-namespaces.md`.
 */
export const LAST_RESORT_EXTENSION_TYPE = 0x000a

/**
 * How long a last-resort key package stays valid, in days.
 *
 * ts-mls's own `defaultLifetime()` is ~15 days, which is right for a single-use package but wrong
 * for a standing availability floor: the slot would go full-but-dead a fortnight after upload, and
 * the failure is silent in the worst way — the hub keeps serving the expired package and every Add
 * fails at the *inviter*, who checks the lifetime when building the commit.
 *
 * 90 days sits under the 4-month `maximumTotalLifetime` ts-mls declares (currently unenforced, but
 * designing above a declared ceiling is a bet against a future release).
 *
 * **This is a rotation deadline, not a solution.** A host must re-upload before it elapses, or the
 * floor disappears exactly when it is needed.
 */
export const LAST_RESORT_LIFETIME_DAYS = 90

/** Back-dated a day, as ts-mls's own default is, so peer clock skew cannot invalidate a fresh package. */
function lastResortLifetime(): Lifetime {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return {
    notBefore: BigInt(nowSeconds - 86_400),
    notAfter: BigInt(nowSeconds + LAST_RESORT_LIFETIME_DAYS * 86_400),
  }
}

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
 *
 * **The caller must also re-upload before {@link LAST_RESORT_LIFETIME_DAYS} elapses.** The package
 * carries an MLS lifetime, and an inviter validates it when building the Add — so an unrotated
 * package stops working while the hub still reports the slot as full and keeps serving it. Both
 * obligations fail the same way: silently, and precisely when the floor is needed.
 */
export async function createLastResortKeyPackageBundle(
  identity: OwnIdentity,
  options?: GroupOptions,
): Promise<KeyPackageBundle> {
  return buildBundle(identity, options, {
    // Supplying `extensions` at all suppresses ts-mls's own default of
    // `greaseExtensions(defaultGreaseConfig)`. `defaultGreaseConfig` is not exported, so its 0.1
    // probability is restated here — dropping the spread would silently cost the stack its GREASE.
    extensions: [
      ...greaseExtensions({ probabilityPerGreaseValue: 0.1 }),
      makeCustomExtension({
        extensionType: LAST_RESORT_EXTENSION_TYPE,
        extensionData: new Uint8Array(0),
      }),
    ],
    lifetime: lastResortLifetime(),
  })
}
