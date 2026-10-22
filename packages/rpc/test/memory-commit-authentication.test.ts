import { fromUTF, toUTF } from '@sozai/codec'
import { describe, expect, test, vi } from 'vitest'

import {
  createMemoryGroupMLS,
  encodeMemoryCommit,
  tagMemoryCommit,
} from './fixtures/memory-group-mls.js'

for (const port of ['processCommit', 'validateRecoveryCommit'] as const) {
  describe(`${port} authenticates the source epoch`, () => {
    for (const kind of ['untagged', 'sibling', 'tagged'] as const) {
      test(`${kind} commit ${kind === 'tagged' ? 'succeeds' : 'is refused without mutation'}`, async () => {
        const source = createMemoryGroupMLS({ localDID: 'alice', members: ['alice', 'bob'] })
        const receiver = createMemoryGroupMLS({ localDID: 'bob', members: ['alice', 'bob'] })
        const sibling = createMemoryGroupMLS({ localDID: 'alice', members: ['alice', 'bob'] })
        await sibling.adopt(
          encodeMemoryCommit(0, 'alice', [], {
            branch: 'sibling',
            authenticator: sibling.authenticator(),
          }),
        )
        const advance = source.buildCommit([])
        await source.adopt(advance)
        await receiver.processCommit(advance, { senderDID: 'alice' })
        const encoded = encodeMemoryCommit(source.epoch(), 'alice', [], {
          external: true,
          adds: ['carol'],
          authenticator: source.authenticator(),
        })
        const { tag: _tag, ...body } = JSON.parse(toUTF(encoded))
        const commit =
          kind === 'untagged'
            ? fromUTF(JSON.stringify(body))
            : kind === 'sibling'
              ? tagMemoryCommit(encoded, sibling.authenticator())
              : encoded
        const before = receiver.serializeState()
        const seenBefore = receiver.seen()
        const lastSenderBefore = receiver.lastSender()
        const resolveLedgerEntries = vi.fn(async () => [])
        const result =
          port === 'processCommit'
            ? await receiver.processCommit(commit, { senderDID: 'carol', resolveLedgerEntries })
            : await receiver.validateRecoveryCommit(commit)
        if (kind === 'tagged') {
          expect(result).toMatchObject(
            port === 'processCommit' ? { applied: true, advanced: true } : { valid: true },
          )
        } else {
          expect(result).toEqual(
            port === 'processCommit'
              ? {
                  applied: false,
                  advanced: false,
                  epochBefore: source.epoch(),
                  epochAfter: source.epoch(),
                  refusal: 'invalid',
                }
              : { epoch: source.epoch() },
          )
          expect(receiver.serializeState()).toEqual(before)
          expect({ seen: receiver.seen(), lastSender: receiver.lastSender() }).toEqual({
            seen: seenBefore,
            lastSender: lastSenderBefore,
          })
          expect(receiver.commits()).toBe(1)
        }
        expect(resolveLedgerEntries).not.toHaveBeenCalled()
      })
    }
  })
}
