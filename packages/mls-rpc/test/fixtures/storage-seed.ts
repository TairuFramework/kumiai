import { normalizeDID, type OwnIdentity, randomIdentity } from '@kokuin/token'
import {
  type ClientState,
  checkpointAuthHash,
  checkpointGenesisHash,
  commitKeyRotation,
  createGroup,
  createKeyPackageBundle,
  decodeClientState,
  decodeEpochRosterFact,
  encodeClientState,
  encodeGroupAnchor,
  type GroupHandle,
  type GroupOptions,
  signLedgerEntry,
} from '@kumiai/mls'

import {
  currentCheckpointFact,
  prepareCheckpointInstallation,
  prepareCheckpointInstallationFromTrust,
} from '../../src/checkpoint-capture.js'
import type {
  GroupKey,
  GroupLifetime,
  GroupPersistence,
  GroupRecoveryTrust,
  GroupStateRecord,
  GroupStores,
  GroupTransition,
  MemoryTransaction,
} from '../../src/persistence-types.js'
import { buildRealCommit, createRealGroup } from './real-group.js'
import { seedMemoryControlState } from './sealed-memory-mls.js'

export type StorageSeed = {
  key: GroupKey
  lifetime: GroupLifetime
  state: GroupStateRecord & { deleted: false }
  trust: GroupRecoveryTrust
  confirmedTranscriptHash: Uint8Array
}

const ciphersuiteName = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'

export async function makeStorageSeed(params: {
  id: string
  incarnation: number
  epoch: number
  mode: 'real-mls' | 'double'
  identity?: OwnIdentity
  options?: GroupOptions
}): Promise<StorageSeed> {
  const key = { groupID: params.id, incarnation: params.incarnation }
  let client: ClientState
  let trust: GroupRecoveryTrust
  if (params.mode === 'real-mls') {
    const real = params.identity === undefined ? await createRealGroup(0, params.id) : null
    let handle =
      real === null
        ? (await createGroup(params.identity ?? randomIdentity(), params.id, params.options)).group
        : real.committer.handle
    while (handle.epoch < params.epoch) {
      if (real === null) handle = (await commitKeyRotation(handle)).newGroup
      else {
        await buildRealCommit(real)
        handle = real.committer.handle
      }
    }
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
    const identity = params.identity ?? randomIdentity()
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
    const ledger = [
      await signLedgerEntry(identity, {
        type: 'kumiai.role',
        groupID: params.id,
        subject: identity.id,
        value: 'admin',
      }),
    ]
    client = seedMemoryControlState(client, { id: identity.id, groupID: params.id }, ledger)
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
      ledger,
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
    confirmedTranscriptHash: client.groupContext.confirmedTranscriptHash.slice(),
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
    await writeInstallationCheckpoint(stores, {
      key: seed.key,
      confirmedTranscriptHash: seed.confirmedTranscriptHash,
      mutationID,
      stateVersion: seed.state.version,
    })
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

export function storageTranscript(state: Uint8Array | null): Uint8Array {
  if (state === null) throw new Error('Missing installed GroupContext')
  const client = decodeClientState(state)
  if (client === undefined) throw new Error('Invalid installed GroupContext')
  return client.groupContext.confirmedTranscriptHash.slice()
}

export async function writeInstallationCheckpoint(
  stores: Pick<GroupStores<MemoryTransaction>, 'checkpoints' | 'trust'>,
  params: { key: GroupKey; mutationID: string; stateVersion: number } & (
    | { handle: GroupHandle }
    | { confirmedTranscriptHash: Uint8Array }
  ),
): Promise<void> {
  const trust = await stores.trust.load()
  if (trust === null) throw new Error('Missing installed trust')
  const previous = currentCheckpointFact(await stores.checkpoints.list())
  const prior = previous === null ? null : decodeEpochRosterFact(previous.canonical)
  if (
    prior !== null &&
    prior.key.groupID === params.key.groupID &&
    prior.key.incarnation === params.key.incarnation &&
    prior.epoch === trust.installed.epoch &&
    prior.authHash ===
      checkpointAuthHash({
        groupID: params.key.groupID,
        genesisHash: checkpointGenesisHash(trust.genesisAnchor),
        epoch: trust.installed.epoch,
        epochAuthenticator: trust.installed.authenticator,
      })
  )
    return
  const capture = { ...params, previousFact: previous?.canonical ?? null }
  const fact =
    'handle' in params
      ? await prepareCheckpointInstallation({ ...capture, handle: params.handle })
      : await prepareCheckpointInstallationFromTrust({
          ...capture,
          trust,
          confirmedTranscriptHash: params.confirmedTranscriptHash,
        })
  const decoded = decodeEpochRosterFact(fact.canonical)
  await stores.checkpoints.put(fact)
  if (decoded.members.some((member) => member.signerDID === normalizeDID(trust.credential.id))) {
    await stores.checkpoints.put({
      kind: 'publication',
      id: `publication:${fact.id}`,
      key: fact.key,
      factID: fact.id,
      frame: null,
      publishID: null,
      accepted: false,
      nextHeartbeatAt: null,
    })
  }
}
