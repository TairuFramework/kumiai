import { describe, expect, test } from 'vitest'

import { createMemoryGroupMLS, memoryEntryID } from '../src/memory-group-mls.js'

describe('GroupMLS port', () => {
  test('processCommit advances the epoch and reports it', async () => {
    const mls = createMemoryGroupMLS({ recoverySecret: new Uint8Array(32).fill(1) })
    expect(await mls.processCommit(mls.buildCommit(), { senderDID: 'did:key:zA' })).toEqual({
      advanced: true,
    })
    expect(mls.epoch()).toBe(1)
    expect(mls.lastSender()).toBe('did:key:zA')
  })

  test('a no-op commit does not advance', async () => {
    const mls = createMemoryGroupMLS({ recoverySecret: new Uint8Array(32).fill(1) })
    expect(await mls.processCommit(new Uint8Array(), {})).toEqual({ advanced: false })
    expect(mls.epoch()).toBe(0)
  })

  test('a commit framed at another epoch is read, and not applied', async () => {
    const mls = createMemoryGroupMLS({ recoverySecret: new Uint8Array(32).fill(1), epoch: 2 })
    const older = createMemoryGroupMLS({ recoverySecret: new Uint8Array(32).fill(1), epoch: 1 })
    // A commit framed at an epoch this member is not at is not one it can apply — real MLS
    // cannot even decrypt it. It is history, not a failure.
    expect(await mls.processCommit(older.buildCommit(), {})).toEqual({ advanced: false })
    expect(mls.epoch()).toBe(2)
    expect(mls.seen()).toBe(1)
  })

  test('a commit says who wrote it, and at what epoch, without being applied', () => {
    const admin = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      epoch: 4,
      localDID: 'admin',
    })
    const commit = admin.buildCommit()
    const reader = createMemoryGroupMLS({ recoverySecret: new Uint8Array(32).fill(1), epoch: 4 })

    // Read out of the commit's own bytes. No state is touched, and the reader is not at the
    // committer's group, let alone at a position to apply anything.
    expect(reader.readCommitHeader(commit)).toEqual({ epoch: 4, committerDID: 'admin' })
    expect(reader.readCommitHeader(new Uint8Array([0xff, 0xff]))).toBeNull()
    expect(reader.readCommitHeader(new Uint8Array())).toBeNull()
  })

  test('a member cannot apply the frame that is its own commit', async () => {
    const mls = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      epoch: 1,
      localDID: 'self',
    })
    // MLS merges a pending commit; it does not process one. The state that could have
    // carried it is the pending state, and a member meeting its own commit in the log has
    // lost it. It is refused, and not with a throw: there is nothing here to retry.
    expect(await mls.processCommit(mls.buildCommit(), { senderDID: 'self' })).toEqual({
      advanced: false,
    })
    expect(mls.epoch()).toBe(1)
  })

  test('a commit from a committer the policy refuses is well-formed, and not applied', async () => {
    const removed = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      epoch: 1,
      localDID: 'mallory',
    })
    const bob = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      epoch: 1,
      localDID: 'bob',
      acceptsCommitter: (did) => did !== 'mallory',
    })
    // A refusal is a `{ advanced: false }`, never a throw: the lane's rule is that a throw
    // leaves the cursor put and the frame is read again, and a commit deliberately refused
    // is a commit that will be refused every time.
    expect(await bob.processCommit(removed.buildCommit(), { senderDID: 'mallory' })).toEqual({
      advanced: false,
    })
    expect(bob.epoch()).toBe(1)
    expect(bob.seen()).toBe(1)
  })

  test('a commit resolves the bodies it enacts from the frame it rides in', async () => {
    const mls = createMemoryGroupMLS({ recoverySecret: new Uint8Array(32).fill(1), epoch: 1 })
    const admin = createMemoryGroupMLS({ recoverySecret: new Uint8Array(32).fill(1), epoch: 1 })
    const token = 'signed-role-token'
    const commit = admin.buildCommit([token]) // the admin holds the body; this member never saw it

    const asked: Array<Array<string>> = []
    const result = await mls.processCommit(commit, {
      resolveLedgerEntries: async (ids) => {
        asked.push(ids)
        return [token]
      },
    })

    expect(result).toEqual({ advanced: true })
    expect(asked).toEqual([[memoryEntryID(token)]])
    expect(mls.ledgerIDs()).toEqual([memoryEntryID(token)])
  })

  test('a body that does not hash to the id it was asked for is ignored', async () => {
    const mls = createMemoryGroupMLS({ recoverySecret: new Uint8Array(32).fill(1), epoch: 1 })
    const admin = createMemoryGroupMLS({ recoverySecret: new Uint8Array(32).fill(1), epoch: 1 })
    const commit = admin.buildCommit(['signed-role-token'])

    // A responder can fail to answer, never inject: the body is bound to the id by its digest.
    await expect(
      mls.processCommit(commit, { resolveLedgerEntries: async () => ['a different token'] }),
    ).rejects.toThrow(/missing ledger entries/)
    expect(mls.epoch()).toBe(1)
    expect(mls.ledgerIDs()).toEqual([])
  })

  test('getLedgerEntries serves the tokens it holds, and only those', async () => {
    const held = 'signed-role-token'
    const mls = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      ledger: [held],
    })
    const heldID = memoryEntryID(held)
    const unheldID = memoryEntryID('some other token')

    expect(await mls.getLedgerEntries([heldID])).toEqual([held])
    // An entry it does not hold is simply absent from the answer.
    expect(await mls.getLedgerEntries([heldID, unheldID])).toEqual([held])
    expect(await mls.getLedgerEntries([unheldID])).toEqual([])
  })

  test('exportGroupInfo + applyRecovery jumps a stranded peer forward', async () => {
    const live = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      localDID: 'live',
    })
    // Advance live to epoch 2. A member ADOPTS the commits it made — it can never process
    // one, because MLS merges a pending commit rather than applying it.
    live.adopt(live.buildCommit())
    live.adopt(live.buildCommit())
    const stranded = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      localDID: 'stranded',
    })
    const groupInfo = await live.exportGroupInfo('stranded')
    expect(await stranded.applyRecovery(groupInfo)).toEqual({ advanced: true })
    expect(stranded.epoch()).toBe(2)
  })

  test('a member other than the requester cannot open the sealed GroupInfo', async () => {
    const live = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      localDID: 'live',
    })
    live.adopt(live.buildCommit())
    const eve = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      localDID: 'eve',
    })
    const sealed = await live.exportGroupInfo('stranded') // sealed to 'stranded', not 'eve'
    expect(await eve.applyRecovery(sealed)).toEqual({ advanced: false })
  })

  test('applyRecovery is a no-op when already current', async () => {
    const mls = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      localDID: 'self',
    })
    expect(await mls.applyRecovery(await mls.exportGroupInfo('self'))).toEqual({ advanced: false })
  })

  test('exportRecoverySecret is stable and epoch-independent', async () => {
    const secret = new Uint8Array(32).fill(7)
    const mls = createMemoryGroupMLS({ recoverySecret: secret })
    const before = await mls.exportRecoverySecret()
    await mls.processCommit(mls.buildCommit(), {})
    const after = await mls.exportRecoverySecret()
    expect(Array.from(after)).toEqual(Array.from(before))
    expect(Array.from(after)).toEqual(Array.from(secret))
  })
})
