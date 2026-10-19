import {
  commitKeyRotation,
  decodeClientState,
  encodeClientState,
  encodeGroupAnchor,
  type GroupHandle,
  GroupRestoreError as InvalidCandidateError,
  restoreGroup,
} from '@kumiai/mls'
import {
  type AdoptionWrite,
  digestAppliedCommit,
  type HostBuilt,
  type Operation,
} from '@kumiai/rpc'

import {
  type ControlHandleAccess,
  type HandleAccess,
  simpleHandleAccess,
} from '../../src/access.js'
import { createControlBuildPort, createPersistenceBuildSaver } from '../../src/control-build.js'
import { decodeStoredValue, encodeStoredValue } from '../../src/persistence-codec.js'
import { registryOptions } from '../../src/registry/validation.js'
import { createRegistryHandleAccess } from '../../src/registry-handle-access.js'
import { createRealGroup } from './real-group.js'
import { createRegistryFixture } from './registry.js'
import { createSealedControlAccess } from './sealed-control-access.js'
import { makeStorageSeed, nextChange, writeInstallationCheckpoint } from './storage-seed.js'
import { createTransactionalAccess, createTransactionalStore } from './transactional-access.js'

export const accessKinds = ['simple', 'registry', 'transactional', 'sealed-control'] as const
export type AccessKind = (typeof accessKinds)[number]
export const rotationIntent: Operation & { stage: 'intent' } = {
  id: 'rotation',
  kind: 'rotation',
  revokes: false,
  body: new Uint8Array(),
  seq: 1,
  enqueuedAt: 0,
  deadline: 30_000,
  stage: 'intent',
}

export async function authoringAccessFixture(
  kind: AccessKind,
  owner: 'member' | 'committer' = 'member',
  backgroundMaintenance?: 'gated',
) {
  const groupID = `authoring-${kind}`
  const real = await createRealGroup(2, groupID)
  const member = owner === 'committer' ? real.committer : real.members[0]
  if (member === undefined) throw new Error('Missing member')
  let live = member.handle
  let f = await createRegistryFixture({
    mode: 'real-mls',
    backgroundMaintenance,
    setup: 'empty',
    groupID,
    identity: member.identity,
    options: { resolveLedgerEntries: member.slot.resolve },
  })
  const key = { groupID, incarnation: 1 }
  const seed = await makeStorageSeed({ id: groupID, incarnation: 1, epoch: 0, mode: 'real-mls' })
  const authenticator = live.state.keySchedule.epochAuthenticator.slice()
  const state = {
    ...seed.state,
    epoch: Number(live.epoch),
    epochAuthenticator: authenticator,
    state: encodeClientState(live.state),
    credential: live.credential,
    ledger: live.ledgerTokens,
  }
  const trust = {
    ...seed.trust,
    genesisAnchor: encodeGroupAnchor(live.anchor),
    installed: { ...key, epoch: Number(live.epoch), authenticator },
    signerTree: structuredClone(live.state.ratchetTree),
    registry: structuredClone(live.registry),
    credential: live.credential,
    ledger: live.ledgerTokens,
    spentEpochAuthenticators: [authenticator],
  }
  await f.installRows({ key, state, trust })
  let store = createTransactionalStore(live)
  const restoreCandidate = async (bytes: Uint8Array) => {
    let candidate = bytes
    if (kind === 'registry') {
      try {
        const saved = decodeStoredValue(bytes) as { state: Uint8Array }
        if (!(saved?.state instanceof Uint8Array))
          throw new InvalidCandidateError('Invalid candidate')
        candidate = saved.state
      } catch (cause) {
        throw new InvalidCandidateError('Invalid candidate envelope', { cause })
      }
    }
    const decoded = decodeClientState(candidate)
    if (decoded === undefined) throw new InvalidCandidateError('Invalid candidate')
    return restoreGroup({
      state: decoded,
      credential: member.handle.credential,
      ledgerEntries: member.handle.ledgerTokens,
      options:
        kind === 'registry'
          ? registryOptions(f.environment.options)
          : { resolveLedgerEntries: member.slot.resolve },
    })
  }
  const persistentSave = async (handle: GroupHandle, write?: AdoptionWrite) => {
    await f.device.groups.transition(
      await nextChange(f.device.groups, groupID, write?.mutationID ?? crypto.randomUUID()),
      async (stores) => {
        const row = await stores.incarnation(1).state.load()
        if (row === null || row.deleted) throw new Error('Missing state')
        await stores.incarnation(1).state.save(
          {
            ...row,
            version: row.version + 1,
            state: encodeClientState(handle.state),
            ledger: handle.ledgerTokens,
            epoch: Number(handle.epoch),
            epochAuthenticator: handle.state.keySchedule.epochAuthenticator,
          },
          write?.expected,
        )
        if (Number(handle.epoch) !== row.epoch) {
          const trust = await stores.trust.load()
          if (trust === null) throw new Error('Missing trust')
          await stores.trust.save({
            ...trust,
            installed: {
              ...key,
              epoch: Number(handle.epoch),
              authenticator: handle.state.keySchedule.epochAuthenticator,
            },
            signerTree: handle.state.ratchetTree,
            ledger: handle.ledgerTokens,
            registry: handle.registry,
          })
          await writeInstallationCheckpoint(stores, {
            key,
            handle,
            mutationID: write?.mutationID ?? 'receive',
            stateVersion: row.version + 1,
          })
        }
        if (write !== undefined)
          await stores.incarnation(1).control.apply(write.changes, write.mutationID)
      },
    )
  }
  let access: ControlHandleAccess
  const construct = async (): Promise<ControlHandleAccess> => {
    if (kind === 'transactional') return (await createTransactionalAccess(member, store)).access
    if (kind === 'simple')
      return simpleHandleAccess({
        key,
        handle: () => live,
        adopt: (next) => {
          live = next
        },
        stateVersion: async () => (await f.device.groups.loadState(key))?.version ?? 0,
        persist: persistentSave,
      })
    if (kind === 'sealed-control')
      return (
        await createSealedControlAccess(
          f.device.groups,
          key,
          () => {},
          () => {},
          live,
        )
      ).access
    return createRegistryHandleAccess({ access: await f.registry.access(groupID) })
  }
  access = await construct()
  const control = () =>
    kind === 'transactional' ? store.control : f.device.groups.ports(key).control
  const stored = async () => {
    if (kind === 'transactional')
      return { state: store.snapshot().state, version: store.snapshot().revision }
    const row = await f.device.groups.loadState(key)
    if (row === null || row.deleted || row.state === null) throw new Error('Missing row')
    return { state: row.state, version: row.version }
  }
  const restoreStored = async (bytes: Uint8Array) => {
    const state = decodeClientState(bytes)
    if (state === undefined) throw new Error('Invalid stored source')
    return restoreGroup({
      state,
      credential: member.handle.credential,
      ledgerEntries: member.handle.ledgerTokens,
      options: { resolveLedgerEntries: member.slot.resolve },
    })
  }
  const build = async (_op: Operation, supplied: GroupHandle): Promise<HostBuilt> => {
    const rotated = await commitKeyRotation(supplied)
    return {
      commit: rotated.commitMessage,
      digest: digestAppliedCommit(rotated.commitMessage),
      incarnation: 1,
      epoch: Number(supplied.epoch),
      authenticatorBefore: supplied.state.keySchedule.epochAuthenticator.slice(),
      journal:
        kind === 'registry'
          ? encodeStoredValue({
              state: encodeClientState(rotated.newGroup.state),
              credential: supplied.credential,
              ledger: supplied.ledgerTokens,
            })
          : encodeClientState(rotated.newGroup.state),
      bodies: [],
      welcome: null,
    }
  }
  const port = (builder = build) =>
    createControlBuildPort({
      access,
      control: control(),
      build: builder,
      restoreCandidate,
      saveBuilt:
        kind === 'transactional'
          ? store.saveBuilt
          : createPersistenceBuildSaver({ persistence: f.device.groups, key }),
      now: () => 1,
      newID: () => crypto.randomUUID(),
    })
  const owe = async () => {
    await control().apply({ putOperations: [rotationIntent] }, 'intent')
    return port().prepareBuild(rotationIntent, async (built) => ({
      payload: built.commit,
      publishID: 'publish',
      expectedHead: null,
    }))
  }
  return {
    get access() {
      return access
    },
    control,
    stored,
    build,
    port,
    owe,
    restoreCandidate,
    restoreStored,
    real,
    remote: real.committer,
    member,
    key,
    get fixture() {
      return f
    },
    async reconstruct() {
      if (kind === 'transactional') store = await store.fork()
      else if (kind === 'registry') f = await f.reopen()
      else live = await restoreStored((await stored()).state)
      access = await construct()
    },
    async rawSave(handle: GroupHandle, expectedVersion: number) {
      if (kind === 'transactional')
        await store.save(expectedVersion, encodeClientState(handle.state), handle.ledgerTokens)
      else {
        await f.device.groups.transition(
          await nextChange(f.device.groups, groupID, crypto.randomUUID()),
          async (stores) => {
            const row = await stores.incarnation(1).state.load()
            if (row === null || row.deleted) throw new Error('Missing source')
            await stores.incarnation(1).state.save(
              {
                ...row,
                version: expectedVersion + 1,
                state: encodeClientState(handle.state),
                ledger: handle.ledgerTokens,
              },
              {
                key,
                stateVersion: expectedVersion,
                identity: {
                  ...key,
                  epoch: Number(handle.epoch),
                  authenticator: handle.state.keySchedule.epochAuthenticator,
                },
              },
            )
          },
        )
        if (kind === 'simple') live = handle
      }
    },
    openAccess: () => access as HandleAccess,
    close: () => f.close(),
  }
}
