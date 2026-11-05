import { deriveTopicID } from '@kumiai/broadcast'
import { describe, expect, test } from 'vitest'

import {
  commitTopic,
  discoveryTopic,
  INBOX_LABEL,
  inboxTopic,
  protocolTopic,
  rendezvousTopic,
} from '../src/topic.js'

const SECRET = new Uint8Array(32).fill(7)
const RECOVERY_SECRET = new Uint8Array(32).fill(9)

describe('topic derivation', () => {
  test('protocolTopic matches deriveTopicID for the protocol label', () => {
    expect(protocolTopic({ secret: SECRET, epoch: 1, protocol: 'control' })).toBe(
      deriveTopicID({ secret: SECRET, epoch: 1, label: 'control' }),
    )
  })

  test('protocolTopic scope discriminates subgroups', () => {
    const a = protocolTopic({ secret: SECRET, epoch: 1, protocol: 'sync', scope: 'roomA' })
    const b = protocolTopic({ secret: SECRET, epoch: 1, protocol: 'sync', scope: 'roomB' })
    expect(a).not.toBe(b)
    expect(a).toBe(deriveTopicID({ secret: SECRET, epoch: 1, label: 'sync', scope: 'roomA' }))
  })

  test('inboxTopic uses the reserved inbox label with the DID as scope', () => {
    expect(inboxTopic({ secret: SECRET, epoch: 1, memberDID: 'did:key:zABC' })).toBe(
      deriveTopicID({ secret: SECRET, epoch: 1, label: INBOX_LABEL, scope: 'did:key:zABC' }),
    )
  })

  test('inbox and protocol topics never collide for the same name', () => {
    expect(inboxTopic({ secret: SECRET, epoch: 1, memberDID: 'control' })).not.toBe(
      protocolTopic({ secret: SECRET, epoch: 1, protocol: 'control' }),
    )
  })

  test('topics rotate per epoch', () => {
    expect(protocolTopic({ secret: SECRET, epoch: 1, protocol: 'control' })).not.toBe(
      protocolTopic({ secret: SECRET, epoch: 2, protocol: 'control' }),
    )
    expect(inboxTopic({ secret: SECRET, epoch: 1, memberDID: 'did:key:zABC' })).not.toBe(
      inboxTopic({ secret: SECRET, epoch: 2, memberDID: 'did:key:zABC' }),
    )
  })

  test('commitTopic is pinned (no rotation)', () => {
    expect(commitTopic(RECOVERY_SECRET)).toBe('JfMPD9Vr90P3vhj0kKSAIn8e087CnhB0QjM8IZQDNXI')
  })

  test('the commit and rendezvous lanes are separate topics', () => {
    // They want opposite things from the hub: the commit topic is a log whose head every
    // commit moves; a rendezvous frame must never move that head.
    expect(commitTopic(RECOVERY_SECRET)).not.toBe(rendezvousTopic(RECOVERY_SECRET))
    expect(commitTopic(RECOVERY_SECRET)).not.toBe(
      protocolTopic({ secret: RECOVERY_SECRET, epoch: 0, protocol: 'chat' }),
    )
  })

  test('both control topics are stable for the group and do not rotate with the epoch', () => {
    // Derived from the epoch-independent recovery secret, so a member stranded on any
    // epoch still derives the same two topics as the live group.
    expect(commitTopic(RECOVERY_SECRET)).toBe(commitTopic(RECOVERY_SECRET))
    expect(rendezvousTopic(RECOVERY_SECRET)).toBe(rendezvousTopic(RECOVERY_SECRET))
    expect(commitTopic(RECOVERY_SECRET)).not.toBe(commitTopic(SECRET))
    expect(rendezvousTopic(RECOVERY_SECRET)).not.toBe(rendezvousTopic(SECRET))
  })

  test('discoveryTopic is a stable, secretless function of the DID', () => {
    const t = discoveryTopic('did:key:zABC')
    expect(t).toBe(discoveryTopic('did:key:zABC'))
    expect(t).not.toBe(discoveryTopic('did:key:zXYZ'))
    expect(typeof t).toBe('string')
    expect(t.length).toBeGreaterThan(0)
  })

  test('protocolTopic rejects the reserved kumiai/ namespace', () => {
    expect(() =>
      protocolTopic({
        secret: SECRET,
        epoch: 1,
        protocol: 'kumiai/inbox/v1',
        scope: 'did:key:zABC',
      }),
    ).toThrow(/reserved/)
    expect(() => protocolTopic({ secret: SECRET, epoch: 0, protocol: 'kumiai/commit/v1' })).toThrow(
      /reserved/,
    )
    expect(() =>
      protocolTopic({ secret: SECRET, epoch: 0, protocol: 'kumiai/rendezvous/v1' }),
    ).toThrow(/reserved/)
    expect(() => protocolTopic({ secret: SECRET, epoch: 1, protocol: 'kumiai/anything' })).toThrow(
      /reserved/,
    )
  })

  test('protocolTopic still accepts ordinary host protocols unchanged', () => {
    expect(protocolTopic({ secret: SECRET, epoch: 1, protocol: 'chat' })).toBe(
      deriveTopicID({ secret: SECRET, epoch: 1, label: 'chat' }),
    )
    expect(protocolTopic({ secret: SECRET, epoch: 1, protocol: 'sync', scope: 'roomA' })).toBe(
      deriveTopicID({ secret: SECRET, epoch: 1, label: 'sync', scope: 'roomA' }),
    )
  })

  test('inboxTopic rejects a NUL-bearing or lone-surrogate DID (via deriveTopicID)', () => {
    expect(() => inboxTopic({ secret: SECRET, epoch: 1, memberDID: 'did:key:z\0evil' })).toThrow(
      /scope/,
    )
    expect(() => inboxTopic({ secret: SECRET, epoch: 1, memberDID: 'did:key:z\uD800' })).toThrow(
      /scope/,
    )
  })

  test('discoveryTopic rejects a lone-surrogate DID but accepts a NUL', () => {
    expect(() => discoveryTopic('did:key:z\uD800')).toThrow(/memberDID/)
    // Single-component prefix is injective regardless of NUL, so a NUL DID is accepted.
    const t = discoveryTopic('did:key:z\0x')
    expect(typeof t).toBe('string')
    expect(t).not.toBe(discoveryTopic('did:key:zx'))
  })

  test('deriveTopicID can intentionally reproduce a reserved rpc tuple (layering boundary)', () => {
    // The reservation lives in protocolTopic, not the label-agnostic primitive: the helpers, not
    // deriveTopicID, carry domain separation. This documents that boundary; it is not a guard.
    expect(
      deriveTopicID({ secret: SECRET, epoch: 1, label: INBOX_LABEL, scope: 'did:key:zABC' }),
    ).toBe(inboxTopic({ secret: SECRET, epoch: 1, memberDID: 'did:key:zABC' }))
  })
})
