import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@enkaku/client'
import { ClientTransport } from '@enkaku/http-fetch'
import { HozonDB } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { PostgresAdapter } from '@hozon/postgres'
import { randomIdentity } from '@kokuin/token'
import { createHubServer } from '@kumiai/hub-http'
import type { HubProtocol } from '@kumiai/hub-protocol'
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest'

const TOPIC_ID = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'
const PAYLOAD = 'aGVsbG8='

declare module 'vitest' {
  // biome-ignore lint/style/useConsistentTypeDefinitions: module augmentation needs an interface.
  interface ProvidedContext {
    postgresURL: string | null
  }
}

type Backend = {
  name: 'node-sqlite' | 'postgres'
  createReopenable: () => Promise<() => HozonDB>
  cleanup: () => Promise<void>
}

function backends(): Array<Backend> {
  const opened: Array<HozonDB> = []
  const directories: Array<string> = []
  const track = (db: HozonDB) => {
    opened.push(db)
    return db
  }
  const sqlite: Backend = {
    name: 'node-sqlite',
    async createReopenable() {
      const directory = await mkdtemp(join(tmpdir(), 'kumiai-hub-http-'))
      directories.push(directory)
      const database = join(directory, 'hub.db')
      return () => track(new HozonDB({ adapter: new NodeSQLiteAdapter({ database }) }))
    },
    async cleanup() {
      await Promise.all(opened.splice(0).map((db) => db.close()))
      await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
      )
    },
  }
  const url = inject('postgresURL')
  if (url == null) return [sqlite]
  const postgres: Backend = {
    name: 'postgres',
    async createReopenable() {
      const tablePrefix = `t${randomUUID().replaceAll('-', '').slice(0, 30)}`
      return () =>
        track(
          new HozonDB({
            adapter: new PostgresAdapter({ url, options: { onnotice: () => {} } }),
            tablePrefix,
          }),
        )
    },
    async cleanup() {
      await Promise.all(opened.splice(0).map((db) => db.close()))
    },
  }
  return [sqlite, postgres]
}

type RunningServer = {
  server: Awaited<ReturnType<typeof createHubServer>>
}

type ConnectedClient = {
  client: Client<HubProtocol>
  transport: ClientTransport<HubProtocol>
}

const availableBackends = backends()
const postgresBackend = availableBackends.find(({ name }) => name === 'postgres')

describe.each(availableBackends)('hub HTTP deployment ($name)', (backend) => {
  const running: Array<RunningServer> = []
  const clients: Array<ConnectedClient> = []
  let open: () => HozonDB

  beforeEach(async () => {
    open = await backend.createReopenable()
  })

  afterEach(async () => {
    for (const { server } of running.splice(0).reverse()) await server.dispose()
    for (const { client, transport } of clients.splice(0).reverse()) {
      await client.dispose()
      await transport.dispose()
    }
    await backend.cleanup()
  })

  async function start(db: HozonDB, identity = randomIdentity()) {
    const server = await createHubServer({
      db,
      identity,
      port: 0,
      hostname: '127.0.0.1',
      purge: false,
    })
    running.push({ server })
    await server.listen()
    return { server, identity }
  }

  function connect(
    url: string,
    serverID: string,
    identity = randomIdentity(),
  ): Client<HubProtocol> {
    const transport = new ClientTransport<HubProtocol>({ url: `${url}/hub` })
    const client = new Client<HubProtocol>({
      transport,
      identity,
      serverID,
    })
    clients.push({ client, transport })
    return client
  }

  async function fetchMessage(client: Client<HubProtocol>) {
    const fetched = await client.request('hub/v1/topic/fetch', { param: { topicID: TOPIC_ID } })
    return fetched.messages.find((message) => message.payload === PAYLOAD)
  }

  test('messages survive a server restart', async () => {
    const db1 = open()
    const { server: server1, identity } = await start(db1)
    const sender = connect(server1.url, identity.id)
    const recipientIdentity = randomIdentity()
    const recipient = connect(server1.url, identity.id, recipientIdentity)
    await sender.request('hub/v1/subscribe', { param: { topicID: TOPIC_ID } })
    await recipient.request('hub/v1/subscribe', { param: { topicID: TOPIC_ID } })
    await sender.request('hub/v1/publish', {
      param: { topicID: TOPIC_ID, payload: PAYLOAD, retain: 'log' },
    })

    await server1.dispose()
    const db2 = open()
    const { server: server2 } = await start(db2, identity)
    const reconnectedRecipient = connect(server2.url, identity.id, recipientIdentity)
    await reconnectedRecipient.request('hub/v1/subscribe', { param: { topicID: TOPIC_ID } })
    await expect(fetchMessage(reconnectedRecipient)).resolves.toMatchObject({ payload: PAYLOAD })
  })

  test('reconnects fail fast during shutdown', async () => {
    const db = open()
    const { server, identity } = await start(db)
    const client = connect(server.url, identity.id)
    const disposal = server.dispose()
    const request = client.request('hub/v1/subscribe', { param: { topicID: TOPIC_ID } })
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      request.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      ),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), 1000)
      }),
    ])
    clearTimeout(timer)
    expect(outcome).toBe('rejected')
    await disposal
  })
})

describe.skipIf(postgresBackend == null)('hub HTTP deployment (postgres)', () => {
  const running: Array<Awaited<ReturnType<typeof createHubServer>>> = []
  const clients: Array<ConnectedClient> = []

  afterEach(async () => {
    for (const server of running.splice(0).reverse()) await server.dispose()
    for (const { client, transport } of clients.splice(0).reverse()) {
      await client.dispose()
      await transport.dispose()
    }
    await postgresBackend?.cleanup()
  })

  test('two servers share one Postgres database', async () => {
    const backend = postgresBackend
    if (backend == null) throw new Error('Postgres backend unavailable')
    const open = await backend.createReopenable()
    const dbA = open()
    const identity = randomIdentity()
    const serverA = await createHubServer({
      db: dbA,
      identity,
      port: 0,
      hostname: '127.0.0.1',
      purge: false,
    })
    running.push(serverA)
    await serverA.listen()
    const dbB = open()
    const serverB = await createHubServer({
      db: dbB,
      identity,
      port: 0,
      hostname: '127.0.0.1',
      purge: false,
    })
    running.push(serverB)
    await serverB.listen()
    const transportA = new ClientTransport<HubProtocol>({ url: `${serverA.url}/hub` })
    const clientA = new Client<HubProtocol>({
      transport: transportA,
      identity: randomIdentity(),
      serverID: identity.id,
    })
    clients.push({ client: clientA, transport: transportA })
    const transportB = new ClientTransport<HubProtocol>({ url: `${serverB.url}/hub` })
    const clientB = new Client<HubProtocol>({
      transport: transportB,
      identity: randomIdentity(),
      serverID: identity.id,
    })
    clients.push({ client: clientB, transport: transportB })
    await clientB.request('hub/v1/subscribe', { param: { topicID: TOPIC_ID } })
    await clientA.request('hub/v1/subscribe', { param: { topicID: TOPIC_ID } })
    await clientA.request('hub/v1/publish', {
      param: { topicID: TOPIC_ID, payload: PAYLOAD, retain: 'log' },
    })
    const fetched = await clientB.request('hub/v1/topic/fetch', { param: { topicID: TOPIC_ID } })
    expect(fetched.messages).toMatchObject([{ payload: PAYLOAD }])
  })
})
