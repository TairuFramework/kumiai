import { expect, test } from 'vitest'

import { encodeCommitFrame } from '../src/commit-frame.js'
import type { ReadyControlScope } from '../src/control-batch.js'
import { prepareControlOccurrence } from '../src/control-prepare.js'
import { encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { UnsupportedLedgerEntriesVersionError } from '../src/ledger-entries.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'

test.each(['commit', 'entries-outer', 'entries-inner', 'malformed'] as const)(
  'buffered control distinguishes unsupported %s bytes from malformed input',
  async (kind) => {
    const mls = createMemoryGroupMLS()
    let snapshot = await mls.control().load()
    const source = await mls.readRecoverySource()
    const scope: ReadyControlScope = {
      source,
      control: () => snapshot,
      anchor: () => null,
      readEpoch: async () => mls.epoch(),
      isLedgerComplete: async () => true,
      readCommitHeader: async () => ({ epoch: mls.epoch(), committerDID: 'other' }),
      rosterEntries: async () => [],
      exportSecret: async () => {
        throw new Error('No export on refused bytes')
      },
      openEntries: async (bytes) => {
        if (kind === 'entries-outer') throw new UnsupportedLedgerEntriesVersionError()
        return bytes
      },
      validation: { restoreValidation: async () => null },
      prepareOwn: async () => {
        throw new Error('No own commit')
      },
      prepareCommit: async (_commit, options) => {
        await options?.resolveLedgerEntries?.(['missing-body'])
        throw new Error('Unsupported entries must refuse')
      },
      stageControl(changes) {
        snapshot = { ...snapshot, ...changes }
      },
      stageAnchor() {
        throw new Error('No anchor')
      },
    }
    const inner = encodeCommitFrame(new Uint8Array([1]), new Uint8Array([255]))
    if (kind === 'commit') inner[0] = 255
    const payload = encodeHandshakeFrame(
      HANDSHAKE_KIND.commit,
      kind === 'malformed' ? new Uint8Array() : inner,
    )
    const result = await prepareControlOccurrence({
      scope,
      page: {
        topicID: 'commits',
        generation: 0,
        after: null,
        result: {
          messages: [{ topicID: 'commits', sequenceID: '01', senderDID: 'other', payload }],
          head: '01',
          oldest: '01',
          gap: false,
        },
      },
      index: 0,
      localDID: 'local',
      ownCommitDigest: () => null,
      adoption: () => () => {
        throw new Error('No applied commit')
      },
      newID: () => crypto.randomUUID(),
    })
    expect(result.consumed).toBe(true)
    expect(snapshot.cursor?.position).toBe('01')
    expect(result.diagnostic?.kind).toBe(kind === 'malformed' ? undefined : 'unknown-version')
    expect(snapshot.strand).toBeNull()
    expect(snapshot.controlHold).toBeNull()
  },
)
