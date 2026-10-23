import { encodeClientState } from '@kumiai/mls'
import { expect, test } from 'vitest'

import { decodeAutoRotationCandidate } from '../src/auto-rotation.js'
import { encodeStoredValue } from '../src/persistence-codec.js'
import { createRegistryLeaseFixture } from './fixtures/registry-lease.js'

test('candidate adapters can decode the library envelope through the public decoder', async () => {
  const f = await createRegistryLeaseFixture('real-mls')
  try {
    const handle = await f.fixture().makeHandle(0)
    const candidate = {
      state: encodeClientState(handle.state),
      credential: handle.credential,
      ledger: handle.ledgerTokens,
    }
    expect(decodeAutoRotationCandidate(encodeStoredValue(candidate))).toEqual(candidate)
  } finally {
    await f.fixture().registry.dispose()
  }
})

test.each([
  null,
  {},
  { state: new Uint8Array(), credential: {}, ledger: [] },
  { state: new Uint8Array(), credential: { id: 'member', groupID: 'group' }, ledger: [1] },
])('candidate decoder refuses malformed envelopes', (value) => {
  expect(() => decodeAutoRotationCandidate(encodeStoredValue(value))).toThrow()
})
