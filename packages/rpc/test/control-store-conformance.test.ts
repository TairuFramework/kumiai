import { describe } from 'vitest'

import { testControlStoreConformance } from '../../rpc-conformance/src/index.js'
import {
  createMemoryControlStore,
  type MemoryControlStore,
} from '../../rpc-conformance/src/memory-control-store.js'
import type { AdoptionWrite } from '../src/control/types.js'
import { createMemoryHostDatabase, type MemoryHostDatabase } from './fixtures/host-db.js'

describe('memory control store', () => {
  let store: MemoryControlStore
  const host = () => ({
    control: store,
    anchor: store.anchor,
    saveState: store.saveState,
    loadState: store.loadState,
  })
  testControlStoreConformance({
    open: async () => {
      store = createMemoryControlStore()
      return host()
    },
    reopen: async () => host(),
    injectFailure: (point) => store.failNext(point),
    commitThenReject: () => store.commitThenRejectNext('apply'),
  })
})

describe('memory host database', () => {
  let db: MemoryHostDatabase
  const host = () => ({
    control: db.control('group'),
    anchor: db.anchorStore('group'),
    saveState: (state: Uint8Array, write?: AdoptionWrite) => db.saveState('group', state, write),
    loadState: () => db.loadState('group'),
  })
  testControlStoreConformance({
    open: async () => {
      db = createMemoryHostDatabase()
      return host()
    },
    reopen: async () => host(),
    injectFailure: (point) => db.failNext(point),
    commitThenReject: () => db.commitThenRejectNext('apply'),
  })
})
