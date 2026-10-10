import { randomIdentity } from '@kokuin/token'
import {
  type ClientState,
  createKeyPackageBundle,
  encodeClientState,
  encodeGroupAnchor,
  signLedgerEntry,
} from '@kumiai/mls'

import type {
  GroupKey,
  GroupLifetime,
  GroupPersistence,
  GroupRecoveryTrust,
  GroupStateRecord,
  GroupTransition,
  MemoryTransaction,
} from '../../src/persistence-types.js'
import { buildRealCommit, createRealGroup } from './real-group.js'

export type StorageSeed = {
  key: GroupKey
  lifetime: GroupLifetime
  state: GroupStateRecord & { deleted: false }
  trust: GroupRecoveryTrust
}

const ciphersuiteName = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'

export async function makeStorageSeed(params: {
  id: string
  incarnation: number
  epoch: number
  mode: 'real-mls' | 'double'
}): Promise<StorageSeed> {
  const key = { groupID: params.id, incarnation: params.incarnation }
  let client: ClientState
  let trust: GroupRecoveryTrust
  if (params.mode === 'real-mls') {
    const real = await createRealGroup(0, params.id)
    while (real.committer.handle.epoch < params.epoch) await buildRealCommit(real)
    const handle = real.committer.handle
    client = structuredClone(handle.state)
    trust = {
      groupID: params.id,
      genesisAnchor: encodeGroupAnchor(handle.anchor),
      installed: {
        ...key,
        epoch: params.epoch,
        authenticator: client.keySchedule.epochAuthenticator,
      },
      signerTree: structuredClone(client.ratchetTree),
      registry: structuredClone(handle.registry),
      credential: handle.credential,
      binding: null,
      ledger: handle.ledgerTokens,
      ciphersuiteName,
      spentEpochAuthenticators: [client.keySchedule.epochAuthenticator.slice()],
    }
  } else {
    // Storage values only: this branch never constructs a GroupHandle.
    const identity = randomIdentity()
    const bundle = await createKeyPackageBundle(identity)
    const secret = () => crypto.getRandomValues(new Uint8Array(32))
    client = {
      groupContext: {
        version: 1,
        cipherSuite: 1,
        groupId: new TextEncoder().encode(params.id),
        epoch: BigInt(params.epoch),
        treeHash: secret(),
        confirmedTranscriptHash: secret(),
        extensions: [],
      },
      keySchedule: {
        senderDataSecret: secret(),
        exporterSecret: secret(),
        externalSecret: secret(),
        confirmationKey: secret(),
        membershipKey: secret(),
        resumptionPsk: secret(),
        epochAuthenticator: secret(),
        initSecret: secret(),
      },
      ratchetTree: [{ nodeType: 1, leaf: bundle.publicPackage.leafNode }],
      secretTree: { leafWidth: 1, intermediateNodes: { 0: secret() }, leafNodes: {} },
      privatePath: { leafIndex: 0, privateKeys: { 0: bundle.privatePackage.hpkePrivateKey } },
      signaturePrivateKey: identity.privateKey.slice(),
      unappliedProposals: {},
      confirmationTag: secret(),
      historicalReceiverData: new Map(),
      groupActiveState: { kind: 'active' },
      treeHashCache: [],
    }
    trust = {
      groupID: params.id,
      genesisAnchor: encodeGroupAnchor({ creatorDID: identity.id, version: 1 }),
      installed: {
        ...key,
        epoch: params.epoch,
        authenticator: client.keySchedule.epochAuthenticator,
      },
      signerTree: structuredClone(client.ratchetTree),
      registry: { devices: new Map(), controllers: new Map() },
      credential: { id: identity.id, groupID: params.id },
      binding: null,
      ledger: [
        await signLedgerEntry(identity, {
          type: 'kumiai.role',
          groupID: params.id,
          subject: identity.id,
          value: 'admin',
        }),
      ],
      ciphersuiteName,
      spentEpochAuthenticators: [client.keySchedule.epochAuthenticator.slice()],
    }
  }
  return {
    key,
    lifetime: {
      groupID: params.id,
      latestIncarnation: params.incarnation,
      activeIncarnation: params.incarnation,
      revision: 1,
      mutationID: 'seed',
      restorePending: false,
    },
    state: {
      ...key,
      version: 1,
      deleted: false,
      terminal: false,
      epoch: params.epoch,
      epochAuthenticator: client.keySchedule.epochAuthenticator.slice(),
      state: encodeClientState(client),
      credential: trust.credential,
      ledger: trust.ledger.slice(),
      senderHWM: 16,
    },
    trust,
  }
}

export async function installSeed(
  groups: GroupPersistence<MemoryTransaction>,
  seed: StorageSeed,
  mutationID: string,
): Promise<void> {
  const change = await nextChange(groups, seed.key.groupID, mutationID)
  await groups.transition(change, async (stores) => {
    await stores.lifetime.save({
      ...seed.lifetime,
      revision: (change.expected?.revision ?? 0) + 1,
      mutationID,
    })
    await stores.incarnation(seed.key.incarnation).state.save(seed.state)
    await stores.trust.save(seed.trust)
  })
}

export async function nextChange(
  groups: GroupPersistence<MemoryTransaction>,
  groupID: string,
  mutationID: string,
): Promise<GroupTransition> {
  const lifetime = await groups.load(groupID)
  return {
    groupID,
    mutationID,
    expected:
      lifetime === null
        ? null
        : {
            revision: lifetime.revision,
            activeIncarnation: lifetime.activeIncarnation,
          },
  }
}
