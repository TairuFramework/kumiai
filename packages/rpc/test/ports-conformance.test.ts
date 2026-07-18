import {
  type ConformanceCryptoMember,
  type ConformanceMLSMember,
  testGroupCryptoConformance,
  testGroupMLSConformance,
} from '@kumiai/rpc-conformance'

import type { GroupCrypto, GroupMLS } from '../src/crypto.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { createMemoryGroupMLS, encodeMemoryCommit } from './fixtures/memory-group-mls.js'

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
    const members = Array.from({ length: size }, (_, index) => ({
      did: didAt(index),
      // One shared base secret and one shared XOR key: fake members of one group.
      crypto: createFakeCrypto({ epoch: 1, localDID: didAt(index) }),
    }))
    return {
      members,
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

const COMMITTER_DID = 'did:key:committer'

testGroupMLSConformance({
  label: 'createMemoryGroupMLS',
  createGroup: async (size) => {
    const dids = Array.from({ length: size }, (_, index) => didAt(index))
    const roster = [COMMITTER_DID, ...dids]
    const members = dids.map((did) => ({
      did,
      mls: createMemoryGroupMLS({ localDID: did, members: roster, epoch: 0 }),
    }))
    // The committer is OUTSIDE `members`, so every commit the suite hands a port is a RECEIVED
    // one. It keeps its own epoch: building a commit is what advances its author, and nothing
    // else may advance a member.
    let committerEpoch = 0
    return {
      members,
      committerDID: COMMITTER_DID,
      buildCommit: async (options) => {
        const removes = options?.removes == null ? undefined : [didAt(options.removes)]
        const commit = encodeMemoryCommit(committerEpoch, COMMITTER_DID, [], {
          ...(removes != null && { removes }),
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
