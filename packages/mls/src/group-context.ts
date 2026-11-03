import {
  type Capabilities,
  type CiphersuiteName,
  type ClientConfig,
  defaultCapabilities,
  defaultKeyPackageEqualityConfig,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  type GroupContextExtension,
  getCiphersuiteImpl,
  type KeyRetentionConfig,
  type MlsContext,
} from 'ts-mls'

import type { GroupAnchor } from './anchor.js'
import { createDIDAuthenticationService, type JudgingContext } from './authentication.js'
import { nobleCryptoProvider } from './crypto.js'
import { denySetOf } from './registry.js'
import type { GroupOptions } from './types.js'

const DEFAULT_CIPHERSUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const

const EMPTY_DENY: ReadonlySet<string> = new Set()

/**
 * The receive-side key retention every kumiai context carries, in place of ts-mls's
 * defaults (10 skipped keys, a 200-generation forward window).
 *
 * A member has ONE application sender ratchet per epoch, and a host can spend it across
 * several lanes a receiver drains independently (tunnel topics, a service lane, an app
 * log). After a reconnect one lane can hold a backlog of hundreds of frames while a single
 * newer frame on another lane opens first and moves the receiver's ratchet past them. Every
 * backlog frame whose skipped key was not retained can then never be opened: ts-mls throws
 * `Desired gen in the past`.
 *
 * - `retainKeysForGenerations: 256` — a sender that restores a persisted state advances
 *   past a lease of up to 64 generations it may have spent, which leaves that many skipped
 *   keys no frame will ever claim; the remaining 192 cover a cross-lane backlog. Each
 *   retained key is one 32-byte secret (about 37 bytes encoded with its generation), so a
 *   full window costs about 9.5 KiB per sender per retained epoch in persisted state; an
 *   in-order receiver holds none.
 * - `maximumForwardRatchetSteps: 512` — at least the retention, so the single newer frame
 *   that jumps past a full backlog still opens rather than being refused as too far ahead.
 *   A step is one KDF expansion, so the bound on a forged generation stays cheap.
 * - `retainKeysForEpochs` keeps the ts-mls default.
 */
export const KUMIAI_KEY_RETENTION_CONFIG: Readonly<KeyRetentionConfig> = Object.freeze({
  retainKeysForGenerations: 256,
  retainKeysForEpochs: 4,
  maximumForwardRatchetSteps: 512,
})

/** A context's client config, with kumiai's key retention when none is given. */
function kumiaiClientConfig(): ClientConfig {
  return {
    keyRetentionConfig: { ...KUMIAI_KEY_RETENTION_CONFIG },
    lifetimeConfig: { ...defaultLifetimeConfig },
    paddingConfig: structuredClone(defaultPaddingConfig),
    keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
  }
}

/** Copy a client config without sharing its mutable parts with the source context. */
export function copyClientConfig(config: ClientConfig): ClientConfig {
  const equality = config.keyPackageEqualityConfig
  return {
    keyRetentionConfig: structuredClone(config.keyRetentionConfig),
    lifetimeConfig: structuredClone(config.lifetimeConfig),
    paddingConfig: structuredClone(config.paddingConfig),
    keyPackageEqualityConfig: {
      compareKeyPackages: equality.compareKeyPackages.bind(equality),
      compareKeyPackageToLeafNode: equality.compareKeyPackageToLeafNode.bind(equality),
    },
  }
}

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
  clientConfig?: ClientConfig,
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
  const context: MlsContext = {
    cipherSuite,
    authService,
    clientConfig: clientConfig == null ? kumiaiClientConfig() : copyClientConfig(clientConfig),
  }
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
