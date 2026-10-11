import { randomIdentity } from '@kokuin/token'
import type { Credential } from 'ts-mls'
import { expect, test } from 'vitest'

import { verifyLeafCredential } from '../src/authentication.js'
import { commitValidationReason, isConclusiveCommitError, LeafBindingError } from '../src/errors.js'

test.each([
  'Invalid capability encoding',
  'Invalid signed capability',
  'Token expired',
  'Unsupported signature algorithm',
])('a deterministic verifier diagnostic is conclusive policy refusal: %s', (message) => {
  const error = new Error(message)
  expect(commitValidationReason(error)).toBe('policy')
  expect(isConclusiveCommitError(error)).toBe(true)
})

test('wrapped binding rejection is conclusive unless a cause explicitly marks a transient failure', () => {
  const inner = new LeafBindingError('signature-invalid')
  const cause = new Error('Unlisted deterministic verifier rejection')
  inner.cause = cause
  const outer = new LeafBindingError('holder-evidence-mismatch')
  outer.cause = inner
  expect(isConclusiveCommitError(outer)).toBe(true)
  Object.assign(cause, { transient: true as const })
  expect(isConclusiveCommitError(outer)).toBe(false)
  inner.cause = outer
  expect(isConclusiveCommitError(outer)).toBe(true)
})

test('a verifier transient marker overrides an otherwise conclusive dependency diagnostic', () => {
  const error = Object.assign(new Error('Invalid signature'), { transient: true as const })
  expect(isConclusiveCommitError(error)).toBe(false)
  expect(commitValidationReason(error)).toBe('unrecognised')
})

test.each([
  ['malformed JSON', { credentialType: 1, identity: new TextEncoder().encode('not JSON') }],
  [
    'unsupported version',
    { credentialType: 1, identity: new TextEncoder().encode('{"v":2,"id":"x"}') },
  ],
  ['non-string DID', { credentialType: 1, identity: new TextEncoder().encode('{"id":42}') }],
  ['unsupported credential type', { credentialType: 2, certificates: [new Uint8Array([1])] }],
] satisfies Array<[string, Credential]>)(
  'credential structure rejection is a conclusive binding error: %s',
  async (_name, credential) => {
    const error = await verifyLeafCredential(credential, randomIdentity().publicKey).catch(
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(LeafBindingError)
    expect(isConclusiveCommitError(error)).toBe(true)
    expect(error).toHaveProperty('cause', expect.any(Error))
  },
)
