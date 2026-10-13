import { describe } from 'vitest'

import { runControlSafetyContract } from '../../rpc-conformance/src/control-safety.js'
import type {
  ConformanceControlHost,
  ConformanceControlSlot,
  ConformanceOperation,
  ConformanceSaveControlBuild,
} from '../../rpc-conformance/src/control-store.js'
import {
  decodeControlFixtureState,
  encodeControlFixtureState,
} from '../../rpc-conformance/src/control-store.js'
import { testControlStoreConformance } from '../../rpc-conformance/src/index.js'
import {
  createMemoryControlStore,
  type MemoryControlStore,
} from '../../rpc-conformance/src/memory-control-store.js'
import { forkEventID, recoveryUnavailableEventID } from '../src/control/safety.js'
import type { AdoptionWrite, ControlSlot, Operation } from '../src/control/types.js'
import { asLogPosition } from '../src/cursor.js'
import { createMemoryHostDatabase, type MemoryHostDatabase } from './fixtures/host-db.js'
import { createMemoryGroupMLS, encodeMemoryControlJournal } from './fixtures/memory-group-mls.js'
import { memoryOperationHost } from './fixtures/peer.js'

describe('memory control store', () => {
  let store: MemoryControlStore
  const host = () => ({
    control: store,
    saveBuilt: store.saveBuilt,
    loadVersion: store.loadVersion,
    anchor: store.anchor,
    saveState: store.saveState,
    loadState: store.loadState,
  })
  testControlStoreConformance({
    open: async () => {
      store = createMemoryControlStore({ groupID: 'group-A', incarnation: 1 })
      return host()
    },
    reopen: async () => host(),
    injectFailure: (point) => store.failNext(point),
    commitThenReject: () => store.commitThenRejectNext('apply'),
  })
})

describe('memory host database', () => {
  let db: MemoryHostDatabase
  const saveBuilt: ConformanceSaveControlBuild = (intent, built, expected, mutationID) => {
    const { pendingPublish, ...request } = intent
    return db.saveBuilt(
      'group-A',
      { groupID: 'group-A', incarnation: 1 },
      {
        ...request,
        ...(pendingPublish === undefined
          ? {}
          : {
              pendingPublish: {
                expectedHead:
                  pendingPublish.expectedHead === null
                    ? null
                    : asLogPosition(pendingPublish.expectedHead),
              },
            }),
      },
      {
        ...built,
        searchFrom: built.searchFrom === null ? null : asLogPosition(built.searchFrom),
        expectedHead: built.expectedHead === null ? null : asLogPosition(built.expectedHead),
      },
      expected,
      mutationID,
    )
  }
  const host = () => ({
    control: db.control('group-A', { groupID: 'group-A', incarnation: 1 }),
    saveBuilt,
    loadVersion: () => db.loadVersion('group-A'),
    anchor: db.anchorStore('group-A'),
    saveState: (state: Uint8Array, write?: AdoptionWrite) => db.saveState('group-A', state, write),
    loadState: () => db.loadState('group-A'),
  })
  testControlStoreConformance({
    open: async () => {
      db = createMemoryHostDatabase({ readIdentity: (state) => decodeControlFixtureState(state) })
      return host()
    },
    reopen: async () => host(),
    injectFailure: (point) => db.failNext(point),
    commitThenReject: () => db.commitThenRejectNext('apply'),
  })
})

function storageSafety(open: () => ConformanceControlHost) {
  let host: ConformanceControlHost
  let slot: ConformanceControlSlot
  let intent: ConformanceOperation & { stage: 'intent' }
  const key = { groupID: 'group-A', incarnation: 1 }
  const identity = { ...key, epoch: 1, authenticator: new Uint8Array([7]) }
  const saveBuilt = async () =>
    (await host.saveBuilt(
      intent,
      slot,
      { key, identity, stateVersion: await host.loadVersion() },
      crypto.randomUUID(),
    )) === 'saved'
      ? ('changed' as const)
      : ('refused' as const)
  return {
    prepareValid: async () => {
      host = open()
      await host.saveState(encodeControlFixtureState(identity))
      intent = {
        id: 'intent',
        kind: 'rotation',
        revokes: false,
        seq: 1,
        body: new Uint8Array(),
        enqueuedAt: 0,
        deadline: Number.MAX_SAFE_INTEGER,
        stage: 'intent',
      }
      await host.control.apply({ putOperations: [intent] }, 'intent')
      slot = {
        opID: intent.id,
        incarnation: 1,
        epoch: 1,
        authenticatorBefore: identity.authenticator,
        searchFrom: null,
        expectedHead: null,
        publishID: 'prepared',
        payload: new Uint8Array([1]),
        payloadDigest: 'payload',
        digest: 'commit',
        journal: new Uint8Array([2]),
        bodies: [],
        welcome: null,
      }
    },
    hold: async (reason: 'fork-halted' | 'recovery-unavailable') => {
      await host.control.apply(
        reason === 'fork-halted'
          ? {
              forkHalt: {
                eventID: forkEventID(key),
                detectedAt: 1,
                evidence: {
                  kind: 'unexplained-own-commit',
                  epoch: 1,
                  position: '1',
                  digest: 'foreign',
                },
              },
            }
          : {
              recoveryUnavailable: {
                ...key,
                id: recoveryUnavailableEventID(key),
                kind: 'group:recovery-unavailable',
                reason: 'trust-unreadable',
              },
            },
        'hold',
      )
    },
    // These storage adapters expose their preparation boundary as saveBuilt.
    prepareBuild: saveBuilt,
    saveBuilt,
    adopt: async () => {
      try {
        await host.saveState(encodeControlFixtureState({ ...identity, epoch: 2 }), {
          mutationID: 'adopt',
          changes: {},
        })
        return 'changed' as const
      } catch (error) {
        if (error instanceof Error && error.name === 'ControlAdoptionMovedError')
          return 'refused' as const
        throw error
      }
    },
    snapshot: async () => ({
      control: await host.control.load(),
      state: await host.loadState(),
      version: await host.loadVersion(),
    }),
    cryptoCalls: () => 0,
  }
}

describe('independent memory control safety', () => {
  runControlSafetyContract(
    storageSafety(() => {
      const store = createMemoryControlStore({ groupID: 'group-A', incarnation: 1 })
      return {
        control: store,
        saveBuilt: store.saveBuilt,
        loadVersion: store.loadVersion,
        anchor: store.anchor,
        saveState: store.saveState,
        loadState: store.loadState,
      }
    }),
  )
})
describe('host database control safety', () => {
  runControlSafetyContract(
    storageSafety(() => {
      const db = createMemoryHostDatabase({
        readIdentity: (state) => decodeControlFixtureState(state),
      })
      const key = { groupID: 'group-A', incarnation: 1 }
      return {
        control: db.control('group-A', key),
        saveBuilt: (op, built, expected, id) =>
          db.saveBuilt(
            'group-A',
            key,
            op as Operation & { stage: 'intent' },
            {
              ...built,
              searchFrom: built.searchFrom === null ? null : asLogPosition(built.searchFrom),
              expectedHead: built.expectedHead === null ? null : asLogPosition(built.expectedHead),
            },
            expected,
            id,
          ),
        loadVersion: () => db.loadVersion('group-A'),
        anchor: db.anchorStore('group-A'),
        loadState: () => db.loadState('group-A'),
        saveState: (state, write) => db.saveState('group-A', state, write as AdoptionWrite),
      }
    }),
  )
})

async function memorySafetyHost(did: string) {
  const mls = createMemoryGroupMLS({
    recoverySecret: new Uint8Array(32).fill(73),
    localDID: did,
    storageID: did,
  })
  await mls.persistInitialState()
  const host = memoryOperationHost(mls)
  let cryptoCalls = 0
  const build = host.build
  host.build = async (op) => {
    cryptoCalls++
    return build(op)
  }
  const intent: Operation & { stage: 'intent' } = {
    id: 'rotation',
    kind: 'ledger',
    revokes: false,
    body: new TextEncoder().encode(JSON.stringify({ tokens: [] })),
    seq: 1,
    enqueuedAt: 0,
    deadline: Number.MAX_SAFE_INTEGER,
    stage: 'intent',
  }
  await host.control.apply({ putOperations: [intent] }, 'intent')
  const source = await mls.readRecoverySource()
  const before = mls.serializeState()
  const candidate = await host.build(intent)
  const slot: ControlSlot = {
    ...candidate,
    opID: intent.id,
    payload: candidate.commit,
    payloadDigest: 'prepared-payload',
    expectedHead: null,
    searchFrom: null,
    publishID: 'prepared',
    journal: encodeMemoryControlJournal({
      source,
      sourceState: before,
      candidate: candidate.journal,
    }),
  }
  const prepareAdoption = async () => {
    if (
      (await host.saveBuilt(intent, slot, (await host.readEvidence()).source, 'build')) !== 'saved'
    )
      throw new Error('Invalid build')
    const proof = {
      source: (await host.readEvidence()).source,
      from: null,
      position: asLogPosition('1'),
      payloadDigest: slot.payloadDigest,
    }
    await host.control.apply({ commitOnceAcceptance: proof }, 'accept')
    return () =>
      host.readEvidence().then((evidence) =>
        host.adopt(
          slot.journal,
          { ...evidence.source, acceptance: proof },
          {
            mutationID: 'adopt',
            changes: {
              commitOnce: null,
              deleteOperations: [intent.id],
              putApplied: [
                {
                  epoch: slot.epoch,
                  digest: slot.digest,
                  payloadDigest: slot.payloadDigest,
                  sequenceID: proof.position,
                  opID: intent.id,
                  removed: false,
                },
              ],
              cursor: { position: proof.position, epoch: slot.epoch + 1 },
            },
          },
        ),
      )
  }
  return {
    host,
    prepareAdoption,
    prepareBuild: () =>
      host.prepareBuild(intent, async () => ({
        payload: slot.payload,
        expectedHead: null,
        publishID: 'prepared',
      })),
    saveBuilt: () =>
      host
        .readEvidence()
        .then((evidence) => host.saveBuilt(intent, slot, evidence.source, 'save-built')),
    hold: async (reason: 'fork-halted' | 'recovery-unavailable') => {
      const key = host.control.key
      await host.control.apply(
        reason === 'fork-halted'
          ? {
              forkHalt: {
                eventID: forkEventID(key),
                detectedAt: 1,
                evidence: {
                  kind: 'unexplained-own-commit',
                  epoch: slot.epoch,
                  position: '1',
                  digest: 'foreign',
                },
              },
            }
          : {
              recoveryUnavailable: {
                ...key,
                id: recoveryUnavailableEventID(key),
                kind: 'group:recovery-unavailable',
                reason: 'trust-unreadable',
              },
            },
        'hold',
      )
    },
    snapshot: () => mls.database().snapshot(did),
    cryptoCalls: () => cryptoCalls,
  }
}

describe('memory MLS and peer builder safety', () => {
  let build: Awaited<ReturnType<typeof memorySafetyHost>>
  let adoption: Awaited<ReturnType<typeof memorySafetyHost>>
  let adopt: Awaited<ReturnType<typeof adoption.prepareAdoption>>
  runControlSafetyContract({
    prepareValid: async () => {
      build = await memorySafetyHost('safety-build')
      adoption = await memorySafetyHost('safety-adopt')
      adopt = await adoption.prepareAdoption()
    },
    hold: async (reason) => {
      await build.hold(reason)
      await adoption.hold(reason)
    },
    prepareBuild: async () =>
      (await build.prepareBuild()).kind === 'saved' ? 'changed' : 'refused',
    saveBuilt: async () => ((await build.saveBuilt()) === 'saved' ? 'changed' : 'refused'),
    adopt: async () => ((await adopt()) === 'installed' ? 'changed' : 'refused'),
    snapshot: async () => {
      const left = await build.snapshot()
      const right = await adoption.snapshot()
      return {
        control: left.control,
        state: new TextEncoder().encode(JSON.stringify([left, right])),
        version: left.version + right.version,
      }
    },
    cryptoCalls: () => build.cryptoCalls() + adoption.cryptoCalls(),
  })
})
