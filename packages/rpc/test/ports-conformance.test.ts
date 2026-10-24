import { createIdentity } from '@kokuin/token'
import {
  type ConformanceAppOutbox,
  type ConformanceCryptoMember,
  type ConformanceMLSMember,
  testAnchorStoreConformance,
  testAppOutboxConformance,
  testCommitJournalConformance,
  testGroupCryptoConformance,
  testGroupMLSConformance,
  testPendingGroupCryptoConformance,
} from '@kumiai/rpc-conformance'
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
import { createMemoryCommitJournal } from './fixtures/journal.js'
import {
  createMemoryGroupMLS,
  encodeMemoryCommit,
  type MemoryControllerLog,
  type MemoryRecoveryBinding,
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

test.each([
  { name: 'missing registry', log: undefined },
  {
    name: 'epoch cap',
    log: {
      chain: ['inception'],
      events: Array.from({ length: 33 }, (_, index) => ({
        id: `add-${index}`,
        op: 'add' as const,
        target: `add-${index}`,
      })),
    },
  },
])('member-rooted double admission refuses $name', async ({ log }) => {
  const binding = {
    id: 'controller',
    prefix: ['inception'],
    member: { add: 'add-0', g: 0 },
    iat: 100,
  }
  const receiver = createMemoryGroupMLS({
    controllerLog: log,
    localDID: 'bob',
    binding,
    members: ['alice', 'bob'],
  })
  const commit = encodeMemoryCommit(0, 'alice', [], {
    adds: ['newcomer'],
    bindings: { newcomer: binding },
  })
  expect(await receiver.processCommit(commit, {})).toMatchObject({
    advanced: false,
    refusal: 'binding',
  })
  expect(await receiver.readEpoch()).toBe(0)
  expect(receiver.leaves()).toEqual(['alice', 'bob'])
})

test.each([
  { name: 'an unknown incarnation owner', member: undefined, key: 'newcomer-key' },
  {
    name: 'a different pinned key',
    member: { did: 'newcomer', key: 'pinned-key' },
    key: 'other-key',
  },
  {
    name: 'an unavailable signature key',
    member: { did: 'newcomer', key: 'pinned-key' },
    key: undefined,
  },
])('membership double admission refuses $name', async ({ member, key }) => {
  const binding: MemoryRecoveryBinding = {
    id: 'controller',
    prefix: ['inception'],
    member: { add: 'member-add', g: 0 },
    iat: 100,
  }
  const receiver = createMemoryGroupMLS({
    binding,
    controllerLog: {
      chain: ['inception'],
      events: [{ id: 'member-add', op: 'add', target: 'member-add', member }],
    },
    localDID: 'bob',
    members: ['alice', 'bob'],
  })
  const commit = encodeMemoryCommit(0, 'alice', [], {
    adds: ['newcomer'],
    bindings: { newcomer: binding },
    signatureKeys: key == null ? undefined : { newcomer: key },
  })
  expect(await receiver.processCommit(commit, {})).toMatchObject({
    advanced: false,
    refusal: 'binding',
  })
  expect(await receiver.readEpoch()).toBe(0)
  expect(receiver.leaves()).toEqual(['alice', 'bob'])
})

testGroupMLSConformance({
  label: 'createMemoryGroupMLS',
  createBoundRecovery: async (kind = 'root') => {
    const newcomer = await createIdentity({
      keys: [{ purpose: 'sig', alg: 'EdDSA', privateKey: new Uint8Array(32).fill(63) }],
      didMethod: 'peer:4',
    })
    const newcomerLongForm = newcomer.longForm
    if (newcomerLongForm == null) throw new Error('Missing admission long form')
    const binding: MemoryRecoveryBinding = {
      id: 'controller',
      prefix: ['inception'],
      ...(kind === 'membership'
        ? { member: { add: 'member-add', g: 0 }, iat: 100 }
        : {
            capability:
              kind === 'mbr'
                ? JSON.stringify({ mbr: { add: 'member-add', g: 0 }, iat: 100 })
                : 'initial-capability',
          }),
    }
    let offered = binding
    const admissionCapability = (add: string) =>
      JSON.stringify({ mbr: { add, g: 0 }, iat: 100, aud: newcomer.id })
    const controllerLog: MemoryControllerLog = {
      chain: ['inception'],
      grants: ['initial-capability', 'renewed-capability'].map((capability) => ({
        capability,
        did: 'bob',
        key: 'bob-key',
      })),
      events: [
        {
          id: 'member-add',
          op: 'add',
          target: 'member-add',
          member: { did: 'bob', key: 'bob-key' },
          grants: [
            ...[100, 110].map((iat) => ({
              capability: JSON.stringify({ mbr: { add: 'member-add', g: 0 }, iat }),
              did: 'bob',
              key: 'bob-key',
            })),
            {
              capability: admissionCapability('member-add'),
              did: newcomer.id,
              key: 'newcomer-key',
            },
          ],
        },
      ],
    }
    const options = {
      binding,
      controllerLog,
      signatureKey: 'bob-key',
      recoveryBinding: async () => offered,
      members: ['alice', 'bob'],
    }
    const requester = createMemoryGroupMLS({ ...options, localDID: 'bob' })
    const responder = createMemoryGroupMLS({ ...options, localDID: 'alice' })
    return {
      requesterDID: 'bob',
      denialAliases: { long: newcomerLongForm, short: newcomer.id },
      buildRecoveryCommit: async () => ({
        commit: encodeMemoryCommit(await responder.readEpoch(), 'bob', [], {
          external: true,
          bindings: { bob: binding },
          signatureKeys: { bob: 'bob-key' },
        }),
        context: {},
      }),
      requester,
      responder,
      ratchet: async () => {
        requester.adopt(requester.buildCommit())
      },
      replaceBinding: async () => {
        offered =
          kind === 'membership'
            ? { ...binding, iat: 110 }
            : {
                ...binding,
                capability:
                  kind === 'mbr'
                    ? JSON.stringify({ mbr: { add: 'member-add', g: 0 }, iat: 110 })
                    : 'renewed-capability',
              }
      },
      buildManagementCommit: async (op) => {
        const event =
          op === 'log'
            ? {
                id: 'new-add',
                op: 'add',
                target: 'unknown-add',
                member: { did: newcomer.id, key: 'newcomer-key' },
                grants: [
                  {
                    capability: admissionCapability('unknown-add'),
                    did: newcomer.id,
                    key: 'newcomer-key',
                  },
                ],
              }
            : op === 'deny'
              ? { id: 'denial', op: 'deny', target: newcomer.id }
              : op === 'deny-alias'
                ? { id: 'alias-denial', op: 'deny', target: newcomerLongForm }
                : { id: 'removal', op: 'remove', target: 'member-add' }
        const token = `management:${JSON.stringify({ op: op === 'log' ? 'log' : 'revoke', proof: { chain: [], events: [event] }, effects: op === 'log' ? [] : [event] })}`
        const commit = responder.buildCommit([token])
        responder.adopt(commit)
        return { commit, entries: [token], context: { resolveLedgerEntries: async () => [token] } }
      },
      buildAdmission: async (authority) => ({
        commit: encodeMemoryCommit(await responder.readEpoch(), 'alice', [], {
          adds: [newcomer.id],
          signatureKeys: { [newcomer.id]: 'newcomer-key' },
          bindings: {
            [newcomer.id]:
              authority === 'foreign'
                ? binding
                : {
                    id: binding.id,
                    prefix: binding.prefix,
                    capability: admissionCapability(
                      authority === 'unavailable' ? 'unknown-add' : 'member-add',
                    ),
                  },
          },
        }),
        context: {},
      }),
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
    const members = dids.map((did) => ({
      did,
      mls: createMemoryGroupMLS({
        groupID: id,
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

testAnchorStoreConformance({
  label: 'rpc memory anchor store',
  createStore: createMemoryAnchorStore,
})

testCommitJournalConformance({
  label: 'createMemoryCommitJournal',
  createJournal: createMemoryCommitJournal,
})
