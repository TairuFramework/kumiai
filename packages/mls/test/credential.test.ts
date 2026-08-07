import { createIdentity } from '@kokuin/token'
import { type Credential, defaultCredentialTypes } from 'ts-mls'
import { describe, expect, it } from 'vitest'

import {
  didFromCredential,
  type MemberCredential,
  parseMLSCredentialIdentity,
} from '../src/credential.js'
import { makeMLSCredential } from '../src/group.js'

describe('parseMLSCredentialIdentity', () => {
  it('accepts a minimal did:key credential', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ id: 'did:key:z6MkABC' }))
    const parsed = parseMLSCredentialIdentity(bytes)
    expect(parsed).toEqual({ id: 'did:key:z6MkABC' })
  })

  it('accepts a peer4 credential carrying longForm', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ id: 'did:peer:4zABC', longForm: 'did:peer:4zABC:eyJ...' }),
    )
    const parsed = parseMLSCredentialIdentity(bytes)
    expect(parsed.id).toBe('did:peer:4zABC')
    expect(parsed.longForm).toBe('did:peer:4zABC:eyJ...')
  })

  it('rejects non-JSON input', () => {
    const bytes = new TextEncoder().encode('not-json')
    expect(() => parseMLSCredentialIdentity(bytes)).toThrow()
  })

  it('rejects JSON missing the id field', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ longForm: 'x' }))
    expect(() => parseMLSCredentialIdentity(bytes)).toThrow(/id/i)
  })

  it('rejects JSON where id is not a string', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ id: 42 }))
    expect(() => parseMLSCredentialIdentity(bytes)).toThrow(/id/i)
  })

  it('rejects JSON where longForm is not a string', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ id: 'did:key:z', longForm: 42 }))
    expect(() => parseMLSCredentialIdentity(bytes)).toThrow(/longForm/i)
  })

  it('parses an identity encoded with v: 1', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, id: 'did:key:z6MkABC' }))
    const parsed = parseMLSCredentialIdentity(bytes)
    expect(parsed.id).toBe('did:key:z6MkABC')
  })

  it('parses an identity with no v field as v1 (leaves written before this change can never be rewritten)', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ id: 'did:key:z6MkABC' }))
    const parsed = parseMLSCredentialIdentity(bytes)
    expect(parsed.id).toBe('did:key:z6MkABC')
  })

  it('rejects an identity with an unknown v', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 2, id: 'did:key:z6MkABC' }))
    expect(() => parseMLSCredentialIdentity(bytes)).toThrow(/v(ersion)?/i)
  })
})

describe('makeMLSCredential', () => {
  it('emits JSON { id } for a did:key identity', async () => {
    const identity = await createIdentity({
      keys: [{ purpose: 'sig', alg: 'EdDSA' }],
      didMethod: 'key',
    })
    const credential = makeMLSCredential(identity)
    expect(credential.credentialType).toBe(defaultCredentialTypes.basic)
    const parsed = parseMLSCredentialIdentity((credential as { identity: Uint8Array }).identity)
    expect(parsed.id).toBe(identity.id)
    expect(parsed.longForm).toBeUndefined()

    const raw = JSON.parse(
      new TextDecoder().decode((credential as { identity: Uint8Array }).identity),
    )
    expect(raw.v).toBe(1)
  })

  it('emits JSON { id, longForm } for a did:peer:4 identity', async () => {
    const identity = await createIdentity({
      keys: [{ purpose: 'sig', alg: 'EdDSA' }],
      didMethod: 'peer:4',
    })
    const credential = makeMLSCredential(identity)
    expect(credential.credentialType).toBe(defaultCredentialTypes.basic)
    const parsed = parseMLSCredentialIdentity((credential as { identity: Uint8Array }).identity)
    expect(parsed.id).toBe(identity.id)
    expect(parsed.longForm).toBe(identity.longForm)
  })

  it('throws when a peer4 identity has no longForm', () => {
    const fake = {
      id: 'did:peer:4zABC',
      publicKey: new Uint8Array(32),
      privateKey: new Uint8Array(32),
      signToken: async () => {
        throw new Error('not used')
      },
    } as unknown as Parameters<typeof makeMLSCredential>[0]
    expect(() => makeMLSCredential(fake)).toThrow(/longForm/i)
  })
})

// Ensure MemberCredential type carries `id` and `groupID`
const _typeCheck: MemberCredential = {
  id: 'did:key:z...',
  groupID: 'group-1',
}
void _typeCheck

/** A basic MLS credential carrying `identity` verbatim. */
function basicCredential(identity: Uint8Array): Credential {
  return { credentialType: defaultCredentialTypes.basic, identity }
}

/** A basic MLS credential whose identity is the JSON `makeMLSCredential` emits. */
function credentialFor(id: string): Credential {
  return basicCredential(new TextEncoder().encode(JSON.stringify({ id })))
}

describe('didFromCredential', () => {
  it('returns the DID a basic did:key credential names', () => {
    expect(didFromCredential(credentialFor('did:key:z6MkABC'))).toBe('did:key:z6MkABC')
  })

  it('normalizes a peer:4 long form to its short form', () => {
    // normalizeDID truncates at the separator after the peer:4 prefix, so the roster lookup
    // this feeds compares short forms on both sides.
    expect(didFromCredential(credentialFor('did:peer:4zABC:eyJ'))).toBe('did:peer:4zABC')
  })

  it('reads an identity tagged v: 1', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, id: 'did:key:z6MkABC' }))
    expect(didFromCredential(basicCredential(bytes))).toBe('did:key:z6MkABC')
  })

  it('returns undefined for an x509 credential, which names no DID', () => {
    const x509: Credential = { credentialType: defaultCredentialTypes.x509, certificates: [] }
    expect(didFromCredential(x509)).toBeUndefined()
  })

  it('returns undefined for a custom credential type', () => {
    const custom: Credential = { credentialType: 0xbeef, data: new Uint8Array([1, 2, 3]) }
    expect(didFromCredential(custom)).toBeUndefined()
  })

  it('returns undefined instead of throwing on non-JSON identity bytes', () => {
    const bytes = new TextEncoder().encode('not json at all')
    expect(() => didFromCredential(basicCredential(bytes))).not.toThrow()
    expect(didFromCredential(basicCredential(bytes))).toBeUndefined()
  })

  it('returns undefined instead of throwing on JSON with no id', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ longForm: 'did:peer:4zABC:eyJ' }))
    expect(() => didFromCredential(basicCredential(bytes))).not.toThrow()
    expect(didFromCredential(basicCredential(bytes))).toBeUndefined()
  })

  it('returns undefined instead of throwing on an unsupported identity version', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 2, id: 'did:key:z6MkABC' }))
    expect(() => didFromCredential(basicCredential(bytes))).not.toThrow()
    expect(didFromCredential(basicCredential(bytes))).toBeUndefined()
  })

  it('returns an arbitrary id string unchanged rather than rejecting it', () => {
    // Not this function's job to validate DID syntax: a well-formed identity naming a string no
    // roster ever grants is a DID the caller will fail to find, which is the correct outcome and
    // a different one from "this credential names no DID at all".
    expect(didFromCredential(credentialFor('banana'))).toBe('banana')
  })
})
