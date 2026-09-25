import { decodeClientState, encodeClientState, restoreGroup } from '@kumiai/mls'
import {
  type GroupCrypto,
  type GroupMLS,
  isAppFrameStorageError,
  type PendingAppFrame,
} from '@kumiai/rpc'
import {
  type ConformanceCryptoMember,
  type ConformanceMLSMember,
  testGroupCryptoConformance,
  testGroupMLSConformance,
  testPendingGroupCryptoConformance,
} from '@kumiai/rpc-conformance'
import { nodeTypes } from 'ts-mls'

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

// THE TRIPWIRE, and the reverse direction is the whole point of it. The assignments above only
// prove the suite asks for nothing the port lacks; they say nothing about a port member the suite
// has never heard of. That gap is invisible by construction — a member with no clause produces no
// failure — and it was real: eight of `GroupMLS`'s twelve members had no contract at all, across
// the recovery and ledger lanes, which carry the group's whole authority state.
//
// These assignments fail to compile the moment a port grows a member the conformance shape does
// not carry. Adding one is then a decision — write the clause, or widen the shape and say why it
// has none — rather than something that happens silently.
const _cryptoCoversPort = (crypto: ConformanceCryptoMember['crypto']): GroupCrypto => crypto
const _mlsCoversPort = (mls: ConformanceMLSMember['mls']): GroupMLS => mls

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

testPendingGroupCryptoConformance({
  label: 'createGroupCrypto over a real GroupHandle',
  isStorageError: isAppFrameStorageError,
  createFixture: async (id) => {
    const group = await createRealGroup(1, `pending-${id}`)
    const member = group.members[0]
    if (member == null) throw new Error('missing real group member')
    const originalHandle = member.handle
    let persistCalls = 0
    const store = {
      state: encodeClientState(member.handle.state),
      records: new Map<string, PendingAppFrame>(),
      fail: false,
    }
    const pending = {
      persistOpened: async (state: Uint8Array, record: PendingAppFrame) => {
        persistCalls++
        if (store.fail) throw new Error('database unavailable')
        store.state = state.slice()
        store.records.set(record.frame.id, record)
      },
      list: async () => [...store.records.values()],
      complete: async (recordID: string) => {
        store.records.delete(recordID)
      },
    }
    const receiver = createGroupCrypto({ handle: () => member.handle, pending })
    const restore = async () => {
      const state = decodeClientState(store.state)
      if (state == null) throw new Error('invalid saved state')
      const handle = await restoreGroup({ state, credential: member.handle.credential })
      return createGroupCrypto({ handle: () => handle, pending })
    }
    return {
      senderDID: group.committer.identity.id,
      sender: createGroupCrypto({ handle: () => group.committer.handle }),
      receiver,
      restore,
      failPersist: (yes: boolean) => {
        store.fail = yes
      },
      saveHandle: async () => {
        store.state = encodeClientState(member.handle.state)
      },
      liveContextOwned: () => member.handle === originalHandle,
      liveState: () => encodeClientState(member.handle.state),
      persistCalls: () => persistCalls,
      unnamedSender: () => {
        const leafIndex = member.handle
          .listMembers()
          .find((entry) => entry.id === group.committer.identity.id)?.leafIndex
        if (leafIndex == null) throw new Error('missing sender leaf')
        const node = member.handle.state.ratchetTree[leafIndex * 2]
        if (
          node == null ||
          node.nodeType !== nodeTypes.leaf ||
          !('identity' in node.leaf.credential)
        )
          throw new Error('missing credential')
        const credential = node.leaf.credential
        const original = credential.identity
        credential.identity = new TextEncoder().encode('not-json-garbage')
        return () => {
          credential.identity = original
        }
      },
      advance: async () => {
        const commit = await buildRealCommit(group, {})
        await member.handle.processMessage(commit)
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
