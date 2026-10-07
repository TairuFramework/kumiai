import type { HozonDBInput } from '@hozon/provider'
import type { AnyHTTPPlugin, CreateServerParams, HTTPServer } from '@sozai/http-server'
import { createServer } from '@sozai/http-server'
import { accessGrantsPlugin, accessRevocationPlugin } from '@teikyo/access'
import { hozonDBPlugin } from '@teikyo/hozon'
import { rateLimitPlugin } from '@teikyo/rate-limit'

import { type HubPluginParams, hubPlugin } from './plugin.js'

export type CreateHubServerParams = HubPluginParams & {
  db: HozonDBInput
  /** Per-IP HTTP rate limit. Defaults to 600 requests per minute. */
  rateLimit?: { windowMs: number; limit: number } | false
} & Omit<CreateServerParams, 'plugins'>

export function createHubServer(params: CreateHubServerParams): Promise<HTTPServer> {
  const { db, rateLimit = { windowMs: 60_000, limit: 600 }, ...serverParams } = params
  // Validate the hub options before createServer starts setting up plugins.
  const hub = hubPlugin(params)
  const plugins: Array<AnyHTTPPlugin> = [hozonDBPlugin({ db })]
  if (params.access?.grants != null) plugins.push(accessGrantsPlugin())
  if (params.access?.revocation != null) plugins.push(accessRevocationPlugin())
  if (rateLimit !== false) plugins.push(rateLimitPlugin(rateLimit))
  plugins.push(hub)
  return createServer({ ...serverParams, plugins })
}
