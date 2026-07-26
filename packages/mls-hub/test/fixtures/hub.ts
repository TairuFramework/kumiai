import { Client } from '@enkaku/client'
import type { AnyClientMessageOf, AnyServerMessageOf } from '@enkaku/protocol'
import { DirectTransports } from '@enkaku/transport'
import { type OwnIdentity, randomIdentity } from '@kokuin/token'
import { HubClient } from '@kumiai/hub-client'
import type { HubProtocol } from '@kumiai/hub-protocol'
import { createHub, createMemoryStore } from '@kumiai/hub-server'

type HubTransports = DirectTransports<
  AnyServerMessageOf<HubProtocol>,
  AnyClientMessageOf<HubProtocol>
>

export type TestHub = {
  client: HubClient
  identity: OwnIdentity
  /** The hub's own store, for asserting what actually reached the slot. */
  hubStore: ReturnType<typeof createMemoryStore>
  dispose: () => Promise<void>
}

/** A real hub over in-process transports, plus one authenticated client for `identity`. */
export function createTestHub(identity: OwnIdentity = randomIdentity()): TestHub {
  const hubStore = createMemoryStore()
  const hubIdentity = randomIdentity()
  const serverTransports: HubTransports = new DirectTransports()
  const hub = createHub({
    transport: serverTransports.server,
    store: hubStore,
    identity: hubIdentity,
  })

  const clientTransports: HubTransports = new DirectTransports()
  hub.server.handle(clientTransports.server)
  const client = new HubClient({
    client: new Client<HubProtocol>({
      transport: clientTransports.client,
      identity,
      serverID: hubIdentity.id,
    }),
  })

  return {
    client,
    identity,
    hubStore,
    dispose: async () => {
      await clientTransports.dispose()
      await serverTransports.dispose()
    },
  }
}
