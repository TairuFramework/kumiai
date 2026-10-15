import { encodeMultibase } from '@kokuin/token'
import {
  type ConformanceAppOutbox,
  type ConformanceCryptoMember,
  type ConformanceMLSMember,
  testAnchorStoreConformance,
  testAppOutboxConformance,
  testGroupCryptoConformance,
  testGroupMLSConformance,
  testPendingGroupCryptoConformance,
} from '@kumiai/rpc-conformance'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromUTF, toUTF } from '@sozai/codec'
import { expect, test } from 'vitest'

import type { AppOutbox } from '../src/app-outbox.js'
import {
  type GroupCrypto,
  type GroupMLS,
  isAppFrameStorageError,
  type PendingAppFrame,
} from '../src/crypto.js'
import { createMemoryAnchorStore } from './fixtures/anchor.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { createMemoryHostDatabase } from './fixtures/host-db.js'
import { createCapturedMemoryRecovery } from './fixtures/memory-captured-recovery.js'
import {
  createMemoryGroupMLS,
  encodeMemoryCommit,
  memoryEntryID,
  sealMemoryRecoveryVerdict,
} from './fixtures/memory-group-mls.js'
import { createMemoryAppOutbox } from './fixtures/outbox.js'

/**
 * The two doubles the whole rpc suite executes against, run against the port contracts
 * themselves — the same move `hub-conformance.test.ts` makes for the hub doubles, and for the same
 * reason. Every peer-level test in this package holds one of these and none of them checked that
 * it behaves like the port it stands in for, which is how the app lane came to open every live
 * frame twice: the fake's `unwrap` was a pure XOR and the real one spends a ratchet key.
 *
 * `@kumiai/mls-rpc` runs the identical suites over the real implementations. A clause that only
 * one side can pass is a divergence, and finding one is the point.
 */

// The conformance shapes are structural (the suite cannot depend on this package without a
// cycle), so this is the check that they still describe the real ports: a `GroupCrypto` and a
// `GroupMLS` must be usable as one without a cast. `@kumiai/mls-rpc` makes the same assertion from
// the other side.
const _cryptoIsAPort = (crypto: GroupCrypto): ConformanceCryptoMember['crypto'] => crypto
const _mlsIsAPort = (mls: GroupMLS): ConformanceMLSMember['mls'] => mls

const DIDS = ['did:key:alice', 'did:key:bob', 'did:key:carol', 'did:key:dave']

function didAt(index: number): string {
  const did = DIDS[index]
  if (did == null) throw new Error('the suite asked for more members than the harness has DIDs')
  return did
}

testGroupCryptoConformance({
  label: 'createFakeCrypto',
  createGroup: async (size) => {
    let hintOffset = 0
    const members = Array.from({ length: size }, (_, index) => ({
      did: didAt(index),
      // One shared base secret and one shared XOR key: fake members of one group.
      crypto: createFakeCrypto({ epoch: 1, localDID: didAt(index) }),
    }))
    return {
      members: members.map((member) => ({
        did: member.did,
        crypto: { ...member.crypto, epoch: () => member.crypto.epoch() + hintOffset },
      })),
      setEpochHintOffset: (offset) => {
        hintOffset = offset
      },
      advance: async () => {
        for (const member of members) member.crypto.setEpoch(member.crypto.epoch() + 1)
      },
      removeMember: async (index) => {
        // A Remove advances every member but the one it drops — the removed member's handle stops
        // at the last epoch it holds, which is what cutting a member off means.
        for (const [at, member] of members.entries()) {
          if (at !== index) member.crypto.setEpoch(member.crypto.epoch() + 1)
        }
      },
    }
  },
})

testPendingGroupCryptoConformance({
  label: 'createFakeCrypto',
  isStorageError: isAppFrameStorageError,
  createFixture: async () => {
    let persistCalls = 0
    const store = {
      state: new Uint8Array() as Uint8Array,
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
    const sender = createFakeCrypto({ epoch: 1, localDID: 'did:key:alice' })
    const receiver = createFakeCrypto({ epoch: 1, localDID: 'did:key:bob', pending })
    store.state = receiver.saveState()
    return {
      senderDID: 'did:key:alice',
      sender,
      receiver,
      restore: async () =>
        createFakeCrypto({ epoch: 1, localDID: 'did:key:bob', pending, state: store.state }),
      failPersist: (yes: boolean) => {
        store.fail = yes
      },
      saveHandle: async () => {
        store.state = receiver.saveState()
      },
      liveContextOwned: () => true,
      liveState: () => receiver.saveState(),
      persistCalls: () => persistCalls,
      unnamedSender: () => receiver.forceUnnamedSender(),
      advance: async () => {
        receiver.setEpoch(2)
      },
    }
  },
})

const COMMITTER_DID = 'did:key:committer'

testGroupMLSConformance({
  createCapturedRecovery: createCapturedMemoryRecovery,
  label: 'createMemoryGroupMLS',
  createBoundRecovery: async () => {
    const binding = { id: 'controller', prefix: [], capability: 'initial-capability' }
    let offered = binding
    const options = { binding, recoveryBinding: async () => offered, members: ['alice', 'bob'] }
    const requester = createMemoryGroupMLS({ ...options, localDID: 'bob' })
    const responder = createMemoryGroupMLS({ ...options, localDID: 'alice' })
    return {
      requester,
      responder,
      ratchet: async () => {
        requester.adopt(requester.buildCommit())
      },
      replaceBinding: async () => {
        offered = { ...binding, capability: 'renewed-capability' }
      },
    }
  },
  createGroup: async (size, id) => {
    let hintOffset = 0
    const dids = Array.from({ length: size }, (_, index) => didAt(index))
    const roster = [COMMITTER_DID, ...dids]
    // A NON-EMPTY LEDGER, because several clauses have no subject without one — the head check
    // has nothing to doctor against an empty list, and it would pass by taking its early return
    // while the same clause against real MLS (whose invites enact role entries) does real work.
    // A conformance clause exercised on one side only is the thing these suites exist to prevent.
    const ledgerTokens = [`ledger-a-${id}`, `ledger-b-${id}`]
    const databases = dids.map(() => createMemoryHostDatabase())
    const members = dids.map((did, index) => ({
      did,
      mls: createMemoryGroupMLS({
        groupID: id,
        hostDB: databases[index],
        localDID: did,
        members: roster,
        epoch: 0,
        bodies: ledgerTokens,
      }),
    }))
    // The committer is OUTSIDE `members`, so every commit the suite hands a port is a RECEIVED
    // one. It keeps its own epoch: building a commit is what advances its author, and nothing
    // else may advance a member.
    let committerEpoch = 0
    // Disambiguates repeated `{ adds: true }` calls within one group's lifetime.
    let addCount = 0

    // Enact the ledger entries, so every member holds the same non-empty ledger the way it would
    // in life: a commit carrying them, applied. No new harness method — the group simply comes
    // with a ledger, as the real one does.
    const seed = encodeMemoryCommit(
      committerEpoch,
      COMMITTER_DID,
      ledgerTokens.map(memoryEntryID),
      {},
    )
    committerEpoch += 1
    for (const member of members) {
      await member.mls.processCommit(seed, {
        senderDID: COMMITTER_DID,
        resolveLedgerEntries: async () => ledgerTokens,
      })
    }

    return {
      groupID: id,
      restartMember: async (index) => {
        const member = members[index]
        const database = databases[index]
        if (member == null || database == null) throw new Error('missing member')
        const state = await database.loadState(id)
        if (state == null) throw new Error('missing state')
        const mls = createMemoryGroupMLS({ groupID: id, hostDB: database, localDID: member.did })
        mls.restoreState(state)
        return { did: member.did, mls }
      },
      otherGroupMember: async (index) => {
        const did = didAt(index)
        return { did, mls: createMemoryGroupMLS({ groupID: `${id}-other`, localDID: did }) }
      },
      confirmationTag: (key, requestID) => encodeMultibase(hmac(sha256, key, fromUTF(requestID))),
      buildRotation: async (index) => {
        const member = members[index]
        if (member == null) throw new Error('missing member')
        return member.mls.buildCommit()
      },
      pauseNextSave: (index, pause) => {
        const database = databases[index]
        if (database == null) throw new Error('missing database')
        database.seam('before-save', pause)
      },
      sealVerdictPayload: async (index, request, verdict) => {
        const member = members[index]
        if (member == null) throw new Error('missing member')
        return sealMemoryRecoveryVerdict(request, member.did, verdict)
      },
      members: members.map((member) => ({
        did: member.did,
        mls: { ...member.mls, epoch: () => member.mls.epoch() + hintOffset },
      })),
      setEpochHintOffset: (offset) => {
        hintOffset = offset
      },
      committerDID: COMMITTER_DID,
      readEvidence: (index) => {
        const member = members[index]
        if (member === undefined) throw new Error('missing member')
        return member.mls.readEvidence()
      },
      buildUnavailableCommit: async () =>
        fromUTF(
          JSON.stringify({
            epoch: committerEpoch,
            committerDID: COMMITTER_DID,
            entryIDs: [],
            signerDID: COMMITTER_DID,
            missingProposal: true,
          }),
        ),
      buildCommit: async (options) => {
        const removes = options?.removes == null ? undefined : [didAt(options.removes)]
        // A genuinely new identity — never one already modelled in `members` — so a reuse test
        // can tell "the freed leaf went to an arrival" from "the freed leaf went to a DID the
        // suite already knew about".
        const adds =
          options?.adds === true ? [`did:key:conformance-newcomer-${id}-${addCount++}`] : undefined
        const commit = encodeMemoryCommit(committerEpoch, COMMITTER_DID, [], {
          ...(removes != null && { removes }),
          ...(adds != null && { adds }),
        })
        committerEpoch += 1
        return { commit, context: { senderDID: COMMITTER_DID } }
      },
      buildExternalCommit: async ({ rejoining, forgeAs }) => ({
        genuine: encodeMemoryCommit(committerEpoch, didAt(rejoining), [], { external: true }),
        // The forgery a publisher holding no key can produce from a frame it observed: the
        // claimed author is rewritten and the signature still belongs to the original signer.
        forged: encodeMemoryCommit(committerEpoch, forgeAs, [], {
          external: true,
          signerDID: didAt(rejoining),
        }),
      }),
    }
  },
})

testAppOutboxConformance({ label: 'createMemoryAppOutbox', createOutbox: createMemoryAppOutbox })
const _outboxIsAPort = (outbox: AppOutbox): ConformanceAppOutbox => outbox

test.each([
  ['did:peer:4zRequester', 'did:peer:4zRequester:zDocument'],
  ['did:peer:4zRequester:zDocument', 'did:peer:4zRequester'],
])('recovery rejects normalized local signer %s as %s', async (localDID, signer) => {
  const options = { groupID: 'normalized-verdict', members: ['alice', localDID] }
  const requester = createMemoryGroupMLS({ ...options, localDID })
  const responder = createMemoryGroupMLS({ ...options, localDID: 'alice' })
  const { request, requestKey } = await requester.createRecoveryRequest('normalized')
  const pending = await requester.applyRecovery(
    await responder.sealGroupInfo(request),
    'normalized',
    requestKey,
  )
  if (pending == null || 'renewalRequired' in pending) throw new Error('No candidate')
  const key = await pending.confirmationKey('position', 'digest')
  const tuple = {
    groupID: options.groupID,
    requestID: 'normalized',
    position: 'position',
    commitDigest: 'digest',
  }
  const restored = await requester.restoreRecovery(pending.serialize(), requestKey)
  for (const candidate of [pending, restored]) {
    expect(
      candidate.judgeVerdict({
        signer,
        verdict: {
          ...tuple,
          verdict: 'confirmed',
          epoch: pending.epoch,
          tag: encodeMultibase(hmac(sha256, key, fromUTF('normalized'))),
        },
      }),
    ).toBe('advisory')
    expect(
      candidate.judgeVerdict({
        signer,
        verdict: { ...tuple, verdict: 'refused', reason: 'policy' },
      }),
    ).toBe('advisory')
    expect(candidate.judgeVerdict({ signer, verdict: { ...tuple, verdict: 'superseded' } })).toBe(
      'advisory',
    )
  }
})

test('ambiguous recovery save reads back committed state without another write', async () => {
  const groupID = 'ambiguous-recovery'
  const hostDB = createMemoryHostDatabase()
  let saves = 0
  const countedDB = {
    ...hostDB,
    saveState: async (...args: Parameters<typeof hostDB.saveState>) => {
      saves += 1
      await hostDB.saveState(...args)
    },
  }
  const requester = createMemoryGroupMLS({
    groupID,
    localDID: 'bob',
    members: ['alice', 'bob', 'carol'],
    hostDB: countedDB,
    bodies: ['before'],
  })
  requester.adopt(requester.buildCommit(['before']))
  const responder = createMemoryGroupMLS({
    groupID,
    localDID: 'alice',
    members: ['alice', 'bob', 'carol'],
    epoch: 5,
    bodies: ['after'],
  })
  responder.adopt(responder.buildCommit(['after']))
  const { request, requestKey } = await requester.createRecoveryRequest('ambiguous')
  const pending = await requester.applyRecovery(
    await responder.sealGroupInfo(request),
    'ambiguous',
    requestKey,
  )
  if (pending == null || 'renewalRequired' in pending) throw new Error('No candidate')
  const restored = await requester.restoreRecovery(pending.serialize(), requestKey)
  const factory = () => ({
    mutationID: 'ambiguous-adoption',
    changes: {
      putOutcomes: [
        { id: 'rejoin-result', kind: 'reenact' as const, opID: null, at: 123, tokens: ['before'] },
      ],
    },
  })
  hostDB.commitThenRejectNext('save')
  await restored.onAccepted(factory)
  expect(await requester.readEpoch()).toBe(7)
  const stored = await hostDB.loadState(groupID)
  if (stored == null) throw new Error('Missing committed state')
  expect(JSON.parse(toUTF(stored)).epoch).toBe(7)
  await restored.onAccepted(factory)
  expect(await requester.readEpoch()).toBe(7)
  expect(requester.epoch()).toBe(7)
  expect(await requester.getLedger()).toEqual([])
  expect(await requester.isLedgerComplete()).toBe(false)
  expect(requester.leaves()).toEqual(['alice', 'bob', 'carol'])
  expect(saves).toBe(1)
  expect(await hostDB.control(groupID, { groupID, incarnation: 1 }).lastMutation()).toBe(
    'ambiguous-adoption',
  )
  expect((await hostDB.control(groupID, { groupID, incarnation: 1 }).load()).outcomes).toEqual([
    { id: 'rejoin-result', kind: 'reenact', opID: null, at: 123, tokens: ['before'] },
  ])
  const restarted = createMemoryGroupMLS({
    groupID,
    localDID: 'bob',
    members: ['alice', 'bob'],
    hostDB: countedDB,
  })
  await (await restarted.restoreRecovery(pending.serialize(), requestKey)).onAccepted(factory)
  expect(await restarted.readEpoch()).toBe(7)
  expect(restarted.leaves()).toEqual(['alice', 'bob', 'carol'])
  expect(await restarted.isLedgerComplete()).toBe(false)
  expect(saves).toBe(1)
})

testAnchorStoreConformance({
  label: 'rpc memory anchor store',
  createStore: createMemoryAnchorStore,
})

test('a failed bootstrap save leaves the live and durable ledger incomplete until a persisted retry', async () => {
  const groupID = 'bootstrap-save-failure'
  const hostDB = createMemoryHostDatabase()
  const options = { groupID, localDID: 'bob', members: ['alice', 'bob'], hostDB }
  const requester = createMemoryGroupMLS(options)
  const responder = createMemoryGroupMLS({ groupID, localDID: 'alice', members: ['alice', 'bob'] })
  responder.adopt(responder.buildCommit(['persisted-ledger']))
  const { request, requestKey } = await requester.createRecoveryRequest('bootstrap')
  const pending = await requester.applyRecovery(
    await responder.sealGroupInfo(request),
    'bootstrap',
    requestKey,
  )
  if (pending == null || 'renewalRequired' in pending) throw new Error('No candidate')
  await pending.onAccepted(() => ({ mutationID: 'bootstrap-adoption', changes: {} }))
  const adopted = await hostDB.loadState(groupID)
  expect(await requester.isLedgerComplete()).toBe(false)
  hostDB.failNext('mid-save')
  await expect(requester.bootstrapLedger(['persisted-ledger'])).rejects.toThrow(
    'Injected transaction failure',
  )
  expect(await requester.isLedgerComplete()).toBe(false)
  expect(await requester.getLedger()).toEqual([])
  expect(await hostDB.loadState(groupID)).toEqual(adopted)
  const afterFailure = createMemoryGroupMLS(options)
  if (adopted == null) throw new Error('Missing state')
  afterFailure.restoreState(adopted)
  expect(await afterFailure.isLedgerComplete()).toBe(false)
  await requester.bootstrapLedger(['persisted-ledger'])
  const saved = await hostDB.loadState(groupID)
  if (saved == null) throw new Error('Missing state')
  const restarted = createMemoryGroupMLS(options)
  restarted.restoreState(saved)
  expect(await restarted.isLedgerComplete()).toBe(true)
  expect(await restarted.getLedger()).toEqual(['persisted-ledger'])
  expect(await restarted.readRecoverySource()).toEqual(await requester.readRecoverySource())
})
