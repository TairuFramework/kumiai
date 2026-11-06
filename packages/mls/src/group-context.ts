import type { CryptoOptions } from '@kokuin/token'
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
 *   keys no frame will ever claim; the remaining 192 generations cover a cross-lane backlog.
 *   The window counts generations, not frames: in a group of three or more, a sender's
 *   frames to the other peers are generations this receiver skips and never claims, so they
 *   both fill the window and shorten the backlog it covers (one frame in `members - 1` is
 *   this receiver's). Each retained key is one 32-byte secret, about 37 bytes encoded.
 * - `retainKeysForEpochs: 1` — the current epoch's tree and one past epoch's. A backlog
 *   sealed before the last commit is rare, and in a group of three or more every retained
 *   tree holds a full window per sender at steady state. Measured persisted receiver state
 *   at steady state: 2 members 2.6 KB, 3 members 42 KB, 5 members 82 KB, 10 members 181 KB
 *   (with ts-mls's four past epochs: 5.8, 103, 202 and 449 KB). That state is persisted on
 *   each receive advance, and ts-mls re-sorts a full window on every ratchet step.
 * - `maximumForwardRatchetSteps: 512` — at least the retention, so the single newer frame
 *   that jumps past a full backlog still opens rather than being refused as too far ahead.
 *   A step is one KDF expansion, so the bound on a forged generation stays cheap.
 */
export const KUMIAI_KEY_RETENTION_CONFIG: Readonly<KeyRetentionConfig> = Object.freeze({
  retainKeysForGenerations: 256,
  retainKeysForEpochs: 1,
  maximumForwardRatchetSteps: 512,
})

/** A context's client config, with kumiai's key retention when none is given. */
export function kumiaiClientConfig(): ClientConfig {
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
export type DeviceDenyHolder = CryptoOptions & {
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
    get crypto() {
      return holder.crypto
    },
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
  return createMlsContext(cipherSuite, anchor, undefined, options)
}

export function createMlsContext(
  cipherSuite: MlsContext['cipherSuite'],
  anchor?: GroupAnchor,
  clientConfig?: ClientConfig,
  options?: CryptoOptions,
): MlsContext {
  // The deny set cannot be known here — the handle that folds it does not exist yet. Bind a mutable
  // holder the auth service reads; the GroupHandle constructor points it at its own currentDenySet().
  const holder: DeviceDenyHolder = {
    crypto: options?.crypto,
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
