import { performance } from 'node:perf_hooks'
import { createIdentity } from '@kokuin/token'
import { expect, test } from 'vitest'

import { decodeClientState, encodeClientState } from '../src/codec.js'
import { createGroup, restoreGroup } from '../src/group.js'
import { signLedgerEntry } from '../src/ledger.js'

// Run with: pnpm --filter @kumiai/mls exec vitest run test/group-clone-bench.test.ts
// Wrap Vitest in a timeout, as for the unit suite.
test('reports clone versus serialized restore with 50 held ledger entries', async () => {
  const identity = await createIdentity({
    keys: [
      { purpose: 'sig', alg: 'EdDSA' },
      { purpose: 'kem', alg: 'X25519' },
    ],
    didMethod: 'peer:4',
  })
  const { group } = await createGroup(identity, 'clone-benchmark')
  const tokens: Array<string> = []
  for (let index = 0; index < 50; index++) {
    tokens.push(
      await signLedgerEntry(identity, {
        type: 'app.record',
        groupID: group.groupID,
        subject: identity.id,
        value: { index, text: 'ledger entry payload '.repeat(5) },
      }),
    )
  }
  await group.applyLedgerEntries(tokens)
  expect(group.ledger).toHaveLength(50)
  const encoded = encodeClientState(group.state)
  const persistedTokens = JSON.stringify(group.ledgerTokens)
  const restore = async () => {
    const state = decodeClientState(encoded)
    if (state == null) throw new Error('Missing benchmark state')
    return restoreGroup({
      state,
      credential: structuredClone(group.credential),
      ledgerEntries: JSON.parse(persistedTokens) as Array<string>,
    })
  }
  // Warm token caches: this compares against the existing best-case restore path.
  for (let index = 0; index < 20; index++) {
    group.clone()
    await restore()
  }
  const clones: Array<number> = []
  const restores: Array<number> = []
  for (let index = 0; index < 200; index++) {
    const cloneStart = performance.now()
    const clone = group.clone()
    clones.push(performance.now() - cloneStart)
    expect(encodeClientState(clone.state)).toEqual(encoded)
    const restoreStart = performance.now()
    const restored = await restore()
    restores.push(performance.now() - restoreStart)
    expect(restored.ledgerTokens).toEqual(tokens)
  }
  const summary = (samples: Array<number>) => {
    const sorted = samples.toSorted((a, b) => a - b)
    return {
      median: sorted[Math.floor(sorted.length / 2)]?.toFixed(3),
      p95: sorted[Math.floor(sorted.length * 0.95)]?.toFixed(3),
      mean: (samples.reduce((sum, value) => sum + value, 0) / samples.length).toFixed(3),
    }
  }
  console.info(
    JSON.stringify({
      runtime: process.version,
      entries: tokens.length,
      meanTokenBytes: Math.round(
        tokens.reduce((sum, token) => sum + token.length, 0) / tokens.length,
      ),
      samples: clones.length,
      milliseconds: { clone: summary(clones), restore: summary(restores) },
    }),
  )
})
