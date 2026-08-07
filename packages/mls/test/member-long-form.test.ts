import { createIdentity, randomIdentity } from '@kokuin/token'
import { describe, expect, it } from 'vitest'

import { createGroup } from '../src/group.js'

/** A did:peer:4 identity carrying the signing and agreement keys a real member holds. */
function peer4Identity() {
  return createIdentity({
    keys: [
      { purpose: 'sig', alg: 'EdDSA' },
      { purpose: 'kem', alg: 'X25519' },
    ],
    didMethod: 'peer:4',
  })
}

describe('GroupMember.longForm', () => {
  it('reports the leaf long form for a did:peer:4 member', async () => {
    const identity = await peer4Identity()
    const { group } = await createGroup(identity, 'long-form-peer4')

    const member = group.listMembers()[0]
    expect(member?.id).toBe(identity.id)
    expect(member?.longForm).toBe(identity.longForm)
    // Asserted separately from the equality above, and deliberately: the short form is NOT
    // resolvable — kokuin's resolveX25519Key refuses one outright — so a member reported with
    // `longForm === id` would be silently useless to the consumer this field exists for.
    expect(member?.longForm).not.toBe(member?.id)
  })

  it('reports `id` as the long form for a did:key member, where the two are the same string', async () => {
    const identity = randomIdentity()
    const { group } = await createGroup(identity, 'long-form-didkey')

    const member = group.listMembers()[0]
    expect(member?.id).toBe(identity.id)
    expect(member?.longForm).toBe(identity.id)
  })
})
