import { describe, expect, test } from 'vitest'

import { createMemoryGroupMLS, memoryEntryID } from './fixtures/memory-group-mls.js'

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

  test('a commit says who wrote it, and at what epoch, without being applied', async () => {
    const admin = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      epoch: 4,
      localDID: 'admin',
    })
    const commit = admin.buildCommit()
    const reader = createMemoryGroupMLS({ recoverySecret: new Uint8Array(32).fill(1), epoch: 4 })

    // Read out of the commit's own bytes. No state is touched, and the reader is not at the
    // committer's group, let alone at a position to apply anything.
    expect(await reader.readCommitHeader(commit)).toEqual({ epoch: 4, committerDID: 'admin' })
    expect(await reader.readCommitHeader(new Uint8Array([0xff, 0xff]))).toBeNull()
    expect(await reader.readCommitHeader(new Uint8Array())).toBeNull()
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

  test('a rejoin builds an external commit, and adopts only when it is accepted', async () => {
    const live = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      localDID: 'live',
      members: ['live', 'stranded'],
    })
    // Advance live to epoch 2. A member ADOPTS the commits it made — it can never process
    // one, because MLS merges a pending commit rather than applying it.
    live.adopt(live.buildCommit(['role:live=admin']))
    live.adopt(live.buildCommit())
    const stranded = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      localDID: 'stranded',
    })

    const request = await stranded.createRecoveryRequest('req-1')
    const sealed = await live.sealGroupInfo(request)
    const pending = await stranded.applyRecovery(sealed, 'req-1')

    // BUILT, not adopted: the commit still has to win a compare-and-set at the head, and a
    // peer that adopted first would be alone on a branch the moment it lost.
    expect(pending).not.toBeNull()
    expect(stranded.epoch()).toBe(0)
    // And the commit says it is a REJOIN, before it is applied and without being applied. Nothing
    // else about it will ever say so: it replaces a leaf the roster already holds, so it changes
    // no DID and no occupied leaf index, and a member applying it has only this to rotate on.
    //
    // The rejoiner itself reads NO committer off it. The flag and the epoch are structural, but an
    // external commit's committer is only as available as the signature that binds it, and that is
    // checkable only against the group context of the epoch it was framed at — epoch 2, where the
    // rejoiner is not. It is still at 0, having built the commit and not adopted it.
    expect(await stranded.readCommitHeader(pending?.commit as Uint8Array)).toEqual({
      epoch: 2,
      external: true,
    })
    // A member that IS at that epoch reads the committer, off the same bytes. The committer is not
    // withheld from the group — it is withheld from anyone who cannot check it.
    expect(await live.readCommitHeader(pending?.commit as Uint8Array)).toEqual({
      epoch: 2,
      committerDID: 'stranded',
      external: true,
    })

    await pending?.onAccepted()
    expect(stranded.epoch()).toBe(3)
    // The rejoined handle holds the group's authenticated head and an EMPTY ledger. That is a
    // roster reset, and it reads as incomplete until the ledger is bootstrapped.
    expect(stranded.ledgerIDs()).toEqual([])
    expect(await stranded.isLedgerComplete()).toBe(false)

    await stranded.bootstrapLedger(await live.getLedger())
    expect(await stranded.isLedgerComplete()).toBe(true)
    expect(stranded.fold().get('role:live')).toBe('admin')
  })

  test('a bootstrapped ledger with an entry withheld is refused, and folds nothing', async () => {
    const live = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      localDID: 'live',
      members: ['live', 'stranded'],
    })
    live.adopt(live.buildCommit(['role:mallory=admin']))
    live.adopt(live.buildCommit(['role:mallory=member']))
    const stranded = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      localDID: 'stranded',
    })
    const request = await stranded.createRecoveryRequest('req-1')
    const pending = await stranded.applyRecovery(await live.sealGroupInfo(request), 'req-1')
    await pending?.onAccepted()

    // Every token in this list is perfectly well-formed. The DEMOTION is simply missing —
    // which is exactly what a signature does not protect and what the head chain does.
    const honest = await live.getLedger()
    await expect(stranded.bootstrapLedger([honest[0] as string])).rejects.toThrow(
      /does not fold to the head/,
    )
    expect(stranded.ledgerIDs()).toEqual([])
    // The demoted admin did not reappear: a rejected ledger folds nothing at all.
    expect(stranded.fold().get('role:mallory')).toBeUndefined()

    await stranded.bootstrapLedger(honest)
    expect(stranded.fold().get('role:mallory')).toBe('member')
  })

  test('a reply sealed for another member, or another request, does not open', async () => {
    const live = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      localDID: 'live',
      members: ['live', 'stranded', 'eve'],
    })
    live.adopt(live.buildCommit())
    const eve = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      localDID: 'eve',
    })
    const stranded = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      localDID: 'stranded',
    })
    const sealed = await live.sealGroupInfo(await stranded.createRecoveryRequest('req-1'))

    // Eve has a leaf and could have asked for herself; this reply is not hers to open.
    await eve.createRecoveryRequest('req-1')
    expect(await eve.applyRecovery(sealed, 'req-1')).toBeNull()
    // And the requester cannot open it under another request id: the key is minted per request.
    await stranded.createRecoveryRequest('req-2')
    expect(await stranded.applyRecovery(sealed, 'req-2')).toBeNull()
  })

  test('a sealed ledger answers one question, and the key survives a reply that is dropped', async () => {
    const live = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      localDID: 'live',
      members: ['live', 'stranded'],
    })
    live.adopt(live.buildCommit(['role:live=admin']))
    const stranded = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      localDID: 'stranded',
    })

    // ONE request, so the two replies differ in nothing but the question they answer: same
    // member, same request id, same ephemeral key. A GroupInfo is not a ledger and a ledger is
    // not a GroupInfo, and neither opens as the other.
    const request = await stranded.createRecoveryRequest('req-1')
    const sealedGroupInfo = await live.sealGroupInfo(request)
    const sealedLedger = await live.sealLedger(request)
    expect(await stranded.openSealedLedger(sealedGroupInfo, 'req-1')).toBeNull()
    expect(await stranded.applyRecovery(sealedLedger, 'req-1')).toBeNull()

    // And a reply the requester drops does not cost it the key: every responder answers a
    // gather, and the next one's reply is sealed to the same ephemeral key.
    expect(await stranded.openSealedLedger(sealedLedger, 'req-1')).toEqual(['role:live=admin'])
  })

  test('a member with no leaf in the responder tree is refused the ledger, as well as the group', async () => {
    const live = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      localDID: 'live',
      members: ['live'],
    })
    live.adopt(live.buildCommit(['role:live=admin']))
    const mallory = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      localDID: 'mallory',
    })
    // The ledger is the group's whole authority state, and the topic it is asked for on is
    // public. Sealing without authorizing would answer this — and encrypt every role neatly to
    // the stranger's own key.
    await expect(live.sealLedger(await mallory.createRecoveryRequest('req-1'))).rejects.toThrow(
      /no leaf/,
    )
  })

  test('a member with no leaf in the responder tree is refused', async () => {
    const live = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      localDID: 'live',
      members: ['live'],
    })
    const removed = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(1),
      localDID: 'mallory',
    })
    // Authorization is roster-intrinsic: the responder can only answer DIDs its own tree still
    // carries a leaf for, so a removed member gets nothing from anyone who applied its removal.
    await expect(live.sealGroupInfo(await removed.createRecoveryRequest('req-1'))).rejects.toThrow(
      /no leaf/,
    )
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
