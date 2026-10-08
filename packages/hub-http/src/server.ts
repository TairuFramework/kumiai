import type { HozonDBInput } from '@hozon/provider'
import type { AnyHTTPPlugin, CreateServerParams, HTTPServer } from '@sozai/http-server'
import { createServer, definePlugin, pluginName } from '@sozai/http-server'
import { accessGrantsPlugin, accessRevocationPlugin } from '@teikyo/access'
import { hozonDBPlugin } from '@teikyo/hozon'
import { rateLimitPlugin } from '@teikyo/rate-limit'

import { type HubPluginParams, hubPlugin, KUMIAI_HUB, type KumiaiHub } from './plugin.js'

export type CreateHubServerParams = HubPluginParams & {
  db: HozonDBInput
  tablePrefix?: string
  /** Per-IP HTTP rate limit. Defaults to 600 requests per minute. */
  rateLimit?: { windowMs: number; limit: number } | false
} & Omit<CreateServerParams, 'plugins'>

export async function createHubServer(
  params: CreateHubServerParams,
): Promise<HTTPServer & { hub: KumiaiHub }> {
  const {
    db,
    tablePrefix,
    rateLimit = { windowMs: 60_000, limit: 600 },
    port,
    hostname,
    trustProxy,
    limits,
    health,
    graceMs,
    closeHookTimeoutMs,
    logger,
    tracer,
    signal,
    ...hubParams
  } = params
  const { bodyBytes, requestTimeoutMs, ...hubLimits } = limits ?? {}
  // Validate the hub options before createServer starts setting up plugins.
  const hub = hubPlugin({ ...hubParams, limits: limits == null ? undefined : hubLimits })
  const plugins: Array<AnyHTTPPlugin> = [hozonDBPlugin({ db, tablePrefix })]
  if (params.access?.grants != null)
    plugins.push(
      accessGrantsPlugin(
        typeof params.access.grants === 'object' && !Array.isArray(params.access.grants)
          ? params.access.grants
          : undefined,
      ),
    )
  if (params.access?.revocation != null)
    plugins.push(
      accessRevocationPlugin(
        params.access.revocation === true ? undefined : params.access.revocation,
      ),
    )
  if (rateLimit !== false) plugins.push(rateLimitPlugin(rateLimit))
  plugins.push(hub)
  let value: KumiaiHub | undefined
  plugins.push(
    definePlugin({
      name: pluginName<void>()('kumiai:hub-handle'),
      dependsOn: [KUMIAI_HUB],
      setup(ctx) {
        value = ctx.use(KUMIAI_HUB)
      },
    }),
  )
  const server = await createServer({
    port,
    hostname,
    trustProxy,
    limits: limits == null ? undefined : { bodyBytes, requestTimeoutMs },
    health,
    graceMs,
    closeHookTimeoutMs,
    logger,
    tracer,
    signal,
    plugins,
  })
  if (value == null) throw new Error('Hub plugin did not initialise')
  return Object.assign(server, { hub: value })
}
