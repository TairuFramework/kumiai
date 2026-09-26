import { decodeClientState, encodeClientState } from '@kumiai/mls'
import { isAppFrameStorageError, type PendingAppFrame } from '@kumiai/rpc'
import {
  testGroupCryptoConformance,
  testGroupMLSConformance,
  testPendingGroupCryptoConformance,
} from '@kumiai/rpc-conformance'
import { nodeTypes } from 'ts-mls'

import type { HandleAccess } from '../src/access.js'
import { simpleHandleAccess } from '../src/access.js'
import { createGroupCrypto } from '../src/crypto.js'
import { createGroupMLS } from '../src/mls.js'
import { buildRealCommit, buildRealExternalCommit, createRealGroup } from './fixtures/real-group.js'
import {
  createTransactionalAccess,
  createTransactionalStore,
  type TransactionalAccess,
} from './fixtures/transactional-access.js'

/**
 * The same contracts as `ports-conformance.test.ts`, over a host that restores a fresh handle for
 * every mutation and open and publishes only after its conditional write commits.
 */

function hinted(access: HandleAccess, offset: () => number): HandleAccess {
  return { ...access, epoch: () => access.epoch() + offset() }
}

testGroupCryptoConformance({
  label: 'createGroupCrypto over a transactional HandleAccess',
  createGroup: async (size, id) => {
    const group = await createRealGroup(size, `tx-crypto-conformance-${id}`)
    let hintOffset = 0
    const hosts = await Promise.all(
      group.members.map((member) =>
        createTransactionalAccess(member, createTransactionalStore(member.handle)),
      ),
    )
    const accesses = hosts.map((host) => hinted(host.access, () => hintOffset))
    return {
      setEpochHintOffset: (offset) => {
        hintOffset = offset
      },
      members: accesses.map((access, index) => {
        const member = group.members[index]
        if (member == null) throw new Error('missing member')
        return { did: member.identity.id, crypto: createGroupCrypto({ access }) }
      }),
      advance: async () => {
        const commit = await buildRealCommit(group, {})
        for (const access of accesses)
          await access.mutate((handle, persist) => handle.processMessage(commit, { persist }))
      },
      removeMember: async (index) => {
        const commit = await buildRealCommit(group, { removes: index })
        for (const [at, access] of accesses.entries()) {
          if (at === index) continue
          await access.mutate((handle, persist) => handle.processMessage(commit, { persist }))
        }
      },
    }
  },
})

testPendingGroupCryptoConformance({
  label: 'createGroupCrypto over a transactional HandleAccess',
  isStorageError: isAppFrameStorageError,
  createFixture: async (id) => {
    const group = await createRealGroup(1, `tx-pending-${id}`)
    const member = group.members[0]
    if (member == null) throw new Error('missing real group member')
    const store = createTransactionalStore(member.handle)
    let persistCalls = 0
    const counted = (host: TransactionalAccess) => ({
      ...host.pending,
      persistOpened: async (state: Uint8Array, record: PendingAppFrame) => {
        persistCalls++
        await host.pending.persistOpened(state, record)
      },
    })
    const host = await createTransactionalAccess(member, store)
    const receiver = createGroupCrypto({ access: host.access, pending: counted(host) })
    const saveLive = async () => {
      const live = host.live()
      await store.save(store.snapshot().revision, encodeClientState(live.state), live.ledgerTokens)
    }
    return {
      senderDID: group.committer.identity.id,
      sender: createGroupCrypto({
        access: simpleHandleAccess({
          handle: () => group.committer.handle,
          adopt: (next) => {
            group.committer.handle = next
          },
        }),
      }),
      receiver,
      restore: async () => {
        const restarted = await createTransactionalAccess(member, await store.fork())
        return createGroupCrypto({ access: restarted.access, pending: counted(restarted) })
      },
      failPersist: (yes: boolean) => {
        store.beforeWrite = yes
          ? () => {
              throw new Error('database unavailable')
            }
          : undefined
      },
      saveHandle: saveLive,
      // Every handle this host publishes is the one its stored row holds.
      liveContextOwned: () => {
        const stored = decodeClientState(store.snapshot().state)
        return (
          stored != null &&
          encodeClientState(stored).every(
            (byte, index) => byte === encodeClientState(host.live().state)[index],
          )
        )
      },
      liveState: () => encodeClientState(host.live().state),
      persistCalls: () => persistCalls,
      unnamedSender: () => {
        const live = host.live()
        const leafIndex = live
          .listMembers()
          .find((entry) => entry.id === group.committer.identity.id)?.leafIndex
        if (leafIndex == null) throw new Error('missing sender leaf')
        const node = live.state.ratchetTree[leafIndex * 2]
        if (
          node == null ||
          node.nodeType !== nodeTypes.leaf ||
          !('identity' in node.leaf.credential)
        )
          throw new Error('missing credential')
        const credential = node.leaf.credential
        const original = credential.identity
        // The working handle is restored from the row, so the row carries the damage too.
        credential.identity = new TextEncoder().encode('not-json-garbage')
        void saveLive()
        return () => {
          credential.identity = original
          void saveLive()
        }
      },
      advance: async () => {
        const commit = await buildRealCommit(group, {})
        await host.access.mutate((handle, persist) => handle.processMessage(commit, { persist }))
      },
    }
  },
})

testGroupMLSConformance({
  label: 'createGroupMLS over a transactional HandleAccess',
  createGroup: async (size, id) => {
    const group = await createRealGroup(size, `tx-mls-conformance-${id}`)
    let hintOffset = 0
    const hosts = await Promise.all(
      group.members.map((member) =>
        createTransactionalAccess(member, createTransactionalStore(member.handle)),
      ),
    )
    return {
      setEpochHintOffset: (offset) => {
        hintOffset = offset
      },
      committerDID: group.committer.identity.id,
      members: group.members.map((member, index) => {
        const host = hosts[index]
        if (host == null) throw new Error('missing host')
        return {
          did: member.identity.id,
          mls: createGroupMLS({
            access: hinted(host.access, () => hintOffset),
            identity: member.identity,
            entrySlot: member.slot,
          }),
        }
      }),
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
