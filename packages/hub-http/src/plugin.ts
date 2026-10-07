import type { ServerTransportOptions } from '@enkaku/http-serve'
import type { Server } from '@enkaku/server'
import type { HubProtocol } from '@kumiai/hub-protocol'
import { type CreateHubParams, createHub, type HubClientRegistry } from '@kumiai/hub-server'
import { createHubStoreDefinition, getHubStore, type HubStoreOptions } from '@kumiai/hub-store'
import type { AnyHTTPPlugin, AnyPluginName, PluginName } from '@sozai/http-server'
import { pluginName } from '@sozai/http-server'
import {
  ACCESS_GRANTS,
  ACCESS_REVOCATION,
  type AccessGrants,
  type AccessGrantsPluginParams,
  type AccessRevocation,
  type AccessRevocationPluginParams,
} from '@teikyo/access'
import { buildAccessRules, mountTransport } from '@teikyo/enkaku'
import { HOZON_DB } from '@teikyo/hozon'

export type KumiaiHub = {
  grants?: AccessGrants
  revocation?: AccessRevocation
  registry: HubClientRegistry
  server: Server<HubProtocol>
}

export const KUMIAI_HUB: PluginName<'kumiai:hub', KumiaiHub> = pluginName<KumiaiHub>()('kumiai:hub')

export type HubPluginParams = Omit<CreateHubParams, 'transport' | 'store' | 'verifyToken'> & {
  /** HTTP transport path. Defaults to /hub. */
  path?: string
  store?: HubStoreOptions
  transport?: ServerTransportOptions
  access?: {
    grants?: true | Array<string> | (AccessGrantsPluginParams & { patterns?: Array<string> })
    revocation?: true | AccessRevocationPluginParams
  }
}

export function hubPlugin(params: HubPluginParams): AnyHTTPPlugin {
  const {
    path = '/hub',
    store: storeOptions,
    transport: transportOptions,
    access = {},
    ...hubParams
  } = params
  const gated =
    access.grants === true
      ? ['hub/*']
      : Array.isArray(access.grants)
        ? access.grants
        : (access.grants?.patterns ?? (access.grants == null ? undefined : ['hub/*']))
  if (gated != null) {
    if (gated.length === 0) throw new Error('access.grants must not be empty')
    // Reject overlaps at the factory, before allocating database or transport resources.
    buildAccessRules({ accessRules: hubParams.accessRules, gated, allow: () => false })
  }
  const dependsOn: Array<AnyPluginName> = [HOZON_DB]
  if (gated != null) dependsOn.push(ACCESS_GRANTS)
  if (access.revocation != null) dependsOn.push(ACCESS_REVOCATION)

  return {
    name: KUMIAI_HUB,
    dependsOn,
    async setup(ctx) {
      const db = ctx.use(HOZON_DB)
      db.register(createHubStoreDefinition(storeOptions))
      const store = await getHubStore(db)
      const grants = gated == null ? undefined : ctx.use(ACCESS_GRANTS)
      const revocation = access.revocation == null ? undefined : ctx.use(ACCESS_REVOCATION)
      const accessRules =
        gated == null
          ? hubParams.accessRules
          : buildAccessRules({
              accessRules: hubParams.accessRules,
              gated,
              allow: ctx.use(ACCESS_GRANTS).allow(),
            })
      const verifyToken = revocation?.verifyToken
      const transport = mountTransport<HubProtocol>(ctx, path, transportOptions)
      const hub = createHub({ ...hubParams, store, transport, accessRules, verifyToken })
      let disposing: Promise<void> | undefined
      ctx.onShutdown(async () => {
        disposing = hub.dispose()
        void disposing.catch(() => {})
        await transport.dispose()
      })
      ctx.onClose(
        async () => {
          await (disposing ?? hub.dispose())
        },
        { timeoutMs: params.limits?.cleanupTimeoutMs ?? 30_000 },
      )
      return { registry: hub.registry, server: hub.server, grants, revocation }
    },
  }
}
