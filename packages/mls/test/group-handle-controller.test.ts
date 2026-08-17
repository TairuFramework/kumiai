import { describe, expect, test } from 'vitest'

import { parseMLSCredentialIdentity } from '../src/credential.js'

// The member projection maps a parsed identity to GroupMember. This unit test asserts the mapping
// rule directly (the group-handle generator applies it per leaf): a bound identity surfaces its
// controller DID; a floating one surfaces none.
function projectMember(identityBytes: Uint8Array, leafIndex: number) {
  const parsed = parseMLSCredentialIdentity(identityBytes)
  return {
    leafIndex,
    id: parsed.id,
    longForm: parsed.longForm ?? parsed.id,
    ...(parsed.controller ? { controller: parsed.controller.id } : {}),
  }
}

const enc = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj))

describe('GroupMember controller surfacing', () => {
  test('bound leaf surfaces the controller DID', () => {
    const identity = enc({
      id: 'did:key:zDevice',
      controller: {
        id: 'did:kokuin:profile',
        prefix: [{ event: { v: 1, t: 'icp' }, sigs: ['s'] }],
        capability: 't',
      },
    })
    expect(projectMember(identity, 0).controller).toBe('did:kokuin:profile')
  })

  test('floating leaf surfaces no controller', () => {
    expect(projectMember(enc({ id: 'did:key:zDevice' }), 0)).not.toHaveProperty('controller')
  })
})
