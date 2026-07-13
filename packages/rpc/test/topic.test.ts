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
    expect(protocolTopic(SECRET, 1, 'control')).toBe(deriveTopicID(SECRET, 1, 'control'))
  })

  test('protocolTopic scope discriminates subgroups', () => {
    const a = protocolTopic(SECRET, 1, 'sync', 'roomA')
    const b = protocolTopic(SECRET, 1, 'sync', 'roomB')
    expect(a).not.toBe(b)
    expect(a).toBe(deriveTopicID(SECRET, 1, 'sync', 'roomA'))
  })

  test('inboxTopic uses the reserved inbox label with the DID as scope', () => {
    expect(inboxTopic(SECRET, 1, 'did:key:zABC')).toBe(
      deriveTopicID(SECRET, 1, INBOX_LABEL, 'did:key:zABC'),
    )
  })

  test('inbox and protocol topics never collide for the same name', () => {
    expect(inboxTopic(SECRET, 1, 'control')).not.toBe(protocolTopic(SECRET, 1, 'control'))
  })

  test('topics rotate per epoch', () => {
    expect(protocolTopic(SECRET, 1, 'control')).not.toBe(protocolTopic(SECRET, 2, 'control'))
    expect(inboxTopic(SECRET, 1, 'did:key:zABC')).not.toBe(inboxTopic(SECRET, 2, 'did:key:zABC'))
  })

  test('the commit and rendezvous lanes are separate topics', () => {
    // They want opposite things from the hub: the commit topic is a log whose head every
    // commit moves; a rendezvous frame must never move that head.
    expect(commitTopic(RECOVERY_SECRET)).not.toBe(rendezvousTopic(RECOVERY_SECRET))
    expect(commitTopic(RECOVERY_SECRET)).not.toBe(protocolTopic(RECOVERY_SECRET, 0, 'chat'))
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
})
