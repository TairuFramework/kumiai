import { describe } from 'vitest'

import type { ConformanceSaveControlBuild } from '../../rpc-conformance/src/control-store.js'
import { decodeControlFixtureState } from '../../rpc-conformance/src/control-store.js'
import { testControlStoreConformance } from '../../rpc-conformance/src/index.js'
import {
  createMemoryControlStore,
  type MemoryControlStore,
} from '../../rpc-conformance/src/memory-control-store.js'
import type { AdoptionWrite } from '../src/control/types.js'
import { asLogPosition } from '../src/cursor.js'
import { createMemoryHostDatabase, type MemoryHostDatabase } from './fixtures/host-db.js'

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
