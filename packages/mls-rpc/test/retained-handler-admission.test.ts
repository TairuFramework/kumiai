import { createGroupPeer, type GroupPeer } from '@kumiai/rpc'
import { expect, test } from 'vitest'

import { createGroupCrypto } from '../src/crypto.js'
import { createTestCompletion } from './fixtures/real-group.js'
import { createRegistryFixture } from './fixtures/registry.js'

test.each(['real-mls', 'double'] as const)(
  'retained handlers require atomic pending storage at construction (%s)',
  async (mode) => {
    const groupID = crypto.randomUUID()
    const fixture = await createRegistryFixture({
      mode,
      groupID,
      setup: 'seeded',
      backgroundMaintenance: 'gated',
    })
    try {
      const access = await fixture.registry.access(groupID)
      const cryptoPort = createGroupCrypto({ access })
      for (const policy of ['legacy', 'at-least-once', 'transactional'] as const) {
        let peer: Pick<GroupPeer<Record<string, never>>, 'dispose'> | undefined
        const handle = async () => {}
        try {
          expect(() => {
            peer = createGroupPeer({
              completion: createTestCompletion(access.key),
              crypto: { ...cryptoPort, pending: undefined },
              hub: {
                publish: async () => {
                  throw new Error('No network')
                },
              } as never,
              localDID: fixture.identity.id,
              protocols: { chat: { posted: { type: 'event', retain: 'log' } } },
              handlers: {
                chat: { posted: policy === 'legacy' ? handle : { mode: policy, handle } },
              },
            })
          }).toThrow('Retained handlers require atomic pending storage')
        } finally {
          await peer?.dispose()
        }
      }
    } finally {
      await fixture.close()
    }
  },
)
