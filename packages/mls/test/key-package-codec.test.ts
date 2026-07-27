import { randomIdentity } from '@kokuin/token'
import { toB64 } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  processWelcome,
} from '../src/group.js'
import {
  decodeKeyPackage,
  decodePrivateKeyPackage,
  encodeKeyPackage,
  encodePrivateKeyPackage,
  keyPackageRef,
} from '../src/key-package-codec.js'
import { ledgerEntryDigest } from '../src/ledger.js'
import type { Invite } from '../src/types.js'

function fromEncoded(encoded: string): Uint8Array {
  return Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
}

async function samplePackage() {
  const bundle = await createKeyPackageBundle(randomIdentity())
  return bundle.publicPackage
}

describe('encodeKeyPackage / decodeKeyPackage', () => {
  test('a round trip reproduces the key package structurally', async () => {
    const original = await samplePackage()
    const decoded = decodeKeyPackage(encodeKeyPackage(original))
    expect(decoded).toEqual(original)
  })

  test('encoding is deterministic for the same package', async () => {
    const original = await samplePackage()
    expect(encodeKeyPackage(original)).toBe(encodeKeyPackage(original))
  })

  /**
   * ts-mls's own `decode()` helper is `dec(t, 0)?.[0]` — it discards the consumed length, so
   * trailing garbage rides along silently and one logical package gains unlimited byte forms.
   * The codec calls the decoder directly to get that length back and compare it.
   */
  test('trailing bytes after a valid encoding are rejected', async () => {
    const original = await samplePackage()
    const bytes = new Uint8Array([...fromEncoded(encodeKeyPackage(original)), 0x00])
    expect(decodeKeyPackage(toB64(bytes))).toBeNull()
  })

  /**
   * Canonicality is a STRING-level property here, not just a byte-level one: the hub stores and
   * compares the string. `fromB64` trims surrounding whitespace, so without the canonical-form
   * check the same package has a second, equally-acceptable string form.
   */
  test('a whitespace-padded encoding is rejected', async () => {
    const original = await samplePackage()
    expect(decodeKeyPackage(`${encodeKeyPackage(original)}\n`)).toBeNull()
  })

  /** `fromB64` THROWS on a bad alphabet rather than returning a sentinel — decode must absorb it. */
  test('non-base64 input returns null rather than throwing', () => {
    expect(decodeKeyPackage('not base64 !!!')).toBeNull()
  })

  test('the empty string is rejected', () => {
    expect(decodeKeyPackage('')).toBeNull()
  })

  test('truncated TLS bytes are rejected', async () => {
    const original = await samplePackage()
    const bytes = fromEncoded(encodeKeyPackage(original))
    expect(decodeKeyPackage(toB64(bytes.subarray(0, bytes.length - 1)))).toBeNull()
  })
})

/**
 * The claim Task 1's tests cannot make. Structural equality proves the codec agrees with itself;
 * it would pass just as happily for an encoding real MLS refuses. So the DECODED package — never
 * the original — is what gets added to a group here, and the join is carried all the way through
 * `processWelcome` so the invitee actually derives the epoch secrets.
 */
describe('a decoded key package against real MLS', () => {
  test('joins a group when the round trip is the only source of the package', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()

    const tokens = new Map<string, string>()
    const publish = (invite: Invite) => {
      for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
    }
    const resolveLedgerEntries = async (ids: Array<string>) =>
      ids.map((id) => {
        const token = tokens.get(id)
        if (token == null) throw new Error(`unknown ledger entry ${id}`)
        return token
      })

    const bundle = await createKeyPackageBundle(bob)
    const decoded = decodeKeyPackage(encodeKeyPackage(bundle.publicPackage))
    expect(decoded).not.toBeNull()
    if (decoded == null) return

    const { group } = await createGroup(alice, 'group:codec', { resolveLedgerEntries })
    const { invite } = await createInvite({
      group,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    publish(invite)

    // The decoded package, not `bundle.publicPackage`. That substitution is the whole test.
    const added = await commitInvite(group, decoded, invite)
    const { group: joined } = await processWelcome({
      identity: bob,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      ratchetTree: added.newGroup.state.ratchetTree,
      options: { resolveLedgerEntries },
    })

    expect(joined.findMemberLeafIndex(bob.id)).not.toBeNull()
  })
})

describe('encodePrivateKeyPackage / decodePrivateKeyPackage', () => {
  test('a round trip reproduces the private key package structurally', async () => {
    const bundle = await createKeyPackageBundle(randomIdentity())
    const decoded = decodePrivateKeyPackage(encodePrivateKeyPackage(bundle.privatePackage))
    expect(decoded).toEqual(bundle.privatePackage)
  })

  test('encoding is deterministic for the same private package', async () => {
    const bundle = await createKeyPackageBundle(randomIdentity())
    expect(encodePrivateKeyPackage(bundle.privatePackage)).toBe(
      encodePrivateKeyPackage(bundle.privatePackage),
    )
  })

  /** Same reasoning as the public codec: ts-mls's `decode()` discards the consumed length. */
  test('trailing bytes after a valid encoding are rejected', async () => {
    const bundle = await createKeyPackageBundle(randomIdentity())
    const bytes = new Uint8Array([
      ...fromEncoded(encodePrivateKeyPackage(bundle.privatePackage)),
      0x00,
    ])
    expect(decodePrivateKeyPackage(toB64(bytes))).toBeNull()
  })

  /** Canonicality is a STRING property: a store compares strings, and `fromB64` trims whitespace. */
  test('a whitespace-padded encoding is rejected', async () => {
    const bundle = await createKeyPackageBundle(randomIdentity())
    expect(
      decodePrivateKeyPackage(`${encodePrivateKeyPackage(bundle.privatePackage)}\n`),
    ).toBeNull()
  })

  test('non-base64 input returns null rather than throwing', () => {
    expect(decodePrivateKeyPackage('not base64 !!!')).toBeNull()
  })

  test('the empty string is rejected', () => {
    expect(decodePrivateKeyPackage('')).toBeNull()
  })

  test('truncated TLS bytes are rejected', async () => {
    const bundle = await createKeyPackageBundle(randomIdentity())
    const bytes = fromEncoded(encodePrivateKeyPackage(bundle.privatePackage))
    expect(decodePrivateKeyPackage(toB64(bytes.subarray(0, bytes.length - 1)))).toBeNull()
  })
})

describe('keyPackageRef', () => {
  test('is stable for the same package and differs between packages', async () => {
    const bundle = await createKeyPackageBundle(randomIdentity())
    const other = await createKeyPackageBundle(randomIdentity())

    const ref = await keyPackageRef(bundle.publicPackage)
    expect(await keyPackageRef(bundle.publicPackage)).toBe(ref)
    expect(await keyPackageRef(other.publicPackage)).not.toBe(ref)
  })

  /** The ref must depend on the package's bytes, not on object identity or insertion order. */
  test('survives a codec round trip', async () => {
    const bundle = await createKeyPackageBundle(randomIdentity())
    const decoded = decodeKeyPackage(encodeKeyPackage(bundle.publicPackage))
    expect(decoded).not.toBeNull()
    if (decoded == null) return
    expect(await keyPackageRef(decoded)).toBe(await keyPackageRef(bundle.publicPackage))
  })

  test('is base64 of a 32-byte hash for the default ciphersuite', async () => {
    const bundle = await createKeyPackageBundle(randomIdentity())
    const ref = await keyPackageRef(bundle.publicPackage)
    expect(fromEncoded(ref)).toHaveLength(32)
  })
})
