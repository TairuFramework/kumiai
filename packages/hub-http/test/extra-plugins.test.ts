import { Client } from '@enkaku/client'
import { ClientTransport } from '@enkaku/http-fetch'
import { randomIdentity } from '@kokuin/token'
import type { HubProtocol } from '@kumiai/hub-protocol'
import { getHubStore } from '@kumiai/hub-store'
import { definePlugin, pluginName } from '@sozai/http-server'
import { HOZON_DB } from '@teikyo/hozon'
import { afterEach, expect, test } from 'vitest'

import { KUMIAI_HUB } from '../src/plugin.js'
import { createHubServer } from '../src/server.js'

const TOPIC = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

test('serves an extra plugin route beside the hub without listening', async () => {
  const server = await createHubServer({
    db: ':memory:',
    identity: randomIdentity(),
    plugins: [
      definePlugin({
        name: pluginName<void>()('test:info'),
        setup(ctx) {
          ctx.route('get', '/info', (c) => c.json({ service: 'hub' }))
        },
      }),
    ],
  })
  cleanups.push(() => server.dispose())
  const response = await server.app.fetch(new Request('http://localhost/info'))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ service: 'hub' })
  const hub = await server.app.fetch(new Request('http://localhost/hub', { method: 'OPTIONS' }))
  expect(hub.status).toBe(204)
})

test('an extra plugin reads HTTP publications from the hub database store', async () => {
  const identity = randomIdentity()
  const caller = randomIdentity()
  const server = await createHubServer({
    db: ':memory:',
    identity,
    plugins: [
      definePlugin({
        name: pluginName<void>()('test:store'),
        dependsOn: [KUMIAI_HUB, HOZON_DB],
        async setup(ctx) {
          ctx.use(KUMIAI_HUB)
          const store = await getHubStore(ctx.use(HOZON_DB))
          ctx.route('get', '/info', async (c) => {
            const result = await store.fetchTopic({ topicID: TOPIC, subscriberDID: caller.id })
            return c.json(result)
          })
        },
      }),
    ],
  })
  cleanups.push(() => server.dispose())
  const transport = new ClientTransport<HubProtocol>({
    url: 'http://localhost/hub',
    fetch: async (input, init) => server.app.fetch(new Request(input, init)),
  })
  const client = new Client<HubProtocol>({ transport, identity: caller, serverID: identity.id })
  cleanups.push(async () => {
    await client.dispose()
    await transport.dispose()
  })
  await client.request('hub/v1/subscribe', { param: { topicID: TOPIC } })
  const published = await client.request('hub/v1/publish', {
    param: { topicID: TOPIC, payload: 'aGVsbG8=', retain: 'log' },
  })
  const response = await server.app.fetch(new Request('http://localhost/info'))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    head: published.sequenceID,
    messages: [{ sequenceID: published.sequenceID, senderDID: caller.id, topicID: TOPIC }],
  })
})

test('disposes extra plugins through their close hooks', async () => {
  let closed = false
  const server = await createHubServer({
    db: ':memory:',
    identity: randomIdentity(),
    plugins: [
      definePlugin({
        name: pluginName<void>()('test:close'),
        setup(ctx) {
          ctx.onClose(() => {
            closed = true
          })
        },
      }),
    ],
  })
  cleanups.push(() => server.dispose())
  expect(closed).toBe(false)
  await server.dispose()
  expect(closed).toBe(true)
})

test('preserves transport CORS preflight with extra plugins at a custom hub path', async () => {
  let setup = false
  const server = await createHubServer({
    db: ':memory:',
    identity: randomIdentity(),
    path: '/custom-hub',
    transport: { allowedOrigin: 'https://client.example' },
    plugins: [
      definePlugin({
        name: pluginName<void>()('test:cors'),
        setup(ctx) {
          setup = true
          ctx.route('get', '/info', (c) => c.json({ service: 'hub' }))
        },
      }),
    ],
  })
  cleanups.push(() => server.dispose())
  expect(setup).toBe(true)
  const response = await server.app.fetch(
    new Request('http://localhost/custom-hub', {
      method: 'OPTIONS',
      headers: { Origin: 'https://client.example', 'Access-Control-Request-Method': 'POST' },
    }),
  )
  expect(response.status).toBe(204)
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://client.example')
})
