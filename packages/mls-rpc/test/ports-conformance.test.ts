import type { GroupCrypto, GroupMLS } from '@kumiai/rpc'
import {
  type ConformanceCryptoMember,
  type ConformanceMLSMember,
  testGroupCryptoConformance,
  testGroupMLSConformance,
} from '@kumiai/rpc-conformance'

import { createGroupCrypto } from '../src/crypto.js'
import { createGroupMLS } from '../src/mls.js'
import { buildRealCommit, buildRealExternalCommit, createRealGroup } from './fixtures/real-group.js'

/**
 * The port contracts, against real MLS. The identical suites run in `@kumiai/rpc` over the test
 * doubles, and running the two against one contract is the whole point: a clause only one side
 * can pass is a divergence, and every divergence found this way had already cost something.
 */

// The suite's port shapes are structural — it cannot import `@kumiai/rpc` without putting a cycle
// in the package graph — so this is what keeps them honest: the REAL port types must be assignable
// to them, checked by the compiler rather than by eye. This package is the one place that may
// depend on both.
const _cryptoIsAPort = (crypto: GroupCrypto): ConformanceCryptoMember['crypto'] => crypto
const _mlsIsAPort = (mls: GroupMLS): ConformanceMLSMember['mls'] => mls

testGroupCryptoConformance({
  label: 'createGroupCrypto over a real GroupHandle',
  createGroup: async (size, id) => {
    const group = await createRealGroup(size, `crypto-conformance-${id}`)
    return {
      members: group.members.map((member) => ({
        did: member.identity.id,
        // The handle is read through a function, as a peer's is: `processMessage` advances the
        // handle in place, and the commit walk below replaces nothing.
        crypto: createGroupCrypto({ handle: () => member.handle }),
      })),
      advance: async () => {
        const commit = await buildRealCommit(group, {})
        for (const member of group.members) await member.handle.processMessage(commit)
      },
      removeMember: async (index) => {
        const commit = await buildRealCommit(group, { removes: index })
        for (const [at, member] of group.members.entries()) {
          if (at === index) continue
          await member.handle.processMessage(commit)
        }
      },
    }
  },
})

testGroupMLSConformance({
  label: 'createGroupMLS over a real GroupHandle',
  createGroup: async (size, id) => {
    const group = await createRealGroup(size, `mls-conformance-${id}`)
    return {
      committerDID: group.committer.identity.id,
      members: group.members.map((member) => ({
        did: member.identity.id,
        mls: createGroupMLS({
          handle: () => member.handle,
          adopt: (next) => {
            member.handle = next
          },
          identity: member.identity,
          entrySlot: member.slot,
        }),
      })),
      buildCommit: async (options) => ({
        commit: await buildRealCommit(group, options ?? {}),
        context: {
          senderDID: group.committer.identity.id,
          resolveLedgerEntries: group.resolveLedgerEntries,
        },
      }),
      buildExternalCommit: async (params) => await buildRealExternalCommit(group, params),
    }
  },
})
