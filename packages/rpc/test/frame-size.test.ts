// Set KUMIAI_PROBE_REPORT=1 to print measurement tables.
import { expect, test } from 'vitest'

import { encodeCommitFrame } from '../src/commit-frame.js'
import { encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { createHubMux } from '../src/hub-mux.js'
import { assertFrameFits, FrameTooLargeError } from '../src/index.js'
import { encodeRecoveryReply } from '../src/recovery.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

test('measures final base64 at the hub boundary', () => {
  const rows = [786431, 786432, 786433].map((rawBytes) => {
    const frame = encodeHandshakeFrame(
      HANDSHAKE_KIND.commit,
      encodeCommitFrame(new Uint8Array(rawBytes - 9), new Uint8Array()),
    )
    return {
      rawBytes: frame.length,
      base64Chars: Buffer.from(frame).toString('base64').length,
      fits: Buffer.from(frame).toString('base64').length <= 1048576,
    }
  })
  if (process.env.KUMIAI_PROBE_REPORT === '1')
    process.stdout.write(
      `rawBytes | base64Chars | fits\n${rows.map((row) => `${row.rawBytes} | ${row.base64Chars} | ${row.fits}`).join('\n')}\n`,
    )
  expect(rows.map((row) => row.fits)).toEqual([true, true, false])
})

test('frameCapBeforeSideEffects', async () => {
  for (const rawFrameBytes of [786_432, 786_433]) {
    const hub = new FakeHub()
    const member = makeMLSPeer(hub, 'did:key:alice', new Uint8Array(32).fill(31))
    try {
      await member.peer.replay()
      const pending = await buildLedgerCommit(member, [])()
      member.crypto.sealEntries = async () => ({
        sealed: new Uint8Array(rawFrameBytes - pending.commit.length - 9),
        epoch: member.mls.epoch(),
      })
      const before = hub.published.length
      const error = await member.peer
        .commit(async () => pending)
        .then(
          () => null,
          (reason: unknown) => reason,
        )
      if (rawFrameBytes === 786_432) {
        expect(error).toBeNull()
        expect(member.journal.puts()).toBe(1)
        expect(hub.published.at(-1)?.payload.length).toBe(786_432)
      } else {
        expect(member.journal.puts()).toBe(0)
        expect(hub.published.length - before).toBe(0)
        expect(error).toMatchObject({ name: 'FrameTooLargeError' })
      }
    } finally {
      await member.peer.dispose()
    }
  }
})

test('all publishing routes reject oversized final payloads', async () => {
  const hub = new FakeHub()
  const mux = createHubMux({ hub, localDID: 'alice' })
  mux.retainTopic('topic:frames')
  try {
    const payload = new Uint8Array(786_433)
    for (const publish of [
      () => mux.bus.publish('topic:frames', payload),
      () => mux.mailbox.publish({ senderDID: 'alice', topicID: 'topic:frames', payload }),
      () => mux.publish({ topicID: 'topic:frames', payload, retain: 'log' }),
    ]) {
      await expect(publish()).rejects.toMatchObject({ name: 'FrameTooLargeError' })
      expect(hub.published).toHaveLength(0)
    }
  } finally {
    await mux.dispose()
  }
})

test('app sizing uses the sealed payload', async () => {
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'did:key:alice', new Uint8Array(32).fill(31))
  try {
    await member.peer.replay()
    member.crypto.wrap = async () => new Uint8Array(786_433)
    const before = hub.published.length
    await expect(
      member.peer.protocol('chat').dispatch('chat/posted', { data: { label: '組合' } }),
    ).rejects.toMatchObject({ name: 'FrameTooLargeError' })
    expect(hub.published.length).toBe(before)
    expect(member.journal.puts()).toBe(0)
  } finally {
    await member.peer.dispose()
  }
})

test('public frame guard checks the payload view at the base64 boundary', () => {
  const backing = new Uint8Array(786_433)
  expect(() => assertFrameFits(backing.subarray(0, 786_432))).not.toThrow()
  expect(() => assertFrameFits(new Uint8Array())).not.toThrow()
  expect(() => assertFrameFits(backing)).toThrow(FrameTooLargeError)
})

test('control reply limits include handshake and request framing', async () => {
  const hub = new FakeHub()
  const mux = createHubMux({ hub, localDID: 'alice' })
  mux.retainTopic('topic:replies')
  try {
    const requestID = 'reply-request'
    for (const kind of [HANDSHAKE_KIND.recoveryReply, HANDSHAKE_KIND.ledgerReply]) {
      const sealed = new Uint8Array(786_432 - 6 - requestID.length)
      const payload = encodeHandshakeFrame(kind, encodeRecoveryReply(requestID, sealed))
      expect(payload.length).toBe(786_432)
      await mux.publish({ topicID: 'topic:replies', payload })
      const before = hub.published.length
      const oversized = encodeHandshakeFrame(
        kind,
        encodeRecoveryReply(requestID, new Uint8Array(sealed.length + 1)),
      )
      await expect(mux.publish({ topicID: 'topic:replies', payload: oversized })).rejects.toThrow(
        FrameTooLargeError,
      )
      expect(hub.published.length).toBe(before)
    }
  } finally {
    await mux.dispose()
  }
})
