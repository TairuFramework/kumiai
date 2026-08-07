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

describe('GroupHandle.findMemberLongForm', () => {
  it('resolves a did:peer:4 member given their short form', async () => {
    const identity = await peer4Identity()
    const { group } = await createGroup(identity, 'lookup-short')

    expect(group.findMemberLongForm(identity.id)).toBe(identity.longForm)
  })

  it('resolves the same member given their long form', async () => {
    const identity = await peer4Identity()
    const { group } = await createGroup(identity, 'lookup-long')

    // normalizeDID truncates a peer:4 long form to its short form, so a caller holding either
    // form finds the member. A consumer that has just read `longForm` off one member and wants
    // another's should not have to normalize first.
    expect(group.findMemberLongForm(identity.longForm)).toBe(identity.longForm)
  })

  it('resolves a did:key member to their id', async () => {
    const identity = randomIdentity()
    const { group } = await createGroup(identity, 'lookup-didkey')

    expect(group.findMemberLongForm(identity.id)).toBe(identity.id)
  })

  it('returns undefined for a DID that is not a member', async () => {
    const identity = await peer4Identity()
    const stranger = await peer4Identity()
    const { group } = await createGroup(identity, 'lookup-stranger')

    // undefined means "no such member", and only that. It never means "this member has no
    // long form" — every member has one.
    expect(group.findMemberLongForm(stranger.id)).toBeUndefined()
  })
})
