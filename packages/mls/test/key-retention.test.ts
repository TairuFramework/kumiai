import { randomIdentity } from '@kokuin/token'
import {
  type ClientConfig,
  defaultKeyPackageEqualityConfig,
  defaultKeyRetentionConfig,
  defaultLifetimeConfig,
  defaultPaddingConfig,
} from 'ts-mls'
import { describe, expect, test } from 'vitest'

import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  exportGroupInfo,
  joinGroupExternal,
  processWelcome,
  restoreGroup,
} from '../src/group.js'
import { createMlsContext, resolveMlsContext } from '../src/group-context.js'
import { deriveGroup } from '../src/group-handle.js'
import type { GroupOptions } from '../src/types.js'

const defaults = {
  keyRetentionConfig: { ...defaultKeyRetentionConfig, maximumForwardRatchetSteps: 500 },
  lifetimeConfig: defaultLifetimeConfig,
  keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
  paddingConfig: defaultPaddingConfig,
}
const options: GroupOptions = {
  keyRetention: { retainKeysForGenerations: 1000, maximumForwardRatchetSteps: 1200 },
}
const effective = {
  ...defaults,
  keyRetentionConfig: { ...defaultKeyRetentionConfig, ...options.keyRetention },
}

describe('MLS key retention', () => {
  test('uses the reservation forward bound with other retention defaults unchanged', async () => {
    const { group } = await createGroup(randomIdentity(), 'retention-defaults')
    expect(group.context.clientConfig).toEqual(defaults)
  })

  test('partial retention overrides preserve every other default', async () => {
    const context = await resolveMlsContext({ keyRetention: { retainKeysForGenerations: 1000 } })
    expect(context.clientConfig).toEqual({
      ...defaults,
      keyRetentionConfig: { ...defaults.keyRetentionConfig, retainKeysForGenerations: 1000 },
    })
    const direct = createMlsContext(context.cipherSuite, undefined, options)
    expect(direct.clientConfig).toEqual(effective)
  })

  test.each(['create', 'restore', 'Welcome', 'external join', 'derive'] as const)(
    'retention survives every construction: %s',
    async (path) => {
      const alice = randomIdentity()
      const { group } = await createGroup(alice, `retention-${path}`, options)
      if (path === 'create') {
        expect(group.context.clientConfig).toEqual(effective)
      } else if (path === 'restore') {
        const restored = await restoreGroup({
          state: group.state,
          credential: group.credential,
          options,
        })
        expect(restored.context.clientConfig).toEqual(effective)
      } else if (path === 'derive') {
        expect(deriveGroup(group, group.state).context.clientConfig).toEqual(effective)
      } else {
        const bob = randomIdentity()
        const { invite } = await createInvite({
          group,
          identity: alice,
          recipientDID: bob.id,
          permission: 'member',
        })
        const bundle = await createKeyPackageBundle(bob)
        const added = await commitInvite(group, bundle.publicPackage, invite)
        const { group: joined } = await processWelcome({
          identity: bob,
          invite,
          welcome: added.welcomeMessage,
          keyPackageBundle: bundle,
          ratchetTree: added.newGroup.state.ratchetTree,
          options,
        })
        if (path === 'Welcome') {
          expect(joined.context.clientConfig).toEqual(effective)
        } else {
          const rejoined = await joinGroupExternal({
            identity: bob,
            groupInfo: (await exportGroupInfo({ group: added.newGroup })).groupInfo,
            credential: joined.credential,
            resync: true,
            ledgerEntries: invite.ledgerEntries,
            options,
            beforeBinding: async (pending, source) => {
              expect(pending.context.clientConfig).toEqual(effective)
              expect(source.context.clientConfig).toEqual(effective)
            },
          })
          expect(rejoined.group.context.clientConfig).toEqual(effective)
        }
      }
    },
  )

  test('derive preserves the complete effective client configuration', async () => {
    const { group } = await createGroup(randomIdentity(), 'retention-full-config', options)
    const clientConfig: ClientConfig = {
      ...effective,
      lifetimeConfig: { ...defaultLifetimeConfig, maximumTotalLifetime: 123456n },
      keyPackageEqualityConfig: {
        compareKeyPackages: () => false,
        compareKeyPackageToLeafNode: () => false,
      },
      paddingConfig: { kind: 'alwaysPad', paddingLength: 42 },
    }
    group.context.clientConfig = clientConfig
    const derived = deriveGroup(group, group.state)
    expect(derived.context.clientConfig).toEqual(clientConfig)
    expect(derived.context).not.toBe(group.context)
  })
})
