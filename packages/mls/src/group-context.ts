import {
  type Capabilities,
  type CiphersuiteName,
  defaultCapabilities,
  type GroupContextExtension,
  getCiphersuiteImpl,
  type MlsContext,
} from 'ts-mls'

import type { GroupAnchor } from './anchor.js'
import { createDIDAuthenticationService, type JudgingContext } from './authentication.js'
import { nobleCryptoProvider } from './crypto.js'
import { denySetOf } from './registry.js'
import type { GroupOptions } from './types.js'

const DEFAULT_CIPHERSUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const

const EMPTY_DENY: ReadonlySet<string> = new Set()

/** Late-bound provider of a context's device deny set, pointed at the live handle after construction. */
export type DeviceDenyHolder = {
  provider: () => ReadonlySet<string>
  judging?: () => JudgingContext
  leafLifetime?: number
  trustedGrantLifetime?: number
}

const DENY_HOLDERS = new WeakMap<MlsContext, DeviceDenyHolder>()

/** The deny holder for an internally built context, or undefined for others. */
export function deviceDenyHolderFor(context: MlsContext): DeviceDenyHolder | undefined {
  return DENY_HOLDERS.get(context)
}

/** Run with an isolated authentication service without changing the source context. */
export async function withJudging<T>(
  context: MlsContext,
  judging: JudgingContext,
  fn: (context: MlsContext) => Promise<T>,
): Promise<T> {
  const holder = deviceDenyHolderFor(context)
  if (holder == null) throw new Error('Missing judging holder')
  const registry = judging.registry
  const scopedHolder: DeviceDenyHolder = {
    ...holder,
    provider: registry == null ? holder.provider : () => denySetOf(registry),
    judging: () => judging,
  }
  const scopedContext = { ...context, authService: authenticationFor(scopedHolder) }
  DENY_HOLDERS.set(scopedContext, scopedHolder)
  return fn(scopedContext)
}

function authenticationFor(holder: DeviceDenyHolder): MlsContext['authService'] {
  return createDIDAuthenticationService({
    deviceDenySet: () => holder.provider(),
    judging: () => holder.judging?.() ?? { stage: 'full', mode: 'admit' },
    mayKeepDeniedIssuer: () => holder.judging?.().mode === 'retain',
    leafLifetime: () => holder.leafLifetime,
    trustedGrantLifetime: () => holder.trustedGrantLifetime,
  })
}

export async function resolveMlsContext(
  options?: GroupOptions,
  anchor?: GroupAnchor,
): Promise<MlsContext> {
  const name = (options?.ciphersuiteName ?? DEFAULT_CIPHERSUITE) as CiphersuiteName
  const cipherSuite = await getCiphersuiteImpl(name, options?.cryptoProvider ?? nobleCryptoProvider)
  return createMlsContext(cipherSuite, anchor)
}

export function createMlsContext(
  cipherSuite: MlsContext['cipherSuite'],
  anchor?: GroupAnchor,
): MlsContext {
  // The deny set cannot be known here — the handle that folds it does not exist yet. Bind a mutable
  // holder the auth service reads; the GroupHandle constructor points it at its own currentDenySet().
  const holder: DeviceDenyHolder = {
    provider: () => EMPTY_DENY,
    leafLifetime: anchor?.controller == null ? undefined : (anchor.leafLifetime ?? 86_400),
    trustedGrantLifetime:
      anchor?.controller == null ? undefined : (anchor.trustedGrantLifetime ?? 2_592_000),
  }
  const authService = authenticationFor(holder)
  const context: MlsContext = { cipherSuite, authService }
  DENY_HOLDERS.set(context, holder)
  return context
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
