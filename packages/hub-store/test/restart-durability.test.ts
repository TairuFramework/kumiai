import { createHash } from 'node:crypto'
import { Client } from '@enkaku/client'
import type { AnyClientMessageOf, AnyServerMessageOf } from '@enkaku/protocol'
import { DirectTransports } from '@enkaku/transport'
import type { HozonDB } from '@hozon/db'
import { type OwnIdentity, randomIdentity } from '@kokuin/token'
import type { HubProtocol, HubStore } from '@kumiai/hub-protocol'
import { createHub, type HubInstance } from '@kumiai/hub-server'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { createHubStoreDefinition, getHubStore } from '../src/index.js'
import { backends } from './databases.js'

const RECEIVE_TIMEOUT_MS = 5000

type HubTransports = DirectTransports<
  AnyServerMessageOf<HubProtocol>,
  AnyClientMessageOf<HubProtocol>
>

type RunningHub = {
  hub: HubInstance
  store: HubStore
  db: HozonDB
  transports: Array<HubTransports>
}

describe.each(backends())('hub restart durability ($name)', (backend) => {
  // Each hub lifetime opens its OWN connection to the database, so the in-memory client registry
  // and the store's connection both reset across a "restart", and only the durable rows survive.
  let open: () => HozonDB
  const running: Array<RunningHub> = []

  beforeEach(async () => {
    open = await backend.createReopenable()
  })

  afterEach(async () => {
    for (const r of running.splice(0)) {
      await stopHub(r)
    }
    await backend.cleanup()
  })

  async function startHub(identity: OwnIdentity): Promise<RunningHub> {
    const db = open()
    db.register(createHubStoreDefinition())
    const store = await getHubStore(db)
    // `createHub` requires a first transport; clients connect through their own.
    const initial: HubTransports = new DirectTransports()
    const hub = createHub({ identity, store, transport: initial.server, purge: false })
    const r: RunningHub = { hub, store, db, transports: [initial] }
    running.push(r)
    return r
  }

  async function stopHub(r: RunningHub): Promise<void> {
    const index = running.indexOf(r)
    if (index !== -1) running.splice(index, 1)
    await r.hub.server.dispose()
    await Promise.all(r.transports.map((transports) => transports.dispose()))
    await r.db.close()
  }

  function connect(r: RunningHub, identity: OwnIdentity, serverID: string): Client<HubProtocol> {
    const transports: HubTransports = new DirectTransports()
    r.transports.push(transports)
    r.hub.server.handle(transports.server)
    return new Client<HubProtocol>({ transport: transports.client, identity, serverID })
  }

  test('offline subscriber receives a post-restart message from a re-subscribed peer', async () => {
    const topicID = createHash('sha256').update('restart-topic').digest('base64url')
    const hubIdentity = randomIdentity()
    const identityA = randomIdentity()
    const identityB = randomIdentity()

    // Lifetime 1: A and B both subscribe to the topic's durable inbox.
    const hub1 = await startHub(hubIdentity)
    const a1 = connect(hub1, identityA, hubIdentity.id)
    const b1 = connect(hub1, identityB, hubIdentity.id)

    expect((await a1.request('hub/v1/subscribe', { param: { topicID } })).subscribed).toBe(true)
    expect((await b1.request('hub/v1/subscribe', { param: { topicID } })).subscribed).toBe(true)

    expect([...(await hub1.store.getSubscribers({ topicID }))].sort()).toEqual(
      [identityA.id, identityB.id].sort(),
    )

    // Restart: tear down lifetime 1 (registry and connection lost), keep the database.
    await stopHub(hub1)

    // Lifetime 2: fresh hub (empty registry) over a reopened store.
    const hub2 = await startHub(hubIdentity)

    // A reconnects and re-subscribes. This must MERGE (upsert), not clobber B's row.
    const a2 = connect(hub2, identityA, hubIdentity.id)
    expect((await a2.request('hub/v1/subscribe', { param: { topicID } })).subscribed).toBe(true)

    // B never reconnected during this sequence, yet its subscription survives.
    expect(await hub2.store.getSubscribers({ topicID })).toContain(identityB.id)

    // A publishes to the topic while B is still offline.
    const payload = btoa('post-restart-message')
    const publishResult = await a2.request('hub/v1/publish', { param: { topicID, payload } })
    expect(typeof publishResult.sequenceID).toBe('string')

    // Lifetime 3: a further restart before B returns, so the pending delivery must come from the
    // database rather than from anything the publishing hub held.
    await stopHub(hub2)
    const hub3 = await startHub(hubIdentity)

    // B comes online and drains its mailbox.
    const b3 = connect(hub3, identityB, hubIdentity.id)
    const channel = b3.createChannel('hub/v1/receive', { param: {} })
    void channel.catch(() => {})
    const reader = channel.readable.getReader()

    let timer: ReturnType<typeof setTimeout> | undefined
    const raceResult = await Promise.race([
      reader.read(),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), RECEIVE_TIMEOUT_MS)
      }),
    ])
    clearTimeout(timer)
    reader.releaseLock()

    if (raceResult === 'timeout' || raceResult.done) {
      throw new Error('offline subscriber did not receive the post-restart message within timeout')
    }
    const received = raceResult.value
    expect(received.payload).toBe(payload)
    expect(received.senderDID).toBe(identityA.id)
    expect(received.topicID).toBe(topicID)
    channel.close()
  }, 20000)

  test('a re-subscribe after restart does not wipe an offline subscriber row', async () => {
    const topicID = createHash('sha256').update('merge-topic').digest('base64url')
    const hubIdentity = randomIdentity()
    const identityA = randomIdentity()
    const identityB = randomIdentity()

    const hub1 = await startHub(hubIdentity)
    const a1 = connect(hub1, identityA, hubIdentity.id)
    const b1 = connect(hub1, identityB, hubIdentity.id)

    await a1.request('hub/v1/subscribe', { param: { topicID } })
    await b1.request('hub/v1/subscribe', { param: { topicID } })

    await stopHub(hub1)

    const hub2 = await startHub(hubIdentity)
    const a2 = connect(hub2, identityA, hubIdentity.id)
    await a2.request('hub/v1/subscribe', { param: { topicID } })

    expect([...(await hub2.store.getSubscribers({ topicID }))].sort()).toEqual(
      [identityA.id, identityB.id].sort(),
    )
  }, 20000)
})
