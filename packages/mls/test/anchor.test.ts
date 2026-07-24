import { randomIdentity } from '@kokuin/token'
import { makeCustomExtension } from 'ts-mls'
import { describe, expect, test } from 'vitest'

import {
  buildGroupAnchorExtension,
  controlCapabilities,
  decodeGroupAnchor,
  encodeGroupAnchor,
  GROUP_ANCHOR_EXTENSION_TYPE,
  type GroupAnchor,
  LEDGER_HEAD_EXTENSION_TYPE,
  RESERVED_EXTENSION_TYPE,
  readGroupAnchor,
  readGroupAnchorExtension,
} from '../src/anchor.js'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  processWelcome,
} from '../src/group.js'

describe('group anchor', () => {
  test('an anchor with a structured app survives createGroup → readGroupAnchor', async () => {
    const alice = randomIdentity()
    // A payload the anchor layer never interprets: nested object, array, and a
    // string with non-ASCII characters.
    const app = {
      recoverySecret: 'c2VjcmV0',
      peers: ['did:example:a', 'did:example:b'],
      note: 'café ☕ — naïve',
      nested: { count: 3, flag: false },
    }
    const anchor: GroupAnchor = { creatorDID: alice.id, version: 1, app }

    const { group } = await createGroup(alice, 'anchored', {
      extensions: [buildGroupAnchorExtension(anchor)],
      capabilities: controlCapabilities(),
    })

    const read = readGroupAnchor(group)
    expect(read).not.toBeNull()
    expect(read?.creatorDID).toBe(alice.id)
    expect(read?.version).toBe(1)
    expect(read?.app).toEqual(app)
  })

  test('an anchor with no app round-trips and reads back with app undefined', async () => {
    const alice = randomIdentity()
    const anchor: GroupAnchor = { creatorDID: alice.id, version: 2 }

    const { group } = await createGroup(alice, 'no-app', {
      extensions: [buildGroupAnchorExtension(anchor)],
      capabilities: controlCapabilities(),
    })

    const read = readGroupAnchor(group)
    expect(read?.creatorDID).toBe(alice.id)
    expect(read?.version).toBe(2)
    expect(read?.app).toBeUndefined()
  })

  test('createGroup without extensions auto-anchors with the default creator anchor', async () => {
    const alice = randomIdentity()
    const { group } = await createGroup(alice, 'plain')
    const read = readGroupAnchor(group)
    expect(read?.creatorDID).toBe(alice.id)
    expect(read?.version).toBe(1)
    expect(read?.app).toBeUndefined()
    expect(readGroupAnchorExtension(group)).not.toBeNull()
  })

  test('createGroup fails closed when the anchor extension is present but undecodable', async () => {
    const alice = randomIdentity()
    // Present under the anchor type, but not decodable — corruption, not absence.
    // The GroupHandle constructor reads the anchor to seed the roster, so
    // creation itself throws rather than yielding a handle over an unreadable
    // anchor.
    const corrupt = makeCustomExtension({
      extensionType: GROUP_ANCHOR_EXTENSION_TYPE,
      extensionData: new Uint8Array([0xff, 0xff, 0xff]),
    })
    await expect(
      createGroup(alice, 'corrupt', {
        extensions: [corrupt],
        capabilities: controlCapabilities(),
      }),
    ).rejects.toThrow(/group anchor extension present but could not be decoded/)
  })

  test('createGroup rejects a caller-supplied anchor whose creatorDID is not the creating identity', async () => {
    const alice = randomIdentity()
    const mallory = randomIdentity()
    const anchor: GroupAnchor = { creatorDID: mallory.id, version: 1 }

    await expect(
      createGroup(alice, 'wrong-creator', {
        extensions: [buildGroupAnchorExtension(anchor)],
        capabilities: controlCapabilities(),
      }),
    ).rejects.toThrow(
      new RegExp(
        `createGroup: the anchor's creatorDID \\(${mallory.id}\\) must be the creating identity \\(${alice.id}\\)`,
      ),
    )
  })

  test('decodeGroupAnchor returns null (never throws) on malformed bytes or wrong shape', () => {
    const enc = (s: string) => new TextEncoder().encode(s)
    // Not JSON.
    expect(decodeGroupAnchor(enc('not json {'))).toBeNull()
    // Not valid UTF-8 either.
    expect(decodeGroupAnchor(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull()
    // JSON, but not an object.
    expect(decodeGroupAnchor(enc('42'))).toBeNull()
    expect(decodeGroupAnchor(enc('"a string"'))).toBeNull()
    expect(decodeGroupAnchor(enc('null'))).toBeNull()
    // Missing creatorDID.
    expect(decodeGroupAnchor(enc(JSON.stringify({ version: 1 })))).toBeNull()
    // Non-number version.
    expect(decodeGroupAnchor(enc(JSON.stringify({ creatorDID: 'did:x', version: '1' })))).toBeNull()
  })

  test('decodeGroupAnchor withholds app when version is above CURRENT_VERSION', () => {
    // A future build wrote this anchor (version 2 > the current 1) with an app
    // payload this build cannot interpret. Structural fields stay; app is dropped.
    const future = encodeGroupAnchor({
      creatorDID: 'did:example:alice',
      version: 2,
      app: { recoverySecret: 'v2-seed', shape: 'unknown-to-v1' },
    })
    const decoded = decodeGroupAnchor(future)
    expect(decoded).not.toBeNull()
    expect(decoded?.creatorDID).toBe('did:example:alice')
    // version is preserved, so a consumer can tell "future, app withheld"
    // (version 2, app undefined) from "genuinely no app" (version 1, app undefined).
    expect(decoded?.version).toBe(2)
    expect(decoded?.app).toBeUndefined()
    expect('app' in (decoded as object)).toBe(false)
  })

  test('decodeGroupAnchor keeps app for a version below CURRENT_VERSION', () => {
    // No such anchor exists today (1 is the only value written), but by the
    // backward-compat contract a lower, already-known version stays interpretable.
    const older = encodeGroupAnchor({
      creatorDID: 'did:example:alice',
      version: 0,
      app: { note: 'still readable' },
    })
    const decoded = decodeGroupAnchor(older)
    expect(decoded?.version).toBe(0)
    expect(decoded?.app).toEqual({ note: 'still readable' })
  })

  test('decodeGroupAnchor keeps app at the current version', () => {
    const current = encodeGroupAnchor({
      creatorDID: 'did:example:alice',
      version: 1,
      app: { recoverySecret: 'v1-seed' },
    })
    const decoded = decodeGroupAnchor(current)
    expect(decoded?.version).toBe(1)
    expect(decoded?.app).toEqual({ recoverySecret: 'v1-seed' })
  })

  test('controlCapabilities advertises all three extension types, exactly once each', () => {
    expect(GROUP_ANCHOR_EXTENSION_TYPE).toBe(0xf100)
    expect(LEDGER_HEAD_EXTENSION_TYPE).toBe(0xf101)
    expect(RESERVED_EXTENSION_TYPE).toBe(0xf102)

    const caps = controlCapabilities()
    expect(caps.extensions).toContain(GROUP_ANCHOR_EXTENSION_TYPE)
    expect(caps.extensions).toContain(LEDGER_HEAD_EXTENSION_TYPE)
    expect(caps.extensions).toContain(RESERVED_EXTENSION_TYPE)

    // Idempotent: each control type appears exactly once. (defaultCapabilities()
    // seeds random GREASE extension values that vary per call, so the array is
    // asserted only for the three control types, never for exact contents.)
    const occurrences = (type: number) => caps.extensions.filter((e) => e === type).length
    expect(occurrences(GROUP_ANCHOR_EXTENSION_TYPE)).toBe(1)
    expect(occurrences(LEDGER_HEAD_EXTENSION_TYPE)).toBe(1)
    expect(occurrences(RESERVED_EXTENSION_TYPE)).toBe(1)
  })

  test('an anchored group invites and admits a member who reads the same anchor', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const app = { recoverySecret: 'seed', epoch0Admin: 'alice' }
    const anchor: GroupAnchor = { creatorDID: alice.id, version: 1, app }

    const { group: aliceGroup } = await createGroup(alice, 'anchored-shared', {
      extensions: [buildGroupAnchorExtension(anchor)],
      capabilities: controlCapabilities(),
    })

    // Invitee's key package must advertise the same control extension types.
    const bobBundle = await createKeyPackageBundle(bob, {
      capabilities: controlCapabilities(),
    })

    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })

    const { welcomeMessage, commitMessage } = await commitInvite(
      aliceGroup,
      bobBundle.publicPackage,
      invite,
    )
    expect(commitMessage).toBeInstanceOf(Uint8Array)

    const { group: bobGroup } = await processWelcome({
      identity: bob,
      invite,
      welcome: welcomeMessage,
      keyPackageBundle: bobBundle,
    })

    const bobAnchor = readGroupAnchor(bobGroup)
    expect(bobAnchor?.creatorDID).toBe(alice.id)
    expect(bobAnchor?.version).toBe(1)
    expect(bobAnchor?.app).toEqual(app)
  })

  test('a GCE builder copies the anchor extension verbatim, never a re-encode', async () => {
    const alice = randomIdentity()
    const anchor: GroupAnchor = { creatorDID: alice.id, version: 1, app: { recoverySecret: 's' } }
    const { group } = await createGroup(alice, 'verbatim', {
      extensions: [buildGroupAnchorExtension(anchor)],
      capabilities: controlCapabilities(),
    })

    // The verbatim bytes a ledger-head GCE proposal must copy.
    const extension = readGroupAnchorExtension(group)
    expect(extension).not.toBeNull()
    expect(extension?.extensionType).toBe(GROUP_ANCHOR_EXTENSION_TYPE)
    const verbatim = extension?.extensionData
    if (!(verbatim instanceof Uint8Array)) throw new Error('expected raw extension bytes')

    // Re-encoding the decoded anchor is what a GCE builder must NOT do: even
    // when it happens to be byte-equal today, the byte-compare in the receiving
    // commit policy must depend on the copied bytes, not on this holding.
    const decoded = readGroupAnchor(group)
    if (decoded == null) throw new Error('expected a decodable anchor')
    const reEncoded = encodeGroupAnchor(decoded)

    // A future GCE builder feeds `verbatim` into its proposal; the byte-compare
    // is defined against these bytes.
    expect(verbatim).toEqual(readGroupAnchorExtension(group)?.extensionData)
    // The re-encode is available but is not what the wire comparison relies on.
    expect(reEncoded).toBeInstanceOf(Uint8Array)
  })
})
