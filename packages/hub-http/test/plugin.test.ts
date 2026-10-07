import { Client } from '@enkaku/client'
import { ClientTransport } from '@enkaku/http-fetch'
import { createCapability, createRevocationRecord } from '@kokuin/capability'
import { randomIdentity, stringifyToken } from '@kokuin/token'
import type { HubProtocol } from '@kumiai/hub-protocol'
import { createServer, definePlugin, pluginName } from '@sozai/http-server'
import {
  ACCESS_GRANTS,
  ACCESS_REVOCATION,
  accessGrantsPlugin,
  accessRevocationPlugin,
} from '@teikyo/access'
import { hozonDBPlugin } from '@teikyo/hozon'
import { afterEach, describe, expect, test } from 'vitest'

import { hubPlugin, KUMIAI_HUB } from '../src/plugin.js'
import { createHubServer } from '../src/server.js'

const TOPIC = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'
const PAYLOAD = 'aGVsbG8='
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function start(params: Parameters<typeof createHubServer>[0]) {
  const server = await createHubServer({ port: 0, hostname: '127.0.0.1', ...params })
  cleanups.push(() => server.dispose())
  await server.listen()
  return server
}

function connect(url: string, serverID: string) {
  const identity = randomIdentity()
  const transport = new ClientTransport<HubProtocol>({ url: `${url}/hub` })
  const client = new Client<HubProtocol>({ transport, identity, serverID })
  cleanups.push(async () => {
    await client.dispose()
    await transport.dispose()
  })
  return { client, identity }
}

describe('hub HTTP server', () => {
  test('publishes and fetches over HTTP', async () => {
    const identity = randomIdentity()
    const server = await start({ db: ':memory:', identity })
    const { client } = connect(server.url, identity.id)
    await client.request('hub/v1/subscribe', { param: { topicID: TOPIC } })
    const published = await client.request('hub/v1/publish', {
      param: { topicID: TOPIC, payload: PAYLOAD, retain: 'log' },
    })
    const fetched = await client.request('hub/v1/topic/fetch', { param: { topicID: TOPIC } })
    expect(fetched.messages).toMatchObject([{ sequenceID: published.sequenceID, payload: PAYLOAD }])
  })

  test('readiness reflects the database', async () => {
    const server = await start({ db: ':memory:', identity: randomIdentity() })
    const response = await fetch(`${server.url}/health/ready`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ checks: { 'hozon:db': true } })
  })

  test('denies clients without grants and allows them after a grant', async () => {
    const identity = randomIdentity()
    let grant: (() => Promise<unknown>) | undefined
    const probe = definePlugin({
      name: pluginName<void>()('test:grants'),
      dependsOn: [ACCESS_GRANTS],
      setup(ctx) {
        const { store } = ctx.use(ACCESS_GRANTS)
        grant = () => store.grant({ subject: caller.id, pattern: 'hub/*', createdBy: identity.id })
      },
    })
    const caller = randomIdentity()
    const server = await createServer({
      port: 0,
      hostname: '127.0.0.1',
      plugins: [
        hozonDBPlugin({ db: ':memory:' }),
        accessGrantsPlugin(),
        hubPlugin({ identity, access: { grants: true } }),
        probe,
      ],
    })
    cleanups.push(() => server.dispose())
    await server.listen()
    const transport = new ClientTransport<HubProtocol>({ url: `${server.url}/hub` })
    const client = new Client<HubProtocol>({ transport, identity: caller, serverID: identity.id })
    cleanups.push(async () => {
      await client.dispose()
      await transport.dispose()
    })
    await expect(client.request('hub/v1/subscribe', { param: { topicID: TOPIC } })).rejects.toThrow(
      'Access denied',
    )
    if (grant == null) throw new Error('grant store unavailable')
    await grant()
    await expect(
      client.request('hub/v1/subscribe', { param: { topicID: TOPIC } }),
    ).resolves.toEqual({ subscribed: true })
  })

  test('denies a revoked delegated capability', async () => {
    const identity = randomIdentity()
    const caller = randomIdentity()
    const jti = crypto.randomUUID()
    const capability = await createCapability(identity, {
      sub: identity.id,
      aud: caller.id,
      act: '*',
      res: '*',
      jti,
    })
    const record = await createRevocationRecord(identity, jti)
    let revoke: (() => Promise<void>) | undefined
    const probe = definePlugin({
      name: pluginName<void>()('test:revocation'),
      dependsOn: [ACCESS_REVOCATION],
      setup(ctx) {
        const { backend } = ctx.use(ACCESS_REVOCATION)
        revoke = () => backend.add(record)
      },
    })
    const server = await createServer({
      port: 0,
      hostname: '127.0.0.1',
      plugins: [
        hozonDBPlugin({ db: ':memory:' }),
        accessRevocationPlugin(),
        hubPlugin({ identity, access: { revocation: true } }),
        probe,
      ],
    })
    cleanups.push(() => server.dispose())
    await server.listen()
    const transport = new ClientTransport<HubProtocol>({ url: `${server.url}/hub` })
    cleanups.push(() => transport.dispose())
    async function subscribe(rid: string) {
      const message = await caller.signToken({
        typ: 'request',
        prc: 'hub/v1/subscribe',
        rid,
        prm: { topicID: TOPIC },
        aud: identity.id,
        sub: identity.id,
        cap: stringifyToken(capability),
        iat: Math.floor(Date.now() / 1000),
      } as const)
      await transport.write(message)
      return (await transport.read()).value?.payload
    }
    expect(await subscribe('before')).toMatchObject({
      typ: 'result',
      val: { subscribed: true },
    })
    if (revoke == null) throw new Error('revocation backend unavailable')
    await revoke()
    expect(await subscribe('after')).toMatchObject({
      typ: 'error',
      msg: expect.stringMatching(/revoked/i),
    })
  })

  test('createHubServer composes grant and revocation plugins', async () => {
    const identity = randomIdentity()
    const server = await start({
      db: ':memory:',
      identity,
      access: { grants: true, revocation: true },
    })
    const { client } = connect(server.url, identity.id)
    await expect(client.request('hub/v1/subscribe', { param: { topicID: TOPIC } })).rejects.toThrow(
      'Access denied',
    )
    const caller = randomIdentity()
    const capability = await createCapability(identity, {
      sub: identity.id,
      aud: caller.id,
      act: '*',
      res: '*',
    })
    const transport = new ClientTransport<HubProtocol>({ url: `${server.url}/hub` })
    cleanups.push(() => transport.dispose())
    await transport.write(
      await caller.signToken({
        typ: 'request',
        prc: 'hub/v1/subscribe',
        rid: 'missing-jti',
        prm: { topicID: TOPIC },
        aud: identity.id,
        sub: identity.id,
        cap: stringifyToken(capability),
        iat: Math.floor(Date.now() / 1000),
      } as const),
    )
    expect((await transport.read()).value?.payload).toMatchObject({
      typ: 'error',
      msg: expect.stringContaining('without jti'),
    })
  })

  test('supports a custom path and configurable HTTP rate limiting', async () => {
    const identity = randomIdentity()
    const server = await start({
      db: ':memory:',
      identity,
      path: '/custom-hub',
      rateLimit: { windowMs: 60_000, limit: 1 },
    })
    const transport = new ClientTransport<HubProtocol>({ url: `${server.url}/custom-hub` })
    const client = new Client<HubProtocol>({
      transport,
      identity: randomIdentity(),
      serverID: identity.id,
    })
    cleanups.push(async () => {
      await client.dispose()
      await transport.dispose()
    })
    await expect(
      client.request('hub/v1/subscribe', { param: { topicID: TOPIC } }),
    ).resolves.toEqual({ subscribed: true })
    const limited = await fetch(`${server.url}/custom-hub`, { method: 'POST' })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('Retry-After')).not.toBeNull()
    expect((await fetch(`${server.url}/health/ready`)).status).toBe(200)
  })

  test('disables HTTP rate limiting when false', async () => {
    const server = await start({ db: ':memory:', identity: randomIdentity(), rateLimit: false })
    const response = await fetch(`${server.url}/missing`)
    expect(response.status).toBe(404)
    expect(response.headers.get('RateLimit')).toBeNull()
  })

  test('rejects caller access rules overlapping the gated hub patterns', async () => {
    await expect(
      createHubServer({
        db: ':memory:',
        identity: randomIdentity(),
        access: { grants: true },
        accessRules: { 'hub/v1/publish': { allow: true } },
      }),
    ).rejects.toThrow(/overlaps/)
  })

  test('shuts down gracefully with subscribed clients', async () => {
    const identity = randomIdentity()
    let disposed: Promise<void> | undefined
    let completed = false
    const probe = definePlugin({
      name: pluginName<void>()('test:hub'),
      dependsOn: [KUMIAI_HUB],
      setup(ctx) {
        disposed = ctx.use(KUMIAI_HUB).server.disposed.then(() => {
          completed = true
        })
      },
    })
    const server = await createServer({
      port: 0,
      hostname: '127.0.0.1',
      graceMs: 1_000,
      plugins: [hozonDBPlugin({ db: ':memory:' }), hubPlugin({ identity }), probe],
    })
    cleanups.push(() => server.dispose())
    await server.listen()
    const { client } = connect(server.url, identity.id)
    await client.request('hub/v1/subscribe', { param: { topicID: TOPIC } })
    const channel = client.createChannel('hub/v1/receive', { param: {} })
    void channel.catch(() => {})
    const reader = channel.readable.getReader()
    const { client: publisher } = connect(server.url, identity.id)
    await publisher.request('hub/v1/publish', { param: { topicID: TOPIC, payload: PAYLOAD } })
    expect((await reader.read()).value?.payload).toBe(PAYLOAD)
    await server.dispose()
    expect(completed).toBe(true)
    await disposed
    expect(server.shutdownReport?.forced).toBe(false)
    expect(server.shutdownReport?.hooks).toContainEqual({
      plugin: 'kumiai:hub',
      phase: 'close',
      outcome: 'completed',
    })
  })
})
